/**
 * Read-only report of active leads that share a normalized phone number, per organization.
 *   npm run leads:phone-duplicates            → summary per organization
 *   npm run leads:phone-duplicates -- --json  → full list (lead IDs) as JSON
 * Resolve each group with the lead merge action (POST /leads/:keptId/merge). Nothing is changed here.
 */
import { logger } from '../config/logger.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { connectDatabase, disconnectDatabase } from './connection.js';
import { findPhoneConflicts } from './migrations.js';

async function run() {
  await connectDatabase();
  const orgs = await OrganizationModel.find({ isPlatform: { $ne: true } }).select('name slug').lean();
  const report = [];
  for (const org of orgs) {
    const conflicts = await findPhoneConflicts(org._id);
    if (conflicts.length) report.push({ organization: org.slug, groups: conflicts.length, leads: conflicts.reduce((n, c) => n + c.otherLeadIds.length + 1, 0), conflicts });
  }
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (!report.length) logger.info('No active leads share a phone number');
  else for (const r of report) logger.warn(`${r.organization}: ${r.groups} phone number(s) shared by ${r.leads} leads`);
  await disconnectDatabase();
}

run().catch(async (err: unknown) => {
  logger.fatal({ err }, 'Report failed');
  await disconnectDatabase();
  process.exit(1);
});
