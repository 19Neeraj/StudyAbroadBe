import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { adsProvider, adsProviderKeys } from '../../integrations/ads/index.js';
import { enqueue } from '../../jobs/queue.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { decryptSecret, encryptSecret, randomToken } from '../../utils/crypto.js';
import { buildPagination, toPaging } from '../../utils/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { ADS_KINDS, IntegrationModel, type Integration } from '../integrations/integration.model.js';
import { LeadModel } from '../leads/lead.model.js';
import { LookupModel } from '../settings/lookup.model.js';
import { UserModel } from '../users/user.model.js';
import { WebsiteKeyModel } from './websiteKey.model.js';
import { ExternalLeadReferenceModel } from './externalLeadReference.model.js';
import { IntegrationFieldMappingModel } from './fieldMapping.model.js';
import { IntegrationAccountModel } from './integrationAccount.model.js';
import { MarketingCampaignModel } from './marketingCampaign.model.js';
import { MarketingDailyMetricModel } from './marketingDailyMetric.model.js';
import { fromMinor } from './money.js';
import { queueSync } from './sync.service.js';
import { IntegrationSyncLogModel } from './syncLog.model.js';
import type { accountsBody, campaignsQuery, connectBody, fieldMappingBody, importedLeadsQuery, settingsBody, syncBody, syncLogQuery } from './hub.validation.js';

/** Catalogue shown on the overview, including connectors that arrive in later stages. */
const CATALOGUE = [
  { kind: 'meta_ads', provider: 'meta', label: 'Meta Ads', stage: 'available' },
  { kind: 'google_ads', provider: 'google_ads', label: 'Google Ads', stage: 'planned (Stage E)' },
  { kind: 'google_analytics', provider: 'ga4', label: 'Google Analytics', stage: 'planned (Stage E)' },

  { kind: 'whatsapp', provider: 'whatsapp', label: 'WhatsApp Business', stage: 'planned (Stage F)' },
  { kind: 'payment', provider: 'payment', label: 'Payment gateway', stage: 'planned (Stage F)' },
] as const;

const webhookUrl = (base: string, doc: { provider: string; webhookToken?: string | null }) => (doc.webhookToken ? `${base}/api/v1/webhooks/ads/${doc.provider}/${doc.webhookToken}` : null);

function secretKeys(doc: { secrets?: string | null }) {
  return doc.secrets ? Object.keys(JSON.parse(decryptSecret(doc.secrets)) as object) : [];
}

async function adsIntegration(ctx: ServiceContext, providerKey: string, withSecrets = false) {
  const q = IntegrationModel.findOne({ organizationId: ctx.organizationId, provider: providerKey, kind: { $in: ADS_KINDS } });
  if (withSecrets) q.select('+secrets +webhookToken');
  return q.lean();
}

async function requireAds(ctx: ServiceContext, providerKey: string) {
  const doc = await adsIntegration(ctx, providerKey, true);
  if (!doc) throw ApiError.notFound('Integration');
  return doc;
}

function knownProvider(key: string) {
  if (!adsProviderKeys().includes(key)) throw ApiError.notFound('Provider');
  return adsProvider(key);
}

/** Never returns secrets: only which keys are set. */
function publicIntegration(doc: Integration & { webhookToken?: string | null }, base: string) {
  return {
    _id: doc._id,
    kind: doc.kind,
    provider: doc.provider,
    enabled: doc.enabled,
    status: doc.status,
    settings: doc.config,
    secretsSet: secretKeys(doc),
    webhookUrl: webhookUrl(base, doc),
    connectedAccountName: doc.connectedAccountName ?? null,
    grantedScopes: doc.grantedScopes ?? [],
    missingScopes: doc.missingScopes ?? [],
    syncState: doc.syncState ?? {},
    lastEventAt: doc.lastEventAt ?? null,
    lastError: doc.lastError ?? null,
    updatedAt: doc.updatedAt,
  };
}

