import { z } from '../../docs/zod.js';
import { createModuleRouter } from '../../utils/router.js';
import { listAuditLogs } from './audit.service.js';
import { auditListQuery, auditLogDto } from './audit.validation.js';

const m = createModuleRouter('/audit-logs', 'Audit Logs');

m.route({
  method: 'get',
  path: '/',
  summary: 'List audit log entries',
  permissions: ['audit.view'],
  query: auditListQuery,
  response: z.array(auditLogDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await listAuditLogs(ctx, query);
    return { data: items, pagination };
  },
});

export const auditModule = m;
