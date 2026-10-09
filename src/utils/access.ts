import type { Types } from 'mongoose';
import type { AuthContext } from '../types/auth.js';
import { ApiError } from './ApiError.js';

/**
 * Data-scope helpers. Permissions say *what* a user may do; the role's dataScope says
 * *which records*. Every list/detail query in scoped modules must go through these.
 */

export function hasOrgScope(ctx: AuthContext): boolean {
  return ctx.isSuperAdmin || ctx.dataScope === 'organization';
}

/** Branch ids the user may see, or null when unrestricted. */
export function accessibleBranchIds(ctx: AuthContext): Types.ObjectId[] | null {
  return hasOrgScope(ctx) ? null : ctx.branchIds;
}

export function canAccessBranch(ctx: AuthContext, branchId: Types.ObjectId | string): boolean {
  const allowed = accessibleBranchIds(ctx);
  return allowed === null || allowed.some((b) => b.equals(branchId));
}

export function assertBranchesAccessible(
  ctx: AuthContext,
  branchIds: readonly (Types.ObjectId | string)[],
): void {
  const denied = branchIds.filter((b) => !canAccessBranch(ctx, b));
  if (denied.length)
    throw ApiError.forbidden('You cannot assign branches outside your own branches');
}

/** True when every permission in `required` is held by the actor (prevents privilege escalation). */
export function holdsAll(ctx: AuthContext, required: readonly string[]): boolean {
  return ctx.isSuperAdmin || required.every((p) => ctx.permissions.has(p));
}

/**
 * Ownership-based scope for records that belong to a student/lead (applications, documents,
 * payments, visa cases): organization → all; branch → my branches or assigned to me; own → assigned to me.
 * The records carry branchId / assignedCounsellor / assignedManager copied from the student.
 */
export function ownershipScope(ctx: AuthContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { organizationId: ctx.organizationId, ...extra };
  if (hasOrgScope(ctx)) return base;
  const mine = [{ assignedCounsellor: ctx.userId }, { assignedManager: ctx.userId }];
  if (ctx.dataScope === 'branch') return { ...base, $or: [{ branchId: { $in: ctx.branchIds } }, ...mine] };
  return { ...base, $or: mine };
}

/** Ownership fields shared by student-linked schemas. */
export const OWNERSHIP_FIELDS = ['branchId', 'assignedCounsellor', 'assignedManager'] as const;
