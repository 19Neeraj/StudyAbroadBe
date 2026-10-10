import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** CRM lead fields an external form answer can map to. */
export const MAPPABLE_FIELDS = [
  'fullName', 'firstName', 'lastName', 'phone', 'whatsappNumber', 'email', 'city', 'state', 'country',
  'countryInterested', 'courseInterested', 'degreeLevel', 'intake', 'budget', 'educationDetails', 'notes',
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** External form field → CRM field (plan §2.10). `formExternalId: null` is the provider default. */
const fieldMappingSchema = new Schema(
  {
    ...tenantField,
    provider: { type: String, required: true },
    formExternalId: { type: String, default: null },
    rules: { type: [{ externalField: { type: String, required: true }, crmField: { type: String, enum: MAPPABLE_FIELDS, required: true }, _id: false }], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
fieldMappingSchema.index({ organizationId: 1, provider: 1, formExternalId: 1 }, { unique: true });
fieldMappingSchema.plugin(tenantPlugin);

export type IntegrationFieldMapping = InferSchemaType<typeof fieldMappingSchema> & { _id: Types.ObjectId };
export const IntegrationFieldMappingModel = model('IntegrationFieldMapping', fieldMappingSchema);
