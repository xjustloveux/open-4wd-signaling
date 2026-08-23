import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import { makeIdentity, type TestIdentity } from '../core/test-support';
import type { Signature } from '../core/protocol';
import { WebSocketSignalingProvider, type WebSocketLike } from './vendor/ws-provider';

class NodeWebSocketAdapter implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly #socket: WebSocket;

  constructor(url: string, headers: Readonly<Record<string, string>>) {
    this.#socket = new WebSocket(url, { headers });
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

export function makeVendoredProvider(
  baseUrl: string,
  identity: TestIdentity,
  headers: Readonly<Record<string, string>> = {},
): WebSocketSignalingProvider {
  return new WebSocketSignalingProvider({
    providerId: 'provider-conformance',
    priority: 0,
    wsUrl: (scope) => `${baseUrl}/ws?room=${encodeURIComponent(scope)}`,
    createWebSocket: (url) => new NodeWebSocketAdapter(url, headers),
    sign: (message) => ed25519.sign(message, identity.privateKey) as Signature,
    registerTimeoutMs: 5_000,
  });
}

export async function runVendoredProviderRelayConformance(
  baseUrl: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{
  readonly alice: TestIdentity;
  readonly bob: TestIdentity;
  readonly sendResult: unknown;
  readonly received: unknown;
}> {
  const alice = makeIdentity(101);
  const bob = makeIdentity(102);
  const aliceResult = await makeVendoredProvider(baseUrl, alice, headers).openSession({
    localPeerId: alice.peerId,
    scope: 'room:123e4567-e89b-42d3-a456-426614174000',
  });
  const bobResult = await makeVendoredProvider(baseUrl, bob, headers).openSession({
    localPeerId: bob.peerId,
    scope: 'room:123e4567-e89b-42d3-a456-426614174000',
  });
  if (!aliceResult.ok) throw aliceResult.error;
  if (!bobResult.ok) throw bobResult.error;

  try {
    const received = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('provider relay timeout')), 5_000);
      bobResult.value.onMessage((from, message) => {
        clearTimeout(timer);
        resolve({ from, message });
      });
    });
    const sendResult = await aliceResult.value.send(bob.peerId, {
      type: 'sdp-offer',
      sdp: 'v=0\r\n',
    });
    return { alice, bob, sendResult, received: await received };
  } finally {
    await aliceResult.value.close();
    await bobResult.value.close();
  }
}
