import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Each test file gets its own database; files run in parallel workers.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
