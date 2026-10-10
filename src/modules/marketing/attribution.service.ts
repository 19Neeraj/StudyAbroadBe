import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { LeadModel } from '../leads/lead.model.js';
import { AttributionNodeModel, DIMENSIONS, type AttributionSnapshot, type Dimension, type Hierarchy } from './attributionNode.model.js';
import { CampaignMappingModel } from './campaignMapping.model.js';
import { MarketingCampaignModel } from './marketingCampaign.model.js';
import { AttributionTouchpointModel, RAW_KEYS, type TouchOrigin } from './touchpoint.model.js';
import type { createMappingBody, createNodeBody, mappingListQuery, reapplyBody, updateNodeBody, utmPreviewQuery } from './attribution.validation.js';

type OrgId = Types.ObjectId;

export interface TouchpointInput {
  origin: TouchOrigin;
  occurredAt?: Date | undefined;
  /** Raw tracking values exactly as received (only keys that were actually present). */
  raw?: Record<string, string | undefined> | undefined;
  leadSource?: string | undefined;
  campaignName?: string | undefined;
  provider?: string | undefined;
  accountExternalId?: string | undefined;
  campaignExternalId?: string | undefined;
  adsetExternalId?: string | undefined;
  adExternalId?: string | undefined;
  leadFormExternalId?: string | undefined;
  visitorId?: string | undefined;
  /** P/S/T chosen by a person (validated with assertAttributionPath). Wins over campaign mappings. */
  attribution?: AttributionPathInput | undefined;
  consent?: { analytics?: boolean | undefined; ads?: boolean | undefined; method?: string | undefined } | undefined;
}

type LevelInput = { l1?: string | null | undefined; l2?: string | null | undefined; l3?: string | null | undefined };
export type AttributionPathInput = Partial<Record<Dimension, LevelInput>>;

const TRACKING_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'gbraid', 'wbraid'];

/** Keeps only received, non-empty values (never invents a value). */
function cleanRaw(raw: TouchpointInput['raw']) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'string' && v.length && v.length <= 2000) out[k] = v;
  return out;
}

const normalize = (raw: Record<string, string>) => Object.fromEntries(Object.entries(raw).filter(([k]) => (RAW_KEYS as readonly string[]).includes(k)).map(([k, v]) => [k, v.trim().toLowerCase()]));

/** Mapping valid at `at`, most specific first: ad → ad set → campaign; then utm_campaign. */
export async function resolveMapping(organizationId: OrgId, t: { provider?: string | undefined; campaignExternalId?: string | undefined; adsetExternalId?: string | undefined; adExternalId?: string | undefined; utmCampaign?: string | undefined }, at: Date) {
  const valid = { effectiveFrom: { $lte: at }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] };
  const tries: Record<string, unknown>[] = [];
  if (t.provider && t.campaignExternalId) {
    if (t.adExternalId) tries.push({ provider: t.provider, campaignExternalId: t.campaignExternalId, adExternalId: t.adExternalId });
    if (t.adsetExternalId) tries.push({ provider: t.provider, campaignExternalId: t.campaignExternalId, adsetExternalId: t.adsetExternalId, adExternalId: null });
    tries.push({ provider: t.provider, campaignExternalId: t.campaignExternalId, adsetExternalId: null, adExternalId: null });
  }
  if (t.utmCampaign) tries.push({ provider: 'utm', campaignExternalId: t.utmCampaign.trim().toLowerCase(), adsetExternalId: null, adExternalId: null });
  for (const q of tries) {
    const m = await CampaignMappingModel.findOne({ organizationId, ...q, ...valid }).sort({ effectiveFrom: -1 }).lean();
    if (m) return m;
  }
  return null;
}

function snapshotOf(m: Awaited<ReturnType<typeof resolveMapping>>): AttributionSnapshot {
  if (!m) return {};
  return Object.fromEntries(DIMENSIONS.map((d) => [d, m[d] ?? {}])) as AttributionSnapshot;
}

/**
 * Re-derives a lead's first/last touch from its touchpoints. First touch = earliest; it only
 * changes when touchpoints are merged in from another lead (the earlier one wins). Last touch =
 * latest non-direct touch (a direct visit never replaces a known campaign touch), else latest.
 */
