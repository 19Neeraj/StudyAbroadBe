import { z } from '../../docs/zod.js';
import { passwordSchema } from '../auth/auth.validation.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';

const name = z.string().trim().min(1).max(60);
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const createUserBody = z
  .object({
    firstName: name.openapi({ example: 'Manav' }),
    lastName: z.string().trim().max(60).default(''),
    email: z.email().max(254).openapi({ example: 'manav@example.com' }),
    phone: z.string().trim().max(20).optional(),
    designation: z.string().trim().max(80).optional(),
    roleId: objectIdString,
    branchIds: z.array(objectIdString).max(50).default([]),
    managerId: objectIdString.optional(),
    password: passwordSchema.optional().openapi({
      description:
        'Initial password. When omitted, the user receives an email invite to set their own.',
    }),
  })
  .openapi('CreateUserRequest');

export const updateUserBody = z
  .object({
    firstName: name.optional(),
    lastName: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    designation: z.string().trim().max(80).nullable().optional(),
    roleId: objectIdString.optional(),
    branchIds: z.array(objectIdString).max(50).optional(),
    managerId: objectIdString.nullable().optional(),
  })
  .openapi('UpdateUserRequest');

export const userStatusBody = z.object({ isActive: z.boolean() });

export const userListQuery = paginationQuery.extend({
  sortBy: sortQuery(['fullName', 'email', 'createdAt', 'lastLoginAt'], 'fullName'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  roleId: objectIdString.optional(),
  branchId: objectIdString.optional(),
  managerId: objectIdString.optional(),
  isActive: boolQuery.optional(),
});
export type UserListQuery = z.infer<typeof userListQuery>;

export const userOptionsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  roleKey: z.string().max(40).optional(),
  branchId: objectIdString.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type UserOptionsQuery = z.infer<typeof userOptionsQuery>;

export const userDto = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    designation: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    isActive: z.boolean(),
    role: z.object({ id: z.string(), key: z.string(), name: z.string() }).nullable(),
    branches: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
    manager: z.object({ id: z.string(), fullName: z.string() }).nullable(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('User');

export const userOptionDto = z
  .object({
    id: z.string(),
    fullName: z.string(),
    email: z.string(),
    roleKey: z.string().nullable(),
  })
  .openapi('UserOption');
