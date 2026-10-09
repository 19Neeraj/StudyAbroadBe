import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './branch.service.js';
import {
  branchDto,
  branchListQuery,
  branchStatusBody,
  createBranchBody,
  updateBranchBody,
} from './branch.validation.js';

const m = createModuleRouter('/branches', 'Branches');

m.route({
  method: 'get',
  path: '/',
  summary: 'List branches',
  description: 'Users without organization-wide scope only see their assigned branches.',
  permissions: ['branch.view'],
  query: branchListQuery,
  response: z.array(branchDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listBranches(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Get a branch',
  permissions: ['branch.view'],
  params: idParams,
  response: branchDto,
  handler: async ({ ctx, params }) => ({ data: await service.getBranch(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/',
  summary: 'Create a branch',
  permissions: ['branch.manage'],
  body: createBranchBody,
  response: branchDto,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({
    message: 'Branch created',
    data: await service.createBranch(ctx, body),
  }),
});

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update a branch',
  permissions: ['branch.manage'],
  params: idParams,
  body: updateBranchBody,
  response: branchDto,
  handler: async ({ ctx, params, body }) => ({
    message: 'Branch updated',
    data: await service.updateBranch(ctx, params.id, body),
  }),
});

m.route({
  method: 'patch',
  path: '/:id/status',
  summary: 'Activate or deactivate a branch',
  permissions: ['branch.manage'],
  params: idParams,
  body: branchStatusBody,
  response: branchDto,
  handler: async ({ ctx, params, body }) => ({
    message: body.isActive ? 'Branch activated' : 'Branch deactivated',
    data: await service.setBranchActive(ctx, params.id, body.isActive),
  }),
});

export const branchModule = m;
