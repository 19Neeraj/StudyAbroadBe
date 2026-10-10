import type { z } from '../../docs/zod.js';
import { env } from '../../config/env.js';
import type { RequestMeta } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { startSession } from '../auth/auth.service.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { UserModel } from '../users/user.model.js';
import type { demoLoginBody } from './demo.validation.js';

/** The seeded demo tenant (`npm run seed:demo`). */
export const DEMO_ORG_SLUG = 'demo-overseas';
export const DEMO_EMAILS = { admin: 'admin@demo.local', manager: 'manager@demo.local', counsellor: 'simran@demo.local' } as const;

/**
 * Passwordless sign-in to the read-only demo. Only works when DEMO_ENABLED=true, only for users of an
 * organization flagged isDemo, and every resulting request is read-only (auth middleware).
 */
export async function demoLogin(input: z.infer<typeof demoLoginBody>, meta: RequestMeta) {
  if (!env.DEMO_ENABLED) throw new ApiError(404, 'The demo is not available', [], 'DEMO_DISABLED');
  const org = await OrganizationModel.findOne({ slug: DEMO_ORG_SLUG, isDemo: true, isActive: true }).select('_id').lean();
  if (!org) throw new ApiError(503, 'The demo is being prepared. Please try again later.', [], 'DEMO_NOT_SEEDED');
  const user = await UserModel.findOne({ organizationId: org._id, email: DEMO_EMAILS[input.persona], isActive: true }).select('_id organizationId twoFactor.enabled').lean();
  // Passwordless demo access must never stand in for a second factor.
  if (user?.twoFactor?.enabled) throw new ApiError(403, 'This demo account uses two-factor authentication; sign in normally', [], 'DEMO_PERSONA_2FA');
  if (!user) throw new ApiError(503, 'The demo is being prepared. Please try again later.', [], 'DEMO_NOT_SEEDED');
  return startSession(user, { platform: input.platform, deviceName: input.deviceName ?? 'Demo' }, { ...meta, userAgent: meta.userAgent ?? 'demo' });
}

/** Public: lets the landing page show the demo button only when it works. */
export async function demoStatus() {
  if (!env.DEMO_ENABLED) return { enabled: false, ready: false, personas: [] as string[] };
  const ready = !!(await OrganizationModel.exists({ slug: DEMO_ORG_SLUG, isDemo: true, isActive: true }));
  return { enabled: true, ready, personas: ready ? Object.keys(DEMO_EMAILS) : [] };
}
