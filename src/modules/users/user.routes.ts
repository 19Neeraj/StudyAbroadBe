import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './user.service.js';
import {
  createUserBody,
  updateUserBody,
  userDto,
  userListQuery,
  userOptionDto,
  userOptionsQuery,
  userStatusBody,
} from './user.validation.js';

const m = createModuleRouter('/users', 'Users');

m.route({
  method: 'get',
  path: '/',
  summary: 'List users',
  description: 'Results are limited by the caller’s data scope (organization, branch or own).',
  permissions: ['user.view'],
  query: userListQuery,
  response: z.array(userDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listUsers(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/options',
  summary: 'Active users for pickers (e.g. assigning a counsellor)',
  permissions: ['user.view', 'lead.assign', 'lead.view'],
  permissionMode: 'any',
  query: userOptionsQuery,
  response: z.array(userOptionDto),
  handler: async ({ ctx, query }) => ({ data: await service.listUserOptions(ctx, query) }),
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Get a user',
  permissions: ['user.view'],
  params: idParams,
  response: userDto,
  handler: async ({ ctx, params }) => ({ data: await service.getUser(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/',
  summary: 'Create a user',
  description: 'Omit `password` to email the user an invite link to set their own password.',
  permissions: ['user.create'],
  body: createUserBody,
  response: userDto,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({
    message: 'User created',
    data: await service.createUser(ctx, body),
  }),
});

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update a user (profile, role, branches, manager)',
  permissions: ['user.update'],
  params: idParams,
  body: updateUserBody,
  response: userDto,
  handler: async ({ ctx, params, body }) => ({
    message: 'User updated',
    data: await service.updateUser(ctx, params.id, body),
  }),
});

m.route({
  method: 'patch',
  path: '/:id/status',
  summary: 'Activate or deactivate a user (deactivation signs them out everywhere)',
  permissions: ['user.deactivate'],
  params: idParams,
  body: userStatusBody,
  response: userDto,
  handler: async ({ ctx, params, body }) => ({
    message: body.isActive ? 'User activated' : 'User deactivated',
    data: await service.setUserActive(ctx, params.id, body.isActive),
  }),
});

export const userModule = m;
