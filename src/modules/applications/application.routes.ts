import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './application.service.js';
import {
  addShortlistBody,
  applicationListQuery,
  applicationStatusBody,
  applyFromShortlistBody,
  createApplicationBody,
  offerBody,
  updateApplicationBody,
  updateShortlistBody,
} from './application.validation.js';

const m = createModuleRouter('/applications', 'Applications');

m.route({
  method: 'get',
  path: '/',
  summary: 'List applications (status, university, intake, deadline, offer, assignee filters)',
  permissions: ['application.view'],
  query: applicationListQuery,
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listApplications(ctx, query);
    return { data: items, pagination };
  },
});
m.route({ method: 'get', path: '/board', summary: 'Application counts per status (board columns)', permissions: ['application.view'], handler: async ({ ctx }) => ({ data: await service.applicationBoard(ctx) }) });
m.route({
  method: 'post',
  path: '/',
  summary: 'Create an application (moves the lead to the Application stage)',
  description: 'Fees, currency and the intake deadline default from the course. Status values are configurable (application_status).',
  permissions: ['application.create'],
  body: createApplicationBody,
  successStatus: 201,
  handler: async ({ ctx, body }) => ({ message: 'Application created', data: await service.createApplication(ctx, body) }),
});
m.route({ method: 'get', path: '/:id', summary: 'Application details', permissions: ['application.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await service.getApplication(ctx, params.id) }) });
m.route({ method: 'patch', path: '/:id', summary: 'Update application details', permissions: ['application.update'], params: idParams, body: updateApplicationBody, handler: async ({ ctx, params, body }) => ({ message: 'Application updated', data: await service.updateApplication(ctx, params.id, body) }) });
m.route({
  method: 'patch',
  path: '/:id/status',
  summary: 'Change application status (advances the lead stage when the status maps to a milestone)',
  permissions: ['application.update'],
  params: idParams,
  body: applicationStatusBody,
  handler: async ({ ctx, params, body }) => ({ message: 'Status updated', data: await service.changeApplicationStatus(ctx, params.id, body) }),
});
m.route({
  method: 'patch',
  path: '/:id/offer',
  summary: 'Record or update the offer (conditional/unconditional moves the lead to the Offer stage)',
  permissions: ['application.update'],
  params: idParams,
  body: offerBody,
  handler: async ({ ctx, params, body }) => ({ message: 'Offer saved', data: await service.updateOffer(ctx, params.id, body) }),
});

/** Shortlist lives under students but is part of the application workflow. */
const s = createModuleRouter('/shortlist', 'Shortlist');
s.route({ method: 'get', path: '/student/:id', summary: 'A student’s shortlisted universities/courses', permissions: ['student.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await service.listShortlist(ctx, params.id) }) });
s.route({ method: 'post', path: '/student/:id', summary: 'Shortlist a university/course for a student', permissions: ['student.update'], params: idParams, body: addShortlistBody, successStatus: 201, handler: async ({ ctx, params, body }) => ({ message: 'Shortlisted', data: await service.addToShortlist(ctx, params.id, body) }) });
s.route({ method: 'patch', path: '/:id', summary: 'Update a shortlist entry', permissions: ['student.update'], params: idParams, body: updateShortlistBody, handler: async ({ ctx, params, body }) => ({ message: 'Shortlist updated', data: await service.updateShortlist(ctx, params.id, body) }) });
s.route({
  method: 'delete',
  path: '/:id',
  summary: 'Remove a shortlist entry (not allowed once an application exists)',
  permissions: ['student.update'],
  params: idParams,
  handler: async ({ ctx, params }) => {
    await service.removeFromShortlist(ctx, params.id);
    return { message: 'Removed', data: null };
  },
});
s.route({ method: 'post', path: '/:id/apply', summary: 'Start an application from a shortlist entry', permissions: ['application.create'], params: idParams, body: applyFromShortlistBody, successStatus: 201, handler: async ({ ctx, params, body }) => ({ message: 'Application created', data: await service.applyFromShortlist(ctx, params.id, body) }) });

export const applicationModule = m;
export const shortlistModule = s;
