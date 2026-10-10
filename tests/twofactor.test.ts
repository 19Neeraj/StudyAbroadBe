import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { ensurePlatformSuperAdmin } from '../src/modules/organizations/organization.service.js';
import { invalidatePlatformPolicy } from '../src/modules/security/policy.js';
import { PlatformSettingModel } from '../src/modules/security/platformSetting.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { AuditLogModel } from '../src/modules/audit/audit.model.js';
import { OrganizationModel } from '../src/modules/organizations/organization.model.js';
import { api, bearer, createOrgWithAdmin, createUserAs, login, PASSWORD, uniqueEmail } from './helpers.js';

const secretOf = (manualKey: string) => manualKey.replace(/\s+/g, '');
/** A valid code for a time step after the given one (codes can't be reused). */
const codeAt = (secret: string, offsetSteps = 0) => generate({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSteps * 30 });

async function enroll(token: string, password = PASSWORD) {
  const setup = await api().post('/api/v1/auth/2fa/setup').set(bearer(token)).send({ password });
  expect(setup.status).toBe(200);
  expect(setup.body.data.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  const secret = secretOf(setup.body.data.manualKey);
  const done = await api().post('/api/v1/auth/2fa/verify-setup').set(bearer(token)).send({ code: await codeAt(secret) });
  expect(done.status).toBe(200);
  expect(done.body.data.recoveryCodes).toHaveLength(10);
  return { secret, recoveryCodes: done.body.data.recoveryCodes as string[] };
}

const signIn = (email: string, platform: 'web' | 'android' = 'android') => api().post('/api/v1/auth/login').send({ email, password: PASSWORD, platform });

async function setPlatform(policy: Record<string, unknown>) {
  await PlatformSettingModel.updateOne({ _id: 'security' }, { $set: Object.fromEntries(Object.entries(policy).map(([k, v]) => [`twoFactor.${k}`, v])) }, { upsert: true });
  invalidatePlatformPolicy();
}

describe('Two-factor authentication (TOTP)', () => {
  it('is optional by default: users without 2FA sign in normally', async () => {
    const { adminEmail } = await createOrgWithAdmin();
    const res = await signIn(adminEmail);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('authenticated');
    expect(res.body.data.user.twoFactor).toEqual({ enabled: false, required: false, enrollmentRequiredBy: null, enrollmentOverdue: false });
  });

  it('enrolls, then requires a code at sign-in; challenges cannot call the API; codes and challenges are single use', async () => {
    const { adminEmail, token } = await createOrgWithAdmin();
    // Setup requires recent re-authentication.
    expect((await api().post('/api/v1/auth/2fa/setup').set(bearer(token)).send({})).status).toBe(422);
    expect((await api().post('/api/v1/auth/2fa/setup').set(bearer(token)).send({ password: 'wrong-pass1' })).status).toBe(422);
    const { secret, recoveryCodes } = await enroll(token);

    // Secrets never leave the server.
    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(JSON.stringify(me.body)).not.toContain(secret);
    expect(me.body.data.twoFactor.enabled).toBe(true);
    const sec = await api().get('/api/v1/auth/security').set(bearer(token));
    expect(sec.body.data.twoFactor).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    expect(JSON.stringify(sec.body)).not.toContain(secret);
    const stored = await UserModel.findOne({ email: adminEmail }).setOptions({ skipTenantGuard: true }).select('+twoFactor.secretEnc +twoFactor.recoveryCodes').lean();
    expect(stored!.twoFactor!.secretEnc).not.toContain(secret);
    expect(JSON.stringify(stored!.twoFactor!.recoveryCodes)).not.toContain(recoveryCodes[0]!.replace('-', ''));

    const first = await signIn(adminEmail);
    expect(first.body.data).toMatchObject({ status: 'two_factor_required', methods: ['totp', 'recovery_code'] });
    expect(first.body.data.accessToken).toBeUndefined();
    const challenge = first.body.data.challengeToken as string;
    // A pending challenge is not an access token.
    expect((await api().get('/api/v1/leads').set(bearer(challenge))).status).toBe(401);

    // Wrong code, then the right one.
    const wrong = await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: challenge, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('TWO_FACTOR_CODE_INVALID');
    const code = await codeAt(secret, 1);
    const ok = await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: challenge, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'authenticated' });
    expect(ok.body.data.refreshToken).toBeTruthy();
    expect((await api().get('/api/v1/leads').set(bearer(ok.body.data.accessToken))).status).toBe(200);

    // The challenge is used up, and the same code can't be replayed on a new challenge.
    expect((await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: challenge, code })).body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    const second = (await signIn(adminEmail)).body.data.challengeToken;
    expect((await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: second, code })).status).toBe(401);

    // Recovery codes work once.
    const rc = recoveryCodes[0]!;
    const viaRecovery = await api().post('/api/v1/auth/2fa/verify-recovery-code').send({ challengeToken: second, recoveryCode: rc.toLowerCase() });
    expect(viaRecovery.status).toBe(200);
    const third = (await signIn(adminEmail)).body.data.challengeToken;
    expect((await api().post('/api/v1/auth/2fa/verify-recovery-code').send({ challengeToken: third, recoveryCode: rc })).status).toBe(401);
    const left = await api().get('/api/v1/auth/security').set(bearer(viaRecovery.body.data.accessToken));
    expect(left.body.data.twoFactor.recoveryCodesRemaining).toBe(9);
  });

  it('locks a challenge after five wrong codes and expires it', async () => {
    const { adminEmail, token } = await createOrgWithAdmin();
    const { secret } = await enroll(token);
    const challenge = (await signIn(adminEmail)).body.data.challengeToken;
    for (let i = 0; i < 5; i++) await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: challenge, code: '111111' });
    const after = await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: challenge, code: await codeAt(secret, 1) });
    expect(after.body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
  });

  it('enforces mandatory 2FA: grace period, then enrollment before any CRM access (also for existing sessions)', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    // The organization requires 2FA (platform allows overrides) with no grace period.
    await setPlatform({ gracePeriodDays: 0 });
    const updated = await api().patch('/api/v1/security/organization-policy').set(bearer(token)).send({ twoFactorMode: 'mandatory' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.effective).toMatchObject({ mode: 'mandatory', source: 'organization', canDisable: false });

    // An existing session stops working for CRM routes, but can still enroll.
    const blocked = await api().get('/api/v1/leads').set(bearer(counsellor.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
    expect((await api().get('/api/v1/auth/me').set(bearer(counsellor.token))).body.data.twoFactor.enrollmentOverdue).toBe(true);

    // Fresh sign-in: enrollment challenge, setup through it, and tokens only after the first code.
    const res = await signIn(counsellor.email);
    expect(res.body.data.status).toBe('two_factor_enrollment_required');
    const challengeToken = res.body.data.challengeToken;
    const setup = await api().post('/api/v1/auth/2fa/setup').send({ challengeToken });
    expect(setup.status).toBe(200);
    const secret = secretOf(setup.body.data.manualKey);
    const done = await api().post('/api/v1/auth/2fa/verify-setup').send({ challengeToken, code: await codeAt(secret) });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'authenticated' });
    expect(done.body.data.recoveryCodes).toHaveLength(10);
    expect((await api().get('/api/v1/leads').set(bearer(done.body.data.accessToken))).status).toBe(200);

    // Mandatory: it can't be turned off.
    const off = await api().post('/api/v1/auth/2fa/disable').set(bearer(done.body.data.accessToken)).send({ password: PASSWORD, code: await codeAt(secret, 1) });
    expect(off.status).toBe(403);

    await setPlatform({ gracePeriodDays: 7 });
  });

  it('lets platform policy win over organizations, and audits Super Admin changes and resets', async () => {
    const saEmail = uniqueEmail('sa');
    await ensurePlatformSuperAdmin(saEmail, 'SuperAdmin123');
    const sa = await login(saEmail, 'SuperAdmin123');
    // Super Admins are users too: once 2FA is mandatory they must have enrolled to keep working.
    await enroll(sa.accessToken, 'SuperAdmin123');
    const { org, token, adminEmail } = await createOrgWithAdmin();

    expect((await api().get('/api/v1/super-admin/security/2fa-policy').set(bearer(token))).status).toBe(403);
    const policy = await api().patch('/api/v1/super-admin/security/2fa-policy').set(bearer(sa.accessToken)).send({ allowOrganizationOverride: false });
    expect(policy.status).toBe(200);
    // Organizations can no longer change their mode.
    expect((await api().patch('/api/v1/security/organization-policy').set(bearer(token)).send({ twoFactorMode: 'mandatory' })).status).toBe(403);
    expect(await AuditLogModel.countDocuments({ action: 'security.2fa_policy_updated' }).setOptions({ skipTenantGuard: true })).toBeGreaterThan(0);

    // Enrolled user loses their phone → authorized reset signs them out and removes the secret.
    const { secret } = await enroll(token);
    const admin = await UserModel.findOne({ email: adminEmail }).setOptions({ skipTenantGuard: true }).lean();
    const users = await api().get(`/api/v1/super-admin/security/2fa-users?organizationId=${org._id}&status=enabled`).set(bearer(sa.accessToken));
    expect(users.body.data.map((u: { email: string }) => u.email)).toContain(adminEmail);
    expect(JSON.stringify(users.body)).not.toContain(secret);
    const reset = await api().post(`/api/v1/super-admin/security/2fa-users/${admin!._id}/reset`).set(bearer(sa.accessToken)).send({ reason: 'Lost phone, identity verified by call' });
    expect(reset.status).toBe(200);
    expect((await api().get('/api/v1/leads').set(bearer(token))).status).toBe(401);
    expect((await signIn(adminEmail)).body.data.status).toBe('authenticated');
    expect(await AuditLogModel.countDocuments({ organizationId: org._id, action: 'security.2fa_reset' })).toBe(1);

    // Platform mandatory beats an organization "optional", and a policy change keeps enrolled secrets.
    const other = await createOrgWithAdmin();
    const kept = await enroll(other.token);
    await api().patch('/api/v1/super-admin/security/2fa-policy').set(bearer(sa.accessToken)).send({ allowOrganizationOverride: true, mode: 'mandatory', gracePeriodDays: 0 });
    await OrganizationModel.updateOne({ _id: org._id }, { 'security.twoFactorMode': 'optional' });
    expect((await signIn(adminEmail)).body.data.status).toBe('two_factor_enrollment_required');
    await api().patch('/api/v1/super-admin/security/2fa-policy').set(bearer(sa.accessToken)).send({ enabled: false });
    // Platform off: nobody is forced, but an enrolled user still verifies with the kept secret.
    expect((await signIn(adminEmail)).body.data.status).toBe('authenticated');
    const ch = (await signIn(other.adminEmail)).body.data;
    expect(ch.status).toBe('two_factor_required');
    expect((await api().post('/api/v1/auth/2fa/verify-login').send({ challengeToken: ch.challengeToken, code: await codeAt(kept.secret, 1) })).status).toBe(200);
    await api().patch('/api/v1/super-admin/security/2fa-policy').set(bearer(sa.accessToken)).send({ enabled: true, mode: 'optional', gracePeriodDays: 7 });
  });

  it('regenerates recovery codes and disables 2FA only with password and a current code', async () => {
    const { token } = await createOrgWithAdmin();
    const { secret, recoveryCodes } = await enroll(token);
    expect((await api().post('/api/v1/auth/2fa/recovery-codes/regenerate').set(bearer(token)).send({ password: PASSWORD, code: '123456' })).status).toBe(422);
    const regen = await api().post('/api/v1/auth/2fa/recovery-codes/regenerate').set(bearer(token)).send({ password: PASSWORD, code: await codeAt(secret, 1) });
    expect(regen.status).toBe(200);
    expect(regen.body.data.recoveryCodes).not.toContain(recoveryCodes[0]);
    expect((await api().post('/api/v1/auth/2fa/disable').set(bearer(token)).send({ password: 'nope-nope1', code: await codeAt(secret) })).status).toBe(422);
    // Let the current step be usable again (the test can't wait 30 seconds for the next code).
    await UserModel.updateMany({ 'twoFactor.enabled': true }, { $unset: { 'twoFactor.lastUsedStep': 1 } }).setOptions({ skipTenantGuard: true });
    const off = await api().post('/api/v1/auth/2fa/disable').set(bearer(token)).send({ password: PASSWORD, code: await codeAt(secret) });
    expect(off.status).toBe(200);
    expect((await api().get('/api/v1/auth/security').set(bearer(token))).body.data.twoFactor.enabled).toBe(false);
  });
});
