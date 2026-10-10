import { leadAssigned as notifyAssigned, leadsBulkAssigned as notifyBulkAssigned } from '../notifications/triggers.js';
import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { hasOrgScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { logActivities, type ActivityInput } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { FollowUpModel, OPEN_FOLLOWUP_STATUSES } from '../followups/followup.model.js';
import { syncStudentOwnership } from '../students/student.service.js';
import { UserModel } from '../users/user.model.js';
import { loadLead, scopedLeadFilter } from './lead.access.js';
import { emitLeadEvent } from './lead.events.js';
import { LeadModel } from './lead.model.js';
import type { assignBody, bulkAssignBody } from './lead.validation.js';

export interface Assignee {
  _id: Types.ObjectId;
  fullName: string;
}

/**
 * An assignee must be an active user of the organization. Users without organization-wide scope
 * can only assign to people in their own branches (or themselves).
 */
export async function resolveAssignee(ctx: ServiceContext, userId: string, field: string): Promise<Assignee> {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, _id: userId, isActive: true };
  if (!hasOrgScope(ctx) && !ctx.userId.equals(userId)) filter.branchIds = { $in: ctx.branchIds };
  const user = await UserModel.findOne(filter).select('fullName').lean();
  if (!user) throw ApiError.validation([{ field: `body.${field}`, message: 'User not found or not assignable by you' }]);
  return { _id: user._id, fullName: user.fullName ?? '' };
}

/**
 * Assignment strategy hook (spec §14). Today: manual, or the creator when they work on own records.
 * Round-robin / load / branch / source / country / campaign strategies plug in here in Phase 4.
 */
export function defaultAssignee(ctx: ServiceContext): Types.ObjectId | undefined {
  return ctx.dataScope === 'own' && !ctx.isSuperAdmin ? ctx.userId : undefined;
}

type AssignChange = { counsellor?: Assignee | null; manager?: Assignee | null };

async function resolveChange(ctx: ServiceContext, input: { counsellorId?: string | null; managerId?: string | null }) {
  const change: AssignChange = {};
  if (input.counsellorId !== undefined) {
    change.counsellor = input.counsellorId ? await resolveAssignee(ctx, input.counsellorId, 'counsellorId') : null;
  }
  if (input.managerId !== undefined) {
    change.manager = input.managerId ? await resolveAssignee(ctx, input.managerId, 'managerId') : null;
  }
  return change;
}

async function names(organizationId: Types.ObjectId, ids: (Types.ObjectId | null | undefined)[]) {
  const wanted = ids.filter((i): i is Types.ObjectId => !!i);
  if (!wanted.length) return new Map<string, string>();
  const users = await UserModel.find({ organizationId, _id: { $in: wanted } }).select('fullName').lean();
  return new Map(users.map((u) => [u._id.toString(), u.fullName ?? '']));
}

function assignmentActivities(
  lead: { _id: Types.ObjectId; assignedCounsellor?: Types.ObjectId | null; assignedManager?: Types.ObjectId | null },
  change: AssignChange,
  nameOf: Map<string, string>,
  note?: string,
): ActivityInput[] {
  const out: ActivityInput[] = [];
  const entries = [
    ['counsellor', lead.assignedCounsellor, change.counsellor],
    ['manager', lead.assignedManager, change.manager],
  ] as const;
  for (const [role, before, after] of entries) {
    if (after === undefined) continue;
    const beforeId = before?.toString() ?? null;
    const afterId = after?._id.toString() ?? null;
    if (beforeId === afterId) continue;
    out.push({
      leadId: lead._id,
      type: beforeId ? 'lead_reassigned' : 'lead_assigned',
      title: `${role === 'counsellor' ? 'Counsellor' : 'Manager'} ${after ? (beforeId ? 'reassigned' : 'assigned') : 'unassigned'}`,
      previousValue: beforeId ? { id: beforeId, name: nameOf.get(beforeId) ?? null } : null,
      newValue: after ? { id: afterId, name: after.fullName } : null,
      metadata: { role },
      notes: note,
    });
  }
  return out;
}

