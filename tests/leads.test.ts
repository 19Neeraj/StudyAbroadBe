import { describe, expect, it } from 'vitest';
import { ActivityModel } from '../src/modules/activities/activity.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { api, bearer, createBranch, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

describe('Leads: create, normalize, number', () => {
  it('normalizes contact details, numbers leads and records the source and timeline', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await createLead(token, {
      firstName: 'Aarav',
      lastName: 'Mehta',
      phone: '098765 43210',
      email: '  Aarav.Mehta@Example.COM ',
      leadSource: 'meta',
      campaign: 'UK Sept Intake',
      utmSource: 'facebook',
      countryInterested: 'uk',
      ieltsScore: 6.5,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.outcome).toBe('created');
    const lead = res.body.data.lead;
    expect(lead).toMatchObject({
      leadNumber: 1001,
      fullName: 'Aarav Mehta',
      phone: '+919876543210',
      email: 'aarav.mehta@example.com',
      leadStage: 'new_lead',
      leadStatus: 'active',
      leadSource: 'meta',
    });
    expect(lead.sourceHistory).toHaveLength(1);
    expect(lead.sourceHistory[0]).toMatchObject({ leadSource: 'meta', campaign: 'UK Sept Intake', utmSource: 'facebook' });
    expect(lead.nameTokens).toBeUndefined();

    const second = await createLead(token, { firstName: 'Zoya', email: 'zoya@example.com' });
    expect(second.body.data.lead.leadNumber).toBe(1002);

    const timeline = await api().get(`/api/v1/leads/${lead._id}/activities`).set(bearer(token));
    expect(timeline.body.data.map((a: { type: string }) => a.type)).toEqual(['lead_created']);
  });

  it('validates contact presence and lookup keys', async () => {
    const { token } = await createOrgWithAdmin();
    const noContact = await createLead(token, { firstName: 'Nobody' });
    expect(noContact.status).toBe(422);
    expect(noContact.body.errors[0].field).toBe('body.phone');

    const badLookup = await createLead(token, { phone: '9876500001', leadSource: 'carrier_pigeon', countryInterested: 'atlantis' });
    expect(badLookup.status).toBe(422);
    expect(badLookup.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['body.countryInterested', 'body.leadSource']);

    const badPhone = await createLead(token, { phone: '12' });
    expect(badPhone.status).toBe(422);
  });

  it('auto-assigns leads created by counsellors to themselves', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    const res = await createLead(counsellor.token, { phone: '9876500002' });
    expect(res.body.data.lead.assignedCounsellor._id).toBe(counsellor.id);

    // …and they may not assign leads to someone else.
    const other = await createUserAs(token, org._id, 'counsellor');
    const forbidden = await createLead(counsellor.token, { phone: '9876500003', assignedCounsellor: other.id });
    expect(forbidden.status).toBe(403);
  });
});

