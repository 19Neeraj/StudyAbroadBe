import type { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { z } from '../../docs/zod.js';
import { callingProvider, CALLING_PROVIDERS } from '../../integrations/calling/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { createModuleRouter } from '../../utils/router.js';
import { applyProviderEvent } from '../calls/call.service.js';
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

export const webhookModule = m;
