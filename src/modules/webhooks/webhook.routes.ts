import type { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { z } from '../../docs/zod.js';
import { callingProvider, CALLING_PROVIDERS } from '../../integrations/calling/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { createModuleRouter } from '../../utils/router.js';
import { adsProvider, adsProviderKeys } from '../../integrations/ads/index.js';
import { enqueue } from '../../jobs/queue.js';
import { applyProviderEvent } from '../calls/call.service.js';
import { IntegrationModel } from '../integrations/integration.model.js';
import { ExternalLeadReferenceModel } from '../marketing/externalLeadReference.model.js';
import { credentialsOf, integrationByWebhookToken, markIntegrationEvent } from '../integrations/integration.service.js';
import { WebhookEventModel } from './webhookEvent.model.js';

const m = createModuleRouter('/webhooks', 'Webhooks');

/**
 * Records the event once (idempotency key = provider event key) and processes it. A failed event
 * answers 500 so the provider retries; the retry re-processes it because it isn't marked processed.
 */
async function processOnce(organizationId: Types.ObjectId, kind: string, provider: string, eventKey: string, payload: unknown, run: () => Promise<string>) {
  const doc = await WebhookEventModel.findOneAndUpdate(
    { organizationId, provider, eventKey },
    { $setOnInsert: { organizationId, kind, provider, eventKey, payload }, $inc: { attempts: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (doc.status === 'processed' || doc.status === 'ignored') return 'duplicate';
  try {
    const result = await run();
    await WebhookEventModel.updateOne({ organizationId, _id: doc._id }, { status: result === 'ignored' ? 'ignored' : 'processed', processedAt: new Date(), $unset: { error: 1 } });
    return result;
  } catch (err) {
    await WebhookEventModel.updateOne({ organizationId, _id: doc._id }, { status: 'failed', error: (err as Error).message.slice(0, 500) });
    throw err;
  }
}

m.publicRoute({
  method: 'post',
  path: '/calling/:provider/:token',
  summary: 'Calling provider status callback (call status, duration, recording)',
  description:
    'The URL (with its secret per-organization token) is shown in Communication settings. Requests are verified by the ' +
    'provider adapter (signature or token), recorded for idempotency and processed; duplicates are acknowledged without effect.',
  params: z.object({ provider: z.enum(CALLING_PROVIDERS as [string, ...string[]]), token: z.string().min(20).max(100) }),
  handler: async ({ req, params }) => {
    const integration = await integrationByWebhookToken('calling', params.provider, params.token);
    if (!integration) throw ApiError.notFound('Webhook');
    const provider = callingProvider(params.provider);
    try {
      provider.verifyWebhook?.(req, credentialsOf(integration));
    } catch {
      logger.warn({ provider: params.provider }, 'Rejected calling webhook with invalid signature');
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    const events = provider.parseWebhook(req);
    const results: string[] = [];
    try {
      for (const e of events) {
        results.push(await processOnce(integration.organizationId, 'calling', params.provider, e.eventKey, e.raw, () => applyProviderEvent(integration.organizationId, params.provider, e)));
      }
      await markIntegrationEvent(integration.organizationId, 'calling');
    } catch (err) {
      await markIntegrationEvent(integration.organizationId, 'calling', (err as Error).message);
      throw err;
    }
    return { data: { received: events.length, results }, message: 'Accepted' };
  },
});

/** Ads webhooks resolve the organization from the secret token in the URL (one URL per connection). */
async function adsIntegrationByToken(provider: string, token: string) {
  if (!adsProviderKeys().includes(provider) || !token || token.length < 20) return null;
  return IntegrationModel.findOne({ webhookToken: token, provider, kind: { $in: ['meta_ads', 'google_ads'] }, enabled: true })
    .select('+secrets +webhookToken')
    .setOptions({ skipTenantGuard: true })
    .lean();
}

const adsParams = z.object({ provider: z.string().min(1).max(40), token: z.string().min(20).max(100) });

m.publicRoute({
  method: 'get',
  path: '/ads/:provider/:token',
  summary: 'Ads webhook subscription handshake (Meta: hub.mode / hub.verify_token / hub.challenge)',
  params: adsParams,
  handler: async ({ req, res, params }) => {
    const integration = await adsIntegrationByToken(params.provider, params.token);
    if (!integration) throw ApiError.notFound('Webhook');
    // Read hub.* from the raw URL: the request sanitizer strips dotted keys from req.query (NoSQL-injection guard).
    const query = Object.fromEntries(new URL(req.originalUrl, 'http://local').searchParams);
    const challenge = adsProvider(params.provider).webhookChallenge?.(query, credentialsOf(integration));
    if (challenge === null || challenge === undefined) throw ApiError.forbidden('Verification token does not match');
    // The provider expects the bare challenge string, not the JSON envelope.
    res.status(200).type('text/plain').send(challenge);
  },
});

m.publicRoute({
  method: 'post',
  path: '/ads/:provider/:token',
  summary: 'Ads lead webhook (Meta leadgen)',
  description:
    'Signature-checked (Meta: X-Hub-Signature-256 with the app secret), recorded once per event, then answered quickly; ' +
    'lead details are fetched and imported in the background queue. Duplicate deliveries have no effect.',
  params: adsParams,
  handler: async ({ req, params }) => {
    const integration = await adsIntegrationByToken(params.provider, params.token);
    if (!integration) throw ApiError.notFound('Webhook');
    const provider = adsProvider(params.provider);
    try {
      provider.verifyWebhook?.(req, credentialsOf(integration));
    } catch {
      logger.warn({ provider: params.provider }, 'Rejected ads webhook with invalid signature');
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    const orgId = integration.organizationId;
    const events = provider.parseWebhook?.(req) ?? [];
    const results: string[] = [];
    for (const e of events) {
      results.push(
        await processOnce(orgId, integration.kind, params.provider, e.eventKey, e.raw, async () => {
          if (e.kind !== 'lead' || !e.externalLeadId) return 'ignored';
          // Record first so the lead is visible (and never lost) even before the job runs.
          await ExternalLeadReferenceModel.updateOne(
            { organizationId: orgId, provider: params.provider, externalLeadId: e.externalLeadId },
            { $setOnInsert: { organizationId: orgId, provider: params.provider, externalLeadId: e.externalLeadId, status: 'received', receivedVia: 'webhook', pageExternalId: e.pageExternalId, formExternalId: e.formExternalId, adExternalId: e.adExternalId } },
            { upsert: true },
          );
          await enqueue('ads.processLead', { organizationId: orgId.toString(), provider: params.provider, externalLeadId: e.externalLeadId, via: 'webhook' }, { jobId: `ads.lead:${params.provider}:${e.externalLeadId}` });
          return 'queued';
        }),
      );
    }
    await IntegrationModel.updateOne({ organizationId: orgId, _id: integration._id }, { lastEventAt: new Date() });
    return { data: { received: events.length, results }, message: 'Accepted' };
  },
});

export const webhookModule = m;
