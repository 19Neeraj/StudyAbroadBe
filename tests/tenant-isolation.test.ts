import { describe, expect, it } from 'vitest';
import { BranchModel } from '../src/modules/branches/branch.model.js';
import { TenantGuardError } from '../src/database/plugins/tenant.plugin.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { api, bearer, createOrgWithAdmin, createUserAs, roleId } from './helpers.js';

describe('Organization isolation', () => {
  it('never returns another organization’s records', async () => {
    const a = await createOrgWithAdmin('Alpha');
    const b = await createOrgWithAdmin('Beta');
    const bUser = await createUserAs(b.token, b.org._id, 'counsellor');
    const bBranch = await api()
      .post('/api/v1/branches')
      .set(bearer(b.token))
      .send({ name: 'Pune', code: 'PNQ' });
    const bRole = await roleId(b.org._id, 'counsellor');

    expect((await api().get(`/api/v1/users/${bUser.id}`).set(bearer(a.token))).status).toBe(404);
    expect(
      (
        await api()
          .patch(`/api/v1/users/${bUser.id}`)
          .set(bearer(a.token))
          .send({ firstName: 'Hacked' })
      ).status,
    ).toBe(404);
    expect(
      (
        await api()
          .patch(`/api/v1/users/${bUser.id}/status`)
          .set(bearer(a.token))
          .send({ isActive: false })
      ).status,
    ).toBe(404);
    expect(
      (await api().get(`/api/v1/branches/${bBranch.body.data._id}`).set(bearer(a.token))).status,
    ).toBe(404);
    expect((await api().get(`/api/v1/roles/${bRole}`).set(bearer(a.token))).status).toBe(404);

    const users = await api().get('/api/v1/users?limit=100').set(bearer(a.token));
    expect(users.body.data.map((u: { id: string }) => u.id)).not.toContain(bUser.id);
  });

  it('cannot assign another organization’s role or branch', async () => {
    const a = await createOrgWithAdmin('Alpha');
    const b = await createOrgWithAdmin('Beta');
    const bBranch = await api()
      .post('/api/v1/branches')
      .set(bearer(b.token))
      .send({ name: 'Pune', code: 'PNQ' });

    const foreignRole = await api()
      .post('/api/v1/users')
      .set(bearer(a.token))
      .send({
        firstName: 'X',
        email: 'x1@test.local',
        roleId: await roleId(b.org._id, 'counsellor'),
        password: 'Passw0rd123',
      });
    expect(foreignRole.status).toBe(422);

    const foreignBranch = await api()
      .post('/api/v1/users')
      .set(bearer(a.token))
      .send({
        firstName: 'X',
        email: 'x2@test.local',
        roleId: await roleId(a.org._id, 'counsellor'),
        branchIds: [bBranch.body.data._id],
        password: 'Passw0rd123',
      });
    expect(foreignBranch.status).toBe(422);
  });

  it('ignores organizationId supplied by the client', async () => {
    const a = await createOrgWithAdmin('Alpha');
    const b = await createOrgWithAdmin('Beta');
    const res = await api()
      .post('/api/v1/branches')
      .set(bearer(a.token))
      .send({ name: 'Injected', code: 'INJ', organizationId: b.org._id });
    expect(res.status).toBe(201);
    const stored = await BranchModel.findOne({ organizationId: a.org._id, code: 'INJ' }).lean();
    expect(stored?.organizationId.toString()).toBe(a.org._id.toString());
  });

  it('strips MongoDB operators from input', async () => {
    const a = await createOrgWithAdmin('Alpha');
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(422);
    const q = await api().get('/api/v1/users?isActive[$ne]=true').set(bearer(a.token));
    expect(q.status).toBe(200);
  });

  it('tenant guard rejects unscoped queries on tenant collections', async () => {
    await expect(UserModel.find({ email: 'x@test.local' })).rejects.toBeInstanceOf(
      TenantGuardError,
    );
    await expect(UserModel.countDocuments({})).rejects.toBeInstanceOf(TenantGuardError);
    await expect(UserModel.updateMany({}, { isActive: false })).rejects.toBeInstanceOf(
      TenantGuardError,
    );
    await expect(UserModel.aggregate([{ $match: {} }])).rejects.toBeInstanceOf(TenantGuardError);
    await expect(UserModel.find({}).setOptions({ skipTenantGuard: true })).resolves.toBeInstanceOf(
      Array,
    );
  });

  it('suspending an organization blocks its users immediately', async () => {
    const { ensurePlatformSuperAdmin } =
      await import('../src/modules/organizations/organization.service.js');
    const { login } = await import('./helpers.js');
    await ensurePlatformSuperAdmin('root@platform.local', 'R00tPassword!');
    const sa = await login('root@platform.local', 'R00tPassword!');
    const a = await createOrgWithAdmin('Alpha');

    const list = await api().get('/api/v1/organizations').set(bearer(sa.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.data.map((o: { slug: string }) => o.slug)).not.toContain('platform');

    await api()
      .patch(`/api/v1/organizations/${a.org._id}/status`)
      .set(bearer(sa.accessToken))
      .send({ isActive: false })
      .expect(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(a.token))).status).toBe(401);
  });
});
