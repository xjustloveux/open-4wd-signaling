/**
 * POST /turn-token 端點與哨兵房 guard 的整合測試：起真 http 伺服器、以 fetch 打端點；
 * 畸形 request-target 案以 raw socket 直送（fetch 造不出畸形請求線）。
 * proof 以 TURN_TOKEN_PURPOSE 佔 register proof 的 room 位簽製（與客戶端取憑證同形），
 * 簽章工具沿用 core/test-support.ts 的 identity 慣例。
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import { createServer, type RunningServer } from './server';
import { readConfig, type ServerConfig } from './config';
import {
  ERR_REGISTER_REJECTED,
  TIMESTAMP_TOLERANCE_MS,
  TURN_TOKEN_PURPOSE,
} from '../../core/constants';
import { buildRegisterProof, type RegisterProof, type Signature } from '../../core/protocol';
import { turnCredential } from '../../core/turn-token';
import { makeIdentity, type TestIdentity } from '../../core/test-support';

const SECRET = 'test-shared-secret';
const TURN_URLS = ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349'];

const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start(
  overrides: Partial<ServerConfig> = {},
): Promise<{ port: number; url: string }> {
  const server = createServer({ ...readConfig({}), port: 0, ...overrides });
  running.push(server);
  const port = await server.ready;
  return { port, url: `http://127.0.0.1:${port}` };
}

/** 已組態 TURN 的伺服器（secret＋urls 齊備＝端點掛出） */
async function startTurn(
  overrides: Partial<ServerConfig> = {},
): Promise<{ port: number; url: string }> {
  return start({ turnSharedSecret: SECRET, turnUrls: [...TURN_URLS], ...overrides });
}

function makeProof(identity: TestIdentity, now: number): Promise<RegisterProof> {
  return buildRegisterProof(
    identity.peerId,
    TURN_TOKEN_PURPOSE,
    (message) => ed25519.sign(message, identity.privateKey) as Signature,
    now,
  );
}

