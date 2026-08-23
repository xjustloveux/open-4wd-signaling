import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import { createServer, type RunningServer } from '../adapters/node/server';
import { readConfig } from '../adapters/node/config';
import { makeIdentity } from '../core/test-support';
import type { Signature } from '../core/protocol';
import { WebSocketSignalingProvider, type WebSocketLike } from './vendor/ws-provider';
import { runVendoredProviderRelayConformance } from './provider-conformance';

class NodeWebSocketAdapter implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly #socket: WebSocket;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.on('open', () => this.onopen?.());
    this.#socket.on('message', (data) => this.onmessage?.({ data: data.toString() }));
    this.#socket.on('close', () => this.onclose?.());
    this.#socket.on('error', () => this.onerror?.());
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(): void {
    this.#socket.close();
  }
}

let server: RunningServer;
let baseUrl: string;

beforeAll(async () => {
  server = createServer({ ...readConfig({}), port: 0, rateLimitPerMin: 200 });
  baseUrl = `ws://127.0.0.1:${await server.ready}`;
});

afterAll(async () => {
  await server.close();
});

describe('e2e —— vendored client provider 對真 Node server', () => {
  it('以 canonical scope 完成 signed register 並透過 session.send 轉發訊息', async () => {
    const result = await runVendoredProviderRelayConformance(baseUrl);

    expect(result.sendResult).toEqual({ ok: true, value: undefined });
    expect(result.received).toEqual({
      from: result.alice.peerId,
      message: { type: 'sdp-offer', sdp: 'v=0\r\n' },
    });
  });

  it('provider 本身拒絕 lobby，不建立 WebSocket', async () => {
    const identity = makeIdentity(3);
    const createWebSocket = vi.fn((url: string) => new NodeWebSocketAdapter(url));
    const candidate = new WebSocketSignalingProvider({
      providerId: 'node-e2e',
      priority: 0,
      wsUrl: (scope) => `${baseUrl}/ws?room=${encodeURIComponent(scope)}`,
      createWebSocket,
      sign: (message) => ed25519.sign(message, identity.privateKey) as Signature,
    });

    const result = await candidate.openSession({
      localPeerId: identity.peerId,
      scope: 'lobby',
    });

    expect(result.ok).toBe(false);
    expect(createWebSocket).not.toHaveBeenCalled();
  });
});
