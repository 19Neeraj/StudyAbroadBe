import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { callAnalytics } from './call.analytics.js';
import * as service from './call.service.js';
import {
  callAnalyticsQuery,
  callDto,
  callListQuery,
  completeCallBody,
  editSummaryBody,
  initiateCallBody,
  initiateCallDto,
  logCallBody,
  outcomeBody,
  transcriptSearchQuery,
} from './call.validation.js';

const m = createModuleRouter('/calls', 'Calls');

m.route({
  method: 'post',
  path: '/',
  summary: 'Call a lead from the CRM (click-to-call)',
  description:
    'Creates a call session linked to the lead, student and counsellor. With a cloud provider (e.g. Exotel) the provider rings your ' +
    'phone first and bridges the student; with `device` mode the app opens the native dialler with `dial` and later reports the result ' +
    'through `POST /calls/{id}/complete`.',
  permissions: ['call.make'],
  body: initiateCallBody,
  response: initiateCallDto,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({ message: 'Call started', data: await service.initiateCall(ctx, body) }),
});

m.route({
  method: 'post',
  path: '/log',
  summary: 'Log a call made outside the CRM',
  permissions: ['call.make'],
  body: logCallBody,
  response: callDto,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({ message: 'Call logged', data: await service.logCall(ctx, body) }),
});

m.route({
  method: 'get',
  path: '/',
  summary: 'Call log with filters (counsellor, outcome, duration, source, campaign, …)',
  permissions: ['call.view'],
  query: callListQuery,
  response: z.array(callDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listCalls(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/analytics',
  summary: 'Calling intelligence: volume, connect rate, talk time, counsellor comparison, call→conversion, response time',
  permissions: ['call.view', 'report.view'],
  query: callAnalyticsQuery,
  handler: async ({ ctx, query }) => ({ data: await callAnalytics(ctx, query) }),
});

m.route({
  method: 'get',
  path: '/transcripts/search',
  summary: 'Search call transcripts (e.g. "budget")',
  permissions: ['recording.view'],
  query: transcriptSearchQuery,
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.searchTranscripts(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Call details',
  permissions: ['call.view'],
  params: idParams,
  response: callDto,
  handler: async ({ ctx, params }) => ({ data: await service.getCall(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/:id/complete',
  summary: 'Finish a call: status/duration (device calls), outcome, notes, next action and follow-up',
  permissions: ['call.make'],
  params: idParams,
  body: completeCallBody,
  response: callDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Call saved', data: await service.completeCall(ctx, params.id, body) }),
});

m.route({
  method: 'patch',
  path: '/:id/outcome',
  summary: 'Set or change the call outcome, notes, next action; optionally schedule a follow-up',
  permissions: ['call.make'],
  params: idParams,
  body: outcomeBody,
  response: callDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Outcome saved', data: await service.setOutcome(ctx, params.id, body) }),
});

m.route({
  method: 'get',
  path: '/:id/recording',
  summary: 'Short-lived signed URL to play (or download) the recording; access is audited',
  permissions: ['recording.view'],
  params: idParams,
  query: z.object({ download: z.enum(['true', 'false']).default('false') }),
  handler: async ({ ctx, params, query }) => ({ data: await service.recordingUrl(ctx, params.id, query.download === 'true') }),
});

m.route({
  method: 'get',
  path: '/:id/intelligence',
  summary: 'Transcript and AI summary of a call (AI output is labelled and editable)',
  permissions: ['recording.view'],
  params: idParams,
  handler: async ({ ctx, params }) => ({ data: await service.callIntelligence(ctx, params.id) }),
});

m.route({
  method: 'patch',
  path: '/:id/summary',
  summary: 'Edit the AI summary (the original model output is kept)',
  permissions: ['call.make', 'recording.view'],
  params: idParams,
  body: editSummaryBody,
  handler: async ({ ctx, params, body }) => ({ message: 'Summary updated', data: await service.editSummary(ctx, params.id, body) }),
});

export const callModule = m;
