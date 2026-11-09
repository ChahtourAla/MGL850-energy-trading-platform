import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],

    testTimeout: 15000,
    hookTimeout: 15000,

    clearMocks: true,
    env: {
      JWT_ACCESS_SECRET: 'B06_ONLY_STATIC_TEST_SECRET_2026_DO_NOT_USE_IN_RUNNING_SERVER',
      WALLET_PROVISIONING_ENABLED: 'false',
    },
  },
});
