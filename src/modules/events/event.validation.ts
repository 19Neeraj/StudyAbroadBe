import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { EVENT_MODES, EVENT_STATUSES, REGISTRATION_STATUSES } from './event.model.js';

const text = (max: number) => z.string().trim().max(max);
const csv = z.string().transform((v) => v.split(',').filter(Boolean));

const eventShape = {
  name: text(160).min(1),
  eventType: text(64).min(1).openapi({ description: 'Lookup key (type event_type)' }),
  description: text(4000).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  mode: z.enum(EVENT_MODES).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  venue: z.object({ name: text(160).optional(), address: text(300).optional(), city: text(100).optional() }).optional(),
  onlineUrl: z.url().max(500).optional(),
  branchId: objectIdString.nullable().optional(),
  countries: z.array(text(64)).max(30).optional(),
  universityIds: z.array(objectIdString).max(100).optional(),
  capacity: z.number().int().min(1).max(100_000).nullable().optional(),
  cost: z.object({ amount: z.number().min(0).max(1e10), currency: z.string().length(3).toUpperCase() }).nullable().optional().openapi({ description: 'Total cost for ROI. Leave empty when unknown (shown as N/A, not zero).' }),
  ownerId: objectIdString.optional(),
};

export const createEventBody = z.object(eventShape).openapi('CreateEventRequest');
export const updateEventBody = z.object(eventShape).partial().openapi('UpdateEventRequest');

export const eventListQuery = paginationQuery.extend({
  status: csv.pipe(z.array(z.enum(EVENT_STATUSES))).optional(),
  eventType: z.string().max(64).optional(),
  branchId: objectIdString.optional(),
  when: z.enum(['upcoming', 'past', 'all']).default('all'),
});

const contact = z.object({
  firstName: text(60).min(1),
  lastName: text(60).optional(),
  phone: text(20).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  city: text(100).optional(),
  countryInterested: text(64).optional(),
  courseInterested: text(64).optional(),
  intake: text(64).optional(),
});

export const registerBody = z
  .object({ leadId: objectIdString.optional(), contact: contact.optional(), walkIn: z.boolean().optional().openapi({ description: 'Register and check in at once (walk-in at the venue)' }), notes: text(2000).optional() })
  .refine((v) => !!v.leadId !== !!v.contact, { message: 'Give either an existing lead or contact details', path: ['leadId'] });

export const registrationListQuery = paginationQuery.extend({ status: csv.pipe(z.array(z.enum(REGISTRATION_STATUSES))).optional() }).extend({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export const checkInBody = z.object({ status: z.enum(REGISTRATION_STATUSES), notes: text(2000).optional() });

export const publicRegisterBody = z.object({
  contact,
  notes: text(1000).optional(),
  tracking: z.partialRecord(z.enum(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'landing_url', 'referrer']), z.string().max(2000)).optional(),
  consent: z.object({ analytics: z.boolean().optional(), ads: z.boolean().optional(), method: text(100).optional() }).optional(),
  /** Honeypot: real people leave it empty. */
  website: z.string().max(0, 'Spam rejected').optional(),
});
