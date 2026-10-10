import type { CookieOptions, Request, Response } from 'express';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { z } from '../../docs/zod.js';
import { extractBearer } from '../../middlewares/auth.middleware.js';
import { credentialLimiter, demoLimiter, refreshLimiter, twoFactorLimiter } from '../../middlewares/rateLimit.middleware.js';
import type { RequestMeta } from '../../types/auth.js';
import { demoLogin, demoStatus } from '../demo/demo.service.js';
import { demoLoginBody } from '../demo/demo.validation.js';
import { reauthCodeBody, securityDto, setupBody, setupDto, verifyLoginBody, verifyRecoveryBody, verifySetupBody } from '../security/security.validation.js';
import * as twoFactor from '../security/twoFactor.service.js';
import { resolveAuthContext } from './authContext.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { createModuleRouter } from '../../utils/router.js';
import * as auth from './auth.service.js';
import {
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  loginDto,
  meDto,
  refreshBody,
  resetPasswordBody,
  sessionDto,
  sessionIdParams,
  tokensDto,
  updateProfileBody,
} from './auth.validation.js';

const m = createModuleRouter('/auth', 'Auth');

export const REFRESH_COOKIE = 'crm_rt';
const cookieOptions = (persistent = true): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/v1/auth',
  // Without "remember me" the cookie lives only as long as the browser session.
  ...(persistent ? { maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000 } : {}),
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});
const SESSION_ONLY = 'crm_rs';

function readRefreshToken(req: Request, bodyToken?: string): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return bodyToken ?? cookies?.[REFRESH_COOKIE];
}

/** Web clients get the refresh token only as an httpOnly cookie; mobile clients get it in the body. */
function deliverTokens(res: Response, tokens: auth.IssuedTokens, viaCookie: boolean, rememberMe = true) {
  if (viaCookie) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(rememberMe));
    // Remembered so refresh rotations keep the same cookie lifetime.
    if (rememberMe) res.clearCookie(SESSION_ONLY, { ...cookieOptions(), maxAge: undefined });
    else res.cookie(SESSION_ONLY, '1', cookieOptions(false));
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }
  return tokens;
}

m.publicRoute({
  method: 'post',
  path: '/login',
  summary: 'Sign in with email and password',
  description:
    'When the account needs a second factor the response has `status: two_factor_required` (or ' +
    '`two_factor_enrollment_required` when 2FA is mandatory and not set up) with a short-lived, single-use ' +
    '`challengeToken` and **no tokens**; finish with `/auth/2fa/verify-login`, `/auth/2fa/verify-recovery-code` or the ' +
    'setup endpoints. A challenge token cannot call any other API. Errors never reveal whether the account exists.',
  body: loginBody,
  response: loginDto,
  middlewares: [credentialLimiter],
  handler: async ({ body, res, meta }) => {
    const result = await auth.login(body, meta);
    if (result.status !== 'authenticated') {
      return {
        message: result.status === 'two_factor_required' ? 'Enter the code from your authenticator app' : 'Set up two-factor authentication to continue',
        data: result,
      };
    }
    return {
      message: 'Signed in successfully',
      data: { status: result.status, ...deliverTokens(res, result.tokens, body.platform === 'web', body.rememberMe), user: result.user },
    };
  },
});

/** Finishes a sign-in after every factor passed and delivers tokens the same way /login does. */
async function finishLogin(res: Response, challenge: { userId: Types.ObjectId; organizationId: Types.ObjectId; platform?: string | null; deviceName?: string | null; rememberMe?: boolean | null }, meta: RequestMeta) {
  const platform = (challenge.platform ?? 'web') as 'web' | 'android' | 'ios' | 'other';
  const { tokens, user } = await auth.startSession({ _id: challenge.userId, organizationId: challenge.organizationId }, { platform, deviceName: challenge.deviceName ?? undefined }, meta);
  return { status: 'authenticated' as const, ...deliverTokens(res, tokens, platform === 'web', challenge.rememberMe ?? true), user };
}

m.publicRoute({
  method: 'post',
  path: '/2fa/verify-login',
  summary: 'Second sign-in step: verify a TOTP code against the challenge and receive tokens',
  description: 'Codes are single use (replay-protected); a challenge allows 5 attempts and expires after 5 minutes.',
  body: verifyLoginBody,
  response: loginDto,
  middlewares: [twoFactorLimiter],
  handler: async ({ body, res, meta }) => {
    const challenge = await twoFactor.verifyChallengeCode(body.challengeToken, { code: body.code }, meta);
    return { message: 'Signed in successfully', data: await finishLogin(res, challenge, meta) };
  },
});

