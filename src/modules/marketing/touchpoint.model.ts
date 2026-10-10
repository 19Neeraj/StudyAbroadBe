import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { attributionField } from './attributionNode.model.js';

export const TOUCH_ORIGINS = ['meta_lead_ad', 'google_ads', 'website_form', 'manual', 'import', 'event', 'whatsapp', 'api', 'merge'] as const;
export type TouchOrigin = (typeof TOUCH_ORIGINS)[number];
/** Raw tracking keys accepted from websites/providers (spec §6.1). */
export const RAW_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'landing_url', 'referrer', 'page_url', 'form_id'] as const;

/**
 * One recorded marketing interaction (spec §6.2, plan §2.6). Raw values are stored exactly as
 * received; `normalized` holds trimmed lower-case copies for matching. Nothing is invented: a key
 * that wasn't received is absent. `attribution` is the mapping valid at `occurredAt` (snapshot).
 */
const touchpointSchema = new Schema(
  {
    ...tenantField,
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student' },
    visitorId: { type: String },
    origin: { type: String, enum: TOUCH_ORIGINS, required: true },
    occurredAt: { type: Date, required: true },
    receivedAt: { type: Date, default: () => new Date() },
    raw: { type: Schema.Types.Mixed, default: {} },
    normalized: { type: Schema.Types.Mixed, default: {} },
    leadSource: { type: String },
    campaignName: { type: String },
    provider: { type: String },
    accountExternalId: { type: String },
    campaignExternalId: { type: String },
    adsetExternalId: { type: String },
    adExternalId: { type: String },
    leadFormExternalId: { type: String },
    ...attributionField,
    mappingId: { type: Schema.Types.ObjectId, ref: 'CampaignMapping' },
    /** Where the P/S/T snapshot came from: a campaign mapping, a person choosing it, or nothing known. */
    attributionMethod: { type: String, enum: ['mapping', 'manual', 'none'], default: 'none' },
    consent: { analytics: Boolean, ads: Boolean, method: String, capturedAt: Date },
    isDirect: { type: Boolean, default: false },
    /** e.g. "earlier_than_first_touch" when an older touch arrives after first touch was set. */
    flags: { type: [String], default: undefined },
  },
  { timestamps: true, minimize: false },
);
touchpointSchema.index({ organizationId: 1, leadId: 1, occurredAt: 1 });
touchpointSchema.index({ organizationId: 1, provider: 1, campaignExternalId: 1, occurredAt: 1 });
touchpointSchema.index({ organizationId: 1, 'normalized.utm_campaign': 1 });
touchpointSchema.index({ organizationId: 1, occurredAt: -1 });
// "Any inquiry" attribution filters look up lead IDs by hierarchy value.
touchpointSchema.index({ organizationId: 1, 'source.l1': 1, leadId: 1 });
touchpointSchema.index({ organizationId: 1, 'medium.l1': 1, leadId: 1 });
touchpointSchema.index({ organizationId: 1, 'campaign.l1': 1, leadId: 1 });
touchpointSchema.plugin(tenantPlugin);

export type AttributionTouchpoint = InferSchemaType<typeof touchpointSchema> & { _id: Types.ObjectId };
export const AttributionTouchpointModel = model('AttributionTouchpoint', touchpointSchema);
