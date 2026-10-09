/** Timeline event types shown on a lead/student (spec §16). */
export const SYSTEM_ACTIVITY_TYPES = [
  'lead_created',
  'lead_updated',
  'lead_assigned',
  'lead_reassigned',
  'stage_changed',
  'status_changed',
  'duplicate_enquiry',
  'lead_merged',
  'merged_into',
  'followup_created',
  'followup_completed',
  'followup_rescheduled',
  'followup_cancelled',
  'student_converted',
  'student_updated',
  'call_completed',
  'call_missed',
  'shortlist_added',
  'shortlist_updated',
  'application_created',
  'application_updated',
  'offer_updated',
  'payment_recorded',
  'payment_updated',
  'visa_updated',
  'document_uploaded',
  'document_reviewed',
] as const;

/** Types a user can log by hand (communication + notes). */
export const MANUAL_ACTIVITY_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'note', 'other'] as const;

export const ACTIVITY_TYPES = [...SYSTEM_ACTIVITY_TYPES, ...MANUAL_ACTIVITY_TYPES] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type ManualActivityType = (typeof MANUAL_ACTIVITY_TYPES)[number];

export const COMMUNICATION_TYPES: ActivityType[] = ['call', 'whatsapp', 'email', 'meeting'];
