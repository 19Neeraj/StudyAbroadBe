import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

const branchSchema = new Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

branchSchema.index({ organizationId: 1, code: 1 }, { unique: true });
branchSchema.index({ organizationId: 1, name: 1 }, { unique: true });
branchSchema.plugin(tenantPlugin);

export type Branch = InferSchemaType<typeof branchSchema> & { _id: Types.ObjectId };
export const BranchModel = model('Branch', branchSchema);
