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
