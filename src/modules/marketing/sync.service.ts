import type { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { adsProvider, ProviderAuthError, type AdsCredentials, type AdsProvider, type DailyMetricRow } from '../../integrations/ads/index.js';
import { enqueue } from '../../jobs/queue.js';
import { emitTo, rooms } from '../../sockets/index.js';
import { credentialsOf } from '../integrations/integration.service.js';
import { ADS_KINDS, IntegrationModel } from '../integrations/integration.model.js';
import { IntegrationAccountModel } from './integrationAccount.model.js';
import { ingestLead } from './leadImport.service.js';
import { MarketingCampaignModel } from './marketingCampaign.model.js';
import { METRIC_FIELDS, MarketingDailyMetricModel, type MetricField } from './marketingDailyMetric.model.js';
import { redact, toMinor } from './money.js';
import { IntegrationSyncLogModel, type SyncTrigger, type SyncType } from './syncLog.model.js';

type Counts = { imported: number; updated: number; skipped: number; failed: number };
interface SyncInput {
  organizationId: Types.ObjectId;
  integrationId: Types.ObjectId;
  type: SyncType;
  trigger: SyncTrigger;
  triggeredBy?: Types.ObjectId | undefined;
  /** Metrics window (account-timezone dates). Defaults to the last 3 days. */
  from?: string | undefined;
  to?: string | undefined;
}

const DAY = 86_400_000;
/** Today's date in an IANA timezone, as YYYY-MM-DD. */
export function dateInZone(d: Date, timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

async function syncAccounts(organizationId: Types.ObjectId, integrationId: Types.ObjectId, provider: AdsProvider, creds: AdsCredentials, counts: Counts) {
  const firstTime = !(await IntegrationAccountModel.exists({ organizationId, integrationId }));
  const found = await provider.listAccounts(creds);
  const pageIds: string[] = [];
  const upsert = async (a: (typeof found)[number]) => {
    const res = await IntegrationAccountModel.updateOne(
      { organizationId, provider: provider.key, type: a.type, externalId: a.externalId },
      {
        $set: { integrationId, name: a.name, parentExternalId: a.parentExternalId, currency: a.currency, timezone: a.timezone, status: a.status, lastSeenAt: new Date() },
        // First connection selects everything found; later discoveries wait for the admin.
        $setOnInsert: { organizationId, provider: provider.key, type: a.type, externalId: a.externalId, selected: firstTime || a.type === 'business' },
      },
      { upsert: true },
    );
    if (res.upsertedCount) counts.imported++;
    else counts.updated++;
  };
  for (const a of found) await upsert(a);
  for (const p of await IntegrationAccountModel.find({ organizationId, integrationId, type: 'page', selected: true }).select('externalId').lean()) pageIds.push(p.externalId);
  for (const page of pageIds) {
    const forms = provider.listLeadForms ? await provider.listLeadForms(creds, page) : [];
    // Forms of a selected page are synced by default.
    for (const f of forms) {
      const res = await IntegrationAccountModel.updateOne(
        { organizationId, provider: provider.key, type: 'lead_form', externalId: f.externalId },
        { $set: { integrationId, name: f.name, parentExternalId: page, status: f.status, lastSeenAt: new Date() }, $setOnInsert: { organizationId, provider: provider.key, type: 'lead_form', externalId: f.externalId, selected: true } },
        { upsert: true },
      );
      if (res.upsertedCount) counts.imported++;
      else counts.updated++;
    }
  }
}

async function syncCampaigns(organizationId: Types.ObjectId, integrationId: Types.ObjectId, provider: AdsProvider, creds: AdsCredentials, counts: Counts) {
  const accounts = await IntegrationAccountModel.find({ organizationId, integrationId, type: 'ad_account', selected: true }).lean();
  for (const acc of accounts) {
    for await (const e of provider.syncCampaigns(creds, acc.externalId)) {
      const now = new Date();
      const filter = { organizationId, provider: provider.key, level: e.level, externalId: e.externalId };
      const existing = await MarketingCampaignModel.findOne(filter).select('name').lean();
      const set = {
        accountExternalId: acc.externalId,
        parentExternalId: e.parentExternalId,
        campaignExternalId: e.campaignExternalId ?? (e.level === 'campaign' ? e.externalId : undefined),
        name: e.name,
        status: e.status,
        effectiveStatus: e.effectiveStatus,
        objective: e.objective,
        startAt: e.startAt,
        endAt: e.endAt,
        budget: e.dailyBudget !== undefined || e.lifetimeBudget !== undefined ? { dailyMinor: toMinor(e.dailyBudget, acc.currency), lifetimeMinor: toMinor(e.lifetimeBudget, acc.currency), currency: acc.currency } : undefined,
        destinationUrl: e.destinationUrl,
        urlTags: e.urlTags,
        lastSyncedAt: now,
      };
      const renamed = existing && e.name && existing.name !== e.name;
      await MarketingCampaignModel.updateOne(
        filter,
        {
          $set: Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)),
          $setOnInsert: { organizationId, provider: provider.key, level: e.level, externalId: e.externalId, firstSeenAt: now },
          ...(renamed || !existing ? { $push: { nameHistory: { name: e.name, seenAt: now } } } : {}),
        },
        { upsert: true },
      );
      if (existing) counts.updated++;
      else counts.imported++;
    }
  }
}

