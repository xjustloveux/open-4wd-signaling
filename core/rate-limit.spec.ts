import { describe, expect, it } from 'vitest';
import { checkRate } from './rate-limit';
import { RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_MS } from './constants';

const NOW = 1_700_000_000_000;

describe('checkRate', () => {
  it('首次呼叫開新窗並放行', () => {
    const result = checkRate(undefined, NOW);
    expect(result.allowed).toBe(true);
    expect(result.window).toEqual({ count: 1, windowStart: NOW });
  });

  it('窗內達上限前放行、超過即拒', () => {
    let window = checkRate(undefined, NOW).window;
    for (let index = 1; index < RATE_LIMIT_PER_MIN; index++) {
      const result = checkRate(window, NOW);
      expect(result.allowed).toBe(true);
      window = result.window;
    }
    expect(window.count).toBe(RATE_LIMIT_PER_MIN);
    expect(checkRate(window, NOW).allowed).toBe(false);
  });

  it('窗過期後重置計數', () => {
    const window = { count: RATE_LIMIT_PER_MIN, windowStart: NOW };
    const result = checkRate(window, NOW + RATE_LIMIT_WINDOW_MS + 1);
    expect(result.allowed).toBe(true);
    expect(result.window.count).toBe(1);
  });

  it('自訂 limit 參數覆寫預設上限：第三次呼叫起才被拒絕', () => {
    const first = checkRate(undefined, NOW, 2);
    expect(first.allowed).toBe(true);
    const second = checkRate(first.window, NOW, 2);
    expect(second.allowed).toBe(true);
    const third = checkRate(second.window, NOW, 2);
    expect(third.allowed).toBe(false);
  });
});
