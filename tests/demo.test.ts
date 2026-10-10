import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { removeDemoOrganization } from '../src/database/demoClean.js';
import { seedDemoData } from '../src/database/demoData.js';
import { ApplicationModel } from '../src/modules/applications/application.model.js';
import { DEMO_ORG_SLUG } from '../src/modules/demo/demo.service.js';
import { LeadInquiryModel } from '../src/modules/leads/inquiry.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { OrganizationModel } from '../src/modules/organizations/organization.model.js';
import { provisionOrganization } from '../src/modules/organizations/organization.service.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { StudentModel } from '../src/modules/students/student.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { api, bearer, createLead, createOrgWithAdmin } from './helpers.js';

describe('Demo environment', () => {
  it('seeds a consistent, read-only demo and cleans up only demo data', { timeout: 180_000 }, async () => {
    const customer = await createOrgWithAdmin('Real Customer');
    await createLead(customer.token, { firstName: 'Customer', phone: '9811100001' });

    // Not available unless enabled.
    expect((await api().post('/api/v1/auth/demo').send({ persona: 'admin' })).status).toBe(404);
    (env as { DEMO_ENABLED: boolean }).DEMO_ENABLED = true;
    expect((await api().post('/api/v1/auth/demo').send({ persona: 'admin' })).body.code).toBe('DEMO_NOT_SEEDED');

    const { organization, admin } = await provisionOrganization(
      { name: 'Demo Overseas Education', slug: DEMO_ORG_SLUG, admin: { firstName: 'Demo', lastName: 'Admin', email: 'admin@demo.local', password: 'DemoAdmin123' } },
      { meta: {} },
    );
    await OrganizationModel.updateOne({ _id: organization._id }, { isDemo: true });
    const orgId = organization._id as mongoose.Types.ObjectId;
    const seeded = await seedDemoData(orgId, new mongoose.Types.ObjectId(admin.id));
    expect(seeded.leads).toBeGreaterThanOrEqual(50);
    expect(seeded.leads).toBeLessThanOrEqual(100);
    // Every collection the app uses has demo data (platform-wide ones are checked without the org filter).
    const { default: mg } = await import('mongoose');
    await import('../src/database/migrations.js');
    const empty: string[] = [];
    for (const m of Object.values(mg.models)) {
      if (m.collection.collectionName === 'migrations') continue; // filled by `npm run seed:demo`, not by this test
      const filter = m.schema.path('organizationId') ? { organizationId: orgId } : {};
      if (!(await m.countDocuments(filter).setOptions({ skipTenantGuard: true }))) empty.push(m.collection.collectionName);
    }
    expect(empty).toEqual([]);
    // Recordings point at real files, and exports finished from real data.
    const { CallRecordingModel } = await import('../src/modules/calls/recording.model.js');
    const { storage } = await import('../src/integrations/storage/index.js');
    const rec = await CallRecordingModel.findOne({ organizationId: orgId }).lean();
    expect((await storage.getObject(rec!.fileKey!)).subarray(0, 4).toString()).toBe('RIFF');
    const { ReportExportModel } = await import('../src/modules/reports/reportExport.model.js');
    expect((await ReportExportModel.find({ organizationId: orgId }).lean()).every((j) => j.status === 'done' && (j.rows ?? 0) > 0)).toBe(true);
    // Idempotent: a second run adds nothing.
    expect((await seedDemoData(orgId, new mongoose.Types.ObjectId(admin.id))).leads).toBe(0);

    // Team: one admin, one manager, 5–10 counsellors.
    const counsellors = await UserModel.countDocuments({ organizationId: orgId, email: { $nin: ['admin@demo.local', 'manager@demo.local'] } });
    expect(counsellors).toBeGreaterThanOrEqual(5);
    expect(counsellors).toBeLessThanOrEqual(10);

    // Every reference resolves inside the demo organization.
    const userIds = new Set((await UserModel.find({ organizationId: orgId }).select('_id').lean()).map((u) => u._id.toString()));
    const leads = await LeadModel.find({ organizationId: orgId }).select('assignedCounsellor assignedManager studentId inquiryCount normalizedPhone').lean();
    for (const l of leads) {
      if (l.assignedCounsellor) expect(userIds.has(l.assignedCounsellor.toString())).toBe(true);
      if (l.assignedManager) expect(userIds.has(l.assignedManager.toString())).toBe(true);
    }
    const leadIds = new Set(leads.map((l) => l._id.toString()));
    const students = await StudentModel.find({ organizationId: orgId }).select('leadId').lean();
    expect(students.every((s) => leadIds.has(s.leadId!.toString()))).toBe(true);
    const studentIds = new Set(students.map((s) => s._id.toString()));
    expect((await ApplicationModel.find({ organizationId: orgId }).select('studentId').lean()).every((a) => studentIds.has(a.studentId!.toString()))).toBe(true);
    expect((await PaymentModel.find({ organizationId: orgId }).select('studentId').lean()).every((p) => studentIds.has(p.studentId!.toString()))).toBe(true);

    // Re-inquiries are real history: counters equal the inquiry documents, and no phone is duplicated.
    const inquiries = await LeadInquiryModel.find({ organizationId: orgId }).select('leadId isReinquiry').lean();
    expect(inquiries.every((i) => leadIds.has(i.leadId.toString()))).toBe(true);
    expect(inquiries.filter((i) => i.isReinquiry).length).toBeGreaterThan(3);
    expect(leads.reduce((n, l) => n + (l.inquiryCount ?? 1), 0)).toBe(inquiries.length);
    expect(new Set(leads.map((l) => l.normalizedPhone)).size).toBe(leads.length);

    // Demo sign-in → dashboard totals come from the database, and nothing can be changed.
    const demo = await api().post('/api/v1/auth/demo').send({ persona: 'manager', platform: 'android' });
    expect(demo.status).toBe(200);
    expect(demo.body.data.user.isDemo).toBe(true);
    const adminDemo = (await api().post('/api/v1/auth/demo').send({ persona: 'admin', platform: 'android' })).body.data.accessToken;
    const dash = await api().get('/api/v1/dashboard/overview?period=all_time').set(bearer(adminDemo));
    expect(dash.body.data.kpis.totalLeads).toBe(await LeadModel.countDocuments({ organizationId: orgId, deletedAt: null }));
    const list = await api().get('/api/v1/leads?inquiryType=reinquiry&limit=1').set(bearer(adminDemo));
    expect(list.body.pagination.total).toBe(await LeadModel.countDocuments({ organizationId: orgId, inquiryCount: { $gte: 2 } }));
    const write = await api().post('/api/v1/leads').set(bearer(adminDemo)).send({ firstName: 'X', phone: '9811100002' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('DEMO_READ_ONLY');
    expect((await api().post('/api/v1/auth/change-password').set(bearer(adminDemo)).send({ currentPassword: 'DemoAdmin123', newPassword: 'Another123' })).status).toBe(403);
    // Demo sessions never see other organizations.
    expect((await api().get('/api/v1/leads?search=Customer').set(bearer(adminDemo))).body.data).toHaveLength(0);

    // Clean-up removes the demo organization only.
    const removed = await removeDemoOrganization();
    expect(removed!.documents).toBeGreaterThan(seeded.leads);
    expect(await LeadModel.countDocuments({ organizationId: orgId })).toBe(0);
    expect(await OrganizationModel.exists({ _id: orgId })).toBeNull();
    expect(await LeadModel.countDocuments({ organizationId: customer.org._id })).toBe(1);
    expect(await UserModel.exists({ email: customer.adminEmail }).setOptions({ skipTenantGuard: true })).not.toBeNull();
    (env as { DEMO_ENABLED: boolean }).DEMO_ENABLED = false;
  });

  it('refuses to clean an organization that is not flagged as a demo', async () => {
    await provisionOrganization({ name: 'Look-alike', slug: DEMO_ORG_SLUG, admin: { firstName: 'A', lastName: 'B', email: `lookalike.${Date.now()}@test.local`, password: 'Passw0rd123' } }, { meta: {} });
    await expect(removeDemoOrganization()).rejects.toThrow(/not flagged as a demo/);
    await OrganizationModel.deleteOne({ slug: DEMO_ORG_SLUG });
  });
});
