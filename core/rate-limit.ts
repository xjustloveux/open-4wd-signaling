import { RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_MS } from './constants';

/** 固定窗限流器的累計狀態。 */
export interface RateWindow {
  readonly count: number;
  readonly windowStart: number;
}

/** 一次限流判定及其更新後的窗狀態。 */
export interface RateResult {
  readonly allowed: boolean;
  readonly window: RateWindow;
}

/**
 * 固定窗計數。純函式：呼叫端負責保存與取回每個來源的窗狀態，
 * 因此同一份規則可搭配記憶體、Redis 或邊緣 KV 等任意後端。
 */
export function checkRate(
  window: RateWindow | undefined,
  now: number,
  limit: number = RATE_LIMIT_PER_MIN,
): RateResult {
  if (window === undefined || now - window.windowStart > RATE_LIMIT_WINDOW_MS)
    return { allowed: true, window: { count: 1, windowStart: now } };
  if (window.count >= limit) return { allowed: false, window };
  return { allowed: true, window: { count: window.count + 1, windowStart: window.windowStart } };
}
