import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { CAMPAIGN_LEVELS } from './marketingCampaign.model.js';

export const METRIC_LEVELS = ['account', ...CAMPAIGN_LEVELS.filter((l) => l !== 'lead_form')] as const;
export type MetricLevel = (typeof METRIC_LEVELS)[number];
export const METRIC_FIELDS = ['spendMinor', 'impressions', 'reach', 'clicks', 'linkClicks', 'ctr', 'linkCtr', 'cpcMinor', 'costPerLinkClickMinor', 'cpmMinor', 'providerLeads'] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

/**
 * One row per entity per day in the ad account's timezone (plan §2.4). A re-sync REPLACES the row,
 * so corrections never double-count. A metric the provider didn't return is null and listed in
 * `unavailable` — never stored as 0. Money is integer minor units of `currency`.
 */
const metricSchema = new Schema(
  {
    ...tenantField,
    provider: { type: String, required: true },
    accountExternalId: { type: String, required: true },
    level: { type: String, enum: METRIC_LEVELS, required: true },
    externalId: { type: String, required: true },
    campaignExternalId: { type: String },
    /** YYYY-MM-DD in the account timezone. */
    date: { type: String, required: true },
    currency: { type: String, uppercase: true },
    spendMinor: { type: Number, default: null },
    impressions: { type: Number, default: null },
    reach: { type: Number, default: null },
    clicks: { type: Number, default: null },
    linkClicks: { type: Number, default: null },
    ctr: { type: Number, default: null },
    linkCtr: { type: Number, default: null },
    cpcMinor: { type: Number, default: null },
    costPerLinkClickMinor: { type: Number, default: null },
    cpmMinor: { type: Number, default: null },
    providerLeads: { type: Number, default: null },
    actions: { type: [{ type: { type: String }, value: Number, _id: false }], default: undefined },
    unavailable: { type: [String], default: [] },
    fetchedAt: { type: Date },
    revision: { type: Number, default: 1 },
  },
  { timestamps: true },
);
metricSchema.index({ organizationId: 1, provider: 1, level: 1, externalId: 1, date: 1 }, { unique: true });
metricSchema.index({ organizationId: 1, level: 1, date: 1 });
metricSchema.index({ organizationId: 1, campaignExternalId: 1, date: 1 });
metricSchema.plugin(tenantPlugin);

export type MarketingDailyMetric = InferSchemaType<typeof metricSchema> & { _id: Types.ObjectId };
export const MarketingDailyMetricModel = model('MarketingDailyMetric', metricSchema);
