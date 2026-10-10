import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { safeEqual } from '../../utils/crypto.js';
import type { AdsCredentials, AdsProvider, AdsWebhookEvent, DailyMetricRow, ExternalAccount, ExternalEntity, ExternalLead } from './ads.provider.js';
import { ProviderAuthError, ProviderRateLimitError } from './ads.provider.js';

/**
 * Meta (Facebook/Instagram) Marketing + Lead Ads adapter, Graph API.
 *
 * Written against Meta's documented endpoints (version pinned per connection, default below; check
 * the changelog before upgrading). It has NOT been run against a live account yet — Stage B
 * acceptance needs the client's app, System User token and a test lead form (plan D1/D5).
 *
 * Credentials: secrets.accessToken (System User token), secrets.appSecret (webhook signatures),
 * secrets.verifyToken (webhook subscription handshake). Config: apiVersion.
 */
export const META_DEFAULT_API_VERSION = 'v26.0';
const GRAPH = 'https://graph.facebook.com';
const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform';
// Meta error codes for throttling (application, user, ad account, API-level).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);

type GraphPage<T> = { data?: T[]; paging?: { next?: string } };

function version(creds: AdsCredentials) {
  const v = String(creds.config.apiVersion ?? META_DEFAULT_API_VERSION);
  return /^v\d+\.\d+$/.test(v) ? v : META_DEFAULT_API_VERSION;
}

async function graph<T>(creds: AdsCredentials, pathOrUrl: string, params: Record<string, string> = {}): Promise<T> {
  if (!creds.secrets.accessToken) throw new ProviderAuthError('Access token missing');
  const url = pathOrUrl.startsWith('https://') ? new URL(pathOrUrl) : new URL(`${GRAPH}/${version(creds)}/${pathOrUrl.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Token in a header, never in the URL, so it can't leak into logs.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${creds.secrets.accessToken}` }, signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; type?: string } };
  if (!res.ok || body.error) {
    const code = body.error?.code;
    const message = `Meta API ${res.status}${code ? ` (code ${code})` : ''}: ${body.error?.message ?? res.statusText}`;
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) throw new ProviderRateLimitError(message, 5 * 60_000);
    if (code === 190 || code === 102 || res.status === 401) throw new ProviderAuthError(message);
    throw new Error(message);
  }
  return body;
}

async function* pages<T>(creds: AdsCredentials, path: string, params: Record<string, string>): AsyncIterable<T> {
  let next: string | undefined;
  let page = await graph<GraphPage<T>>(creds, path, { limit: '200', ...params });
  for (;;) {
    for (const item of page.data ?? []) yield item;
    next = page.paging?.next;
    if (!next) return;
    page = await graph<GraphPage<T>>(creds, next);
  }
}

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const date = (v: unknown) => (typeof v === 'string' && v ? new Date(v) : undefined);
const actId = (id: string) => (id.startsWith('act_') ? id : `act_${id}`);

function toLead(raw: Record<string, unknown>): ExternalLead {
  const answers: Record<string, string> = {};
  for (const f of (raw.field_data as { name: string; values?: string[] }[] | undefined) ?? []) answers[f.name] = (f.values ?? []).join(', ');
  return {
    externalLeadId: String(raw.id),
    submittedAt: date(raw.created_time),
    formExternalId: raw.form_id as string | undefined,
    campaignExternalId: raw.campaign_id as string | undefined,
    campaignName: raw.campaign_name as string | undefined,
    adsetExternalId: raw.adset_id as string | undefined,
    adsetName: raw.adset_name as string | undefined,
    adExternalId: raw.ad_id as string | undefined,
    adName: raw.ad_name as string | undefined,
    platform: raw.platform as string | undefined,
    isOrganic: raw.is_organic as boolean | undefined,
    answers,
  };
}

