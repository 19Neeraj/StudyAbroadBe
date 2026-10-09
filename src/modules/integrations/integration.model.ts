import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const INTEGRATION_KINDS = ['calling', 'whatsapp', 'email', 'transcription', 'ai'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export const INTEGRATION_STATUSES = ['connected', 'disconnected', 'error', 'requires_reauthorization'] as const;

/**
 * One provider connection per organization and kind (spec: Integration Hub). Non-secret settings
 * live in `config`; credentials are AES-GCM encrypted in `secrets` and never leave the API.
 * `webhookToken` identifies the organization in provider callback URLs.
 */
const integrationSchema = new Schema(
  {
    ...tenantField,
    kind: { type: String, enum: INTEGRATION_KINDS, required: true },
    provider: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    status: { type: String, enum: INTEGRATION_STATUSES, default: 'connected' },
    config: { type: Schema.Types.Mixed, default: {} },
    secrets: { type: String, select: false },
    webhookToken: { type: String, required: true, select: false },
    lastEventAt: { type: Date },
    lastError: { type: String },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false },
);
integrationSchema.index({ organizationId: 1, kind: 1 }, { unique: true });
// Webhook lookups arrive without an organization (that's what the token resolves).
integrationSchema.index({ webhookToken: 1 }, { unique: true });
integrationSchema.plugin(tenantPlugin);

export type Integration = InferSchemaType<typeof integrationSchema> & { _id: Types.ObjectId };
export const IntegrationModel = model('Integration', integrationSchema);
