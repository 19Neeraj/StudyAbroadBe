import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const EXTERNAL_LEAD_STATUSES = ['received', 'processing', 'created', 'merged', 'duplicate_flagged', 'skipped', 'failed'] as const;
export type ExternalLeadStatus = (typeof EXTERNAL_LEAD_STATUSES)[number];
export const DONE_STATUSES: ExternalLeadStatus[] = ['created', 'merged', 'duplicate_flagged', 'skipped'];

/**
 * Every lead a provider delivered (plan §2.8). Webhook and polling both upsert here first, so the
 * same provider lead is processed once. Failed rows stay visible and retryable — nothing is dropped.
 */
const externalLeadSchema = new Schema(
  {
    ...tenantField,
    provider: { type: String, required: true },
    externalLeadId: { type: String, required: true },
    formExternalId: { type: String },
    adExternalId: { type: String },
    adsetExternalId: { type: String },
    campaignExternalId: { type: String },
    pageExternalId: { type: String },
    submittedAt: { type: Date },
    status: { type: String, enum: EXTERNAL_LEAD_STATUSES, default: 'received' },
    /** Claim lock so a webhook and a poll arriving together can't both create the lead. */
    lockedUntil: { type: Date },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    receivedVia: { type: String, enum: ['webhook', 'poll', 'api', 'retry'] },
    /** Form answers as received (personal data: removed by retention after 180 days). */
    answers: { type: Schema.Types.Mixed },
    processedAt: { type: Date },
  },
  { timestamps: true },
);
externalLeadSchema.index({ organizationId: 1, provider: 1, externalLeadId: 1 }, { unique: true });
externalLeadSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
externalLeadSchema.index({ organizationId: 1, campaignExternalId: 1 });
externalLeadSchema.plugin(tenantPlugin);

export type ExternalLeadReference = InferSchemaType<typeof externalLeadSchema> & { _id: Types.ObjectId };
export const ExternalLeadReferenceModel = model('ExternalLeadReference', externalLeadSchema);
