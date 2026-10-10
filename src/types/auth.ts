import type { Types } from 'mongoose';
import type { DataScope } from '../constants/roles.js';

/** Resolved on every authenticated request; the only trusted source of tenant identity. */
export interface AuthContext {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  sessionId: string;
  roleId: Types.ObjectId;
  roleKey: string;
  permissions: ReadonlySet<string>;
  dataScope: DataScope;
  branchIds: Types.ObjectId[];
  isSuperAdmin: boolean;
  /**
   * The role holds `lead.viewAssignedOnly`: lead (and lead-owned) records are limited to those
   * assigned to the user, whatever the role's data scope. See recordScope() in utils/access.ts.
   */
  assignedOnly: boolean;
  /** Demo tenant: every signed-in request is read-only (enforced in authenticate()). */
  isDemo?: boolean;
  /** 2FA is mandatory, the user hasn't enrolled and the grace period is over: only enrollment routes work. */
  twoFactorEnrollmentRequired?: boolean;
}

/** Request metadata recorded in audit logs. */
export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/** What services receive: who is acting and from where. */
export interface ServiceContext extends AuthContext {
  meta: RequestMeta;
}