export async function overview(ctx: ServiceContext) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [integrations, counts, accounts, campaigns, failedLeads, recent] = await Promise.all([
    IntegrationModel.find({ organizationId: ctx.organizationId }).lean(),
    IntegrationSyncLogModel.aggregate<{ _id: string; imported: number; updated: number; skipped: number; failed: number }>([
      { $match: { organizationId: ctx.organizationId, startedAt: { $gte: since } } },
      { $group: { _id: '$provider', imported: { $sum: '$counts.imported' }, updated: { $sum: '$counts.updated' }, skipped: { $sum: '$counts.skipped' }, failed: { $sum: '$counts.failed' } } },
    ]),
    IntegrationAccountModel.aggregate<{ _id: { provider: string; type: string }; n: number }>([{ $match: { organizationId: ctx.organizationId, selected: true } }, { $group: { _id: { provider: '$provider', type: '$type' }, n: { $sum: 1 } } }]),
    MarketingCampaignModel.aggregate<{ _id: string; n: number }>([{ $match: { organizationId: ctx.organizationId, level: 'campaign' } }, { $group: { _id: '$provider', n: { $sum: 1 } } }]),
    ExternalLeadReferenceModel.aggregate<{ _id: string; n: number }>([{ $match: { organizationId: ctx.organizationId, status: 'failed' } }, { $group: { _id: '$provider', n: { $sum: 1 } } }]),
    IntegrationSyncLogModel.find({ organizationId: ctx.organizationId }).sort({ startedAt: -1 }).limit(10).populate({ path: 'triggeredBy', select: 'fullName', match: { organizationId: ctx.organizationId } }).lean(),
  ]);
  const ads = integrations.filter((i) => (ADS_KINDS as readonly string[]).includes(i.kind));
  const cards = [
    ...ads.map((i) => {
      const acc = (t: string) => accounts.find((a) => a._id.provider === i.provider && a._id.type === t)?.n ?? 0;
      const state = (i.syncState ?? {}) as Record<string, { lastSuccessAt?: Date; lastAttemptAt?: Date }>;
      return {
        kind: i.kind,
        provider: i.provider,
        label: adsProviderKeys().includes(i.provider) ? adsProvider(i.provider).label : i.provider,
        stage: 'available',
        connected: i.enabled,
        status: i.enabled ? i.status : 'disconnected',
        connectedAccountName: i.connectedAccountName ?? null,
        lastSuccessfulSync: maxDate(Object.values(state).map((s) => s?.lastSuccessAt)),
        lastAttemptedSync: maxDate(Object.values(state).map((s) => s?.lastAttemptAt)),
        lastSpendSync: state.metrics?.lastSuccessAt ?? null,
        counts30d: counts.find((c) => c._id === i.provider) ?? { imported: 0, updated: 0, skipped: 0, failed: 0 },
        failedLeads: failedLeads.find((f) => f._id === i.provider)?.n ?? 0,
        selected: { adAccounts: acc('ad_account'), pages: acc('page'), leadForms: acc('lead_form') },
        campaigns: campaigns.find((c) => c._id === i.provider)?.n ?? 0,
        missingScopes: i.missingScopes ?? [],
        lastError: i.lastError ?? null,
      };
    }),
    // Calling is configured in Calling & Recording settings; shown here for one overview.
    ...integrations.filter((i) => i.kind === 'calling').map((i) => ({ kind: i.kind, provider: i.provider, label: `Calling (${i.provider})`, stage: 'available', connected: i.enabled, status: i.enabled ? i.status : 'disconnected', lastError: i.lastError ?? null, lastEventAt: i.lastEventAt ?? null })),
  ];
  // Website forms: "connected" once an active API key exists.
  const keys = await WebsiteKeyModel.find({ organizationId: ctx.organizationId, revokedAt: null }).select('lastUsedAt submissions').lean();
  cards.push({
    kind: 'website', provider: 'website', label: 'Website forms', stage: 'available', connected: keys.length > 0, status: keys.length ? 'connected' : 'disconnected',
    connectedAccountName: keys.length ? `${keys.length} active API key(s) · ${keys.reduce((s, k) => s + (k.submissions ?? 0), 0)} lead(s) received` : null,
    lastError: null,
  } as (typeof cards)[number]);
  const connectedKinds = new Set(cards.map((c) => c.kind));
  const available = CATALOGUE.filter((c) => !connectedKinds.has(c.kind)).map((c) => ({ ...c, connected: false, status: 'disconnected' }));
  return { cards: [...cards, ...available], recent: recent.map(syncLogDto) };
}

const maxDate = (ds: (Date | undefined)[]) => ds.filter(Boolean).sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null;

