import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './role.service.js';
import { createRoleBody, roleDto, updateRoleBody } from './role.validation.js';

const m = createModuleRouter('/roles', 'Roles & Permissions');

m.route({
  method: 'get',
  path: '/',
  summary: 'List roles with user counts',
  permissions: ['role.view'],
  response: z.array(roleDto),
  handler: async ({ ctx }) => ({ data: await service.listRoles(ctx) }),
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Get a role',
  permissions: ['role.view'],
  params: idParams,
  response: roleDto,
  handler: async ({ ctx, params }) => ({ data: await service.getRole(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/',
  summary: 'Create a role',
  description: 'You can only grant permissions you hold yourself.',
  permissions: ['role.manage'],
  body: createRoleBody,
  response: roleDto,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({
    message: 'Role created',
    data: await service.createRole(ctx, body),
  }),
});

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update a role (name, scope, permissions, active)',
  permissions: ['role.manage'],
  params: idParams,
  body: updateRoleBody,
  response: roleDto,
  handler: async ({ ctx, params, body }) => ({
    message: 'Role updated',
    data: await service.updateRole(ctx, params.id, body),
  }),
});

m.route({
  method: 'delete',
  path: '/:id',
  summary: 'Delete a custom role that has no users',
  permissions: ['role.manage'],
  params: idParams,
  response: z.null(),
  handler: async ({ ctx, params }) => {
    await service.deleteRole(ctx, params.id);
    return { message: 'Role deleted', data: null };
  },
});

export const roleModule = m;
