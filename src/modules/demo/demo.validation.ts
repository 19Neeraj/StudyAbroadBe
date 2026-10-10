import { z } from '../../docs/zod.js';
import { CLIENT_PLATFORMS } from '../auth/session.model.js';

export const DEMO_PERSONAS = ['admin', 'manager', 'counsellor'] as const;

export const demoLoginBody = z
  .object({
    persona: z.enum(DEMO_PERSONAS).default('admin').openapi({ description: 'Which demo user to explore as' }),
    platform: z.enum(CLIENT_PLATFORMS).default('web'),
    deviceName: z.string().trim().max(100).optional(),
  })
  .openapi('DemoLoginRequest');
