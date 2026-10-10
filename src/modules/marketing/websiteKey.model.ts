import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/**
 * API keys for website lead capture (spec §6.3). Only a SHA-256 hash is stored; the key is shown
 * once. Imports run as the admin who created the key. Server-to-server only: a key must never be
 * embedded in browser JavaScript (the website's backend forwards the form).
 */
const websiteKeySchema = new Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true },
    keyHash: { type: String, required: true, select: false },
    prefix: { type: String, required: true },
    leadSource: { type: String, default: 'website' },
    defaultBranchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    defaultCounsellorId: { type: Schema.Types.ObjectId, ref: 'User' },
    duplicatePolicy: { type: String, enum: ['keep_existing', 'mark_duplicate', 'create_separate'], default: 'keep_existing' },
    lastUsedAt: { type: Date },
    submissions: { type: Number, default: 0 },
    revokedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
websiteKeySchema.index({ keyHash: 1 }, { unique: true });
websiteKeySchema.index({ organizationId: 1, createdAt: -1 });
websiteKeySchema.plugin(tenantPlugin);

export type WebsiteKey = InferSchemaType<typeof websiteKeySchema> & { _id: Types.ObjectId };
export const WebsiteKeyModel = model('WebsiteKey', websiteKeySchema);
