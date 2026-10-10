import type { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { adsProvider, ProviderAuthError, ProviderRateLimitError, type ExternalLead } from '../../integrations/ads/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { credentialsOf } from '../integrations/integration.service.js';
import { IntegrationModel } from '../integrations/integration.model.js';
import { createLead } from '../leads/lead.service.js';
import { createLeadBody } from '../leads/lead.validation.js';
import type { LookupType } from '../../constants/lookups.js';
import { LookupModel } from '../settings/lookup.model.js';
import { ActorUnavailableError, integrationActor } from './actor.js';
import { DONE_STATUSES, ExternalLeadReferenceModel, type ExternalLeadStatus } from './externalLeadReference.model.js';
import { IntegrationFieldMappingModel, type MappableField } from './fieldMapping.model.js';
import { redact } from './money.js';

export const DUPLICATE_POLICIES = ['keep_existing', 'mark_duplicate', 'create_separate'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

/** Import settings stored in Integration.config (plan D2: keep_existing by default). */
export interface ImportSettings {
  leadSource?: string;
  duplicatePolicy?: DuplicatePolicy;
  defaultBranchId?: string;
  defaultCounsellorId?: string;
  defaultStage?: string;
}

/** Meta's standard lead-form field names (custom questions are mapped by the admin). */
const DEFAULT_RULES: Record<string, MappableField> = {
  full_name: 'fullName',
  first_name: 'firstName',
  last_name: 'lastName',
  email: 'email',
  phone_number: 'phone',
  phone: 'phone',
  whatsapp_number: 'whatsappNumber',
  city: 'city',
  state: 'state',
  province: 'state',
  country: 'country',
};
const LOOKUP_FIELDS: Partial<Record<MappableField, LookupType>> = { countryInterested: 'country', courseInterested: 'course', degreeLevel: 'degree_level', intake: 'intake' };
const LOCK_MS = 2 * 60_000;

export type IngestOutcome = ExternalLeadStatus | 'duplicate_event';

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function resolveLookup(organizationId: Types.ObjectId, type: LookupType, value: string): Promise<string | undefined> {
  const items = await LookupModel.find({ organizationId, type, isActive: true }).select('key label').lean();
  const v = norm(value);
  return items.find((i) => norm(i.key) === v || norm(i.label) === v)?.key;
}

/** Applies the field mapping; anything unmapped or unrecognised is kept in the lead's notes, never dropped. */
export async function mapAnswers(organizationId: Types.ObjectId, provider: string, lead: ExternalLead) {
  const mapping = await IntegrationFieldMappingModel.find({ organizationId, provider, formExternalId: { $in: [null, lead.formExternalId ?? null] } }).lean();
  const custom = new Map<string, MappableField>();
  // Form-specific rules win over the provider default.
  for (const m of mapping.sort((a) => (a.formExternalId ? 1 : -1))) for (const r of m.rules) custom.set(r.externalField, r.crmField as MappableField);

  const out: Record<string, unknown> = {};
  const leftovers: string[] = [];
  for (const [field, raw] of Object.entries(lead.answers)) {
    const value = raw.trim();
    if (!value) continue;
    const target = custom.get(field) ?? DEFAULT_RULES[field];
    if (!target) {
      leftovers.push(`${field}: ${value}`);
      continue;
    }
    const lookupType = LOOKUP_FIELDS[target];
    if (lookupType) {
      const key = await resolveLookup(organizationId, lookupType, value);
      if (key) out[target] = key;
      else leftovers.push(`${field}: ${value}`);
    } else if (target === 'budget') {
      const n = Number(value.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n) && n > 0) out.budget = n;
      else leftovers.push(`${field}: ${value}`);
    } else if (target === 'fullName') {
      const [first, ...rest] = value.split(/\s+/);
      out.firstName ??= first;
      if (rest.length) out.lastName ??= rest.join(' ');
    } else if (target === 'notes') {
      leftovers.push(`${field}: ${value}`);
    } else {
      out[target] = value;
    }
  }
  return { fields: out, leftovers };
}

/**
 * Records a provider lead (idempotent by provider lead ID) and imports it once.
 * `lead` may be only an ID with hints (webhook); details are then fetched from the provider.
 * Returns the outcome. Transient provider errors are re-thrown so the job queue retries.
 */
export async function ingestLead(
  organizationId: Types.ObjectId,
  providerKey: string,
  lead: Partial<ExternalLead> & { externalLeadId: string },
  via: 'webhook' | 'poll' | 'api' | 'retry',
): Promise<IngestOutcome> {
  const now = new Date();
  const ids = {
    formExternalId: lead.formExternalId,
    adExternalId: lead.adExternalId,
    adsetExternalId: lead.adsetExternalId,
    campaignExternalId: lead.campaignExternalId,
    pageExternalId: lead.pageExternalId,
    submittedAt: lead.submittedAt,
  };
  await ExternalLeadReferenceModel.updateOne(
    { organizationId, provider: providerKey, externalLeadId: lead.externalLeadId },
    { $setOnInsert: { organizationId, provider: providerKey, externalLeadId: lead.externalLeadId, status: 'received', receivedVia: via, ...Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== undefined)) } },
    { upsert: true },
  );
  // Claim: only one worker processes a lead; finished leads are never processed again.
  const ref = await ExternalLeadReferenceModel.findOneAndUpdate(
    {
      organizationId,
      provider: providerKey,
      externalLeadId: lead.externalLeadId,
      status: { $nin: DONE_STATUSES },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!ref) return 'duplicate_event';

  const finish = async (status: ExternalLeadStatus, extra: Record<string, unknown> = {}) => {
    await ExternalLeadReferenceModel.updateOne({ organizationId, _id: ref._id }, { $set: { status, processedAt: new Date(), ...extra }, $unset: { lockedUntil: 1, ...(status === 'failed' ? {} : { lastError: 1 }) } });
    return status;
  };

  try {
    const integration = await IntegrationModel.findOne({ organizationId, provider: providerKey, kind: { $in: ['meta_ads', 'google_ads'] } }).select('+secrets').lean();
    if (!integration?.enabled) throw new ActorUnavailableError('Integration is not connected');
    const provider = adsProvider(providerKey);
    const full: ExternalLead = lead.answers ? (lead as ExternalLead) : await provider.fetchLead(credentialsOf(integration), lead.externalLeadId);
    await ExternalLeadReferenceModel.updateOne(
      { organizationId, _id: ref._id },
      { $set: { answers: full.answers, formExternalId: full.formExternalId, adExternalId: full.adExternalId, adsetExternalId: full.adsetExternalId, campaignExternalId: full.campaignExternalId, submittedAt: full.submittedAt } },
    );
    if (full.isOrganic === true && lead.answers === undefined) logger.info({ provider: providerKey }, 'Importing organic lead-form submission');

    const actor = await integrationActor(organizationId, integration.connectedBy);
    const settings = (integration.config ?? {}) as ImportSettings;
    const { fields, leftovers } = await mapAnswers(organizationId, providerKey, full);
    const sourceNote = `Imported from ${provider.label}${full.formName ? ` form "${full.formName}"` : ''} (lead ${full.externalLeadId}).`;
    const parsed = createLeadBody.safeParse({
      firstName: 'Unknown',
      ...fields,
      leadSource: settings.leadSource ?? (provider.kind === 'meta_ads' ? 'meta' : 'google'),
      platform: full.platform ?? provider.label,
      campaign: full.campaignName,
      adSet: full.adsetName,
      ad: full.adName,
      leadForm: full.formName ?? full.formExternalId,
      utmSource: full.tracking?.utm_source,
      utmMedium: full.tracking?.utm_medium,
      utmCampaign: full.tracking?.utm_campaign,
      utmTerm: full.tracking?.utm_term,
      utmContent: full.tracking?.utm_content,
      branchId: settings.defaultBranchId,
      assignedCounsellor: settings.defaultCounsellorId,
      leadStage: settings.defaultStage,
      notes: [sourceNote, ...(leftovers.length ? ['Form answers:', ...leftovers] : [])].join('\n').slice(0, 5000),
      duplicateAction: settings.duplicatePolicy ?? 'keep_existing',
    });
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'lead'}: ${i.message}`).join('; ');
      return await finish('failed', { lastError: redact(`Cannot import: ${message}`) });
    }
    const result = await createLead(actor, parsed.data, {
      inquiry: { idempotencyKey: `${providerKey}:${full.externalLeadId}`, externalLeadId: full.externalLeadId, provider: providerKey },
      touchpoints: [
        {
          origin: provider.kind === 'meta_ads' ? 'meta_lead_ad' : 'google_ads',
          occurredAt: full.submittedAt,
          leadSource: parsed.data.leadSource,
          campaignName: full.campaignName,
          provider: providerKey,
          campaignExternalId: full.campaignExternalId,
          adsetExternalId: full.adsetExternalId,
          adExternalId: full.adExternalId,
          leadFormExternalId: full.formExternalId,
          // Only what the provider actually delivered.
          raw: full.tracking,
        },
      ],
    });
    if (result.outcome === 'added_to_existing' || result.outcome === 'duplicate_event') return await finish('merged', { leadId: result.leadId });
    const flagged = result.lead?.leadStatus === 'duplicate';
    return await finish(flagged ? 'duplicate_flagged' : 'created', { leadId: result.leadId });
  } catch (err) {
    const message = err instanceof ApiError ? `${err.message}${err.details ? `: ${JSON.stringify(err.details).slice(0, 300)}` : ''}` : (err as Error).message;
    await finish('failed', { lastError: redact(message) });
    if (err instanceof ProviderAuthError) {
      await IntegrationModel.updateOne({ organizationId, provider: providerKey }, { status: 'requires_reauthorization', lastError: redact(message) });
    }
    // Transient: let the queue retry. Permanent (validation, permissions, inactive user): stays failed for review.
    if (err instanceof ProviderRateLimitError || !(err instanceof ApiError || err instanceof ActorUnavailableError || err instanceof ProviderAuthError)) throw err;
    return 'failed';
  }
}
