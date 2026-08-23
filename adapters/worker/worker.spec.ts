import { describe, expect, it } from 'vitest';
import type { DurableObjectNamespace, DurableObjectStub, WorkerEnv } from './env';
import { opaqueBucket, verifyInternalAuthToken, INTERNAL_AUTH_HEADER } from './rate-limit';
import worker from './worker';

const INTERNAL_SECRET = 'internal-hmac-secret';

class CapturingStub implements DurableObjectStub {
  readonly requests: Request[] = [];

  constructor(private readonly response: () => Response | Promise<Response>) {}

  fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    return Promise.resolve(this.response());
  }
}

class CapturingNamespace implements DurableObjectNamespace {
  readonly names: string[] = [];

  constructor(readonly stub: CapturingStub) {}

  getByName(name: string): DurableObjectStub {
    this.names.push(name);
    return this.stub;
  }
}

function baseEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const room = new CapturingNamespace(new CapturingStub(() => new Response('upgraded')));
  const admission = new CapturingNamespace(
    new CapturingStub(() => Response.json({ allowed: true })),
  );
  const tokens = new CapturingNamespace(
    new CapturingStub(() => Response.json({ credential: 'issued' })),
  );
  return {
    INTERNAL_HMAC_SECRET: INTERNAL_SECRET,
    ROOMS: room,
    ADMISSION: admission,
    TOKEN_ISSUERS: tokens,
    ...overrides,
  };
}

describe('Worker router', () => {
  it('derives admission from CF-Connecting-IP and ignores forwarding headers', async () => {
    const env = baseEnv();
    const response = await worker.fetch(
      new Request('https://signal.example/ws?room=room:123e4567-e89b-42d3-a456-426614174000', {
        headers: {
          Upgrade: 'websocket',
          'CF-Connecting-IP': '203.0.113.9',
          'x-forwarded-for': '198.51.100.7',
          'x-open4wd-admission': 'forged',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const admission = env.ADMISSION as CapturingNamespace;
    expect(admission.stub.requests).toHaveLength(1);
    const forwarded = admission.stub.requests[0]!;
    const body = (await forwarded.clone().json()) as { bucket: string };
    expect(body.bucket).toBe(await opaqueBucket(INTERNAL_SECRET, 'ip', '203.0.113.9'));
    expect(body.bucket).not.toContain('198.51.100.7');
    expect(
      await verifyInternalAuthToken({
        token: forwarded.headers.get(INTERNAL_AUTH_HEADER),
        secret: INTERNAL_SECRET,
        purpose: 'admission',
        bucket: body.bucket,
        now: Number(forwarded.headers.get('x-open4wd-internal-time')),
      }),
    ).toBe(true);
  });

  it('keeps TURN disabled when the private deployment values are absent', async () => {
    const response = await worker.fetch(
      new Request('https://signal.example/turn-token', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.9' },
        body: '{}',
      }),
      baseEnv(),
    );
    expect(response.status).toBe(404);
  });

  it('routes a configured TURN request by opaque peer shard', async () => {
    const env = baseEnv({
      TURN_SHARED_SECRET: 'turn-secret',
      TURN_URLS: 'turn:turn.example.org:3478',
    });
    const response = await worker.fetch(
      new Request('https://signal.example/turn-token', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({
          peerId: '12D3KooWtest',
          proof: {
            timestamp: 1_700_000_000_000,
            nonce: '00'.repeat(16),
            signatureHex: '11'.repeat(64),
          },
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const issuers = env.TOKEN_ISSUERS as CapturingNamespace;
    expect(issuers.names).toEqual([await opaqueBucket(INTERNAL_SECRET, 'peer', '12D3KooWtest')]);
    const internalBody = (await issuers.stub.requests[0]!.clone().json()) as {
      bucket: string;
      peerId: string;
    };
    expect(internalBody.peerId).toBe('12D3KooWtest');
    expect(internalBody.bucket).toBe(await opaqueBucket(INTERNAL_SECRET, 'ip', '203.0.113.9'));
  });
});
