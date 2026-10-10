import { describe, expect, it } from 'vitest';
import { drainJobs } from '../src/jobs/queue.js';
import { storage } from '../src/integrations/storage/index.js';
import { LeadInquiryModel } from '../src/modules/leads/inquiry.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { OrganizationModel } from '../src/modules/organizations/organization.model.js';
import { invalidateOrgSettings } from '../src/modules/organizations/orgSettings.js';
import { ReportExportModel } from '../src/modules/reports/reportExport.model.js';
import { FollowUpModel } from '../src/modules/followups/followup.model.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs, roleId } from './helpers.js';

async function node(token: string, dimension: string, level: number, label: string, parentId?: string) {
  const res = await api().post('/api/v1/marketing/attribution/nodes').set(bearer(token)).send({ dimension, level, label, parentId });
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}

async function hierarchy(token: string) {
  const digital = await node(token, 'source', 1, 'Digital Marketing');
  const meta = await node(token, 'source', 2, 'Meta', digital);
  const leadAds = await node(token, 'source', 3, 'Meta Lead Ads Form', meta);
  const organic = await node(token, 'source', 1, 'Organic Search');
  const paid = await node(token, 'medium', 1, 'Paid');
  const social = await node(token, 'medium', 2, 'Social', paid);
  const leadGen = await node(token, 'medium', 3, 'Lead Generation', social);
  const study = await node(token, 'campaign', 1, 'Study Abroad');
  const sept = await node(token, 'campaign', 2, 'September Intake', study);
  const ukMasters = await node(token, 'campaign', 3, 'UK Masters Leads', sept);
  return { digital, meta, leadAds, organic, paid, social, leadGen, study, sept, ukMasters };
}

