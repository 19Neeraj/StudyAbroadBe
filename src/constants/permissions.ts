/**
 * Permission catalog. Permissions are enforced in code, so the catalog lives in code;
 * which roles hold which permissions is data and is configured per organization.
 */
export const PERMISSION_CATALOG = {
  organization: {
    'organization.view': 'View organization profile and settings',
    'organization.update': 'Update organization profile and settings',
  },
  user: {
    'user.view': 'View users',
    'user.create': 'Create users',
    'user.update': 'Update users, their roles and branches',
    'user.deactivate': 'Activate or deactivate users',
  },
  role: {
    'role.view': 'View roles',
    'role.manage': 'Create, update and delete roles',
  },
  branch: {
    'branch.view': 'View branches',
    'branch.manage': 'Create, update and deactivate branches',
  },
  settings: {
    'settings.view': 'View CRM configuration (stages, sources, countries, …)',
    'settings.manage': 'Change CRM configuration',
  },
  lead: {
    'lead.view': 'View leads',
    'lead.viewAssignedOnly':
      'View only assigned leads: restricts lists, search, counts, exports, reports and lead details to leads where the user is the assigned counsellor or manager',
    'lead.viewInquiries': 'View re-inquiry history and inquiry attribution of leads the user can see',
    'lead.create': 'Create leads',
    'lead.update': 'Update leads',
    'lead.delete': 'Delete leads',
    'lead.assign': 'Assign and reassign leads',
    'lead.bulkAssign': 'Bulk assign leads',
    'lead.changeStage': 'Move leads between stages',
    'lead.merge': 'Resolve duplicates and merge leads',
    'lead.export': 'Export leads',
  },
  followup: {
    'followup.view': 'View follow-ups',
    'followup.manage': 'Create, complete and reschedule follow-ups',
  },
  student: {
    'student.view': 'View students',
    'student.create': 'Create students / convert leads',
    'student.update': 'Update students',
  },
  university: {
    'university.view': 'View universities and courses',
    'university.manage': 'Manage universities and courses',
  },
  application: {
    'application.view': 'View applications',
    'application.create': 'Create applications',
    'application.update': 'Update applications',
  },
  document: {
    'document.view': 'View documents',
    'document.upload': 'Upload documents',
    'document.approve': 'Approve documents',
    'document.reject': 'Reject documents',
  },
  event: {
    'event.view': 'View events',
    'event.manage': 'Manage events and registrations',
  },
  payment: {
    'payment.view': 'View payments',
    'payment.manage': 'Record and update payments',
  },
  visa: {
    'visa.view': 'View visa cases',
    'visa.manage': 'Update visa cases',
  },
  report: {
    'report.view': 'View reports and dashboards',
    'report.export': 'Export reports',
  },
  communication: {
    'call.view': 'View call logs and communication history',
    'call.make': 'Make, log and update calls and outcomes',
    'recording.view': 'Play call recordings and read transcripts / AI summaries',
    'recording.download': 'Download call recordings',
    'communication.manage': 'Configure calling providers, recording consent and retention',
  },
  integration: {
    'integration.view': 'View integrations, sync history and imported leads',
    'integration.manage': 'Connect, sync, retry and disconnect integrations; field mapping and API keys',
  },
  marketing: {
    'marketing.view': 'View campaigns, ad spend, attribution and marketing reports',
    'marketing.manage': 'Manage attribution hierarchy, campaign mappings and UTM templates',
    'marketing.export': 'Export marketing reports',
  },
  notification: {
    'notification.send': 'Send team messages to users, roles or branches',
  },
  device: {
    'device.manage': 'View team devices and sign them out remotely',
  },
  audit: {
    'audit.view': 'View audit logs',
  },
} as const;

type Catalog = typeof PERMISSION_CATALOG;
export type PermissionModule = keyof Catalog;
export type Permission = { [M in PermissionModule]: keyof Catalog[M] }[PermissionModule];

export const ALL_PERMISSIONS = Object.values(PERMISSION_CATALOG).flatMap((group) =>
  Object.keys(group),
) as Permission[];

/**
 * Permissions that *narrow* access instead of granting it. Full-access roles (Organization Admin,
 * Super Admin) never hold them, and only unrestricted users may add or remove them (utils/access.ts).
 */
export const RESTRICTION_PERMISSIONS = ['lead.viewAssignedOnly'] as const satisfies readonly Permission[];
const restrictionSet = new Set<string>(RESTRICTION_PERMISSIONS);
export const isRestriction = (p: string) => restrictionSet.has(p);

/** Everything a full-access role holds. */
export const FULL_ACCESS_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !restrictionSet.has(p));

const permissionSet = new Set<string>(ALL_PERMISSIONS);
export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}

/** Platform-level capability held only by the Super Admin role; never assignable to org roles. */
export const PLATFORM_MANAGE = 'platform.manage' as const;
