import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ALL_PERMISSIONS, PLATFORM_MANAGE } from '../../constants/permissions.js';
import { sendEmailSafe } from '../../integrations/email/index.js';
import type { RequestMeta, ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { hashToken, randomToken } from '../../utils/crypto.js';
import { normalizeEmail } from '../../utils/normalize.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { normalizePhone } from '../../utils/normalize.js';
import { BranchModel } from '../branches/branch.model.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from '../users/user.model.js';
import { SessionModel } from './session.model.js';
import { accessTokenTtlSeconds, signAccessToken } from './token.service.js';

const MAX_SESSIONS_PER_USER = 10;
const KEEP_PREVIOUS_HASHES = 5;
const INVALID_CREDENTIALS = 'Invalid email or password';

// Verifying against a real hash when the user does not exist keeps response timing uniform.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing-1'));

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function createSession(
  user: { _id: Types.ObjectId; organizationId: Types.ObjectId },
  client: { platform: 'web' | 'android' | 'ios' | 'other'; deviceName?: string | undefined },
  meta: RequestMeta,
): Promise<IssuedTokens> {
  const refreshToken = randomToken();
  const session = await SessionModel.create({
    userId: user._id,
    organizationId: user.organizationId,
    refreshTokenHash: hashToken(refreshToken),
    platform: client.platform,
    deviceName: client.deviceName,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    expiresAt: refreshExpiry(),
  });

  // Cap concurrent sessions: revoke the oldest beyond the limit.
  const stale = await SessionModel.find({ userId: user._id, revokedAt: null })
    .sort({ lastUsedAt: -1 })
    .skip(MAX_SESSIONS_PER_USER)
    .select('_id')
    .lean();
  if (stale.length) {
    await SessionModel.updateMany(
      { _id: { $in: stale.map((s) => s._id) } },
      { revokedAt: new Date(), revokedReason: 'session_limit' },
    );
  }

  return {
    accessToken: signAccessToken({
      userId: user._id.toString(),
      organizationId: user.organizationId.toString(),
      sessionId: session._id.toString(),
    }),
    refreshToken,
    expiresIn: accessTokenTtlSeconds(),
  };
}

export async function login(
  input: {
    email: string;
    password: string;
    platform: 'web' | 'android' | 'ios' | 'other';
    deviceName?: string | undefined;
  },
  meta: RequestMeta,
) {
  const user = await UserModel.findOne({ email: normalizeEmail(input.email) })
    .setOptions({ skipTenantGuard: true })
    .select('+passwordHash organizationId isActive')
    .lean();

  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await recordAudit(
      { organizationId: user.organizationId, userId: user._id, meta },
      { entityType: 'user', entityId: user._id, action: 'auth.login_failed' },
    );
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }
  if (!user.isActive)
    throw new ApiError(403, 'Your account has been deactivated', [], 'ACCOUNT_INACTIVE');

  const org = await OrganizationModel.findById(user.organizationId).select('isActive').lean();
  if (!org?.isActive)
    throw new ApiError(403, 'Your organization is inactive', [], 'ORGANIZATION_INACTIVE');

  const tokens = await createSession(user, input, meta);
  await UserModel.updateOne(
    { _id: user._id, organizationId: user.organizationId },
    { lastLoginAt: new Date() },
  );
  await recordAudit(
    { organizationId: user.organizationId, userId: user._id, meta },
    {
      entityType: 'user',
      entityId: user._id,
      action: 'auth.login',
      metadata: { platform: input.platform },
    },
  );
  return { tokens, user: await getCurrentUser(user._id, user.organizationId) };
}

