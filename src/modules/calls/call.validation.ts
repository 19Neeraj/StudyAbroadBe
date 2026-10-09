import { z } from '../../docs/zod.js';
import { filterQueryParam } from '../../utils/filterTree.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';
import { PERIOD_PRESETS } from '../../utils/time.js';
import { createFollowUpBody } from '../followups/followup.validation.js';
import { CALL_DIRECTIONS, CALL_STATUSES, CONSENT_STATUSES, TERMINAL_CALL_STATUSES } from './call.model.js';

const key = z.string().trim().min(1).max(64);
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
const duration = z.number().int().min(0).max(36_000).openapi({ description: 'Talk time in seconds' });

const outcomeShape = {
  callOutcome: key.optional().openapi({ description: 'Lookup key (type call_outcome)' }),
  notes: z.string().trim().max(2000).optional(),
  nextAction: z.string().trim().max(500).optional(),
  followUp: createFollowUpBody.omit({ assignedTo: true }).optional().openapi({ description: 'Schedule the next follow-up in the same step' }),
};

export const initiateCallBody = z
  .object({
    leadId: objectIdString,
    numberType: z.enum(['phone', 'whatsapp']).default('phone'),
  })
  .openapi('InitiateCallRequest');

export const completeCallBody = z
  .object({
    status: z.enum(TERMINAL_CALL_STATUSES).optional().openapi({ description: 'Device calls only; cloud calls get status from the provider' }),
    durationSeconds: duration.optional(),
    endedAt: z.coerce.date().optional(),
    recordingConsent: z.enum(['granted', 'denied']).optional().openapi({ description: 'Explicit-consent mode: what the student said' }),
    ...outcomeShape,
  })
  .openapi('CompleteCallRequest');

export const outcomeBody = z.object(outcomeShape).openapi('CallOutcomeRequest');

export const logCallBody = z
  .object({
    leadId: objectIdString,
    direction: z.enum(CALL_DIRECTIONS).default('outgoing'),
    status: z.enum(TERMINAL_CALL_STATUSES).default('completed'),
    startedAt: z.coerce.date().refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'Cannot be in the future'),
    durationSeconds: duration.default(0),
    ...outcomeShape,
  })
  .refine((v) => v.status !== 'completed' || v.durationSeconds > 0, { message: 'A completed call needs a duration', path: ['durationSeconds'] })
  .openapi('LogCallRequest');

export const callListQuery = paginationQuery.extend({
  sortBy: sortQuery(['startedAt', 'duration'], 'startedAt'),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  counsellor: objectIdString.optional(),
  branchId: objectIdString.optional(),
  leadId: objectIdString.optional(),
  direction: z.enum(CALL_DIRECTIONS).optional(),
  status: csv.pipe(z.array(z.enum(CALL_STATUSES))).optional(),
  outcome: csv.optional(),
  connected: z.enum(['true', 'false']).optional(),
  hasRecording: z.enum(['true', 'false']).optional(),
  minDuration: z.coerce.number().int().min(0).optional(),
  maxDuration: z.coerce.number().int().min(0).optional(),
  source: csv.optional(),
  campaign: z.string().trim().max(200).optional(),
  country: key.optional(),
  course: key.optional(),
});
export type CallListQuery = z.infer<typeof callListQuery>;

export const callAnalyticsQuery = z.object({
  period: z.enum(PERIOD_PRESETS).default('this_month'),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  branchId: objectIdString.optional(),
  counsellor: objectIdString.optional(),
  source: csv.optional(),
  campaign: z.string().trim().max(200).optional(),
  country: key.optional(),
  course: key.optional(),
  /** Nested filter on the called leads (lead fields). */
  filter: filterQueryParam.optional(),
});
export type CallAnalyticsQuery = z.infer<typeof callAnalyticsQuery>;

export const transcriptSearchQuery = paginationQuery.extend({
  q: z.string().trim().min(2).max(200).openapi({ description: 'Words or "a phrase" to find in transcripts', example: 'budget' }),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  counsellor: objectIdString.optional(),
});

export const editSummaryBody = z
  .object({ summary: z.string().trim().min(1).max(5000).optional(), nextAction: z.string().trim().max(500).optional() })
  .openapi('EditAiSummaryRequest');

const ref = z.object({ _id: z.string(), fullName: z.string() }).nullable();
export const callDto = z
  .object({
    _id: z.string(),
    provider: z.string(),
    source: z.string(),
    direction: z.enum(CALL_DIRECTIONS),
    status: z.enum(CALL_STATUSES),
    phoneNumber: z.string(),
    startedAt: z.string(),
    answeredAt: z.string().nullable().optional(),
    endedAt: z.string().nullable().optional(),
    duration: z.number(),
    connected: z.boolean(),
    callOutcome: z.string().nullable().optional(),
    nextAction: z.string().optional(),
    lead: z.object({ _id: z.string(), leadNumber: z.number(), fullName: z.string() }).nullable(),
    counsellor: ref,
    recordingConsent: z.object({ status: z.enum(CONSENT_STATUSES) }).partial().optional(),
    hasRecording: z.boolean(),
    hasTranscript: z.boolean(),
    hasSummary: z.boolean(),
  })
  .catchall(z.unknown())
  .openapi('Call');

export const initiateCallDto = z
  .object({
    call: callDto,
    mode: z.enum(['device', 'cloud']).openapi({ description: 'device: open the native dialler with `dial`; cloud: the provider is ringing your phone' }),
    dial: z.string().nullable(),
    consentMessage: z.string().nullable(),
  })
  .openapi('InitiateCallResponse');
