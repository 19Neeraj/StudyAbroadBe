import { Types } from 'mongoose';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { getLead } from '../leads/lead.service.js';
import * as attribution from './attribution.service.js';
import * as exportsSvc from './export.service.js';
import * as reports from './reports.service.js';
import { exportBody, reportQuery } from './reports.validation.js';
import { createMappingBody, createNodeBody, mappingListQuery, nodeListQuery, reapplyBody, updateNodeBody, utmPreviewQuery } from './attribution.validation.js';

const m = createModuleRouter('/marketing', 'Marketing attribution');

m.route({ method: 'get', path: '/attribution/nodes', summary: 'Primary / Secondary / Tertiary values for source, medium and campaign', permissions: ['marketing.view'], query: nodeListQuery, handler: async ({ ctx, query }) => ({ data: await attribution.listNodes(ctx, query.dimension) }) });
m.route({
  method: 'get',
  path: '/attribution/options',
  summary: 'Active Primary / Secondary / Tertiary values for lead forms and filters (dependent dropdowns)',
  description: 'Readable by anyone who can view or create leads; only active values, only id/label/parent.',
  permissions: ['lead.view', 'lead.create', 'marketing.view'],
  permissionMode: 'any',
  query: nodeListQuery,
  handler: async ({ ctx, query }) => ({ data: await attribution.listOptions(ctx, query.dimension) }),
});
m.route({ method: 'post', path: '/attribution/nodes', summary: 'Add a hierarchy value (level 2/3 must sit under the right parent)', permissions: ['marketing.manage'], body: createNodeBody, successStatus: 201, handler: async ({ ctx, body }) => ({ message: 'Value added', data: await attribution.createNode(ctx, body) }) });
m.route({ method: 'patch', path: '/attribution/nodes/:id', summary: 'Rename, re-parent or deactivate a hierarchy value (key stays the same)', permissions: ['marketing.manage'], params: idParams, body: updateNodeBody, handler: async ({ ctx, params, body }) => ({ message: 'Value updated', data: await attribution.updateNode(ctx, params.id, body) }) });
m.route({
  method: 'get',
  path: '/attribution/leads/:id',
  summary: 'First touch, last touch and full touchpoint history of a lead',
  permissions: ['lead.view'],
  params: idParams,
  handler: async ({ ctx, params }) => {
    await getLead(ctx, params.id); // scope check: same visibility as the lead itself
    return { data: await attribution.leadAttribution(ctx, new Types.ObjectId(params.id)) };
  },
});

m.route({ method: 'get', path: '/campaign-mappings', summary: 'External campaign IDs → internal hierarchy (active and superseded)', permissions: ['marketing.view'], query: mappingListQuery, handler: async ({ ctx, query }) => ({ data: await attribution.listMappings(ctx, query) }) });
m.route({
  method: 'post',
  path: '/campaign-mappings',
  summary: 'Map an external campaign / ad set / ad ID (or a utm_campaign value) to the internal hierarchy',
  description: 'Matching is by ID, never by name. A new mapping for the same ID supersedes the old one from effectiveFrom; reports keep the mapping that was valid when each touch happened unless /reapply is used.',
  permissions: ['marketing.manage'],
  body: createMappingBody,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({ message: 'Mapping saved', data: await attribution.createMapping(ctx, body) }),
});
m.route({ method: 'post', path: '/campaign-mappings/reapply', summary: 'Re-resolve stored attribution for a date range with the mappings valid at each touch', permissions: ['marketing.manage'], body: reapplyBody, handler: async ({ ctx, body }) => ({ message: 'Mappings re-applied', data: await attribution.reapplyMappings(ctx, body) }) });
m.route({ method: 'get', path: '/utm/preview', summary: 'Build and check a tracked landing URL from a destination URL and UTM template', permissions: ['marketing.view'], query: utmPreviewQuery, handler: async ({ ctx, query }) => ({ data: await attribution.utmPreview(ctx, query) }) });

const reportDescription = 'Cohort basis: leads first acquired in [from, to] and their outcomes whenever they happen. Spend is summed only in the report currency. Null means N/A (zero denominator) or unavailable (not reported) — never zero.';
m.route({ method: 'get', path: '/reports/overview', summary: 'Headline KPIs with the previous period', description: reportDescription, permissions: ['marketing.view'], query: reportQuery, handler: async ({ ctx, query }) => ({ data: await reports.overview(ctx, query) }) });
m.route({ method: 'get', path: '/reports/campaigns', summary: 'Spend → leads → applications → enrolments → revenue per campaign, hierarchy level, source, country, course, intake, counsellor or branch', description: reportDescription, permissions: ['marketing.view'], query: reportQuery, handler: async ({ ctx, query }) => ({ data: await reports.breakdown(ctx, query) }) });
m.route({ method: 'get', path: '/reports/funnel', summary: 'Funnel from leads to enrolment with cost per step', description: reportDescription, permissions: ['marketing.view'], query: reportQuery, handler: async ({ ctx, query }) => ({ data: await reports.funnel(ctx, query) }) });
m.route({ method: 'get', path: '/reports/roas', summary: 'Revenue, ROAS and cost per outcome (same rows as /reports/campaigns)', description: reportDescription, permissions: ['marketing.view'], query: reportQuery, handler: async ({ ctx, query }) => ({ data: await reports.breakdown(ctx, query) }) });
m.route({ method: 'get', path: '/reports/trend', summary: 'Daily / weekly / monthly spend and leads', permissions: ['marketing.view'], query: reportQuery, handler: async ({ ctx, query }) => ({ data: await reports.trend(ctx, query) }) });
m.route({ method: 'get', path: '/reports/data-quality', summary: 'Leads without tracking, unmapped campaign IDs, import problems and spend without outcomes', permissions: ['marketing.view'], query: reportQuery, handler: async ({ ctx, query }) => ({ data: await reports.dataQuality(ctx, query) }) });
m.route({ method: 'get', path: '/reports/definitions', summary: 'How every marketing KPI is calculated', permissions: ['marketing.view'], handler: async () => ({ data: reports.METRIC_DEFINITIONS }) });
m.route({ method: 'post', path: '/reports/export', summary: 'Queue a CSV/XLSX export (built in the background)', permissions: ['marketing.export'], body: exportBody, successStatus: 202, handler: async ({ ctx, body }) => ({ message: 'Export queued', data: await exportsSvc.requestExport(ctx, body) }) });
m.route({ method: 'get', path: '/reports/exports', summary: 'Your recent exports', permissions: ['marketing.export'], handler: async ({ ctx }) => ({ data: await exportsSvc.listExports(ctx) }) });
m.route({ method: 'get', path: '/reports/exports/:id/download', summary: 'Short-lived download link for your export', permissions: ['marketing.export'], params: idParams, handler: async ({ ctx, params }) => ({ data: await exportsSvc.downloadExport(ctx, params.id) }) });

export const marketingModule = m;
