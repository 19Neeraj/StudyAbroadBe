import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { attributionField } from './attributionNode.model.js';

/**
 * External campaign identifiers → internal Primary/Secondary/Tertiary values (spec §8, plan §2.7).
 * Matched by ID, most specific first (ad → ad set → campaign); provider "utm" maps a utm_campaign
 * value. A change closes the old row (`effectiveTo`) and opens a new one, so history explains old reports.
 */
const mappingSchema = new Schema(
  {
    ...tenantField,
    provider: { type: String, required: true },
    accountExternalId: { type: String },
    campaignExternalId: { type: String, required: true },
    adsetExternalId: { type: String, default: null },
    adExternalId: { type: String, default: null },
    /** External name when the mapping was made (display only; never used for matching). */
    externalName: { type: String },
    ...attributionField,
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    status: { type: String, enum: ['active', 'superseded'], default: 'active' },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
mappingSchema.index({ organizationId: 1, provider: 1, campaignExternalId: 1, adsetExternalId: 1, adExternalId: 1, effectiveFrom: -1 });
mappingSchema.index({ organizationId: 1, status: 1 });
mappingSchema.plugin(tenantPlugin);

export type CampaignMapping = InferSchemaType<typeof mappingSchema> & { _id: Types.ObjectId };
export const CampaignMappingModel = model('CampaignMapping', mappingSchema);
