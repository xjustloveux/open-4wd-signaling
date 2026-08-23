import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import { createServer, type RunningServer } from '../adapters/node/server';
import { readConfig } from '../adapters/node/config';
import { makeIdentity, type TestIdentity } from '../core/test-support';
import {
  buildRegisterProof,
  signSignalEnvelope,
  type Signature,
  type SignalingWire,
} from '../core/protocol';

let server: RunningServer;
let baseUrl: string;

beforeAll(async () => {
  server = createServer({ ...readConfig({}), port: 0, rateLimitPerMin: 200 });
  baseUrl = `ws://127.0.0.1:${await server.ready}`;
});

afterAll(async () => {
  await server.close();
});

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextWire(socket: WebSocket): Promise<SignalingWire> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wire timeout')), 5_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as SignalingWire);
    });
  });
}

async function connectRegistered(scope: string, identity: TestIdentity): Promise<WebSocket> {
  const socket = await openSocket(`${baseUrl}/ws?room=${encodeURIComponent(scope)}`);
  const proof = await buildRegisterProof(
    identity.peerId,
    scope,
    (message) => ed25519.sign(message, identity.privateKey) as Signature,
    Date.now(),
  );
  const initial = nextWire(socket);
  socket.send(
    JSON.stringify({
      type: 'register',
      sender: identity.peerId,
      payload: { peerId: identity.peerId, proof },
    }),
  );
  expect((await initial).type).toBe('room-state');
  return socket;
}

describe('e2e —— raw WebSocket server-wire conformance', () => {
  it('簽章 register 成功並取得房間快照', async () => {
    const socket = await connectRegistered(
      'room:123e4567-e89b-42d3-a456-426614174000',
      makeIdentity(1),
    );
    socket.close();
  });

  it('兩個 peer 可經伺服器轉發 sdp-offer', async () => {
    const alice = makeIdentity(1);
    const bob = makeIdentity(2);
    const aliceSocket = await connectRegistered('room:123e4567-e89b-42d3-a456-426614174000', alice);
    const bobSocket = await connectRegistered('room:123e4567-e89b-42d3-a456-426614174000', bob);
    const received = nextWire(bobSocket);
    aliceSocket.send(
      JSON.stringify(
        await signSignalEnvelope(
          {
            scope: 'room:123e4567-e89b-42d3-a456-426614174000',
            target: bob.peerId,
            message: { type: 'sdp-offer', sdp: 'v=0\r\n' },
            now: Date.now(),
            nonce: new Uint8Array(16).fill(1),
          },
          (message) => Promise.resolve(ed25519.sign(message, alice.privateKey) as Signature),
          alice.peerId,
        ),
      ),
    );
    await expect(received).resolves.toMatchObject({
      type: 'signal-v1',
      signer: alice.peerId,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'v=0\r\n' },
    });
    aliceSocket.close();
    bobSocket.close();
  });

  it('64 人限制只作用於單一 scope，不形成全域 lobby', async () => {
    const sockets = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        connectRegistered(`match:${index.toString(16).padStart(64, '0')}`, makeIdentity(index + 1)),
      ),
    );
    expect(sockets).toHaveLength(65);
    for (const socket of sockets) socket.close();
  });

  it('缺少 canonical scope 時拒絕，不回退到 lobby', async () => {
    const socket = new WebSocket(`${baseUrl}/ws`);
    const closed = new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(1006);
      }, 1_000);
      socket.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(await closed).toBe(1008);
  });
});
