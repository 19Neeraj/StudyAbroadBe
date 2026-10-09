import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { FOLLOWUP_STATUSES } from './followup.model.js';

const notInPast = (d: Date) => d.getTime() >= Date.now() - 24 * 3_600_000;
const dueAt = z.coerce
  .date()
  .refine(notInPast, 'Pick a date and time from today onwards')
  .openapi({ description: 'Follow-up date and time (ISO 8601, with offset)', example: '2026-10-09T11:30:00+05:30' });

export const createFollowUpBody = z
  .object({
    dueAt,
    followUpType: z.string().trim().min(1).max(64).openapi({ description: 'Lookup key (type followup_type)', example: 'call' }),
    notes: z.string().trim().max(2000).optional(),
    nextAction: z.string().trim().max(500).optional(),
    assignedTo: objectIdString.optional().openapi({ description: 'Defaults to the lead’s counsellor (or you). Assigning others needs lead.assign.' }),
  })
  .openapi('CreateFollowUpRequest');

export const completeFollowUpBody = z
  .object({
    outcome: z.string().trim().min(1, 'Describe the outcome').max(2000),
    next: createFollowUpBody.omit({ assignedTo: true }).optional().openapi({ description: 'Schedule the next follow-up in the same step' }),
  })
  .openapi('CompleteFollowUpRequest');

export const rescheduleFollowUpBody = z
  .object({ dueAt, notes: z.string().trim().max(2000).optional() })
  .openapi('RescheduleFollowUpRequest');

export const cancelFollowUpBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).openapi('CancelFollowUpRequest');

export const FOLLOWUP_VIEWS = ['today', 'upcoming', 'overdue', 'completed', 'all'] as const;

export const followUpListQuery = paginationQuery.omit({ search: true }).extend({
  view: z.enum(FOLLOWUP_VIEWS).default('today'),
  assignedTo: z.union([objectIdString, z.literal('me')]).optional(),
  branchId: objectIdString.optional(),
  followUpType: z.string().max(64).optional(),
});
export type FollowUpListQuery = z.infer<typeof followUpListQuery>;

export const followUpSummaryQuery = z.object({
  mine: z.enum(['true', 'false']).transform((v) => v === 'true').default(true),
});

export const followUpDto = z
  .object({
    _id: z.string(),
    leadId: z.string(),
    lead: z.object({ _id: z.string(), leadNumber: z.number(), fullName: z.string(), phone: z.string().optional(), whatsappNumber: z.string().optional(), leadStage: z.string() }).nullable(),
    assignedTo: z.object({ _id: z.string(), fullName: z.string() }).nullable(),
    dueAt: z.string(),
    followUpType: z.string(),
    notes: z.string().optional(),
    nextAction: z.string().optional(),
    status: z.enum(FOLLOWUP_STATUSES),
    isOverdue: z.boolean(),
    outcome: z.string().optional(),
    completedAt: z.string().optional(),
    createdAt: z.string(),
  })
  .openapi('FollowUp');

export const followUpSummaryDto = z
  .object({ today: z.number(), overdue: z.number(), upcoming: z.number() })
  .openapi('FollowUpSummary');
