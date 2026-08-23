import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIGNALING_SMOKE_SCOPE, signalingSmokeUrl } from './smoke-lib';

describe('signaling deployment smoke contract', () => {
  it('uses the canonical scoped-v1 room instead of a global lobby', () => {
    expect(SIGNALING_SMOKE_SCOPE).toBe('room:123e4567-e89b-42d3-a456-426614174000');
    expect(signalingSmokeUrl('wss://signal.example.org')).toBe(
      `wss://signal.example.org/ws?room=${encodeURIComponent(SIGNALING_SMOKE_SCOPE)}`,
    );
  });

  it('rejects lobby and malformed base URLs before opening a socket', () => {
    expect(() => signalingSmokeUrl('wss://signal.example.org', 'lobby')).toThrow(
      'canonical signaling scope',
    );
    for (const base of [
      'https://signal.example.org',
      'wss://user:pass@signal.example.org',
      'wss://signal.example.org/path',
      'wss://signal.example.org?token=x',
    ])
      expect(() => signalingSmokeUrl(base)).toThrow('signaling base URL');
  });

  it('keeps public deployment templates independent of a maintainer deployment', () => {
    const text = [
      'README.md',
      'deploy/cloudflare/README.md',
      'deploy/cloudflare/wrangler.jsonc',
      'deploy/docker/docker-compose.yml',
      'deploy/docker/docker-compose.all-in-one.yml',
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
      .toLowerCase();

    for (const forbidden of [
      'official deployment',
      'official signaling',
      'private deploy repo',
      'deployment repository',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // 具名值不寫進公版：維護者 deploy repo（<公版名>-deploy 慣例）與 signal.<網域> 主機名
    // 一律以樣式斷言，避免守門測試本身把要排除的名稱帶進公開 repo。
    expect(text).not.toMatch(/-deploy\b/u);
    expect(text).not.toMatch(/\bsignal\.[a-z0-9-]+\.[a-z]{2,}\b/u);
  });
});