/** Pending follow-ups move with the lead to its new counsellor. */
async function moveOpenFollowUps(ctx: ServiceContext, leadIds: Types.ObjectId[], counsellor: Assignee | null | undefined) {
  if (!counsellor) return;
  await FollowUpModel.updateMany(
    { organizationId: ctx.organizationId, leadId: { $in: leadIds }, status: { $in: OPEN_FOLLOWUP_STATUSES } },
    { assignedTo: counsellor._id },
  );
}

function toUpdate(change: AssignChange, actor: Types.ObjectId) {
  const set: Record<string, unknown> = { updatedBy: actor, assignedAt: new Date() };
  if (change.counsellor !== undefined) set.assignedCounsellor = change.counsellor?._id ?? null;
  if (change.manager !== undefined) set.assignedManager = change.manager?._id ?? null;
  return set;
}

export async function assignLead(ctx: ServiceContext, id: string, input: z.infer<typeof assignBody>) {
  const lead = await loadLead(ctx, id);
  const change = await resolveChange(ctx, input);
  const nameOf = await names(ctx.organizationId, [lead.assignedCounsellor, lead.assignedManager]);
  const activities = assignmentActivities(lead, change, nameOf, input.note);
  if (!activities.length) return lead._id;

  await LeadModel.updateOne({ organizationId: ctx.organizationId, _id: lead._id }, toUpdate(change, ctx.userId));
  await syncStudentOwnership(ctx.organizationId, [lead._id], toUpdate(change, ctx.userId));
  await moveOpenFollowUps(ctx, [lead._id], change.counsellor);
  await logActivities(ctx, activities);

  const after = await LeadModel.findOne({ organizationId: ctx.organizationId, _id: lead._id })
    .select('organizationId assignedCounsellor assignedManager leadNumber fullName')
    .lean();
  if (after) {
    emitLeadEvent('lead.assigned', after, { leadNumber: after.leadNumber, fullName: after.fullName });
    await notifyAssigned(ctx.organizationId, after, { counsellor: change.counsellor?._id, manager: change.manager?._id }, ctx.userId);
  }
  return lead._id;
}

export async function bulkAssignLeads(ctx: ServiceContext, input: z.infer<typeof bulkAssignBody>) {
  const change = await resolveChange(ctx, input);
  const ids = [...new Set(input.leadIds)].map((i) => new Types.ObjectId(i));
  const leads = await LeadModel.find(scopedLeadFilter(ctx, { _id: { $in: ids } }))
    .select('organizationId assignedCounsellor assignedManager')
    .lean();
  const nameOf = await names(
    ctx.organizationId,
    leads.flatMap((l) => [l.assignedCounsellor, l.assignedManager]),
  );
  const activities = leads.flatMap((l) => assignmentActivities(l, change, nameOf));
  const changedIds = [...new Set(activities.map((a) => a.leadId.toString()))].map((i) => new Types.ObjectId(i));

  if (changedIds.length) {
    await LeadModel.updateMany({ organizationId: ctx.organizationId, _id: { $in: changedIds } }, toUpdate(change, ctx.userId));
    await syncStudentOwnership(ctx.organizationId, changedIds, toUpdate(change, ctx.userId));
    await moveOpenFollowUps(ctx, changedIds, change.counsellor);
    await logActivities(ctx, activities);
    await recordAudit(ctx, {
      entityType: 'lead',
      action: 'lead.bulk_assigned',
      metadata: {
        count: changedIds.length,
        counsellorId: change.counsellor?._id.toString() ?? change.counsellor,
        managerId: change.manager?._id.toString() ?? change.manager,
      },
    });
    for (const l of leads.filter((x) => changedIds.some((c) => c.equals(x._id)))) {
      emitLeadEvent('lead.assigned', {
        ...l,
        assignedCounsellor: change.counsellor === undefined ? l.assignedCounsellor : (change.counsellor?._id ?? null),
        assignedManager: change.manager === undefined ? l.assignedManager : (change.manager?._id ?? null),
      });
    }
  }
  await notifyBulkAssigned(ctx.organizationId, changedIds.length, { counsellor: change.counsellor?._id, manager: change.manager?._id }, ctx.userId);
  return { updated: changedIds.length, unchanged: leads.length - changedIds.length, skipped: ids.length - leads.length };
}

