import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Asynchronous report export (plan §2.11). The file lives in private storage; links are signed. Kept 7 days. */
const reportJobSchema = new Schema(
  {
    ...tenantField,
    report: { type: String, required: true },
    format: { type: String, enum: ['csv', 'xlsx'], required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    fileKey: { type: String },
    fileName: { type: String },
    rows: { type: Number },
    error: { type: String },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    finishedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);
reportJobSchema.index({ organizationId: 1, requestedBy: 1, createdAt: -1 });
reportJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 86_400 });
reportJobSchema.plugin(tenantPlugin);

export type MarketingReportJob = InferSchemaType<typeof reportJobSchema> & { _id: Types.ObjectId };
export const MarketingReportJobModel = model('MarketingReportJob', reportJobSchema);
