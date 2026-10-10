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

const levelPath = z
  .object({ l1: objectIdString.nullable().optional(), l2: objectIdString.nullable().optional(), l3: objectIdString.nullable().optional() })
  .openapi({ description: 'Primary (l1) → Secondary (l2) → Tertiary (l3) value ids; each must be a child of the level above' });
export const attributionPathSchema = z
  .object({ source: levelPath.optional(), medium: levelPath.optional(), campaign: levelPath.optional() })
  .openapi('AttributionPath');

export const DUPLICATE_ACTIONS = ['keep_existing', 'create_separate', 'mark_duplicate'] as const;

export const createLeadBody = z
  .object({
    ...profileShape,
    ...attributionShape,
    leadStage: key.optional().openapi({ description: 'Defaults to new_lead' }),
    assignedCounsellor: objectIdString.optional(),
    assignedManager: objectIdString.optional(),
    notes: optText(5000),
    attribution: attributionPathSchema.optional().openapi({
      description: 'Hierarchical Source / Medium / Campaign attribution of this enquiry. Invalid parent/child combinations are rejected.',
    }),
    duplicateAction: z.enum(DUPLICATE_ACTIONS).optional().openapi({
      description:
        'How to resolve a DUPLICATE_LEAD conflict (email / WhatsApp matches): keep_existing (record this enquiry on the existing lead), ' +
        'create_separate, or mark_duplicate (create it as a duplicate of the existing lead). The last two need lead.merge. ' +
        'A phone number that already belongs to an active lead is always recorded as a re-inquiry of that lead.',
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
    allowDuplicate: z.boolean().optional().openapi({ description: 'Save even if the new email / WhatsApp number matches another lead (never for a phone number another active lead uses)' }),
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
const csvIds = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(objectIdString).min(1).max(50))
  .openapi({ type: 'string', description: 'Comma-separated hierarchy value ids' });

export const leadListQuery = paginationQuery.extend({
  sortBy: sortQuery(['createdAt', 'updatedAt', 'fullName', 'nextFollowUpAt', 'leadNumber', 'lastInquiryAt', 'inquiryCount'], 'createdAt'),
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

  // Re-inquiry filters (based on inquiry history, not a manual badge).
  inquiryType: z.enum(['all', 'first_time', 'reinquiry']).optional().openapi({ description: 'first_time: one inquiry; reinquiry: two or more' }),
  inquiryCountMin: z.coerce.number().int().min(1).max(1000).optional(),
  inquiryCountMax: z.coerce.number().int().min(1).max(1000).optional(),
  firstInquiryFrom: z.coerce.date().optional(),
  firstInquiryTo: z.coerce.date().optional(),
  lastInquiryFrom: z.coerce.date().optional(),
  lastInquiryTo: z.coerce.date().optional(),
  inquiryFrom: z.coerce.date().optional().openapi({ description: 'Leads with any inquiry (first or repeat) in this range' }),
  inquiryTo: z.coerce.date().optional(),
  inquiryChannel: csv.optional().openapi({ description: 'Inquiry channel(s): meta_lead_ad, website_form, manual, import, event, api, …' }),
  inquiryStatus: z.enum(['new', 'pending_review', 'handled']).optional().openapi({ description: 'Leads with a re-inquiry in this status (pending_review = re-inquiry queue)' }),

  // Hierarchical attribution, matched against the chosen attribution context.
  attributionMode: z.enum(['original', 'latest', 'any']).default('original').openapi({
    description: 'original: first-touch attribution · latest: most recent inquiry · any: any inquiry in the history',
  }),
  sourcePrimary: csvIds.optional(),
  sourceSecondary: csvIds.optional(),
  sourceTertiary: csvIds.optional(),
  mediumPrimary: csvIds.optional(),
  mediumSecondary: csvIds.optional(),
  mediumTertiary: csvIds.optional(),
  campaignPrimary: csvIds.optional(),
  campaignSecondary: csvIds.optional(),
  campaignTertiary: csvIds.optional(),

  // Raw tracking / integration identifiers (same attribution context). UTM values match case-insensitively.
  utmSource: optText(200),
  utmMedium: optText(200),
  utmCampaign: optText(200),
  utmTerm: optText(200),
  utmContent: optText(200),
  provider: optText(50),
  campaignExternalId: optText(100),
  adExternalId: optText(100),
  formExternalId: optText(100),
  landingPage: optText(500).openapi({ description: 'Landing page URL prefix' }),
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
    samePhone: z.boolean().openapi({ description: 'Creating a lead with this phone records a re-inquiry on this lead instead' }),
    leadStage: z.string(),
    leadStatus: z.string(),
    originalSource: z.string(),
    latestSource: z.string(),
    campaign: z.string().nullable(),
    assignedCounsellor: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('DuplicateMatch');
