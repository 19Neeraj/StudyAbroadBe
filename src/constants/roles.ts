import { ALL_PERMISSIONS, FULL_ACCESS_PERMISSIONS, type Permission } from './permissions.js';

/**
 * Data scope decides *which* records a permission applies to:
 *  - organization: everything in the organization
 *  - branch: records in the user's assigned branches
 *  - own: records assigned to / created by the user
 */
export const DATA_SCOPES = ['organization', 'branch', 'own'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export const SUPER_ADMIN_ROLE_KEY = 'super_admin';
export const ORG_ADMIN_ROLE_KEY = 'org_admin';

export interface DefaultRole {
  key: string;
  name: string;
  description: string;
  dataScope: DataScope;
  permissions: Permission[];
}

const VIEW_ALL = ALL_PERMISSIONS.filter((p) => p.endsWith('.view') || p === 'lead.viewInquiries');

/** Seeded into every new organization. Admins can edit these or add their own. */
export const DEFAULT_ROLES: DefaultRole[] = [
  {
    key: ORG_ADMIN_ROLE_KEY,
    name: 'Organization Admin',
    description: 'Full access to the organization',
    dataScope: 'organization',
    permissions: [...FULL_ACCESS_PERMISSIONS],
  },
  {
    key: 'management',
    name: 'Management / CEO',
    description: 'Read access to everything, reports and exports',
    dataScope: 'organization',
    permissions: [...VIEW_ALL, 'report.export', 'lead.export', 'recording.download'],
  },
  {
    key: 'manager',
    name: 'Manager / Team Leader',
    description: 'Manages counsellors and leads in assigned branches',
    dataScope: 'branch',
    permissions: [
      'notification.send',
      'marketing.view',
      'user.view',
      'branch.view',
      'settings.view',
      'role.view',
      'lead.view',
      'lead.viewInquiries',
      'lead.create',
      'lead.update',
      'lead.assign',
      'lead.bulkAssign',
      'lead.changeStage',
      'lead.merge',
      'lead.export',
      'followup.view',
      'followup.manage',
      'student.view',
      'student.create',
      'student.update',
      'university.view',
      'application.view',
      'application.create',
      'application.update',
      'document.view',
      'document.upload',
      'document.approve',
      'document.reject',
      'event.view',
      'payment.view',
      'visa.view',
      'report.view',
      'report.export',
      'call.view',
      'call.make',
      'recording.view',
      'recording.download',
      'device.manage',
    ],
  },
  {
    key: 'marketing',
    name: 'Marketing',
    description: 'Lead capture, events and marketing reports',
    dataScope: 'organization',
    permissions: [
      'settings.view',
      'branch.view',
      'lead.view',
      'lead.viewInquiries',
      'lead.create',
      'lead.update',
      'lead.export',
      'event.view',
      'event.manage',
      'report.view',
      'report.export',
      'integration.view',
      'marketing.view',
      'marketing.manage',
      'marketing.export',
    ],
  },
  {
    key: 'counsellor',
    name: 'Counsellor',
    description: 'Works on own assigned leads and students',
    dataScope: 'own',
    permissions: [
      'settings.view',
      'branch.view',
      'lead.view',
      'lead.viewInquiries',
      'lead.create',
      'lead.update',
      'lead.changeStage',
      'followup.view',
      'followup.manage',
      'student.view',
      'student.create',
      'student.update',
      'university.view',
      'application.view',
      'application.create',
      'document.view',
      'document.upload',
      'event.view',
      'payment.view',
      'visa.view',
      'report.view',
      'call.view',
      'call.make',
      'recording.view',
    ],
  },
  {
    key: 'application_team',
    name: 'Application Team',
    description: 'Processes university applications and documents',
    dataScope: 'branch',
    permissions: [
      'settings.view',
      'branch.view',
      'lead.view',
      'lead.viewInquiries',
      'student.view',
      'student.update',
      'university.view',
      'university.manage',
      'application.view',
      'application.create',
      'application.update',
      'document.view',
      'document.upload',
      'document.approve',
      'document.reject',
      'payment.view',
      'report.view',
      'call.view',
      'call.make',
    ],
  },
  {
    key: 'visa_team',
    name: 'Visa Team',
    description: 'Handles visa processing',
    dataScope: 'branch',
    permissions: [
      'settings.view',
      'branch.view',
      'student.view',
      'application.view',
      'document.view',
      'document.upload',
      'document.approve',
      'document.reject',
      'visa.view',
      'visa.manage',
      'payment.view',
      'report.view',
      'call.view',
      'call.make',
    ],
  },
];
