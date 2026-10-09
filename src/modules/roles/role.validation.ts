import { ALL_PERMISSIONS } from '../../constants/permissions.js';
import { DATA_SCOPES } from '../../constants/roles.js';
import { z } from '../../docs/zod.js';

const permissionList = z
  .array(z.enum(ALL_PERMISSIONS as [string, ...string[]]))
  .max(ALL_PERMISSIONS.length)
  .transform((p) => [...new Set(p)].sort());

export const createRoleBody = z
  .object({
    name: z.string().trim().min(2).max(60).openapi({ example: 'Senior Counsellor' }),
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Key must be lower_snake_case')
      .optional()
      .openapi({ description: 'Generated from the name when omitted' }),
    description: z.string().trim().max(300).optional(),
    dataScope: z.enum(DATA_SCOPES),
    permissions: permissionList,
  })
  .openapi('CreateRoleRequest');

export const updateRoleBody = createRoleBody
  .omit({ key: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .openapi('UpdateRoleRequest');

export const roleDto = z
  .object({
    _id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    dataScope: z.enum(DATA_SCOPES),
    permissions: z.array(z.string()),
    isSystem: z.boolean(),
    isActive: z.boolean(),
    userCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Role');
