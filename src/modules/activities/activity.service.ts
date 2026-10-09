import type { Types } from 'mongoose';
import type { ActivityType } from '../../constants/activities.js';
import type { ServiceContext } from '../../types/auth.js';
import { buildPagination, toPaging } from '../../utils/pagination.js';
import { ActivityModel } from './activity.model.js';
import type { ActivityListQuery } from './activity.validation.js';

export interface ActivityInput {
  leadId: Types.ObjectId;
  studentId?: Types.ObjectId | undefined;
  type: ActivityType;
  title: string;
  notes?: string | undefined;
  outcome?: string | undefined;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | undefined;
}

type Actor = Pick<ServiceContext, 'organizationId' | 'userId'>;

export async function logActivity(ctx: Actor, input: ActivityInput) {
  return ActivityModel.create({ organizationId: ctx.organizationId, userId: ctx.userId, ...input });
}

/** Bulk insert for bulk actions (one entry per lead). */
export async function logActivities(ctx: Actor, inputs: ActivityInput[]) {
  if (!inputs.length) return;
  await ActivityModel.insertMany(inputs.map((i) => ({ organizationId: ctx.organizationId, userId: ctx.userId, ...i })));
}

/** Timeline of a lead. Callers must have already checked the lead is within the user's scope. */
export async function listLeadActivities(ctx: ServiceContext, leadId: Types.ObjectId, q: ActivityListQuery) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, leadId };
  if (q.types?.length) filter.type = { $in: q.types };
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    ActivityModel.find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'userId', select: 'fullName', match: { organizationId: ctx.organizationId } })
      .lean(),
    ActivityModel.countDocuments(filter),
  ]);
  return {
    items: items.map(({ userId, ...rest }) => ({ ...rest, user: userId ?? null })),
    pagination: buildPagination(q.page, q.limit, total),
  };
}
