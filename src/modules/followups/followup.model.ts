import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { LeadModel } from '../leads/lead.model.js';

export const FOLLOWUP_STATUSES = ['pending', 'completed', 'missed', 'cancelled', 'rescheduled'] as const;
export type FollowUpStatus = (typeof FOLLOWUP_STATUSES)[number];
/** Statuses that still need action. ("missed" is set by the overdue job in Phase 4.) */
export const OPEN_FOLLOWUP_STATUSES: FollowUpStatus[] = ['pending', 'missed'];

const followUpSchema = new Schema(
  {
    ...tenantField,
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    /** Copied from the lead so branch-scoped lists don't need a join. */
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** followUpDate + followUpTime as one instant (spec §15). */
    dueAt: { type: Date, required: true },
    /** Lookup key (type followup_type). */
    followUpType: { type: String, required: true },
    notes: { type: String, trim: true },
    nextAction: { type: String, trim: true },
    status: { type: String, enum: FOLLOWUP_STATUSES, default: 'pending', required: true },
    outcome: { type: String, trim: true },
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
    cancelReason: { type: String, trim: true },
    rescheduledFromId: { type: Schema.Types.ObjectId, ref: 'FollowUp' },
    rescheduledToId: { type: Schema.Types.ObjectId, ref: 'FollowUp' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

followUpSchema.index({ organizationId: 1, assignedTo: 1, status: 1, dueAt: 1 });
followUpSchema.index({ organizationId: 1, branchId: 1, status: 1, dueAt: 1 });
followUpSchema.index({ organizationId: 1, status: 1, dueAt: 1 });
followUpSchema.index({ organizationId: 1, leadId: 1, dueAt: -1 });
followUpSchema.index({ organizationId: 1, status: 1, completedAt: -1 });
followUpSchema.plugin(tenantPlugin);

export type FollowUp = InferSchemaType<typeof followUpSchema> & { _id: Types.ObjectId };
export const FollowUpModel = model('FollowUp', followUpSchema);

/** Keeps `lead.nextFollowUpAt` equal to the earliest open follow-up. */
export async function refreshNextFollowUp(organizationId: Types.ObjectId, leadId: Types.ObjectId): Promise<void> {
  const next = await FollowUpModel.findOne({ organizationId, leadId, status: { $in: OPEN_FOLLOWUP_STATUSES } })
    .sort({ dueAt: 1 })
    .select('dueAt')
    .lean();
  await LeadModel.updateOne({ organizationId, _id: leadId }, { nextFollowUpAt: next?.dueAt ?? null });
}
