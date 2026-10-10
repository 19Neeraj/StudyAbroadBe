import * as triggers from '../notifications/triggers.js';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from '../../docs/zod.js';
import { env } from '../../config/env.js';
import { hasPermissions } from '../../middlewares/auth.middleware.js';
import { storage } from '../../integrations/storage/index.js';
import { emitTo, rooms } from '../../sockets/index.js';
import type { ServiceContext } from '../../types/auth.js';
import { ownershipScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { objectIdString } from '../../utils/objectId.js';
import { logActivity } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { ApplicationModel } from '../applications/application.model.js';
import { assertLookupValues, lookupMetaByKey } from '../settings/lookup.service.js';
import { loadStudent } from '../students/student.service.js';
import { DocumentModel } from './document.model.js';
import { ALLOWED_TYPES, detectFileType, safeFileName } from './fileType.js';

const key = z.string().trim().min(1).max(64);

export const checklistBody = z
  .object({
    studentId: objectIdString,
    documentTypes: z.array(key).min(1).max(30),
    applicationId: objectIdString.optional(),
    dueDate: z.coerce.date().optional(),
  })
  .openapi('DocumentChecklistRequest');

/** Multipart text fields that accompany the file. */
export const uploadFields = z
  .object({
    studentId: objectIdString.optional(),
    documentType: key.optional(),
    documentId: objectIdString.optional().openapi({ description: 'Upload a (new version of a) file for this checklist item' }),
    applicationId: objectIdString.optional(),
    title: z.string().trim().max(150).optional(),
  })
  .refine((v) => v.documentId || (v.studentId && v.documentType), { message: 'Send documentId, or studentId and documentType', path: ['documentType'] })
  .openapi('UploadDocumentFields');

export const reviewBody = z
  .object({
    decision: z.enum(['under_review', 'approve', 'reject', 'reupload']),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.decision === 'approve' || v.decision === 'under_review' || v.reason, { message: 'Give a reason so the student knows what to fix', path: ['reason'] })
  .openapi('ReviewDocumentRequest');

export const documentListQuery = z.object({
  studentId: objectIdString.optional(),
  applicationId: objectIdString.optional(),
  status: z.string().transform((v) => v.split(',').filter(Boolean)).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const populate = (ctx: ServiceContext) => [
  { path: 'reviewedBy', select: 'fullName', match: { organizationId: ctx.organizationId } },
  { path: 'file.uploadedBy', select: 'fullName', match: { organizationId: ctx.organizationId } },
  { path: 'studentId', select: 'fullName studentNumber', match: { organizationId: ctx.organizationId } },
];
/** File keys never leave the API; clients download through signed URLs. */
function dto(d: Record<string, unknown> & { file?: Record<string, unknown> | null; versions?: Record<string, unknown>[]; studentId?: unknown }): Record<string, unknown> & { status: string } {
  const strip = (f?: Record<string, unknown> | null) => (f ? (({ fileKey: _k, ...rest }) => rest)(f) : null);
  const { studentId, __v: _v, ...rest } = d;
  return { ...rest, status: String(d.status), student: studentId ?? null, file: strip(d.file), versions: (d.versions ?? []).map((v) => strip(v)) };
}

async function loadDocument(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Document');
  const doc = await DocumentModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id) }));
  if (!doc) throw ApiError.notFound('Document');
  return doc;
}

export async function getDocument(ctx: ServiceContext, id: string | Types.ObjectId) {
  const doc = await DocumentModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id) })).populate(populate(ctx)).lean();
  if (!doc) throw ApiError.notFound('Document');
  return dto(doc as never);
}

export async function listDocuments(ctx: ServiceContext, q: z.infer<typeof documentListQuery>) {
  const filter: Record<string, unknown> = {};
  if (q.studentId) filter.studentId = new Types.ObjectId((await loadStudent(ctx, q.studentId))._id);
  if (q.applicationId) filter.applicationId = new Types.ObjectId(q.applicationId);
  if (q.status?.length) filter.status = { $in: q.status };
  const docs = await DocumentModel.find(ownershipScope(ctx, filter)).sort({ updatedAt: -1 }).limit(q.limit).populate(populate(ctx)).lean();
  const items = docs.map((d) => dto(d as never));
  const count = (s: string) => items.filter((d) => d.status === s).length;
  return { items, summary: { total: items.length, approved: count('approved'), pending: count('required') + count('reupload_required') + count('rejected'), inReview: count('uploaded') + count('under_review') } };
}