export async function refreshLeadAttribution(organizationId: OrgId, leadId: Types.ObjectId, opts: { allowFirstChange?: boolean } = {}) {
  const [lead, touches] = await Promise.all([
    LeadModel.findOne({ organizationId, _id: leadId }).select('firstTouchId').lean(),
    AttributionTouchpointModel.find({ organizationId, leadId }).sort({ occurredAt: 1, _id: 1 }).lean(),
  ]);
  if (!lead || !touches.length) return;
  const earliest = touches[0]!;
  const keep = !opts.allowFirstChange && lead.firstTouchId ? touches.find((t) => t._id.equals(lead.firstTouchId!)) : undefined;
  const first = keep ?? earliest;
  const nonDirect = touches.filter((t) => !t.isDirect);
  const last = (nonDirect.length ? nonDirect : touches)[(nonDirect.length ? nonDirect : touches).length - 1]!;
  const summary = (t: typeof first) => {
    const n = (t.normalized ?? {}) as Record<string, string | undefined>;
    return {
      origin: t.origin,
      occurredAt: t.occurredAt,
      provider: t.provider,
      campaignExternalId: t.campaignExternalId,
      adsetExternalId: t.adsetExternalId,
      adExternalId: t.adExternalId,
      formExternalId: t.leadFormExternalId ?? n.form_id,
      utmSource: n.utm_source,
      utmMedium: n.utm_medium,
      utmCampaign: n.utm_campaign,
      utmTerm: n.utm_term,
      utmContent: n.utm_content,
      landingPage: (t.raw as Record<string, string | undefined> | undefined)?.landing_url ?? (t.raw as Record<string, string | undefined> | undefined)?.page_url,
      isDirect: t.isDirect,
    };
  };
  const attr = (h?: Hierarchy | null) => ({ l1: h?.l1 ?? undefined, l2: h?.l2 ?? undefined, l3: h?.l3 ?? undefined });
  await LeadModel.updateOne(
    { organizationId, _id: leadId },
    {
      $set: {
        firstTouchId: first._id,
        lastTouchId: last._id,
        firstTouch: summary(first),
        latestTouch: summary(last),
        attribution: { source: attr(first.source), medium: attr(first.medium), campaign: attr(first.campaign) },
        latestAttribution: { source: attr(last.source), medium: attr(last.medium), campaign: attr(last.campaign) },
      },
    },
  );
  // A touch older than the kept first touch is recorded but flagged for review, not silently promoted.
  if (keep && earliest.occurredAt < keep.occurredAt && !earliest.flags?.includes('earlier_than_first_touch')) {
    await AttributionTouchpointModel.updateOne({ organizationId, _id: earliest._id }, { $addToSet: { flags: 'earlier_than_first_touch' } });
  }
}

/** Records one touchpoint for a lead and refreshes first/last touch. */
export async function recordTouchpoint(organizationId: OrgId, leadId: Types.ObjectId, input: TouchpointInput) {
  const raw = cleanRaw(input.raw);
  const normalized = normalize(raw);
  const occurredAt = input.occurredAt && !Number.isNaN(input.occurredAt.getTime()) && input.occurredAt <= new Date(Date.now() + 5 * 60_000) ? input.occurredAt : new Date();
  const isDirect = !TRACKING_KEYS.some((k) => raw[k]) && !input.campaignExternalId && !input.adExternalId && !input.leadFormExternalId;
  const manual = input.attribution && DIMENSIONS.some((d) => input.attribution?.[d]?.l1) ? toSnapshot(input.attribution) : null;
  const mapping = manual ? null : await resolveMapping(organizationId, { ...input, utmCampaign: normalized.utm_campaign }, occurredAt);
  const tp = await AttributionTouchpointModel.create({
    organizationId,
    leadId,
    origin: input.origin,
    occurredAt,
    raw,
    normalized,
    isDirect,
    leadSource: input.leadSource,
    campaignName: input.campaignName,
    provider: input.provider,
    accountExternalId: input.accountExternalId,
    campaignExternalId: input.campaignExternalId,
    adsetExternalId: input.adsetExternalId,
    adExternalId: input.adExternalId,
    leadFormExternalId: input.leadFormExternalId,
    visitorId: input.visitorId,
    consent: input.consent ? { ...input.consent, capturedAt: new Date() } : undefined,
    mappingId: mapping?._id,
    attributionMethod: manual ? 'manual' : mapping ? 'mapping' : 'none',
    ...(manual ?? snapshotOf(mapping)),
  });
  await refreshLeadAttribution(organizationId, leadId);
  return tp;
}

