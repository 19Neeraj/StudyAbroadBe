import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { hasPermissions } from '../../middlewares/auth.middleware.js';
import { emitTo, rooms } from '../../sockets/index.js';
import type { AuthContext, ServiceContext } from '../../types/auth.js';
import { recordScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, toPaging } from '../../utils/pagination.js';
import { addDays, startOfDayInTz } from '../../utils/time.js';
import { logActivity } from '../activities/activity.service.js';
import { loadLead } from '../leads/lead.access.js';
import { resolveAssignee } from '../leads/lead.assignment.js';
import { LeadModel } from '../leads/lead.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { assertLookupValues } from '../settings/lookup.service.js';
import { FollowUpModel, OPEN_FOLLOWUP_STATUSES, refreshNextFollowUp } from './followup.model.js';
import type {
  cancelFollowUpBody,
  completeFollowUpBody,
  createFollowUpBody,
  FollowUpListQuery,
  rescheduleFollowUpBody,
} from './followup.validation.js';

type Filter = Record<string, unknown>;

/** own → assigned to me; branch → my branches or assigned to me; organization → all. */
export function followUpScope(ctx: AuthContext): Filter {
  const base: Filter = { organizationId: ctx.organizationId };
  const scope = recordScope(ctx);
  if (scope === 'organization') return base;
  if (scope === 'branch') return { ...base, $or: [{ branchId: { $in: ctx.branchIds } }, { assignedTo: ctx.userId }] };
  return { ...base, assignedTo: ctx.userId };
}

const populateRefs = (ctx: ServiceContext) => [
  { path: 'leadId', select: 'leadNumber fullName phone whatsappNumber leadStage', match: { organizationId: ctx.organizationId } },
  { path: 'assignedTo', select: 'fullName', match: { organizationId: ctx.organizationId } },
];

interface PopulatedFollowUp {
  _id: Types.ObjectId;
  leadId: { _id: Types.ObjectId } | null;
  status: string;
  dueAt: Date;
  [k: string]: unknown;
}

function toDto(f: PopulatedFollowUp, now = new Date()) {
  const { leadId, ...rest } = f;
  return {
    ...rest,
    leadId: leadId?._id ?? null,
    lead: leadId,
    isOverdue: OPEN_FOLLOWUP_STATUSES.includes(f.status as never) && f.dueAt < now,
  };
}

async function viewFilter(ctx: ServiceContext, view: FollowUpListQuery['view']): Promise<Filter> {
  const { timezone } = await getOrgSettings(ctx.organizationId);
  const now = new Date();
  const today = startOfDayInTz(timezone, now);
  const tomorrow = addDays(today, 1);
  const open = { status: { $in: OPEN_FOLLOWUP_STATUSES } };
  switch (view) {
    case 'today':
      return { ...open, dueAt: { $gte: today, $lt: tomorrow } };
    case 'overdue':
      return { ...open, dueAt: { $lt: now } };
    case 'upcoming':
      return { ...open, dueAt: { $gte: tomorrow } };
    case 'completed':
      return { status: 'completed' };
    default:
      return {};
  }
}

async function loadFollowUp(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Follow-up');
  const f = await FollowUpModel.findOne({ ...followUpScope(ctx), _id: new Types.ObjectId(id) });
  if (!f) throw ApiError.notFound('Follow-up');
  return f;
}

function assertOpen(status: string) {
  if (!OPEN_FOLLOWUP_STATUSES.includes(status as never)) {
    throw ApiError.conflict(`This follow-up is already ${status}`);
  }
}

function notify(f: { _id: Types.ObjectId; leadId: Types.ObjectId; assignedTo: Types.ObjectId }, event: 'followup.created' | 'followup.updated') {
  emitTo([rooms.user(f.assignedTo.toString())], event, { followUpId: f._id.toString(), leadId: f.leadId.toString() });
}

export async function createFollowUp(ctx: ServiceContext, leadId: string, input: z.infer<typeof createFollowUpBody>) {
  const lead = await loadLead(ctx, leadId);
  await assertLookupValues(ctx, { followUpType: { type: 'followup_type', value: input.followUpType } });

  let assignedTo = lead.assignedCounsellor ?? ctx.userId;
  if (input.assignedTo && !ctx.userId.equals(input.assignedTo)) {
    if (!hasPermissions(ctx, ['lead.assign'])) throw ApiError.forbidden('You can only schedule follow-ups for yourself');
    assignedTo = (await resolveAssignee(ctx, input.assignedTo, 'assignedTo'))._id;
  } else if (input.assignedTo) {
    assignedTo = ctx.userId;
  }

  const followUp = await FollowUpModel.create({
    organizationId: ctx.organizationId,
    leadId: lead._id,
    branchId: lead.branchId,
    assignedTo,
    dueAt: input.dueAt,
    followUpType: input.followUpType,
    notes: input.notes,
    nextAction: input.nextAction,
    createdBy: ctx.userId,
  });
  await refreshNextFollowUp(ctx.organizationId, lead._id);
  await logActivity(ctx, {
    leadId: lead._id,
    type: 'followup_created',
    title: 'Follow-up scheduled',
    notes: input.notes,
    newValue: { dueAt: input.dueAt, followUpType: input.followUpType },
    metadata: { followUpId: followUp._id.toString(), nextAction: input.nextAction },
  });
  notify(followUp, 'followup.created');
  return getFollowUp(ctx, followUp._id);
}

async function getFollowUp(ctx: ServiceContext, id: Types.ObjectId) {
  const f = await FollowUpModel.findOne({ organizationId: ctx.organizationId, _id: id }).populate(populateRefs(ctx)).lean<PopulatedFollowUp>();
  if (!f) throw ApiError.notFound('Follow-up');
  return toDto(f);
}

