import type { Response } from 'express';
import type { FieldError } from './ApiError.js';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
  pagination?: PaginationMeta;
}

export interface ErrorBody {
  success: false;
  message: string;
  code?: string;
  errors: FieldError[];
  details?: unknown;
}

export function sendSuccess<T>(
  res: Response,
  {
    data,
    message = 'OK',
    status = 200,
    pagination,
  }: { data: T; message?: string; status?: number; pagination?: PaginationMeta },
): void {
  const body: SuccessBody<T> = { success: true, message, data };
  if (pagination) body.pagination = pagination;
  res.status(status).json(body);
}
