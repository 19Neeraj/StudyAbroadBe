/**
 * Startup creates missing indexes (autoIndex). Run this on deploy to also drop indexes that
 * were removed from the schemas:  node dist/database/sync-indexes.js
 */
import mongoose from 'mongoose';
import { logger } from '../config/logger.js';
import '../modules/activities/activity.model.js';
import '../modules/audit/audit.model.js';
import '../modules/auth/session.model.js';
import '../modules/branches/branch.model.js';
import '../modules/counters/counter.model.js';
import '../modules/followups/followup.model.js';
import '../modules/leads/lead.model.js';
import '../modules/organizations/organization.model.js';
import '../modules/roles/role.model.js';
import '../modules/settings/lookup.model.js';
import '../modules/users/user.model.js';
import { connectDatabase, disconnectDatabase } from './connection.js';

async function run() {
  await connectDatabase();
  for (const name of mongoose.modelNames()) {
    const dropped = await mongoose.model(name).syncIndexes();
    logger.info({ model: name, dropped }, 'Indexes synced');
  }
  await disconnectDatabase();
}

run().catch((err: unknown) => {
  logger.fatal({ err }, 'Index sync failed');
  process.exit(1);
});
