import { env } from '../../config/env.js';
import { z } from '../../docs/zod.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './integration.service.js';
import { integrationDto, updateCallingBody, updatePolicyBody } from './integration.validation.js';

const m = createModuleRouter('/communication', 'Communication settings');
const settingsDto = z.object({ integration: integrationDto.nullable(), effectiveProvider: z.string(), availableProviders: z.array(z.string()) });

m.route({
  method: 'get',
  path: '/calling',
  summary: 'Calling provider settings (secrets are never returned)',
  permissions: ['communication.manage'],
  response: settingsDto,
  handler: async ({ ctx }) => ({ data: await service.getCallingSettings(ctx, env.API_PUBLIC_URL) }),
});

m.route({
  method: 'put',
  path: '/calling',
  summary: 'Connect or change the calling provider',
  permissions: ['communication.manage'],
  body: updateCallingBody,
  response: settingsDto,
  handler: async ({ ctx, body }) => ({ message: 'Calling settings saved', data: await service.updateCallingSettings(ctx, body, env.API_PUBLIC_URL) }),
});

m.route({
  method: 'post',
  path: '/calling/rotate-webhook',
  summary: 'Issue a new webhook URL (the old one stops working)',
  permissions: ['communication.manage'],
  response: settingsDto,
  handler: async ({ ctx }) => ({ message: 'Webhook URL rotated', data: await service.rotateWebhookToken(ctx, 'calling', env.API_PUBLIC_URL) }),
});

m.route({
  method: 'get',
  path: '/policy',
  summary: 'Recording consent, retention, transcription and AI policy',
  permissions: ['call.view'],
  handler: async ({ ctx }) => ({ data: await service.getPolicy(ctx) }),
});

m.route({
  method: 'patch',
  path: '/policy',
  summary: 'Update recording consent, retention, transcription and AI policy',
  description: 'Check applicable law, provider terms and organization policy before enabling recording, transcription or AI analysis.',
  permissions: ['communication.manage'],
  body: updatePolicyBody,
  handler: async ({ ctx, body }) => ({ message: 'Policy saved', data: await service.updatePolicy(ctx, body) }),
});

export const communicationModule = m;
