import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone, slugify } from '../src/utils/normalize.js';
import { generateOpenApiDocument } from '../src/docs/openapi.js';
import '../src/routes/index.js';
import { api } from './helpers.js';

describe('normalization', () => {
  it.each([
    ['+91 98765-43210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['098765 43210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['+44 20 7946 0958', '+442079460958'],
    ['(555) 01', null],
    ['', null],
  ])('normalizePhone(%s) → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('normalizes email and slugs', () => {
    expect(normalizeEmail('  Riya.Sharma@Example.COM ')).toBe('riya.sharma@example.com');
    expect(slugify('Master’s — Data Science!')).toBe('master_s_data_science');
  });
});

describe('API documentation & conventions', () => {
  it('documents every route with a summary and the security requirement', () => {
    const doc = generateOpenApiDocument();
    const ops = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { summary?: string; security?: unknown }>).map(
        ([method, op]) => ({ path, method, op }),
      ),
    );
    expect(ops.length).toBeGreaterThan(30);
    for (const { op } of ops) expect(op.summary).toBeTruthy();
    const me = ops.find((o) => o.path === '/auth/me');
    expect(me?.op.security).toEqual([{ bearerAuth: [] }]);
  });

  it('returns JSON envelopes for unknown routes and malformed JSON', async () => {
    const notFound = await api().get('/api/v1/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });

    const malformed = await api()
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.success).toBe(false);
  });

  it('sets security headers and request ids', async () => {
    const res = await api().get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
