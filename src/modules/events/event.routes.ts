import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { z } from '../../docs/zod.js';
import { ApiError } from '../../utils/ApiError.js';
import { idParams, objectIdString } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './event.service.js';
import { checkInBody, createEventBody, eventListQuery, publicRegisterBody, registerBody, registrationListQuery, updateEventBody } from './event.validation.js';

const m = createModuleRouter('/events', 'Events');
const slugParams = z.object({ slug: z.string().min(8).max(40) });
const publicLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => env.NODE_ENV === 'test', keyGenerator: (req) => ipKeyGenerator(req.ip ?? '0.0.0.0'), handler: (_q, _s, next) => next(ApiError.tooManyRequests()) });

// Public registration page (no sign-in). Registered first so "/public/…" isn't read as an event id.
m.publicRoute({ method: 'get', path: '/public/:slug', summary: 'Public event details for the registration page', params: slugParams, handler: async ({ params }) => ({ data: await service.getPublicEvent(params.slug) }) });
m.publicRoute({
  method: 'post',
  path: '/public/:slug/register',
  summary: 'Public event registration (creates or updates the lead; rate limited)',
  middlewares: [publicLimiter],
  params: slugParams,
  body: publicRegisterBody,
  successStatus: 201,
  handler: async ({ params, body }) => ({ message: 'You are registered', data: await service.registerPublic(params.slug, body), status: 201 }),
});

m.route({ method: 'get', path: '/', summary: 'Events (branch-scoped) with registration counts', permissions: ['event.view'], query: eventListQuery, paginated: true, handler: async ({ ctx, query }) => { const r = await service.listEvents(ctx, query); return { data: r.items, pagination: r.pagination }; } });
m.route({ method: 'post', path: '/', summary: 'Create an event', permissions: ['event.manage'], body: createEventBody, successStatus: 201, handler: async ({ ctx, body }) => ({ message: 'Event created', data: await service.createEvent(ctx, body) }) });
m.route({ method: 'get', path: '/:id', summary: 'Event with counts, outcomes of registered leads and cost/ROI', permissions: ['event.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await service.getEvent(ctx, params.id) }) });
m.route({ method: 'patch', path: '/:id', summary: 'Update an event', permissions: ['event.manage'], params: idParams, body: updateEventBody, handler: async ({ ctx, params, body }) => ({ message: 'Event updated', data: await service.updateEvent(ctx, params.id, body) }) });
m.route({ method: 'delete', path: '/:id', summary: 'Delete an event without registrations (otherwise cancel it)', permissions: ['event.manage'], params: idParams, handler: async ({ ctx, params }) => { await service.deleteEvent(ctx, params.id); return { data: null, message: 'Event deleted' }; } });
m.route({ method: 'post', path: '/:id/public-registration', summary: 'Open or close the public registration page', permissions: ['event.manage'], params: idParams, body: z.object({ open: z.boolean() }), handler: async ({ ctx, params, body }) => ({ message: body.open ? 'Registration opened' : 'Registration closed', data: await service.setPublicRegistration(ctx, params.id, body.open) }) });
m.route({ method: 'get', path: '/:id/registrations', summary: 'Registrations with search (name, phone, email) for check-in', permissions: ['event.view'], params: idParams, query: registrationListQuery, paginated: true, handler: async ({ ctx, params, query }) => { const r = await service.listRegistrations(ctx, params.id, query); return { data: r.items, pagination: r.pagination }; } });
m.route({ method: 'post', path: '/:id/registrations', summary: 'Register an existing lead or a new person (walkIn: also check in)', permissions: ['event.manage'], params: idParams, body: registerBody, successStatus: 201, handler: async ({ ctx, params, body }) => { const r = await service.registerByStaff(ctx, params.id, body); return { message: r.alreadyRegistered ? 'Already registered' : 'Registered', data: r, status: r.alreadyRegistered ? 200 : 201 }; } });
m.route({ method: 'patch', path: '/:id/registrations/:registrationId', summary: 'Check in / mark no-show / cancel', permissions: ['event.manage'], params: idParams.extend({ registrationId: objectIdString }), body: checkInBody, handler: async ({ ctx, params, body }) => ({ message: 'Updated', data: await service.checkIn(ctx, params.id, params.registrationId, body) }) });

export const eventModule = m;
