import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { counsellorPerformance } from './report.catalog.js';
import * as service from './report.service.js';
import { exportBody } from './report.validation.js';

const m = createModuleRouter('/reports', 'Reports & exports');

m.route({ method: 'get', path: '/catalog', summary: 'Reports you can export', permissions: ['report.view'], handler: async ({ ctx }) => ({ data: service.catalog(ctx) }) });
m.route({
  method: 'get',
  path: '/counsellor-performance',
  summary: 'Per-counsellor leads, milestones, calls, talk time, follow-ups and revenue',
  description: 'Accepts the dashboard filters (period, dateFrom/dateTo, branchId, source, campaign, country, course, intake). Scoped to what you can see.',
  permissions: ['report.view'],
  query: z.object({}).passthrough(),
  // Validated by the dashboard and call-analytics query schemas inside.
  handler: async ({ ctx, req }) => ({ data: await counsellorPerformance(ctx, req.query as Record<string, string>) }),
});
m.route({ method: 'post', path: '/export', summary: 'Queue a CSV/XLSX export (built in the background with your permissions)', permissions: ['report.view'], body: exportBody, successStatus: 202, handler: async ({ ctx, body }) => ({ message: 'Export queued', data: await service.requestExport(ctx, body) }) });
m.route({ method: 'get', path: '/exports', summary: 'Your recent exports', permissions: ['report.view'], handler: async ({ ctx }) => ({ data: await service.listExports(ctx) }) });
m.route({ method: 'get', path: '/exports/:id/download', summary: 'Five-minute download link (requester only)', permissions: ['report.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await service.downloadExport(ctx, params.id) }) });

export const reportModule = m;
