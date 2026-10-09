import type { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { isProduction } from '../../config/env.js';
import { callingProvider, CALLING_PROVIDERS } from '../../integrations/calling/index.js';
import type { ProviderCredentials } from '../../integrations/calling/calling.provider.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { decryptSecret, encryptSecret, randomToken } from '../../utils/crypto.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { CommunicationPolicyModel, getCommunicationPolicy } from './communicationPolicy.model.js';
import { IntegrationModel, type IntegrationKind } from './integration.model.js';
import type { updateCallingBody, updatePolicyBody } from './integration.validation.js';

export const DEFAULT_CALLING = { provider: 'device', enabled: true } as const;

export function allowedCallingProviders(): string[] {
  return CALLING_PROVIDERS.filter((p) => p !== 'mock' || !isProduction);
}

/** Active calling integration of an organization (falls back to native device dialling). */
export async function activeCalling(organizationId: Types.ObjectId) {
  const doc = await IntegrationModel.findOne({ organizationId, kind: 'calling', enabled: true }).select('+secrets +webhookToken').lean();
  if (!doc) return { provider: callingProvider('device'), integration: null, creds: { config: {}, secrets: {} } as ProviderCredentials };
  return { provider: callingProvider(doc.provider), integration: doc, creds: credentialsOf(doc) };
}

export function credentialsOf(doc: { config?: unknown; secrets?: string | null }): ProviderCredentials {
  return {
    config: (doc.config ?? {}) as Record<string, unknown>,
    secrets: doc.secrets ? (JSON.parse(decryptSecret(doc.secrets)) as Record<string, string>) : {},
  };
}

/** Webhooks: resolve the organization from the secret token in the callback URL. */
export async function integrationByWebhookToken(kind: IntegrationKind, provider: string, token: string) {
  if (!token || token.length < 20) return null;
  return IntegrationModel.findOne({ webhookToken: token, kind, provider })
    .select('+secrets +webhookToken')
    .setOptions({ skipTenantGuard: true })
    .lean();
}

/** Never returns secrets — only which secret keys are set. */
function publicView(doc: { _id: Types.ObjectId; kind: string; provider: string; enabled: boolean; status: string; config: unknown; secrets?: string | null; webhookToken?: string; lastEventAt?: Date | null; lastError?: string | null; updatedAt?: Date }, webhookBase: string) {
  const secretKeys = doc.secrets ? Object.keys(JSON.parse(decryptSecret(doc.secrets)) as object) : [];
  return {
    _id: doc._id,
    kind: doc.kind,
    provider: doc.provider,
    enabled: doc.enabled,
    status: doc.status,
    config: doc.config,
    secretsSet: secretKeys,
    webhookUrl: doc.webhookToken ? `${webhookBase}/api/v1/webhooks/${doc.kind}/${doc.provider}/${doc.webhookToken}` : null,
    lastEventAt: doc.lastEventAt ?? null,
    lastError: doc.lastError ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

export async function getCallingSettings(ctx: ServiceContext, webhookBase: string) {
  const doc = await IntegrationModel.findOne({ organizationId: ctx.organizationId, kind: 'calling' }).select('+secrets +webhookToken').lean();
  return {
    integration: doc ? publicView(doc, webhookBase) : null,
    effectiveProvider: doc?.enabled ? doc.provider : DEFAULT_CALLING.provider,
    availableProviders: allowedCallingProviders(),
  };
}

export async function updateCallingSettings(ctx: ServiceContext, input: z.infer<typeof updateCallingBody>, webhookBase: string) {
  if (!allowedCallingProviders().includes(input.provider)) {
    throw ApiError.validation([{ field: 'body.provider', message: 'Unsupported provider' }]);
  }
  const existing = await IntegrationModel.findOne({ organizationId: ctx.organizationId, kind: 'calling' }).select('+secrets +webhookToken');
  // Secrets merge: omitted keys keep their stored value; empty string removes one.
  const prevSecrets = existing?.secrets && existing.provider === input.provider ? (JSON.parse(decryptSecret(existing.secrets)) as Record<string, string>) : {};
  const secrets = { ...prevSecrets };
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    if (v) secrets[k] = v;
    else delete secrets[k];
  }
  const update = {
    provider: input.provider,
    enabled: input.enabled,
    config: input.config ?? {},
    secrets: Object.keys(secrets).length ? encryptSecret(JSON.stringify(secrets)) : undefined,
    status: 'connected' as const,
    lastError: undefined,
    updatedBy: ctx.userId,
  };
  if (existing) {
    existing.set(update);
    await existing.save();
  } else {
    await IntegrationModel.create({ ...update, organizationId: ctx.organizationId, kind: 'calling', webhookToken: randomToken(32) });
  }
  await recordAudit(ctx, {
    entityType: 'integration',
    entityId: existing?._id,
    action: 'integration.calling.updated',
    // Secret values are never audited, only which keys changed.
    metadata: { provider: input.provider, enabled: input.enabled, secretKeysChanged: Object.keys(input.secrets ?? {}) },
  });
  return getCallingSettings(ctx, webhookBase);
}

export async function rotateWebhookToken(ctx: ServiceContext, kind: IntegrationKind, webhookBase: string) {
  const res = await IntegrationModel.updateOne({ organizationId: ctx.organizationId, kind }, { webhookToken: randomToken(32) });
  if (!res.matchedCount) throw ApiError.notFound('Integration');
  await recordAudit(ctx, { entityType: 'integration', action: `integration.${kind}.webhook_rotated` });
  return getCallingSettings(ctx, webhookBase);
}

export async function getPolicy(ctx: ServiceContext) {
  const { _id, organizationId: _o, __v: _v, ...rest } = (await getCommunicationPolicy(ctx.organizationId)) as Record<string, unknown> & { _id: unknown };
  return rest;
}

export async function updatePolicy(ctx: ServiceContext, input: z.infer<typeof updatePolicyBody>) {
  const before = await getCommunicationPolicy(ctx.organizationId);
  await CommunicationPolicyModel.updateOne({ organizationId: ctx.organizationId }, { ...input, updatedBy: ctx.userId });
  const diff = diffFields(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await recordAudit(ctx, { entityType: 'communication_policy', action: 'communication.policy_updated', ...diff });
  return getPolicy(ctx);
}

export async function markIntegrationEvent(organizationId: Types.ObjectId, kind: IntegrationKind, error?: string) {
  await IntegrationModel.updateOne(
    { organizationId, kind },
    error ? { status: 'error', lastError: error.slice(0, 500) } : { lastEventAt: new Date(), status: 'connected', $unset: { lastError: 1 } },
  );
}
