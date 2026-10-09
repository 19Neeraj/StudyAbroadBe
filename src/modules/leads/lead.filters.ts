import type { FilterFieldCatalog } from '../../utils/filterTree.js';

/**
 * Fields usable in advanced lead filters (lists, pipeline, dashboards, reports, exports).
 * Every field here is either indexed with organizationId or only ever evaluated after an
 * indexed scope/date filter has narrowed the set.
 */
export const LEAD_FILTER_FIELDS: FilterFieldCatalog = {
  leadStage: { label: 'Stage', type: 'lookup', lookupType: 'lead_stage', group: 'Pipeline' },
  leadStatus: { label: 'Status', type: 'lookup', lookupType: 'lead_status', group: 'Pipeline' },
  stageChangedAt: { label: 'Stage changed', type: 'date', group: 'Pipeline' },
  nextFollowUpAt: { label: 'Next follow-up', type: 'date', group: 'Pipeline' },
  lastActivityAt: { label: 'Last activity', type: 'date', group: 'Pipeline' },
  expectedPaymentDate: { label: 'Expected payment date', type: 'date', group: 'Pipeline' },
  firstContactAt: { label: 'First contacted', type: 'date', group: 'Pipeline' },
  lastContactedAt: { label: 'Last contacted', type: 'date', group: 'Pipeline' },
  convertedAt: { label: 'Converted to student', type: 'date', group: 'Pipeline' },

  branchId: { label: 'Branch', type: 'reference', refType: 'branch', group: 'Ownership' },
  assignedCounsellor: { label: 'Counsellor', type: 'reference', refType: 'user', group: 'Ownership' },
  assignedManager: { label: 'Manager', type: 'reference', refType: 'user', group: 'Ownership' },
  createdBy: { label: 'Created by', type: 'reference', refType: 'user', group: 'Ownership' },
  assignedAt: { label: 'Assigned on', type: 'date', group: 'Ownership' },

  countryInterested: { label: 'Country interested', type: 'lookup', lookupType: 'country', group: 'Interest' },
  courseInterested: { label: 'Course interested', type: 'lookup', lookupType: 'course', group: 'Interest' },
  degreeLevel: { label: 'Degree level', type: 'lookup', lookupType: 'degree_level', group: 'Interest' },
  intake: { label: 'Intake', type: 'lookup', lookupType: 'intake', group: 'Interest' },
  budget: { label: 'Budget', type: 'number', group: 'Interest' },
  ieltsScore: { label: 'IELTS', type: 'number', group: 'Interest' },
  pteScore: { label: 'PTE', type: 'number', group: 'Interest' },
  toeflScore: { label: 'TOEFL', type: 'number', group: 'Interest' },

  leadSource: { label: 'Source', type: 'lookup', lookupType: 'lead_source', group: 'Marketing' },
  campaign: { label: 'Campaign', type: 'text', group: 'Marketing' },
  platform: { label: 'Platform', type: 'text', group: 'Marketing' },
  adSet: { label: 'Ad set', type: 'text', group: 'Marketing' },
  ad: { label: 'Ad', type: 'text', group: 'Marketing' },
  leadForm: { label: 'Lead form', type: 'text', group: 'Marketing' },
  utmSource: { label: 'UTM source', type: 'text', group: 'Marketing' },
  utmMedium: { label: 'UTM medium', type: 'text', group: 'Marketing' },
  utmCampaign: { label: 'UTM campaign', type: 'text', group: 'Marketing' },
  anySource: { label: 'Any enquiry source (incl. repeat enquiries)', type: 'lookup', lookupType: 'lead_source', path: 'sourceHistory.leadSource', group: 'Marketing' },

  city: { label: 'City', type: 'text', group: 'Contact' },
  state: { label: 'State', type: 'text', group: 'Contact' },
  country: { label: 'Country of residence', type: 'text', group: 'Contact' },
  email: { label: 'Email', type: 'text', group: 'Contact' },
  phone: { label: 'Phone', type: 'text', group: 'Contact' },

  leadNumber: { label: 'Lead number', type: 'number', group: 'Record' },
  createdAt: { label: 'Created', type: 'date', group: 'Record' },
  updatedAt: { label: 'Updated', type: 'date', group: 'Record' },
};
