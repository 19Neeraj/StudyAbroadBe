import { PLATFORM_MANAGE } from '../../constants/permissions.js';
import { z } from '../../docs/zod.js';
import { buildPagination } from '../../utils/pagination.js';
import { createModuleRouter } from '../../utils/router.js';
import * as security from './security.service.js';
import { orgPolicyBody, platformPolicyDto, resetBody, twoFactorUsersQuery, updatePlatformPolicyBody, userIdParams } from './security.validation.js';
import { listUsersTwoFactor, resetUserTwoFactor } from './twoFactor.service.js';

/** Organization-level security policy (organization admins). */
const org = createModuleRouter('/security', 'Security');

org.route({
  method: 'get',
  path: '/organization-policy',
  summary: 'Two-factor policy of my organization and what the platform allows',
  permissions: ['organization.view'],
  handler: async ({ ctx }) => ({ data: await security.getOrganizationPolicy(ctx) }),
});

org.route({
  method: 'patch',
  path: '/organization-policy',
  summary: 'Require 2FA for my organization (only if the platform allows organization overrides)',
  description: 'Organizations can make 2FA stricter than the platform, never weaker.',
  permissions: ['organization.update'],
  body: orgPolicyBody,
  handler: async ({ ctx, body }) => ({ message: 'Security policy updated', data: await security.updateOrganizationPolicy(ctx, body) }),
});

/** Platform security (Super Admins only). */
const sa = createModuleRouter('/super-admin/security', 'Super Admin: Security');

sa.route({
  method: 'get',
  path: '/2fa-policy',
  summary: 'Platform two-factor policy',
  permissions: [PLATFORM_MANAGE],
  response: platformPolicyDto,
  handler: async () => ({ data: await security.getPlatformTwoFactorPolicy() }),
});

sa.route({
  method: 'patch',
  path: '/2fa-policy',
  summary: 'Change the platform two-factor policy (audited)',
  description: 'Precedence: platform mandatory > organization mandatory > user choice. Enrolled secrets are never discarded by a policy change.',
  permissions: [PLATFORM_MANAGE],
  body: updatePlatformPolicyBody,
  response: platformPolicyDto,
  handler: async ({ ctx, body }) => ({ message: 'Platform policy updated', data: await security.updatePlatformTwoFactorPolicy(ctx, body) }),
});

sa.route({
  method: 'get',
  path: '/2fa-users',
  summary: 'Users and their 2FA enrollment status, across organizations',
  permissions: [PLATFORM_MANAGE],
  query: twoFactorUsersQuery,
  paginated: true,
  handler: async ({ query }) => {
    const { items, total } = await listUsersTwoFactor(query);
    return { data: items, pagination: buildPagination(query.page, query.limit, total) };
  },
});

sa.route({
  method: 'post',
  path: '/2fa-users/:userId/reset',
  summary: "Authorized reset of a user's 2FA (lost device): removes the secret and recovery codes, signs the user out everywhere",
  permissions: [PLATFORM_MANAGE],
  params: userIdParams,
  body: resetBody,
  response: z.null(),
  handler: async ({ ctx, params, body }) => {
    await resetUserTwoFactor(ctx, params.userId, body.reason);
    return { message: 'Two-factor authentication reset', data: null };
  },
});

export const securityModule = org;
export const superAdminSecurityModule = sa;
