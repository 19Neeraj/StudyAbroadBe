import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

const segmentSchema = new Schema(
  { speaker: String, startTime: Number, endTime: Number, text: String },
  { _id: false },
);

/** Speech-to-text of a recorded call or voice message (spec §16–17, §51). Never overwritten by AI output. */
const transcriptSchema = new Schema(
  {
    ...tenantField,
    callId: { type: Schema.Types.ObjectId, ref: 'Call' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    counsellorId: { type: Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    provider: { type: String, required: true },
    language: { type: String },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    segments: { type: [segmentSchema], default: [] },
    fullText: { type: String, default: '' },
    duration: { type: Number },
    error: { type: String },
  },
  { timestamps: true },
);
transcriptSchema.index({ organizationId: 1, callId: 1 }, { unique: true, partialFilterExpression: { callId: { $exists: true } } });
// Transcript Center search (spec §40): tenant-prefixed text index, so every search is org-bounded.
// language_override points at an unused field: our `language` holds BCP-47 codes (en-IN) Mongo doesn't accept.
transcriptSchema.index({ organizationId: 1, fullText: 'text' }, { default_language: 'none', language_override: 'textSearchLanguage' });
transcriptSchema.plugin(tenantPlugin);

export type Transcript = InferSchemaType<typeof transcriptSchema> & { _id: Types.ObjectId };
export const TranscriptModel = model('Transcript', transcriptSchema);
