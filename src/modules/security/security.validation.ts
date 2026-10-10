import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';

const code = z.string().trim().min(6).max(12).openapi({ example: '123456', description: '6-digit code from the authenticator app' });
const challengeToken = z.string().min(20).max(200).openapi({ description: 'challengeToken from the sign-in response' });

export const setupBody = z
  .object({
    password: z.string().min(1).max(128).optional().openapi({ description: 'Current password (required when signed in)' }),
    challengeToken: challengeToken.optional().openapi({ description: 'Enrollment challenge from sign-in, when 2FA is mandatory and not set up yet' }),
  })
  .openapi('TwoFactorSetupRequest');

export const verifySetupBody = z.object({ code, challengeToken: challengeToken.optional() }).openapi('TwoFactorVerifySetupRequest');
export const verifyLoginBody = z.object({ challengeToken, code }).openapi('TwoFactorVerifyLoginRequest');
export const verifyRecoveryBody = z
  .object({ challengeToken, recoveryCode: z.string().trim().min(10).max(20).openapi({ example: 'ABCDE-FGHJK' }) })
  .openapi('TwoFactorRecoveryRequest');
export const reauthCodeBody = z
  .object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20).openapi({ description: 'Authenticator code (disable also accepts a recovery code)' }) })
  .openapi('TwoFactorReauthRequest');

export const setupDto = z
  .object({ otpauthUrl: z.string(), qrCodeDataUrl: z.string(), manualKey: z.string(), expiresIn: z.number() })
  .openapi('TwoFactorSetup');

export const securityDto = z
  .object({
    twoFactor: z.object({
      enabled: z.boolean(),
      enabledAt: z.string().nullable(),
      pendingSetup: z.boolean(),
      recoveryCodesRemaining: z.number(),
      recoveryCodesGeneratedAt: z.string().nullable(),
      policy: z.object({
        available: z.boolean(),
        mode: z.enum(['optional', 'mandatory']),
        source: z.enum(['platform', 'organization']),
        canDisable: z.boolean(),
        required: z.boolean(),
        enrollmentRequiredBy: z.string().nullable(),
        enrollmentOverdue: z.boolean(),
      }),
    }),
  })
  .openapi('SecurityStatus');

export const platformPolicyDto = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['optional', 'mandatory']),
    allowOrganizationOverride: z.boolean(),
    gracePeriodDays: z.number(),
    mandatorySince: z.string().nullable(),
  })
  .openapi('PlatformTwoFactorPolicy');

export const updatePlatformPolicyBody = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['optional', 'mandatory']).optional(),
    allowOrganizationOverride: z.boolean().optional(),
    gracePeriodDays: z.number().int().min(0).max(90).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' })
  .openapi('UpdatePlatformTwoFactorPolicy');

export const orgPolicyBody = z
  .object({ twoFactorMode: z.enum(['inherit', 'optional', 'mandatory']) })
  .openapi('OrganizationTwoFactorPolicy');

export const twoFactorUsersQuery = paginationQuery.extend({
  organizationId: objectIdString.optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
});

export const resetBody = z.object({ reason: z.string().trim().min(5).max(500).openapi({ description: 'Why the reset was authorized (kept in the audit log)' }) }).openapi('TwoFactorResetRequest');
export const userIdParams = z.object({ userId: objectIdString });
