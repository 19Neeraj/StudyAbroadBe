import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockAds } from '../src/integrations/ads/mock.ads.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ApplicationModel } from '../src/modules/applications/application.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { AttributionTouchpointModel } from '../src/modules/marketing/touchpoint.model.js';
import { MarketingDailyMetricModel } from '../src/modules/marketing/marketingDailyMetric.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const SECRETS = { accessToken: 'mock-token', appSecret: 'app-secret', verifyToken: 'verify' };

async function node(token: string, dimension: string, level: number, label: string, parentId?: string) {
  return api().post('/api/v1/marketing/attribution/nodes').set(bearer(token)).send({ dimension, level, label, parentId });
}

async function websiteKey(token: string) {
  const res = await api().post('/api/v1/integrations/website/keys').set(bearer(token)).send({ name: 'Main site' });
  expect(res.status).toBe(201);
  return res.body.data.key as string;
}

const submit = (key: string, body: Record<string, unknown>, idem?: string) => {
  const req = api().post('/api/v1/integrations/website/leads').set('X-Api-Key', key);
  if (idem) req.set('Idempotency-Key', idem);
  return req.send(body);
};

beforeEach(() => mockAds.reset());

describe('Attribution hierarchy', () => {
  it('enforces Primary → Secondary → Tertiary parent rules', async () => {
    const { token } = await createOrgWithAdmin();
    const paid = (await node(token, 'source', 1, 'Paid Advertising')).body.data;
    const organic = (await node(token, 'source', 1, 'Organic')).body.data;
    const meta = (await node(token, 'source', 2, 'Meta', paid._id)).body.data;
    expect((await node(token, 'source', 3, 'Lead Ads', meta._id)).status).toBe(201);
    expect((await node(token, 'source', 2, 'No parent')).status).toBe(422);
    expect((await node(token, 'source', 3, 'Wrong level', paid._id)).status).toBe(422);
    const medium = (await node(token, 'medium', 1, 'Paid')).body.data;
    expect((await node(token, 'source', 2, 'Cross-dimension', medium._id)).status).toBe(422);

    // A mapping can't pair a secondary with the wrong primary.
    const bad = await api().post('/api/v1/marketing/campaign-mappings').set(bearer(token)).send({ provider: 'meta', campaignExternalId: 'c-1', source: { l1: organic._id, l2: meta._id } });
    expect(bad.status).toBe(422);
    const ok = await api().post('/api/v1/marketing/campaign-mappings').set(bearer(token)).send({ provider: 'meta', campaignExternalId: 'c-1', source: { l1: paid._id, l2: meta._id } });
    expect(ok.status).toBe(201);
  });
});

