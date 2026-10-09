import { PERMISSION_CATALOG } from '../../constants/permissions.js';
import { DATA_SCOPES } from '../../constants/roles.js';
import { z } from '../../docs/zod.js';
import { createModuleRouter } from '../../utils/router.js';

const m = createModuleRouter('/permissions', 'Roles & Permissions');

const catalog = Object.entries(PERMISSION_CATALOG).map(([module, perms]) => ({
  module,
  permissions: Object.entries(perms).map(([key, description]) => ({ key, description })),
}));

m.route({
  method: 'get',
  path: '/',
  summary: 'Permission catalog grouped by module, plus available data scopes',
  permissions: ['role.view'],
  response: z.object({
    modules: z.array(
      z.object({
        module: z.string(),
        permissions: z.array(z.object({ key: z.string(), description: z.string() })),
      }),
    ),
    dataScopes: z.array(z.enum(DATA_SCOPES)),
  }),
  handler: async () => ({ data: { modules: catalog, dataScopes: [...DATA_SCOPES] } }),
});

export const permissionModule = m;
