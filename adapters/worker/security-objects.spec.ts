import { DatabaseSync } from 'node:sqlite';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { TURN_TOKEN_PURPOSE } from '../../core/constants';
import { buildRegisterProof, type RegisterProof, type Signature } from '../../core/protocol';
import { makeIdentity } from '../../core/test-support';
import type {
  DurableObjectStorage,
  SqlCursor,
  SqlValue,
  StatefulDurableObjectContext,
} from './env';
import { AdmissionLimiterDurableObject } from './admission-object';
import { createInternalAuthToken, INTERNAL_AUTH_HEADER } from './rate-limit';
import { TokenIssuerDurableObject } from './token-object';

const NOW = 1_700_000_000_000;
const INTERNAL_SECRET = 'internal-hmac-secret';
const TURN_SECRET = 'turn-shared-secret';
const TURN_URLS = 'turn:turn.example.org:3478?transport=udp';

class SqliteCursor<T extends Record<string, unknown>> implements SqlCursor<T> {
  constructor(private readonly rows: T[]) {}

  toArray(): T[] {
    return this.rows;
  }
}

class MemoryStorage implements DurableObjectStorage {
  private readonly db = new DatabaseSync(':memory:');
  alarmTime: number | null = null;

  readonly sql = {
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> => {
      const statement = this.db.prepare(query);
      const rows =
        statement.columns().length === 0
          ? (statement.run(...bindings), [])
          : statement.all(...bindings);
      return new SqliteCursor(rows as T[]);
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmTime = scheduledTime;
    return Promise.resolve();
  }
}

class MemoryContext implements StatefulDurableObjectContext {
  readonly storage = new MemoryStorage();
}

async function makeTurnProof(seed: number): Promise<{
  peerId: string;
  proof: RegisterProof;
}> {
  const identity = makeIdentity(seed);
  const proof = await buildRegisterProof(
    identity.peerId,
    TURN_TOKEN_PURPOSE,
    (message) => ed25519.sign(message, identity.privateKey) as Signature,
    NOW,
  );
  return { peerId: identity.peerId, proof };
}

async function tokenRequest(body: {
  peerId: string;
  proof: RegisterProof;
  bucket: string;
}): Promise<Request> {
  return new Request('https://internal/issue', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INTERNAL_AUTH_HEADER]: await createInternalAuthToken({
        secret: INTERNAL_SECRET,
        purpose: 'turn-token',
        bucket: body.bucket,
        now: NOW,
      }),
    },
    body: JSON.stringify(body),
  });
}

describe('AdmissionLimiterDurableObject', () => {
  it('limits one opaque IP bucket across many room scopes and recreation', () => {
    const context = new MemoryContext();
    const first = new AdmissionLimiterDurableObject(
      context,
      {
        INTERNAL_HMAC_SECRET: INTERNAL_SECRET,
      },
      () => NOW,
    );
    expect(first.consume('bucket-a', 2)).toBe(true);
    expect(first.consume('bucket-a', 2)).toBe(true);

    const woken = new AdmissionLimiterDurableObject(
      context,
      {
        INTERNAL_HMAC_SECRET: INTERNAL_SECRET,
      },
      () => NOW,
    );
    expect(woken.consume('bucket-a', 2)).toBe(false);
    expect(woken.consume('bucket-b', 2)).toBe(true);
  });

  it('requires a front-worker HMAC token on its fetch boundary', async () => {
    const context = new MemoryContext();
    const limiter = new AdmissionLimiterDurableObject(
      context,
      { INTERNAL_HMAC_SECRET: INTERNAL_SECRET },
      () => NOW,
    );
    const body = JSON.stringify({ bucket: 'bucket-a' });
    const forged = await limiter.fetch(
      new Request('https://internal/consume', {
        method: 'POST',
        headers: { [INTERNAL_AUTH_HEADER]: 'forged' },
        body,
      }),
    );
    expect(forged.status).toBe(403);

    const valid = await limiter.fetch(
      new Request('https://internal/consume', {
        method: 'POST',
        headers: {
          [INTERNAL_AUTH_HEADER]: await createInternalAuthToken({
            secret: INTERNAL_SECRET,
            purpose: 'admission',
            bucket: 'bucket-a',
            now: NOW,
          }),
        },
        body,
      }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ allowed: true });
  });
});

describe('TokenIssuerDurableObject', () => {
  it('rejects the same TURN proof after issuer recreation', async () => {
    const context = new MemoryContext();
    const env = {
      INTERNAL_HMAC_SECRET: INTERNAL_SECRET,
      TURN_SHARED_SECRET: TURN_SECRET,
      TURN_URLS,
      TURN_RATE_LIMIT_PER_MIN: '10',
    };
    const body = { ...(await makeTurnProof(1)), bucket: 'opaque-ip-bucket' };

    const first = new TokenIssuerDurableObject(context, env, () => NOW);
    const accepted = await first.fetch(await tokenRequest(body));
    expect(accepted.status).toBe(200);

    const woken = new TokenIssuerDurableObject(context, env, () => NOW);
    const replay = await woken.fetch(await tokenRequest(body));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'nonce-replayed' });
  });

  it('rejects a forged internal token before checking the peer proof', async () => {
    const context = new MemoryContext();
    const issuer = new TokenIssuerDurableObject(
      context,
      {
        INTERNAL_HMAC_SECRET: INTERNAL_SECRET,
        TURN_SHARED_SECRET: TURN_SECRET,
        TURN_URLS,
      },
      () => NOW,
    );
    const body = { ...(await makeTurnProof(2)), bucket: 'opaque-ip-bucket' };
    const request = await tokenRequest(body);
    request.headers.set(INTERNAL_AUTH_HEADER, 'v1.1700000000000.forged');

    const response = await issuer.fetch(request);
    expect(response.status).toBe(403);
  });

  it('applies the durable IP and peer rate limit before issuing another token', async () => {
    const context = new MemoryContext();
    const env = {
      INTERNAL_HMAC_SECRET: INTERNAL_SECRET,
      TURN_SHARED_SECRET: TURN_SECRET,
      TURN_URLS,
      TURN_RATE_LIMIT_PER_MIN: '1',
    };
    const issuer = new TokenIssuerDurableObject(context, env, () => NOW);
    const first = { ...(await makeTurnProof(3)), bucket: 'opaque-ip-bucket' };
    const second = { ...(await makeTurnProof(3)), bucket: 'opaque-ip-bucket' };

    expect((await issuer.fetch(await tokenRequest(first))).status).toBe(200);
    const limited = await issuer.fetch(await tokenRequest(second));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate-limited' });
  });
});
