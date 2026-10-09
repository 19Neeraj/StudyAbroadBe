import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Stored copy of a call recording (spec §14, §50). Audio lives in object storage; access via signed URLs only. */
const recordingSchema = new Schema(
  {
    ...tenantField,
    callId: { type: Schema.Types.ObjectId, ref: 'Call', required: true },
    provider: { type: String, required: true },
    externalRecordingId: { type: String },
    fileKey: { type: String },
    mimeType: { type: String },
    fileSize: { type: Number },
    duration: { type: Number },
    consentStatus: { type: String },
    status: { type: String, enum: ['pending', 'stored', 'failed', 'deleted'], default: 'pending' },
    error: { type: String },
    retentionUntil: { type: Date, required: true },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
recordingSchema.index({ organizationId: 1, callId: 1 }, { unique: true });
recordingSchema.index({ organizationId: 1, status: 1, retentionUntil: 1 });
// Retention sweep runs across organizations.
recordingSchema.index({ status: 1, retentionUntil: 1 });
recordingSchema.plugin(tenantPlugin);

export type CallRecording = InferSchemaType<typeof recordingSchema> & { _id: Types.ObjectId };
export const CallRecordingModel = model('CallRecording', recordingSchema);