export const metaAdsProvider: AdsProvider = {
  key: 'meta',
  label: 'Meta Ads',
  kind: 'meta_ads',
  capabilities: { leads: true, metrics: true, webhooks: true, writeUrlTags: false },
  requiredScopes: ['ads_read', 'leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'business_management'],
  secretKeys: ['accessToken', 'appSecret', 'verifyToken'],
  configKeys: ['apiVersion'],

  async validate(creds) {
    try {
      const me = await graph<{ id: string; name?: string }>(creds, 'me', { fields: 'id,name' });
      const perms = await graph<{ data: { permission: string; status: string }[] }>(creds, 'me/permissions');
      const granted = perms.data.filter((p) => p.status === 'granted').map((p) => p.permission);
      return { ok: true, accountName: me.name ?? me.id, grantedScopes: granted, missingScopes: this.requiredScopes.filter((s) => !granted.includes(s)) };
    } catch (err) {
      return { ok: false, grantedScopes: [], missingScopes: [...this.requiredScopes], error: (err as Error).message };
    }
  },

  async listAccounts(creds) {
    const out: ExternalAccount[] = [];
    for await (const a of pages<Record<string, unknown>>(creds, 'me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status' })) {
      out.push({ type: 'ad_account', externalId: String(a.id), name: a.name as string, currency: a.currency as string, timezone: a.timezone_name as string, status: String(a.account_status ?? '') });
    }
    for await (const p of pages<Record<string, unknown>>(creds, 'me/accounts', { fields: 'id,name' })) {
      out.push({ type: 'page', externalId: String(p.id), name: p.name as string });
    }
    return out;
  },

  async listLeadForms(creds, pageId) {
    const out: ExternalAccount[] = [];
    for await (const f of pages<Record<string, unknown>>(creds, `${pageId}/leadgen_forms`, { fields: 'id,name,status' })) {
      out.push({ type: 'lead_form', externalId: String(f.id), name: f.name as string, status: f.status as string, parentExternalId: pageId });
    }
    return out;
  },

  async *syncCampaigns(creds, account) {
    const a = actId(account);
    for await (const c of pages<Record<string, unknown>>(creds, `${a}/campaigns`, { fields: 'id,name,objective,status,effective_status,start_time,stop_time,daily_budget,lifetime_budget' })) {
      yield { level: 'campaign', externalId: String(c.id), name: c.name as string, objective: c.objective as string, status: c.status as string, effectiveStatus: c.effective_status as string, startAt: date(c.start_time), endAt: date(c.stop_time), dailyBudget: minorToMajor(c.daily_budget), lifetimeBudget: minorToMajor(c.lifetime_budget) } satisfies ExternalEntity;
    }
    for await (const s of pages<Record<string, unknown>>(creds, `${a}/adsets`, { fields: 'id,name,campaign_id,status,effective_status,start_time,end_time,daily_budget,lifetime_budget' })) {
      yield { level: 'adset', externalId: String(s.id), parentExternalId: s.campaign_id as string, campaignExternalId: s.campaign_id as string, name: s.name as string, status: s.status as string, effectiveStatus: s.effective_status as string, startAt: date(s.start_time), endAt: date(s.end_time), dailyBudget: minorToMajor(s.daily_budget), lifetimeBudget: minorToMajor(s.lifetime_budget) } satisfies ExternalEntity;
    }
    for await (const ad of pages<Record<string, unknown>>(creds, `${a}/ads`, { fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,url_tags}' })) {
      const creative = ad.creative as { url_tags?: string } | undefined;
      yield { level: 'ad', externalId: String(ad.id), parentExternalId: ad.adset_id as string, campaignExternalId: ad.campaign_id as string, name: ad.name as string, status: ad.status as string, effectiveStatus: ad.effective_status as string, urlTags: creative?.url_tags } satisfies ExternalEntity;
    }
  },

  async *fetchDailyMetrics(creds, account, level, from, to) {
    const fields = ['spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'inline_link_click_ctr', 'cpc', 'cost_per_inline_link_click', 'cpm', 'actions', 'account_currency', 'date_start', 'campaign_id', 'adset_id', 'ad_id'];
    for await (const r of pages<Record<string, unknown>>(creds, `${actId(account)}/insights`, { level, time_increment: '1', time_range: JSON.stringify({ since: from, until: to }), fields: fields.join(',') })) {
      const actions = (r.actions as { action_type: string; value: string }[] | undefined)?.map((x) => ({ type: x.action_type, value: Number(x.value) }));
      const id = level === 'account' ? account : String(r[`${level}_id`]);
      yield {
        level, externalId: id, campaignExternalId: r.campaign_id as string | undefined, date: String(r.date_start), currency: r.account_currency as string | undefined,
        spend: num(r.spend), impressions: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks), linkClicks: num(r.inline_link_clicks),
        ctr: num(r.ctr), linkCtr: num(r.inline_link_click_ctr), cpc: num(r.cpc), costPerLinkClick: num(r.cost_per_inline_link_click), cpm: num(r.cpm),
        // Meta reports lead-form submissions as the "lead" action; absent means unavailable, not zero.
        providerLeads: actions ? actions.filter((x) => x.type === 'lead').reduce((s, x) => s + x.value, 0) : undefined,
        actions,
      } satisfies DailyMetricRow;
    }
  },

  async fetchLead(creds, id) {
    return toLead(await graph<Record<string, unknown>>(creds, id, { fields: LEAD_FIELDS }));
  },

  async *pollLeads(creds, form, since) {
    const filtering = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(since.getTime() / 1000) }]);
    for await (const l of pages<Record<string, unknown>>(creds, `${form}/leads`, { fields: LEAD_FIELDS, filtering })) yield toLead(l);
  },

  verifyWebhook(req: Request, creds) {
    const secret = creds.secrets.appSecret;
    const header = String(req.headers['x-hub-signature-256'] ?? '');
    if (!secret || !req.rawBody || !header.startsWith('sha256=')) throw new Error('Missing signature');
    const expected = `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
    if (!safeEqual(expected, header)) throw new Error('Invalid signature');
  },

  webhookChallenge(query, creds) {
    const token = creds.secrets.verifyToken;
    return token && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === token ? String(query['hub.challenge'] ?? '') : null;
  },

  parseWebhook(req: Request): AdsWebhookEvent[] {
    const body = req.body as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
    if (body.object !== 'page') return [];
    const events: AdsWebhookEvent[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen' || !change.value?.leadgen_id) continue;
        const v = change.value;
        events.push({ eventKey: `leadgen:${String(v.leadgen_id)}`, kind: 'lead', externalLeadId: String(v.leadgen_id), pageExternalId: v.page_id ? String(v.page_id) : entry.id, formExternalId: v.form_id ? String(v.form_id) : undefined, adExternalId: v.ad_id ? String(v.ad_id) : undefined, raw: v });
      }
    }
    return events;
  },
};

/** Meta returns budgets in the account currency's minor units (e.g. paise) as strings. */
function minorToMajor(v: unknown) {
  const n = num(v);
  return n === undefined ? undefined : n / 100;
}
