import { z } from '../../docs/zod.js';
import { activityDto, activityListQuery, logActivityBody } from '../activities/activity.validation.js';
import { listLeadActivities } from '../activities/activity.service.js';
import { listLeadCalls } from '../calls/call.service.js';
import { callDto, callListQuery } from '../calls/call.validation.js';
import { convertLead } from '../students/student.service.js';
import { convertLeadBody, studentDto } from '../students/student.validation.js';
import { createFollowUp, listLeadFollowUps } from '../followups/followup.service.js';
import { createFollowUpBody, followUpDto } from '../followups/followup.validation.js';
import { idParams } from '../../utils/objectId.js';
import { describeCatalog, filterFieldDto } from '../../utils/filterTree.js';
import { ApiError } from '../../utils/ApiError.js';
import { createModuleRouter } from '../../utils/router.js';
import { listLeadInquiries, markInquiryHandled } from './lead.inquiries.js';
import { LEAD_FILTER_FIELDS } from './lead.filters.js';
import { loadLead } from './lead.access.js';
import { assignLead, bulkAssignLeads } from './lead.assignment.js';
import { findDuplicates, normalizeContact } from './lead.duplicates.js';
import * as service from './lead.service.js';
import {
  assignBody,
  bulkAssignBody,
  bulkStageBody,
  changeStageBody,
  changeStatusBody,
  checkDuplicatesBody,
  createLeadBody,
  duplicateMatchDto,
  leadDto,
  leadListQuery,
  mergeBody,
  pipelineQuery,
  updateLeadBody,
} from './lead.validation.js';

const m = createModuleRouter('/leads', 'Leads');
const bulkResult = z.object({ updated: z.number(), unchanged: z.number(), skipped: z.number() });