function metricValues(row: DailyMetricRow, currency?: string) {
  const values: Record<MetricField, number | undefined> = {
    spendMinor: toMinor(row.spend, currency),
    impressions: row.impressions,
    reach: row.reach,
    clicks: row.clicks,
    linkClicks: row.linkClicks,
    ctr: row.ctr,
    linkCtr: row.linkCtr,
    cpcMinor: toMinor(row.cpc, currency),
    costPerLinkClickMinor: toMinor(row.costPerLinkClick, currency),
    cpmMinor: toMinor(row.cpm, currency),
    providerLeads: row.providerLeads,
  };
  const unavailable = METRIC_FIELDS.filter((f) => values[f] === undefined || Number.isNaN(values[f]));
  return { values: Object.fromEntries(METRIC_FIELDS.map((f) => [f, unavailable.includes(f) ? null : values[f]])), unavailable };
}

async function syncMetrics(organizationId: Types.ObjectId, integrationId: Types.ObjectId, provider: AdsProvider, creds: AdsCredentials, counts: Counts, window: { from?: string | undefined; to?: string | undefined }) {
  const accounts = await IntegrationAccountModel.find({ organizationId, integrationId, type: 'ad_account', selected: true }).lean();
  for (const acc of accounts) {
    const to = window.to ?? dateInZone(new Date(), acc.timezone ?? 'UTC');
    const from = window.from ?? dateInZone(new Date(Date.now() - 2 * DAY), acc.timezone ?? 'UTC');
    for (const level of ['account', 'campaign', 'adset', 'ad'] as const) {
      for await (const row of provider.fetchDailyMetrics(creds, acc.externalId, level, from, to)) {
        const currency = row.currency ?? acc.currency ?? undefined;
        const { values, unavailable } = metricValues(row, currency);
        // Replace the day (provider corrections overwrite, never add).
        const res = await MarketingDailyMetricModel.updateOne(
          { organizationId, provider: provider.key, level, externalId: row.externalId, date: row.date },
          {
            $set: { ...values, unavailable, currency, accountExternalId: acc.externalId, campaignExternalId: row.campaignExternalId ?? (level === 'campaign' ? row.externalId : undefined), actions: row.actions, fetchedAt: new Date() },
            $setOnInsert: { organizationId, provider: provider.key, level, externalId: row.externalId, date: row.date },
            $inc: { revision: 1 },
          },
          { upsert: true },
        );
        if (res.upsertedCount) counts.imported++;
        else counts.updated++;
      }
    }
  }
}

async function syncLeads(organizationId: Types.ObjectId, integrationId: Types.ObjectId, provider: AdsProvider, creds: AdsCredentials, counts: Counts) {
  if (!provider.pollLeads) return;
  const forms = await IntegrationAccountModel.find({ organizationId, integrationId, type: 'lead_form', selected: true }).lean();
  for (const form of forms) {
    const cursor = (form.cursor as { leadCursor?: string } | undefined)?.leadCursor;
    // One-hour overlap: anything seen twice is ignored by the per-lead idempotency record.
    const since = cursor ? new Date(new Date(cursor).getTime() - 3_600_000) : new Date(Date.now() - 7 * DAY);
    let newest = cursor ? new Date(cursor) : since;
    for await (const lead of provider.pollLeads(creds, form.externalId, since)) {
      const outcome = await ingestLead(organizationId, provider.key, { ...lead, formName: lead.formName ?? form.name ?? undefined }, 'poll').catch((err: Error) => {
        logger.warn({ err: redact(err.message), provider: provider.key }, 'Lead import failed; will retry');
        return 'failed' as const;
      });
      if (outcome === 'created') counts.imported++;
      else if (outcome === 'merged' || outcome === 'duplicate_flagged') counts.updated++;
      else if (outcome === 'failed') counts.failed++;
      else counts.skipped++;
      if (lead.submittedAt && lead.submittedAt > newest) newest = lead.submittedAt;
    }
    await IntegrationAccountModel.updateOne({ organizationId, _id: form._id }, { $set: { 'cursor.leadCursor': newest.toISOString() } });
  }
}

