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

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearer(req.headers.authorization);
    if (!token) throw ApiError.unauthorized();
    req.auth = await resolveAuthContext(token);
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
