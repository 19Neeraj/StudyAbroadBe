import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const SYNC_TYPES = ['accounts', 'campaigns', 'metrics', 'leads'] as const;
export type SyncType = (typeof SYNC_TYPES)[number];
export const SYNC_TRIGGERS = ['schedule', 'manual', 'webhook', 'retry', 'connect'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/** One row per sync run (plan §2.9). Errors are stored redacted. Kept 180 days. */
const syncLogSchema = new Schema(
  {
    ...tenantField,
    integrationId: { type: Schema.Types.ObjectId, ref: 'Integration' },
    provider: { type: String, required: true },
    syncType: { type: String, enum: SYNC_TYPES, required: true },
    trigger: { type: String, enum: SYNC_TRIGGERS, required: true },
    triggeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    durationMs: { type: Number },
    result: { type: String, enum: ['running', 'success', 'partial', 'failed'], default: 'running' },
    counts: { imported: { type: Number, default: 0 }, updated: { type: Number, default: 0 }, skipped: { type: Number, default: 0 }, failed: { type: Number, default: 0 } },
    window: { from: String, to: String },
    error: { type: String },
  },
  { timestamps: false },
);
syncLogSchema.index({ organizationId: 1, startedAt: -1 });
syncLogSchema.index({ organizationId: 1, provider: 1, syncType: 1, startedAt: -1 });
syncLogSchema.index({ startedAt: 1 }, { expireAfterSeconds: 180 * 86_400 });
syncLogSchema.plugin(tenantPlugin);

export type IntegrationSyncLog = InferSchemaType<typeof syncLogSchema> & { _id: Types.ObjectId };
export const IntegrationSyncLogModel = model('IntegrationSyncLog', syncLogSchema);
