/**
 * Configurable CRM master data. Every organization gets these defaults on creation and
 * can rename, reorder, add or deactivate values from Admin Settings.
 *
 * Records store the lookup `key` (stable, never edited); UIs show the `label`.
 * `system` values are referenced by workflow logic and can be renamed but not deactivated.
 */
export const LOOKUP_TYPES = [
  'country',
  'course',
  'degree_level',
  'intake',
  'lead_source',
  'lead_stage',
  'lead_status',
  'followup_type',
  'event_type',
  'application_status',
  'document_type',
  'call_outcome',
] as const;
export type LookupType = (typeof LOOKUP_TYPES)[number];

/** Analytics milestones (spec §52). A stage's `meta.milestone` marks it; defaults map to the standard stage keys. */
export const STAGE_MILESTONES = ['contacted', 'meeting', 'shortlisting', 'application', 'offer', 'payment', 'visa', 'enrolment'] as const;
export type StageMilestone = (typeof STAGE_MILESTONES)[number];
export const DEFAULT_MILESTONE_STAGES: Record<StageMilestone, string> = {
  contacted: 'contacted',
  meeting: 'meeting_done',
  shortlisting: 'shortlisted',
  application: 'application',
  offer: 'offer_received',
  payment: 'payment_pending',
  visa: 'visa',
  enrolment: 'enrolled',
};

export interface LookupSeed {
  label: string;
  key?: string;
  color?: string;
  system?: boolean;
  meta?: Record<string, unknown>;
}

const intakes = (): LookupSeed[] => {
  const year = new Date().getFullYear();
  return [year + 1, year + 2].flatMap((y) =>
    (['Jan', 'May', 'Sep'] as const).map((m) => ({
      label: `${m} ${y}`,
      key: `${m.toLowerCase()}_${y}`,
    })),
  );
};

