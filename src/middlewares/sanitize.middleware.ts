import type { NextFunction, Request, Response } from 'express';

/**
 * Removes keys that MongoDB could interpret as operators ("$gt") or paths ("a.b")
 * from body, query and params. Zod validation runs afterwards as the second line of defense.
 */
function clean(value: unknown, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        k.startsWith('$') ||
        k.includes('.') ||
        k === '__proto__' ||
        k === 'constructor' ||
        k === 'prototype'
      )
        continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeRequest(req: Request, _res: Response, next: NextFunction): void {
  if (req.body) req.body = clean(req.body);
  // Express 5 exposes req.query as a getter; replace it with a sanitized own property.
  Object.defineProperty(req, 'query', {
    value: clean(req.query),
    writable: true,
    configurable: true,
  });
  next();
}
