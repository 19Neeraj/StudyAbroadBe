import { z } from '../../docs/zod.js';
import { filterQueryParam } from '../../utils/filterTree.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional();
const nullableText = (max: number) => text(max).nullable().optional();
const key = z.string().trim().min(1).max(64);
/** Trims and lower-cases before validating, so pasted addresses with stray spaces are accepted. */
const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email').max(254));

const profileShape = {
  firstName: z.string().trim().min(1, 'First name is required').max(60).openapi({ example: 'Aarav' }),
  lastName: optText(60),
  phone: optText(20).openapi({ example: '98765 43210', description: 'Normalized to E.164 using the organization country code' }),
  whatsappNumber: optText(20),
  email: email.optional(),
  city: optText(100),
  state: optText(100),
  country: optText(100),
  countryInterested: key.optional().openapi({ description: 'Lookup key (type country)' }),
  courseInterested: key.optional().openapi({ description: 'Lookup key (type course)' }),
  degreeLevel: key.optional().openapi({ description: 'Lookup key (type degree_level)' }),
  intake: key.optional().openapi({ description: 'Lookup key (type intake)' }),
  educationDetails: optText(2000),
  ieltsScore: z.number().min(0).max(9).multipleOf(0.5).optional(),
  pteScore: z.number().min(10).max(90).optional(),
  toeflScore: z.number().int().min(0).max(120).optional(),
  otherTestScore: optText(100),
  budget: z.number().min(0).max(1e10).optional(),
  expectedPaymentDate: z.coerce.date().optional(),
  branchId: objectIdString.optional(),
};

const attributionShape = {
  leadSource: key.default('manual').openapi({ description: 'Lookup key (type lead_source)' }),
  campaign: optText(200),
  platform: optText(100),
  adSet: optText(200),
  ad: optText(200),
  leadForm: optText(200),
  utmSource: optText(200),
  utmMedium: optText(200),
  utmCampaign: optText(200),
  utmTerm: optText(200),
  utmContent: optText(200),
};

export const DUPLICATE_ACTIONS = ['keep_existing', 'create_separate', 'mark_duplicate'] as const;

export const createLeadBody = z
  .object({
    ...profileShape,
    ...attributionShape,
    leadStage: key.optional().openapi({ description: 'Defaults to new_lead' }),
    assignedCounsellor: objectIdString.optional(),
    assignedManager: objectIdString.optional(),
    notes: optText(5000),
    duplicateAction: z.enum(DUPLICATE_ACTIONS).optional().openapi({
      description:
        'How to resolve a DUPLICATE_LEAD conflict: keep_existing (record this enquiry on the existing lead), ' +
        'create_separate, or mark_duplicate (create it as a duplicate of the existing lead). The last two need lead.merge.',
    }),
    duplicateOfId: objectIdString.optional().openapi({ description: 'Existing lead to use for keep_existing / mark_duplicate' }),
  })
  .refine((v) => v.phone || v.email || v.whatsappNumber, { message: 'Provide a phone number, WhatsApp number or email', path: ['phone'] })
  .openapi('CreateLeadRequest');

// Updates accept null to clear optional fields.
export const updateLeadBody = z
  .object({
    firstName: profileShape.firstName.optional(),
    lastName: nullableText(60),
    phone: nullableText(20),
    whatsappNumber: nullableText(20),
    email: email.nullable().optional(),
    city: nullableText(100),
    state: nullableText(100),
    country: nullableText(100),
    countryInterested: key.nullable().optional(),
    courseInterested: key.nullable().optional(),
    degreeLevel: key.nullable().optional(),
    intake: key.nullable().optional(),
    educationDetails: nullableText(2000),
    ieltsScore: z.number().min(0).max(9).multipleOf(0.5).nullable().optional(),
    pteScore: z.number().min(10).max(90).nullable().optional(),
    toeflScore: z.number().int().min(0).max(120).nullable().optional(),
    otherTestScore: nullableText(100),
    budget: z.number().min(0).max(1e10).nullable().optional(),
    expectedPaymentDate: z.coerce.date().nullable().optional(),
    branchId: objectIdString.nullable().optional(),
    campaign: nullableText(200),
    notes: nullableText(5000),
    allowDuplicate: z.boolean().optional().openapi({ description: 'Save even if the new phone/email matches another lead' }),
  })
  .openapi('UpdateLeadRequest');