export async function getStatus(ctx: ServiceContext, providerKey: string, base: string) {
  const provider = knownProvider(providerKey);
  const doc = await adsIntegration(ctx, providerKey, true);
  return {
    provider: { key: provider.key, label: provider.label, requiredScopes: provider.requiredScopes, secretKeys: provider.secretKeys, configKeys: provider.configKeys, capabilities: provider.capabilities },
    integration: doc ? publicIntegration(doc, base) : null,
  };
}

async function assertSettings(ctx: ServiceContext, s: z.infer<typeof settingsBody>) {
  if (s.defaultBranchId && !(await BranchModel.exists({ organizationId: ctx.organizationId, _id: s.defaultBranchId, isActive: true }))) {
    throw ApiError.validation([{ field: 'body.settings.defaultBranchId', message: 'Branch not found' }]);
  }
  if (s.defaultCounsellorId && !(await UserModel.exists({ organizationId: ctx.organizationId, _id: s.defaultCounsellorId, isActive: true }))) {
    throw ApiError.validation([{ field: 'body.settings.defaultCounsellorId', message: 'User not found' }]);
  }
  if (s.leadSource && !(await LookupModel.exists({ organizationId: ctx.organizationId, type: 'lead_source', key: s.leadSource, isActive: true }))) {
    throw ApiError.validation([{ field: 'body.settings.leadSource', message: 'Unknown lead source' }]);
  }
  if (s.defaultStage && !(await LookupModel.exists({ organizationId: ctx.organizationId, type: 'lead_stage', key: s.defaultStage, isActive: true }))) {
    throw ApiError.validation([{ field: 'body.settings.defaultStage', message: 'Unknown lead stage' }]);
  }
}

/**
 * Validates the credentials with the provider before saving. Missing scopes still connect (so
 * the admin sees exactly what's missing) but the status says reauthorization is required.
 */
export async function connect(ctx: ServiceContext, providerKey: string, input: z.infer<typeof connectBody>, base: string) {
  const provider = knownProvider(providerKey);
  if (input.settings) await assertSettings(ctx, input.settings);
  const existing = await IntegrationModel.findOne({ organizationId: ctx.organizationId, kind: provider.kind }).select('+secrets +webhookToken');
  const prev = existing?.secrets && existing.provider === providerKey ? (JSON.parse(decryptSecret(existing.secrets)) as Record<string, string>) : {};
  const secrets = { ...prev };
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    if (!provider.secretKeys.includes(k)) throw ApiError.validation([{ field: `body.secrets.${k}`, message: 'Unknown credential' }]);
    if (v) secrets[k] = v;
    else delete secrets[k];
  }
  const config = { ...(existing?.provider === providerKey ? (existing.config as object) : {}), ...(input.config ?? {}), ...(input.settings ?? {}) };
  const check = await provider.validate({ config, secrets });
  if (!check.ok) throw ApiError.validation([{ field: 'body.secrets.accessToken', message: `The provider rejected these credentials: ${check.error ?? 'invalid token'}` }]);

  const update = {
    provider: providerKey,
    enabled: true,
    config,
    secrets: encryptSecret(JSON.stringify(secrets)),
    status: check.missingScopes.length ? ('requires_reauthorization' as const) : ('connected' as const),
    grantedScopes: check.grantedScopes,
    missingScopes: check.missingScopes,
    tokenExpiresAt: check.expiresAt,
    connectedAccountName: check.accountName,
    connectedBy: ctx.userId,
    lastError: check.missingScopes.length ? `Missing permissions: ${check.missingScopes.join(', ')}` : undefined,
    updatedBy: ctx.userId,
  };
  let id: Types.ObjectId;
  if (existing) {
    existing.set(update);
    if (!existing.webhookToken) existing.set({ webhookToken: randomToken(32) });
    await existing.save();
    id = existing._id;
  } else {
    id = (await IntegrationModel.create({ ...update, organizationId: ctx.organizationId, kind: provider.kind, webhookToken: randomToken(32) }))._id;
  }
  await recordAudit(ctx, {
    entityType: 'integration',
    entityId: id,
    action: `integration.${providerKey}.connected`,
    metadata: { missingScopes: check.missingScopes, secretKeysChanged: Object.keys(input.secrets ?? {}) },
  });
  // Discover accounts first, then the rest (sequenced by the queue's per-type jobs).
  await queueSync({ organizationId: ctx.organizationId, integrationId: id, type: 'accounts', trigger: 'connect', triggeredBy: ctx.userId });
  return getStatus(ctx, providerKey, base);
}