describe('Re-inquiries: one lead per phone per organization', () => {
  it('reuses the lead ID, records each inquiry once and leaves stage, owner and tasks alone', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    const first = await createLead(token, { firstName: 'Asha', phone: '+91 99000 11111', leadSource: 'website', assignedCounsellor: counsellor.id });
    expect(first.status).toBe(201);
    const leadId = first.body.data.leadId;
    await api().patch(`/api/v1/leads/${leadId}/stage`).set(bearer(token)).send({ stage: 'contacted' });
    await api().post(`/api/v1/leads/${leadId}/followups`).set(bearer(token)).send({ dueAt: new Date(Date.now() + 86_400_000).toISOString(), followUpType: 'call' });

    const second = await createLead(token, { firstName: 'Asha K', phone: '9900011111', leadSource: 'meta', campaign: 'UK' });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ outcome: 'added_to_existing', leadId, reinquiry: true, inquiryCount: 2 });

    const lead = await LeadModel.findOne({ organizationId: org._id, _id: leadId }).lean();
    expect(lead).toMatchObject({ leadStage: 'contacted', firstName: 'Asha', leadSource: 'website', inquiryCount: 2, normalizedPhone: '+919900011111' });
    expect(lead!.assignedCounsellor!.toString()).toBe(counsellor.id);
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);
    expect(await FollowUpModel.countDocuments({ organizationId: org._id, leadId, status: 'pending' })).toBe(1);

    const history = await api().get(`/api/v1/leads/${leadId}/inquiries`).set(bearer(token));
    expect(history.status).toBe(200);
    expect(history.body.data.summary).toMatchObject({ totalInquiries: 2, reinquiryCount: 1 });
    expect(history.body.data.items.map((i: { sequence: number; isReinquiry: boolean; leadSource: string }) => [i.sequence, i.isReinquiry, i.leadSource])).toEqual([
      [2, true, 'meta'],
      [1, false, 'website'],
    ]);
    expect(history.body.data.items[0].assignment).toMatchObject({ policy: 'keep_owner', action: 'kept' });
    expect(history.body.data.items[0].previousOwner.counsellor._id).toBe(counsellor.id);
  });

  it('keeps organizations independent', async () => {
    const a = await createOrgWithAdmin('Org A');
    const b = await createOrgWithAdmin('Org B');
    const inA = await createLead(a.token, { phone: '9900022222' });
    const inB = await createLead(b.token, { phone: '9900022222' });
    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);
    expect(inA.body.data.leadId).not.toBe(inB.body.data.leadId);
    // Org B can't read Org A's inquiry history.
    expect((await api().get(`/api/v1/leads/${inA.body.data.leadId}/inquiries`).set(bearer(b.token))).status).toBe(404);
  });

  it('never creates two leads under concurrent submissions of the same phone', async () => {
    const { org, token } = await createOrgWithAdmin();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => createLead(token, { firstName: `P${i}`, phone: '9900033333', leadSource: 'website' })));
    expect(results.map((r) => (r.status === 200 || r.status === 201 ? 'ok' : JSON.stringify(r.body)))).toEqual(Array(6).fill('ok'));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.data.leadId)).size).toBe(1);
    expect(await LeadModel.countDocuments({ organizationId: org._id })).toBe(1);
    expect(await LeadInquiryModel.countDocuments({ organizationId: org._id })).toBe(6);
    expect((await LeadModel.findOne({ organizationId: org._id }).lean())!.inquiryCount).toBe(6);
  });

  it('treats retried deliveries (same Idempotency-Key) as one inquiry', async () => {
    const { org, token } = await createOrgWithAdmin();
    await createLead(token, { phone: '9900044444' });
    const send = () => api().post('/api/v1/leads').set(bearer(token)).set('Idempotency-Key', 'meta-event-000123').send({ firstName: 'X', phone: '9900044444', leadSource: 'meta' });
    const one = await send();
    const two = await send();
    const three = await send();
    expect(one.body.data).toMatchObject({ outcome: 'added_to_existing', inquiryCount: 2 });
    expect(two.body.data.outcome).toBe('duplicate_event');
    expect(three.body.data.outcome).toBe('duplicate_event');
    expect((await LeadModel.findOne({ organizationId: org._id }).lean())!.inquiryCount).toBe(2);
    expect(await LeadInquiryModel.countDocuments({ organizationId: org._id })).toBe(2);
  });

  it('applies the review-queue and reassign-if-unavailable policies without resetting the stage', async () => {
    const { org, token } = await createOrgWithAdmin();
    const c1 = await createUserAs(token, org._id, 'counsellor');
    const c2 = await createUserAs(token, org._id, 'counsellor');
    const lead = await createLead(token, { phone: '9900055555', assignedCounsellor: c1.id });
    const leadId = lead.body.data.leadId;

    await OrganizationModel.updateOne({ _id: org._id }, { 'settings.reinquiryPolicy': 'review_queue' });
    invalidateOrgSettings(org._id);
    await createLead(token, { phone: '9900055555', leadSource: 'meta' });
    const queued = await api().get('/api/v1/leads?inquiryStatus=pending_review').set(bearer(token));
    expect(queued.body.data.map((l: { _id: string }) => l._id)).toEqual([leadId]);
    const inq = await LeadInquiryModel.findOne({ organizationId: org._id, isReinquiry: true }).lean();
    expect((await api().post(`/api/v1/leads/${leadId}/inquiries/${inq!._id}/handled`).set(bearer(token))).status).toBe(200);
    expect((await api().get('/api/v1/leads?inquiryStatus=pending_review').set(bearer(token))).body.data).toHaveLength(0);

    // Owner deactivated → the incoming default assignee takes over (only under this policy).
    await OrganizationModel.updateOne({ _id: org._id }, { 'settings.reinquiryPolicy': 'reassign_if_unavailable' });
    invalidateOrgSettings(org._id);
    await api().patch(`/api/v1/users/${c1.id}/status`).set(bearer(token)).send({ isActive: false });
    const again = await createLead(token, { phone: '9900055555', assignedCounsellor: c2.id, leadSource: 'website' });
    expect(again.body.data.reinquiry).toBe(true);
    const after = await LeadModel.findOne({ organizationId: org._id, _id: leadId }).lean();
    expect(after!.assignedCounsellor!.toString()).toBe(c2.id);
    expect(after!.leadStage).toBe('new_lead');
  });

  it('frees the phone when a lead is deleted or merged', async () => {
    const { token } = await createOrgWithAdmin();
    const a = await createLead(token, { phone: '9900066666' });
    expect((await api().delete(`/api/v1/leads/${a.body.data.leadId}`).set(bearer(token))).status).toBe(200);
    const b = await createLead(token, { phone: '9900066666' });
    expect(b.status).toBe(201);
    expect(b.body.data.leadId).not.toBe(a.body.data.leadId);

    // Merge: the kept lead without a phone takes the duplicate's number.
    const keep = await createLead(token, { firstName: 'Keep', email: 'keep@example.com' });
    const merged = await api().post(`/api/v1/leads/${keep.body.data.leadId}/merge`).set(bearer(token)).send({ duplicateLeadId: b.body.data.leadId });
    expect(merged.status).toBe(200);
    expect(merged.body.data).toMatchObject({ phone: '+919900066666', inquiryCount: 2 });
    const next = await createLead(token, { phone: '9900066666' });
    expect(next.body.data).toMatchObject({ outcome: 'added_to_existing', leadId: keep.body.data.leadId, inquiryCount: 3 });
  });
});