/** Runs one sync and records it in the sync log; the integration's status and sync state follow the result. */
export async function runSync(input: SyncInput): Promise<void> {
  const { organizationId, integrationId, type } = input;
  const integration = await IntegrationModel.findOne({ organizationId, _id: integrationId }).select('+secrets').lean();
  if (!integration?.enabled) return;
  const provider = adsProvider(integration.provider);
  const startedAt = new Date();
  const log = await IntegrationSyncLogModel.create({ organizationId, integrationId, provider: provider.key, syncType: type, trigger: input.trigger, triggeredBy: input.triggeredBy, startedAt, window: input.from || input.to ? { from: input.from, to: input.to } : undefined });
  const counts: Counts = { imported: 0, updated: 0, skipped: 0, failed: 0 };
  await IntegrationModel.updateOne({ organizationId, _id: integrationId }, { $set: { [`syncState.${type}.lastAttemptAt`]: startedAt } });
  emitTo([rooms.organization(organizationId.toString())], 'integration.sync', { provider: provider.key, type, state: 'started' });
  let error: string | undefined;
  let authFailed = false;
  try {
    const creds = credentialsOf(integration);
    if (type === 'accounts') await syncAccounts(organizationId, integrationId, provider, creds, counts);
    else if (type === 'campaigns') await syncCampaigns(organizationId, integrationId, provider, creds, counts);
    else if (type === 'metrics') await syncMetrics(organizationId, integrationId, provider, creds, counts, input);
    else await syncLeads(organizationId, integrationId, provider, creds, counts);
  } catch (err) {
    error = redact((err as Error).message);
    authFailed = err instanceof ProviderAuthError;
  }
  const finishedAt = new Date();
  const result = error ? (counts.imported + counts.updated > 0 ? 'partial' : 'failed') : counts.failed ? 'partial' : 'success';
  await IntegrationSyncLogModel.updateOne({ organizationId, _id: log._id }, { $set: { finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), result, counts, error } });
  await IntegrationModel.updateOne(
    { organizationId, _id: integrationId },
    error
      ? { $set: { status: authFailed ? 'requires_reauthorization' : 'error', lastError: error, [`syncState.${type}.lastError`]: error } }
      : { $set: { status: 'connected', [`syncState.${type}.lastSuccessAt`]: finishedAt }, $unset: { lastError: 1, [`syncState.${type}.lastError`]: 1 } },
  );
  emitTo([rooms.organization(organizationId.toString())], 'integration.sync', { provider: provider.key, type, state: result, counts });
  if (error && !authFailed && result === 'failed') throw new Error(error);
}

/** Queue a sync (deduplicated per integration+type so a burst of clicks runs once). */
export async function queueSync(input: SyncInput) {
  const data = { ...input, organizationId: input.organizationId.toString(), integrationId: input.integrationId.toString(), triggeredBy: input.triggeredBy?.toString() };
  await enqueue('ads.sync', Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)), { jobId: `ads.sync:${data.integrationId}:${input.type}:${input.from ?? ''}:${input.to ?? ''}:${Math.floor(Date.now() / 30_000)}` });
}

/**
 * Every 15 minutes (cross-tenant): leads every run, campaigns hourly, metrics for the last 3 days
 * every 3 hours, and a 28-day re-fetch nightly for late provider corrections.
 */
export async function scheduleDueSyncs(now = new Date()) {
  const integrations = await IntegrationModel.find({ kind: { $in: ADS_KINDS }, enabled: true, status: { $ne: 'requires_reauthorization' } })
    .select('organizationId syncState')
    .setOptions({ skipTenantGuard: true })
    .lean();
  for (const i of integrations) {
    const state = (i.syncState ?? {}) as Record<string, { lastSuccessAt?: Date; lastAttemptAt?: Date }>;
    const age = (t: string) => now.getTime() - new Date(state[t]?.lastAttemptAt ?? 0).getTime();
    const base = { organizationId: i.organizationId, integrationId: i._id, trigger: 'schedule' as const };
    await queueSync({ ...base, type: 'leads' });
    if (age('accounts') > DAY) await queueSync({ ...base, type: 'accounts' });
    if (age('campaigns') > 3_600_000) await queueSync({ ...base, type: 'campaigns' });
    if (age('metrics') > 3 * 3_600_000) await queueSync({ ...base, type: 'metrics' });
    const deep = (state as Record<string, { lastAttemptAt?: Date }>).metrics28?.lastAttemptAt;
    if (now.getTime() - new Date(deep ?? 0).getTime() > DAY) {
      await IntegrationModel.updateOne({ organizationId: i.organizationId, _id: i._id }, { $set: { 'syncState.metrics28.lastAttemptAt': now } });
      await queueSync({ ...base, type: 'metrics', from: dateInZone(new Date(now.getTime() - 27 * DAY)), to: dateInZone(now) });
    }
  }
}