describe('Touchpoints: UTM preservation, first and last touch', () => {
  it('stores raw UTMs exactly, normalizes separately and never invents values', async () => {
    const { org, token } = await createOrgWithAdmin();
    const res = await createLead(token, { firstName: 'Ira', phone: '9822200001', leadSource: 'google', utmSource: 'Google', utmCampaign: 'UK_Sept', utmMedium: 'CPC' });
    const tp = await AttributionTouchpointModel.findOne({ organizationId: org._id, leadId: res.body.data.lead._id }).lean();
    expect(tp?.raw).toEqual({ utm_source: 'Google', utm_medium: 'CPC', utm_campaign: 'UK_Sept' });
    expect(tp?.normalized).toEqual({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'uk_sept' });
    expect(tp?.raw).not.toHaveProperty('utm_term');
    expect(tp?.isDirect).toBe(false);
  });

  it('keeps first touch, moves last touch only for qualifying touches, and keeps click IDs', async () => {
    const { org, token } = await createOrgWithAdmin();
    const key = await websiteKey(token);
    const first = { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'uk-oct ', fbclid: 'IwAR-abc', landing_url: 'https://x.test/uk?utm_source=facebook', at: '2026-10-01T08:00:00Z' };
    const r1 = await submit(key, { lead: { firstName: 'Neha', phone: '9822200002' }, attribution: { first, last: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand', gclid: 'Cj0-xyz', at: '2026-10-05T09:00:00Z' } }, formId: 'contact' });
    expect(r1.status).toBe(201);
    const leadId = r1.body.data.leadId;
    let lead = await LeadModel.findOne({ organizationId: org._id, _id: leadId }).lean();
    const touches = await AttributionTouchpointModel.find({ organizationId: org._id, leadId }).sort({ occurredAt: 1 }).lean();
    expect(touches).toHaveLength(2);
    expect(touches[0]!.raw).toMatchObject({ fbclid: 'IwAR-abc', utm_campaign: 'uk-oct ' });
    expect(touches[0]!.normalized).toMatchObject({ utm_campaign: 'uk-oct' });
    expect(touches[1]!.raw).toMatchObject({ gclid: 'Cj0-xyz' });
    expect(lead?.firstTouchId?.toString()).toBe(touches[0]!._id.toString());
    expect(lead?.lastTouchId?.toString()).toBe(touches[1]!._id.toString());
    expect(lead).toMatchObject({ utmCampaign: 'uk-oct', utmSource: 'facebook' });

    // Later direct visit: recorded, but neither first nor last touch changes.
    const r2 = await submit(key, { lead: { firstName: 'Neha', phone: '9822200002' }, attribution: { last: { at: '2026-10-07T09:00:00Z' } } });
    expect(r2.body.data.status).toBe('merged');
    lead = await LeadModel.findOne({ organizationId: org._id, _id: leadId }).lean();
    expect(lead?.firstTouchId?.toString()).toBe(touches[0]!._id.toString());
    expect(lead?.lastTouchId?.toString()).toBe(touches[1]!._id.toString());

    // Later paid touch: last touch moves, first stays.
    await submit(key, { lead: { firstName: 'Neha', phone: '9822200002' }, attribution: { last: { utm_source: 'facebook', utm_campaign: 'retarget', at: '2026-10-08T09:00:00Z' } } });
    lead = await LeadModel.findOne({ organizationId: org._id, _id: leadId }).lean();
    expect(lead?.firstTouchId?.toString()).toBe(touches[0]!._id.toString());
    const last = await AttributionTouchpointModel.findOne({ organizationId: org._id, _id: lead?.lastTouchId }).lean();
    expect(last?.normalized).toMatchObject({ utm_campaign: 'retarget' });

    // An older touch arriving late is kept and flagged, not promoted.
    await submit(key, { lead: { firstName: 'Neha', phone: '9822200002' }, attribution: { first: { utm_source: 'tiktok', at: '2026-09-01T09:00:00Z' } } });
    lead = await LeadModel.findOne({ organizationId: org._id, _id: leadId }).lean();
    expect(lead?.firstTouchId?.toString()).toBe(touches[0]!._id.toString());
    expect(await AttributionTouchpointModel.countDocuments({ organizationId: org._id, leadId, flags: 'earlier_than_first_touch' })).toBe(1);

    const view = await api().get(`/api/v1/marketing/attribution/leads/${leadId}`).set(bearer(token));
    expect(view.status).toBe(200);
    expect(view.body.data.touchpoints).toHaveLength(5);
    expect(view.body.data.firstTouch.raw.fbclid).toBe('IwAR-abc');
  });

  it('website endpoint: rejects bad keys, honours idempotency and never returns the key again', async () => {
    const { org, token } = await createOrgWithAdmin();
    const key = await websiteKey(token);
    expect((await submit('crm_live_wrongwrongwrongwrong', { lead: { firstName: 'X', phone: '9822200003' } })).status).toBe(401);
    expect((await submit(key, { lead: { firstName: 'X' } })).status).toBe(422);
    const a = await submit(key, { lead: { firstName: 'Om', phone: '9822200004' } }, 'form-123');
    const b = await submit(key, { lead: { firstName: 'Om', phone: '9822200004' } }, 'form-123');
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.data).toMatchObject({ status: 'duplicate_submission', leadId: a.body.data.leadId });
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);
    const keys = await api().get('/api/v1/integrations/website/keys').set(bearer(token));
    expect(JSON.stringify(keys.body)).not.toContain(key);
    expect(keys.body.data[0]).not.toHaveProperty('keyHash');
    await api().delete(`/api/v1/integrations/website/keys/${keys.body.data[0]._id}`).set(bearer(token));
    expect((await submit(key, { lead: { firstName: 'Om', phone: '9822200005' } })).status).toBe(401);
  });

  it('merging keeps every touchpoint and the earliest first touch', async () => {
    const { org, token } = await createOrgWithAdmin();
    const older = (await createLead(token, { firstName: 'Old', phone: '9822200006', leadSource: 'website', utmCampaign: 'first-ever' })).body.data.lead;
    await AttributionTouchpointModel.updateMany({ organizationId: org._id, leadId: older._id }, { occurredAt: new Date('2026-01-01') });
    const newer = (await createLead(token, { firstName: 'New', email: 'new@example.com', leadSource: 'meta', utmCampaign: 'later' })).body.data.lead;
    const res = await api().post(`/api/v1/leads/${newer._id}/merge`).set(bearer(token)).send({ duplicateLeadId: older._id });
    expect(res.status).toBe(200);
    const kept = await LeadModel.findOne({ organizationId: org._id, _id: newer._id }).lean();
    expect(kept?.firstTouch?.utmCampaign).toBe('first-ever');
    expect(await AttributionTouchpointModel.countDocuments({ organizationId: org._id, leadId: newer._id })).toBe(2);
  });
});

describe('Campaign mapping by ID', () => {
  it('maps duplicate/renamed campaign names independently and keeps history until re-applied', async () => {
    const { org, token } = await createOrgWithAdmin();
    await api().post('/api/v1/integrations/mock/connect').set(bearer(token)).send({ secrets: SECRETS });
    await drainJobs();
    const p1 = (await node(token, 'campaign', 1, 'Intake 2027')).body.data;
    const p2 = (await node(token, 'campaign', 1, 'Intake 2028')).body.data;
    // Two different campaign IDs with the same external name map separately.
    await api().post('/api/v1/marketing/campaign-mappings').set(bearer(token)).send({ provider: 'mock', campaignExternalId: 'c-100', externalName: 'Same name', campaign: { l1: p1._id }, effectiveFrom: '2026-01-01' });
    await api().post('/api/v1/marketing/campaign-mappings').set(bearer(token)).send({ provider: 'mock', campaignExternalId: 'c-200', externalName: 'Same name', campaign: { l1: p2._id }, effectiveFrom: '2026-01-01' });

    const hook = (await api().get('/api/v1/integrations/mock/status').set(bearer(token))).body.data.integration.webhookUrl.replace(/^https?:\/\/[^/]+/, '');
    mockAds.addLead({ externalLeadId: 'M-1', formExternalId: 'f-3001', campaignExternalId: 'c-100', campaignName: 'Same name', submittedAt: new Date(), answers: { full_name: 'Map One', phone_number: '9822200007' } });
    mockAds.addLead({ externalLeadId: 'M-2', formExternalId: 'f-3001', campaignExternalId: 'c-200', campaignName: 'Same name', submittedAt: new Date(), answers: { full_name: 'Map Two', phone_number: '9822200008' } });
    await api().post(hook).set('x-mock-signature', SECRETS.appSecret).send({ leads: [{ id: 'M-1' }, { id: 'M-2' }] });
    await drainJobs();
    const one = await LeadModel.findOne({ organizationId: org._id, phone: '+919822200007' }).lean();
    const two = await LeadModel.findOne({ organizationId: org._id, phone: '+919822200008' }).lean();
    expect(one?.attribution?.campaign?.l1?.toString()).toBe(p1._id);
    expect(two?.attribution?.campaign?.l1?.toString()).toBe(p2._id);
    expect(one?.firstTouch).toMatchObject({ origin: 'meta_lead_ad', provider: 'mock', campaignExternalId: 'c-100' });

    // Changing c-100's mapping keeps the old snapshot until an explicit re-apply.
    await api().post('/api/v1/marketing/campaign-mappings').set(bearer(token)).send({ provider: 'mock', campaignExternalId: 'c-100', campaign: { l1: p2._id }, effectiveFrom: '2026-01-02' });
    expect((await LeadModel.findOne({ organizationId: org._id, _id: one!._id }).lean())?.attribution?.campaign?.l1?.toString()).toBe(p1._id);
    const list = await api().get('/api/v1/marketing/campaign-mappings?campaignExternalId=c-100').set(bearer(token));
    expect(list.body.data.map((m: { status: string }) => m.status).sort()).toEqual(['active', 'superseded']);
    const re = await api().post('/api/v1/marketing/campaign-mappings/reapply').set(bearer(token)).send({ from: '2026-01-01', to: new Date(Date.now() + 86_400_000).toISOString() });
    expect(re.body.data.touchpointsChanged).toBe(1);
    expect((await LeadModel.findOne({ organizationId: org._id, _id: one!._id }).lean())?.attribution?.campaign?.l1?.toString()).toBe(p2._id);
  });

  it('builds tracked URLs without breaking existing parameters', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api().get('/api/v1/marketing/utm/preview').set(bearer(token)).query({ url: 'https://site.test/apply?ref=fair&utm_source=old#form', template: '?utm_source={{site_source_name}}&utm_medium=paid%20social&utm_campaign={{campaign.name}}&utm_content={{bogus}}' });
    expect(res.status).toBe(200);
    expect(res.body.data.finalUrl).toBe('https://site.test/apply?ref=fair&utm_source={{site_source_name}}&utm_medium=paid%20social&utm_campaign={{campaign.name}}&utm_content={{bogus}}#form');
    expect(res.body.data.warnings.join(' ')).toMatch(/\{\{bogus\}\}/);
    expect(res.body.data.warnings.join(' ')).toMatch(/utm_source.*already exists/);
  });
});

