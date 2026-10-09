import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/**
 * AI-generated call summary (spec §18–19, §52). Always labelled AI-generated in clients; authorized
 * users may edit it (edits are kept separately in `edited*` so the original model output survives).
 * Sentiment/intent are analytics signals only — never used for automatic decisions.
 */
const aiSummarySchema = new Schema(
  {
    ...tenantField,
    callId: { type: Schema.Types.ObjectId, ref: 'Call' },
    transcriptId: { type: Schema.Types.ObjectId, ref: 'Transcript' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    summary: { type: String },
    studentRequirements: { type: String },
    countryPreference: { type: String },
    coursePreference: { type: String },
    budget: { type: String },
    intake: { type: String },
    concerns: { type: [String], default: [] },
    objections: { type: [String], default: [] },
    nextAction: { type: String },
    recommendedFollowUp: { type: String },
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative', null] },
    intent: { type: [String], default: [] },
    model: { type: String },
    generatedAt: { type: Date, default: () => new Date() },
    editedSummary: { type: String },
    editedNextAction: { type: String },
    editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    editedAt: { type: Date },
  },
  { timestamps: true },
);
aiSummarySchema.index({ organizationId: 1, callId: 1 }, { unique: true, partialFilterExpression: { callId: { $exists: true } } });
aiSummarySchema.index({ organizationId: 1, generatedAt: -1 });
aiSummarySchema.plugin(tenantPlugin);

export type AiSummary = InferSchemaType<typeof aiSummarySchema> & { _id: Types.ObjectId };
export const AiSummaryModel = model('AiSummary', aiSummarySchema);
