import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('./docker/Dockerfile', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('node adapter image', () => {
  it('carries the manifests tsx and pnpm need inside the image', () => {
    // pnpm-workspace.yaml 帶 allowBuilds（esbuild），tsconfig.json 帶 @open4wd/* 別名；缺任一
    // 都是「建得出來／建不出來但起不來」的歷史缺陷，這裡釘住。
    expect(dockerfile).toMatch(/^COPY package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.\/$/mu);
    expect(dockerfile).toMatch(/^COPY tsconfig\.json \.\/$/mu);
  });

  it('starts the same entry as `pnpm start` without going through pnpm or corepack', () => {
    // start script 形如 `tsx <entry>`；CMD 必須直接以 node 執行 tsx 的 cli 並指向同一入口，否則
    // USER 切換後 corepack 會在每次啟動時重新下載 pnpm（需要網路與可寫的 HOME）。
    const start = packageJson.scripts['start'] ?? '';
    const entry = start.replace(/^tsx\s+/u, '');
    expect(entry).not.toBe('');
    const cmd = dockerfile.match(/^CMD (\[.*\])$/mu)?.[1] ?? '[]';
    const argv = JSON.parse(cmd) as string[];
    expect(argv.slice(0, 3)).toEqual(['node', 'node_modules/tsx/dist/cli.mjs', entry]);
    expect(argv.some((part) => /pnpm|corepack/u.test(part))).toBe(false);
  });
});
