import { describe, expect, it } from 'vitest';
import { api, bearer, createOrgWithAdmin, createUserAs, roleId, uniqueEmail } from './helpers.js';

describe('Roles & permissions', () => {
  it('seeds the default roles for a new organization', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api().get('/api/v1/roles').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { key: string }) => r.key).sort()).toEqual(
      [
        'application_team',
        'counsellor',
        'management',
        'manager',
        'marketing',
        'org_admin',
        'visa_team',
      ].sort(),
    );
  });

  it('denies endpoints the role lacks permission for', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');

    const res = await api()
      .post('/api/v1/users')
      .set(bearer(counsellor.token))
      .send({ firstName: 'X', email: uniqueEmail(), roleId: await roleId(org._id, 'counsellor') });
    expect(res.status).toBe(403);
    expect((await api().get('/api/v1/roles').set(bearer(counsellor.token))).status).toBe(403);
    expect((await api().get('/api/v1/organizations').set(bearer(token))).status).toBe(403); // platform-only
  });

  it('applies permission changes to a role immediately', async () => {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get('/api/v1/users').set(bearer(counsellor.token))).status).toBe(403);

    const role = await roleId(org._id, 'counsellor');
    const current = await api().get(`/api/v1/roles/${role}`).set(bearer(token));
    await api()
      .patch(`/api/v1/roles/${role}`)
      .set(bearer(token))
      .send({ permissions: [...current.body.data.permissions, 'user.view'] })
      .expect(200);

    const list = await api().get('/api/v1/users').set(bearer(counsellor.token));
    expect(list.status).toBe(200);
    // Counsellor scope is "own": they only see themselves.
    expect(list.body.data.map((u: { id: string }) => u.id)).toEqual([counsellor.id]);
  });

  it('prevents granting permissions the actor does not hold', async () => {
    const { org, token } = await createOrgWithAdmin();
    const roleRes = await api()
      .post('/api/v1/roles')
      .set(bearer(token))
      .send({
        name: 'User Manager',
        dataScope: 'organization',
        permissions: ['user.view', 'user.create', 'role.view', 'role.manage'],
      });
    expect(roleRes.status).toBe(201);
    expect(roleRes.body.data.key).toBe('user_manager');

    const manager = await createUserAs(token, org._id, 'user_manager');

    // Cannot create a role with permissions they lack…
    const escalate = await api()
      .post('/api/v1/roles')
      .set(bearer(manager.token))
      .send({ name: 'Sneaky', dataScope: 'organization', permissions: ['lead.delete'] });
    expect(escalate.status).toBe(403);

    // …nor create a user with a more powerful role.
    const adminUser = await api()
      .post('/api/v1/users')
      .set(bearer(manager.token))
      .send({
        firstName: 'Evil',
        email: uniqueEmail(),
        roleId: await roleId(org._id, 'org_admin'),
        password: 'Passw0rd123',
      });
    expect(adminUser.status).toBe(403);
  });

  it('protects the Organization Admin role and the last admin', async () => {
    const { org, token, admin } = await createOrgWithAdmin();
    const adminRole = await roleId(org._id, 'org_admin');

    const restrict = await api()
      .patch(`/api/v1/roles/${adminRole}`)
      .set(bearer(token))
      .send({ permissions: ['lead.view'] });
    expect(restrict.status).toBe(400);
    expect((await api().delete(`/api/v1/roles/${adminRole}`).set(bearer(token))).status).toBe(400);

    const selfDeactivate = await api()
      .patch(`/api/v1/users/${admin.id}/status`)
      .set(bearer(token))
      .send({ isActive: false });
    expect(selfDeactivate.status).toBe(400);
  });

  it('rejects unknown permissions', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api()
      .post('/api/v1/roles')
      .set(bearer(token))
      .send({ name: 'Bad', dataScope: 'own', permissions: ['platform.manage'] });
    expect(res.status).toBe(422);
  });

  it('deletes a custom role only when no users hold it', async () => {
    const { org, token } = await createOrgWithAdmin();
    const created = await api()
      .post('/api/v1/roles')
      .set(bearer(token))
      .send({ name: 'Temp', dataScope: 'own', permissions: ['lead.view'] });
    const user = await createUserAs(token, org._id, 'temp');
    expect(
      (await api().delete(`/api/v1/roles/${created.body.data._id}`).set(bearer(token))).status,
    ).toBe(409);

    await api()
      .patch(`/api/v1/users/${user.id}`)
      .set(bearer(token))
      .send({ roleId: await roleId(org._id, 'counsellor') })
      .expect(200);
    expect(
      (await api().delete(`/api/v1/roles/${created.body.data._id}`).set(bearer(token))).status,
    ).toBe(200);
  });

  it('exposes the permission catalog', async () => {
    const { token } = await createOrgWithAdmin();
    const res = await api().get('/api/v1/permissions').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.dataScopes).toEqual(['organization', 'branch', 'own']);
    expect(
      res.body.data.modules.find((m: { module: string }) => m.module === 'lead').permissions.length,
    ).toBeGreaterThan(5);
  });
});

