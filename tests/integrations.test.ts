import { beforeEach, describe, expect, it } from 'vitest';
import { mockAds } from '../src/integrations/ads/mock.ads.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ActivityModel } from '../src/modules/activities/activity.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { ExternalLeadReferenceModel } from '../src/modules/marketing/externalLeadReference.model.js';
import { MarketingCampaignModel } from '../src/modules/marketing/marketingCampaign.model.js';
import { MarketingDailyMetricModel } from '../src/modules/marketing/marketingDailyMetric.model.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const SECRETS = { accessToken: 'mock-token-SECRET-123', appSecret: 'app-secret-XYZ', verifyToken: 'verify-me' };

async function connected() {
  const { org, token } = await createOrgWithAdmin();
  const res = await api().post('/api/v1/integrations/mock/connect').set(bearer(token)).send({ secrets: SECRETS });
  expect(res.status).toBe(200);
  await drainJobs();
  const hook = (res.body.data.integration.webhookUrl as string).replace(/^https?:\/\/[^/]+/, '');
  return { org, token, hook };
}

const lead = (id: string, answers: Record<string, string>) =>
  mockAds.addLead({ externalLeadId: id, formExternalId: 'f-3001', formName: 'UK Enquiry Form', campaignExternalId: 'c-100', campaignName: 'UK Sep Intake', adsetExternalId: 's-110', adsetName: 'UK · Delhi 21-30', adExternalId: 'a-111', adName: 'UK Carousel', platform: 'instagram', submittedAt: new Date(), answers });

const deliver = (hook: string, ids: string[], signature = SECRETS.appSecret) =>
  api().post(hook).set('x-mock-signature', signature).send({ leads: ids.map((id) => ({ id, page: 'p-2001', form: 'f-3001' })) });

beforeEach(() => mockAds.reset());

describe('Integrations hub: connection', () => {
  it('validates credentials, discovers accounts and never returns secrets', async () => {
    const { org, token } = await connected();
    const status = await api().get('/api/v1/integrations/mock/status').set(bearer(token));
    expect(status.status).toBe(200);
    expect(status.body.data.integration).toMatchObject({ status: 'connected', connectedAccountName: 'Mock Business', secretsSet: expect.arrayContaining(['accessToken', 'appSecret', 'verifyToken']) });
    const accounts = await api().get('/api/v1/integrations/mock/accounts').set(bearer(token));
    expect(accounts.body.data.map((a: { type: string; selected: boolean }) => `${a.type}:${a.selected}`).sort()).toEqual(['ad_account:true', 'business:true', 'lead_form:true', 'page:true']);

    const overview = await api().get('/api/v1/integrations').set(bearer(token));
    for (const body of [status.body, accounts.body, overview.body]) {
      const text = JSON.stringify(body);
      for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    }
    expect(overview.body.data.cards.find((c: { provider: string }) => c.provider === 'mock')).toMatchObject({ connected: true, selected: { adAccounts: 1, pages: 1, leadForms: 1 } });
    expect(org).toBeTruthy();
  });

  it('rejects invalid credentials and flags missing permissions as reauthorization', async () => {
    const { token } = await createOrgWithAdmin();
    const bad = await api().post('/api/v1/integrations/mock/connect').set(bearer(token)).send({ secrets: { accessToken: 'expired' } });
    expect(bad.status).toBe(422);
    mockAds.missingScopes = ['leads_retrieval'];
    const partial = await api().post('/api/v1/integrations/mock/connect').set(bearer(token)).send({ secrets: SECRETS });
    expect(partial.status).toBe(200);
    expect(partial.body.data.integration).toMatchObject({ status: 'requires_reauthorization', missingScopes: ['leads_retrieval'] });
  });

  it('is limited to permitted roles and isolated per organization', async () => {
    const a = await connected();
    const counsellor = await createUserAs(a.token, a.org._id, 'counsellor');
    expect((await api().get('/api/v1/integrations').set(bearer(counsellor.token))).status).toBe(403);
    expect((await api().post('/api/v1/integrations/mock/connect').set(bearer(counsellor.token)).send({ secrets: SECRETS })).status).toBe(403);

    lead('L-iso', { full_name: 'Iso Lead', phone_number: '9811100001' });
    await deliver(a.hook, ['L-iso']);
    await drainJobs();
    const b = await createOrgWithAdmin('Other Org');
    const leadsB = await api().get('/api/v1/integrations/mock/leads').set(bearer(b.token));
    expect(leadsB.body.data).toEqual([]);
    expect((await api().get('/api/v1/integrations/sync-logs').set(bearer(b.token))).body.data).toEqual([]);
    expect((await api().get('/api/v1/integrations/mock/campaigns').set(bearer(b.token))).body.data).toEqual([]);
  });
});

