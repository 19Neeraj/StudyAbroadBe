import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Background CRM exports (spec: Reports & exports). Files live in private storage; kept 7 days. */
const reportExportSchema = new Schema(
  {
    ...tenantField,
    report: { type: String, required: true },
    format: { type: String, enum: ['csv', 'xlsx'], required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    fileKey: { type: String },
    fileName: { type: String },
    rows: { type: Number },
    truncated: { type: Boolean, default: false },
    error: { type: String },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    finishedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);
reportExportSchema.index({ organizationId: 1, requestedBy: 1, createdAt: -1 });
reportExportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 86_400 });
reportExportSchema.plugin(tenantPlugin);

export type ReportExport = InferSchemaType<typeof reportExportSchema> & { _id: Types.ObjectId };
export const ReportExportModel = model('ReportExport', reportExportSchema);