describe('Users & branches', () => {
  it('creates a user with an invite email when no password is given', async () => {
    const { org, token } = await createOrgWithAdmin();
    const email = uniqueEmail('invitee');
    const res = await api()
      .post('/api/v1/users')
      .set(bearer(token))
      .send({
        firstName: 'Riya',
        lastName: 'Sharma',
        email,
        phone: '98765 43210',
        roleId: await roleId(org._id, 'counsellor'),
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fullName: 'Riya Sharma',
      phone: '+919876543210',
      role: { key: 'counsellor' },
    });
    const { sentEmails } = await import('./helpers.js');
    expect(sentEmails().some((m) => m.to === email && /invite=1/.test(m.text))).toBe(true);
  });

  it('rejects duplicate emails across organizations', async () => {
    const a = await createOrgWithAdmin('Org A');
    const b = await createOrgWithAdmin('Org B');
    const res = await api()
      .post('/api/v1/users')
      .set(bearer(b.token))
      .send({
        firstName: 'Dup',
        email: a.adminEmail,
        roleId: await roleId(b.org._id, 'counsellor'),
        password: 'Passw0rd123',
      });
    expect(res.status).toBe(409);
  });

  it('restricts branch-scoped managers to users and branches in their branches', async () => {
    const { org, token } = await createOrgWithAdmin();
    const delhi = await api()
      .post('/api/v1/branches')
      .set(bearer(token))
      .send({ name: 'Delhi', code: 'del' });
    const mumbai = await api()
      .post('/api/v1/branches')
      .set(bearer(token))
      .send({ name: 'Mumbai', code: 'BOM' });
    expect(delhi.status).toBe(201);
    expect(delhi.body.data.code).toBe('DEL');

    const manager = await createUserAs(token, org._id, 'manager', {
      branchIds: [delhi.body.data._id],
    });
    const delhiCounsellor = await createUserAs(token, org._id, 'counsellor', {
      branchIds: [delhi.body.data._id],
    });
    const mumbaiCounsellor = await createUserAs(token, org._id, 'counsellor', {
      branchIds: [mumbai.body.data._id],
    });

    const users = await api().get('/api/v1/users').set(bearer(manager.token));
    const ids = users.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(delhiCounsellor.id);
    expect(ids).not.toContain(mumbaiCounsellor.id);
    expect(
      (await api().get(`/api/v1/users/${mumbaiCounsellor.id}`).set(bearer(manager.token))).status,
    ).toBe(404);

    const branches = await api().get('/api/v1/branches').set(bearer(manager.token));
    expect(branches.body.data.map((b: { code: string }) => b.code)).toEqual(['DEL']);
  });

  it('paginates and searches users', async () => {
    const { org, token } = await createOrgWithAdmin();
    for (let i = 0; i < 3; i++) await createUserAs(token, org._id, 'counsellor');
    const page = await api()
      .get('/api/v1/users?limit=2&page=1&sortBy=createdAt')
      .set(bearer(token));
    expect(page.body.pagination).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });

    const search = await api().get('/api/v1/users?search=Org%20Adm').set(bearer(token));
    expect(search.body.data).toHaveLength(1);

    const badSort = await api().get('/api/v1/users?sortBy=passwordHash').set(bearer(token));
    expect(badSort.status).toBe(422);
  });

  it('records audit history for user changes', async () => {
    const { org, token } = await createOrgWithAdmin();
    const user = await createUserAs(token, org._id, 'counsellor');
    await api()
      .patch(`/api/v1/users/${user.id}`)
      .set(bearer(token))
      .send({ designation: 'Senior Counsellor' })
      .expect(200);

    const logs = await api()
      .get(`/api/v1/audit-logs?entityType=user&entityId=${user.id}`)
      .set(bearer(token));
    const update = logs.body.data.find((l: { action: string }) => l.action === 'user.updated');
    expect(update).toMatchObject({
      oldValue: { designation: null },
      newValue: { designation: 'Senior Counsellor' },
    });
    expect(update.userId.fullName).toBe('Org Admin');
  });
});