describe('Hierarchical attribution and filters', () => {
  it('validates parent/child paths and filters by original, latest and any-inquiry attribution', async () => {
    const { token } = await createOrgWithAdmin();
    const h = await hierarchy(token);

    // Invalid combinations are rejected.
    const bad = await createLead(token, { phone: '9900077770', attribution: { source: { l1: h.organic, l2: h.meta } } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('body.attribution.source.l2');
    const wrongDim = await createLead(token, { phone: '9900077770', attribution: { medium: { l1: h.digital } } });
    expect(wrongDim.status).toBe(422);
    const gap = await createLead(token, { phone: '9900077770', attribution: { campaign: { l1: h.study, l3: h.ukMasters } } });
    expect(gap.status).toBe(422);

    // Lead 1: organic originally, then a Meta re-inquiry. Lead 2: Meta from the start.
    const l1 = await createLead(token, { firstName: 'Org', phone: '9900077771', leadSource: 'website', utmSource: 'Google', attribution: { source: { l1: h.organic } } });
    await createLead(token, {
      firstName: 'Org',
      phone: '9900077771',
      leadSource: 'meta',
      utmSource: 'facebook',
      attribution: { source: { l1: h.digital, l2: h.meta, l3: h.leadAds }, medium: { l1: h.paid, l2: h.social }, campaign: { l1: h.study, l2: h.sept, l3: h.ukMasters } },
    });
    const l2 = await createLead(token, { firstName: 'Meta', phone: '9900077772', leadSource: 'meta', attribution: { source: { l1: h.digital, l2: h.meta }, campaign: { l1: h.study } } });
    const ids = (res: { body: { data: { _id: string }[] } }) => res.body.data.map((l) => l._id).sort();
    const get = (qs: string) => api().get(`/api/v1/leads?${qs}`).set(bearer(token));

    expect(ids(await get(`sourcePrimary=${h.digital}`))).toEqual([l2.body.data.leadId]);
    expect(ids(await get(`attributionMode=latest&sourcePrimary=${h.digital}`))).toEqual([l1.body.data.leadId, l2.body.data.leadId].sort());
    expect(ids(await get(`attributionMode=any&sourcePrimary=${h.organic}`))).toEqual([l1.body.data.leadId]);
    expect(ids(await get(`attributionMode=latest&sourceTertiary=${h.leadAds}&mediumSecondary=${h.social}&campaignTertiary=${h.ukMasters}`))).toEqual([l1.body.data.leadId]);
    expect(ids(await get(`inquiryType=reinquiry&attributionMode=latest&sourceSecondary=${h.meta}`))).toEqual([l1.body.data.leadId]);
    expect(ids(await get('inquiryType=first_time'))).toEqual([l2.body.data.leadId]);
    // UTM values match case-insensitively; original vs latest stay distinct.
    expect(ids(await get('utmSource=google'))).toEqual([l1.body.data.leadId]);
    expect(ids(await get('attributionMode=latest&utmSource=google'))).toEqual([]);
    expect(ids(await get('attributionMode=any&utmSource=FACEBOOK'))).toEqual([l1.body.data.leadId]);
    const today = new Date().toISOString().slice(0, 10);
    expect(ids(await get(`inquiryFrom=${today}&inquiryChannel=api`))).toHaveLength(2);

    // Inquiry history keeps both the original and the new attribution.
    const hist = (await api().get(`/api/v1/leads/${l1.body.data.leadId}/inquiries`).set(bearer(token))).body.data;
    expect(hist.summary.originalAttribution.source.primary).toBe('Organic Search');
    expect(hist.summary.latestAttribution.source).toEqual({ primary: 'Digital Marketing', secondary: 'Meta', tertiary: 'Meta Lead Ads Form' });
    expect(hist.items[0].previousHierarchy.source.primary).toBe('Organic Search');
    expect(hist.items[0].utm.source).toBe('facebook');

    // Bad filter values are rejected, not silently ignored.
    expect((await get('sourcePrimary=not-an-id')).status).toBe(422);
  });
});

describe('Assigned-only lead visibility (lead.viewAssignedOnly)', () => {
  it('limits lists, search, detail, inquiries, dashboard and exports to assigned leads, even for organization-scope roles', async () => {
    const { org, token } = await createOrgWithAdmin();
    const c1 = await createUserAs(token, org._id, 'counsellor');
    const c2 = await createUserAs(token, org._id, 'counsellor');
    // An organization-wide role, then restricted from /roles.
    const role = await api()
      .post('/api/v1/roles')
      .set(bearer(token))
      .send({ name: 'Telecaller', dataScope: 'organization', permissions: ['lead.view', 'lead.viewInquiries', 'lead.export', 'report.view', 'report.export', 'settings.view'] });
    expect(role.status).toBe(201);
    const user = await createUserAs(token, org._id, 'counsellor');
    await api().patch(`/api/v1/users/${user.id}`).set(bearer(token)).send({ roleId: role.body.data._id });
    const { login } = await import('./helpers.js');
    const tele = await login(user.email);

    const mine = await createLead(token, { firstName: 'Mine', phone: '9900088881', assignedCounsellor: user.id });
    const theirs = await createLead(token, { firstName: 'Theirs', phone: '9900088882', assignedCounsellor: c1.id });
    await createLead(token, { firstName: 'Other', phone: '9900088883', assignedCounsellor: c2.id });

    // Before the restriction: organization scope sees all three.
    expect((await api().get('/api/v1/leads').set(bearer(tele.accessToken))).body.pagination.total).toBe(3);

    const updated = await api()
      .patch(`/api/v1/roles/${role.body.data._id}`)
      .set(bearer(token))
      .send({ permissions: [...role.body.data.permissions, 'lead.viewAssignedOnly'] });
    expect(updated.status).toBe(200);

    // Takes effect on the next request (no re-login).
    const list = await api().get('/api/v1/leads').set(bearer(tele.accessToken));
    expect(list.body.pagination.total).toBe(1);
    expect(list.body.data[0]._id).toBe(mine.body.data.leadId);
    expect((await api().get('/api/v1/leads?search=Theirs').set(bearer(tele.accessToken))).body.data).toHaveLength(0);
    expect((await api().get('/api/v1/leads?search=9900088882').set(bearer(tele.accessToken))).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/leads/${theirs.body.data.leadId}`).set(bearer(tele.accessToken))).status).toBe(404);
    expect((await api().get(`/api/v1/leads/${theirs.body.data.leadId}/inquiries`).set(bearer(tele.accessToken))).status).toBe(404);
    expect((await api().get(`/api/v1/marketing/attribution/leads/${theirs.body.data.leadId}`).set(bearer(tele.accessToken))).status).toBe(404);
    const pipeline = (await api().get('/api/v1/leads/pipeline').set(bearer(tele.accessToken))).body.data;
    expect(pipeline.reduce((n: number, s: { count: number }) => n + s.count, 0)).toBe(1);
    const dash = (await api().get('/api/v1/dashboard/overview?period=all_time').set(bearer(tele.accessToken))).body.data;
    expect(dash.kpis.totalLeads).toBe(1);

    // Export follows the same scope.
    const exp = await api().post('/api/v1/reports/export').set(bearer(tele.accessToken)).send({ report: 'leads', format: 'csv' });
    expect(exp.status).toBe(202);
    await drainJobs();
    const job = await ReportExportModel.findById(exp.body.data.id).setOptions({ skipTenantGuard: true }).lean();
    expect(job!.rows).toBe(1);
    expect((await storage.getObject(job!.fileKey!)).toString('utf8')).not.toContain('Theirs');

    // Assignment changes take effect immediately.
    await api().post(`/api/v1/leads/${theirs.body.data.leadId}/assign`).set(bearer(token)).send({ counsellorId: user.id });
    expect((await api().get(`/api/v1/leads/${theirs.body.data.leadId}`).set(bearer(tele.accessToken))).status).toBe(200);
    await api().post(`/api/v1/leads/${theirs.body.data.leadId}/assign`).set(bearer(token)).send({ counsellorId: c1.id });
    expect((await api().get(`/api/v1/leads/${theirs.body.data.leadId}`).set(bearer(tele.accessToken))).status).toBe(404);

    // Without lead.assign the user cannot reassign, even their own lead.
    expect((await api().post(`/api/v1/leads/${mine.body.data.leadId}/assign`).set(bearer(tele.accessToken)).send({ counsellorId: user.id })).status).toBe(403);
  });

  it('is never part of full-access roles and only unrestricted users can change it', async () => {
    const { org, token } = await createOrgWithAdmin();
    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(me.body.data.permissions).not.toContain('lead.viewAssignedOnly');
    expect(me.body.data.permissions).toContain('lead.viewInquiries');

    // A restricted role manager can't lift the restriction or hand out an unrestricted lead role.
    const restricted = await api()
      .post('/api/v1/roles')
      .set(bearer(token))
      .send({ name: 'Restricted lead', dataScope: 'organization', permissions: ['role.view', 'role.manage', 'user.view', 'user.update', 'lead.view', 'lead.viewAssignedOnly'] });
    const other = await api().post('/api/v1/roles').set(bearer(token)).send({ name: 'Plain viewer', dataScope: 'own', permissions: ['lead.view', 'lead.viewAssignedOnly'] });
    const u = await createUserAs(token, org._id, 'counsellor');
    await api().patch(`/api/v1/users/${u.id}`).set(bearer(token)).send({ roleId: restricted.body.data._id });
    const { login } = await import('./helpers.js');
    const t = (await login(u.email)).accessToken;
    const lift = await api().patch(`/api/v1/roles/${other.body.data._id}`).set(bearer(t)).send({ permissions: ['lead.view'] });
    expect(lift.status).toBe(403);
    const target = await createUserAs(token, org._id, 'counsellor');
    const assign = await api().patch(`/api/v1/users/${target.id}`).set(bearer(t)).send({ roleId: await roleId(org._id, 'counsellor') });
    expect(assign.status).toBe(403);
  });
});

describe('Lead-integrity migration (existing data)', () => {
  it('backfills phone keys and inquiry history without merging or deleting, and reports shared phones', async () => {
    const { migrateLeadIntegrity, findPhoneConflicts } = await import('../src/database/migrations.js');
    const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
    const { Types } = await import('mongoose');
    const { org, token } = await createOrgWithAdmin();
    const custom = await api().post('/api/v1/roles').set(bearer(token)).send({ name: 'Legacy viewer', dataScope: 'own', permissions: ['lead.view'] });
    // Legacy documents as older releases stored them: no normalizedPhone, no inquiry fields, and two leads sharing a phone.
    const old = (n: number, phone: string, history: { leadSource: string; at: Date }[]) => ({
      _id: new Types.ObjectId(), organizationId: org._id, leadNumber: 5000 + n, firstName: `Old${n}`, fullName: `Old${n}`, phone, leadSource: history[0]!.leadSource,
      leadStage: 'new_lead', leadStatus: 'active', sourceHistory: history, deletedAt: null, createdAt: history[0]!.at, updatedAt: history[0]!.at,
    });
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-03-01T00:00:00Z');
    const a = old(1, '+919700000001', [{ leadSource: 'website', at: t0 }, { leadSource: 'meta', at: t1 }]);
    const b = old(2, '+919700000002', [{ leadSource: 'event', at: t0 }]);
    const c = old(3, '+919700000002', [{ leadSource: 'meta', at: t1 }]);
    await LeadModel.collection.insertMany([a, b, c]);

    expect((await findPhoneConflicts(org._id)).map((x) => [x.keptLeadId.toString(), x.otherLeadIds.map(String)])).toEqual([[b._id.toString(), [c._id.toString()]]]);
    await migrateLeadIntegrity(org._id);
    await migrateLeadIntegrity(org._id); // idempotent

    const after = await LeadModel.find({ organizationId: org._id, _id: { $in: [a._id, b._id, c._id] } }).lean();
    const byId = new Map(after.map((l) => [l._id.toString(), l]));
    expect(after).toHaveLength(3);
    expect(byId.get(a._id.toString())).toMatchObject({ normalizedPhone: '+919700000001', inquiryCount: 2, firstInquiryAt: t0, lastInquiryAt: t1 });
    expect(byId.get(b._id.toString())!.normalizedPhone).toBe('+919700000002');
    expect(byId.get(c._id.toString())!.normalizedPhone).toBeUndefined();
    expect(byId.get(c._id.toString())!.leadStatus).toBe('active');
    expect(await LeadInquiryModel.countDocuments({ organizationId: org._id, leadId: a._id })).toBe(2);
    expect(await AuditLogModel.countDocuments({ organizationId: org._id, action: 'lead.phone_duplicates_detected' })).toBe(1);
    const role = await (await import('../src/modules/roles/role.model.js')).RoleModel.findOne({ organizationId: org._id, _id: custom.body.data._id }).lean();
    expect(role!.permissions).toContain('lead.viewInquiries');

    // New submissions with that phone go to the lead holding the key.
    const next = await createLead(token, { phone: '9700000002' });
    expect(next.body.data).toMatchObject({ outcome: 'added_to_existing', leadId: b._id.toString() });
  });
});
