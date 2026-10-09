import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { LOOKUP_TYPES } from '../../constants/lookups.js';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Configurable master data: countries, courses, intakes, sources, stages, statuses, … */
const lookupSchema = new Schema(
  {
    ...tenantField,
    type: { type: String, enum: LOOKUP_TYPES, required: true },
    /** Stable identifier stored on records. Immutable so history stays readable. */
    key: { type: String, required: true, trim: true, immutable: true },
    label: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    color: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
    meta: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false },
);

lookupSchema.index({ organizationId: 1, type: 1, key: 1 }, { unique: true });
lookupSchema.index({ organizationId: 1, type: 1, isActive: 1, order: 1 });
lookupSchema.plugin(tenantPlugin);

export type Lookup = InferSchemaType<typeof lookupSchema> & { _id: Types.ObjectId };
export const LookupModel = model('Lookup', lookupSchema);
