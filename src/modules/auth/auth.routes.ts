import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { z } from '../../docs/zod.js';
import { credentialLimiter, refreshLimiter } from '../../middlewares/rateLimit.middleware.js';
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
const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

function readRefreshToken(req: Request, bodyToken?: string): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return bodyToken ?? cookies?.[REFRESH_COOKIE];
}

/** Web clients get the refresh token only as an httpOnly cookie; mobile clients get it in the body. */
function deliverTokens(res: Response, tokens: auth.IssuedTokens, viaCookie: boolean) {
  if (viaCookie) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions());
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }
  return tokens;
}

m.publicRoute({
  method: 'post',
  path: '/login',
  summary: 'Sign in with email and password',
  body: loginBody,
  response: loginDto,
  middlewares: [credentialLimiter],
  handler: async ({ body, res, meta }) => {
    const { tokens, user } = await auth.login(body, meta);
    return {
      message: 'Signed in successfully',
      data: { ...deliverTokens(res, tokens, body.platform === 'web'), user },
    };
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
    return { message: 'Token refreshed', data: deliverTokens(res, tokens, !body.refreshToken) };
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

export const authModule = m;
