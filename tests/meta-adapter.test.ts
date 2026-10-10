import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRateLimitError } from '../src/integrations/ads/ads.provider.js';
import { metaAdsProvider } from '../src/integrations/ads/meta.ads.js';

const creds = { config: {}, secrets: { accessToken: 'EAAtesttoken', appSecret: 's3cret', verifyToken: 'vt' } };
const body = { object: 'page', entry: [{ id: 'P1', changes: [{ field: 'leadgen', value: { leadgen_id: '444', page_id: 'P1', form_id: 'F1', ad_id: 'A1', created_time: 1760000000 } }, { field: 'feed', value: {} }] }] };
const req = (b: unknown, sig?: string) => {
  const raw = Buffer.from(JSON.stringify(b));
  return { body: b, rawBody: raw, headers: { 'x-hub-signature-256': sig ?? `sha256=${createHmac('sha256', 's3cret').update(raw).digest('hex')}` } } as unknown as Request;
};

afterEach(() => vi.unstubAllGlobals());

describe('Meta adapter (offline)', () => {
  it('verifies X-Hub-Signature-256 and parses only leadgen changes', () => {
    expect(() => metaAdsProvider.verifyWebhook!(req(body), creds)).not.toThrow();
    expect(() => metaAdsProvider.verifyWebhook!(req(body, 'sha256=deadbeef'), creds)).toThrow();
    expect(metaAdsProvider.parseWebhook!(req(body))).toEqual([expect.objectContaining({ eventKey: 'leadgen:444', kind: 'lead', externalLeadId: '444', pageExternalId: 'P1', formExternalId: 'F1', adExternalId: 'A1' })]);
    expect(metaAdsProvider.webhookChallenge!({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '99' }, creds)).toBe('99');
    expect(metaAdsProvider.webhookChallenge!({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '99' }, creds)).toBeNull();
  });

  it('maps a lead and keeps the token out of the URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: '444', created_time: '2026-10-09T10:00:00+0000', form_id: 'F1', campaign_id: 'C1', campaign_name: 'UK', adset_id: 'S1', ad_id: 'A1', ad_name: 'Ad', platform: 'ig', field_data: [{ name: 'full_name', values: ['Asha Rao'] }, { name: 'phone_number', values: ['+919810000001'] }] })));
    vi.stubGlobal('fetch', fetchMock);
    const lead = await metaAdsProvider.fetchLead(creds, '444');
    expect(lead).toMatchObject({ externalLeadId: '444', formExternalId: 'F1', campaignExternalId: 'C1', campaignName: 'UK', platform: 'ig', answers: { full_name: 'Asha Rao', phone_number: '+919810000001' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toContain('graph.facebook.com/v26.0/444');
    expect(String(url)).not.toContain('EAAtesttoken');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EAAtesttoken');
  });

  it('turns throttling codes into a retryable rate-limit error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'User request limit reached', code: 17 } }), { status: 400 })));
    await expect(metaAdsProvider.fetchLead(creds, '1')).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('reports missing permissions from /me/permissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: URL) => new Response(JSON.stringify(String(u).includes('permissions') ? { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'leads_retrieval', status: 'declined' }] } : { id: '1', name: 'Client BM' }))));
    const v = await metaAdsProvider.validate(creds);
    expect(v).toMatchObject({ ok: true, accountName: 'Client BM', grantedScopes: ['ads_read'] });
    expect(v.missingScopes).toContain('leads_retrieval');
  });
});
