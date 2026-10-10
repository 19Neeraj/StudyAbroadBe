import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { storage } from '../src/integrations/storage/index.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ReportExportModel } from '../src/modules/reports/reportExport.model.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

async function exportFile(token: string, report: string, format: 'csv' | 'xlsx', params: Record<string, string> = {}) {
  const res = await api().post('/api/v1/reports/export').set(bearer(token)).send({ report, format, params });
  expect(res.status).toBe(202);
  await drainJobs();
  const job = await ReportExportModel.findById(res.body.data.id).setOptions({ skipTenantGuard: true }).lean();
  expect(job?.status).toBe('done');
  return { job: job!, body: await storage.getObject(job!.fileKey!) };
}

describe('Reports & exports', () => {
  it('exports leads with the list filters and neutralises spreadsheet formulas', async () => {
    const { token } = await createOrgWithAdmin();
    await createLead(token, { firstName: '=HYPERLINK("x")', phone: '9855500001', leadSource: 'meta', campaign: 'UK' });
    await createLead(token, { firstName: 'Web', phone: '9855500002', leadSource: 'website' });
    const { job, body } = await exportFile(token, 'leads', 'csv', { source: 'meta' });
    const text = body.toString('utf8');
    expect(job.rows).toBe(1);
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toContain('Web');
    expect(text.split('\r\n')[0]).toContain('Lead #');

    const dl = await api().get(`/api/v1/reports/exports/${job._id}/download`).set(bearer(token));
    expect(dl.status).toBe(200);
    expect(dl.body.data.fileName).toMatch(/^leads-.*\.csv$/);
  });

  it('only exports what the requester can see, and only reports they may export', async () => {
    const { org, token } = await createOrgWithAdmin();
    const c1 = await createUserAs(token, org._id, 'counsellor');
    const c2 = await createUserAs(token, org._id, 'counsellor');
    await createLead(token, { firstName: 'Mine', phone: '9855500003', assignedCounsellor: c1.id });
    await createLead(token, { firstName: 'Theirs', phone: '9855500004', assignedCounsellor: c2.id });
    const cat = (await api().get('/api/v1/reports/catalog').set(bearer(c1.token))).body.data.map((r: { key: string }) => r.key);
    expect(cat).not.toContain('leads'); // counsellors don't have lead.export by default
    expect((await api().post('/api/v1/reports/export').set(bearer(c1.token)).send({ report: 'leads', format: 'csv' })).status).toBe(403);

    const manager = await createUserAs(token, org._id, 'management');
    const { body } = await exportFile(manager.token, 'leads', 'xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);
    const names = wb.worksheets[0]!.getColumn(2).values.slice(2);
    expect(names.sort()).toEqual(['Mine', 'Theirs']);
    // Someone else can't download it.
    const job = await ReportExportModel.findOne({ organizationId: org._id, requestedBy: manager.id }).lean();
    expect((await api().get(`/api/v1/reports/exports/${job!._id}/download`).set(bearer(token))).status).toBe(404);
  });

  it('builds the counsellor performance report from leads and calls', async () => {
    const { org, token } = await createOrgWithAdmin();
    const c1 = await createUserAs(token, org._id, 'counsellor');
    const lead = (await createLead(token, { firstName: 'Perf', phone: '9855500005', assignedCounsellor: c1.id })).body.data.lead;
    const call = await api().post('/api/v1/calls').set(bearer(c1.token)).send({ leadId: lead._id });
    await api().post(`/api/v1/calls/${call.body.data.call._id}/complete`).set(bearer(c1.token)).send({ durationSeconds: 300, callOutcome: 'interested' });
    const res = await api().get('/api/v1/reports/counsellor-performance?period=all_time').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.rows.find((r: { key: string }) => r.key === c1.id)).toMatchObject({ leads: 1, calls: 1, connected: 1, talkMinutes: 5 });
    expect((await api().get('/api/v1/reports/counsellor-performance?period=nonsense').set(bearer(token))).status).toBe(422);
    const { job } = await exportFile(token, 'counsellor_performance', 'xlsx', { period: 'all_time' });
    expect(job.rows).toBeGreaterThanOrEqual(1);
  });

  it('exports calls, follow-ups, payments, applications and students without errors', async () => {
    const { token } = await createOrgWithAdmin();
    await createLead(token, { firstName: 'Any', phone: '9855500006' });
    for (const r of ['calls', 'followups', 'payments', 'applications', 'students']) {
      const { job } = await exportFile(token, r, 'csv');
      expect(job.error).toBeUndefined();
    }
  });
});
