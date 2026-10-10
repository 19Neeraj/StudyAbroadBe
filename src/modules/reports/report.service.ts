import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { storage } from '../../integrations/storage/index.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { CONTENT_TYPES, toCsv, toXlsx } from '../../utils/spreadsheet.js';
import { recordAudit } from '../audit/audit.service.js';
import { integrationActor } from '../marketing/actor.js';
import { redact } from '../marketing/money.js';
import { REPORTS } from './report.catalog.js';
import { ReportExportModel } from './reportExport.model.js';
import type { exportBody } from './report.validation.js';

const allowed = (ctx: ServiceContext, key: string) => {
  const def = REPORTS.find((r) => r.key === key);
  return def && def.permissions.every((p) => ctx.permissions.has(p)) ? def : null;
};

/** Reports this user may export. */
export function catalog(ctx: ServiceContext) {
  return REPORTS.filter((r) => allowed(ctx, r.key)).map(({ key, label, description }) => ({ key, label, description }));
}

export async function requestExport(ctx: ServiceContext, input: z.infer<typeof exportBody>) {
  if (!allowed(ctx, input.report)) throw ApiError.forbidden('You cannot export this report');
  const job = await ReportExportModel.create({ organizationId: ctx.organizationId, report: input.report, format: input.format, params: input.params, requestedBy: ctx.userId });
  await enqueue('reports.export', { organizationId: ctx.organizationId.toString(), jobId: job._id.toString() }, { jobId: `reports.export:${job._id.toString()}` });
  await recordAudit(ctx, { entityType: 'report_export', entityId: job._id, action: 'report.export_requested', metadata: input });
  return { id: job._id, status: job.status };
}

/** Builds the file as the requester, with their permissions and data scope at run time. */
export async function runExport(organizationId: Types.ObjectId, jobId: Types.ObjectId) {
  const job = await ReportExportModel.findOneAndUpdate({ organizationId, _id: jobId, status: { $in: ['queued', 'failed'] } }, { status: 'running' }, { returnDocument: 'after' });
  if (!job) return;
  try {
    const ctx = await integrationActor(organizationId, job.requestedBy);
    const def = allowed(ctx, job.report);
    if (!def) throw new Error('Export permission was removed');
    const sheet = await def.build(ctx, job.params as Record<string, string>);
    const body = job.format === 'csv' ? toCsv(sheet) : await toXlsx(sheet, def.label);
    const fileName = `${job.report}-${new Date().toISOString().slice(0, 10)}.${job.format}`;
    const key = `${organizationId.toString()}/exports/reports/${job._id.toString()}.${job.format}`;
    await storage.putObject({ key, body, contentType: CONTENT_TYPES[job.format as 'csv' | 'xlsx'] });
    await ReportExportModel.updateOne({ organizationId, _id: job._id }, { status: 'done', fileKey: key, fileName, rows: sheet.rows.length, truncated: sheet.truncated, finishedAt: new Date() });
  } catch (err) {
    await ReportExportModel.updateOne({ organizationId, _id: job._id }, { status: 'failed', error: redact((err as Error).message), finishedAt: new Date() });
  }
}

export async function listExports(ctx: ServiceContext) {
  return ReportExportModel.find({ organizationId: ctx.organizationId, requestedBy: ctx.userId }).sort({ createdAt: -1 }).limit(30).select('-organizationId -__v -fileKey').lean();
}

export async function downloadExport(ctx: ServiceContext, id: string) {
  const job = await ReportExportModel.findOne({ organizationId: ctx.organizationId, _id: new Types.ObjectId(id), requestedBy: ctx.userId }).lean();
  if (!job) throw ApiError.notFound('Export');
  if (job.status !== 'done' || !job.fileKey) throw ApiError.conflict(job.status === 'failed' ? `Export failed: ${job.error ?? 'unknown error'}` : 'Export is not ready yet');
  await recordAudit(ctx, { entityType: 'report_export', entityId: job._id, action: 'report.export_downloaded', metadata: { report: job.report, rows: job.rows } });
  return { url: await storage.getSignedUrl(job.fileKey, { expiresInSeconds: 300, fileName: job.fileName ?? undefined }), fileName: job.fileName };
}

export function registerReportJobs() {
  registerJob<{ organizationId: string; jobId: string }>('reports.export', async (d) => runExport(new Types.ObjectId(d.organizationId), new Types.ObjectId(d.jobId)), { attempts: 2 });
}
