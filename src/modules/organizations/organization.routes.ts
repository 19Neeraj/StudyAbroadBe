import { PLATFORM_MANAGE } from '../../constants/permissions.js';
import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { userDto } from '../users/user.validation.js';
import * as service from './organization.service.js';
import {
  createOrganizationBody,
  organizationDto,
  organizationListQuery,
  organizationStatusBody,
  updateOrganizationBody,
} from './organization.validation.js';

const m = createModuleRouter('/organizations', 'Organizations');

// --- Own organization ---------------------------------------------------------------

m.route({
  method: 'get',
  path: '/current',
  summary: 'My organization profile and settings',
  permissions: ['organization.view'],
  response: organizationDto,
  handler: async ({ ctx }) => ({ data: await service.getOrganization(ctx.organizationId) }),
});

m.route({
  method: 'patch',
  path: '/current',
  summary: 'Update my organization profile and settings',
  permissions: ['organization.update'],
  body: updateOrganizationBody,
  response: organizationDto,
  handler: async ({ ctx, body }) => ({
    message: 'Organization updated',
    data: await service.updateOrganization(ctx, ctx.organizationId, body),
  }),
});

// --- Platform (Super Admin) ---------------------------------------------------------

m.route({
  method: 'get',
  path: '/',
  summary: 'List all organizations (Super Admin)',
  permissions: [PLATFORM_MANAGE],
  query: organizationListQuery,
  response: z.array(organizationDto),
  paginated: true,
  handler: async ({ query }) => {
    const { items, pagination } = await service.listOrganizations(query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'post',
  path: '/',
  summary:
    'Provision a new organization with default roles, settings, branch and admin (Super Admin)',
  permissions: [PLATFORM_MANAGE],
  body: createOrganizationBody,
  response: z.object({ organization: organizationDto, admin: userDto }),
  successStatus: 201,
  handler: async ({ ctx, body }) => ({
    message: 'Organization created',
    data: await service.provisionOrganization(body, { userId: ctx.userId, meta: ctx.meta }),
  }),
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Get an organization (Super Admin)',
  permissions: [PLATFORM_MANAGE],
  params: idParams,
  response: organizationDto,
  handler: async ({ params }) => ({ data: await service.getOrganization(params.id) }),
});

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update an organization (Super Admin)',
  permissions: [PLATFORM_MANAGE],
  params: idParams,
  body: updateOrganizationBody,
  response: organizationDto,
  handler: async ({ ctx, params, body }) => ({
    message: 'Organization updated',
    data: await service.updateOrganization(ctx, params.id, body),
  }),
});

m.route({
  method: 'patch',
  path: '/:id/status',
  summary: 'Activate or suspend an organization (Super Admin)',
  description: 'Suspending blocks sign-in and API access for all of its users immediately.',
  permissions: [PLATFORM_MANAGE],
  params: idParams,
  body: organizationStatusBody,
  response: organizationDto,
  handler: async ({ ctx, params, body }) => ({
    message: body.isActive ? 'Organization activated' : 'Organization suspended',
    data: await service.setOrganizationActive(ctx, params.id, body.isActive),
  }),
});

export const organizationModule = m;
