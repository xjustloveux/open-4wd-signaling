import { describe, expect, it } from 'vitest';
import { readConfig } from './config';

describe('readConfig', () => {
  it('無環境變數時採用預設值，且不信任代理標頭', () => {
    const config = readConfig({});
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(false);
    expect(config.rateLimitPerMin).toBe(60);
  });

  it('TRUST_PROXY 僅在明確為 true 時開啟', () => {
    expect(readConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(readConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(false);
    expect(readConfig({ TRUST_PROXY: 'yes' }).trustProxy).toBe(false);
  });

  it('數值變數可覆寫，非法值退回預設', () => {
    expect(readConfig({ PORT: '9000' }).port).toBe(9000);
    expect(readConfig({ PORT: 'abc' }).port).toBe(8080);
  });
});
