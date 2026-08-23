// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import commentQualityRule from './scripts/eslint-comment-quality.mjs';

// core/protocol/vendor/** 為逐字同步的 Open4WD 原始碼，scripts/vendor/** 為逐字打包的
// 第三方 browser 資產；兩者皆禁止手改，故排除在本 repo 的 lint 規則之外。
export default tseslint.config(
  {
    ignores: ['core/protocol/vendor/**', 'e2e/vendor/ws-provider.ts', 'scripts/vendor/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.stylistic,
  prettier,
  {
    files: ['adapters/**/*.ts', 'core/**/*.ts'],
    ignores: [
      '**/*.spec.ts',
      '**/*.d.ts',
      '**/vendor/**',
      '**/generated/**',
      '**/*test-support.ts',
      '**/*.test-support.ts',
    ],
    plugins: { open4wd: { rules: { 'comment-quality': commentQualityRule } } },
    rules: { 'open4wd/comment-quality': 'error' },
  },
);
