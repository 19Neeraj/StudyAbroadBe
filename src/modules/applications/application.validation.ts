import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';
import { ENROLMENT_STATUSES, OFFER_STATUSES, SHORTLIST_STATUSES } from './application.model.js';

const key = z.string().trim().min(1).max(64);
const money = z.number().min(0).max(1e9);
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

export const addShortlistBody = z
  .object({
    universityId: objectIdString,
    courseId: objectIdString.optional(),
    intake: key.optional(),
    priority: z.number().int().min(1).max(10).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .openapi('AddShortlistRequest');

export const updateShortlistBody = z
  .object({
    status: z.enum(SHORTLIST_STATUSES).optional(),
    intake: key.nullable().optional(),
    priority: z.number().int().min(1).max(10).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('UpdateShortlistRequest');

const applicationFields = {
  courseId: objectIdString.optional(),
  courseName: z.string().trim().max(200).optional(),
  intake: key.optional(),
  applicationDate: z.coerce.date().optional(),
  applicationDeadline: z.coerce.date().optional(),
  universityApplicationId: z.string().trim().max(100).optional(),
  assignedTo: objectIdString.optional().openapi({ description: 'Application team member handling it' }),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  tuitionFee: money.optional(),
  scholarship: money.optional(),
  applicationFee: money.optional(),
  notes: z.string().trim().max(5000).optional(),
};

export const createApplicationBody = z
  .object({
    studentId: objectIdString,
    universityId: objectIdString,
    status: key.optional().openapi({ description: 'Lookup key (type application_status); defaults to draft' }),
    ...applicationFields,
  })
  .openapi('CreateApplicationRequest');

export const applyFromShortlistBody = z.object({ status: key.optional(), ...applicationFields }).openapi('ApplyFromShortlistRequest');

export const updateApplicationBody = z
  .object({
    courseId: objectIdString.nullable().optional(),
    courseName: z.string().trim().max(200).nullable().optional(),
    intake: key.nullable().optional(),
    applicationDate: z.coerce.date().nullable().optional(),
    applicationDeadline: z.coerce.date().nullable().optional(),
    universityApplicationId: z.string().trim().max(100).nullable().optional(),
    assignedTo: objectIdString.nullable().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    tuitionFee: money.nullable().optional(),
    scholarship: money.nullable().optional(),
    applicationFee: money.nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    enrolmentStatus: z.enum(ENROLMENT_STATUSES).optional(),
  })
  .openapi('UpdateApplicationRequest');

export const applicationStatusBody = z.object({ status: key, note: z.string().trim().max(1000).optional() }).openapi('ApplicationStatusRequest');

export const offerBody = z
  .object({
    status: z.enum(OFFER_STATUSES),
    date: z.coerce.date().optional(),
    conditions: z.string().trim().max(3000).optional(),
    expiryDate: z.coerce.date().optional(),
    depositAmount: money.optional(),
    depositDeadline: z.coerce.date().optional(),
    tuitionFee: money.optional(),
    scholarship: money.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .openapi('OfferRequest');

export const applicationListQuery = paginationQuery.extend({
  sortBy: sortQuery(['createdAt', 'updatedAt', 'applicationDeadline', 'applicationNumber'], 'updatedAt'),
  status: csv.optional(),
  studentId: objectIdString.optional(),
  universityId: objectIdString.optional(),
  country: key.optional(),
  intake: key.optional(),
  counsellor: objectIdString.optional(),
  assignedTo: z.union([objectIdString, z.literal('me')]).optional(),
  branchId: objectIdString.optional(),
  offerStatus: csv.optional(),
  deadlineWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  openOnly: z.enum(['true', 'false']).optional(),
});
export type ApplicationListQuery = z.infer<typeof applicationListQuery>;