/** Touchpoints derived from the CRM's own attribution fields (manual entry, CSV import). */
export function touchFromLeadFields(input: Record<string, unknown>, origin: TouchOrigin): TouchpointInput {
  const f = (k: string) => (typeof input[k] === 'string' && input[k] ? (input[k] as string) : undefined);
  return {
    origin,
    leadSource: f('leadSource'),
    campaignName: f('campaign'),
    raw: { utm_source: f('utmSource'), utm_medium: f('utmMedium'), utm_campaign: f('utmCampaign'), utm_term: f('utmTerm'), utm_content: f('utmContent') },
  };
}

/** Merge: the surviving lead takes every touchpoint; its first touch becomes the earliest of both. */
export async function moveTouchpoints(organizationId: OrgId, fromLeadId: Types.ObjectId, toLeadId: Types.ObjectId) {
  await AttributionTouchpointModel.updateMany({ organizationId, leadId: fromLeadId }, { leadId: toLeadId });
  await refreshLeadAttribution(organizationId, toLeadId, { allowFirstChange: true });
}

function toSnapshot(path: AttributionPathInput): AttributionSnapshot {
  const id = (v?: string | null) => (v ? new Types.ObjectId(v) : undefined);
  return Object.fromEntries(DIMENSIONS.map((d) => [d, { l1: id(path[d]?.l1), l2: id(path[d]?.l2), l3: id(path[d]?.l3) }])) as AttributionSnapshot;
}

/**
 * Rejects attribution paths the hierarchy doesn't allow: each given level must exist, be active,
 * belong to the dimension and sit under the level above it. Missing lower levels stay "unknown".
 */
export async function assertAttributionPath(ctx: Pick<ServiceContext, 'organizationId'>, path: AttributionPathInput | undefined, fieldPrefix = 'body.attribution') {
  if (!path) return;
  for (const d of DIMENSIONS) await assertHierarchy(ctx, d, path[d], { fieldPrefix, requireActive: true });
}

// ---------------------------------------------------------------- hierarchy masters