function postTurnToken(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/turn-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('readConfig —— TURN 組態', () => {
  it('TURN_SHARED_SECRET 未設或空字串＝undefined', () => {
    expect(readConfig({}).turnSharedSecret).toBeUndefined();
    expect(readConfig({ TURN_SHARED_SECRET: '' }).turnSharedSecret).toBeUndefined();
    expect(readConfig({ TURN_SHARED_SECRET: 's3cret' }).turnSharedSecret).toBe('s3cret');
  });

  it('TURN_URLS 逗號分隔、trim、去空項；未設＝空清單', () => {
    expect(readConfig({}).turnUrls).toEqual([]);
    expect(readConfig({ TURN_URLS: ` ${TURN_URLS[0]} ,, ${TURN_URLS[1]} ` }).turnUrls).toEqual(
      TURN_URLS,
    );
  });

  it('非 turn:／turns: 前綴項丟棄並 console.warn 一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = readConfig({
        TURN_URLS:
          'turn:a.example:3478, http://evil.example , stun:b.example, turns:c.example:5349',
      });
      expect(config.turnUrls).toEqual(['turn:a.example:3478', 'turns:c.example:5349']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('POST /turn-token —— 未組態', () => {
  it('TURN 組態缺席＝端點不掛（404），合法 proof 也一樣', async () => {
    const { url } = await start();
    const identity = makeIdentity(1);
    const response = await postTurnToken(url, {
      peerId: identity.peerId,
      proof: await makeProof(identity, Date.now()),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /turn-token —— 已組態', () => {
  it('合法 proof＝200 TurnToken：username 前綴未來時戳、credential 可重算、urls 原樣、ttlSec 300', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(2);
    const beforeSec = Math.floor(Date.now() / 1000);
    const response = await postTurnToken(url, {
      peerId: identity.peerId,
      proof: await makeProof(identity, Date.now()),
    });
    expect(response.status).toBe(200);
    const token = (await response.json()) as {
      urls: string[];
      username: string;
      credential: string;
      ttlSec: number;
    };
    const expirySec = Number(token.username.slice(0, token.username.indexOf(':')));
    expect(expirySec).toBeGreaterThan(beforeSec);
    expect(token.username.endsWith(`:${identity.peerId}`)).toBe(true);
    expect(token.credential).toBe(await turnCredential(SECRET, token.username));
    expect(token.urls).toEqual(TURN_URLS);
    expect(token.ttlSec).toBe(300);
  });

  it('壞簽章＝403 invalid-proof', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(3);
    const proof = await makeProof(identity, Date.now());
    const tampered = {
      ...proof,
      signatureHex:
        (proof.signatureHex.startsWith('00') ? 'ff' : '00') + proof.signatureHex.slice(2),
    };
    const response = await postTurnToken(url, { peerId: identity.peerId, proof: tampered });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid-proof' });
  });

  it('過期 timestamp（超容忍窗；簽章本身有效）＝403 invalid-proof', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(4);
    const stale = Date.now() - TIMESTAMP_TOLERANCE_MS - 60_000;
    const response = await postTurnToken(url, {
      peerId: identity.peerId,
      proof: await makeProof(identity, stale),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid-proof' });
  });

  it('同 nonce 重送＝第二次 409 nonce-replayed', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(5);
    const body = { peerId: identity.peerId, proof: await makeProof(identity, Date.now()) };
    expect((await postTurnToken(url, body)).status).toBe(200);
    const second = await postTurnToken(url, body);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'nonce-replayed' });
  });

  it('逾 per-IP 限流＝429（限流計數在驗證之前）', async () => {
    const { url } = await startTurn({ rateLimitPerMin: 2 });
    const identity = makeIdentity(6);
    const bogus = {
      peerId: identity.peerId,
      proof: { timestamp: Date.now(), nonce: '00'.repeat(16), signatureHex: '00'.repeat(64) },
    };
    expect((await postTurnToken(url, bogus)).status).toBe(403);
    expect((await postTurnToken(url, bogus)).status).toBe(403);
    expect((await postTurnToken(url, bogus)).status).toBe(429);
  });

  it('JSON parse 失敗或形不符＝400', async () => {
    const { url } = await startTurn();
    expect((await postTurnToken(url, '{not json')).status).toBe(400);
    expect((await postTurnToken(url, { peerId: 42 })).status).toBe(400);
  });

  it('額外欄位與非 canonical proof 格式＝400，與 Worker shape gate 一致', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(32);
    const proof = await makeProof(identity, Date.now());
    expect((await postTurnToken(url, { peerId: identity.peerId, proof, extra: true })).status).toBe(
      400,
    );
    expect(
      (
        await postTurnToken(url, {
          peerId: identity.peerId,
          proof: { ...proof, nonce: 'not-canonical' },
        })
      ).status,
    ).toBe(400);
  });

  it('TURN credential 非同步產生失敗＝500，請求不懸空', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(33);
    const importKey = vi
      .spyOn(globalThis.crypto.subtle, 'importKey')
      .mockRejectedValueOnce(new Error('crypto unavailable'));
    try {
      const response = await postTurnToken(url, {
        peerId: identity.peerId,
        proof: await makeProof(identity, Date.now()),
      });
      expect(response.status).toBe(500);
    } finally {
      importKey.mockRestore();
    }
  });

  it('body 逾 4096 bytes＝413', async () => {
    const { url } = await startTurn();
    const identity = makeIdentity(7);
    const padded = {
      peerId: identity.peerId,
      proof: await makeProof(identity, Date.now()),
      padding: 'x'.repeat(5_000),
    };
    expect((await postTurnToken(url, padded)).status).toBe(413);
  });

  it('非 POST 方法與其他路徑維持 404', async () => {
    const { url } = await startTurn();
    expect((await fetch(`${url}/turn-token`)).status).toBe(404);
    expect((await fetch(`${url}/other`, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('哨兵房 guard —— WS 升級', () => {
  function closeOf(port: number, room: string): Promise<{ code: number; reason: string }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${encodeURIComponent(room)}`);
    return new Promise((resolve, reject) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      socket.on('error', reject);
    });
  }

  it('哨兵房與 "/" 前綴房名一律拒絕（1008 register-rejected），與 TURN 組態無關', async () => {
    const { port } = await start();
    for (const room of [TURN_TOKEN_PURPOSE, '/reserved/internal']) {
      const closed = await closeOf(port, room);
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe(ERR_REGISTER_REJECTED);
    }
  });

  it('一般房名不受 guard 影響（升級完成）', async () => {
    const { port } = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=lobby`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.close();
  });
});

describe('畸形 request-target —— 行程存活', () => {
  /**
   * 以 raw socket 送原始 bytes 並收齊回應直到連線關閉。Node 會把 absolute-form
   * 等畸形 request-target 原樣放進 request.url，這類請求線 fetch 造不出來，
   * 只能走 raw socket。伺服器強制切斷也視為關閉、不作錯誤。
   */
  function rawExchange(port: number, payload: string): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const socket = connect(port, '127.0.0.1', () => socket.write(payload));
      const finish = (): void => resolve(Buffer.concat(chunks).toString());
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', finish);
      socket.on('error', finish);
      socket.setTimeout(3_000, () => socket.destroy());
    });
  }

  it('http 路徑：畸形 target＝400 且行程存活（與 TURN 組態無關），後續合法請求照常回應', async () => {
    const { port, url } = await start();
    const raw = await rawExchange(
      port,
      'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    );
    expect(raw.startsWith('HTTP/1.1 400')).toBe(true);
    // 行程存活證明：同一伺服器緊接著回應合法請求（未組態 TURN＝任何路徑 404）
    expect((await fetch(`${url}/turn-token`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('升級路徑：畸形 target＋Upgrade 標頭＝連線被拒且行程存活，後續 WS 升級照常完成', async () => {
    const { port } = await start();
    const raw = await rawExchange(
      port,
      'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    expect(raw.startsWith('HTTP/1.1 400')).toBe(true);
    // 行程存活證明：同一伺服器緊接著完成一次合法 WS 升級
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=lobby`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.close();
  });
});
