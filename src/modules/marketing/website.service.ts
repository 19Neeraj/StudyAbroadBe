import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { hashToken, randomToken } from '../../utils/crypto.js';
import { recordAudit } from '../audit/audit.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { createLead } from '../leads/lead.service.js';
import { createLeadBody } from '../leads/lead.validation.js';
import { UserModel } from '../users/user.model.js';
import { WebhookEventModel } from '../webhooks/webhookEvent.model.js';
import { ActorUnavailableError, integrationActor } from './actor.js';
import type { TouchpointInput } from './attribution.service.js';
import { WebsiteKeyModel } from './websiteKey.model.js';
import type { createWebsiteKeyBody, websiteLeadBody } from './website.validation.js';

const TRACK = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'gbraid', 'wbraid'] as const;

export async function listKeys(ctx: ServiceContext) {
  return WebsiteKeyModel.find({ organizationId: ctx.organizationId }).sort({ createdAt: -1 }).populate({ path: 'createdBy', select: 'fullName', match: { organizationId: ctx.organizationId } }).select('-organizationId -__v').lean();
}

/** The plain key is returned once and never stored. */
export async function createKey(ctx: ServiceContext, input: z.infer<typeof createWebsiteKeyBody>) {
  if (input.defaultBranchId && !(await BranchModel.exists({ organizationId: ctx.organizationId, _id: input.defaultBranchId, isActive: true }))) throw ApiError.validation([{ field: 'body.defaultBranchId', message: 'Branch not found' }]);
  if (input.defaultCounsellorId && !(await UserModel.exists({ organizationId: ctx.organizationId, _id: input.defaultCounsellorId, isActive: true }))) throw ApiError.validation([{ field: 'body.defaultCounsellorId', message: 'User not found' }]);
  const key = `crm_live_${randomToken(24)}`;
  const doc = await WebsiteKeyModel.create({ ...input, organizationId: ctx.organizationId, keyHash: hashToken(key), prefix: key.slice(0, 14), createdBy: ctx.userId });
  await recordAudit(ctx, { entityType: 'website_key', entityId: doc._id, action: 'integration.website_key_created', metadata: { name: input.name, prefix: doc.prefix } });
  return { key, id: doc._id, prefix: doc.prefix, name: doc.name };
}

export async function revokeKey(ctx: ServiceContext, id: string) {
  const res = await WebsiteKeyModel.updateOne({ organizationId: ctx.organizationId, _id: new Types.ObjectId(id), revokedAt: null }, { revokedAt: new Date() });
  if (!res.matchedCount) throw ApiError.notFound('API key');
  await recordAudit(ctx, { entityType: 'website_key', entityId: new Types.ObjectId(id), action: 'integration.website_key_revoked' });
}

export async function keyFromHeader(header: string | undefined) {
  if (!header || header.length < 20 || header.length > 200) return null;
  return WebsiteKeyModel.findOne({ keyHash: hashToken(header), revokedAt: null }).setOptions({ skipTenantGuard: true }).lean();
}

function touch(t: Record<string, string | undefined> | undefined, base: Partial<TouchpointInput>): TouchpointInput | null {
  if (!t) return null;
  const raw: Record<string, string | undefined> = {};
  for (const k of TRACK) if (t[k]) raw[k] = t[k];
  if (t.landing_url) raw.landing_url = t.landing_url;
  if (t.referrer) raw.referrer = t.referrer;
  return { origin: 'website_form', ...base, occurredAt: t.at ? new Date(t.at) : base.occurredAt, raw };
}

/**
 * Website form submission → lead (spec §6.3). Same duplicate rules as everywhere else; the
 * original (first-touch) attribution is preserved and every later touch is added to history.
 */
