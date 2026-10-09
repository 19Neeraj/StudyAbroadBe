import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { ACTIVITY_TYPES } from '../../constants/activities.js';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/**
 * Timeline entries for a lead (and, from Phase 2, its student record).
 * Unlike the audit log this is product data shown to users: who, what, before → after, when.
 */
const activitySchema = new Schema(
  {
    ...tenantField,
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student' },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    /** Short human summary, e.g. "Stage changed". */
    title: { type: String, required: true },
    notes: { type: String },
    /** e.g. call outcome: "Interested, wants UK options". */
    outcome: { type: String },
    previousValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
    /** When the interaction happened (defaults to now; may be back-dated for logged calls). */
    occurredAt: { type: Date, default: () => new Date() },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

activitySchema.index({ organizationId: 1, leadId: 1, occurredAt: -1 });
activitySchema.index({ organizationId: 1, userId: 1, occurredAt: -1 });
activitySchema.index({ organizationId: 1, type: 1, occurredAt: -1 });
activitySchema.plugin(tenantPlugin);

export type Activity = InferSchemaType<typeof activitySchema> & { _id: Types.ObjectId };
export const ActivityModel = model('Activity', activitySchema);