async function assertApplication(ctx: ServiceContext, studentId: Types.ObjectId, applicationId?: string) {
  if (!applicationId) return undefined;
  const ok = await ApplicationModel.exists({ organizationId: ctx.organizationId, _id: applicationId, studentId });
  if (!ok) throw ApiError.validation([{ field: 'body.applicationId', message: 'Application not found for this student' }]);
  return new Types.ObjectId(applicationId);
}

/** Creates "required" placeholders for the given types (existing open items are kept). */
export async function createChecklist(ctx: ServiceContext, input: z.infer<typeof checklistBody>) {
  const student = await loadStudent(ctx, input.studentId);
  await assertLookupValues(ctx, Object.fromEntries(input.documentTypes.map((t, i) => [`documentTypes.${i}`, { type: 'document_type' as const, value: t }])));
  const applicationId = await assertApplication(ctx, student._id, input.applicationId);
  const existing = await DocumentModel.find({ organizationId: ctx.organizationId, studentId: student._id, documentType: { $in: input.documentTypes }, ...(applicationId ? { applicationId } : {}) }).select('documentType').lean();
  const have = new Set(existing.map((d) => d.documentType));
  const missing = [...new Set(input.documentTypes)].filter((t) => !have.has(t));
  if (missing.length) {
    await DocumentModel.insertMany(
      missing.map((documentType) => ({
        organizationId: ctx.organizationId,
        studentId: student._id,
        leadId: student.leadId,
        branchId: student.branchId,
        assignedCounsellor: student.assignedCounsellor,
        assignedManager: student.assignedManager,
        applicationId,
        documentType,
        status: 'required',
        dueDate: input.dueDate,
        createdBy: ctx.userId,
      })),
    );
    const labels = await lookupMetaByKey(ctx, 'document_type');
    await logActivity(ctx, { leadId: student.leadId, studentId: student._id, type: 'document_uploaded', title: 'Documents requested', notes: missing.map((t) => labels.get(t)?.label ?? t).join(', ') });
  }
  return listDocuments(ctx, { studentId: student._id.toString(), limit: 200 });
}

export async function uploadDocument(ctx: ServiceContext, fields: z.infer<typeof uploadFields>, file: { buffer: Buffer; originalname: string; size: number } | undefined) {
  if (!file) throw ApiError.validation([{ field: 'file', message: 'Attach a file' }]);
  const mime = detectFileType(file.buffer);
  if (!mime) throw ApiError.validation([{ field: 'file', message: 'Only PDF, JPG, PNG, WEBP, DOC or DOCX files are allowed' }]);
  const ext = ALLOWED_TYPES[mime]!.ext;

  let doc = fields.documentId ? await loadDocument(ctx, fields.documentId) : null;
  if (!doc) {
    const student = await loadStudent(ctx, fields.studentId!);
    await assertLookupValues(ctx, { documentType: { type: 'document_type', value: fields.documentType } });
    const applicationId = await assertApplication(ctx, student._id, fields.applicationId);
    // Reuse an open checklist item of this type instead of creating a duplicate.
    doc =
      (await DocumentModel.findOne({ organizationId: ctx.organizationId, studentId: student._id, documentType: fields.documentType, status: { $in: ['required', 'reupload_required', 'rejected'] }, ...(applicationId ? { applicationId } : {}) })) ??
      new DocumentModel({
        organizationId: ctx.organizationId,
        studentId: student._id,
        leadId: student.leadId,
        branchId: student.branchId,
        assignedCounsellor: student.assignedCounsellor,
        assignedManager: student.assignedManager,
        applicationId,
        documentType: fields.documentType,
        title: fields.title,
        createdBy: ctx.userId,
      });
  }
  if (doc.status === 'approved' && !hasPermissions(ctx, ['document.approve'])) {
    throw ApiError.forbidden('This document is already approved; ask a reviewer to request a re-upload');
  }
  const fileKey = `${ctx.organizationId.toString()}/students/${doc.studentId.toString()}/documents/${doc._id.toString()}/${randomUUID()}.${ext}`;
  await storage.putObject({ key: fileKey, body: file.buffer, contentType: mime });
  if (doc.file) doc.versions.push({ ...doc.toObject().file, status: doc.status, rejectionReason: doc.rejectionReason } as never);
  doc.set('file', { fileKey, fileName: safeFileName(file.originalname, ext), mimeType: mime, fileSize: file.size, uploadedBy: ctx.userId, uploadedAt: new Date() });
  doc.status = 'uploaded';
  doc.rejectionReason = undefined;
  if (fields.title) doc.title = fields.title;
  await doc.save();

  const labels = await lookupMetaByKey(ctx, 'document_type');
  await logActivity(ctx, { leadId: doc.leadId, studentId: doc.studentId, type: 'document_uploaded', title: `${labels.get(doc.documentType)?.label ?? doc.documentType} uploaded`, metadata: { documentId: doc._id.toString(), version: doc.versions.length + 1 } });
  await recordAudit(ctx, { entityType: 'document', entityId: doc._id, action: 'document.uploaded', metadata: { documentType: doc.documentType, size: file.size, mimeType: mime } });
  if (doc.assignedCounsellor) emitTo([rooms.user(doc.assignedCounsellor.toString())], 'document.updated', { documentId: doc._id.toString(), status: 'uploaded' });
  return getDocument(ctx, doc._id);
}

