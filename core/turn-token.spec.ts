import { describe, expect, it } from 'vitest';
import { buildTurnToken, turnCredential } from './turn-token';
import { TURN_TOKEN_TTL_SEC } from './constants';

describe('turnCredential', () => {
  it('使用 Web Crypto 非同步產生 HMAC-SHA1 base64（RFC 2202 test case 2 向量）', async () => {
    // 公開向量：key="Jefe"、data="what do ya want for nothing?" → 既知 digest（hex）。
    const expectedHex = 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79';
    const pending = turnCredential('Jefe', 'what do ya want for nothing?');
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(Buffer.from(expectedHex, 'hex').toString('base64'));
  });
});

describe('buildTurnToken', () => {
  it('username＝到期秒:peerId；credential 與 turnCredential 一致；urls 原樣', async () => {
    const token = await buildTurnToken({
      peerId: '12D3KooWtest',
      nowMs: 1_700_000_000_000,
      secret: 's3cret',
      urls: ['turn:turn.example.org:3478?transport=udp'],
    });
    expect(token.username).toBe(`${1_700_000_000 + TURN_TOKEN_TTL_SEC}:12D3KooWtest`);
    expect(token.credential).toBe(await turnCredential('s3cret', token.username));
    expect(token.urls).toEqual(['turn:turn.example.org:3478?transport=udp']);
    expect(token.ttlSec).toBe(TURN_TOKEN_TTL_SEC);
  });

  it('nowMs 向下取整到秒（毫秒餘數不影響到期整數）', async () => {
    const a = await buildTurnToken({
      peerId: 'p',
      nowMs: 1_700_000_000_999,
      secret: 's',
      urls: [],
    });
    expect(a.username).toBe(`${1_700_000_000 + TURN_TOKEN_TTL_SEC}:p`);
  });
});
