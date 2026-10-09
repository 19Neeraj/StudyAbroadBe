import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { api, createOrgWithAdmin, login, PASSWORD } from './helpers.js';

// Limiters are skipped under NODE_ENV=test; enable them for this file only (modules are isolated per file).
const mutableEnv = env as { NODE_ENV: string };
beforeAll(() => {
  mutableEnv.NODE_ENV = 'development';
});
afterAll(() => {
  mutableEnv.NODE_ENV = 'test';
});

describe('Rate limiting', () => {
  it('limits login attempts per account without locking out colleagues on the same IP', async () => {
    const victim = await createOrgWithAdmin('Victim Org');
    const colleague = await createOrgWithAdmin('Colleague Org');

    let status = 0;
    for (let i = 0; i <= env.AUTH_RATE_LIMIT_MAX; i++) {
      status = (
        await api()
          .post('/api/v1/auth/login')
          .send({ email: victim.adminEmail, password: 'wrong-pass1' })
      ).status;
    }
    expect(status).toBe(429);

    // Same IP, different account: still allowed.
    const ok = await api()
      .post('/api/v1/auth/login')
      .send({ email: colleague.adminEmail, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('does not count token refreshes against the login limit', async () => {
    const { adminEmail } = await createOrgWithAdmin('Refresh Org');
    let { refreshToken } = await login(adminEmail);
    for (let i = 0; i < env.AUTH_RATE_LIMIT_MAX + 5; i++) {
      const res = await api().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(200);
      refreshToken = res.body.data.refreshToken;
    }
  });
});
