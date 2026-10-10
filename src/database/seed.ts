/**
 * Idempotent seed:
 *   npm run seed                      → platform org + Super Admin (from SUPER_ADMIN_* env vars)
 *   npm run seed -- --demo            → also a demo organization with an admin
 *   npm run seed:demo                 → demo organization with a team, 90 leads (--leads=N) and data in every collection
 *   npm run seed:demo -- --reset      → removes the demo organization's data first, then seeds again
 * Demo data is synthetic, never sends messages, and is refused when NODE_ENV=production.
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import {
  ensurePlatformSuperAdmin,
  provisionOrganization,
} from '../modules/organizations/organization.service.js';
import { DEMO_ORG_SLUG } from '../modules/demo/demo.service.js';
import { connectDatabase, disconnectDatabase } from './connection.js';
import { removeDemoOrganization } from './demoClean.js';
import { seedDemoData } from './demoData.js';
import { runMigrations } from './migrations.js';
import { UserModel } from '../modules/users/user.model.js';

async function run() {
  const withData = process.argv.includes('--demo-data');
  const withDemo = process.argv.includes('--demo') || withData;
  if (withData && env.NODE_ENV === 'production') throw new Error('Demo data is not allowed in production (NODE_ENV=production)');
  await connectDatabase();
  await runMigrations();

  if (env.SUPER_ADMIN_EMAIL && env.SUPER_ADMIN_PASSWORD) {
    const sa = await ensurePlatformSuperAdmin(env.SUPER_ADMIN_EMAIL, env.SUPER_ADMIN_PASSWORD);
    logger.info(sa.created ? `Super Admin created: ${env.SUPER_ADMIN_EMAIL}` : 'Super Admin already exists');
  } else if (!withDemo) {
    throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD to seed the Super Admin');
  } else {
    logger.warn('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set: skipping the Super Admin');
  }

  if (withDemo) {
    if (process.argv.includes('--reset')) {
      const removed = await removeDemoOrganization();
      logger.info(removed ? `Removed previous demo data (${removed.documents} documents)` : 'No previous demo organization');
    }
    if (await OrganizationModel.exists({ slug: DEMO_ORG_SLUG })) {
      logger.info('Demo organization already exists');
    } else {
      const demo = await provisionOrganization(
        {
          name: 'Demo Overseas Education',
          slug: DEMO_ORG_SLUG,
          admin: { firstName: 'Demo', lastName: 'Admin', email: 'admin@demo.local', password: 'DemoAdmin123' },
        },
        { meta: { userAgent: 'seed' } },
      );
      logger.info(`Demo organization created. Sign in as ${demo.admin.email} / DemoAdmin123`);
    }
    // Demo tenants are flagged: read-only for signed-in users and the only target of seed:demo:clean.
    await OrganizationModel.updateOne({ slug: DEMO_ORG_SLUG }, { $set: { isDemo: true } });
    if (withData) {
      const org = await OrganizationModel.findOne({ slug: DEMO_ORG_SLUG }).select('_id').lean();
      const admin = await UserModel.findOne({ organizationId: org?._id, email: 'admin@demo.local' }).select('_id').lean();
      if (org && admin) {
        const leadsArg = process.argv.find((a) => a.startsWith('--leads='));
        const { leads } = await seedDemoData(org._id, admin._id, leadsArg ? { leads: Number(leadsArg.slice(8)) } : {});
        logger.info(leads ? `Demo data added: ${leads} leads; team passwords are DemoUser123` : 'Demo data already present (use --reset to rebuild it)');
      }
    }
  }
  await disconnectDatabase();
}

run().catch(async (err: unknown) => {
  logger.fatal({ err }, 'Seed failed');
  await disconnectDatabase();
  process.exit(1);
});