async function assertParent(ctx: ServiceContext, dimension: Dimension, level: number, parentId?: string | null) {
  if (level === 1) {
    if (parentId) throw ApiError.validation([{ field: 'body.parentId', message: 'A primary value has no parent' }]);
    return;
  }
  if (!parentId) throw ApiError.validation([{ field: 'body.parentId', message: `A level-${level} value needs a level-${level - 1} parent` }]);
  const parent = await AttributionNodeModel.findOne({ organizationId: ctx.organizationId, _id: parentId }).lean();
  if (!parent || parent.dimension !== dimension || parent.level !== level - 1) {
    throw ApiError.validation([{ field: 'body.parentId', message: `Parent must be a level-${level - 1} ${dimension} value` }]);
  }
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'value';

export async function listNodes(ctx: ServiceContext, dimension?: Dimension) {
  return AttributionNodeModel.find({ organizationId: ctx.organizationId, ...(dimension ? { dimension } : {}) }).sort({ dimension: 1, level: 1, order: 1, label: 1 }).select('-organizationId -__v').lean();
}

export async function listOptions(ctx: ServiceContext, dimension?: Dimension) {
  return AttributionNodeModel.find({ organizationId: ctx.organizationId, isActive: true, ...(dimension ? { dimension } : {}) })
    .sort({ dimension: 1, level: 1, order: 1, label: 1 })
    .select('dimension level parentId label key isActive')
    .lean();
}

export async function createNode(ctx: ServiceContext, input: z.infer<typeof createNodeBody>) {
  await assertParent(ctx, input.dimension, input.level, input.parentId);
  const key = input.key ?? slug(input.label);
  if (await AttributionNodeModel.exists({ organizationId: ctx.organizationId, dimension: input.dimension, key })) throw ApiError.conflict(`A ${input.dimension} value with key "${key}" already exists`);
  const node = await AttributionNodeModel.create({ ...input, key, organizationId: ctx.organizationId, createdBy: ctx.userId, updatedBy: ctx.userId });
  await recordAudit(ctx, { entityType: 'attribution_node', entityId: node._id, action: 'marketing.node_created', metadata: { dimension: input.dimension, level: input.level, key } });
  return node.toObject();
}

export async function updateNode(ctx: ServiceContext, id: string, input: z.infer<typeof updateNodeBody>) {
  const node = await AttributionNodeModel.findOne({ organizationId: ctx.organizationId, _id: id });
  if (!node) throw ApiError.notFound('Value');
  if (input.parentId !== undefined) await assertParent(ctx, node.dimension, node.level, input.parentId);
  node.set({ ...input, updatedBy: ctx.userId });
  await node.save();
  await recordAudit(ctx, { entityType: 'attribution_node', entityId: node._id, action: 'marketing.node_updated', metadata: input });
  return node.toObject();
}

/** Every given level must exist, and each level must be a child of the one above. */
async function assertHierarchy(
  ctx: Pick<ServiceContext, 'organizationId'>,
  dimension: Dimension,
  h: LevelInput | undefined,
  opts: { fieldPrefix?: string; requireActive?: boolean } = {},
) {
  if (!h) return;
  const prefix = opts.fieldPrefix ?? 'body';
  if ((h.l2 && !h.l1) || (h.l3 && !h.l2)) throw ApiError.validation([{ field: `${prefix}.${dimension}`, message: 'Lower levels need the levels above them' }]);
  const ids = [h.l1, h.l2, h.l3].filter((v): v is string => !!v);
  if (ids.some((id) => !Types.ObjectId.isValid(id))) throw ApiError.validation([{ field: `${prefix}.${dimension}`, message: 'Invalid value id' }]);
  const nodes = await AttributionNodeModel.find({ organizationId: ctx.organizationId, _id: { $in: ids } }).lean();
  const get = (id?: string | null) => (id ? nodes.find((n) => n._id.toString() === id) : undefined);
  const [n1, n2, n3] = [get(h.l1), get(h.l2), get(h.l3)];
  const bad = (level: number, msg: string) => ApiError.validation([{ field: `${prefix}.${dimension}.l${level}`, message: msg }]);
  if (h.l1 && (!n1 || n1.dimension !== dimension || n1.level !== 1)) throw bad(1, `Not a primary ${dimension} value`);
  if (h.l2 && (!n2 || n2.dimension !== dimension || n2.level !== 2 || !n2.parentId?.equals(n1!._id))) throw bad(2, 'Secondary value does not belong to the chosen primary');
  if (h.l3 && (!n3 || n3.dimension !== dimension || n3.level !== 3 || !n3.parentId?.equals(n2!._id))) throw bad(3, 'Tertiary value does not belong to the chosen secondary');
  if (opts.requireActive) {
    const inactive = [n1, n2, n3].findIndex((n) => n && !n.isActive);
    if (inactive >= 0) throw bad(inactive + 1, 'This value is inactive');
  }
}

// ---------------------------------------------------------------- campaign mappings

export async function listMappings(ctx: ServiceContext, q: z.infer<typeof mappingListQuery>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (q.provider) filter.provider = q.provider;
  if (q.status) filter.status = q.status;
  if (q.campaignExternalId) filter.campaignExternalId = q.campaignExternalId;
  const items = await CampaignMappingModel.find(filter).sort({ status: 1, updatedAt: -1 }).limit(500).populate({ path: 'createdBy updatedBy', select: 'fullName', match: { organizationId: ctx.organizationId } }).lean();
  return items.map(({ organizationId: _o, __v: _v, ...m }) => m);
}

/** Creating a mapping for an ID that already has one supersedes it from `effectiveFrom`. */
export async function createMapping(ctx: ServiceContext, input: z.infer<typeof createMappingBody>) {
  for (const d of DIMENSIONS) await assertHierarchy(ctx, d, input[d]);
  const key = { provider: input.provider, campaignExternalId: input.provider === 'utm' ? input.campaignExternalId.trim().toLowerCase() : input.campaignExternalId, adsetExternalId: input.adsetExternalId ?? null, adExternalId: input.adExternalId ?? null };
  const from = input.effectiveFrom ?? new Date();
  const ext = input.provider === 'utm' ? null : await MarketingCampaignModel.findOne({ organizationId: ctx.organizationId, provider: input.provider, externalId: input.adExternalId ?? input.adsetExternalId ?? input.campaignExternalId }).select('name accountExternalId').lean();
  const previous = await CampaignMappingModel.find({ organizationId: ctx.organizationId, ...key, status: 'active' }).lean();
  await CampaignMappingModel.updateMany({ organizationId: ctx.organizationId, ...key, status: 'active' }, { status: 'superseded', effectiveTo: from, updatedBy: ctx.userId });
  const clean = (h?: { l1?: string | null | undefined; l2?: string | null | undefined; l3?: string | null | undefined }) => ({ l1: h?.l1 ?? undefined, l2: h?.l2 ?? undefined, l3: h?.l3 ?? undefined });
  const mapping = await CampaignMappingModel.create({
    organizationId: ctx.organizationId,
    ...key,
    accountExternalId: input.accountExternalId ?? ext?.accountExternalId,
    externalName: input.externalName ?? ext?.name,
    source: clean(input.source),
    medium: clean(input.medium),
    campaign: clean(input.campaign),
    effectiveFrom: from,
    notes: input.notes,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await recordAudit(ctx, { entityType: 'campaign_mapping', entityId: mapping._id, action: previous.length ? 'marketing.mapping_changed' : 'marketing.mapping_created', metadata: { ...key, supersedes: previous.map((p) => p._id.toString()) } });
  return mapping.toObject();
}

/**
 * Historical reports use the snapshot stored on each touchpoint (the mapping valid at the time).
 * This explicitly re-resolves snapshots for a date range — e.g. after correcting a wrong mapping.
 */
export async function reapplyMappings(ctx: ServiceContext, input: z.infer<typeof reapplyBody>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, occurredAt: { $gte: input.from, $lte: input.to } };
  if (input.provider) filter.provider = input.provider;
  if (input.campaignExternalId) filter.campaignExternalId = input.campaignExternalId;
  let changed = 0;
  const leads = new Set<string>();
  for await (const t of AttributionTouchpointModel.find(filter).cursor()) {
    const m = await resolveMapping(ctx.organizationId, { provider: t.provider ?? undefined, campaignExternalId: t.campaignExternalId ?? undefined, adsetExternalId: t.adsetExternalId ?? undefined, adExternalId: t.adExternalId ?? undefined, utmCampaign: (t.normalized as Record<string, string> | undefined)?.utm_campaign }, t.occurredAt);
    if (String(m?._id ?? '') === String(t.mappingId ?? '')) continue;
    t.set({ mappingId: m?._id ?? null, ...Object.fromEntries(DIMENSIONS.map((d) => [d, m?.[d] ?? {}])) });
    await t.save();
    changed++;
    if (t.leadId) leads.add(t.leadId.toString());
  }
  for (const id of leads) await refreshLeadAttribution(ctx.organizationId, new Types.ObjectId(id));
  await recordAudit(ctx, { entityType: 'campaign_mapping', action: 'marketing.mappings_reapplied', metadata: { ...input, touchpointsChanged: changed, leadsUpdated: leads.size } });
  return { touchpointsChanged: changed, leadsUpdated: leads.size };
}

// ---------------------------------------------------------------- views

export async function leadAttribution(ctx: ServiceContext, leadId: Types.ObjectId) {
  const [lead, touches] = await Promise.all([
    LeadModel.findOne({ organizationId: ctx.organizationId, _id: leadId }).select('firstTouchId lastTouchId attribution firstTouch').lean(),
    AttributionTouchpointModel.find({ organizationId: ctx.organizationId, leadId }).sort({ occurredAt: 1 }).select('-organizationId -__v').lean(),
  ]);
  const nodeIds = touches.flatMap((t) => DIMENSIONS.flatMap((d) => [t[d]?.l1, t[d]?.l2, t[d]?.l3])).filter(Boolean);
  const nodes = await AttributionNodeModel.find({ organizationId: ctx.organizationId, _id: { $in: nodeIds } }).select('label').lean();
  const label = (id?: Types.ObjectId | null) => (id ? (nodes.find((n) => n._id.equals(id))?.label ?? null) : null);
  const view = touches.map((t) => ({
    ...t,
    hierarchy: Object.fromEntries(DIMENSIONS.map((d) => [d, [label(t[d]?.l1), label(t[d]?.l2), label(t[d]?.l3)]])),
    isFirst: !!lead?.firstTouchId?.equals(t._id),
    isLast: !!lead?.lastTouchId?.equals(t._id),
  }));
  return { firstTouch: view.find((t) => t.isFirst) ?? null, lastTouch: view.find((t) => t.isLast) ?? null, touchpoints: view };
}

/** Meta dynamic URL parameters documented for ad URL parameters (verify against Meta docs when changing). */
export const META_URL_TOKENS = ['{{campaign.id}}', '{{campaign.name}}', '{{adset.id}}', '{{adset.name}}', '{{ad.id}}', '{{ad.name}}', '{{placement}}', '{{site_source_name}}'];

/**
 * Builds the final landing URL from a destination URL and a UTM template, keeping existing query
 * parameters, avoiding double "?" and double encoding, and flagging tokens Meta doesn't document.
 */
export async function utmPreview(ctx: ServiceContext, q: z.infer<typeof utmPreviewQuery>) {
  const warnings: string[] = [];
  let url: URL;
  try {
    url = new URL(q.url);
  } catch {
    throw ApiError.validation([{ field: 'query.url', message: 'Enter a full URL including https://' }]);
  }
  if (url.protocol !== 'https:') warnings.push('The destination is not HTTPS.');
  const template = q.template.replace(/^[?&]+/, '');
  const params: { key: string; value: string; source: 'existing' | 'template' }[] = [...url.searchParams.entries()].map(([key, value]) => ({ key, value, source: 'existing' as const }));
  for (const part of template.split('&').filter(Boolean)) {
    const [k, ...rest] = part.split('=');
    const key = decodeURIComponent((k ?? '').trim());
    // Decode once so already-encoded values aren't encoded twice.
    let value = rest.join('=').trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      warnings.push(`Could not decode the value of "${key}"; it is used as typed.`);
    }
    if (!key) continue;
    for (const token of value.match(/\{\{[^}]*\}\}/g) ?? []) if (!META_URL_TOKENS.includes(token)) warnings.push(`${token} is not a documented Meta dynamic parameter; it may reach your site unchanged.`);
    const existing = params.findIndex((p) => p.key === key);
    if (existing >= 0) {
      warnings.push(`"${key}" already exists in the destination URL; the template value replaces it.`);
      params.splice(existing, 1);
    }
    params.push({ key, value, source: 'template' });
  }
  if (!params.some((p) => p.key === 'utm_source')) warnings.push('utm_source is missing.');
  if (!params.some((p) => p.key === 'utm_medium')) warnings.push('utm_medium is missing.');
  if (!params.some((p) => p.key === 'utm_campaign')) warnings.push('utm_campaign is missing.');
  // Encode values but keep {{tokens}} readable for the ad platform to substitute.
  const enc = (v: string) => v.split(/(\{\{[^}]*\}\})/).map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part))).join('');
  const query = params.map((p) => `${encodeURIComponent(p.key)}=${enc(p.value)}`).join('&');
  const finalUrl = `${url.origin}${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
  // "Detected on incoming traffic": which keys real touchpoints carried in the last 30 days.
  const since = new Date(Date.now() - 30 * 86_400_000);
  const detected = await AttributionTouchpointModel.aggregate<{ _id: string; n: number }>([
    { $match: { organizationId: ctx.organizationId, occurredAt: { $gte: since } } },
    { $project: { keys: { $objectToArray: '$raw' } } },
    { $unwind: '$keys' },
    { $group: { _id: '$keys.k', n: { $sum: 1 } } },
  ]);
  const urlTemplate = params.filter((p) => p.source === 'template').map((p) => `${encodeURIComponent(p.key)}=${enc(p.value)}`).join('&');
  return { finalUrl, urlTags: urlTemplate, params, warnings, detected: Object.fromEntries(detected.map((d) => [d._id, d.n])) };
}

export type { TouchOrigin };
