import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { env } from '../../config/env.js';
import type { RequestMeta, ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { decryptSecret, encryptSecret, hashToken, randomToken } from '../../utils/crypto.js';
import { verifyPassword } from '../../utils/password.js';
import { recordAudit } from '../audit/audit.service.js';
import { revokeSessions } from '../auth/auth.service.js';
import { UserModel } from '../users/user.model.js';
import { policyForOrganization, requirementFor } from './policy.js';
import { TwoFactorChallengeModel } from './twoFactorChallenge.model.js';

const PENDING_SETUP_MS = 15 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
/** One 30-second step either side, for phone clocks that drift a little. */
const EPOCH_TOLERANCE_SECONDS = 30;
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type Actor = { organizationId: Types.ObjectId; userId: Types.ObjectId; meta: RequestMeta };

// ---------------------------------------------------------------- secrets & codes

/** Secrets are bound to their user: a ciphertext copied onto another account does not decrypt as valid. */
const seal = (userId: Types.ObjectId, secret: string) => encryptSecret(`${userId.toString()}:${secret}`);
function unseal(userId: Types.ObjectId, sealed: string): string {
  const plain = decryptSecret(sealed);
  const prefix = `${userId.toString()}:`;
  if (!plain.startsWith(prefix)) throw new Error('Two-factor secret does not belong to this user');
  return plain.slice(prefix.length);
}

const normalizeCode = (code: string) => code.replace(/\s+/g, '');
const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = randomBytes(10);
    const chars = [...bytes].map((b) => BASE32[b % BASE32.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
  });
}

/** Verifies a 6-digit TOTP code and returns its time step, or null. */
async function checkTotp(secret: string, code: string, afterTimeStep?: number | null): Promise<number | null> {
  const token = normalizeCode(code);
  if (!/^\d{6}$/.test(token)) return null;
  const result = await verify({ secret, token, epochTolerance: EPOCH_TOLERANCE_SECONDS, ...(afterTimeStep ? { afterTimeStep } : {}) });
  return result.valid ? ((result as { timeStep?: number }).timeStep ?? Math.floor(Date.now() / 30_000)) : null;
}

/**
 * Accepts a code for an enrolled user once: the time step is recorded with a conditional update,
 * so the same code (or an older one) can't be replayed, even by two simultaneous requests.
 */
async function consumeTotp(user: { _id: Types.ObjectId; organizationId: Types.ObjectId }, code: string): Promise<boolean> {
  const doc = await UserModel.findOne({ organizationId: user.organizationId, _id: user._id }).select('+twoFactor.secretEnc +twoFactor.lastUsedStep twoFactor.enabled').lean();
  if (!doc?.twoFactor?.enabled || !doc.twoFactor.secretEnc) return false;
  const step = await checkTotp(unseal(user._id, doc.twoFactor.secretEnc), code, doc.twoFactor.lastUsedStep);
  if (step === null) return false;
  const res = await UserModel.updateOne(
    { organizationId: user.organizationId, _id: user._id, $or: [{ 'twoFactor.lastUsedStep': null }, { 'twoFactor.lastUsedStep': { $lt: step } }] },
    { $set: { 'twoFactor.lastUsedStep': step } },
  );
  return res.modifiedCount === 1;
}

/** Marks one unused recovery code as used (atomic). */
async function consumeRecoveryCode(user: { _id: Types.ObjectId; organizationId: Types.ObjectId }, code: string): Promise<boolean> {
  const normalized = normalizeRecovery(code);
  if (normalized.length !== 10) return false;
  const res = await UserModel.updateOne(
    { organizationId: user.organizationId, _id: user._id, 'twoFactor.enabled': true, 'twoFactor.recoveryCodes': { $elemMatch: { hash: hashToken(normalized), usedAt: null } } },
    { $set: { 'twoFactor.recoveryCodes.$.usedAt': new Date() } },
  );
  return res.modifiedCount === 1;
}

async function requirePassword(actor: Actor, password: string | undefined) {
  if (!password) throw ApiError.validation([{ field: 'body.password', message: 'Enter your current password to continue' }]);
  const user = await UserModel.findOne({ organizationId: actor.organizationId, _id: actor.userId }).select('+passwordHash').lean();
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    await recordAudit(actor, { entityType: 'user', entityId: actor.userId, action: 'auth.reauthentication_failed' });
    throw ApiError.validation([{ field: 'body.password', message: 'Password is incorrect' }]);
  }
}

