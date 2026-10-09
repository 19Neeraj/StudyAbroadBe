import type { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import type { ServiceContext } from '../../types/auth.js';
import { buildPagination, toPaging } from '../../utils/pagination.js';
import { AuditLogModel } from './audit.model.js';
import type { AuditListQuery } from './audit.validation.js';

export interface AuditEntry {
  entityType: string;
  entityId?: Types.ObjectId;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
}

type ActorContext = Pick<ServiceContext, 'organizationId' | 'meta'> & { userId?: Types.ObjectId };

/**
 * Records an audit entry. Audit failures are logged, not thrown: by the time we audit,
 * the business change has already been committed.
 */
export async function recordAudit(ctx: ActorContext, entry: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      ...entry,
      ipAddress: ctx.meta.ip,
      userAgent: ctx.meta.userAgent,
    });
  } catch (err) {
    logger.error(
      { err, entityType: entry.entityType, action: entry.action },
      'Failed to write audit log',
    );
  }
}

/** Returns only the fields that changed, as `{ oldValue, newValue }` for the audit trail. */
export function diffFields<T extends object>(
  before: T,
  after: Partial<T>,
): { oldValue: Partial<T>; newValue: Partial<T> } | null {
  const oldValue: Partial<T> = {};
  const newValue: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      oldValue[key] = before[key];
      newValue[key] = after[key];
    }
  }
  return Object.keys(newValue).length ? { oldValue, newValue } : null;
}

export async function listAuditLogs(ctx: ServiceContext, q: AuditListQuery) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (q.entityType) filter.entityType = q.entityType;
  if (q.entityId) filter.entityId = q.entityId;
  if (q.userId) filter.userId = q.userId;
  if (q.action) filter.action = q.action;
  if (q.dateFrom || q.dateTo) {
    filter.createdAt = {
      ...(q.dateFrom ? { $gte: q.dateFrom } : {}),
      ...(q.dateTo ? { $lte: q.dateTo } : {}),
    };
  }
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    AuditLogModel.find(filter)
      .sort({ createdAt: q.sortOrder === 'asc' ? 1 : -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: 'userId',
        select: 'fullName email',
        match: { organizationId: ctx.organizationId },
      })
      .lean(),
    AuditLogModel.countDocuments(filter),
  ]);
  return { items, pagination: buildPagination(q.page, q.limit, total) };
}
