import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function localMarkdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1]!.trim().replace(/^<|>$/gu, ''))
    .filter((target) => target !== '' && !/^(?:https?:|mailto:|#)/u.test(target))
    .map((target) => decodeURIComponent(target.split('#')[0]!));
}

test('README relative Markdown links point at existing repository paths', async () => {
  const readmePath = resolve(ROOT, 'README.md');
  const targets = localMarkdownTargets(await readFile(readmePath, 'utf8'));
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    const destination = resolve(dirname(readmePath), target);
    expect(existsSync(destination), target).toBe(true);
    expect(statSync(destination).isFile() || statSync(destination).isDirectory(), target).toBe(
      true,
    );
  }
});

test('public signaling guidance only describes deployment from the operator fork', async () => {
  const guidance = await Promise.all(
    ['adapters/worker/env.ts', 'deploy/cloudflare/README.md'].map((path) =>
      readFile(resolve(ROOT, path), 'utf8'),
    ),
  );
  const text = guidance.join('\n');
  expect(text).not.toMatch(/private deploy repo|deployment repository|部署 repo/iu);
  expect(text).toMatch(/operator fork|營運者 fork/iu);
});
