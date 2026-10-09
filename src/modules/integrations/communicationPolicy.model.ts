import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const CONSENT_MODES = ['none', 'announcement', 'explicit'] as const;

/**
 * Per-organization privacy & processing policy for communications (spec §14–17, §30–31, §56).
 * Defaults are conservative: recording, transcription and AI are off until an admin enables them.
 */
const policySchema = new Schema(
  {
    ...tenantField,
    recordingEnabled: { type: Boolean, default: false },
    /** none: no recording disclosure needed; announcement: provider plays a message; explicit: caller must agree. */
    consentMode: { type: String, enum: CONSENT_MODES, default: 'announcement' },
    consentMessage: { type: String, default: 'Calls may be recorded for quality and training purposes.' },
    retentionDays: { type: Number, default: 90, min: 1, max: 3650 },
    keepTranscriptAfterRecordingDeleted: { type: Boolean, default: true },
    transcriptionEnabled: { type: Boolean, default: false },
    /** BCP-47-ish codes; "auto" lets the provider detect (Hinglish etc.). */
    transcriptionLanguages: { type: [String], default: ['en-IN', 'hi-IN'] },
    aiSummaryEnabled: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
policySchema.index({ organizationId: 1 }, { unique: true });
policySchema.plugin(tenantPlugin);

export type CommunicationPolicy = InferSchemaType<typeof policySchema> & { _id: Types.ObjectId };
export const CommunicationPolicyModel = model('CommunicationPolicy', policySchema);

export async function getCommunicationPolicy(organizationId: Types.ObjectId) {
  const found = await CommunicationPolicyModel.findOne({ organizationId }).lean();
  if (found) return found;
  return (await CommunicationPolicyModel.findOneAndUpdate({ organizationId }, { $setOnInsert: { organizationId } }, { upsert: true, returnDocument: 'after' }).lean())!;
}
