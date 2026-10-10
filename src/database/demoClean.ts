import mongoose from 'mongoose';
import { logger } from '../config/logger.js';
import { SessionModel } from '../modules/auth/session.model.js';
import { DEMO_ORG_SLUG } from '../modules/demo/demo.service.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { TwoFactorChallengeModel } from '../modules/security/twoFactorChallenge.model.js';

/**
 * Deletes the demo organization and everything it owns. Safety: only an organization with the demo
 * slug AND isDemo=true is touched, and only documents whose organizationId is that organization.
 * Customer organizations are never matched. Returns null when there is no demo organization.
 */
export async function removeDemoOrganization(): Promise<{ documents: number } | null> {
  const org = await OrganizationModel.findOne({ slug: DEMO_ORG_SLUG }).select('_id isDemo isPlatform').lean();
  if (!org) return null;
  if (!org.isDemo || org.isPlatform) {
    throw new Error(`Refusing to delete "${DEMO_ORG_SLUG}": it is not flagged as a demo organization (isDemo=true)`);
  }
  let documents = 0;
  for (const model of Object.values(mongoose.models)) {
    if (model === OrganizationModel || !model.schema.path('organizationId')) continue;
    const res = await model.deleteMany({ organizationId: org._id }).setOptions({ skipTenantGuard: true });
    documents += res.deletedCount;
  }
  documents += (await SessionModel.deleteMany({ organizationId: org._id })).deletedCount;
  documents += (await TwoFactorChallengeModel.deleteMany({ organizationId: org._id })).deletedCount;
  await OrganizationModel.deleteOne({ _id: org._id, isDemo: true });
  logger.info({ organizationId: org._id.toString(), documents }, 'Demo organization removed');
  return { documents: documents + 1 };
}
