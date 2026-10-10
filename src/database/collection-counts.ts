/**
 * Read-only: document count of every model's collection (all organizations, or one with --org=<slug>).
 *   npm run db:counts                      → whole database
 *   npm run db:counts -- --org=demo-overseas
 */
import mongoose from 'mongoose';
import { logger } from '../config/logger.js';
import '../routes/index.js';
import './migrations.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { connectDatabase, disconnectDatabase } from './connection.js';

async function run() {
  await connectDatabase();
  const slug = process.argv.find((a) => a.startsWith('--org='))?.slice(6);
  const org = slug ? await OrganizationModel.findOne({ slug }).select('_id').lean() : null;
  if (slug && !org) throw new Error(`Organization "${slug}" not found`);
  const rows: [string, number][] = [];
  for (const m of Object.values(mongoose.models)) {
    const filter = org && m.schema.path('organizationId') ? { organizationId: org._id } : {};
    rows.push([m.collection.collectionName, await m.countDocuments(filter).setOptions({ skipTenantGuard: true })]);
  }
  rows.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  process.stdout.write(rows.map(([n, c]) => `${String(c).padStart(7)}  ${n}`).join('\n') + '\n');
  await disconnectDatabase();
}

run().catch(async (err: unknown) => {
  logger.fatal({ err }, 'Count failed');
  await disconnectDatabase();
  process.exit(1);
});
