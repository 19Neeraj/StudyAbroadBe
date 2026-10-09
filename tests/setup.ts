import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';

// Must be set before any src module loads config/env.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.EMAIL_PROVIDER = 'memory';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-at-least-32-chars';
process.env.JOBS_DRIVER = 'inline';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = `${process.env.TMPDIR ?? '/tmp'}/crm-test-storage`;

beforeAll(async () => {
  const { registerJobs } = await import('../src/jobs/index.js');
  registerJobs();
  // Each test file gets an isolated database so files can run in parallel.
  const base = inject('mongoUri');
  await mongoose.connect(base, { dbName: `crm_test_${randomUUID().slice(0, 8)}` });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
