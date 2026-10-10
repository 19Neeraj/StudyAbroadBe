import { env } from '../../config/env.js';
import { z } from '../../docs/zod.js';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { ApiError } from '../../utils/ApiError.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as hub from './hub.service.js';
import * as website from './website.service.js';
import { createWebsiteKeyBody, websiteLeadBody } from './website.validation.js';
import { accountsBody, campaignsQuery, connectBody, fieldMappingBody, importedLeadsQuery, providerParams, settingsBody, syncBody, syncLogQuery } from './hub.validation.js';

const m = createModuleRouter('/integrations', 'Integrations & Marketing hub');
const base = () => env.API_PUBLIC_URL;

// Static paths first so they aren't captured by "/:provider/…".
// Website lead capture: server-to-server with an API key; limited per key and per IP.
const websiteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  keyGenerator: (req) => `wk:${String(req.headers['x-api-key'] ?? '').slice(0, 24)}:${ipKeyGenerator(req.ip ?? '0.0.0.0')}`,
  handler: (_req, _res, next) => next(ApiError.tooManyRequests()),
});

m.publicRoute({
  method: 'post',
  path: '/website/leads',
  summary: 'Website form → lead (API key in X-Api-Key; optional Idempotency-Key)',
  description:
    'Send from your website server, never from browser JavaScript (the key is secret). attribution.first is the original landing ' +
    '(captured by the first-party snippet), attribution.last the current visit. Responses: 201 created, 200 merged into an existing ' +
    'lead, 200 duplicate_submission for a repeated Idempotency-Key, 401 bad key, 422 invalid body, 429 rate limited.',
  middlewares: [websiteLimiter],
  body: websiteLeadBody,
  handler: async ({ req, res, body }) => {
    const key = await website.keyFromHeader(req.headers['x-api-key'] as string | undefined);
    if (!key) throw ApiError.unauthorized('Invalid or revoked API key');
    const idem = req.headers['idempotency-key'];
    const result = await website.submitWebsiteLead(key, body, typeof idem === 'string' && idem.length <= 200 ? idem : undefined);
    res.status(result.status === 'created' ? 201 : 200);
    return { data: result, message: result.status === 'created' ? 'Lead created' : result.status === 'merged' ? 'Added to existing lead' : 'Already received', status: result.status === 'created' ? 201 : 200 };
  },
});
m.route({ method: 'get', path: '/website/keys', summary: 'Website API keys (only a prefix is shown)', permissions: ['integration.manage'], handler: async ({ ctx }) => ({ data: await website.listKeys(ctx) }) });
m.route({ method: 'post', path: '/website/keys', summary: 'Create a website API key (the key is shown once)', permissions: ['integration.manage'], body: createWebsiteKeyBody, successStatus: 201, handler: async ({ ctx, body }) => ({ message: 'Key created — copy it now, it will not be shown again', data: await website.createKey(ctx, body) }) });
m.route({ method: 'delete', path: '/website/keys/:id', summary: 'Revoke a website API key (stops working immediately)', permissions: ['integration.manage'], params: idParams, handler: async ({ ctx, params }) => { await website.revokeKey(ctx, params.id); return { data: null, message: 'Key revoked' }; } });

m.route({ method: 'get', path: '/', summary: 'Integration overview: status cards, 30-day counts and recent sync activity', permissions: ['integration.view'], handler: async ({ ctx }) => ({ data: await hub.overview(ctx) }) });
m.route({ method: 'get', path: '/sync-logs', summary: 'Sync history', permissions: ['integration.view'], query: syncLogQuery, paginated: true, handler: async ({ ctx, query }) => { const r = await hub.listSyncLogs(ctx, query); return { data: r.items, pagination: r.pagination }; } });
m.route({ method: 'get', path: '/failed-jobs', summary: 'Failed lead imports and failed/partial sync runs (last 7 days)', permissions: ['integration.view'], handler: async ({ ctx }) => ({ data: await hub.failedJobs(ctx) }) });
m.route({ method: 'post', path: '/failed-jobs/leads/retry', summary: 'Retry every failed lead import', permissions: ['integration.manage'], handler: async ({ ctx }) => ({ message: 'Retry queued', data: await hub.retryLeads(ctx) }) });
m.route({ method: 'post', path: '/failed-jobs/leads/:id/retry', summary: 'Retry one failed lead import (never re-imports a lead that already succeeded)', permissions: ['integration.manage'], params: idParams, handler: async ({ ctx, params }) => ({ message: 'Retry queued', data: await hub.retryLeads(ctx, params.id) }) });
m.route({ method: 'post', path: '/sync-logs/:id/retry', summary: 'Run a failed sync again with the same window', permissions: ['integration.manage'], params: idParams, handler: async ({ ctx, params }) => ({ message: 'Sync queued', data: await hub.retrySync(ctx, params.id) }) });