describe('Marketing reports', () => {
  it('reconciles spend with synced metrics, attributes outcomes and keeps N/A apart from zero', async () => {
    const { org, token } = await createOrgWithAdmin();
    await api().post('/api/v1/integrations/mock/connect').set(bearer(token)).send({ secrets: SECRETS });
    await drainJobs();
    const today = new Date().toISOString().slice(0, 10);
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'campaigns' });
    await api().post('/api/v1/integrations/mock/sync').set(bearer(token)).send({ type: 'metrics', from: today, to: today });
    await drainJobs();
    const hook = (await api().get('/api/v1/integrations/mock/status').set(bearer(token))).body.data.integration.webhookUrl.replace(/^https?:\/\/[^/]+/, '');
    mockAds.addLead({ externalLeadId: 'R-1', formExternalId: 'f-3001', campaignExternalId: 'c-100', submittedAt: new Date(), answers: { full_name: 'Rev One', phone_number: '9822200009' } });
    mockAds.addLead({ externalLeadId: 'R-2', formExternalId: 'f-3001', campaignExternalId: 'c-100', submittedAt: new Date(), answers: { full_name: 'Rev Two', phone_number: '9822200010' } });
    await api().post(hook).set('x-mock-signature', SECRETS.appSecret).send({ leads: [{ id: 'R-1' }, { id: 'R-2' }] });
    await drainJobs();
    const lead = await LeadModel.findOne({ organizationId: org._id, phone: '+919822200009' }).lean();
    const studentId = new Types.ObjectId();
    await ApplicationModel.create({ organizationId: org._id, studentId, leadId: lead!._id, applicationNumber: 1, universityId: new Types.ObjectId(), status: 'submitted', offer: { status: 'accepted' }, enrolmentStatus: 'enrolled' });
    await PaymentModel.create({ organizationId: org._id, studentId, leadId: lead!._id, paymentNumber: 1, purpose: 'service_fee', amount: 50_000, currency: 'INR', paymentStatus: 'success' });
    await PaymentModel.create({ organizationId: org._id, studentId, leadId: lead!._id, paymentNumber: 2, purpose: 'service_fee', amount: 9_999, currency: 'INR', paymentStatus: 'refunded' });

    const metric = await MarketingDailyMetricModel.findOne({ organizationId: org._id, level: 'campaign', externalId: 'c-100', date: today }).lean();
    const res = await api().get('/api/v1/marketing/reports/campaigns').set(bearer(token)).query({ from: today, to: today, groupBy: 'campaign' });
    expect(res.status).toBe(200);
    const uk = res.body.data.items.find((i: { key: string }) => i.key === 'mock:c-100');
    expect(uk).toMatchObject({ label: 'UK Sep Intake', leads: 2, applications: 1, admissions: 1, enrolments: 1, revenue: 50_000 });
    expect(uk.spend).toBeCloseTo((metric!.spendMinor as number) / 100, 2);
    expect(uk.cpl).toBeCloseTo(uk.spend / 2, 2);
    expect(uk.roas).toBeCloseTo(50_000 / uk.spend, 4);
    const canada = res.body.data.items.find((i: { key: string }) => i.key === 'mock:c-200');
    expect(canada.leads).toBe(0);
    expect(canada.cpl).toBeNull(); // N/A, not infinity or zero

    // Spend can't be attributed to a country: unavailable, not zero.
    const byCountry = await api().get('/api/v1/marketing/reports/campaigns').set(bearer(token)).query({ from: today, to: today, groupBy: 'country' });
    expect(byCountry.body.data.spendSupported).toBe(false);
    expect(byCountry.body.data.items.every((i: { spend: unknown }) => i.spend === null)).toBe(true);

    // A different currency is listed separately, never summed.
    await MarketingDailyMetricModel.create({ organizationId: org._id, provider: 'mock', accountExternalId: 'act_usd', level: 'campaign', externalId: 'c-usd', date: today, currency: 'USD', spendMinor: 10_000 });
    const mixed = await api().get('/api/v1/marketing/reports/overview').set(bearer(token)).query({ from: today, to: today });
    expect(mixed.body.data.current.otherCurrencySpend).toEqual([{ currency: 'USD', spend: 100 }]);
    expect(mixed.body.data.current.paidLeads).toBe(2);

    const dq = await api().get('/api/v1/marketing/reports/data-quality').set(bearer(token)).query({ from: today, to: today });
    expect(dq.body.data.unmappedCampaigns.map((c: { campaignExternalId: string }) => c.campaignExternalId)).toEqual(expect.arrayContaining(['c-100', 'c-200']));
    expect(dq.body.data.spendWithoutLeads.map((c: { key: string }) => c.key)).toContain('mock:c-200');

    const funnel = await api().get('/api/v1/marketing/reports/funnel').set(bearer(token)).query({ from: today, to: today, provider: 'mock' });
    expect(funnel.body.data.steps[0]).toMatchObject({ key: 'leads', count: 2 });
  });

  it('exports in the background and only the requester can download', async () => {
    const { org, token } = await createOrgWithAdmin();
    const req = await api().post('/api/v1/marketing/reports/export').set(bearer(token)).send({ report: 'campaigns', format: 'csv', params: {} });
    expect(req.status).toBe(202);
    await drainJobs();
    const list = await api().get('/api/v1/marketing/reports/exports').set(bearer(token));
    expect(list.body.data[0]).toMatchObject({ status: 'done', report: 'campaigns', format: 'csv' });
    const dl = await api().get(`/api/v1/marketing/reports/exports/${req.body.data.id}/download`).set(bearer(token));
    expect(dl.status).toBe(200);
    expect(dl.body.data.url).toBeTruthy();
    const other = await createUserAs(token, org._id, 'marketing');
    expect((await api().get(`/api/v1/marketing/reports/exports/${req.body.data.id}/download`).set(bearer(other.token))).status).toBe(404);
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get('/api/v1/marketing/reports/overview').set(bearer(counsellor.token))).status).toBe(403);
  });
});