export async function submitWebsiteLead(key: NonNullable<Awaited<ReturnType<typeof keyFromHeader>>>, input: z.infer<typeof websiteLeadBody>, idempotencyKey?: string) {
  const organizationId = key.organizationId as Types.ObjectId;
  if (idempotencyKey) {
    const prior = await WebhookEventModel.findOne({ organizationId, provider: 'website', eventKey: `${key._id.toString()}:${idempotencyKey}` }).lean();
    if (prior?.status === 'processed') return { status: 'duplicate_submission' as const, leadId: (prior.payload as { leadId?: string } | undefined)?.leadId ?? null };
  }
  let actor: ServiceContext;
  try {
    actor = await integrationActor(organizationId, key.createdBy);
  } catch (err) {
    if (err instanceof ActorUnavailableError) throw ApiError.forbidden('This API key can no longer create leads; ask an admin to issue a new key');
    throw err;
  }
  const submittedAt = input.submittedAt ?? new Date();
  const first = input.attribution?.first;
  const last = input.attribution?.last;
  const extra = Object.entries(input.answers ?? {}).map(([k, v]) => `${k}: ${v}`);
  const parsed = createLeadBody.safeParse({
    ...input.lead,
    leadSource: key.leadSource ?? 'website',
    leadForm: input.formId,
    // The lead's own attribution fields describe the original (first) touch.
    utmSource: first?.utm_source ?? last?.utm_source,
    utmMedium: first?.utm_medium ?? last?.utm_medium,
    utmCampaign: first?.utm_campaign ?? last?.utm_campaign,
    utmTerm: first?.utm_term ?? last?.utm_term,
    utmContent: first?.utm_content ?? last?.utm_content,
    campaign: first?.utm_campaign ?? last?.utm_campaign,
    branchId: key.defaultBranchId?.toString(),
    assignedCounsellor: key.defaultCounsellorId?.toString(),
    notes: [`Website form${input.formId ? ` "${input.formId}"` : ''}${input.pageUrl ? ` on ${input.pageUrl}` : ''}.`, ...(extra.length ? ['Form answers:', ...extra] : []), input.lead.notes].filter(Boolean).join('\n').slice(0, 5000),
    duplicateAction: key.duplicatePolicy ?? 'keep_existing',
  });
  if (!parsed.success) throw ApiError.validation(parsed.error.issues.map((i) => ({ field: `body.lead.${i.path.join('.')}`, message: i.message })));
  const base = { leadSource: parsed.data.leadSource, leadFormExternalId: input.formId, visitorId: input.visitorId, consent: input.consent, occurredAt: submittedAt };
  const touches = [touch(first, base), touch(last, base)].filter((t): t is TouchpointInput => !!t);
  // A submission with no attribution at all is still a (direct) touch at submission time.
  if (!touches.length) touches.push({ origin: 'website_form', ...base, raw: { page_url: input.pageUrl } });
  else if (input.pageUrl) touches[touches.length - 1]!.raw = { ...touches[touches.length - 1]!.raw, page_url: input.pageUrl };
  const result = await createLead(actor, parsed.data, {
    touchpoints: touches,
    inquiry: { idempotencyKey: idempotencyKey ? `website:${key._id.toString()}:${idempotencyKey}` : undefined, provider: 'website' },
  });
  if (result.outcome === 'duplicate_event') return { status: 'duplicate_submission' as const, leadId: result.leadId.toString() };
  const status = result.outcome === 'added_to_existing' ? ('merged' as const) : ('created' as const);
  if (idempotencyKey) {
    await WebhookEventModel.updateOne(
      { organizationId, provider: 'website', eventKey: `${key._id.toString()}:${idempotencyKey}` },
      { $setOnInsert: { organizationId, kind: 'website', provider: 'website', eventKey: `${key._id.toString()}:${idempotencyKey}` }, $set: { status: 'processed', processedAt: new Date(), payload: { leadId: result.leadId.toString(), outcome: status } }, $inc: { attempts: 1 } },
      { upsert: true },
    );
  }
  await WebsiteKeyModel.updateOne({ organizationId, _id: key._id }, { $set: { lastUsedAt: new Date() }, $inc: { submissions: 1 } });
  return { status, leadId: result.leadId.toString() };
}