m.route({ method: 'get', path: '/:provider/status', summary: 'Connection detail: scopes, sync state, webhook URL (secrets never returned)', permissions: ['integration.view'], params: providerParams, handler: async ({ ctx, params }) => ({ data: await hub.getStatus(ctx, params.provider, base()) }) });
m.route({
  method: 'post',
  path: '/:provider/connect',
  summary: 'Connect or reconnect with credentials (validated with the provider before saving)',
  description: 'Meta: a System User token with ads_read, leads_retrieval and page permissions, the app secret (webhook signatures) and a verify token of your choice. Missing permissions are reported, not assumed.',
  permissions: ['integration.manage'],
  params: providerParams,
  body: connectBody,
  handler: async ({ ctx, params, body }) => ({ message: 'Connected', data: await hub.connect(ctx, params.provider, body, base()) }),
});
m.route({ method: 'patch', path: '/:provider/settings', summary: 'Import settings: lead source, duplicate policy, default branch / counsellor / stage', permissions: ['integration.manage'], params: providerParams, body: settingsBody, handler: async ({ ctx, params, body }) => ({ message: 'Settings saved', data: await hub.updateSettings(ctx, params.provider, body, base()) }) });
m.route({ method: 'post', path: '/:provider/disconnect', summary: 'Disconnect (erases credentials, keeps history and imported data)', permissions: ['integration.manage'], params: providerParams, handler: async ({ ctx, params }) => ({ message: 'Disconnected', data: await hub.disconnect(ctx, params.provider, base()) }) });
m.route({ method: 'post', path: '/:provider/rotate-webhook', summary: 'Issue a new webhook URL (update it in the provider app)', permissions: ['integration.manage'], params: providerParams, handler: async ({ ctx, params }) => ({ message: 'Webhook URL rotated', data: await hub.rotateWebhook(ctx, params.provider, base()) }) });
m.route({ method: 'get', path: '/:provider/accounts', summary: 'Ad accounts, pages and lead forms the connection can see', permissions: ['integration.view'], params: providerParams, handler: async ({ ctx, params }) => ({ data: await hub.listAccounts(ctx, params.provider) }) });
m.route({ method: 'patch', path: '/:provider/accounts', summary: 'Choose which accounts, pages and forms are synced', permissions: ['integration.manage'], params: providerParams, body: accountsBody, handler: async ({ ctx, params, body }) => ({ message: 'Selection saved', data: await hub.selectAccounts(ctx, params.provider, body) }) });
m.route({ method: 'post', path: '/:provider/sync', summary: 'Queue a sync now (accounts, campaigns, metrics, leads or all)', permissions: ['integration.manage'], params: providerParams, body: syncBody, handler: async ({ ctx, params, body }) => ({ message: 'Sync queued', data: await hub.syncNow(ctx, params.provider, body) }) });
m.route({ method: 'get', path: '/:provider/campaigns', summary: 'Campaign → ad set → ad tree with spend, provider leads and CRM leads for a date range', permissions: ['marketing.view'], params: providerParams, query: campaignsQuery, response: z.array(z.unknown()), handler: async ({ ctx, params, query }) => ({ data: await hub.campaignTree(ctx, params.provider, query) }) });
m.route({ method: 'get', path: '/:provider/leads', summary: 'Leads received from the provider and what happened to each', permissions: ['integration.view'], params: providerParams, query: importedLeadsQuery.omit({ provider: true }), paginated: true, handler: async ({ ctx, params, query }) => { const r = await hub.listImportedLeads(ctx, { ...query, provider: params.provider }); return { data: r.items, pagination: r.pagination }; } });
m.route({ method: 'get', path: '/:provider/field-mappings', summary: 'Form field → CRM field mappings and field names seen in recent submissions', permissions: ['integration.manage'], params: providerParams, handler: async ({ ctx, params }) => ({ data: await hub.getFieldMappings(ctx, params.provider) }) });
m.route({ method: 'put', path: '/:provider/field-mappings', summary: 'Save the mapping for one form (or the provider default)', permissions: ['integration.manage'], params: providerParams, body: fieldMappingBody, handler: async ({ ctx, params, body }) => ({ message: 'Mapping saved', data: await hub.saveFieldMapping(ctx, params.provider, body) }) });

export const integrationHubModule = m;