export async function listFollowUps(ctx: ServiceContext, q: FollowUpListQuery) {
  const filter: Filter = { ...followUpScope(ctx), ...(await viewFilter(ctx, q.view)) };
  if (q.assignedTo) {
    const wanted = q.assignedTo === 'me' ? ctx.userId : new Types.ObjectId(q.assignedTo);
    // An "own" scope already pins assignedTo; a different assignee must not widen it.
    if (filter.assignedTo && !(filter.assignedTo as Types.ObjectId).equals(wanted)) filter._id = null;
    else filter.assignedTo = wanted;
  }
  if (q.branchId) filter.branchId = new Types.ObjectId(q.branchId);
  if (q.followUpType) filter.followUpType = q.followUpType;

  const sort: Record<string, 1 | -1> =
    q.view === 'completed' ? { completedAt: -1, _id: -1 } : q.view === 'all' ? { dueAt: -1, _id: -1 } : { dueAt: q.sortOrder === 'desc' ? -1 : 1, _id: 1 };
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    FollowUpModel.find(filter).sort(sort).skip(skip).limit(limit).populate(populateRefs(ctx)).lean<PopulatedFollowUp[]>(),
    FollowUpModel.countDocuments(filter),
  ]);
  const now = new Date();
  return { items: items.map((f) => toDto(f, now)), pagination: buildPagination(q.page, q.limit, total) };
}

/** Follow-ups of one lead (visible to anyone who can see the lead). */
export async function listLeadFollowUps(ctx: ServiceContext, leadId: string) {
  const lead = await loadLead(ctx, leadId);
  const items = await FollowUpModel.find({ organizationId: ctx.organizationId, leadId: lead._id })
    .sort({ dueAt: -1 })
    .limit(200)
    .populate(populateRefs(ctx))
    .lean<PopulatedFollowUp[]>();
  const now = new Date();
  return items.map((f) => toDto(f, now));
}

export async function followUpSummary(ctx: ServiceContext, mine: boolean) {
  const base = mine ? { organizationId: ctx.organizationId, assignedTo: ctx.userId } : followUpScope(ctx);
  const [today, overdue, upcoming] = await Promise.all(
    (['today', 'overdue', 'upcoming'] as const).map(async (v) => FollowUpModel.countDocuments({ ...base, ...(await viewFilter(ctx, v)) })),
  );
  return { today: today!, overdue: overdue!, upcoming: upcoming! };
}

export async function completeFollowUp(ctx: ServiceContext, id: string, input: z.infer<typeof completeFollowUpBody>) {
  const f = await loadFollowUp(ctx, id);
  assertOpen(f.status);
  f.status = 'completed';
  f.outcome = input.outcome;
  f.completedAt = new Date();
  f.completedBy = ctx.userId;
  await f.save();
  await logActivity(ctx, {
    leadId: f.leadId,
    type: 'followup_completed',
    title: 'Follow-up completed',
    outcome: input.outcome,
    metadata: { followUpId: f._id.toString(), followUpType: f.followUpType, dueAt: f.dueAt },
  });
  await LeadModel.updateOne({ organizationId: ctx.organizationId, _id: f.leadId }, { lastActivityAt: new Date() });

  let next = null;
  if (input.next) next = await createFollowUp(ctx, f.leadId.toString(), input.next);
  else await refreshNextFollowUp(ctx.organizationId, f.leadId);
  notify(f, 'followup.updated');
  return { completed: await getFollowUp(ctx, f._id), next };
}

export async function rescheduleFollowUp(ctx: ServiceContext, id: string, input: z.infer<typeof rescheduleFollowUpBody>) {
  const f = await loadFollowUp(ctx, id);
  assertOpen(f.status);
  const replacement = await FollowUpModel.create({
    organizationId: ctx.organizationId,
    leadId: f.leadId,
    branchId: f.branchId,
    assignedTo: f.assignedTo,
    dueAt: input.dueAt,
    followUpType: f.followUpType,
    notes: input.notes ?? f.notes,
    nextAction: f.nextAction,
    rescheduledFromId: f._id,
    createdBy: ctx.userId,
  });
  f.status = 'rescheduled';
  f.rescheduledToId = replacement._id;
  await f.save();
  await refreshNextFollowUp(ctx.organizationId, f.leadId);
  await logActivity(ctx, {
    leadId: f.leadId,
    type: 'followup_rescheduled',
    title: 'Follow-up rescheduled',
    notes: input.notes,
    previousValue: f.dueAt,
    newValue: input.dueAt,
    metadata: { followUpId: replacement._id.toString(), previousFollowUpId: f._id.toString() },
  });
  notify(replacement, 'followup.updated');
  return getFollowUp(ctx, replacement._id);
}

export async function cancelFollowUp(ctx: ServiceContext, id: string, input: z.infer<typeof cancelFollowUpBody>) {
  const f = await loadFollowUp(ctx, id);
  assertOpen(f.status);
  f.status = 'cancelled';
  f.cancelledAt = new Date();
  f.cancelReason = input.reason;
  await f.save();
  await refreshNextFollowUp(ctx.organizationId, f.leadId);
  await logActivity(ctx, {
    leadId: f.leadId,
    type: 'followup_cancelled',
    title: 'Follow-up cancelled',
    notes: input.reason,
    metadata: { followUpId: f._id.toString(), dueAt: f.dueAt },
  });
  notify(f, 'followup.updated');
  return getFollowUp(ctx, f._id);
}
