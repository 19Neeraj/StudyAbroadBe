import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { DATA_SCOPES } from '../../constants/roles.js';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

const roleSchema = new Schema(
  {
    ...tenantField,
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    permissions: { type: [String], default: [] },
    dataScope: { type: String, enum: DATA_SCOPES, default: 'own', required: true },
    /** Seeded roles: can be edited but not deleted. */
    isSystem: { type: Boolean, default: false },
    /** Only on the platform organization's super_admin role. */
    isSuperAdmin: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

roleSchema.index({ organizationId: 1, key: 1 }, { unique: true });
roleSchema.index({ organizationId: 1, name: 1 }, { unique: true });
roleSchema.plugin(tenantPlugin);

export type Role = InferSchemaType<typeof roleSchema> & { _id: Types.ObjectId };
export const RoleModel = model('Role', roleSchema);
