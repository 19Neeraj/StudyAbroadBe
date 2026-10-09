import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const CALL_STATUSES = ['initiated', 'ringing', 'answered', 'completed', 'missed', 'rejected', 'failed', 'busy', 'no_answer'] as const;
export const CALL_DIRECTIONS = ['outgoing', 'incoming'] as const;
export const CALL_SOURCES = ['click_to_call', 'device', 'manual_log', 'webhook'] as const;
/** Final statuses: the call is over. */
export const TERMINAL_CALL_STATUSES = ['completed', 'missed', 'rejected', 'failed', 'busy', 'no_answer'] as const;
export const CONSENT_STATUSES = ['not_required', 'announced', 'granted', 'denied', 'unknown'] as const;

/**
 * One phone call (spec §11). The lead timeline gets a summarizing activity; this record holds the
 * telephony detail, outcome and links to recording / transcript / AI summary.
 */
const callSchema = new Schema(
  {
    ...tenantField,
    provider: { type: String, required: true },
    providerCallId: { type: String },
    source: { type: String, enum: CALL_SOURCES, required: true },

    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student' },
    applicationId: { type: Schema.Types.ObjectId },
    /** Counsellor on the call (scope: own). */
    counsellorId: { type: Schema.Types.ObjectId, ref: 'User' },
    /** Copied from the lead for branch-scoped lists. */
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },

    /** Snapshot of the lead's attribution at call time: reports by source/campaign/country/course need no join. */
    leadSource: { type: String },
    campaign: { type: String },
    countryInterested: { type: String },
    courseInterested: { type: String },

    direction: { type: String, enum: CALL_DIRECTIONS, required: true },
    status: { type: String, enum: CALL_STATUSES, required: true },
    phoneNumber: { type: String, required: true },

    startedAt: { type: Date, required: true },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    /** Talk time in seconds (0 when not connected). */
    duration: { type: Number, default: 0, min: 0 },

    recordingConsent: {
      status: { type: String, enum: CONSENT_STATUSES, default: 'unknown' },
      at: { type: Date },
      method: { type: String },
    },
    /** Provider recording URL as received; never exposed — the stored copy is served via signed URLs. */
    providerRecordingUrl: { type: String, select: false },
    recordingId: { type: Schema.Types.ObjectId, ref: 'CallRecording' },
    transcriptId: { type: Schema.Types.ObjectId, ref: 'Transcript' },
    summaryId: { type: Schema.Types.ObjectId, ref: 'AiSummary' },

    /** Lookup key (type call_outcome). */
    callOutcome: { type: String },
    outcomeNotes: { type: String, trim: true },
    nextAction: { type: String, trim: true },
    followUpId: { type: Schema.Types.ObjectId, ref: 'FollowUp' },
    activityId: { type: Schema.Types.ObjectId, ref: 'Activity' },
    /** Set once the timeline/contact side effects have run (idempotent finalization). */
    finalizedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

callSchema.index({ organizationId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, leadId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, counsellorId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, branchId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, status: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, callOutcome: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, leadSource: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, campaign: 1, startedAt: -1 });
callSchema.index(
  { organizationId: 1, provider: 1, providerCallId: 1 },
  { unique: true, partialFilterExpression: { providerCallId: { $type: 'string', $gt: '' } } },
);
callSchema.plugin(tenantPlugin);

export type Call = InferSchemaType<typeof callSchema> & { _id: Types.ObjectId };
export const CallModel = model('Call', callSchema);