export function defaultLookups(): Record<LookupType, LookupSeed[]> {
  return {
    country: [
      { label: 'United Kingdom', key: 'uk', meta: { isoCode: 'GB' } },
      { label: 'United States', key: 'usa', meta: { isoCode: 'US' } },
      { label: 'Canada', key: 'canada', meta: { isoCode: 'CA' } },
      { label: 'Australia', key: 'australia', meta: { isoCode: 'AU' } },
      { label: 'New Zealand', key: 'new_zealand', meta: { isoCode: 'NZ' } },
      { label: 'Ireland', key: 'ireland', meta: { isoCode: 'IE' } },
      { label: 'Germany', key: 'germany', meta: { isoCode: 'DE' } },
      { label: 'France', key: 'france', meta: { isoCode: 'FR' } },
      { label: 'Dubai (UAE)', key: 'uae', meta: { isoCode: 'AE' } },
    ],
    course: [
      { label: 'Business & Management' },
      { label: 'MBA' },
      { label: 'Computer Science & IT' },
      { label: 'Data Science & Analytics' },
      { label: 'Engineering' },
      { label: 'Health & Medicine' },
      { label: 'Law' },
      { label: 'Arts & Design' },
      { label: 'Hospitality & Tourism' },
    ],
    degree_level: [
      { label: 'Foundation' },
      { label: 'Diploma' },
      { label: "Bachelor's", key: 'bachelors' },
      { label: "Master's", key: 'masters' },
      { label: 'PhD', key: 'phd' },
    ],
    intake: intakes(),
    lead_source: [
      { label: 'Meta', key: 'meta' },
      { label: 'Google', key: 'google' },
      { label: 'Website', key: 'website' },
      { label: 'Event', key: 'event', system: true },
      { label: 'Google Forms', key: 'google_forms' },
      { label: 'Walk-in', key: 'walk_in' },
      { label: 'Referral', key: 'referral' },
      { label: 'Organic', key: 'organic' },
      { label: 'Manual', key: 'manual', system: true },
    ],
    // category: open (active pipeline) | won (final success)
    lead_stage: [
      {
        label: 'New Lead',
        key: 'new_lead',
        system: true,
        color: '#64748b',
        meta: { category: 'open' },
      },
      { label: 'Contacted', key: 'contacted', color: '#0ea5e9', meta: { category: 'open', milestone: 'contacted' } },
      {
        label: 'Meeting Pending',
        key: 'meeting_pending',
        color: '#6366f1',
        meta: { category: 'open' },
      },
      { label: 'Meeting Done', key: 'meeting_done', color: '#8b5cf6', meta: { category: 'open', milestone: 'meeting' } },
      {
        label: 'Shortlisting Pending',
        key: 'shortlisting_pending',
        color: '#a855f7',
        meta: { category: 'open' },
      },
      { label: 'Shortlisted', key: 'shortlisted', color: '#d946ef', meta: { category: 'open', milestone: 'shortlisting' } },
      { label: 'Application', key: 'application', color: '#ec4899', meta: { category: 'open', milestone: 'application' } },
      {
        label: 'Offer Received',
        key: 'offer_received',
        color: '#f97316',
        meta: { category: 'open', milestone: 'offer' },
      },
      {
        label: 'Payment Pending',
        key: 'payment_pending',
        color: '#eab308',
        meta: { category: 'open', milestone: 'payment' },
      },
      { label: 'Visa', key: 'visa', color: '#84cc16', meta: { category: 'open', milestone: 'visa' } },
      {
        label: 'Enrolled',
        key: 'enrolled',
        system: true,
        color: '#16a34a',
        meta: { category: 'won', milestone: 'enrolment' },
      },
    ],
    // isClosed: lead leaves the active pipeline
    lead_status: [
      { label: 'Active', key: 'active', system: true, color: '#16a34a', meta: { isClosed: false } },
      {
        label: 'Not Interested',
        key: 'not_interested',
        color: '#94a3b8',
        meta: { isClosed: true },
      },
      { label: 'Dummy', key: 'dummy', color: '#94a3b8', meta: { isClosed: true } },
      {
        label: 'Duplicate',
        key: 'duplicate',
        system: true,
        color: '#f59e0b',
        meta: { isClosed: true },
      },
      { label: 'Invalid', key: 'invalid', color: '#ef4444', meta: { isClosed: true } },
      { label: 'Lost', key: 'lost', color: '#ef4444', meta: { isClosed: true } },
    ],
    followup_type: [
      { label: 'Call', key: 'call' },
      { label: 'WhatsApp', key: 'whatsapp' },
      { label: 'Email', key: 'email' },
      { label: 'Meeting', key: 'meeting' },
      { label: 'Other', key: 'other' },
    ],
    event_type: [
      { label: 'Education Fair', key: 'education_fair' },
      { label: 'University Spot Admission', key: 'spot_admission' },
      { label: 'Webinar', key: 'webinar' },
      { label: 'Seminar', key: 'seminar' },
    ],
    application_status: [
      { label: 'Draft', key: 'draft', system: true, color: '#94a3b8' },
      { label: 'Documents Pending', key: 'documents_pending', color: '#f59e0b' },
      { label: 'Submitted', key: 'submitted', color: '#3b82f6', meta: { leadMilestone: 'application' } },
      { label: 'Under Review', key: 'under_review', color: '#6366f1', meta: { leadMilestone: 'application' } },
      { label: 'Conditional Offer', key: 'conditional_offer', color: '#14b8a6', meta: { leadMilestone: 'offer' } },
      { label: 'Unconditional Offer', key: 'unconditional_offer', color: '#16a34a', meta: { leadMilestone: 'offer' } },
      { label: 'Rejected', key: 'rejected', color: '#ef4444', meta: { isFinal: true } },
      { label: 'Withdrawn', key: 'withdrawn', color: '#94a3b8', meta: { isFinal: true } },
      { label: 'Enrolled', key: 'enrolled', system: true, color: '#15803d', meta: { leadMilestone: 'enrolment', isFinal: true } },
    ],
    // requiresFollowUp: the outcome dialog asks for the next follow-up; isPositive: counts as an interested conversation
    call_outcome: [
      { label: 'Interested', key: 'interested', meta: { isPositive: true, requiresFollowUp: true } },
      { label: 'Not Interested', key: 'not_interested', meta: { isPositive: false, requiresFollowUp: false } },
      { label: 'Call Back', key: 'call_back', meta: { isPositive: false, requiresFollowUp: true } },
      { label: 'Meeting Required', key: 'meeting_required', meta: { isPositive: true, requiresFollowUp: true } },
      { label: 'Documents Required', key: 'documents_required', meta: { isPositive: true, requiresFollowUp: true } },
      { label: 'Application Discussion', key: 'application_discussion', meta: { isPositive: true, requiresFollowUp: true } },
      { label: 'Payment Discussion', key: 'payment_discussion', meta: { isPositive: true, requiresFollowUp: true } },
      { label: 'Visa Discussion', key: 'visa_discussion', meta: { isPositive: true, requiresFollowUp: true } },
      { label: 'Wrong Number', key: 'wrong_number', system: true, meta: { isPositive: false, requiresFollowUp: false } },
      { label: 'No Response', key: 'no_response', system: true, meta: { isPositive: false, requiresFollowUp: true } },
      { label: 'Other', key: 'other', meta: { isPositive: false, requiresFollowUp: false } },
    ],
    document_type: [
      { label: 'Passport', key: 'passport' },
      { label: '10th Marksheet', key: 'class_10' },
      { label: '12th Marksheet', key: 'class_12' },
      { label: "Bachelor's Degree", key: 'bachelors' },
      { label: "Master's Degree", key: 'masters' },
      { label: 'Mark Sheets', key: 'mark_sheets' },
      { label: 'IELTS', key: 'ielts' },
      { label: 'PTE', key: 'pte' },
      { label: 'TOEFL', key: 'toefl' },
      { label: 'CV', key: 'cv' },
      { label: 'SOP', key: 'sop' },
      { label: 'LOR', key: 'lor' },
      { label: 'Financial Documents', key: 'financial' },
      { label: 'Offer Letter', key: 'offer_letter' },
      { label: 'Visa Documents', key: 'visa_documents' },
      { label: 'Other', key: 'other' },
    ],
  };
}
