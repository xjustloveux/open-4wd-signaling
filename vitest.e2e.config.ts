import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@open4wd/interfaces': source('./core/protocol/shim/interfaces.ts'),
      '@open4wd/system-constants': source('./core/protocol/shim/system-constants.ts'),
    },
  },
  test: {
    include: ['e2e/**/*.e2e.spec.ts', 'deploy/**/*.e2e.spec.ts'],
    testTimeout: 20_000,
    environment: 'node',
  },
});
