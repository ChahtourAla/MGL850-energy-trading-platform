import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],

    testTimeout: 15000,
    hookTimeout: 15000,

    clearMocks: true,
  },
});
