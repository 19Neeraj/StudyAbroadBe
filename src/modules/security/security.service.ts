import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { effectivePolicy, getPlatformPolicy, invalidatePlatformPolicy } from './policy.js';
import { PlatformSettingModel } from './platformSetting.model.js';
import type { orgPolicyBody, updatePlatformPolicyBody } from './security.validation.js';

export async function getPlatformTwoFactorPolicy() {
  return getPlatformPolicy();
}

/**
 * Super Admin: change the platform policy. Switching to mandatory starts the grace period from now.
 * Enrolled secrets are never discarded by a policy change.
 */
export async function updatePlatformTwoFactorPolicy(ctx: ServiceContext, input: z.infer<typeof updatePlatformPolicyBody>) {
  const before = await getPlatformPolicy();
  const set: Record<string, unknown> = { updatedBy: ctx.userId };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) set[`twoFactor.${k}`] = v;
  if (input.mode === 'mandatory' && before.mode !== 'mandatory') set['twoFactor.mandatorySince'] = new Date();
  await PlatformSettingModel.updateOne({ _id: 'security' }, { $set: set }, { upsert: true });
  invalidatePlatformPolicy();
  const after = await getPlatformPolicy();
  await recordAudit(ctx, { entityType: 'platform_setting', action: 'security.2fa_policy_updated', oldValue: before, newValue: after });
  return after;
}

export async function getOrganizationPolicy(ctx: ServiceContext) {
  const [platform, org] = await Promise.all([getPlatformPolicy(), OrganizationModel.findById(ctx.organizationId).select('security').lean()]);
  return {
    twoFactorMode: (org?.security?.twoFactorMode ?? 'inherit') as 'inherit' | 'optional' | 'mandatory',
    canOverride: platform.enabled && platform.mode === 'optional' && platform.allowOrganizationOverride,
    platform: { enabled: platform.enabled, mode: platform.mode, allowOrganizationOverride: platform.allowOrganizationOverride, gracePeriodDays: platform.gracePeriodDays },
    effective: effectivePolicy(platform, org?.security),
  };
}

/** Organization admin: require 2FA for the organization (only when the platform allows overrides). */
export async function updateOrganizationPolicy(ctx: ServiceContext, input: z.infer<typeof orgPolicyBody>) {
  const current = await getOrganizationPolicy(ctx);
  if (!current.canOverride && input.twoFactorMode !== current.twoFactorMode) {
    throw ApiError.forbidden('The platform policy decides two-factor authentication for every organization');
  }
  const set: Record<string, unknown> = { 'security.twoFactorMode': input.twoFactorMode, updatedBy: ctx.userId };
  if (input.twoFactorMode === 'mandatory' && current.twoFactorMode !== 'mandatory') set['security.twoFactorMandatorySince'] = new Date();
  await OrganizationModel.updateOne({ _id: ctx.organizationId }, { $set: set });
  await recordAudit(ctx, { entityType: 'organization', entityId: ctx.organizationId, action: 'security.org_2fa_policy_updated', oldValue: { twoFactorMode: current.twoFactorMode }, newValue: { twoFactorMode: input.twoFactorMode } });
  return getOrganizationPolicy(ctx);
}