// ---------------------------------------------------------------- status

export async function securityStatus(ctx: Pick<ServiceContext, 'organizationId' | 'userId'>) {
  const [user, policy] = await Promise.all([
    UserModel.findOne({ organizationId: ctx.organizationId, _id: ctx.userId }).select('twoFactor.enabled twoFactor.enabledAt twoFactor.pendingCreatedAt twoFactor.recoveryCodesGeneratedAt +twoFactor.recoveryCodes createdAt').lean(),
    policyForOrganization(ctx.organizationId),
  ]);
  if (!user) throw ApiError.notFound('User');
  const tf = user.twoFactor;
  const req = requirementFor(policy, { enabled: tf?.enabled, createdAt: user.createdAt });
  return {
    twoFactor: {
      enabled: !!tf?.enabled,
      enabledAt: tf?.enabledAt ?? null,
      pendingSetup: !!tf?.pendingCreatedAt && Date.now() - tf.pendingCreatedAt.getTime() < PENDING_SETUP_MS,
      recoveryCodesRemaining: tf?.enabled ? (tf.recoveryCodes ?? []).filter((c) => !c.usedAt).length : 0,
      recoveryCodesGeneratedAt: tf?.recoveryCodesGeneratedAt ?? null,
      policy: {
        available: policy.available,
        mode: policy.mode,
        source: policy.source,
        canDisable: policy.canDisable,
        required: policy.mode === 'mandatory',
        enrollmentRequiredBy: req.enrollBy,
        enrollmentOverdue: req.enrollNow,
      },
    },
  };
}

// ---------------------------------------------------------------- enrollment

/**
 * Starts enrollment: a fresh secret is stored (encrypted) as pending until the first code is
 * verified. Signed-in users confirm their password first; a sign-in enrollment challenge already did.
 */
export async function startSetup(actor: Actor, opts: { password?: string | undefined; viaChallenge: boolean }) {
  const policy = await policyForOrganization(actor.organizationId);
  if (!policy.available) throw ApiError.forbidden('Two-factor authentication is turned off for this platform');
  if (!opts.viaChallenge) await requirePassword(actor, opts.password);
  const user = await UserModel.findOne({ organizationId: actor.organizationId, _id: actor.userId }).select('email twoFactor.enabled').lean();
  if (!user) throw ApiError.notFound('User');
  if (user.twoFactor?.enabled) throw ApiError.conflict('Two-factor authentication is already on. Turn it off first to set up a new device.');

  const secret = generateSecret();
  await UserModel.updateOne(
    { organizationId: actor.organizationId, _id: actor.userId },
    { $set: { 'twoFactor.pendingSecretEnc': seal(actor.userId, secret), 'twoFactor.pendingCreatedAt': new Date() } },
  );
  const otpauthUrl = generateURI({ issuer: env.APP_NAME, label: user.email, secret });
  await recordAudit(actor, { entityType: 'user', entityId: actor.userId, action: 'auth.2fa_setup_started' });
  return {
    otpauthUrl,
    qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 }),
    manualKey: secret.match(/.{1,4}/g)!.join(' '),
    expiresIn: PENDING_SETUP_MS / 1000,
  };
}

/** Activates 2FA after the first valid code and returns single-use recovery codes (shown once). */
export async function confirmSetup(actor: Actor, code: string) {
  const user = await UserModel.findOne({ organizationId: actor.organizationId, _id: actor.userId }).select('+twoFactor.pendingSecretEnc twoFactor.pendingCreatedAt twoFactor.enabled').lean();
  const pending = user?.twoFactor?.pendingSecretEnc;
  if (!user || !pending || !user.twoFactor?.pendingCreatedAt || Date.now() - user.twoFactor.pendingCreatedAt.getTime() > PENDING_SETUP_MS) {
    throw ApiError.badRequest('Setup expired or was not started. Start again to get a new QR code.');
  }
  const secret = unseal(actor.userId, pending);
  const step = await checkTotp(secret, code);
  if (step === null) throw ApiError.validation([{ field: 'body.code', message: 'That code is not valid. Check the time on your phone and try the newest code.' }]);

  const codes = newRecoveryCodes();
  const res = await UserModel.updateOne(
    { organizationId: actor.organizationId, _id: actor.userId, 'twoFactor.pendingSecretEnc': pending },
    {
      $set: {
        'twoFactor.enabled': true,
        'twoFactor.enabledAt': new Date(),
        'twoFactor.secretEnc': seal(actor.userId, secret),
        'twoFactor.lastUsedStep': step,
        'twoFactor.recoveryCodes': codes.map((c) => ({ hash: hashToken(normalizeRecovery(c)), usedAt: null })),
        'twoFactor.recoveryCodesGeneratedAt': new Date(),
      },
      $unset: { 'twoFactor.pendingSecretEnc': 1, 'twoFactor.pendingCreatedAt': 1 },
    },
  );
  if (!res.modifiedCount) throw ApiError.conflict('Setup changed in the meantime; start again');
  await recordAudit(actor, { entityType: 'user', entityId: actor.userId, action: 'auth.2fa_enabled' });
  return { recoveryCodes: codes };
}

