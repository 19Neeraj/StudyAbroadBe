import { Schema, model, type Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { ORG_ADMIN_ROLE_KEY, DEFAULT_ROLES } from '../constants/roles.js';
import type { Permission } from '../constants/permissions.js';
import type { LookupType } from '../constants/lookups.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { RoleModel } from '../modules/roles/role.model.js';
import { seedMissingLookupType } from '../modules/settings/lookup.service.js';
import { LeadModel } from '../modules/leads/lead.model.js';
import { AttributionTouchpointModel, type TouchOrigin } from '../modules/marketing/touchpoint.model.js';
import { refreshLeadAttribution } from '../modules/marketing/attribution.service.js';
import { AuditLogModel } from '../modules/audit/audit.model.js';
import { LeadInquiryModel } from '../modules/leads/inquiry.model.js';

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
  /** Data backfill for one organization (idempotent). */
  run?: (organizationId: Types.ObjectId) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: '2026-10-08-communication',
    permissions: ['call.view', 'call.make', 'recording.view', 'recording.download', 'communication.manage', 'device.manage'],
    lookupTypes: ['call_outcome'],
  },
  {
    id: '2026-10-09-integrations',
    permissions: ['integration.view', 'integration.manage', 'marketing.view', 'marketing.manage', 'marketing.export'],
  },
  {
    id: '2026-10-09-notifications',
    permissions: ['notification.send'],
  },
  {
    // Existing leads: turn the stored source history into touchpoints so first/last touch exist.
    id: '2026-10-09-touchpoints',
    run: backfillTouchpoints,
  },
  {
    // Re-inquiries & assigned-only access (docs/LEAD_INTEGRITY.md). Non-destructive: adds fields,
    // never merges or deletes. Leads sharing a phone are reported, not resolved.
    id: '2026-10-10-lead-integrity',
    permissions: ['lead.viewInquiries'],
    run: migrateLeadIntegrity,
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
    if (m.run) await m.run(org._id);
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

const ORIGIN_BY_SOURCE: Record<string, TouchOrigin> = { manual: 'manual', event: 'event', meta: 'import', google: 'import', website: 'import' };

async function backfillTouchpoints(organizationId: Types.ObjectId) {
  const cursor = LeadModel.find({ organizationId, firstTouchId: null }).select('sourceHistory leadSource createdAt').cursor();
  for await (const lead of cursor) {
    type Touch = { leadSource?: string | null; campaign?: string | null; utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; utmTerm?: string | null; utmContent?: string | null; at?: Date | null };
    const history: Touch[] = lead.sourceHistory.length ? lead.sourceHistory.map((t) => t.toObject() as Touch) : [{ leadSource: lead.leadSource, at: lead.get('createdAt') as Date }];
    await AttributionTouchpointModel.insertMany(
      history.map((t) => {
        const raw = Object.fromEntries(Object.entries({ utm_source: t.utmSource, utm_medium: t.utmMedium, utm_campaign: t.utmCampaign, utm_term: t.utmTerm, utm_content: t.utmContent }).filter(([, v]) => v)) as Record<string, string>;
        return {
          organizationId,
          leadId: lead._id,
          origin: ORIGIN_BY_SOURCE[t.leadSource ?? ''] ?? 'import',
          occurredAt: t.at ?? (lead.get('createdAt') as Date),
          raw,
          normalized: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.trim().toLowerCase()])),
          leadSource: t.leadSource,
          campaignName: t.campaign,
          isDirect: Object.keys(raw).length === 0,
        };
      }),
    );
    await refreshLeadAttribution(organizationId, lead._id);
  }
}

/** Exported for tests; idempotent. */
export async function migrateLeadIntegrity(organizationId: Types.ObjectId) {
  await grantToLeadViewers(organizationId, 'lead.viewInquiries');
  await backfillPhoneKeys(organizationId);
  await backfillInquiries(organizationId);
}

/** Custom roles that could see leads keep seeing what they saw before (inquiry history was part of the lead). */
async function grantToLeadViewers(organizationId: Types.ObjectId, permission: Permission) {
  await RoleModel.updateMany({ organizationId, permissions: 'lead.view', isSuperAdmin: { $ne: true } }, { $addToSet: { permissions: permission } });
}

export interface PhoneConflict {
  phone: string;
  keptLeadId: Types.ObjectId;
  otherLeadIds: Types.ObjectId[];
}

/**
 * Groups active leads by normalized phone. Read-only; used by the migration and by
 * `npm run leads:phone-duplicates` (dry-run report before/after deploying the unique index).
 */
