import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { storage } from '../../integrations/storage/index.js';
import { enqueue } from '../../jobs/queue.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { CONTENT_TYPES, toCsv, toXlsx } from '../../utils/spreadsheet.js';
import { recordAudit } from '../audit/audit.service.js';
import { integrationActor } from './actor.js';
import { redact } from './money.js';
import { MarketingReportJobModel } from './reportJob.model.js';
import * as reports from './reports.service.js';
import { reportQuery, type exportBody } from './reports.validation.js';

type Cell = string | number | null;
const NA = 'N/A';

/** Null ratio → "N/A"; null spend → "Unavailable" (never 0). */
async function build(ctx: ServiceContext, report: string, params: Record<string, string>): Promise<{ headers: string[]; rows: Cell[][] }> {
  const q = reportQuery.parse(params);
  const money = (v: number | null) => (v === null ? 'Unavailable' : Math.round(v * 100) / 100);
  const r2 = (v: number | null) => (v === null ? NA : Math.round(v * 100) / 100);
  if (report === 'campaigns') {
    const b = await reports.breakdown(ctx, q);
    return {
      headers: ['Group', 'Key', `Spend (${b.currency})`, 'Platform leads', 'CRM leads', 'Qualified', 'Contacted', 'Meetings', 'Applications', 'Admissions', 'Enrolments', `Revenue (${b.currency})`, 'CPL', 'Cost / qualified', 'Cost / application', 'Cost / admission', 'Cost / enrolment', 'ROAS'],
      rows: b.items.map((i) => [i.label, i.key, b.spendSupported ? money(i.spend) : NA, i.providerLeads ?? 'Unavailable', i.leads, i.qualified, i.contacted, i.meetings, i.applications, i.admissions, i.enrolments, i.revenue, r2(i.cpl), r2(i.cpql), r2(i.costPerApplication), r2(i.costPerAdmission), r2(i.costPerEnrolment), r2(i.roas)]),
    };
  }
  if (report === 'overview') {
    const o = await reports.overview(ctx, q);
    const keys = ['spend', 'providerLeads', 'leads', 'paidLeads', 'qualified', 'contacted', 'meetings', 'applications', 'admissions', 'enrolments', 'revenue', 'cpl', 'paidCpl', 'costPerApplication', 'costPerEnrolment', 'roas'] as const;
    return { headers: ['Metric', `${o.period.from} → ${o.period.to}`, `${o.previousPeriod.from} → ${o.previousPeriod.to}`], rows: keys.map((k) => [k, (o.current as Record<string, unknown>)[k] as Cell ?? NA, (o.previous as Record<string, unknown>)[k] as Cell ?? NA]) };
  }
  if (report === 'funnel') {
    const f = await reports.funnel(ctx, q);
    return { headers: ['Step', 'Count', '% of previous', '% of leads', `Cost per (${f.currency})`], rows: f.steps.map((s) => [s.key ?? '', s.count, s.fromPrevious ?? NA, s.fromTop ?? NA, r2(s.costPer)]) };
  }
  if (report === 'trend') {
    const t = await reports.trend(ctx, q);
    return { headers: ['Period', `Spend (${t.currency})`, 'CRM leads', 'Paid leads', 'CPL (paid)'], rows: t.points.map((p) => [p.period, money(p.spend), p.leads, p.paidLeads, r2(p.cpl)]) };
  }
  const d = await reports.dataQuality(ctx, q);
  return {
    headers: ['Issue', 'Item', 'Value'],
    rows: [
      ...d.leadsWithoutTracking.bySource.map((x) => ['Leads without tracking', x.leadSource, x.leads] as Cell[]),
      ...d.unmappedCampaigns.map((x) => ['Unmapped campaign', `${x.provider}:${x.campaignExternalId} ${x.name ?? ''}`.trim(), x.touchpoints] as Cell[]),
      ...Object.entries(d.importOutcomes).map(([k, v]) => ['Imported leads', k, v] as Cell[]),
      ...d.spendWithoutLeads.map((x) => ['Spend without CRM leads', x.label, x.spend] as Cell[]),
      ...d.spendWithoutEnrolments.map((x) => ['Spend without enrolments', x.label, x.spend] as Cell[]),
    ],
  };
}

export async function requestExport(ctx: ServiceContext, input: z.infer<typeof exportBody>) {
  reportQuery.parse(input.params); // fail fast on bad parameters
  const job = await MarketingReportJobModel.create({ organizationId: ctx.organizationId, report: input.report, format: input.format, params: input.params, requestedBy: ctx.userId });
  await enqueue('marketing.export', { organizationId: ctx.organizationId.toString(), jobId: job._id.toString() }, { jobId: `marketing.export:${job._id.toString()}` });
  await recordAudit(ctx, { entityType: 'marketing_report', entityId: job._id, action: 'marketing.export_requested', metadata: input });
  return { id: job._id, status: job.status };
}

export async function runExport(organizationId: Types.ObjectId, jobId: Types.ObjectId) {
  const job = await MarketingReportJobModel.findOneAndUpdate({ organizationId, _id: jobId, status: { $in: ['queued', 'failed'] } }, { status: 'running' }, { returnDocument: 'after' });
  if (!job) return;
  try {
    // Runs with the requester's current permissions (an export can't outlive revoked access).
    const ctx = await integrationActor(organizationId, job.requestedBy);
    if (!ctx.permissions.has('marketing.export')) throw new Error('Export permission was removed');
    const data = await build(ctx, job.report, job.params as Record<string, string>);
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `marketing-${job.report}-${stamp}.${job.format}`;
    const body = job.format === 'csv' ? toCsv(data) : await toXlsx(data, job.report);
    const key = `${organizationId.toString()}/exports/marketing/${job._id.toString()}.${job.format}`;
    await storage.putObject({ key, body, contentType: CONTENT_TYPES[job.format as 'csv' | 'xlsx'] });
    await MarketingReportJobModel.updateOne({ organizationId, _id: job._id }, { status: 'done', fileKey: key, fileName, rows: data.rows.length, finishedAt: new Date() });
  } catch (err) {
    await MarketingReportJobModel.updateOne({ organizationId, _id: job._id }, { status: 'failed', error: redact((err as Error).message), finishedAt: new Date() });
  }
}

export async function listExports(ctx: ServiceContext) {
  return MarketingReportJobModel.find({ organizationId: ctx.organizationId, requestedBy: ctx.userId }).sort({ createdAt: -1 }).limit(20).select('-organizationId -__v -fileKey').lean();
}

/** Only the requester can download; the link expires in 5 minutes. */
export async function downloadExport(ctx: ServiceContext, id: string) {
  const job = await MarketingReportJobModel.findOne({ organizationId: ctx.organizationId, _id: new Types.ObjectId(id), requestedBy: ctx.userId }).lean();
  if (!job) throw ApiError.notFound('Export');
  if (job.status !== 'done' || !job.fileKey) throw ApiError.conflict(job.status === 'failed' ? `Export failed: ${job.error ?? 'unknown error'}` : 'Export is not ready yet');
  await recordAudit(ctx, { entityType: 'marketing_report', entityId: job._id, action: 'marketing.export_downloaded' });
  return { url: await storage.getSignedUrl(job.fileKey, { expiresInSeconds: 300, fileName: job.fileName ?? undefined }), fileName: job.fileName };
}
