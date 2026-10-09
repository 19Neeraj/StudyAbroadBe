import { describe, expect, it } from 'vitest';
import { api, bearer, createOrgWithAdmin, createUserAs } from './helpers.js';

describe('Admin settings (lookups)', () => {
  it('seeds lead stages in pipeline order', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api().get('/api/v1/settings/lookups/lead_stage').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { key: string }) => s.key)).toEqual([
      'new_lead',
      'contacted',
      'meeting_pending',
      'meeting_done',
      'shortlisting_pending',
      'shortlisted',
      'application',
      'offer_received',
      'payment_pending',
      'visa',
      'enrolled',
    ]);
  });

  it('returns several types grouped in one call', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api()
      .get('/api/v1/settings/lookups?types=lead_source,lead_status')
      .set(bearer(token));
    expect(Object.keys(res.body.data).sort()).toEqual(['lead_source', 'lead_status']);
    expect(res.body.data.lead_source.map((s: { key: string }) => s.key)).toContain('walk_in');
  });

  it('lets admins add, rename, reorder and deactivate values', async () => {
    const { token } = await createOrgWithAdmin();
    const created = await api()
      .post('/api/v1/settings/lookups/lead_source')
      .set(bearer(token))
      .send({ label: 'LinkedIn Ads' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      key: 'linkedin_ads',
      isActive: true,
      isSystem: false,
    });

    const dup = await api()
      .post('/api/v1/settings/lookups/lead_source')
      .set(bearer(token))
      .send({ label: 'LinkedIn  Ads' });
    expect(dup.status).toBe(409);

    const id = created.body.data._id;
    const renamed = await api()
      .patch(`/api/v1/settings/lookups/lead_source/${id}`)
      .set(bearer(token))
      .send({ label: 'LinkedIn' });
    expect(renamed.body.data).toMatchObject({ label: 'LinkedIn', key: 'linkedin_ads' });

    await api()
      .patch(`/api/v1/settings/lookups/lead_source/${id}`)
      .set(bearer(token))
      .send({ isActive: false })
      .expect(200);
    const active = await api().get('/api/v1/settings/lookups/lead_source').set(bearer(token));
    expect(active.body.data.map((s: { _id: string }) => s._id)).not.toContain(id);

    const all = await api()
      .get('/api/v1/settings/lookups/lead_source?includeInactive=true')
      .set(bearer(token));
    const ids: string[] = all.body.data.map((s: { _id: string }) => s._id);
    const reordered = await api()
      .put('/api/v1/settings/lookups/lead_source/order')
      .set(bearer(token))
      .send({ ids: [...ids].reverse() });
    expect(reordered.body.data.map((s: { _id: string }) => s._id)).toEqual([...ids].reverse());
  });

  it('protects system values and validates type-specific metadata', async () => {
    const { token } = await createOrgWithAdmin();
    const stages = await api().get('/api/v1/settings/lookups/lead_stage').set(bearer(token));
    const newLead = stages.body.data.find((s: { key: string }) => s.key === 'new_lead');

    const deactivate = await api()
      .patch(`/api/v1/settings/lookups/lead_stage/${newLead._id}`)
      .set(bearer(token))
      .send({ isActive: false });
    expect(deactivate.status).toBe(400);

    const badMeta = await api()
      .post('/api/v1/settings/lookups/lead_stage')
      .set(bearer(token))
      .send({ label: 'Deposit Paid', meta: { category: 'maybe' } });
    expect(badMeta.status).toBe(422);
    expect(badMeta.body.errors[0].field).toBe('body.meta.category');

    const unknownType = await api().get('/api/v1/settings/lookups/unicorns').set(bearer(token));
    expect(unknownType.status).toBe(422);
  });

  it('allows every user to read settings but only admins to change them', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    expect(
      (await api().get('/api/v1/settings/lookups/country').set(bearer(counsellor.token))).status,
    ).toBe(200);
    const res = await api()
      .post('/api/v1/settings/lookups/country')
      .set(bearer(counsellor.token))
      .send({ label: 'Japan' });
    expect(res.status).toBe(403);
  });

  it('updates organization settings without clobbering other fields', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api()
      .patch('/api/v1/organizations/current')
      .set(bearer(token))
      .send({ settings: { currency: 'USD' } });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({
      currency: 'USD',
      timezone: 'Asia/Kolkata',
      defaultCountryCode: '91',
    });
    const bad = await api()
      .patch('/api/v1/organizations/current')
      .set(bearer(token))
      .send({ settings: { timezone: 'Mars/Base' } });
    expect(bad.status).toBe(422);
  });
});