m.route({
  method: 'get',
  path: '/',
  summary: 'List leads with search, filters, sorting and pagination',
  description:
    'Search matches lead number (#1001), phone/WhatsApp (full or prefix), email prefix and name-word prefixes, all index-backed. ' +
    'Results are limited by the caller’s data scope.',
  permissions: ['lead.view'],
  query: leadListQuery,
  response: z.array(leadDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listLeads(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/filter-fields',
  summary: 'Fields and operators available to the advanced (nested AND/OR) lead filter',
  permissions: ['lead.view'],
  response: z.array(filterFieldDto),
  handler: async () => ({ data: describeCatalog(LEAD_FILTER_FIELDS) }),
});

m.route({
  method: 'get',
  path: '/pipeline',
  summary: 'Pipeline board: count and latest leads per stage (closed statuses excluded)',
  permissions: ['lead.view'],
  query: pipelineQuery,
  response: z.array(
    z.object({ stage: z.string(), label: z.string(), color: z.string().nullable(), category: z.string(), count: z.number(), leads: z.array(leadDto) }),
  ),
  handler: async ({ ctx, query }) => ({ data: await service.leadPipeline(ctx, query) }),
});

m.route({
  method: 'post',
  path: '/',
  summary: 'Create a lead (with duplicate detection)',
  description:
    'A phone number that already belongs to an active lead of the organization is **never** a new lead: the submission is ' +
    'recorded as a re-inquiry of that lead (`outcome: added_to_existing`, `reinquiry: true`, same `leadId`). ' +
    'If only the WhatsApp number or email matches, the API answers **409 `DUPLICATE_LEAD`** with `details.duplicates`; resend ' +
    'with `duplicateAction` to resolve it. Send an `Idempotency-Key` header to make retries safe (`outcome: duplicate_event`). ' +
    'Leads created by users who work on their own records are assigned to them automatically.',
  permissions: ['lead.create'],
  body: createLeadBody,
  response: z.object({
    outcome: z.enum(['created', 'added_to_existing', 'duplicate_event']),
    leadId: z.string(),
    lead: leadDto.nullable(),
    reinquiry: z.boolean().optional().openapi({ description: 'True when the submission was recorded as a re-inquiry of the existing lead' }),
    inquiryId: z.string().optional(),
    inquiryCount: z.number().optional(),
  }),
  successStatus: 201,
  handler: async ({ ctx, body, req }) => {
    const key = req.get('idempotency-key')?.trim();
    if (key && (key.length < 8 || key.length > 128)) throw ApiError.validation([{ field: 'header.Idempotency-Key', message: 'Use 8–128 characters' }]);
    const result = await service.createLead(ctx, body, { inquiry: { idempotencyKey: key ? `api:${ctx.userId.toString()}:${key}` : undefined } });
    const messages = { created: 'Lead created', added_to_existing: 'Re-inquiry recorded on the existing lead', duplicate_event: 'Already received; nothing changed' } as const;
    return { status: result.outcome === 'created' ? 201 : 200, message: messages[result.outcome], data: result };
  },
});

m.route({
  method: 'post',
  path: '/check-duplicates',
  summary: 'Check a phone/email for existing leads before creating or editing',
  permissions: ['lead.create', 'lead.update'],
  permissionMode: 'any',
  body: checkDuplicatesBody,
  response: z.array(duplicateMatchDto),
  handler: async ({ ctx, body }) => {
    const contact = await normalizeContact(ctx, body);
    return { data: await findDuplicates(ctx, contact, body.excludeLeadId) };
  },
});

m.route({
  method: 'post',
  path: '/bulk-assign',
  summary: 'Assign many leads to a counsellor and/or manager',
  description: 'Leads outside your scope are skipped. Open follow-ups move to the new counsellor.',
  permissions: ['lead.bulkAssign'],
  body: bulkAssignBody,
  response: bulkResult,
  handler: async ({ ctx, body }) => ({ message: 'Leads assigned', data: await bulkAssignLeads(ctx, body) }),
});

m.route({
  method: 'post',
  path: '/bulk-stage',
  summary: 'Move many leads to a stage',
  permissions: ['lead.changeStage'],
  body: bulkStageBody,
  response: bulkResult,
  handler: async ({ ctx, body }) => ({ message: 'Stage updated', data: await service.bulkChangeStage(ctx, body) }),
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Lead details',
  permissions: ['lead.view'],
  params: idParams,
  response: leadDto,
  handler: async ({ ctx, params }) => ({ data: await service.getLead(ctx, params.id) }),
});

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update lead details',
  description: 'Changing phone/email to one used by another lead returns 409 `DUPLICATE_LEAD` unless `allowDuplicate` is true.',
  permissions: ['lead.update'],
  params: idParams,
  body: updateLeadBody,
  response: leadDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Lead updated', data: await service.updateLead(ctx, params.id, body) }),
});

m.route({
  method: 'delete',
  path: '/:id',
  summary: 'Delete a lead (soft delete; history is kept)',
  permissions: ['lead.delete'],
  params: idParams,
  response: z.null(),
  handler: async ({ ctx, params }) => {
    await service.deleteLead(ctx, params.id);
    return { message: 'Lead deleted', data: null };
  },
});

m.route({
  method: 'patch',
  path: '/:id/stage',
  summary: 'Move a lead to another pipeline stage',
  permissions: ['lead.changeStage'],
  params: idParams,
  body: changeStageBody,
  response: leadDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Stage updated', data: await service.changeStage(ctx, params.id, body) }),
});

m.route({
  method: 'patch',
  path: '/:id/status',
  summary: 'Change lead status (e.g. Not Interested, Lost)',
  permissions: ['lead.update'],
  params: idParams,
  body: changeStatusBody,
  response: leadDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Status updated', data: await service.changeStatus(ctx, params.id, body) }),
});

m.route({
  method: 'post',
  path: '/:id/assign',
  summary: 'Assign or reassign the counsellor and/or manager',
  description: 'Pass null to unassign. Open follow-ups move to the new counsellor.',
  permissions: ['lead.assign'],
  params: idParams,
  body: assignBody,
  response: leadDto,
  handler: async ({ ctx, params, body }) => {
    const id = await assignLead(ctx, params.id, body);
    return { message: 'Lead assigned', data: await service.getLead(ctx, id) };
  },
});