export async function disableTwoFactor(actor: Actor, input: { password: string; code: string }) {
  const policy = await policyForOrganization(actor.organizationId);
  if (!policy.canDisable) throw ApiError.forbidden('Two-factor authentication is required for your organization and cannot be turned off');
  await requirePassword(actor, input.password);
  const self = { _id: actor.userId, organizationId: actor.organizationId };
  if (!(await consumeTotp(self, input.code)) && !(await consumeRecoveryCode(self, input.code))) {
    throw ApiError.validation([{ field: 'body.code', message: 'That code is not valid' }]);
  }
  await UserModel.updateOne(
    { organizationId: actor.organizationId, _id: actor.userId },
    { $set: { 'twoFactor.enabled': false }, $unset: { 'twoFactor.secretEnc': 1, 'twoFactor.lastUsedStep': 1, 'twoFactor.recoveryCodes': 1, 'twoFactor.enabledAt': 1 } },
  );
  await recordAudit(actor, { entityType: 'user', entityId: actor.userId, action: 'auth.2fa_disabled' });
}

export async function regenerateRecoveryCodes(actor: Actor, input: { password: string; code: string }) {
  await requirePassword(actor, input.password);
  if (!(await consumeTotp({ _id: actor.userId, organizationId: actor.organizationId }, input.code))) {
    throw ApiError.validation([{ field: 'body.code', message: 'Enter a current code from your authenticator app' }]);
  }
  const codes = newRecoveryCodes();
  await UserModel.updateOne(
    { organizationId: actor.organizationId, _id: actor.userId },
    { $set: { 'twoFactor.recoveryCodes': codes.map((c) => ({ hash: hashToken(normalizeRecovery(c)), usedAt: null })), 'twoFactor.recoveryCodesGeneratedAt': new Date() } },
  );
  await recordAudit(actor, { entityType: 'user', entityId: actor.userId, action: 'auth.2fa_recovery_codes_regenerated' });
  return { recoveryCodes: codes };
}

// ---------------------------------------------------------------- sign-in challenges

export async function issueChallenge(
  user: { _id: Types.ObjectId; organizationId: Types.ObjectId },
  purpose: 'verify' | 'enroll',
  client: { platform: 'web' | 'android' | 'ios' | 'other'; deviceName?: string | undefined; rememberMe?: boolean | undefined },
) {
  const token = randomToken(32);
  await TwoFactorChallengeModel.create({
    tokenHash: hashToken(token),
    userId: user._id,
    organizationId: user.organizationId,
    purpose,
    platform: client.platform,
    deviceName: client.deviceName,
    rememberMe: client.rememberMe ?? true,
    expiresAt: new Date(Date.now() + CHALLENGE_MS),
  });
  return { challengeToken: token, expiresIn: CHALLENGE_MS / 1000 };
}

/**
 * Loads a live challenge for `purpose` and counts the attempt. Expired, used or exhausted challenges
 * are rejected with one generic message (the client starts again from the password).
 */
