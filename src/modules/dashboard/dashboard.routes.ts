import { createModuleRouter } from '../../utils/router.js';
import { dashboardOverview } from './dashboard.service.js';
import { dashboardDto, dashboardQuery } from './dashboard.validation.js';

const m = createModuleRouter('/dashboard', 'Dashboard');

m.route({
  method: 'get',
  path: '/overview',
  summary: 'Role-aware dashboard: KPIs vs previous period, funnel, rates, trend and breakdowns',
  description:
    'Everything is computed with MongoDB aggregation pipelines inside the caller’s data scope (counsellors see their own ' +
    'leads, managers their branches). Cohort figures cover leads created in `period`; `totalLeads`, `activeLeads` and ' +
    '`pipeline` cover every matching lead regardless of date. Accepts the same nested `filter` as `GET /leads`.',
  permissions: ['report.view'],
  query: dashboardQuery,
  response: dashboardDto,
  handler: async ({ ctx, query }) => ({ data: await dashboardOverview(ctx, query) }),
});

export const dashboardModule = m;
