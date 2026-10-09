import type { Types } from 'mongoose';
import { DEFAULT_MILESTONE_STAGES, STAGE_MILESTONES, type StageMilestone } from '../../constants/lookups.js';
import type { ServiceContext } from '../../types/auth.js';
import { logActivity } from '../activities/activity.service.js';
import { listLookups } from '../settings/lookup.service.js';
import { emitLeadEvent } from './lead.events.js';
import { LeadModel } from './lead.model.js';

/** Stage key that represents each milestone (stage meta.milestone, else the default key). */
export async function milestoneStages(ctx: Pick<ServiceContext, 'organizationId'>) {
  const stages = await listLookups(ctx as ServiceContext, 'lead_stage', false);
  const keys = stages.map((s) => s.key);
  const byMilestone = new Map<StageMilestone, string>();
  for (const m of STAGE_MILESTONES) {
    const marked = stages.find((s) => (s.meta as { milestone?: string } | undefined)?.milestone === m);
    const key = marked?.key ?? (keys.includes(DEFAULT_MILESTONE_STAGES[m]) ? DEFAULT_MILESTONE_STAGES[m] : undefined);
    if (key) byMilestone.set(m, key);
  }
  return { keys, byMilestone };
}

/**
 * Moves a lead forward to the stage of a business milestone (application created, offer received,
 * visa approved, enrolled…). Never moves a lead backwards. Logs an automatic stage change.
 */
export async function advanceLeadToMilestone(ctx: Pick<ServiceContext, 'organizationId' | 'userId'>, leadId: Types.ObjectId, milestone: StageMilestone, reason: string): Promise<boolean> {
  const { keys, byMilestone } = await milestoneStages(ctx);
  const target = byMilestone.get(milestone);
  if (!target) return false;
  const lead = await LeadModel.findOne({ organizationId: ctx.organizationId, _id: leadId, deletedAt: null }).select('leadStage organizationId assignedCounsellor assignedManager');
  if (!lead) return false;
  if (keys.indexOf(lead.leadStage) >= keys.indexOf(target)) return false;
  const previous = lead.leadStage;
  await LeadModel.updateOne({ organizationId: ctx.organizationId, _id: leadId }, { leadStage: target, stageChangedAt: new Date(), updatedBy: ctx.userId });
  await logActivity(ctx, { leadId, type: 'stage_changed', title: 'Stage changed automatically', previousValue: previous, newValue: target, notes: reason, metadata: { automatic: true, milestone } });
  emitLeadEvent('lead.stageChanged', lead, { stage: target });
  return true;
}