export const changeStageBody = z.object({ stage: key, note: optText(1000) }).openapi('ChangeLeadStageRequest');
export const changeStatusBody = z.object({ status: key, note: optText(1000) }).openapi('ChangeLeadStatusRequest');

export const assignBody = z
  .object({
    counsellorId: objectIdString.nullable().optional(),
    managerId: objectIdString.nullable().optional(),
    note: optText(1000),
  })
  .refine((v) => v.counsellorId !== undefined || v.managerId !== undefined, { message: 'Choose a counsellor or manager' })
  .openapi('AssignLeadRequest');

const leadIds = z.array(objectIdString).min(1).max(500);
export const bulkAssignBody = z
  .object({ leadIds, counsellorId: objectIdString.nullable().optional(), managerId: objectIdString.nullable().optional() })
  .refine((v) => v.counsellorId !== undefined || v.managerId !== undefined, { message: 'Choose a counsellor or manager' })
  .openapi('BulkAssignRequest');
export const bulkStageBody = z.object({ leadIds, stage: key }).openapi('BulkStageRequest');

export const mergeBody = z.object({ duplicateLeadId: objectIdString }).openapi('MergeLeadRequest');

export const checkDuplicatesBody = z
  .object({ phone: optText(20), whatsappNumber: optText(20), email: email.optional(), excludeLeadId: objectIdString.optional() })
  .openapi('CheckDuplicatesRequest');

const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

export const leadListQuery = paginationQuery.extend({
  sortBy: sortQuery(['createdAt', 'updatedAt', 'fullName', 'nextFollowUpAt', 'leadNumber'], 'createdAt'),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  branchId: objectIdString.optional(),
  assignedUser: z.union([objectIdString, z.literal('unassigned')]).optional().openapi({ description: 'Counsellor id or "unassigned"' }),
  assignedManager: objectIdString.optional(),
  stage: csv.optional().openapi({ description: 'Comma-separated stage keys' }),
  status: csv.optional().openapi({ description: 'Comma-separated status keys' }),
  source: csv.optional(),
  campaign: optText(200),
  country: key.optional(),
  course: key.optional(),
  intake: key.optional(),
  followUp: z.enum(['overdue', 'today', 'upcoming', 'none']).optional(),
  includeClosed: z.enum(['true', 'false']).transform((v) => v === 'true').default(true),
  filter: filterQueryParam.optional(),
});
export type LeadListQuery = z.infer<typeof leadListQuery>;

export const pipelineQuery = leadListQuery
  .pick({ branchId: true, assignedUser: true, source: true, country: true, search: true, filter: true })
  .extend({ perStage: z.coerce.number().int().min(1).max(50).default(20) });
export type PipelineQuery = z.infer<typeof pipelineQuery>;

const userRef = z.object({ _id: z.string(), fullName: z.string() }).nullable();
export const leadDto = z
  .object({
    _id: z.string(),
    leadNumber: z.number(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    phone: z.string().optional(),
    whatsappNumber: z.string().optional(),
    email: z.string().optional(),
    leadStage: z.string(),
    leadStatus: z.string(),
    leadSource: z.string(),
    campaign: z.string().optional(),
    branch: z.object({ _id: z.string(), name: z.string(), code: z.string() }).nullable(),
    assignedCounsellor: userRef,
    assignedManager: userRef,
    nextFollowUpAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .catchall(z.unknown())
  .openapi('Lead', { description: 'List items carry the fields above; detail adds every profile, attribution and history field.' });

export const duplicateMatchDto = z
  .object({
    _id: z.string(),
    leadNumber: z.number(),
    fullName: z.string(),
    matchedOn: z.array(z.enum(['phone', 'whatsappNumber', 'email'])),
    leadStage: z.string(),
    leadStatus: z.string(),
    originalSource: z.string(),
    latestSource: z.string(),
    campaign: z.string().nullable(),
    assignedCounsellor: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('DuplicateMatch');
