import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@open4wd/interfaces': source('./core/protocol/shim/interfaces.ts'),
      '@open4wd/system-constants': source('./core/protocol/shim/system-constants.ts'),
    },
  },
  test: {
    // e2e/*.e2e.spec.ts 打真伺服器，屬 vitest.e2e.config.ts（pnpm e2e）專管，不進本套件
    exclude: [
      ...configDefaults.exclude,
      '**/*.e2e.spec.ts',
      'scripts/comment-hook-runner.test.mjs',
      'scripts/eslint-comment-quality.test.mjs',
      'scripts/issue-maintenance.test.mjs',
      'scripts/prepare-graphify-release.test.mjs',
      'scripts/run-graphify-release.test.mjs',
    ],
  },
});