m.route({
  method: 'get',
  path: '/:id/duplicates',
  summary: 'Other leads sharing this lead’s phone, WhatsApp or email',
  permissions: ['lead.view'],
  params: idParams,
  response: z.array(duplicateMatchDto),
  handler: async ({ ctx, params }) => ({ data: await service.leadDuplicates(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/:id/merge',
  summary: 'Merge a duplicate lead into this lead',
  description: 'Fills empty fields, moves source history, follow-ups and timeline, and closes the duplicate as "Duplicate". Nothing is deleted.',
  permissions: ['lead.merge'],
  params: idParams,
  body: mergeBody,
  response: leadDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Leads merged', data: await service.mergeLeads(ctx, params.id, body.duplicateLeadId) }),
});

m.route({
  method: 'post',
  path: '/:id/convert',
  summary: 'Convert a lead into a student',
  description: 'Copies contact details, interest and test scores into a new student profile and links both records. Answers 409 `ALREADY_CONVERTED` (with `details.studentId`) when the lead already has a student.',
  permissions: ['lead.view', 'student.create'],
  params: idParams,
  body: convertLeadBody,
  response: studentDto,
  successStatus: 201,
  handler: async ({ ctx, params, body }) => ({ message: 'Lead converted to student', data: await convertLead(ctx, params.id, body) }),
});

m.route({
  method: 'get',
  path: '/:id/activities',
  summary: 'Lead timeline (newest first)',
  permissions: ['lead.view'],
  params: idParams,
  query: activityListQuery,
  response: z.array(activityDto),
  paginated: true,
  handler: async ({ ctx, params, query }) => {
    const lead = await loadLead(ctx, params.id);
    const { items, pagination } = await listLeadActivities(ctx, lead._id, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'post',
  path: '/:id/activities',
  summary: 'Log a call, WhatsApp, email, meeting or note',
  permissions: ['lead.update'],
  params: idParams,
  body: logActivityBody,
  response: activityDto,
  successStatus: 201,
  handler: async ({ ctx, params, body }) => ({ message: 'Activity logged', data: await service.logLeadActivity(ctx, params.id, body) }),
});

m.route({
  method: 'get',
  path: '/:id/calls',
  summary: 'Calls with this lead (any counsellor)',
  permissions: ['lead.view', 'call.view'],
  params: idParams,
  query: callListQuery,
  response: z.array(callDto),
  paginated: true,
  handler: async ({ ctx, params, query }) => {
    const { items, pagination } = await listLeadCalls(ctx, params.id, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/:id/followups',
  summary: 'Follow-ups of a lead',
  permissions: ['lead.view', 'followup.view'],
  params: idParams,
  response: z.array(followUpDto),
  handler: async ({ ctx, params }) => ({ data: await listLeadFollowUps(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/:id/followups',
  summary: 'Schedule a follow-up',
  permissions: ['followup.manage'],
  params: idParams,
  body: createFollowUpBody,
  response: followUpDto,
  successStatus: 201,
  handler: async ({ ctx, params, body }) => ({ message: 'Follow-up scheduled', data: await createFollowUp(ctx, params.id, body) }),
});

m.route({
  method: 'get',
  path: '/:id/inquiries',
  summary: 'Inquiry history of a lead: first inquiry, re-inquiries, attribution of each, assignment decisions',
  description: 'Same visibility as the lead itself (data scope and assigned-only access apply).',
  permissions: ['lead.view', 'lead.viewInquiries'],
  params: idParams,
  handler: async ({ ctx, params }) => ({ data: await listLeadInquiries(ctx, params.id) }),
});

m.route({
  method: 'post',
  path: '/:id/inquiries/:inquiryId/handled',
  summary: 'Mark a re-inquiry from the review queue as handled',
  permissions: ['lead.update'],
  params: z.object({ id: idParams.shape.id, inquiryId: idParams.shape.id }),
  response: z.null(),
  handler: async ({ ctx, params }) => {
    await markInquiryHandled(ctx, params.id, params.inquiryId);
    return { message: 'Inquiry marked as handled', data: null };
  },
});

export const leadModule = m;