m.publicRoute({
  method: 'post',
  path: '/2fa/verify-recovery-code',
  summary: 'Second sign-in step with a single-use recovery code (when the authenticator is unavailable)',
  body: verifyRecoveryBody,
  response: loginDto,
  middlewares: [twoFactorLimiter],
  handler: async ({ body, res, meta }) => {
    const challenge = await twoFactor.verifyChallengeCode(body.challengeToken, { recoveryCode: body.recoveryCode }, meta);
    return { message: 'Signed in with a recovery code. Consider generating new codes.', data: await finishLogin(res, challenge, meta) };
  },
});

/**
 * Setup works signed in (Bearer token + current password) or during sign-in with an enrollment challenge
 * (mandatory 2FA, grace period over). The router's public variant is used so both are possible; the
 * handler authenticates explicitly.
 */
async function setupActor(req: Request, challengeToken: string | undefined, meta: RequestMeta) {
  if (challengeToken) {
    const challenge = await twoFactor.useChallenge(challengeToken, 'enroll');
    return { actor: { organizationId: challenge.organizationId, userId: challenge.userId, meta }, challenge };
  }
  const bearer = extractBearer(req.headers.authorization);
  if (!bearer) throw ApiError.unauthorized();
  const ctx = await resolveAuthContext(bearer);
  if (ctx.isDemo) throw new ApiError(403, 'This is a read-only demo. Changes are not saved.', [], 'DEMO_READ_ONLY');
  return { actor: { organizationId: ctx.organizationId, userId: ctx.userId, meta }, challenge: null };
}

m.publicRoute({
  method: 'post',
  path: '/2fa/setup',
  summary: 'Start 2FA enrollment: returns a QR code and manual key for Google/Microsoft Authenticator',
  description: 'Send `Authorization: Bearer` + `password`, or the enrollment `challengeToken` from sign-in.',
  body: setupBody,
  response: setupDto,
  middlewares: [twoFactorLimiter],
  handler: async ({ req, body, meta }) => {
    const { actor, challenge } = await setupActor(req, body.challengeToken, meta);
    return { data: await twoFactor.startSetup(actor, { password: body.password, viaChallenge: !!challenge }) };
  },
});

m.publicRoute({
  method: 'post',
  path: '/2fa/verify-setup',
  summary: 'Confirm enrollment with the first code; returns recovery codes (shown once) — and tokens when finishing a sign-in',
  body: verifySetupBody,
  response: z.object({ recoveryCodes: z.array(z.string()) }).catchall(z.unknown()),
  middlewares: [twoFactorLimiter],
  handler: async ({ req, res, body, meta }) => {
    const { actor, challenge } = await setupActor(req, body.challengeToken, meta);
    const { recoveryCodes } = await twoFactor.confirmSetup(actor, body.code);
    if (!challenge) return { message: 'Two-factor authentication is on', data: { recoveryCodes } };
    await twoFactor.completeChallenge(challenge._id);
    return { message: 'Two-factor authentication is on', data: { recoveryCodes, ...(await finishLogin(res, challenge, meta)) } };
  },
});

m.route({
  method: 'get',
  path: '/security',
  summary: 'My security settings: 2FA status, recovery codes left and the policy that applies to me',
  response: securityDto,
  handler: async ({ ctx }) => ({ data: await twoFactor.securityStatus(ctx) }),
});

m.route({
  method: 'post',
  path: '/2fa/disable',
  summary: 'Turn 2FA off (only when policy allows; needs password and a current code)',
  body: reauthCodeBody,
  response: z.null(),
  middlewares: [twoFactorLimiter],
  handler: async ({ ctx, body }) => {
    await twoFactor.disableTwoFactor(ctx, body);
    return { message: 'Two-factor authentication is off', data: null };
  },
});

m.route({
  method: 'post',
  path: '/2fa/recovery-codes/regenerate',
  summary: 'Replace all recovery codes (old ones stop working); needs password and a current code',
  body: reauthCodeBody,
  response: z.object({ recoveryCodes: z.array(z.string()) }),
  middlewares: [twoFactorLimiter],
  handler: async ({ ctx, body }) => ({ message: 'New recovery codes generated', data: await twoFactor.regenerateRecoveryCodes(ctx, body) }),
});

m.publicRoute({
  method: 'post',
  path: '/demo',
  summary: 'Sign in to the public read-only demo (only when DEMO_ENABLED=true)',
  description: 'Personas: admin, manager, counsellor. Demo sessions cannot change data and never reach other organizations.',
  body: demoLoginBody,
  response: loginDto,
  middlewares: [demoLimiter],
  handler: async ({ body, res, meta }) => {
    const { tokens, user } = await demoLogin(body, meta);
    return { message: 'Welcome to the demo', data: { status: 'authenticated' as const, ...deliverTokens(res, tokens, body.platform === 'web'), user } };
  },
});

