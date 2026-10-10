import type { Types } from 'mongoose';
import type { DataScope } from '../../constants/roles.js';
import type { ServiceContext } from '../../types/auth.js';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from '../users/user.model.js';

export class ActorUnavailableError extends Error {}

/**
 * Background imports have no signed-in user. They run as the admin who connected the integration,
 * with that user's current role and scope (re-read every time), so a deactivated or demoted admin
 * stops the import instead of leaving an over-privileged robot behind.
 */
export async function integrationActor(organizationId: Types.ObjectId, userId: Types.ObjectId | null | undefined): Promise<ServiceContext> {
  if (!userId) throw new ActorUnavailableError('No connecting user recorded; reconnect the integration');
  const user = await UserModel.findOne({ organizationId, _id: userId }).select('roleId branchIds isActive').lean();
  if (!user?.isActive) throw new ActorUnavailableError('The user who connected this integration is inactive; reconnect it');
  const role = await RoleModel.findOne({ organizationId, _id: user.roleId }).select('key permissions dataScope isSuperAdmin isActive').lean();
  if (!role?.isActive) throw new ActorUnavailableError('The connecting user’s role is inactive; reconnect the integration');
  return {
    userId: user._id,
    organizationId,
    sessionId: 'integration',
    roleId: role._id,
    roleKey: role.key,
    permissions: new Set(role.permissions),
    dataScope: role.dataScope as DataScope,
    branchIds: user.branchIds,
    isSuperAdmin: false,
    assignedOnly: role.permissions.includes('lead.viewAssignedOnly'),
    meta: { userAgent: 'integration-import' },
  };
}
