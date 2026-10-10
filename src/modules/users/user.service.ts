import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ORG_ADMIN_ROLE_KEY } from '../../constants/roles.js';
import type { z } from '../../docs/zod.js';
import { sendEmailSafe } from '../../integrations/email/index.js';
import type { ServiceContext } from '../../types/auth.js';
import { accessibleBranchIds, assertBranchesAccessible, roleWithinActor } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { hashToken, randomToken } from '../../utils/crypto.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { buildPagination, escapeRegex, toPaging, toSort } from '../../utils/pagination.js';
import { hashPassword } from '../../utils/password.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { revokeSessions } from '../auth/auth.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from './user.model.js';
import type {
  createUserBody,
  updateUserBody,
  UserListQuery,
  UserOptionsQuery,
} from './user.validation.js';

const INVITE_TTL_HOURS = 72;
const LIST_FIELDS =
  'firstName lastName fullName email phone designation avatarUrl isActive roleId branchIds managerId lastLoginAt createdAt updatedAt';

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName?: string | null;
  fullName?: string | null;
  email: string;
  phone?: string | null;
  designation?: string | null;
  avatarUrl?: string | null;
  isActive: boolean;
  roleId: { _id: Types.ObjectId; key: string; name: string } | null;
  branchIds: { _id: Types.ObjectId; name: string; code: string }[];
  managerId: { _id: Types.ObjectId; fullName: string } | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toUserDto(u: PopulatedUser) {
  return {
    id: u._id.toString(),
    firstName: u.firstName,
    lastName: u.lastName ?? '',
    fullName: u.fullName ?? u.firstName,
    email: u.email,
    phone: u.phone ?? null,
    designation: u.designation ?? null,
    avatarUrl: u.avatarUrl ?? null,
    isActive: u.isActive,
    role: u.roleId ? { id: u.roleId._id.toString(), key: u.roleId.key, name: u.roleId.name } : null,
    branches: (u.branchIds ?? [])
      .filter(Boolean)
      .map((b) => ({ id: b._id.toString(), name: b.name, code: b.code })),
    manager: u.managerId
      ? { id: u.managerId._id.toString(), fullName: u.managerId.fullName }
      : null,
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/** Restricts which users the actor can see, according to their role's data scope. */
function scopedFilter(ctx: ServiceContext): Record<string, unknown> {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (ctx.dataScope === 'own' && !ctx.isSuperAdmin) {
    filter._id = ctx.userId;
  } else {
    const branches = accessibleBranchIds(ctx);
    if (branches) filter.$or = [{ branchIds: { $in: branches } }, { _id: ctx.userId }];
  }
  return filter;
}

function populated(ctx: ServiceContext) {
  const match = { organizationId: ctx.organizationId };
  return [
    { path: 'roleId', select: 'key name', match },
    { path: 'branchIds', select: 'name code', match },
    { path: 'managerId', select: 'fullName', match },
  ];
}

async function normalizePhoneForOrg(ctx: ServiceContext, phone: string) {
  const { defaultCountryCode } = await getOrgSettings(ctx.organizationId);
  const normalized = normalizePhone(phone, defaultCountryCode);
  if (!normalized)
    throw ApiError.validation([{ field: 'body.phone', message: 'Invalid phone number' }]);
  return normalized;
}

/** Validates a role assignment: role exists in this org, is active, and grants nothing beyond the actor. */
async function resolveAssignableRole(ctx: ServiceContext, roleId: string) {
  const role = await RoleModel.findOne({
    organizationId: ctx.organizationId,
    _id: roleId,
    isActive: true,
  })
    .select('key permissions isSuperAdmin')
    .lean();
  if (!role || role.isSuperAdmin)
    throw ApiError.validation([{ field: 'body.roleId', message: 'Role not found' }]);
  if (!roleWithinActor(ctx, role.permissions))
    throw ApiError.forbidden('You cannot assign a role with more permissions than your own');
  return role;
}

async function assertBranchesExist(ctx: ServiceContext, branchIds: string[]) {
  if (!branchIds.length) return;
  assertBranchesAccessible(ctx, branchIds);
  const count = await BranchModel.countDocuments({
    organizationId: ctx.organizationId,
    _id: { $in: branchIds },
    isActive: true,
  });
  if (count !== new Set(branchIds).size)
    throw ApiError.validation([
      { field: 'body.branchIds', message: 'One or more branches are invalid' },
    ]);
}

async function assertManagerExists(ctx: ServiceContext, managerId: string, selfId?: string) {
  if (managerId === selfId)
    throw ApiError.validation([
      { field: 'body.managerId', message: 'A user cannot manage themselves' },
    ]);
  const exists = await UserModel.exists({
    organizationId: ctx.organizationId,
    _id: managerId,
    isActive: true,
  });
  if (!exists)
    throw ApiError.validation([{ field: 'body.managerId', message: 'Manager not found' }]);
}

/** The actor must out-rank the target: they may only modify users whose permissions they also hold. */
async function loadManageableUser(ctx: ServiceContext, id: string) {
  const user = await UserModel.findOne({ ...scopedFilter(ctx), _id: id });
  if (!user) throw ApiError.notFound('User');
  const role = await RoleModel.findOne({ organizationId: ctx.organizationId, _id: user.roleId })
    .select('key permissions')
    .lean();
  if (role && !roleWithinActor(ctx, role.permissions))
    throw ApiError.forbidden('You cannot modify a user with more permissions than your own');
  return { user, role };
}

/** An organization must always keep at least one active admin. */
async function assertNotLastAdmin(ctx: ServiceContext, userId: Types.ObjectId) {
  const adminRole = await RoleModel.findOne({
    organizationId: ctx.organizationId,
    key: ORG_ADMIN_ROLE_KEY,
  })
    .select('_id')
    .lean();
  if (!adminRole) return;
  const others = await UserModel.countDocuments({
    organizationId: ctx.organizationId,
    roleId: adminRole._id,
    isActive: true,
    _id: { $ne: userId },
  });
  if (others === 0)
    throw ApiError.badRequest('The organization must keep at least one active Organization Admin');
}

export async function listUsers(ctx: ServiceContext, q: UserListQuery) {
  const filter = scopedFilter(ctx);
  const and: Record<string, unknown>[] = [];
  if (q.roleId) filter.roleId = q.roleId;
  if (q.managerId) filter.managerId = q.managerId;
  if (q.isActive !== undefined) filter.isActive = q.isActive;
  if (q.branchId) and.push({ branchIds: new Types.ObjectId(q.branchId) });
  if (q.search) {
    // Users per organization are few, so a case-insensitive scan within the tenant is acceptable here.
    const rx = new RegExp(escapeRegex(q.search), 'i');
    and.push({ $or: [{ fullName: rx }, { email: rx }, { phone: rx }] });
  }
  if (and.length) filter.$and = and;

  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    UserModel.find(filter)
      .select(LIST_FIELDS)
      .sort(toSort(q.sortBy, q.sortOrder))
      .skip(skip)
      .limit(limit)
      .populate(populated(ctx))
      .lean<PopulatedUser[]>(),
    UserModel.countDocuments(filter),
  ]);
  return { items: items.map(toUserDto), pagination: buildPagination(q.page, q.limit, total) };
}

