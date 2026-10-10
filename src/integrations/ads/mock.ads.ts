import type { Request } from 'express';
import type { AdsCredentials, AdsProvider, AdsWebhookEvent, DailyMetricRow, ExternalEntity, ExternalLead } from './ads.provider.js';
import { ProviderAuthError } from './ads.provider.js';

/**
 * Deterministic ads provider for tests, demos and local development (disabled in production).
 * Tests add leads with `mockAds.addLead` and can correct metrics with `mockAds.spendOverride`.
 */
export const mockAds = {
  leads: new Map<string, ExternalLead>(),
  spendOverride: new Map<string, number>(),
  /** Simulated missing scopes (tests of reauthorization). */
  missingScopes: [] as string[],
  addLead(lead: ExternalLead) {
    this.leads.set(lead.externalLeadId, lead);
    return lead;
  },
  reset() {
    this.leads.clear();
    this.spendOverride.clear();
    this.missingScopes = [];
  },
};

const ENTITIES: ExternalEntity[] = [
  { level: 'campaign', externalId: 'c-100', name: 'UK Sep Intake', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_LEADS', dailyBudget: 2500 },
  { level: 'campaign', externalId: 'c-200', name: 'Canada PG Diploma', status: 'PAUSED', effectiveStatus: 'PAUSED', objective: 'OUTCOME_LEADS', dailyBudget: 1500 },
  { level: 'adset', externalId: 's-110', parentExternalId: 'c-100', campaignExternalId: 'c-100', name: 'UK · Delhi 21-30', status: 'ACTIVE' },
  { level: 'adset', externalId: 's-210', parentExternalId: 'c-200', campaignExternalId: 'c-200', name: 'Canada · Punjab', status: 'PAUSED' },
  { level: 'ad', externalId: 'a-111', parentExternalId: 's-110', campaignExternalId: 'c-100', name: 'UK Carousel', status: 'ACTIVE', urlTags: 'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}' },
  { level: 'ad', externalId: 'a-211', parentExternalId: 's-210', campaignExternalId: 'c-200', name: 'Canada Video', status: 'PAUSED' },
];

/** Stable pseudo-random number per key. */
function seeded(key: string) {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

function days(from: string, to: string) {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function check(creds: AdsCredentials) {
  if (!creds.secrets.accessToken) throw new ProviderAuthError('Access token missing');
  if (creds.secrets.accessToken === 'expired') throw new ProviderAuthError('Token expired');
}

export const mockAdsProvider: AdsProvider = {
  key: 'mock',
  label: 'Mock Ads (test)',
  kind: 'meta_ads',
  capabilities: { leads: true, metrics: true, webhooks: true, writeUrlTags: false },
  requiredScopes: ['ads_read', 'leads_retrieval'],
  secretKeys: ['accessToken', 'appSecret', 'verifyToken'],
  configKeys: [],
  async validate(creds) {
    if (!creds.secrets.accessToken || creds.secrets.accessToken === 'expired') return { ok: false, grantedScopes: [], missingScopes: [...this.requiredScopes], error: 'Token is invalid or expired' };
    const missing = mockAds.missingScopes;
    return { ok: true, accountName: 'Mock Business', grantedScopes: this.requiredScopes.filter((s) => !missing.includes(s)), missingScopes: [...missing] };
  },
  async listAccounts(creds) {
    check(creds);
    return [
      { type: 'business', externalId: 'b-1', name: 'Mock Business' },
      { type: 'ad_account', externalId: 'act_1001', name: 'Demo Ads INR', currency: 'INR', timezone: 'Asia/Kolkata', status: 'ACTIVE', parentExternalId: 'b-1' },
      { type: 'page', externalId: 'p-2001', name: 'Demo Overseas Page', parentExternalId: 'b-1' },
    ];
  },
  async listLeadForms(creds, page) {
    check(creds);
    return [{ type: 'lead_form', externalId: 'f-3001', name: 'UK Enquiry Form', parentExternalId: page, status: 'ACTIVE' }];
  },
  async *syncCampaigns(creds) {
    check(creds);
    yield* ENTITIES;
  },
  async *fetchDailyMetrics(creds, account, level, from, to) {
    check(creds);
    const ids = level === 'account' ? [account] : ENTITIES.filter((e) => e.level === level).map((e) => e.externalId);
    for (const date of days(from, to)) {
      for (const id of ids) {
        const r = seeded(`${id}:${date}`);
        const impressions = Math.round(1000 + r * 9000);
        const clicks = Math.round(impressions * (0.01 + r * 0.02));
        const spend = mockAds.spendOverride.get(`${id}:${date}`) ?? Math.round((800 + r * 3200) * 100) / 100;
        const campaign = ENTITIES.find((e) => e.externalId === id)?.campaignExternalId ?? (level === 'campaign' ? id : undefined);
        const row: DailyMetricRow = { level, externalId: id, campaignExternalId: campaign, date, currency: 'INR', spend, impressions, clicks, linkClicks: Math.round(clicks * 0.8), cpm: (spend / impressions) * 1000, cpc: clicks ? spend / clicks : undefined, ctr: (clicks / impressions) * 100, providerLeads: Math.round(r * 6) };
        // Reach is only reported at account/campaign level, like real providers often do.
        if (level === 'account' || level === 'campaign') row.reach = Math.round(impressions * 0.7);
        yield row;
      }
    }
  },
  async fetchLead(creds, id) {
    check(creds);
    const lead = mockAds.leads.get(id);
    if (!lead) throw new Error(`Lead ${id} not found at provider`);
    return lead;
  },
  async *pollLeads(creds, form, since) {
    check(creds);
    for (const l of mockAds.leads.values()) if (l.formExternalId === form && (!l.submittedAt || l.submittedAt > since)) yield l;
  },
  verifyWebhook(req: Request, creds) {
    if (req.headers['x-mock-signature'] !== (creds.secrets.appSecret ?? '')) throw new Error('Invalid signature');
  },
  webhookChallenge(query, creds) {
    return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === creds.secrets.verifyToken ? String(query['hub.challenge'] ?? '') : null;
  },
  parseWebhook(req: Request): AdsWebhookEvent[] {
    const body = req.body as { leads?: { id: string; page?: string; form?: string }[] };
    return (body.leads ?? []).map((l) => ({ eventKey: `leadgen:${l.id}`, kind: 'lead', externalLeadId: l.id, pageExternalId: l.page, formExternalId: l.form, raw: l }));
  },
};