/** Rotates the refresh token. Presenting an already-rotated token revokes the whole session. */
export async function refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
  const tokenHash = hashToken(refreshToken);
  const session = await SessionModel.findOne({ refreshTokenHash: tokenHash });

  if (!session) {
    const reused = await SessionModel.findOneAndUpdate(
      { previousTokenHashes: tokenHash, revokedAt: null },
      { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' },
    );
    if (reused) {
      await recordAudit(
        { organizationId: reused.organizationId, userId: reused.userId, meta },
        {
          entityType: 'session',
          entityId: reused._id,
          action: 'auth.refresh_token_reuse_detected',
        },
      );
    }
    throw ApiError.unauthorized('Invalid refresh token');
  }
  if (session.revokedAt || session.expiresAt < new Date())
    throw ApiError.unauthorized('Session has expired');

  const user = await UserModel.findOne({
    _id: session.userId,
    organizationId: session.organizationId,
  })
    .select('isActive')
    .lean();
  if (!user?.isActive) {
    session.revokedAt = new Date();
    session.revokedReason = 'user_inactive';
    await session.save();
    throw ApiError.unauthorized('Account is inactive');
  }

  const next = randomToken();
  // Conditional update guards against two concurrent refreshes both succeeding.
  const rotated = await SessionModel.findOneAndUpdate(
    { _id: session._id, refreshTokenHash: tokenHash, revokedAt: null },
    {
      refreshTokenHash: hashToken(next),
      $push: { previousTokenHashes: { $each: [tokenHash], $slice: -KEEP_PREVIOUS_HASHES } },
      lastUsedAt: new Date(),
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      expiresAt: refreshExpiry(),
    },
  );
  if (!rotated) throw ApiError.unauthorized('Invalid refresh token');

  return {
    accessToken: signAccessToken({
      userId: session.userId.toString(),
      organizationId: session.organizationId.toString(),
      sessionId: session._id.toString(),
    }),
    refreshToken: next,
    expiresIn: accessTokenTtlSeconds(),
  };
}

export async function logout(ctx: ServiceContext): Promise<void> {
  await revokeSessions({ _id: ctx.sessionId, userId: ctx.userId }, 'logout');
  await recordAudit(ctx, { entityType: 'user', entityId: ctx.userId, action: 'auth.logout' });
}

/** Logout via refresh token only (e.g. web client whose access token already expired). */
export async function logoutByRefreshToken(refreshToken: string): Promise<void> {
  await SessionModel.updateOne(
    { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
    { revokedAt: new Date(), revokedReason: 'logout' },
  );
}

export async function logoutAll(ctx: ServiceContext): Promise<number> {
  const count = await revokeSessions({ userId: ctx.userId }, 'logout_all');
  await recordAudit(ctx, {
    entityType: 'user',
    entityId: ctx.userId,
    action: 'auth.logout_all',
    metadata: { count },
  });
  return count;
}

export async function revokeSessions(
  filter: { userId: Types.ObjectId; _id?: string | Types.ObjectId | { $ne: string } },
  reason: string,
): Promise<number> {
  const res = await SessionModel.updateMany(
    { ...filter, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason },
  );
  return res.modifiedCount;
}

export async function getCurrentUser(userId: Types.ObjectId, organizationId: Types.ObjectId) {
  const user = await UserModel.findOne({ _id: userId, organizationId })
    .select('firstName lastName fullName email phone designation avatarUrl roleId branchIds')
    .lean();
  if (!user) throw ApiError.notFound('User');

  const [role, org, branches] = await Promise.all([
    RoleModel.findOne({ _id: user.roleId, organizationId })
      .select('key name dataScope permissions isSuperAdmin')
      .lean(),
    OrganizationModel.findById(organizationId).select('name slug settings').lean(),
    BranchModel.find({ organizationId, _id: { $in: user.branchIds }, isActive: true })
      .select('name code')
      .lean(),
  ]);
  if (!role || !org) throw ApiError.notFound('User');

  const permissions = role.isSuperAdmin ? [...ALL_PERMISSIONS, PLATFORM_MANAGE] : role.permissions;
  return {
    id: user._id.toString(),
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: user.fullName ?? user.firstName,
    email: user.email,
    phone: user.phone ?? undefined,
    designation: user.designation ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    isSuperAdmin: role.isSuperAdmin,
    organization: {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      settings: org.settings,
    },
    role: { id: role._id.toString(), key: role.key, name: role.name, dataScope: role.dataScope },
    permissions,
    branches: branches.map((b) => ({ id: b._id.toString(), name: b.name, code: b.code })),
  };
}

export async function changePassword(
  ctx: ServiceContext,
  input: { currentPassword: string; newPassword: string },
) {
  const user = await UserModel.findOne({
    _id: ctx.userId,
    organizationId: ctx.organizationId,
  }).select('+passwordHash');
  if (!user) throw ApiError.notFound('User');
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw ApiError.validation([
      { field: 'body.currentPassword', message: 'Current password is incorrect' },
    ]);
  }
  user.passwordHash = await hashPassword(input.newPassword);
  user.passwordChangedAt = new Date();
  await user.save();

  // Sign out every other device; the current one gets a fresh access token.
  await revokeSessions({ userId: ctx.userId, _id: { $ne: ctx.sessionId } }, 'password_changed');
  await recordAudit(ctx, {
    entityType: 'user',
    entityId: ctx.userId,
    action: 'auth.password_changed',
  });
  return {
    accessToken: signAccessToken({
      userId: ctx.userId.toString(),
      organizationId: ctx.organizationId.toString(),
      sessionId: ctx.sessionId,
    }),
    expiresIn: accessTokenTtlSeconds(),
  };
}

