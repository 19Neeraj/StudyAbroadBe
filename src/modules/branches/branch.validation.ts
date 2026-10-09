import { z } from '../../docs/zod.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const createBranchBody = z
  .object({
    name: z.string().trim().min(2).max(100).openapi({ example: 'Noida' }),
    code: z
      .string()
      .trim()
      .min(2)
      .max(10)
      .regex(/^[A-Za-z0-9_-]+$/, 'Code may contain letters, digits, "-" and "_"')
      .openapi({ example: 'NOI' }),
    email: z.email().optional(),
    phone: optionalText(20),
    address: optionalText(300),
    city: optionalText(100),
    state: optionalText(100),
    country: optionalText(100),
  })
  .openapi('CreateBranchRequest');

export const updateBranchBody = createBranchBody.partial().openapi('UpdateBranchRequest');

export const branchStatusBody = z.object({ isActive: z.boolean() });

export const branchListQuery = paginationQuery.extend({
  sortBy: sortQuery(['name', 'code', 'createdAt'], 'name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type BranchListQuery = z.infer<typeof branchListQuery>;

export const branchDto = z
  .object({
    _id: z.string(),
    name: z.string(),
    code: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Branch');
