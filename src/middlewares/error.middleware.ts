import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { ApiError, type FieldError } from '../utils/ApiError.js';
import type { ErrorBody } from '../utils/apiResponse.js';

export function zodToFieldErrors(err: ZodError, prefix?: string): FieldError[] {
  return err.issues.map((issue) => ({
    field: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return ApiError.validation(zodToFieldErrors(err));
  if (err instanceof mongoose.Error.ValidationError) {
    return ApiError.validation(
      Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    );
  }
  if (err instanceof mongoose.Error.CastError)
    return ApiError.badRequest(`Invalid value for ${err.path}`);
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) {
    const keyValue =
      'keyValue' in err && err.keyValue && typeof err.keyValue === 'object' ? err.keyValue : {};
    const fields = Object.keys(keyValue).filter((k) => k !== 'organizationId');
    return ApiError.conflict(
      `A record with this ${fields.join(', ') || 'value'} already exists`,
      fields.map((field) => ({ field, message: 'Already exists' })),
    );
  }
  if (err instanceof SyntaxError && 'body' in err)
    return ApiError.badRequest('Malformed JSON body');
  if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large') {
    return new ApiError(413, 'Request body too large', [], 'PAYLOAD_TOO_LARGE');
  }
  return new ApiError(500, 'Something went wrong', [], 'INTERNAL_ERROR');
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, `Route ${req.method} ${req.path} not found`, [], 'ROUTE_NOT_FOUND'));
}

// Express identifies error middleware by arity, so all four parameters are required.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const apiError = toApiError(err);
  if (apiError.statusCode >= 500) {
    logger.error({ err, requestId: req.requestId, path: req.path }, 'Unhandled error');
  }
  const body: ErrorBody = { success: false, message: apiError.message, errors: apiError.errors };
  if (apiError.code) body.code = apiError.code;
  if (apiError.details !== undefined) body.details = apiError.details;
  res.status(apiError.statusCode).json(body);
}
