import type { Types } from 'mongoose';
import { isRestriction } from '../constants/permissions.js';
import type { DataScope } from '../constants/roles.js';
import type { AuthContext } from '../types/auth.js';
import { ApiError } from './ApiError.js';

/**
 * Data-scope helpers. Permissions say *what* a user may do; the role's dataScope says
 * *which records*. Every list/detail query in scoped modules must go through these.
 */

export function hasOrgScope(ctx: AuthContext): boolean {
  return ctx.isSuperAdmin || ctx.dataScope === 'organization';
}

/**
 * Effective scope for lead-owned records (leads, students, follow-ups, calls, applications,
 * documents, payments, visa cases, dashboards, exports). `lead.viewAssignedOnly` narrows any data
 * scope to "assigned to me" (assigned counsellor or assigned manager); nothing ever widens it.
 * Role-level questions (which users or branches can I pick?) keep using hasOrgScope / dataScope.
 */
export function recordScope(ctx: AuthContext): DataScope {
  if (ctx.isSuperAdmin) return 'organization';
  return ctx.assignedOnly ? 'own' : ctx.dataScope;
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

/**
 * True when every permission in `required` is held by the actor (prevents privilege escalation).
 * Restriction permissions (lead.viewAssignedOnly) are the exception: they narrow access, so the
 * actor needn't hold them — but an actor who is restricted themselves can neither add nor remove
 * them, and can't hand out a lead-viewing role that lacks the restriction.
 */
export function holdsAll(ctx: AuthContext, required: readonly string[]): boolean {
  if (ctx.isSuperAdmin) return true;
  return required.every((p) => (isRestriction(p) ? !ctx.assignedOnly : ctx.permissions.has(p)));
}

/** A role's full permission list is no wider than the actor's own (used when assigning roles to users). */
export function roleWithinActor(ctx: AuthContext, rolePermissions: readonly string[]): boolean {
  if (ctx.isSuperAdmin) return true;
  const grants = rolePermissions.filter((p) => !isRestriction(p));
  if (!grants.every((p) => ctx.permissions.has(p))) return false;
  // A restricted actor can't give someone unrestricted lead visibility.
  return !ctx.assignedOnly || !rolePermissions.includes('lead.view') || rolePermissions.some(isRestriction);
}

/**
 * Ownership-based scope for records that belong to a student/lead (applications, documents,
 * payments, visa cases): organization → all; branch → my branches or assigned to me; own → assigned to me.
 * The records carry branchId / assignedCounsellor / assignedManager copied from the student.
 */
export function ownershipScope(ctx: AuthContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { organizationId: ctx.organizationId, ...extra };
  const scope = recordScope(ctx);
  if (scope === 'organization') return base;
  const mine = [{ assignedCounsellor: ctx.userId }, { assignedManager: ctx.userId }];
  if (scope === 'branch') return { ...base, $or: [{ branchId: { $in: ctx.branchIds } }, ...mine] };
  return { ...base, $or: mine };
}

/** Ownership fields shared by student-linked schemas. */
export const OWNERSHIP_FIELDS = ['branchId', 'assignedCounsellor', 'assignedManager'] as const;
