import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const CAMPAIGN_LEVELS = ['campaign', 'adset', 'ad', 'lead_form'] as const;
export type CampaignLevel = (typeof CAMPAIGN_LEVELS)[number];

/**
 * External advertising hierarchy, one document per entity (plan §2.3). Upserted by provider ID,
 * so repeated syncs never duplicate; renames are kept in `nameHistory` to explain old reports.
 */
const marketingCampaignSchema = new Schema(
  {
    ...tenantField,
    provider: { type: String, required: true },
    accountExternalId: { type: String, required: true },
    level: { type: String, enum: CAMPAIGN_LEVELS, required: true },
    externalId: { type: String, required: true },
    parentExternalId: { type: String },
    campaignExternalId: { type: String },
    name: { type: String, trim: true },
    nameHistory: { type: [{ name: String, seenAt: Date, _id: false }], default: [] },
    status: { type: String },
    effectiveStatus: { type: String },
    objective: { type: String },
    startAt: { type: Date },
    endAt: { type: Date },
    budget: { dailyMinor: Number, lifetimeMinor: Number, currency: String },
    /** Only what the provider actually returned. */
    destinationUrl: { type: String },
    urlTags: { type: String },
    firstSeenAt: { type: Date },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);
marketingCampaignSchema.index({ organizationId: 1, provider: 1, level: 1, externalId: 1 }, { unique: true });
marketingCampaignSchema.index({ organizationId: 1, provider: 1, accountExternalId: 1, level: 1 });
marketingCampaignSchema.index({ organizationId: 1, campaignExternalId: 1 });
marketingCampaignSchema.plugin(tenantPlugin);

export type MarketingCampaign = InferSchemaType<typeof marketingCampaignSchema> & { _id: Types.ObjectId };
export const MarketingCampaignModel = model('MarketingCampaign', marketingCampaignSchema);
