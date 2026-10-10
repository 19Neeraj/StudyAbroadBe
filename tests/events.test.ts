import { describe, expect, it } from 'vitest';
import { ActivityModel } from '../src/modules/activities/activity.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { AttributionTouchpointModel } from '../src/modules/marketing/touchpoint.model.js';
import { api, bearer, createBranch, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function event(token: string, extra: Record<string, unknown> = {}) {
  const res = await api().post('/api/v1/events').set(bearer(token)).send({ name: 'Delhi Education Fair', eventType: 'education_fair', startAt: soon(24), endAt: soon(30), status: 'published', venue: { name: 'Hotel', city: 'New Delhi' }, cost: { amount: 100_000, currency: 'INR' }, ...extra });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('Events', () => {
  it('registers new and existing people through the lead duplicate rules', async () => {
    const { org, token } = await createOrgWithAdmin();
    const e = await event(token);
    const fresh = await api().post(`/api/v1/events/${e._id}/registrations`).set(bearer(token)).send({ contact: { firstName: 'Kiran', phone: '9833300001' } });
    expect(fresh.status).toBe(201);
    const lead = await LeadModel.findOne({ organizationId: org._id, phone: '+919833300001' }).lean();
    expect(lead).toMatchObject({ leadSource: 'event', campaign: 'Delhi Education Fair' });
    expect(await AttributionTouchpointModel.countDocuments({ organizationId: org._id, leadId: lead!._id, origin: 'event' })).toBe(1);

    // Same person again: no second lead, no second registration.
    const again = await api().post(`/api/v1/events/${e._id}/registrations`).set(bearer(token)).send({ contact: { firstName: 'Kiran', phone: '9833300001' } });
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyRegistered).toBe(true);
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);

    // An existing lead from another source keeps its original source.
    const existing = (await createLead(token, { firstName: 'Old', phone: '9833300002', leadSource: 'website' })).body.data.lead;
    await api().post(`/api/v1/events/${e._id}/registrations`).set(bearer(token)).send({ contact: { firstName: 'Old', phone: '9833300002' } });
    expect((await LeadModel.findOne({ organizationId: org._id, _id: existing._id }).lean())?.leadSource).toBe('website');

    const detail = await api().get(`/api/v1/events/${e._id}`).set(bearer(token));
    expect(detail.body.data.counts).toMatchObject({ registered: 2, newLeads: 1, existingLeads: 1 });
    expect(detail.body.data.results).toMatchObject({ cost: 100_000, costPerRegistration: 50_000, costPerNewLead: 100_000, applications: 0 });
    expect(detail.body.data.results.costPerApplication).toBeNull();
  });

  it('checks people in, logs attendance and counts it as contact', async () => {
    const { org, token } = await createOrgWithAdmin();
    const e = await event(token);
    const r = await api().post(`/api/v1/events/${e._id}/registrations`).set(bearer(token)).send({ contact: { firstName: 'Mira', email: 'mira@example.com' } });
    const regId = r.body.data.registration._id;
    const list = await api().get(`/api/v1/events/${e._id}/registrations?search=mira`).set(bearer(token));
    expect(list.body.data).toHaveLength(1);
    const ci = await api().patch(`/api/v1/events/${e._id}/registrations/${regId}`).set(bearer(token)).send({ status: 'attended' });
    expect(ci.status).toBe(200);
    expect(ci.body.data.checkedInAt).toBeTruthy();
    const lead = await LeadModel.findOne({ organizationId: org._id, email: 'mira@example.com' }).lean();
    expect(lead?.firstContactAt).toBeTruthy();
    expect(await ActivityModel.countDocuments({ organizationId: org._id, leadId: lead!._id, type: 'event_attended' })).toBe(1);

    const walkIn = await api().post(`/api/v1/events/${e._id}/registrations`).set(bearer(token)).send({ contact: { firstName: 'Walk', phone: '9833300003' }, walkIn: true });
    expect(walkIn.body.data.registration.status).toBe('attended');
    const detail = await api().get(`/api/v1/events/${e._id}`).set(bearer(token));
    expect(detail.body.data.counts).toMatchObject({ registered: 2, attended: 2 });
    expect(detail.body.data.results.attendanceRate).toBe(100);
  });

  it('public page: only when open, respects capacity, honeypot and never needs sign-in', async () => {
    const { org, token } = await createOrgWithAdmin();
    const e = await event(token, { capacity: 1 });
    const opened = await api().post(`/api/v1/events/${e._id}/public-registration`).set(bearer(token)).send({ open: true });
    const slug = opened.body.data.publicSlug;
    expect(slug).toBeTruthy();
    const page = await api().get(`/api/v1/events/public/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({ name: 'Delhi Education Fair', open: true });
    expect(page.body.data).not.toHaveProperty('cost');
    expect((await api().post(`/api/v1/events/public/${slug}/register`).send({ contact: { firstName: 'Bot', phone: '9833300009' }, website: 'spam' })).status).toBe(422);
    const ok = await api().post(`/api/v1/events/public/${slug}/register`).send({ contact: { firstName: 'Ana', phone: '9833300004' }, tracking: { utm_source: 'instagram', utm_campaign: 'fair-oct' }, consent: { ads: true } });
    expect(ok.status).toBe(201);
    const tp = await AttributionTouchpointModel.findOne({ organizationId: org._id, origin: 'event' }).lean();
    expect(tp?.raw).toMatchObject({ utm_source: 'instagram', utm_campaign: 'fair-oct' });
    expect((await api().post(`/api/v1/events/public/${slug}/register`).send({ contact: { firstName: 'Ben', phone: '9833300005' } })).status).toBe(409);
    expect((await api().get(`/api/v1/events/public/${slug}`)).body.data).toMatchObject({ open: false, full: true });
    await api().post(`/api/v1/events/${e._id}/public-registration`).set(bearer(token)).send({ open: false });
    expect((await api().post(`/api/v1/events/public/${slug}/register`).send({ contact: { firstName: 'Cy', phone: '9833300006' } })).status).toBe(404);
  });

  it('is branch-scoped and permission-checked', async () => {
    const { org, token } = await createOrgWithAdmin();
    const b1 = await createBranch(token, 'North', 'NOR');
    const b2 = await createBranch(token, 'South', 'SOU');
    await event(token, { name: 'North fair', branchId: b1 });
    await event(token, { name: 'South fair', branchId: b2 });
    await event(token, { name: 'Webinar for all', eventType: 'webinar', mode: 'online', onlineUrl: 'https://meet.example.com/x' });
    const manager = await createUserAs(token, org._id, 'manager', { branchIds: [b1] });
    const names = (await api().get('/api/v1/events').set(bearer(manager.token))).body.data.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(['North fair', 'Webinar for all']);
    const counsellor = await createUserAs(token, org._id, 'counsellor', { branchIds: [b1] });
    const ev = (await api().get('/api/v1/events').set(bearer(counsellor.token))).body.data[0];
    expect((await api().patch(`/api/v1/events/${ev._id}`).set(bearer(counsellor.token)).send({ name: 'x' })).status).toBe(403);
    const other = await createOrgWithAdmin('Other');
    expect((await api().get(`/api/v1/events/${ev._id}`).set(bearer(other.token))).status).toBe(404);
  });
});
