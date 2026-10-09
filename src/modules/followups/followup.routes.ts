import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './followup.service.js';
import {
  cancelFollowUpBody,
  completeFollowUpBody,
  followUpDto,
  followUpListQuery,
  followUpSummaryDto,
  followUpSummaryQuery,
  rescheduleFollowUpBody,
} from './followup.validation.js';

const m = createModuleRouter('/followups', 'Follow-ups');

m.route({
  method: 'get',
  path: '/',
  summary: 'Follow-ups: today, upcoming, overdue, completed or all',
  description: '"Today" uses the organization time zone. Overdue = still open and past due. Limited by data scope.',
  permissions: ['followup.view'],
  query: followUpListQuery,
  response: z.array(followUpDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listFollowUps(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/summary',
  summary: 'Counts of today’s, overdue and upcoming follow-ups (yours by default)',
  permissions: ['followup.view'],
  query: followUpSummaryQuery,
  response: followUpSummaryDto,
  handler: async ({ ctx, query }) => ({ data: await service.followUpSummary(ctx, query.mine) }),
});

m.route({
  method: 'post',
  path: '/:id/complete',
  summary: 'Complete a follow-up, optionally scheduling the next one',
  permissions: ['followup.manage'],
  params: idParams,
  body: completeFollowUpBody,
  response: z.object({ completed: followUpDto, next: followUpDto.nullable() }),
  handler: async ({ ctx, params, body }) => ({ message: 'Follow-up completed', data: await service.completeFollowUp(ctx, params.id, body) }),
});

m.route({
  method: 'post',
  path: '/:id/reschedule',
  summary: 'Reschedule (the original is kept as "Rescheduled")',
  permissions: ['followup.manage'],
  params: idParams,
  body: rescheduleFollowUpBody,
  response: followUpDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Follow-up rescheduled', data: await service.rescheduleFollowUp(ctx, params.id, body) }),
});

m.route({
  method: 'post',
  path: '/:id/cancel',
  summary: 'Cancel a follow-up',
  permissions: ['followup.manage'],
  params: idParams,
  body: cancelFollowUpBody,
  response: followUpDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Follow-up cancelled', data: await service.cancelFollowUp(ctx, params.id, body) }),
});

export const followUpModule = m;
