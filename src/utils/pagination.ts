import { z } from '../docs/zod.js';
import type { SortOrder } from 'mongoose';
import type { PaginationMeta } from './apiResponse.js';

export const MAX_PAGE_SIZE = 100;

/** Common list query params. Modules extend this with their own filters and allowed sort fields. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(100).optional(),
});

export type PaginationInput = z.infer<typeof paginationQuery>;

export function sortQuery<const T extends readonly [string, ...string[]]>(
  fields: T,
  fallback: T[number],
) {
  return z.enum(fields).default(fallback as never);
}

export function toPaging(q: { page: number; limit: number }) {
  return { skip: (q.page - 1) * q.limit, limit: q.limit };
}

export function toSort(sortBy: string, sortOrder: 'asc' | 'desc'): Record<string, SortOrder> {
  // _id tiebreaker keeps pagination stable when sort values collide.
  return { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: sortOrder === 'asc' ? 1 : -1 };
}

export function buildPagination(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** Escape user input before using it in an anchored, index-friendly prefix regex. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
