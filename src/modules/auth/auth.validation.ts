import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { CLIENT_PLATFORMS } from './session.model.js';

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number')
  .openapi({ example: 'Str0ngPassw0rd' });

export const loginBody = z
  .object({
    email: z.email().max(254).openapi({ example: 'admin@example.com' }),
    password: z.string().min(1).max(128),
    platform: z.enum(CLIENT_PLATFORMS).default('web').openapi({
      description: 'web: refresh token is set as an httpOnly cookie. Mobile: returned in the body.',
    }),
    deviceName: z.string().trim().max(100).optional(),
  })
  .openapi('LoginRequest');

export const refreshBody = z
  .object({
    refreshToken: z.string().min(20).max(200).optional().openapi({
      description: 'Required for mobile clients; web clients send the httpOnly cookie instead.',
    }),
  })
  .openapi('RefreshRequest');

export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  })
  .openapi('ChangePasswordRequest');

export const forgotPasswordBody = z
  .object({ email: z.email().max(254) })
  .openapi('ForgotPasswordRequest');

export const resetPasswordBody = z
  .object({ token: z.string().min(20).max(200), newPassword: passwordSchema })
  .openapi('ResetPasswordRequest');

export const sessionIdParams = z.object({ id: objectIdString });

export const meDto = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    email: z.string(),
    phone: z.string().optional(),
    designation: z.string().optional(),
    avatarUrl: z.string().optional(),
    isSuperAdmin: z.boolean(),
    organization: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      settings: z.object({
        timezone: z.string(),
        currency: z.string(),
        defaultCountryCode: z.string(),
        dateFormat: z.string(),
      }),
    }),
    role: z.object({ id: z.string(), key: z.string(), name: z.string(), dataScope: z.string() }),
    permissions: z.array(z.string()),
    branches: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
  })
  .openapi('CurrentUser');

export const tokensDto = z
  .object({
    accessToken: z.string(),
    expiresIn: z.number().openapi({ description: 'Access token lifetime in seconds' }),
    refreshToken: z.string().optional().openapi({ description: 'Only returned to mobile clients' }),
  })
  .openapi('AuthTokens');

export const loginDto = tokensDto.extend({ user: meDto }).openapi('LoginResponse');

export const sessionDto = z
  .object({
    id: z.string(),
    platform: z.string(),
    deviceName: z.string().optional(),
    ipAddress: z.string().optional(),
    userAgent: z.string().optional(),
    lastUsedAt: z.string(),
    createdAt: z.string(),
    current: z.boolean(),
  })
  .openapi('Session');

export const updateProfileBody = z
  .object({
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(20).nullable().optional().openapi({ description: 'Used to bridge click-to-call through the calling provider' }),
    designation: z.string().trim().max(100).nullable().optional(),
  })
  .openapi('UpdateProfileRequest');
