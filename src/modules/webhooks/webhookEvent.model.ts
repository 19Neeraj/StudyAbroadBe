import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/**
 * Every accepted webhook event (spec §44, §47): idempotency key, raw payload for debugging/audit
 * and processing status so failures can be retried.
 */
const webhookEventSchema = new Schema(
  {
    ...tenantField,
    kind: { type: String, required: true },
    provider: { type: String, required: true },
    eventKey: { type: String, required: true },
    status: { type: String, enum: ['received', 'processed', 'failed', 'ignored'], default: 'received' },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    payload: { type: Schema.Types.Mixed },
    processedAt: { type: Date },
  },
  { timestamps: true },
);
webhookEventSchema.index({ organizationId: 1, provider: 1, eventKey: 1 }, { unique: true });
webhookEventSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
webhookEventSchema.plugin(tenantPlugin);

export type WebhookEvent = InferSchemaType<typeof webhookEventSchema> & { _id: Types.ObjectId };
export const WebhookEventModel = model('WebhookEvent', webhookEventSchema);