export async function useChallenge(token: string, purpose: 'verify' | 'enroll') {
  const challenge = await TwoFactorChallengeModel.findOneAndUpdate(
    { tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_CHALLENGE_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!challenge) throw new ApiError(401, 'This sign-in attempt has expired. Please sign in again.', [], 'TWO_FACTOR_CHALLENGE_INVALID');
  return challenge;
}

/** Marks the challenge used; only one request can win (single use). */
export async function completeChallenge(challengeId: Types.ObjectId): Promise<void> {
  const res = await TwoFactorChallengeModel.updateOne({ _id: challengeId, usedAt: null }, { usedAt: new Date() });
  if (!res.modifiedCount) throw new ApiError(401, 'This sign-in attempt has expired. Please sign in again.', [], 'TWO_FACTOR_CHALLENGE_INVALID');
}

/** Checks a TOTP or recovery code against a verify challenge (policy re-checked at verification time). */
export async function verifyChallengeCode(token: string, input: { code?: string | undefined; recoveryCode?: string | undefined }, meta: RequestMeta) {
  const challenge = await useChallenge(token, 'verify');
  const user = { _id: challenge.userId, organizationId: challenge.organizationId };
  const actor: Actor = { organizationId: challenge.organizationId, userId: challenge.userId, meta };
  const ok = input.recoveryCode ? await consumeRecoveryCode(user, input.recoveryCode) : input.code ? await consumeTotp(user, input.code) : false;
  if (!ok) {
    await recordAudit(actor, { entityType: 'user', entityId: challenge.userId, action: input.recoveryCode ? 'auth.2fa_recovery_failed' : 'auth.2fa_failed' });
    const left = MAX_CHALLENGE_ATTEMPTS - challenge.attempts;
    throw new ApiError(401, left > 0 ? 'That code is not valid. Try again.' : 'Too many invalid codes. Please sign in again.', [], 'TWO_FACTOR_CODE_INVALID', { attemptsLeft: Math.max(0, left) });
  }
  await completeChallenge(challenge._id);
  await recordAudit(actor, { entityType: 'user', entityId: challenge.userId, action: input.recoveryCode ? 'auth.2fa_recovery_code_used' : 'auth.2fa_verified' });
  return challenge;
}

// ---------------------------------------------------------------- administration

/** Super Admin: list users with their 2FA status (across organizations). */
export async function listUsersTwoFactor(q: { organizationId?: string | undefined; status?: 'enabled' | 'disabled' | undefined; search?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = {};
  if (q.organizationId) filter.organizationId = new Types.ObjectId(q.organizationId);
  if (q.status === 'enabled') filter['twoFactor.enabled'] = true;
  if (q.status === 'disabled') filter['twoFactor.enabled'] = { $ne: true };
  if (q.search) filter.email = { $regex: `^${q.search.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  const [items, total] = await Promise.all([
    UserModel.find(filter)
      .setOptions({ skipTenantGuard: true })
      .select('fullName email organizationId isActive lastLoginAt twoFactor.enabled twoFactor.enabledAt twoFactor.resetAt createdAt')
      .populate({ path: 'organizationId', select: 'name slug security' })
      .sort({ email: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    UserModel.countDocuments(filter).setOptions({ skipTenantGuard: true }),
  ]);
  return { items, total };
}

/**
 * Super Admin: authorized reset for a user who lost their device. The secret and recovery codes are
 * removed, every session is signed out, and the user must enroll again (if required) at next sign-in.
 */
export async function resetUserTwoFactor(ctx: ServiceContext, userId: string, reason: string) {
  const user = await UserModel.findOne({ _id: userId }).setOptions({ skipTenantGuard: true }).select('organizationId email twoFactor.enabled').lean();
  if (!user) throw ApiError.notFound('User');
  await UserModel.updateOne(
    { organizationId: user.organizationId, _id: user._id },
    {
      $set: { 'twoFactor.enabled': false, 'twoFactor.resetAt': new Date(), 'twoFactor.resetBy': ctx.userId },
      $unset: { 'twoFactor.secretEnc': 1, 'twoFactor.pendingSecretEnc': 1, 'twoFactor.pendingCreatedAt': 1, 'twoFactor.lastUsedStep': 1, 'twoFactor.recoveryCodes': 1, 'twoFactor.enabledAt': 1 },
    },
  );
  await revokeSessions({ userId: user._id }, 'two_factor_reset');
  const entry = { entityType: 'user', entityId: user._id, action: 'security.2fa_reset', metadata: { reason, email: user.email, wasEnabled: !!user.twoFactor?.enabled, by: ctx.userId.toString() } };
  // Visible to the Super Admin's audit trail and to the user's organization.
  await recordAudit(ctx, entry);
  await recordAudit({ organizationId: user.organizationId, userId: ctx.userId, meta: ctx.meta }, entry);
}