export async function updateSettings(ctx: ServiceContext, providerKey: string, input: z.infer<typeof settingsBody>, base: string) {
  knownProvider(providerKey);
  const doc = await requireAds(ctx, providerKey);
  await assertSettings(ctx, input);
  const config = { ...(doc.config as object), ...input };
  for (const [k, v] of Object.entries(input)) if (v === null) delete (config as Record<string, unknown>)[k];
  await IntegrationModel.updateOne({ organizationId: ctx.organizationId, _id: doc._id }, { config, updatedBy: ctx.userId });
  await recordAudit(ctx, { entityType: 'integration', entityId: doc._id, action: `integration.${providerKey}.settings_updated`, metadata: input });
  return getStatus(ctx, providerKey, base);
}

/** Stops syncing and erases credentials; history, imported leads and metrics stay. */
export async function disconnect(ctx: ServiceContext, providerKey: string, base: string) {
  const doc = await requireAds(ctx, providerKey);
  await IntegrationModel.updateOne({ organizationId: ctx.organizationId, _id: doc._id }, { $set: { enabled: false, status: 'disconnected', updatedBy: ctx.userId }, $unset: { secrets: 1, grantedScopes: 1, missingScopes: 1 } });
  await recordAudit(ctx, { entityType: 'integration', entityId: doc._id, action: `integration.${providerKey}.disconnected` });
  return getStatus(ctx, providerKey, base);
}

export async function rotateWebhook(ctx: ServiceContext, providerKey: string, base: string) {
  const doc = await requireAds(ctx, providerKey);
  await IntegrationModel.updateOne({ organizationId: ctx.organizationId, _id: doc._id }, { webhookToken: randomToken(32) });
  await recordAudit(ctx, { entityType: 'integration', entityId: doc._id, action: `integration.${providerKey}.webhook_rotated` });
  return getStatus(ctx, providerKey, base);
}

export async function listAccounts(ctx: ServiceContext, providerKey: string) {
  knownProvider(providerKey);
  const items = await IntegrationAccountModel.find({ organizationId: ctx.organizationId, provider: providerKey }).sort({ type: 1, name: 1 }).lean();
  return items.map(({ organizationId: _o, __v: _v, cursor: _c, ...a }) => a);
}

export async function selectAccounts(ctx: ServiceContext, providerKey: string, input: z.infer<typeof accountsBody>) {
  const doc = await requireAds(ctx, providerKey);
  for (const a of input.accounts) {
    await IntegrationAccountModel.updateOne({ organizationId: ctx.organizationId, provider: providerKey, _id: a.id }, { selected: a.selected });
  }
  await recordAudit(ctx, { entityType: 'integration', entityId: doc._id, action: `integration.${providerKey}.accounts_selected`, metadata: { accounts: input.accounts } });
  // Newly selected pages need their forms discovered.
  await queueSync({ organizationId: ctx.organizationId, integrationId: doc._id, type: 'accounts', trigger: 'manual', triggeredBy: ctx.userId });
  return listAccounts(ctx, providerKey);
}

export async function syncNow(ctx: ServiceContext, providerKey: string, input: z.infer<typeof syncBody>) {
  const doc = await requireAds(ctx, providerKey);
  if (!doc.enabled) throw ApiError.conflict('Integration is disconnected');
  const types = input.type === 'all' ? (['accounts', 'campaigns', 'metrics', 'leads'] as const) : [input.type];
  for (const type of types) await queueSync({ organizationId: ctx.organizationId, integrationId: doc._id, type, trigger: 'manual', triggeredBy: ctx.userId, from: input.from, to: input.to });
  await recordAudit(ctx, { entityType: 'integration', entityId: doc._id, action: `integration.${providerKey}.sync_requested`, metadata: input });
  return { queued: types };
}

function syncLogDto(l: Record<string, unknown>) {
  const { organizationId: _o, __v: _v, ...rest } = l;
  return rest;
}

export async function listSyncLogs(ctx: ServiceContext, q: z.infer<typeof syncLogQuery>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (q.provider) filter.provider = q.provider;
  if (q.syncType) filter.syncType = q.syncType;
  if (q.result) filter.result = q.result;
  if (q.from || q.to) filter.startedAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([IntegrationSyncLogModel.find(filter).sort({ startedAt: -1 }).skip(skip).limit(limit).populate({ path: 'triggeredBy', select: 'fullName', match: { organizationId: ctx.organizationId } }).lean(), IntegrationSyncLogModel.countDocuments(filter)]);
  return { items: items.map((i) => syncLogDto(i as unknown as Record<string, unknown>)), pagination: buildPagination(q.page, limit, total) };
}

