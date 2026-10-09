/**
 * Idempotent seed:
 *   npm run seed                      → platform org + Super Admin (from SUPER_ADMIN_* env vars)
 *   npm run seed -- --demo            → also a demo organization with an admin and sample users
 *   npm run seed -- --demo-data       → demo organization plus sample team, ~600 leads, follow-ups (not in production)
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import {
  ensurePlatformSuperAdmin,
  provisionOrganization,
} from '../modules/organizations/organization.service.js';
import { connectDatabase, disconnectDatabase } from './connection.js';
import { seedDemoData } from './demoData.js';
import { runMigrations } from './migrations.js';
import { UserModel } from '../modules/users/user.model.js';

async function run() {
  if (!env.SUPER_ADMIN_EMAIL || !env.SUPER_ADMIN_PASSWORD) {
    throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD to seed the Super Admin');
  }
  await connectDatabase();
  await runMigrations();

  const sa = await ensurePlatformSuperAdmin(env.SUPER_ADMIN_EMAIL, env.SUPER_ADMIN_PASSWORD);
  logger.info(
    sa.created ? `Super Admin created: ${env.SUPER_ADMIN_EMAIL}` : 'Super Admin already exists',
  );

  const withData = process.argv.includes('--demo-data');
  if (process.argv.includes('--demo') || withData) {
    if (await OrganizationModel.exists({ slug: 'demo-overseas' })) {
      logger.info('Demo organization already exists');
    } else {
      const demo = await provisionOrganization(
        {
          name: 'Demo Overseas Education',
          slug: 'demo-overseas',
          admin: {
            firstName: 'Demo',
            lastName: 'Admin',
            email: 'admin@demo.local',
            password: 'DemoAdmin123',
          },
        },
        { meta: { userAgent: 'seed' } },
      );
      logger.info(`Demo organization created. Sign in as ${demo.admin.email} / DemoAdmin123`);
    }
    if (withData) {
      const org = await OrganizationModel.findOne({ slug: 'demo-overseas' }).select('_id').lean();
      const admin = await UserModel.findOne({ email: 'admin@demo.local' }).select('_id').setOptions({ skipTenantGuard: true }).lean();
      if (org && admin) {
        const { leads } = await seedDemoData(org._id, admin._id);
        logger.info(leads ? `Demo data added: ${leads} leads; team passwords are DemoUser123` : 'Demo data already present');
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
