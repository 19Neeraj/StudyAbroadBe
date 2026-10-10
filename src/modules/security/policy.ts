import type { Types } from 'mongoose';
import { OrganizationModel } from '../organizations/organization.model.js';
import { PlatformSettingModel } from './platformSetting.model.js';

export interface PlatformTwoFactorPolicy {
  enabled: boolean;
  mode: 'optional' | 'mandatory';
  allowOrganizationOverride: boolean;
  gracePeriodDays: number;
  mandatorySince: Date | null;
}

export const DEFAULT_PLATFORM_POLICY: PlatformTwoFactorPolicy = {
  enabled: true,
  mode: 'optional',
  allowOrganizationOverride: true,
  gracePeriodDays: 7,
  mandatorySince: null,
};

const TTL_MS = 30_000;
let cached: { value: PlatformTwoFactorPolicy; expires: number } | null = null;

export async function getPlatformPolicy(): Promise<PlatformTwoFactorPolicy> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const doc = await PlatformSettingModel.findById('security').lean();
  const tf = doc?.twoFactor;
  const value: PlatformTwoFactorPolicy = {
    enabled: tf?.enabled ?? DEFAULT_PLATFORM_POLICY.enabled,
    mode: (tf?.mode as PlatformTwoFactorPolicy['mode'] | undefined) ?? DEFAULT_PLATFORM_POLICY.mode,
    allowOrganizationOverride: tf?.allowOrganizationOverride ?? DEFAULT_PLATFORM_POLICY.allowOrganizationOverride,
    gracePeriodDays: tf?.gracePeriodDays ?? DEFAULT_PLATFORM_POLICY.gracePeriodDays,
    mandatorySince: tf?.mandatorySince ?? null,
  };
  cached = { value, expires: Date.now() + TTL_MS };
  return value;
}

export function invalidatePlatformPolicy(): void {
  cached = null;
}

export interface OrgSecurity {
  twoFactorMode?: string | null;
  twoFactorMandatorySince?: Date | null;
}

export interface EffectiveTwoFactorPolicy {
  /** Can users enroll at all? */
  available: boolean;
  mode: 'optional' | 'mandatory';
  /** Who decided the mode. */
  source: 'platform' | 'organization';
  /** May the user turn 2FA off again? */
  canDisable: boolean;
  gracePeriodDays: number;
  mandatorySince: Date | null;
}

/**
 * Policy precedence (strongest wins; nothing below can relax anything above):
 *  1. Platform disabled → 2FA unavailable and never required. Users who already enrolled keep their
 *     secret and keep verifying: a policy change never silently discards or bypasses an enrollment.
 *  2. Platform mandatory → mandatory for every organization and user.
 *  3. Platform optional + organization override allowed → an organization may make it mandatory.
 *  4. Otherwise optional; each user decides.
 */
export function effectivePolicy(platform: PlatformTwoFactorPolicy, org: OrgSecurity | null | undefined): EffectiveTwoFactorPolicy {
  if (!platform.enabled) {
    return { available: false, mode: 'optional', source: 'platform', canDisable: true, gracePeriodDays: platform.gracePeriodDays, mandatorySince: null };
  }
  if (platform.mode === 'mandatory') {
    return { available: true, mode: 'mandatory', source: 'platform', canDisable: false, gracePeriodDays: platform.gracePeriodDays, mandatorySince: platform.mandatorySince };
  }
  if (platform.allowOrganizationOverride && org?.twoFactorMode === 'mandatory') {
    return { available: true, mode: 'mandatory', source: 'organization', canDisable: false, gracePeriodDays: platform.gracePeriodDays, mandatorySince: org.twoFactorMandatorySince ?? null };
  }
  return { available: true, mode: 'optional', source: 'platform', canDisable: true, gracePeriodDays: platform.gracePeriodDays, mandatorySince: null };
}

export interface UserTwoFactorState {
  enabled?: boolean | null;
}

export interface TwoFactorRequirement {
  /** A correct password is not enough: a TOTP / recovery code must follow. */
  verify: boolean;
  /** Mandatory but not enrolled, and the grace period is over: enroll before using the CRM. */
  enrollNow: boolean;
  /** Mandatory but not enrolled, still within the grace period. */
  enrollBy: Date | null;
  policy: EffectiveTwoFactorPolicy;
}

export function requirementFor(policy: EffectiveTwoFactorPolicy, user: UserTwoFactorState & { createdAt?: Date | null }, now = new Date()): TwoFactorRequirement {
  if (user.enabled) return { verify: true, enrollNow: false, enrollBy: null, policy };
  if (policy.mode !== 'mandatory') return { verify: false, enrollNow: false, enrollBy: null, policy };
  const since = Math.max(policy.mandatorySince?.getTime() ?? 0, user.createdAt?.getTime() ?? 0);
  const deadline = new Date(since + policy.gracePeriodDays * 86_400_000);
  return deadline <= now ? { verify: false, enrollNow: true, enrollBy: deadline, policy } : { verify: false, enrollNow: false, enrollBy: deadline, policy };
}

export async function policyForOrganization(organizationId: Types.ObjectId): Promise<EffectiveTwoFactorPolicy> {
  const [platform, org] = await Promise.all([getPlatformPolicy(), OrganizationModel.findById(organizationId).select('security').lean()]);
  return effectivePolicy(platform, org?.security);
}
