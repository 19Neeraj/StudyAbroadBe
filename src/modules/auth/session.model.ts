import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const CLIENT_PLATFORMS = ['web', 'android', 'ios', 'other'] as const;

/**
 * One document per signed-in device. The refresh token rotates on every use; the last few
 * hashes are kept so that replay of an old token (theft) can be detected and the session killed.
 * Not tenant-guarded: sessions are looked up by token hash before the tenant is known.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    previousTokenHashes: { type: [String], default: [], index: true },
    platform: { type: String, enum: CLIENT_PLATFORMS, default: 'web' },
    deviceName: { type: String, trim: true },
    ipAddress: { type: String },
    userAgent: { type: String },
    lastUsedAt: { type: Date, default: () => new Date() },
    // Mobile device registration (spec §36–37). Set by POST /devices/register after sign-in.
    deviceId: { type: String, trim: true },
    appVersion: { type: String, trim: true },
    osVersion: { type: String, trim: true },
    /** FCM registration token for push notifications. */
    pushToken: { type: String },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String },
  },
  { timestamps: true },
);

// MongoDB removes sessions automatically once they expire.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ organizationId: 1, revokedAt: 1, lastUsedAt: -1 });
sessionSchema.index({ pushToken: 1 }, { sparse: true });

export type Session = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };
export const SessionModel = model('Session', sessionSchema);
