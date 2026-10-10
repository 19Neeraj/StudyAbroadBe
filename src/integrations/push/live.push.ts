import { connect } from 'node:http2';
import { createSign } from 'node:crypto';
import { env } from '../../config/env.js';
import type { PushMessage, PushProvider, PushResult } from './push.provider.js';

/** Accepts raw or base64-encoded secrets (env files handle one-line base64 better). */
const decode = (v: string) => (v.trim().startsWith('{') || v.includes('BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8'));
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// ---------------------------------------------------------------- FCM HTTP v1 (Android)
let fcmToken: { value: string; expires: number } | null = null;

async function fcmAccessToken(sa: { client_email: string; private_key: string; token_uri?: string }) {
  if (fcmToken && fcmToken.expires > Date.now() + 60_000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key, 'base64url');
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!body.access_token) throw new Error(`FCM auth failed: ${body.error ?? res.status}`);
  fcmToken = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return fcmToken.value;
}

async function sendFcm(token: string, m: PushMessage): Promise<PushResult> {
  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, error: 'FCM_SERVICE_ACCOUNT not configured' };
  const sa = JSON.parse(decode(env.FCM_SERVICE_ACCOUNT)) as { project_id: string; client_email: string; private_key: string; token_uri?: string };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await fcmAccessToken(sa)}`, 'content-type': 'application/json' },
    // Channel "crm" is created by the app (services/push.ts).
    body: JSON.stringify({ message: { token, notification: { title: m.title, body: m.body }, data: m.data, android: { priority: 'HIGH', notification: { channel_id: 'crm' } } } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return { ok: true };
  const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
  return { ok: false, invalidToken: res.status === 404 || err.error?.status === 'UNREGISTERED' || err.error?.status === 'INVALID_ARGUMENT', error: `FCM ${res.status}: ${err.error?.message ?? ''}` };
}

// ---------------------------------------------------------------- APNs (iOS)
let apnsJwt: { value: string; issued: number } | null = null;

function apnsToken() {
  // Apple accepts a provider token for up to an hour; refresh every 50 minutes.
  if (apnsJwt && Date.now() - apnsJwt.issued < 50 * 60_000) return apnsJwt.value;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID }));
  const claims = b64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const signature = createSign('SHA256').update(`${header}.${claims}`).sign({ key: decode(env.APNS_KEY!), dsaEncoding: 'ieee-p1363' }, 'base64url');
  apnsJwt = { value: `${header}.${claims}.${signature}`, issued: Date.now() };
  return apnsJwt.value;
}

function sendApns(token: string, m: PushMessage): Promise<PushResult> {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return Promise.resolve({ ok: false, error: 'APNs credentials not configured' });
  return new Promise((resolve) => {
    const client = connect(env.APNS_PRODUCTION ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
    client.on('error', (e) => resolve({ ok: false, error: `APNs: ${e.message}` }));
    const req = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${apnsToken()}`, 'apns-topic': env.APNS_BUNDLE_ID, 'apns-push-type': 'alert', 'apns-priority': '10' });
    let status = 0;
    let body = '';
    req.setTimeout(15_000, () => req.close());
    req.on('response', (h) => (status = Number(h[':status'])));
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      client.close();
      if (status === 200) return resolve({ ok: true });
      const reason = (() => { try { return (JSON.parse(body) as { reason?: string }).reason; } catch { return body; } })();
      resolve({ ok: false, invalidToken: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered', error: `APNs ${status}: ${reason ?? ''}` });
    });
    req.end(JSON.stringify({ aps: { alert: { title: m.title, body: m.body }, sound: 'default', ...(m.badge !== undefined ? { badge: m.badge } : {}) }, ...m.data }));
  });
}

/** Real delivery. Not yet run against live Firebase/Apple credentials (needs the client's accounts). */
export const livePush: PushProvider = {
  name: 'live',
  send: (token, platform, m) => (platform === 'ios' ? sendApns(token, m) : platform === 'android' ? sendFcm(token, m) : Promise.resolve({ ok: false, error: 'Web push not supported' })),
};
