import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { ownershipFields } from '../applications/application.model.js';

export const DOCUMENT_STATUSES = ['required', 'uploaded', 'under_review', 'approved', 'rejected', 'reupload_required'] as const;

/** File metadata only: the bytes live in object storage (spec §21, §42). */
const fileSchema = new Schema(
  {
    fileKey: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    fileSize: { type: Number, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: () => new Date() },
    /** Review outcome of this version (for history). */
    status: { type: String },
    rejectionReason: { type: String },
  },
  { _id: true },
);

const documentSchema = new Schema(
  {
    ...tenantField,
    ...ownershipFields,
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
    /** Lookup key (type document_type). */
    documentType: { type: String, required: true },
    title: { type: String, trim: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'required' },
    /** Current version; previous versions stay in `versions` (nothing is overwritten). */
    file: { type: fileSchema },
    versions: { type: [fileSchema], default: [] },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
    dueDate: { type: Date },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
documentSchema.index({ organizationId: 1, studentId: 1, documentType: 1 });
documentSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
documentSchema.index({ organizationId: 1, applicationId: 1 });
documentSchema.index({ organizationId: 1, branchId: 1, status: 1 });
documentSchema.index({ organizationId: 1, assignedCounsellor: 1, status: 1 });
documentSchema.plugin(tenantPlugin);

export type CrmDocument = InferSchemaType<typeof documentSchema> & { _id: Types.ObjectId };
export const DocumentModel = model('Document', documentSchema);
