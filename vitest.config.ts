import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest configuration.
 *
 * `globals: true` is required because the existing tests under lib/__tests__
 * use bare describe/it/expect without importing a runner. Enabling globals lets
 * those tests run unmodified — their meaning is not changed by this config.
 *
 * Only lib/__tests__ is included. These are pure unit tests over RBAC,
 * correlation, audit, and repository logic; none of them open a database
 * connection or contact an external payment provider.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lib/__tests__/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      // `server-only` throws on import outside a React Server Component, which
      // is exactly its job in the application and useless noise here. Stubbing
      // it lets the admin auth primitives be tested directly while the real
      // package still keeps them out of any client bundle at build time.
      'server-only': fileURLToPath(new URL('./lib/__tests__/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
});