m.publicRoute({
  method: 'post',
  path: '/refresh',
  summary: 'Exchange a refresh token for a new access token (rotates the refresh token)',
  body: refreshBody,
  response: tokensDto,
  middlewares: [refreshLimiter],
  handler: async ({ req, res, body, meta }) => {
    const token = readRefreshToken(req, body.refreshToken);
    if (!token) throw ApiError.unauthorized('Refresh token missing');
    const tokens = await auth.refresh(token, meta);
    const sessionOnly = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_ONLY] === '1';
    return { message: 'Token refreshed', data: deliverTokens(res, tokens, !body.refreshToken, !sessionOnly) };
  },
});

m.publicRoute({
  method: 'post',
  path: '/logout',
  summary: 'Sign out the current device',
  description:
    'Revokes the session identified by the refresh token (cookie or body). Works with an expired access token.',
  body: refreshBody,
  response: z.null(),
  handler: async ({ req, res, body }) => {
    const token = readRefreshToken(req, body.refreshToken);
    if (token) await auth.logoutByRefreshToken(token);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    res.clearCookie(SESSION_ONLY, { ...cookieOptions(), maxAge: undefined });
    return { message: 'Signed out', data: null };
  },
});

m.route({
  method: 'post',
  path: '/logout-all',
  summary: 'Sign out from all devices',
  response: z.object({ revokedSessions: z.number() }),
  handler: async ({ ctx, res }) => {
    const revokedSessions = await auth.logoutAll(ctx);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    return { message: 'Signed out from all devices', data: { revokedSessions } };
  },
});

m.route({
  method: 'get',
  path: '/me',
  summary: 'Current user with role, permissions, branches and organization',
  description:
    'Clients should drive role-based UI from `permissions`; the API enforces them regardless.',
  response: meDto,
  handler: async ({ ctx }) => ({ data: await auth.getCurrentUser(ctx.userId, ctx.organizationId) }),
});

m.route({
  method: 'patch',
  path: '/me',
  summary: 'Update own profile (name, phone, designation)',
  body: updateProfileBody,
  response: meDto,
  handler: async ({ ctx, body }) => ({ message: 'Profile updated', data: await auth.updateProfile(ctx, body) }),
});

m.route({
  method: 'post',
  path: '/change-password',
  summary: 'Change own password (signs out other devices)',
  body: changePasswordBody,
  response: tokensDto,
  middlewares: [credentialLimiter],
  handler: async ({ ctx, body }) => ({
    message: 'Password changed',
    data: await auth.changePassword(ctx, body),
  }),
});

m.publicRoute({
  method: 'post',
  path: '/forgot-password',
  summary: 'Email a password reset link',
  description: 'Always responds with success so it cannot be used to discover registered emails.',
  body: forgotPasswordBody,
  response: z.null(),
  middlewares: [credentialLimiter],
  handler: async ({ body, meta }) => {
    await auth.forgotPassword(body.email, meta);
    return {
      message: 'If an account exists for this email, a reset link has been sent',
      data: null,
    };
  },
});

m.publicRoute({
  method: 'post',
  path: '/reset-password',
  summary: 'Set a new password using a reset token (signs out all devices)',
  body: resetPasswordBody,
  response: z.null(),
  middlewares: [credentialLimiter],
  handler: async ({ body, meta }) => {
    await auth.resetPassword(body, meta);
    return { message: 'Password has been reset. Please sign in.', data: null };
  },
});

m.route({
  method: 'get',
  path: '/sessions',
  summary: 'List my active sessions (devices)',
  response: z.array(sessionDto),
  handler: async ({ ctx }) => ({ data: await auth.listSessions(ctx) }),
});

m.route({
  method: 'delete',
  path: '/sessions/:id',
  summary: 'Revoke one of my sessions',
  params: sessionIdParams,
  response: z.null(),
  handler: async ({ ctx, params }) => {
    await auth.revokeSession(ctx, params.id);
    return { message: 'Session revoked', data: null };
  },
});

m.publicRoute({
  method: 'get',
  path: '/demo',
  summary: 'Is the public demo available? (landing page uses this to show "Live demo")',
  response: z.object({ enabled: z.boolean(), ready: z.boolean(), personas: z.array(z.string()) }),
  handler: async () => ({ data: await demoStatus() }),
});

export const authModule = m;
