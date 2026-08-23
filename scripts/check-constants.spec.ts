import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  compareSignalingConstants,
  parseSignalingConstants,
  runConstantsCheck,
  SIGNALING_CONSTANT_NAMES,
  type SignalingConstantValues,
} from './check-constants';

const TABLE = `
## 8. network/sync

| 名稱 | 值 | 說明 |
|---|---:|---|
| \`RATE_LIMIT_PER_MIN\` | 999 | 不屬 signaling section |

## 9. network/signaling

| 名稱 | 值 | 說明 |
|---|---:|---|
| \`RATE_LIMIT_PER_MIN\` | 60 | connection limit |
| \`PEER_TIMEOUT_MS\` | 90_000 | liveness |
| \`REGISTER_DEADLINE_MS\` | 10_000 | registration |
| \`MESSAGE_RATE_LIMIT_PER_MIN\` | 1,200 | message limit |
| \`TURN_TOKEN_TTL_SEC\` | 300 | credential lifetime |
| \`MAX_PEERS\` | 64 | 不屬 owner-scoped 比對項 |

## 10. network/other

| 名稱 | 值 | 說明 |
|---|---:|---|
| \`PEER_TIMEOUT_MS\` | 1 | 不屬 signaling section |
`;

const IMPLEMENTED: SignalingConstantValues = {
  RATE_LIMIT_PER_MIN: 60,
  PEER_TIMEOUT_MS: 90_000,
  REGISTER_DEADLINE_MS: 10_000,
  MESSAGE_RATE_LIMIT_PER_MIN: 1_200,
  TURN_TOKEN_TTL_SEC: 300,
};

function readParameterFixture(markdown: string) {
  return (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    if (normalized.endsWith('scripts/parameter-authorities.json')) {
      return JSON.stringify({ program: ['程式參數/network.md'], modeling: [] });
    }
    if (normalized.endsWith('程式參數/network.md')) return markdown;
    throw Object.assign(new Error(`unexpected path: ${path}`), { code: 'ENOENT' });
  };
}

describe('signaling constants contract', () => {
  it('keeps the operator README aligned with the current manifest-backed authority and governed set', () => {
    const readme = readFileSync(resolve(import.meta.dirname, '..', 'README.md'), 'utf8');

    expect(readme).toContain('parameter-authorities.json');
    expect(readme).toContain('程式參數/network.md');
    expect(readme).toContain(`${SIGNALING_CONSTANT_NAMES.length} 項`);
    expect(readme).not.toContain('程式參數表.md');
    for (const required of [
      '開發中',
      '主遊戲尚未正式公開',
      '[MIT](LICENSE)',
      'https://github.com/xjustloveux/open-4wd/security/policy',
    ]) {
      expect(readme).toContain(required);
    }
  });

  it('parses only the five governed §9 integer rows and normalizes separators', () => {
    expect(parseSignalingConstants(TABLE)).toEqual(IMPLEMENTED);
  });

  it('reports no drift when Specs and runtime defaults match', () => {
    expect(compareSignalingConstants(parseSignalingConstants(TABLE), IMPLEMENTED)).toEqual([]);
  });

  it('reports the named documented and implemented values when one constant drifts', () => {
    expect(
      compareSignalingConstants(parseSignalingConstants(TABLE), {
        ...IMPLEMENTED,
        PEER_TIMEOUT_MS: 89_999,
      }),
    ).toEqual([
      {
        kind: 'mismatch',
        name: 'PEER_TIMEOUT_MS',
        documented: 90_000,
        implemented: 89_999,
      },
    ]);
  });

  it('reports a missing governed row as an incomplete document contract', () => {
    const documented = parseSignalingConstants(
      TABLE.replace('| `REGISTER_DEADLINE_MS` | 10_000 | registration |\n', ''),
    );

    expect(compareSignalingConstants(documented, IMPLEMENTED)).toContainEqual({
      kind: 'missing-documentation',
      name: 'REGISTER_DEADLINE_MS',
      documented: undefined,
      implemented: 10_000,
    });
  });
});

describe('signaling constants CLI boundary', () => {
  it('loads signaling values from the program authority leaves selected by the manifest', () => {
    const requested: string[] = [];
    const log = vi.fn();

    const exitCode = runConstantsCheck({
      specsDir: 'fixture-specs',
      readFile: (path) => {
        requested.push(path.replaceAll('\\', '/'));
        return readParameterFixture(TABLE)(path);
      },
      log,
      error: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(requested).toEqual([
      expect.stringMatching(/scripts\/parameter-authorities\.json$/u),
      expect.stringMatching(/程式參數\/network\.md$/u),
    ]);
    expect(log.mock.calls.flat().join('\n')).toContain('authority 1 檔');
  });

  it('fails closed when the Specs table cannot be read', () => {
    const error = vi.fn();

    const exitCode = runConstantsCheck({
      specsDir: 'missing-specs',
      readFile: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      log: vi.fn(),
      error,
    });

    expect(exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('parameter-authorities.json');
  });

  it('returns success and reports all five governed values when they match', () => {
    const log = vi.fn();

    const exitCode = runConstantsCheck({
      specsDir: 'fixture-specs',
      readFile: readParameterFixture(TABLE),
      log,
      error: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('5/5');
  });

  it('returns failure with both values and the constant name when drift exists', () => {
    const error = vi.fn();

    const exitCode = runConstantsCheck({
      specsDir: 'fixture-specs',
      readFile: readParameterFixture(TABLE.replace('90_000', '89_999')),
      log: vi.fn(),
      error,
    });

    expect(exitCode).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain(
      'PEER_TIMEOUT_MS｜specs=89999｜signaling=90000',
    );
  });
});
