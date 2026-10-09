import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { emailProvider } from '../src/integrations/email/index.js';
import type { MemoryEmailProvider } from '../src/integrations/email/providers.js';
import { provisionOrganization } from '../src/modules/organizations/organization.service.js';
import { RoleModel } from '../src/modules/roles/role.model.js';
import type { Types } from 'mongoose';

export const app = createApp();
export const api = () => supertest(app);

export const sentEmails = () => (emailProvider as MemoryEmailProvider).sent;

export const PASSWORD = 'Passw0rd123';

let seq = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${++seq}@test.local`;

export async function login(
  email: string,
  password = PASSWORD,
  platform: 'web' | 'android' = 'android',
) {
  const res = await api().post('/api/v1/auth/login').send({ email, password, platform });
  if (res.status !== 200)
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; organization: { id: string } };
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function createOrgWithAdmin(name = 'Test Org') {
  const adminEmail = uniqueEmail('admin');
  const { organization, admin } = await provisionOrganization(
    { name, admin: { firstName: 'Org', lastName: 'Admin', email: adminEmail, password: PASSWORD } },
    { meta: {} },
  );
  const tokens = await login(adminEmail);
  return { org: organization, admin, adminEmail, token: tokens.accessToken };
}

export async function roleId(
  organizationId: string | Types.ObjectId,
  key: string,
): Promise<string> {
  const role = await RoleModel.findOne({ organizationId, key }).lean();
  if (!role) throw new Error(`Role ${key} not found`);
  return role._id.toString();
}

/** Creates a user with the given role via the API (as the org admin) and signs them in. */
export async function createUserAs(
  adminToken: string,
  organizationId: string | Types.ObjectId,
  roleKey: string,
  extra: { branchIds?: string[] } = {},
) {
  const email = uniqueEmail(roleKey);
  const res = await api()
    .post('/api/v1/users')
    .set(bearer(adminToken))
    .send({
      firstName: roleKey,
      email,
      roleId: await roleId(organizationId, roleKey),
      password: PASSWORD,
      ...extra,
    });
  if (res.status !== 201)
    throw new Error(`Create user failed: ${res.status} ${JSON.stringify(res.body)}`);
  const tokens = await login(email);
  return { id: res.body.data.id as string, email, token: tokens.accessToken };
}

export async function createBranch(token: string, name: string, code: string): Promise<string> {
  const res = await api().post('/api/v1/branches').set(bearer(token)).send({ name, code });
  if (res.status !== 201) throw new Error(`Create branch failed: ${JSON.stringify(res.body)}`);
  return res.body.data._id as string;
}

export async function createLead(token: string, body: Record<string, unknown>) {
  return api().post('/api/v1/leads').set(bearer(token)).send({ firstName: 'Test', ...body });
}
