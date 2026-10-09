import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

const userSchema = new Schema(
  {
    ...tenantField,
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true, default: '' },
    fullName: { type: String, trim: true },
    /** Normalized (lower-case). Globally unique: email is the login identifier. */
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** Normalized E.164. */
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    passwordChangedAt: { type: Date },
    passwordReset: {
      type: { tokenHash: String, expiresAt: Date },
      select: false,
      _id: false,
    },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    branchIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Branch' }], default: [] },
    managerId: { type: Schema.Types.ObjectId, ref: 'User' },
    designation: { type: String, trim: true },
    avatarUrl: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        delete ret.passwordReset;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.pre('validate', function () {
  this.fullName = [this.firstName, this.lastName].filter(Boolean).join(' ');
});

userSchema.index({ organizationId: 1, isActive: 1, fullName: 1 });
userSchema.index({ organizationId: 1, roleId: 1 });
userSchema.index({ organizationId: 1, branchIds: 1 });
userSchema.index({ organizationId: 1, managerId: 1 });
userSchema.plugin(tenantPlugin);

export type User = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const UserModel = model('User', userSchema);