describe('Leads: duplicate detection', () => {
  it('detects duplicates across phone formats and email casing, and offers resolutions', async () => {
    const { org, token } = await createOrgWithAdmin();
    const original = await createLead(token, { firstName: 'Riya', phone: '+91 98765 11111', email: 'riya@example.com', leadSource: 'meta', campaign: 'Spring' });
    const originalId = original.body.data.lead._id;

    const dup = await createLead(token, { firstName: 'Riya S', phone: '09876511111', leadSource: 'google' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_LEAD');
    expect(dup.body.details.duplicates[0]).toMatchObject({
      _id: originalId,
      leadNumber: 1001,
      matchedOn: ['phone'],
      originalSource: 'meta',
      latestSource: 'meta',
      campaign: 'Spring',
    });

    const byEmail = await api().post('/api/v1/leads/check-duplicates').set(bearer(token)).send({ email: 'RIYA@example.com' });
    expect(byEmail.body.data[0].matchedOn).toEqual(['email']);

    // keep_existing: no new lead; enquiry recorded on the existing one, empty fields filled.
    const kept = await createLead(token, { firstName: 'Riya S', phone: '09876511111', leadSource: 'google', city: 'Pune', duplicateAction: 'keep_existing' });
    expect(kept.status).toBe(200);
    expect(kept.body.data).toMatchObject({ outcome: 'added_to_existing', leadId: originalId });
    expect(kept.body.data.lead.city).toBe('Pune');
    expect(kept.body.data.lead.sourceHistory.map((s: { leadSource: string }) => s.leadSource)).toEqual(['meta', 'google']);
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);
    expect(await ActivityModel.countDocuments({ organizationId: org._id, type: 'duplicate_enquiry' })).toBe(1);

    const again = await createLead(token, { firstName: 'Riya', email: 'riya@example.com' });
    expect(again.body.details.duplicates[0].latestSource).toBe('google');

    // mark_duplicate / create_separate need lead.merge.
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    const denied = await createLead(counsellor.token, { phone: '9876511111', duplicateAction: 'create_separate' });
    expect(denied.status).toBe(403);

    const marked = await createLead(token, { phone: '9876511111', duplicateAction: 'mark_duplicate' });
    expect(marked.status).toBe(201);
    expect(marked.body.data.lead).toMatchObject({ leadStatus: 'duplicate', duplicateOf: originalId });
  });

  it('blocks editing a lead into a duplicate unless allowed', async () => {
    const { token } = await createOrgWithAdmin();
    await createLead(token, { phone: '9876522222' });
    const b = await createLead(token, { phone: '9876533333' });
    const id = b.body.data.lead._id;
    const conflict = await api().patch(`/api/v1/leads/${id}`).set(bearer(token)).send({ phone: '98765 22222' });
    expect(conflict.status).toBe(409);
    const allowed = await api().patch(`/api/v1/leads/${id}`).set(bearer(token)).send({ phone: '98765 22222', allowDuplicate: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.phone).toBe('+919876522222');
  });

  it('merges a duplicate into the kept lead without losing data', async () => {
    const { org, token } = await createOrgWithAdmin();
    const keep = (await createLead(token, { firstName: 'Kabir', phone: '9876544444', leadSource: 'website' })).body.data.lead;
    const dupe = (await createLead(token, { firstName: 'Kabir', email: 'kabir@example.com', city: 'Delhi', leadSource: 'event', duplicateAction: 'create_separate' })).body.data.lead;
    await api().post(`/api/v1/leads/${dupe._id}/activities`).set(bearer(token)).send({ type: 'call', notes: 'Asked about Canada' });
    await api().post(`/api/v1/leads/${dupe._id}/followups`).set(bearer(token)).send({ dueAt: new Date(Date.now() + 86_400_000).toISOString(), followUpType: 'call' });

    const merged = await api().post(`/api/v1/leads/${keep._id}/merge`).set(bearer(token)).send({ duplicateLeadId: dupe._id });
    expect(merged.status).toBe(200);
    expect(merged.body.data).toMatchObject({ email: 'kabir@example.com', city: 'Delhi', phone: '+919876544444' });
    expect(merged.body.data.sourceHistory.map((s: { leadSource: string }) => s.leadSource)).toEqual(['website', 'event']);
    expect(merged.body.data.nextFollowUpAt).toBeTruthy();

    const timeline = await api().get(`/api/v1/leads/${keep._id}/activities`).set(bearer(token));
    const types = timeline.body.data.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(['lead_merged', 'call', 'followup_created']));

    const source = await LeadModel.findOne({ organizationId: org._id, _id: dupe._id }).lean();
    expect(source).toMatchObject({ leadStatus: 'duplicate' });
    expect(source?.mergedInto?.toString()).toBe(keep._id);

    const again = await api().post(`/api/v1/leads/${keep._id}/merge`).set(bearer(token)).send({ duplicateLeadId: dupe._id });
    expect(again.status).toBe(409);
  });
});

describe('Leads: search, filters and scope', () => {
  it('searches by number, phone, email and name prefix', async () => {
    const { token } = await createOrgWithAdmin();
    await createLead(token, { firstName: 'Ananya', lastName: 'Iyer', phone: '9123456780', email: 'ananya.iyer@mail.com' });
    await createLead(token, { firstName: 'Arjun', lastName: 'Nair', phone: '9988776655', email: 'arjun@mail.com' });
    const search = async (q: string) =>
      (await api().get(`/api/v1/leads?search=${encodeURIComponent(q)}`).set(bearer(token))).body.data.map((l: { firstName: string }) => l.firstName);

    expect(await search('#1002')).toEqual(['Arjun']);
    expect(await search('91234 56780')).toEqual(['Ananya']);
    expect(await search('99887')).toEqual(['Arjun']);
    expect(await search('ANANYA.I')).toEqual(['Ananya']);
    expect(await search('ana iy')).toEqual(['Ananya']);
    expect((await search('a')).sort()).toEqual(['Ananya', 'Arjun']);
    expect(await search('zzz')).toEqual([]);
  });

  it('filters by stage, source and assignment, and sorts', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    await createLead(token, { firstName: 'A', phone: '9000000001', leadSource: 'meta', assignedCounsellor: counsellor.id });
    const b = await createLead(token, { firstName: 'B', phone: '9000000002', leadSource: 'google' });
    await api().patch(`/api/v1/leads/${b.body.data.lead._id}/stage`).set(bearer(token)).send({ stage: 'contacted' }).expect(200);

    const q = async (qs: string) => (await api().get(`/api/v1/leads?${qs}`).set(bearer(token))).body.data.map((l: { firstName: string }) => l.firstName);
    expect(await q('stage=contacted')).toEqual(['B']);
    expect(await q('source=meta,google&sortBy=fullName&sortOrder=asc')).toEqual(['A', 'B']);
    expect(await q(`assignedUser=${counsellor.id}`)).toEqual(['A']);
    expect(await q('assignedUser=unassigned')).toEqual(['B']);
  });

  it('limits counsellors to their leads and managers to their branches', async () => {
    const { org, token } = await createOrgWithAdmin();
    const delhi = await createBranch(token, 'Delhi', 'DEL');
    const mumbai = await createBranch(token, 'Mumbai', 'BOM');
    const manager = await createUserAs(token, org._id, 'manager', { branchIds: [delhi] });
    const c1 = await createUserAs(token, org._id, 'counsellor', { branchIds: [delhi] });
    const c2 = await createUserAs(token, org._id, 'counsellor', { branchIds: [mumbai] });

    const delhiLead = (await createLead(token, { firstName: 'Delhi', phone: '9000000011', branchId: delhi, assignedCounsellor: c1.id })).body.data.lead;
    const mumbaiLead = (await createLead(token, { firstName: 'Mumbai', phone: '9000000012', branchId: mumbai, assignedCounsellor: c2.id })).body.data.lead;

    const names = async (t: string) => (await api().get('/api/v1/leads').set(bearer(t))).body.data.map((l: { firstName: string }) => l.firstName);
    expect(await names(c1.token)).toEqual(['Delhi']);
    expect(await names(manager.token)).toEqual(['Delhi']);
    expect((await names(token)).sort()).toEqual(['Delhi', 'Mumbai']);

    expect((await api().get(`/api/v1/leads/${mumbaiLead._id}`).set(bearer(c1.token))).status).toBe(404);
    expect((await api().get(`/api/v1/leads/${mumbaiLead._id}`).set(bearer(manager.token))).status).toBe(404);
    expect((await api().patch(`/api/v1/leads/${mumbaiLead._id}/stage`).set(bearer(manager.token)).send({ stage: 'contacted' })).status).toBe(404);

    // Managers can only assign to people in their branches.
    const outOfBranch = await api().post(`/api/v1/leads/${delhiLead._id}/assign`).set(bearer(manager.token)).send({ counsellorId: c2.id });
    expect(outOfBranch.status).toBe(422);

    // Another organization never sees them.
    const other = await createOrgWithAdmin('Other');
    expect((await api().get(`/api/v1/leads/${delhiLead._id}`).set(bearer(other.token))).status).toBe(404);
    expect(await names(other.token)).toEqual([]);
  });
});