export async function findPhoneConflicts(organizationId: Types.ObjectId): Promise<PhoneConflict[]> {
  const groups = await LeadModel.aggregate<{ _id: string; ids: Types.ObjectId[] }>([
    { $match: { organizationId, deletedAt: null, mergedInto: null, phone: { $type: 'string' } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: '$phone', ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  return groups.map((g) => ({ phone: g._id, keptLeadId: g.ids[0]!, otherLeadIds: g.ids.slice(1) }));
}

/**
 * Sets the uniqueness key on active leads. Where several active leads share a phone, only the oldest
 * gets the key; the others are left as they are (still visible and usable) and logged so an admin
 * can merge them with the existing merge action. Nothing is merged automatically.
 */
async function backfillPhoneKeys(organizationId: Types.ObjectId) {
  const conflicts = await findPhoneConflicts(organizationId);
  const losers = new Set(conflicts.flatMap((c) => c.otherLeadIds.map(String)));
  const cursor = LeadModel.find({ organizationId, deletedAt: null, mergedInto: null, phone: { $type: 'string' }, normalizedPhone: null }).select('phone').lean().cursor();
  for await (const lead of cursor) {
    if (losers.has(String(lead._id))) continue;
    try {
      await LeadModel.updateOne({ organizationId, _id: lead._id }, { $set: { normalizedPhone: lead.phone } });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      losers.add(String(lead._id));
    }
  }
  const reported = new Set(
    (await AuditLogModel.find({ organizationId, action: 'lead.phone_duplicates_detected' }).select('metadata.phone').lean()).map((a) => (a.metadata as { phone?: string } | undefined)?.phone),
  );
  const fresh = conflicts.filter((c) => !reported.has(c.phone));
  if (fresh.length) {
    logger.warn({ organizationId: organizationId.toString(), groups: fresh.length, leads: losers.size }, 'Leads share a phone number; merge them (npm run leads:phone-duplicates lists them)');
    await AuditLogModel.insertMany(
      fresh.map((c) => ({
        organizationId,
        entityType: 'lead',
        entityId: c.keptLeadId,
        action: 'lead.phone_duplicates_detected',
        metadata: { phone: c.phone, otherLeadIds: c.otherLeadIds.map(String) },
        userAgent: 'migration',
      })),
    );
  }
}

/** One inquiry per stored source-history entry (the first is the original enquiry), plus counters and latest attribution. */
async function backfillInquiries(organizationId: Types.ObjectId) {
  const cursor = LeadModel.find({ organizationId, firstInquiryAt: null }).select('sourceHistory leadSource campaign createdAt assignedCounsellor assignedManager').cursor();
  for await (const lead of cursor) {
    const createdAt = lead.get('createdAt') as Date;
    type Touch = { leadSource?: string | null; campaign?: string | null; utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; utmTerm?: string | null; utmContent?: string | null; at?: Date | null };
    const history: Touch[] = lead.sourceHistory.length ? lead.sourceHistory.map((t) => t.toObject() as Touch) : [{ leadSource: lead.leadSource, campaign: lead.campaign, at: createdAt }];
    const owner = { counsellor: lead.assignedCounsellor ?? undefined, manager: lead.assignedManager ?? undefined };
    const docs = history.map((t, i) => ({
      organizationId,
      leadId: lead._id,
      sequence: i + 1,
      isReinquiry: i > 0,
      channel: ORIGIN_BY_SOURCE[t.leadSource ?? ''] ?? 'import',
      occurredAt: t.at ?? createdAt,
      status: 'handled',
      leadSource: t.leadSource ?? undefined,
      campaignName: t.campaign ?? undefined,
      utm: { source: t.utmSource ?? undefined, medium: t.utmMedium ?? undefined, campaign: t.utmCampaign ?? undefined, term: t.utmTerm ?? undefined, content: t.utmContent ?? undefined },
      currentOwner: owner,
      assignment: { action: i > 0 ? 'kept' : 'none', reason: 'Backfilled from source history' },
      notes: 'Backfilled from source history',
    }));
    await LeadInquiryModel.insertMany(docs);
    const times = docs.map((d) => d.occurredAt.getTime());
    await LeadModel.updateOne(
      { organizationId, _id: lead._id },
      { $set: { inquiryCount: docs.length, firstInquiryAt: new Date(Math.min(...times)), lastInquiryAt: new Date(Math.max(...times)), lastInquiryChannel: docs.at(-1)!.channel } },
    );
    await refreshLeadAttribution(organizationId, lead._id);
  }
}