function leadRefDto(r: Record<string, unknown>, withAnswers: boolean) {
  const { organizationId: _o, __v: _v, lockedUntil: _l, answers, ...rest } = r;
  return withAnswers ? { ...rest, answers } : rest;
}

export async function listImportedLeads(ctx: ServiceContext, q: z.infer<typeof importedLeadsQuery>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (q.provider) filter.provider = q.provider;
  if (q.status?.length) filter.status = { $in: q.status };
  if (q.campaignExternalId) filter.campaignExternalId = q.campaignExternalId;
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    ExternalLeadReferenceModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate({ path: 'leadId', select: 'leadNumber fullName', match: { organizationId: ctx.organizationId } }).lean(),
    ExternalLeadReferenceModel.countDocuments(filter),
  ]);
  // Form answers are personal data: only users who can view leads see them.
  const withAnswers = ctx.permissions.has('lead.view');
  return { items: items.map((i) => leadRefDto(i as unknown as Record<string, unknown>, withAnswers)), pagination: buildPagination(q.page, limit, total) };
}

export async function failedJobs(ctx: ServiceContext) {
  const [leads, syncs] = await Promise.all([
    ExternalLeadReferenceModel.find({ organizationId: ctx.organizationId, status: 'failed' }).sort({ updatedAt: -1 }).limit(100).lean(),
    IntegrationSyncLogModel.find({ organizationId: ctx.organizationId, result: { $in: ['failed', 'partial'] }, startedAt: { $gte: new Date(Date.now() - 7 * 86_400_000) } }).sort({ startedAt: -1 }).limit(50).lean(),
  ]);
  return { leads: leads.map((l) => leadRefDto(l as unknown as Record<string, unknown>, false)), syncs: syncs.map((s) => syncLogDto(s as unknown as Record<string, unknown>)) };
}

/** Re-queues failed lead imports (one or all). Already imported leads are never re-imported. */
export async function retryLeads(ctx: ServiceContext, id?: string) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, status: 'failed' };
  if (id) filter._id = new Types.ObjectId(id);
  const refs = await ExternalLeadReferenceModel.find(filter).select('provider externalLeadId').limit(500).lean();
  if (id && !refs.length) throw ApiError.notFound('Failed lead');
  for (const r of refs) await enqueue('ads.processLead', { organizationId: ctx.organizationId.toString(), provider: r.provider, externalLeadId: r.externalLeadId, via: 'retry' }, { jobId: `ads.lead:${r._id.toString()}:${Date.now()}` });
  await recordAudit(ctx, { entityType: 'integration', action: 'integration.leads_retried', metadata: { count: refs.length, id } });
  return { queued: refs.length };
}

export async function retrySync(ctx: ServiceContext, logId: string) {
  const log = await IntegrationSyncLogModel.findOne({ organizationId: ctx.organizationId, _id: logId }).lean();
  if (!log?.integrationId) throw ApiError.notFound('Sync run');
  await queueSync({ organizationId: ctx.organizationId, integrationId: log.integrationId, type: log.syncType, trigger: 'retry', triggeredBy: ctx.userId, from: log.window?.from ?? undefined, to: log.window?.to ?? undefined });
  return { queued: [log.syncType] };
}