/** Lightweight active-user list for assignment pickers. */
export async function listUserOptions(ctx: ServiceContext, q: UserOptionsQuery) {
  const filter: Record<string, unknown> = { ...scopedFilter(ctx), isActive: true };
  const and: Record<string, unknown>[] = [];
  if (q.branchId) and.push({ branchIds: new Types.ObjectId(q.branchId) });
  if (q.roleKey) {
    const role = await RoleModel.findOne({ organizationId: ctx.organizationId, key: q.roleKey })
      .select('_id')
      .lean();
    if (!role) return [];
    filter.roleId = role._id;
  }
  if (q.search) and.push({ fullName: new RegExp(escapeRegex(q.search), 'i') });
  if (and.length) filter.$and = and;

  const users = await UserModel.find(filter)
    .select('fullName email roleId')
    .sort({ fullName: 1 })
    .limit(q.limit)
    .populate({ path: 'roleId', select: 'key', match: { organizationId: ctx.organizationId } })
    .lean<
      { _id: Types.ObjectId; fullName: string; email: string; roleId: { key: string } | null }[]
    >();
  return users.map((u) => ({
    id: u._id.toString(),
    fullName: u.fullName,
    email: u.email,
    roleKey: u.roleId?.key ?? null,
  }));
}

export async function getUser(ctx: ServiceContext, id: string) {
  const user = await UserModel.findOne({ ...scopedFilter(ctx), _id: id })
    .select(LIST_FIELDS)
    .populate(populated(ctx))
    .lean<PopulatedUser>();
  if (!user) throw ApiError.notFound('User');
  return toUserDto(user);
}

