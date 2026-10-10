import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { extractBearer } from './auth.middleware.js';

/*
 * Limits are keyed by what they protect, not only by IP: a consultancy office usually shares
 * one public IP, so per-IP limits alone would make colleagues lock each other out.
 * Stores are in memory; use a Redis store (rate-limit-redis) when running multiple API instances.
 */

const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('base64url').slice(0, 22);
const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');

const common: Partial<Options> = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
};

/** Coarse flood protection per IP (generous enough for a whole office). */
export const ipLimiter = rateLimit({
  ...common,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_IP_MAX,
  keyGenerator: ipKey,
  handler: (_req, _res, next) => next(ApiError.tooManyRequests()),
});

/** Per signed-in session (keyed by access token); unauthenticated requests are left to ipLimiter. */
export const userLimiter = rateLimit({
  ...common,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  skip: (req) => env.NODE_ENV === 'test' || !extractBearer(req.headers.authorization),
  keyGenerator: (req) => `t:${fingerprint(extractBearer(req.headers.authorization) ?? '')}`,
  handler: (_req, _res, next) => next(ApiError.tooManyRequests()),
});

/** Brute-force protection for credential endpoints: per IP + target account. */
export const credentialLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const bearer = extractBearer(req.headers.authorization);
    return `${ipKey(req)}:${email ? fingerprint(email) : bearer ? fingerprint(bearer) : '-'}`;
  },
  handler: (_req, _res, next) =>
    next(ApiError.tooManyRequests('Too many attempts, please try again later')),
});

/** Token refresh happens on every page load, so it is limited per refresh token, not per IP. */
export const refreshLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: env.REFRESH_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    const body = req.body as { refreshToken?: unknown } | undefined;
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const token = typeof body?.refreshToken === 'string' ? body.refreshToken : cookies?.crm_rt;
    return token ? `r:${fingerprint(token)}` : `ip:${ipKey(req)}`;
  },
  handler: (_req, _res, next) => next(ApiError.tooManyRequests()),
});

/**
 * Second-factor attempts: per IP + challenge (or signed-in session). Each challenge also allows
 * only 5 tries before the user must start again from the password.
 */
export const twoFactorLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    const body = req.body as { challengeToken?: unknown } | undefined;
    const challenge = typeof body?.challengeToken === 'string' ? body.challengeToken : '';
    const bearer = extractBearer(req.headers.authorization) ?? '';
    return `2fa:${ipKey(req)}:${fingerprint(challenge || bearer || '-')}`;
  },
  handler: (_req, _res, next) => next(ApiError.tooManyRequests('Too many attempts, please try again later')),
});

/** Public demo sign-in: generous, but not a free-for-all. */
export const demoLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 30,
  keyGenerator: ipKey,
  handler: (_req, _res, next) => next(ApiError.tooManyRequests()),
});
