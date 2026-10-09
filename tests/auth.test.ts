import { describe, expect, it } from 'vitest';
import {
  api,
  bearer,
  createOrgWithAdmin,
  createUserAs,
  login,
  PASSWORD,
  sentEmails,
} from './helpers.js';

describe('Auth', () => {
  it('logs in and returns the current user with permissions', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail.toUpperCase(), password: PASSWORD, platform: 'android' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTypeOf('string');
    expect(res.body.data.refreshToken).toBeTypeOf('string');
    expect(res.body.data.user.role.key).toBe('org_admin');
    expect(res.body.data.user.permissions).toContain('lead.create');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('web login sets an httpOnly refresh cookie and omits the token from the body', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD, platform: 'web' });

    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/crm_rt=/);
    expect(cookie).toMatch(/HttpOnly/);

    const refreshed = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie.split(';')[0]!)
      .send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTypeOf('string');
  });

  it('rejects wrong password and unknown email with the same message', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: 'nope-nope1' });
    const unknown = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@test.local', password: 'nope-nope1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('validates request bodies with field errors', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ success: false, message: 'Validation failed' });
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining(['body.email', 'body.password']),
    );
  });

  it('requires a valid bearer token', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('rotates refresh tokens and kills the session when an old token is replayed', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const first = await login(adminEmail);

    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(r1.status).toBe(200);
    const second = r1.body.data.refreshToken as string;
    expect(second).not.toBe(first.refreshToken);

    // Replay of the rotated token → reuse detected → session revoked.
    const replay = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    const afterRevoke = await api().post('/api/v1/auth/refresh').send({ refreshToken: second });
    expect(afterRevoke.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const t = await login(adminEmail);
    expect(
      (await api().post('/api/v1/auth/logout').send({ refreshToken: t.refreshToken })).status,
    ).toBe(200);
    expect(
      (await api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken })).status,
    ).toBe(401);
  });

  it('change password invalidates other sessions and old access tokens', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const deviceA = await login(adminEmail);
    const deviceB = await login(adminEmail);

    // Ensure the change lands in a later second than the tokens' iat.
    await new Promise((r) => setTimeout(r, 1100));
    const res = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(deviceA.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd456' });
    expect(res.status).toBe(200);

    expect((await api().get('/api/v1/auth/me').set(bearer(deviceA.accessToken))).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(bearer(res.body.data.accessToken))).status).toBe(
      200,
    );
    expect(
      (await api().post('/api/v1/auth/refresh').send({ refreshToken: deviceB.refreshToken }))
        .status,
    ).toBe(401);
    expect(
      (await api().post('/api/v1/auth/refresh').send({ refreshToken: deviceA.refreshToken }))
        .status,
    ).toBe(200);
    await login(adminEmail, 'NewPassw0rd456');
  });

  it('forgot/reset password flow works once and does not leak whether an email exists', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const unknown = await api()
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'ghost@test.local' });
    const known = await api().post('/api/v1/auth/forgot-password').send({ email: adminEmail });
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);

    const mail = sentEmails()
      .filter((m) => m.to === adminEmail)
      .at(-1);
    const token = decodeURIComponent(/token=([^&\s]+)/.exec(mail?.text ?? '')?.[1] ?? '');
    expect(token).not.toBe('');

    const reset = await api()
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Reset12345' });
    expect(reset.status).toBe(200);
    await login(adminEmail, 'Reset12345');

    const reuse = await api()
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Another123' });
    expect(reuse.status).toBe(400);
  });

  it('deactivated users are signed out and cannot log in', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');

    const res = await api()
      .patch(`/api/v1/users/${counsellor.id}/status`)
      .set(bearer(token))
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(counsellor.token))).status).toBe(401);
    const loginRes = await api()
      .post('/api/v1/auth/login')
      .send({ email: counsellor.email, password: PASSWORD });
    expect(loginRes.status).toBe(403);
  });

  it('lists and revokes own sessions', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const a = await login(adminEmail);
    const b = await login(adminEmail);
    const list = await api().get('/api/v1/auth/sessions').set(bearer(a.accessToken));
    // createOrgWithAdmin signs in once too.
    expect(list.body.data.length).toBe(3);
    const others = list.body.data.filter((s: { current: boolean }) => !s.current);
    expect(others).toHaveLength(2);

    for (const s of others) {
      expect(
        (await api().delete(`/api/v1/auth/sessions/${s.id}`).set(bearer(a.accessToken))).status,
      ).toBe(200);
    }
    expect(
      (await api().post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken })).status,
    ).toBe(401);
    expect(
      (await api().post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken })).status,
    ).toBe(200);
  });
});
