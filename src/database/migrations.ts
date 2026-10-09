import { Schema, model } from 'mongoose';
import { logger } from '../config/logger.js';
import { ORG_ADMIN_ROLE_KEY, DEFAULT_ROLES } from '../constants/roles.js';
import type { Permission } from '../constants/permissions.js';
import type { LookupType } from '../constants/lookups.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { RoleModel } from '../modules/roles/role.model.js';
import { seedMissingLookupType } from '../modules/settings/lookup.service.js';

/**
 * Data migrations for existing organizations when a release adds permissions or settings types.
 * New organizations already get current defaults at provisioning. Each migration runs once
 * (recorded in `migrations`) and is idempotent anyway. Runs at API start and from the seed script.
 */
const migrationSchema = new Schema({ _id: String, appliedAt: { type: Date, default: () => new Date() } }, { versionKey: false });
const MigrationModel = model('Migration', migrationSchema);

interface Migration {
  id: string;
  /** Permissions introduced by the release: granted to org admins and to system roles whose defaults include them. */
  permissions?: Permission[];
  lookupTypes?: LookupType[];
}

const MIGRATIONS: Migration[] = [
  {
    id: '2026-10-08-communication',
    permissions: ['call.view', 'call.make', 'recording.view', 'recording.download', 'communication.manage', 'device.manage'],
    lookupTypes: ['call_outcome'],
  },
];

async function apply(m: Migration) {
  const orgs = await OrganizationModel.find({ isPlatform: { $ne: true } }).select('_id').lean();
  for (const org of orgs) {
    for (const perm of m.permissions ?? []) {
      const roleKeys = [ORG_ADMIN_ROLE_KEY, ...DEFAULT_ROLES.filter((r) => r.permissions.includes(perm)).map((r) => r.key)];
      // Only system roles; custom roles are the organization's own decision.
      await RoleModel.updateMany({ organizationId: org._id, key: { $in: [...new Set(roleKeys)] }, isSystem: true }, { $addToSet: { permissions: perm } });
    }
    for (const type of m.lookupTypes ?? []) await seedMissingLookupType(org._id, type);
  }
  return orgs.length;
}

export async function runMigrations(): Promise<void> {
  const done = new Set((await MigrationModel.find().select('_id').lean()).map((d) => d._id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    const count = await apply(m);
    await MigrationModel.create({ _id: m.id });
    logger.info({ migration: m.id, organizations: count }, 'Migration applied');
  }
}