/** Always succeeds from the caller's point of view so the endpoint cannot be used to discover accounts. */
export async function forgotPassword(email: string, meta: RequestMeta): Promise<void> {
  const user = await UserModel.findOne({ email: normalizeEmail(email), isActive: true })
    .setOptions({ skipTenantGuard: true })
    .select('organizationId firstName email');
  if (!user) return;

  const token = randomToken(32);
  user.passwordReset = {
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
  };
  await user.save();

  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmailSafe({
    to: user.email,
    subject: 'Reset your password',
    text:
      `Hi ${user.firstName},\n\nUse the link below to reset your password. ` +
      `It expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes.\n\n${link}\n\n` +
      `If you did not request this, you can ignore this email.`,
  });
  await recordAudit(
    { organizationId: user.organizationId, userId: user._id, meta },
    { entityType: 'user', entityId: user._id, action: 'auth.password_reset_requested' },
  );
}

export async function resetPassword(
  input: { token: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  const user = await UserModel.findOne({
    'passwordReset.tokenHash': hashToken(input.token),
    'passwordReset.expiresAt': { $gt: new Date() },
  })
    .setOptions({ skipTenantGuard: true })
    .select('+passwordReset organizationId isActive');
  if (!user || !user.isActive)
    throw ApiError.badRequest('This reset link is invalid or has expired');

  user.passwordHash = await hashPassword(input.newPassword);
  user.passwordChangedAt = new Date();
  user.passwordReset = undefined;
  await user.save();

  await revokeSessions({ userId: user._id }, 'password_reset');
  await recordAudit(
    { organizationId: user.organizationId, userId: user._id, meta },
    { entityType: 'user', entityId: user._id, action: 'auth.password_reset' },
  );
}

export async function listSessions(ctx: ServiceContext) {
  const sessions = await SessionModel.find({
    userId: ctx.userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .select('platform deviceName ipAddress userAgent lastUsedAt createdAt')
    .lean();
  return sessions.map((s) => ({
    id: s._id.toString(),
    platform: s.platform,
    deviceName: s.deviceName ?? undefined,
    ipAddress: s.ipAddress ?? undefined,
    userAgent: s.userAgent ?? undefined,
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    current: s._id.toString() === ctx.sessionId,
  }));
}

export async function revokeSession(ctx: ServiceContext, sessionId: string): Promise<void> {
  const count = await revokeSessions({ userId: ctx.userId, _id: sessionId }, 'revoked_by_user');
  if (!count) throw ApiError.notFound('Session');
  await recordAudit(ctx, {
    entityType: 'session',
    entityId: new Types.ObjectId(sessionId),
    action: 'auth.session_revoked',
  });
}

/** Own profile (name, phone, designation). Role, branches and status stay admin-managed. */
export async function updateProfile(ctx: ServiceContext, input: { firstName?: string | undefined; lastName?: string | undefined; phone?: string | null | undefined; designation?: string | null | undefined }) {
  const user = await UserModel.findOne({ organizationId: ctx.organizationId, _id: ctx.userId });
  if (!user) throw ApiError.notFound('User');
  const before = { firstName: user.firstName, lastName: user.lastName, phone: user.phone, designation: user.designation };
  if (input.phone) {
    const { defaultCountryCode } = await getOrgSettings(ctx.organizationId);
    const normalized = normalizePhone(input.phone, defaultCountryCode);
    if (!normalized) throw ApiError.validation([{ field: 'body.phone', message: 'Invalid phone number' }]);
    input = { ...input, phone: normalized };
  }
  for (const [k, v] of Object.entries(input)) if (v !== undefined) user.set(k, v === null ? undefined : v);
  await user.save();
  const diff = diffFields(before, input as typeof before);
  if (diff) await recordAudit(ctx, { entityType: 'user', entityId: user._id, action: 'user.profile_updated', ...diff });
  return getCurrentUser(ctx.userId, ctx.organizationId);
}