describe('Integrations hub: lead import', () => {
  it('imports a webhook lead exactly once, even when delivered repeatedly and polled', async () => {
    const { org, token, hook } = await connected();
    lead('L-1', { full_name: 'Asha Rao', phone_number: '+91 98100 00001', email: 'asha@example.com', budget_question: '20-25L' });
    for (let i = 0; i < 3; i++) expect((await deliver(hook, ['L-1'])).status).toBe(200);
    await drainJobs();
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'leads' });
    await drainJobs();

    const leads = await LeadModel.find({ organizationId: org._id }).lean();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', leadSource: 'meta', platform: 'instagram', campaign: 'UK Sep Intake', adSet: 'UK · Delhi 21-30', ad: 'UK Carousel', leadForm: 'UK Enquiry Form' });
    expect(await ActivityModel.countDocuments({ organizationId: org._id, leadId: leads[0]!._id, type: 'lead_created' })).toBe(1);
    const refs = await ExternalLeadReferenceModel.find({ organizationId: org._id }).lean();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ status: 'created', campaignExternalId: 'c-100', adExternalId: 'a-111', formExternalId: 'f-3001' });
    // Unmapped answers are kept on the lead, never dropped.
    const created = await ActivityModel.findOne({ organizationId: org._id, leadId: leads[0]!._id, type: 'lead_created' }).lean();
    expect(created?.notes).toContain('budget_question: 20-25L');
  });

  it('rejects bad signatures and unknown tokens without storing anything', async () => {
    const { org, hook } = await connected();
    lead('L-sig', { full_name: 'X', phone_number: '9811100002' });
    expect((await deliver(hook, ['L-sig'], 'wrong')).status).toBe(401);
    expect((await deliver(hook.replace(/[^/]+$/, 'x'.repeat(40)), ['L-sig'])).status).toBe(404);
    await drainJobs();
    expect(await ExternalLeadReferenceModel.countDocuments({ organizationId: org._id })).toBe(0);
  });

  it('answers the subscription handshake only with the right verify token', async () => {
    const { hook } = await connected();
    const ok = await api().get(`${hook}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    expect((await api().get(`${hook}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status).toBe(403);
  });

  it('adds a repeat enquiry to the existing lead instead of creating a duplicate', async () => {
    const { org, token, hook } = await connected();
    await createLead(token, { firstName: 'Ravi', phone: '9811100003', leadSource: 'website' });
    lead('L-dup', { full_name: 'Ravi K', phone_number: '9811100003' });
    await deliver(hook, ['L-dup']);
    await drainJobs();
    const leads = await LeadModel.find({ organizationId: org._id }).lean();
    expect(leads).toHaveLength(1);
    expect(leads[0]!.leadSource).toBe('website'); // original source preserved
    expect(leads[0]!.sourceHistory.some((t) => t.campaign === 'UK Sep Intake')).toBe(true);
    expect((await ExternalLeadReferenceModel.findOne({ organizationId: org._id }).lean())?.status).toBe('merged');
  });

  it('keeps failed imports visible and imports them once on retry', async () => {
    const { org, token, hook } = await connected();
    lead('L-bad', { full_name: 'No Contact' });
    await deliver(hook, ['L-bad']);
    await drainJobs();
    const failed = await api().get('/api/v1/integrations/failed-jobs').set(bearer(token));
    expect(failed.body.data.leads).toHaveLength(1);
    expect(failed.body.data.leads[0].lastError).toMatch(/phone/i);

    lead('L-bad', { full_name: 'No Contact', phone_number: '9811100004' });
    const retry = await api().post(`/api/v1/integrations/failed-jobs/leads/${failed.body.data.leads[0]._id}/retry`).set(bearer(token));
    expect(retry.status).toBe(200);
    await drainJobs();
    await api().post('/api/v1/integrations/failed-jobs/leads/retry').set(bearer(token));
    await drainJobs();
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);
    expect((await ExternalLeadReferenceModel.findOne({ organizationId: org._id }).lean())?.status).toBe('created');
  });

  it('maps custom form questions to CRM fields', async () => {
    const { org, token, hook } = await connected();
    const save = await api().put('/api/v1/integrations/mock/field-mappings').set(bearer(token)).send({ formExternalId: 'f-3001', rules: [{ externalField: 'which_country?', crmField: 'countryInterested' }] });
    expect(save.status).toBe(200);
    lead('L-map', { full_name: 'Map Me', phone_number: '9811100005', 'which_country?': 'United Kingdom' });
    await deliver(hook, ['L-map']);
    await drainJobs();
    expect((await LeadModel.findOne({ organizationId: org._id }).lean())?.countryInterested).toBe('uk');
  });
});

