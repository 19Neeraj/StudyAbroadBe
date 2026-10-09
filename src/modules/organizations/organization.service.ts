import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { DEFAULT_ROLES, ORG_ADMIN_ROLE_KEY, SUPER_ADMIN_ROLE_KEY } from '../../constants/roles.js';
import type { z } from '../../docs/zod.js';
import type { RequestMeta, ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizeEmail, slugify } from '../../utils/normalize.js';
import { buildPagination, escapeRegex, toPaging, toSort } from '../../utils/pagination.js';
import { hashPassword } from '../../utils/password.js';
import { randomToken } from '../../utils/crypto.js';
import { AuditLogModel } from '../audit/audit.model.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { RoleModel } from '../roles/role.model.js';
import { LookupModel } from '../settings/lookup.model.js';
import { seedLookups } from '../settings/lookup.service.js';
import { UserModel } from '../users/user.model.js';
import { createUser } from '../users/user.service.js';
import { OrganizationModel } from './organization.model.js';
import { invalidateOrgSettings } from './orgSettings.js';
import type {
  createOrganizationBody,
  OrganizationListQuery,
  updateOrganizationBody,
} from './organization.validation.js';

const PUBLIC_FIELDS =
  'name slug email phone website address logoUrl isActive settings createdAt updatedAt';

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base).replace(/_/g, '-') || 'org';
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    if (!(await OrganizationModel.exists({ slug: candidate }))) return candidate;
  }
  return `${root}-${randomToken(4).toLowerCase()}`;
}

/** Removes everything created for an organization; used to roll back a failed provisioning. */
async function purgeOrganization(organizationId: Types.ObjectId) {
  const scoped = { organizationId };
  await Promise.allSettled([
    UserModel.deleteMany(scoped),
    RoleModel.deleteMany(scoped),
    BranchModel.deleteMany(scoped),
    LookupModel.deleteMany(scoped),
    AuditLogModel.deleteMany(scoped),
  ]);
  await OrganizationModel.deleteOne({ _id: organizationId });
}

/**
 * Creates a ready-to-use tenant: default roles, CRM master data, a head-office branch and
 * its first Organization Admin. Steps are compensated on failure (no multi-document
 * transactions, so this works on a standalone MongoDB too).
 */
export async function provisionOrganization(
  input: z.infer<typeof createOrganizationBody>,
  actor: { userId?: Types.ObjectId; meta: RequestMeta },
) {
  const adminEmail = normalizeEmail(input.admin.email);
  if (await UserModel.exists({ email: adminEmail }).setOptions({ skipTenantGuard: true })) {
    throw ApiError.conflict('A user with this email already exists', [
      { field: 'body.admin.email', message: 'Already registered' },
    ]);
  }
  if (input.slug && (await OrganizationModel.exists({ slug: input.slug }))) {
    throw ApiError.conflict('This organization slug is taken', [
      { field: 'body.slug', message: 'Already exists' },
    ]);
  }

  const { admin, ...profile } = input;
  const org = await OrganizationModel.create({
    ...profile,
    slug: input.slug ?? (await uniqueSlug(input.name)),
    createdBy: actor.userId,
  });
  const organizationId = org._id;

  try {
    const roles = await RoleModel.insertMany(
      DEFAULT_ROLES.map((r) => ({ ...r, organizationId, isSystem: true })),
    );
    await seedLookups(organizationId);
    const branch = await BranchModel.create({ organizationId, name: 'Head Office', code: 'HO' });
    const adminRole = roles.find((r) => r.key === ORG_ADMIN_ROLE_KEY);
    if (!adminRole) throw new Error('Default admin role missing');

    // Provisioning acts as the new organization's admin role so user-creation rules apply uniformly.
    const systemCtx: ServiceContext = {
      userId: actor.userId ?? new Types.ObjectId(),
      organizationId,
      sessionId: 'system',
      roleId: adminRole._id,
      roleKey: adminRole.key,
      permissions: new Set(adminRole.permissions),
      dataScope: 'organization',
      branchIds: [branch._id],
      isSuperAdmin: false,
      meta: actor.meta,
    };
    const adminUser = await createUser(systemCtx, {
      ...admin,
      roleId: adminRole._id.toString(),
      branchIds: [branch._id.toString()],
    });

    await recordAudit(systemCtx, {
      entityType: 'organization',
      entityId: organizationId,
      action: 'organization.created',
      newValue: { name: org.name, slug: org.slug, adminEmail },
    });
    return { organization: await getOrganization(organizationId), admin: adminUser };
  } catch (err) {
    logger.error({ err, organizationId }, 'Organization provisioning failed; rolling back');
    await purgeOrganization(organizationId);
    throw err;
  }
}

