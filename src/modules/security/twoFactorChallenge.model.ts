import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { CLIENT_PLATFORMS } from '../auth/session.model.js';

/**
 * Pending sign-in after a correct password when a second factor (or enrollment) is required.
 * The client holds an opaque random token; only its keyed hash is stored. It is not a JWT, so it
 * can never authorize CRM APIs. Single use, 5 attempts, expires after 5 minutes.
 * Not tenant-guarded: looked up by token hash before the tenant is known.
 */
const challengeSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    purpose: { type: String, enum: ['verify', 'enroll'], required: true },
    platform: { type: String, enum: CLIENT_PLATFORMS, default: 'web' },
    deviceName: { type: String },
    rememberMe: { type: Boolean, default: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type TwoFactorChallenge = InferSchemaType<typeof challengeSchema> & { _id: Types.ObjectId };
export const TwoFactorChallengeModel = model('TwoFactorChallenge', challengeSchema);