export async function createUser(ctx: ServiceContext, input: z.infer<typeof createUserBody>) {
  const email = normalizeEmail(input.email);
  // Email is the global login id; check across tenants without revealing which tenant owns it.
  if (await UserModel.exists({ email }).setOptions({ skipTenantGuard: true })) {
    throw ApiError.conflict('A user with this email already exists', [
      { field: 'body.email', message: 'Already registered' },
    ]);
  }
  await resolveAssignableRole(ctx, input.roleId);
  await assertBranchesExist(ctx, input.branchIds);
  if (input.managerId) await assertManagerExists(ctx, input.managerId);
  const phone = input.phone ? await normalizePhoneForOrg(ctx, input.phone) : undefined;

  const inviteToken = input.password ? null : randomToken(32);
  const user = await UserModel.create({
    organizationId: ctx.organizationId,
    firstName: input.firstName,
    lastName: input.lastName,
    email,
    phone,
    designation: input.designation,
    roleId: input.roleId,
    branchIds: input.branchIds,
    managerId: input.managerId,
    // Invited users get an unusable random password until they set their own.
    passwordHash: await hashPassword(input.password ?? randomToken(32)),
    ...(inviteToken
      ? {
          passwordReset: {
            tokenHash: hashToken(inviteToken),
            expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000),
          },
        }
      : {}),
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });

  if (inviteToken) {
    const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(inviteToken)}&invite=1`;
    await sendEmailSafe({
      to: email,
      subject: 'You have been invited to the CRM',
      text: `Hi ${input.firstName},\n\nAn account has been created for you. Set your password here (valid for ${INVITE_TTL_HOURS} hours):\n\n${link}`,
    });
  }

  const { password: _password, ...auditable } = input;
  await recordAudit(ctx, {
    entityType: 'user',
    entityId: user._id,
    action: 'user.created',
    newValue: { ...auditable, email, invited: !!inviteToken },
  });
  return getUser(ctx, user._id.toString());
}

export async function updateUser(
  ctx: ServiceContext,
  id: string,
  input: z.infer<typeof updateUserBody>,
) {
  const { user, role } = await loadManageableUser(ctx, id);
  const isSelf = user._id.equals(ctx.userId);

  if (input.roleId && !user.roleId.equals(input.roleId)) {
    if (isSelf) throw ApiError.badRequest('You cannot change your own role');
    await resolveAssignableRole(ctx, input.roleId);
    if (role?.key === ORG_ADMIN_ROLE_KEY) await assertNotLastAdmin(ctx, user._id);
  }
  if (input.branchIds) {
    await assertBranchesExist(ctx, input.branchIds);
    // Branch-scoped actors can only add/remove branches they control; keep the target's other branches.
    const allowed = accessibleBranchIds(ctx);
    if (allowed) {
      const untouchable = user.branchIds
        .filter((b) => !allowed.some((a) => a.equals(b)))
        .map(String);
      input.branchIds = [...new Set([...untouchable, ...input.branchIds])];
    }
  }
  if (input.managerId) await assertManagerExists(ctx, input.managerId, id);

  const before = {
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone ?? null,
    designation: user.designation ?? null,
    roleId: user.roleId.toString(),
    branchIds: user.branchIds.map(String),
    managerId: user.managerId?.toString() ?? null,
  };
  const changes: Record<string, unknown> = { ...input };
  if (input.phone) changes.phone = await normalizePhoneForOrg(ctx, input.phone);

  user.set({ ...changes, updatedBy: ctx.userId });
  await user.save();

  const diff = diffFields(before, changes as Partial<typeof before>);
  if (diff)
    await recordAudit(ctx, {
      entityType: 'user',
      entityId: user._id,
      action: 'user.updated',
      ...diff,
    });
  return getUser(ctx, id);
}

export async function setUserActive(ctx: ServiceContext, id: string, isActive: boolean) {
  const { user, role } = await loadManageableUser(ctx, id);
  if (user._id.equals(ctx.userId))
    throw ApiError.badRequest('You cannot change your own account status');
  if (user.isActive === isActive) return getUser(ctx, id);
  if (!isActive && role?.key === ORG_ADMIN_ROLE_KEY) await assertNotLastAdmin(ctx, user._id);

  user.isActive = isActive;
  user.updatedBy = ctx.userId;
  await user.save();
  if (!isActive) await revokeSessions({ userId: user._id }, 'user_deactivated');

  await recordAudit(ctx, {
    entityType: 'user',
    entityId: user._id,
    action: isActive ? 'user.activated' : 'user.deactivated',
    oldValue: { isActive: !isActive },
    newValue: { isActive },
  });
  return getUser(ctx, id);
}
