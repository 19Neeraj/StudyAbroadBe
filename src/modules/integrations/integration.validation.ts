import { z } from '../../docs/zod.js';
import { CONSENT_MODES } from './communicationPolicy.model.js';

export const updateCallingBody = z
  .object({
    provider: z.string().min(1).max(40).openapi({ example: 'exotel' }),
    enabled: z.boolean().default(true),
    config: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()])).optional().openapi({
      description: 'Non-secret settings, e.g. Exotel { subdomain, accountSid, callerId }',
    }),
    secrets: z.record(z.string().max(60), z.string().max(500)).optional().openapi({
      description: 'Credentials (write-only). Omitted keys keep their stored value; an empty string removes the key.',
    }),
  })
  .openapi('UpdateCallingIntegrationRequest');

export const updatePolicyBody = z
  .object({
    recordingEnabled: z.boolean().optional(),
    consentMode: z.enum(CONSENT_MODES).optional(),
    consentMessage: z.string().trim().min(5).max(500).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    keepTranscriptAfterRecordingDeleted: z.boolean().optional(),
    transcriptionEnabled: z.boolean().optional(),
    transcriptionLanguages: z.array(z.string().trim().min(2).max(10)).min(1).max(10).optional(),
    aiSummaryEnabled: z.boolean().optional(),
  })
  .openapi('UpdateCommunicationPolicyRequest');

export const integrationDto = z
  .object({
    _id: z.string(),
    kind: z.string(),
    provider: z.string(),
    enabled: z.boolean(),
    status: z.string(),
    config: z.record(z.string(), z.unknown()),
    secretsSet: z.array(z.string()).openapi({ description: 'Which credential keys are stored (values are never returned)' }),
    webhookUrl: z.string().nullable(),
    lastEventAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .openapi('Integration');
