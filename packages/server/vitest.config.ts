import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    testTimeout: 30000,
    // Allow mocking of @decigraph/core modules
    deps: {
      inline: ['@decigraph/core'],
    },
  },
});
