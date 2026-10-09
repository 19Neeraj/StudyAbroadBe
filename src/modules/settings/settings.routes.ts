import { z } from '../../docs/zod.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './lookup.service.js';
import {
  createLookupBody,
  lookupDto,
  lookupGroupsQuery,
  lookupItemParams,
  lookupListQuery,
  lookupTypeParams,
  reorderLookupsBody,
  updateLookupBody,
} from './lookup.validation.js';

const m = createModuleRouter('/settings', 'Admin Settings');

m.route({
  method: 'get',
  path: '/lookups',
  summary: 'Configured values for several types at once (grouped by type)',
  description:
    'Available to every signed-in user because forms need it. Types: country, course, degree_level, intake, lead_source, lead_stage, lead_status, followup_type, event_type, application_status, document_type.',
  query: lookupGroupsQuery,
  response: z.record(z.string(), z.array(lookupDto)),
  handler: async ({ ctx, query }) => ({
    data: await service.listLookupGroups(ctx, query.types, query.includeInactive),
  }),
});

m.route({
  method: 'get',
  path: '/lookups/:type',
  summary: 'Configured values of one type, in display order',
  params: lookupTypeParams,
  query: lookupListQuery,
  response: z.array(lookupDto),
  handler: async ({ ctx, params, query }) => ({
    data: await service.listLookups(ctx, params.type, query.includeInactive),
  }),
});

m.route({
  method: 'post',
  path: '/lookups/:type',
  summary: 'Add a value (e.g. a new lead source or stage)',
  permissions: ['settings.manage'],
  params: lookupTypeParams,
  body: createLookupBody,
  response: lookupDto,
  successStatus: 201,
  handler: async ({ ctx, params, body }) => ({
    message: 'Value added',
    data: await service.createLookup(ctx, params.type, body),
  }),
});

m.route({
  method: 'put',
  path: '/lookups/:type/order',
  summary: 'Reorder values of a type',
  permissions: ['settings.manage'],
  params: lookupTypeParams,
  body: reorderLookupsBody,
  response: z.array(lookupDto),
  handler: async ({ ctx, params, body }) => ({
    message: 'Order saved',
    data: await service.reorderLookups(ctx, params.type, body.ids),
  }),
});

m.route({
  method: 'patch',
  path: '/lookups/:type/:id',
  summary: 'Rename, recolour, reorder or (de)activate a value',
  description:
    'Values are never hard-deleted so historical records stay readable; deactivate instead.',
  permissions: ['settings.manage'],
  params: lookupItemParams,
  body: updateLookupBody,
  response: lookupDto,
  handler: async ({ ctx, params, body }) => ({
    message: 'Value updated',
    data: await service.updateLookup(ctx, params.type, params.id, body),
  }),
});

export const settingsModule = m;