export async function reviewDocument(ctx: ServiceContext, id: string, input: z.infer<typeof reviewBody>) {
  const needed = input.decision === 'approve' ? 'document.approve' : input.decision === 'under_review' ? null : 'document.reject';
  if (needed && !hasPermissions(ctx, [needed])) throw ApiError.forbidden(`You need ${needed} to do this`);
  if (input.decision === 'under_review' && !hasPermissions(ctx, ['document.approve', 'document.reject'], 'any')) throw ApiError.forbidden();
  const doc = await loadDocument(ctx, id);
  if (!doc.file) throw ApiError.badRequest('Nothing has been uploaded for this document yet');
  const status = { under_review: 'under_review', approve: 'approved', reject: 'rejected', reupload: 'reupload_required' }[input.decision] as 'under_review';
  const previous = doc.status;
  doc.status = status;
  doc.rejectionReason = input.decision === 'approve' || input.decision === 'under_review' ? undefined : input.reason;
  doc.reviewedBy = ctx.userId;
  doc.reviewedAt = new Date();
  await doc.save();
  const labels = await lookupMetaByKey(ctx, 'document_type');
  const label = labels.get(doc.documentType)?.label ?? doc.documentType;
  await logActivity(ctx, {
    leadId: doc.leadId,
    studentId: doc.studentId,
    type: 'document_reviewed',
    title: { under_review: `${label} under review`, approved: `${label} approved`, rejected: `${label} rejected`, reupload_required: `${label}: re-upload requested` }[status],
    previousValue: previous,
    newValue: status,
    notes: input.reason,
    metadata: { documentId: doc._id.toString() },
  });
  await recordAudit(ctx, { entityType: 'document', entityId: doc._id, action: `document.${input.decision}`, oldValue: { status: previous }, newValue: { status }, metadata: { reason: input.reason } });
  if (doc.assignedCounsellor) emitTo([rooms.user(doc.assignedCounsellor.toString())], 'document.updated', { documentId: doc._id.toString(), status });
  if (input.decision === 'reject' || input.decision === 'reupload') await triggers.documentRejected(ctx.organizationId, doc, label, input.reason, ctx.userId);
  return getDocument(ctx, doc._id);
}

/** Short-lived signed link to the current file or a past version; every access is audited. */
export async function documentDownloadUrl(ctx: ServiceContext, id: string, versionId?: string, inline = false) {
  const doc = await loadDocument(ctx, id);
  const file = versionId ? doc.versions.find((v) => v._id?.toString() === versionId) : doc.file;
  if (!file) throw ApiError.notFound('File');
  const url = await storage.getSignedUrl(file.fileKey, { fileName: file.fileName, inline });
  await recordAudit(ctx, { entityType: 'document', entityId: doc._id, action: inline ? 'document.viewed' : 'document.downloaded', metadata: { versionId: versionId ?? null } });
  return { url, fileName: file.fileName, mimeType: file.mimeType, expiresInSeconds: env.SIGNED_URL_TTL_SECONDS };
}