/** Creates the platform organization and Super Admin if they do not exist (idempotent). */
export async function ensurePlatformSuperAdmin(email: string, password: string) {
  let platform = await OrganizationModel.findOne({ isPlatform: true });
  platform ??= await OrganizationModel.create({
    name: 'Platform',
    slug: 'platform',
    isPlatform: true,
  });

  const roleFilter = { organizationId: platform._id, key: SUPER_ADMIN_ROLE_KEY };
  const role =
    (await RoleModel.findOne(roleFilter)) ??
    (await RoleModel.create({
      ...roleFilter,
      name: 'Super Admin',
      description: 'Platform administrator with access to all organizations',
      dataScope: 'organization',
      permissions: [],
      isSystem: true,
      isSuperAdmin: true,
    }));

  const normalized = normalizeEmail(email);
  const existing = await UserModel.findOne({ email: normalized })
    .setOptions({ skipTenantGuard: true })
    .lean();
  if (existing) return { created: false, organizationId: platform._id };

  await UserModel.create({
    organizationId: platform._id,
    firstName: 'Super',
    lastName: 'Admin',
    email: normalized,
    passwordHash: await hashPassword(password),
    roleId: role._id,
  });
  return { created: true, organizationId: platform._id };
}

export async function getOrganization(id: Types.ObjectId | string) {
  const org = await OrganizationModel.findOne({ _id: id, isPlatform: false })
    .select(PUBLIC_FIELDS)
    .lean();
  if (!org) throw ApiError.notFound('Organization');
  return org;
}

export async function listOrganizations(q: OrganizationListQuery) {
  const filter: Record<string, unknown> = { isPlatform: false };
  if (q.isActive !== undefined) filter.isActive = q.isActive;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { slug: rx }, { email: rx }];
  }
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    OrganizationModel.find(filter)
      .select(PUBLIC_FIELDS)
      .sort(toSort(q.sortBy, q.sortOrder))
      .skip(skip)
      .limit(limit)
      .lean(),
    OrganizationModel.countDocuments(filter),
  ]);
  return { items, pagination: buildPagination(q.page, q.limit, total) };
}

export async function updateOrganization(
  ctx: ServiceContext,
  id: Types.ObjectId | string,
  input: z.infer<typeof updateOrganizationBody>,
) {
  const before = await getOrganization(id);
  const { settings, ...profile } = input;
  const update: Record<string, unknown> = { ...profile, updatedBy: ctx.userId };
  // Merge settings field-by-field so partial updates don't wipe other settings.
  for (const [k, v] of Object.entries(settings ?? {}))
    if (v !== undefined) update[`settings.${k}`] = v;
  await OrganizationModel.updateOne({ _id: before._id }, update, { runValidators: true });
  invalidateOrgSettings(before._id);
  const after = await getOrganization(id);

  const changes = diffFields(before, {
    ...profile,
    ...(settings ? { settings: after.settings } : {}),
  });
  if (changes) {
    await recordAudit(
      { ...ctx, organizationId: before._id },
      {
        entityType: 'organization',
        entityId: before._id,
        action: 'organization.updated',
        ...changes,
      },
    );
  }
  return after;
}

export async function setOrganizationActive(ctx: ServiceContext, id: string, isActive: boolean) {
  const before = await getOrganization(id);
  if (before.isActive === isActive) return before;
  await OrganizationModel.updateOne({ _id: before._id }, { isActive, updatedBy: ctx.userId });
  await recordAudit(
    { ...ctx, organizationId: before._id },
    {
      entityType: 'organization',
      entityId: before._id,
      action: isActive ? 'organization.activated' : 'organization.deactivated',
      oldValue: { isActive: before.isActive },
      newValue: { isActive },
    },
  );
  return getOrganization(id);
}
