import type { NextFunction, Request, Response } from 'express';
import type { Permission, PLATFORM_MANAGE } from '../constants/permissions.js';
import { resolveAuthContext } from '../modules/auth/authContext.service.js';
import type { AuthContext } from '../types/auth.js';
import { ApiError } from '../utils/ApiError.js';

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/** All a user who must enroll in 2FA can do until they have. */
const ENROLLMENT_ROUTES = new Set(['GET /auth/me', 'GET /auth/security', 'POST /auth/2fa/setup', 'POST /auth/2fa/verify-setup', 'POST /auth/logout-all', 'POST /devices/register']);
/** Demo sessions are read-only; these writes only touch the visitor's own session/device. */
const DEMO_WRITABLE = new Set(['POST /devices/register', 'POST /notifications/read-all']);

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearer(req.headers.authorization);
    if (!token) throw ApiError.unauthorized();
    req.auth = await resolveAuthContext(token);
    const path = `${req.baseUrl}${req.path}`.replace(/^\/api\/v1/, '').replace(/\/$/, '');
    if (req.auth.twoFactorEnrollmentRequired && !ENROLLMENT_ROUTES.has(`${req.method} ${path}`)) {
      throw new ApiError(403, 'Set up two-factor authentication to continue', [], 'TWO_FACTOR_ENROLLMENT_REQUIRED');
    }
    if (req.auth.isDemo && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !DEMO_WRITABLE.has(`${req.method} ${path}`)) {
      throw new ApiError(403, 'This is a read-only demo. Changes are not saved.', [], 'DEMO_READ_ONLY');
    }
    next();
  } catch (err) {
    next(err);
  }
}

export type RequiredPermission = Permission | typeof PLATFORM_MANAGE;

export function hasPermissions(
  auth: AuthContext,
  required: readonly RequiredPermission[],
  mode: 'all' | 'any' = 'all',
) {
  if (required.length === 0) return true;
  return mode === 'all'
    ? required.every((p) => auth.permissions.has(p))
    : required.some((p) => auth.permissions.has(p));
}

export function authorize(required: readonly RequiredPermission[], mode: 'all' | 'any' = 'all') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!hasPermissions(req.auth, required, mode)) return next(ApiError.forbidden());
    next();
  };
}