/** Campaign → ad set → ad tree with totals for the date range (spend stays in each account's currency). */
export async function campaignTree(ctx: ServiceContext, providerKey: string, q: z.infer<typeof campaignsQuery>) {
  const entities = await MarketingCampaignModel.find({ organizationId: ctx.organizationId, provider: providerKey, level: { $in: ['campaign', 'adset', 'ad'] }, ...(q.status ? { effectiveStatus: q.status } : {}) }).sort({ name: 1 }).lean();
  const match: Record<string, unknown> = { organizationId: ctx.organizationId, provider: providerKey, level: { $in: ['campaign', 'adset', 'ad'] } };
  if (q.from || q.to) match.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const totals = await MarketingDailyMetricModel.aggregate<{ _id: { level: string; id: string }; currency: string; spendMinor: number | null; impressions: number | null; clicks: number | null; providerLeads: number | null; days: number; spendDays: number }>([
    { $match: match },
    {
      $group: {
        _id: { level: '$level', id: '$externalId' },
        currency: { $first: '$currency' },
        spendMinor: { $sum: '$spendMinor' },
        impressions: { $sum: '$impressions' },
        clicks: { $sum: '$clicks' },
        providerLeads: { $sum: '$providerLeads' },
        days: { $sum: 1 },
        spendDays: { $sum: { $cond: [{ $eq: ['$spendMinor', null] }, 0, 1] } },
      },
    },
  ]);
  // Same rule as the reports: unique CRM leads first acquired from the campaign in the range.
  const crmLeads = await LeadModel.aggregate<{ _id: string; n: number }>([
    {
      $match: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        mergedInto: null,
        leadStatus: { $ne: 'duplicate' },
        'firstTouch.provider': providerKey,
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { $gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59Z`) } : {}) } } : {}),
      },
    },
    { $group: { _id: '$firstTouch.campaignExternalId', n: { $sum: 1 } } },
  ]);
  const t = (level: string, id: string) => {
    const r = totals.find((x) => x._id.level === level && x._id.id === id);
    if (!r) return { spend: null, currency: null, impressions: null, clicks: null, providerLeads: null, spendAvailable: false };
    // Spend is "unavailable" (not 0) when no day in range carried it.
    return { spend: r.spendDays ? fromMinor(r.spendMinor, r.currency) : null, currency: r.currency, impressions: r.impressions, clicks: r.clicks, providerLeads: r.providerLeads, spendAvailable: r.spendDays > 0 };
  };
  const node = (e: (typeof entities)[number]) => ({ _id: e._id, level: e.level, externalId: e.externalId, name: e.name, status: e.effectiveStatus ?? e.status, objective: e.objective, accountExternalId: e.accountExternalId, urlTags: e.urlTags, renamed: (e.nameHistory?.length ?? 0) > 1, metrics: t(e.level, e.externalId) });
  return entities
    .filter((e) => e.level === 'campaign')
    .map((c) => {
      const leads = crmLeads.find((x) => x._id === c.externalId)?.n ?? 0;
      const m = t('campaign', c.externalId);
      return {
        ...node(c),
        crmLeads: leads,
        cpl: m.spend !== null && leads > 0 ? m.spend / leads : null,
        adsets: entities.filter((s) => s.level === 'adset' && s.parentExternalId === c.externalId).map((s) => ({ ...node(s), ads: entities.filter((a) => a.level === 'ad' && a.parentExternalId === s.externalId).map(node) })),
      };
    });
}

export async function getFieldMappings(ctx: ServiceContext, providerKey: string) {
  knownProvider(providerKey);
  const [mappings, forms] = await Promise.all([
    IntegrationFieldMappingModel.find({ organizationId: ctx.organizationId, provider: providerKey }).lean(),
    IntegrationAccountModel.find({ organizationId: ctx.organizationId, provider: providerKey, type: 'lead_form' }).select('externalId name selected').lean(),
  ]);
  // Field names seen in recent submissions help the admin map custom questions.
  const recent = await ExternalLeadReferenceModel.find({ organizationId: ctx.organizationId, provider: providerKey, answers: { $exists: true } }).sort({ createdAt: -1 }).limit(50).select('formExternalId answers').lean();
  const seen: Record<string, string[]> = {};
  for (const r of recent) seen[r.formExternalId ?? ''] = [...new Set([...(seen[r.formExternalId ?? ''] ?? []), ...Object.keys((r.answers as object) ?? {})])];
  return { mappings: mappings.map(({ organizationId: _o, __v: _v, ...m }) => m), forms, seenFields: seen };
}

export async function saveFieldMapping(ctx: ServiceContext, providerKey: string, input: z.infer<typeof fieldMappingBody>) {
  knownProvider(providerKey);
  await IntegrationFieldMappingModel.updateOne(
    { organizationId: ctx.organizationId, provider: providerKey, formExternalId: input.formExternalId ?? null },
    { $set: { rules: input.rules, updatedBy: ctx.userId }, $setOnInsert: { organizationId: ctx.organizationId, provider: providerKey, formExternalId: input.formExternalId ?? null } },
    { upsert: true },
  );
  await recordAudit(ctx, { entityType: 'integration', action: `integration.${providerKey}.field_mapping_saved`, metadata: input });
  return getFieldMappings(ctx, providerKey);
}