describe('Integrations hub: campaigns and metrics', () => {
  it('syncs the hierarchy without duplicates and keeps renamed names', async () => {
    const { org, token } = await connected();
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'campaigns' });
    await drainJobs();
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'campaigns' });
    await drainJobs();
    expect(await MarketingCampaignModel.countDocuments({ organizationId: org._id })).toBe(6);
    await MarketingCampaignModel.updateOne({ organizationId: org._id, externalId: 'c-100' }, { name: 'Old name' });
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'campaigns' });
    await drainJobs();
    const c = await MarketingCampaignModel.findOne({ organizationId: org._id, externalId: 'c-100' }).lean();
    expect(c?.name).toBe('UK Sep Intake');
    expect(c?.nameHistory.map((h) => h.name)).toContain('UK Sep Intake');
  });

  it('replaces corrected daily metrics instead of adding them, and keeps unavailable apart from zero', async () => {
    const { org, token } = await connected();
    const day = { from: '2026-10-01', to: '2026-10-01' };
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'campaigns' });
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'metrics', ...day });
    await drainJobs();
    mockAds.spendOverride.set('c-100:2026-10-01', 1234.56);
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'metrics', ...day });
    await drainJobs();
    const rows = await MarketingDailyMetricModel.find({ organizationId: org._id, level: 'campaign', externalId: 'c-100', date: '2026-10-01' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ spendMinor: 123456, currency: 'INR', revision: 2 });
    const ad = await MarketingDailyMetricModel.findOne({ organizationId: org._id, level: 'ad', externalId: 'a-111' }).lean();
    expect(ad?.reach).toBeNull();
    expect(ad?.unavailable).toContain('reach');

    const tree = await api().get('/api/v1/integrations/mock/campaigns?from=2026-10-01&to=2026-10-01').set(bearer(token));
    const uk = tree.body.data.find((c: { externalId: string }) => c.externalId === 'c-100');
    expect(uk.metrics.spend).toBe(1234.56);
    expect(uk.adsets[0].ads[0]).toMatchObject({ externalId: 'a-111' });
    // No CRM leads in range: cost per lead is N/A, not infinity or zero.
    expect(uk.cpl).toBeNull();
  });
});