describe('Leads: assignment, stages and deletion', () => {
  it('reassigns with timeline history and moves open follow-ups', async () => {
    const { org, token } = await createOrgWithAdmin();
    const c1 = await createUserAs(token, org._id, 'counsellor');
    const c2 = await createUserAs(token, org._id, 'counsellor');
    const lead = (await createLead(token, { phone: '9000000021', assignedCounsellor: c1.id })).body.data.lead;
    await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(c1.token)).send({ dueAt: new Date(Date.now() + 3_600_000).toISOString(), followUpType: 'call' }).expect(201);

    const res = await api().post(`/api/v1/leads/${lead._id}/assign`).set(bearer(token)).send({ counsellorId: c2.id, note: 'Moving to Canada desk' });
    expect(res.status).toBe(200);
    expect(res.body.data.assignedCounsellor._id).toBe(c2.id);

    const timeline = await api().get(`/api/v1/leads/${lead._id}/activities?types=lead_reassigned`).set(bearer(token));
    expect(timeline.body.data[0]).toMatchObject({ previousValue: { id: c1.id }, newValue: { id: c2.id }, notes: 'Moving to Canada desk' });

    const c2Followups = await api().get('/api/v1/followups?view=all').set(bearer(c2.token));
    expect(c2Followups.body.data).toHaveLength(1);
    expect((await api().get(`/api/v1/leads/${lead._id}`).set(bearer(c1.token))).status).toBe(404);
  });

  it('bulk assigns and bulk moves stage, skipping leads outside scope', async () => {
    const { org, token } = await createOrgWithAdmin();
    const c1 = await createUserAs(token, org._id, 'counsellor');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await createLead(token, { phone: `90000001${i}0` })).body.data.lead._id);
    const foreign = (await createLead((await createOrgWithAdmin('X')).token, { phone: '9000000999' })).body.data.lead._id;

    const assigned = await api().post('/api/v1/leads/bulk-assign').set(bearer(token)).send({ leadIds: [...ids, foreign], counsellorId: c1.id });
    expect(assigned.body.data).toEqual({ updated: 3, unchanged: 0, skipped: 1 });
    const repeat = await api().post('/api/v1/leads/bulk-assign').set(bearer(token)).send({ leadIds: ids, counsellorId: c1.id });
    expect(repeat.body.data).toEqual({ updated: 0, unchanged: 3, skipped: 0 });

    const staged = await api().post('/api/v1/leads/bulk-stage').set(bearer(token)).send({ leadIds: ids, stage: 'meeting_pending' });
    expect(staged.body.data.updated).toBe(3);
    expect((await api().post('/api/v1/leads/bulk-stage').set(bearer(token)).send({ leadIds: ids, stage: 'nope' })).status).toBe(422);
    expect((await api().post('/api/v1/leads/bulk-assign').set(bearer(c1.token)).send({ leadIds: ids, counsellorId: c1.id })).status).toBe(403);
  });

  it('records stage and status changes and builds the pipeline', async () => {
    const { token } = await createOrgWithAdmin();
    const lead = (await createLead(token, { phone: '9000000031' })).body.data.lead;
    await createLead(token, { phone: '9000000032' });

    const staged = await api().patch(`/api/v1/leads/${lead._id}/stage`).set(bearer(token)).send({ stage: 'meeting_done', note: 'Met at office' });
    expect(staged.body.data.leadStage).toBe('meeting_done');
    const timeline = await api().get(`/api/v1/leads/${lead._id}/activities?types=stage_changed`).set(bearer(token));
    expect(timeline.body.data[0]).toMatchObject({ previousValue: 'new_lead', newValue: 'meeting_done', notes: 'Met at office' });

    const pipeline = await api().get('/api/v1/leads/pipeline').set(bearer(token));
    const counts = Object.fromEntries(pipeline.body.data.map((s: { stage: string; count: number }) => [s.stage, s.count]));
    expect(counts).toMatchObject({ new_lead: 1, meeting_done: 1, contacted: 0 });

    await api().patch(`/api/v1/leads/${lead._id}/status`).set(bearer(token)).send({ status: 'lost' }).expect(200);
    const after = await api().get('/api/v1/leads/pipeline').set(bearer(token));
    expect(after.body.data.find((s: { stage: string }) => s.stage === 'meeting_done').count).toBe(0);
    expect((await api().get('/api/v1/leads?includeClosed=false').set(bearer(token))).body.data).toHaveLength(1);
  });

  it('soft-deletes leads and cancels their open follow-ups', async () => {
    const { org, token } = await createOrgWithAdmin();
    const lead = (await createLead(token, { phone: '9000000041' })).body.data.lead;
    await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(token)).send({ dueAt: new Date(Date.now() + 3_600_000).toISOString(), followUpType: 'call' });
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    expect((await api().delete(`/api/v1/leads/${lead._id}`).set(bearer(counsellor.token))).status).toBe(403);

    expect((await api().delete(`/api/v1/leads/${lead._id}`).set(bearer(token))).status).toBe(200);
    expect((await api().get(`/api/v1/leads/${lead._id}`).set(bearer(token))).status).toBe(404);
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);
    const fu = await api().get('/api/v1/followups?view=all').set(bearer(token));
    expect(fu.body.data[0].status).toBe('cancelled');
    // A deleted lead no longer counts as a duplicate.
    expect((await createLead(token, { phone: '9000000041' })).status).toBe(201);
  });

  it('logs manual communication and filters the timeline', async () => {
    const { token } = await createOrgWithAdmin();
    const lead = (await createLead(token, { phone: '9000000051' })).body.data.lead;
    await api().post(`/api/v1/leads/${lead._id}/activities`).set(bearer(token)).send({ type: 'whatsapp', notes: 'Sent course list', outcome: 'Read' }).expect(201);
    await api().post(`/api/v1/leads/${lead._id}/activities`).set(bearer(token)).send({ type: 'note', notes: 'Prefers Manchester' }).expect(201);
    const bad = await api().post(`/api/v1/leads/${lead._id}/activities`).set(bearer(token)).send({ type: 'stage_changed', notes: 'x' });
    expect(bad.status).toBe(422);

    const comms = await api().get(`/api/v1/leads/${lead._id}/activities?types=call,whatsapp,email,meeting`).set(bearer(token));
    expect(comms.body.data).toHaveLength(1);
    expect(comms.body.data[0]).toMatchObject({ type: 'whatsapp', outcome: 'Read', user: { fullName: 'Org Admin' } });
  });
});
