import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { WebSocket } from 'ws';
import { runVendoredProviderRelayConformance } from '../../e2e/provider-conformance';

let runtime: Unstable_DevWorker;

beforeAll(async () => {
  runtime = await unstable_dev('adapters/worker/worker.ts', {
    config: 'deploy/cloudflare/wrangler.jsonc',
    ip: '127.0.0.1',
    port: 0,
    local: true,
    logLevel: 'error',
    vars: { INTERNAL_HMAC_SECRET: 'local-e2e-secret' },
    experimental: {
      disableDevRegistry: true,
      watch: false,
    },
  });
}, 20_000);

afterAll(async () => {
  await runtime?.stop();
});

describe('Cloudflare Worker local runtime', () => {
  it('boots SQLite-backed Durable Objects and upgrades a canonical room', async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${runtime.port}/ws?room=${encodeURIComponent(
        'room:123e4567-e89b-42d3-a456-426614174000',
      )}`,
      { headers: { 'CF-Connecting-IP': '127.0.0.1' } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('keeps TURN hidden when private deployment values are absent', async () => {
    const response = await runtime.fetch('/turn-token', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '127.0.0.1' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it('passes the same vendored provider relay vector as the Node adapter', async () => {
    const result = await runVendoredProviderRelayConformance(`ws://127.0.0.1:${runtime.port}`, {
      'CF-Connecting-IP': '127.0.0.1',
    });

    expect(result.sendResult).toEqual({ ok: true, value: undefined });
    expect(result.received).toEqual({
      from: result.alice.peerId,
      message: { type: 'sdp-offer', sdp: 'v=0\r\n' },
    });
  });
});
