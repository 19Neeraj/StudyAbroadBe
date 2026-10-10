import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const ACCOUNT_TYPES = ['business', 'ad_account', 'page', 'lead_form'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Ad accounts, pages and lead forms a connection can see (Integrations plan §2.2). The admin
 * chooses which ones are synced (`selected`). Page IDs also route provider webhooks.
 */
const integrationAccountSchema = new Schema(
  {
    ...tenantField,
    integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', required: true },
    provider: { type: String, required: true },
    type: { type: String, enum: ACCOUNT_TYPES, required: true },
    externalId: { type: String, required: true },
    name: { type: String, trim: true },
    parentExternalId: { type: String },
    currency: { type: String, uppercase: true },
    timezone: { type: String },
    status: { type: String },
    selected: { type: Boolean, default: false },
    /** Sync cursors, e.g. { leadCursor } for lead forms. */
    cursor: { type: Schema.Types.Mixed, default: {} },
    lastSeenAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);
integrationAccountSchema.index({ organizationId: 1, provider: 1, type: 1, externalId: 1 }, { unique: true });
integrationAccountSchema.index({ provider: 1, type: 1, externalId: 1 });
integrationAccountSchema.plugin(tenantPlugin);

export type IntegrationAccount = InferSchemaType<typeof integrationAccountSchema> & { _id: Types.ObjectId };
export const IntegrationAccountModel = model('IntegrationAccount', integrationAccountSchema);
