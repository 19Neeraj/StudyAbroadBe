import type { Types } from 'mongoose';
import { ORG_ADMIN_ROLE_KEY } from '../../constants/roles.js';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { holdsAll } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { slugify } from '../../utils/normalize.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { UserModel } from '../users/user.model.js';
import { RoleModel } from './role.model.js';
import type { createRoleBody, updateRoleBody } from './role.validation.js';

const PUBLIC_FIELDS =
  'key name description dataScope permissions isSystem isActive createdAt updatedAt';

async function userCounts(organizationId: Types.ObjectId): Promise<Map<string, number>> {
  const rows = await UserModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { organizationId } },
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
}

function assertCanGrant(ctx: ServiceContext, permissions: readonly string[]) {
  if (!holdsAll(ctx, permissions)) {
    throw ApiError.forbidden('You cannot grant permissions that you do not have yourself');
  }
}

export async function listRoles(ctx: ServiceContext) {
  const [roles, counts] = await Promise.all([
    RoleModel.find({ organizationId: ctx.organizationId, isSuperAdmin: false })
      .select(PUBLIC_FIELDS)
      .sort({ isSystem: -1, name: 1 })
      .lean(),
    userCounts(ctx.organizationId),
  ]);
  return roles.map((r) => ({ ...r, userCount: counts.get(r._id.toString()) ?? 0 }));
}

export async function getRole(ctx: ServiceContext, id: string) {
  const role = await RoleModel.findOne({
    organizationId: ctx.organizationId,
    _id: id,
    isSuperAdmin: false,
  })
    .select(PUBLIC_FIELDS)
    .lean();
  if (!role) throw ApiError.notFound('Role');
  const userCount = await UserModel.countDocuments({
    organizationId: ctx.organizationId,
    roleId: role._id,
  });
  return { ...role, userCount };
}

export async function createRole(ctx: ServiceContext, input: z.infer<typeof createRoleBody>) {
  assertCanGrant(ctx, input.permissions);
  const key = input.key ?? slugify(input.name);
  if (!key)
    throw ApiError.validation([
      { field: 'body.name', message: 'Name must contain letters or digits' },
    ]);
  const role = await RoleModel.create({
    ...input,
    key,
    organizationId: ctx.organizationId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await recordAudit(ctx, {
    entityType: 'role',
    entityId: role._id,
    action: 'role.created',
    newValue: { ...input, key },
  });
  return getRole(ctx, role._id.toString());
}

export async function updateRole(
  ctx: ServiceContext,
  id: string,
  input: z.infer<typeof updateRoleBody>,
) {
  const before = await getRole(ctx, id);
  if (
    before.key === ORG_ADMIN_ROLE_KEY &&
    (input.permissions || input.dataScope || input.isActive === false)
  ) {
    // Prevents an organization from locking itself out of administration.
    throw ApiError.badRequest(
      'The Organization Admin role always has full access and cannot be restricted',
    );
  }
  if (input.permissions) {
    // Changing a role must not grant or remove permissions the actor does not hold.
    const added = input.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !input.permissions?.includes(p));
    assertCanGrant(ctx, [...added, ...removed]);
  }
  if (input.isActive === false && before.userCount > 0) {
    throw ApiError.conflict(
      `This role is assigned to ${before.userCount} user(s). Reassign them first.`,
    );
  }
  if (ctx.roleId.equals(before._id) && (input.permissions || input.isActive === false)) {
    throw ApiError.badRequest('You cannot change permissions of your own role');
  }

  await RoleModel.updateOne(
    { organizationId: ctx.organizationId, _id: id },
    { ...input, updatedBy: ctx.userId },
    { runValidators: true },
  );
  const changes = diffFields(before, input);
  if (changes)
    await recordAudit(ctx, {
      entityType: 'role',
      entityId: before._id,
      action: 'role.updated',
      ...changes,
    });
  return getRole(ctx, id);
}

export async function deleteRole(ctx: ServiceContext, id: string) {
  const role = await getRole(ctx, id);
  if (role.isSystem)
    throw ApiError.badRequest('Default roles cannot be deleted; deactivate or edit them instead');
  if (role.userCount > 0)
    throw ApiError.conflict(
      `This role is assigned to ${role.userCount} user(s). Reassign them first.`,
    );
  assertCanGrant(ctx, role.permissions);
  await RoleModel.deleteOne({ organizationId: ctx.organizationId, _id: id });
  await recordAudit(ctx, {
    entityType: 'role',
    entityId: role._id,
    action: 'role.deleted',
    oldValue: role,
  });
}
