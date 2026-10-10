import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Platform-wide settings managed by Super Admins (single document, _id "security").
 * Not tenant-owned: it applies to every organization.
 */
const platformSettingSchema = new Schema(
  {
    _id: { type: String, required: true },
    twoFactor: {
      /** Off: nobody can enroll and nobody is required to (already enrolled users keep verifying). */
      enabled: { type: Boolean, default: true },
      mode: { type: String, enum: ['optional', 'mandatory'], default: 'optional' },
      /** May organization admins require 2FA for their own organization? (They can never relax the platform.) */
      allowOrganizationOverride: { type: Boolean, default: true },
      /** Days a user may keep signing in without 2FA after it becomes mandatory for them. */
      gracePeriodDays: { type: Number, default: 7, min: 0, max: 90 },
      mandatorySince: { type: Date },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

export type PlatformSetting = InferSchemaType<typeof platformSettingSchema>;
export const PlatformSettingModel = model('PlatformSetting', platformSettingSchema);
