import { Types } from 'mongoose';
import { ALL_PERMISSIONS, PLATFORM_MANAGE } from '../../constants/permissions.js';
import type { DataScope } from '../../constants/roles.js';
import type { AuthContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from '../users/user.model.js';
import { SessionModel } from './session.model.js';
import { verifyAccessToken } from './token.service.js';

const SUPER_ADMIN_PERMISSIONS: ReadonlySet<string> = new Set([...ALL_PERMISSIONS, PLATFORM_MANAGE]);

/**
 * Turns an access token into a trusted AuthContext by re-reading the user, role and organization,
 * so deactivation, role edits and password changes take effect without waiting for token expiry.
 */
export async function resolveAuthContext(token: string): Promise<AuthContext> {
  const payload = verifyAccessToken(token);
  if (!Types.ObjectId.isValid(payload.sub) || !Types.ObjectId.isValid(payload.org)) {
    throw ApiError.unauthorized('Invalid access token');
  }
  const organizationId = new Types.ObjectId(payload.org);

  const [user, org, session] = await Promise.all([
    UserModel.findOne({ _id: payload.sub, organizationId })
      .select('roleId branchIds isActive passwordChangedAt')
      .lean(),
    OrganizationModel.findById(organizationId).select('isActive').lean(),
    // Revoked sessions (sign-out, remote device sign-out, password reset) stop working immediately.
    Types.ObjectId.isValid(payload.sid) ? SessionModel.findById(payload.sid).select('revokedAt').lean() : null,
  ]);
  if (!session || session.revokedAt) throw ApiError.unauthorized('Session expired, please sign in again');
  if (!user || !user.isActive) throw ApiError.unauthorized('Account is inactive or does not exist');
  if (!org || !org.isActive) throw ApiError.unauthorized('Organization is inactive');
  // Tokens issued before a password change are invalid (iat has second precision).
  if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
    throw ApiError.unauthorized('Session expired, please sign in again');
  }

  const role = await RoleModel.findOne({ _id: user.roleId, organizationId })
    .select('key permissions dataScope isSuperAdmin isActive')
    .lean();
  if (!role || !role.isActive) throw ApiError.forbidden('Your role is inactive');

  return {
    userId: user._id,
    organizationId,
    sessionId: payload.sid,
    roleId: role._id,
    roleKey: role.key,
    permissions: role.isSuperAdmin ? SUPER_ADMIN_PERMISSIONS : new Set(role.permissions),
    dataScope: role.dataScope as DataScope,
    branchIds: user.branchIds,
    isSuperAdmin: role.isSuperAdmin,
  };
}
