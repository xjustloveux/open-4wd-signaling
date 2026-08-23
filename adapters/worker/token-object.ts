import {
  RATE_LIMIT_PER_MIN,
  TIMESTAMP_TOLERANCE_MS,
  TURN_TOKEN_PURPOSE,
} from '../../core/constants';
import { verifyRegisterProof } from '../../core/protocol';
import { buildTurnToken } from '../../core/turn-token';
import { parseTurnTokenRequest } from '../../core/turn-token-request';
import type { StatefulDurableObjectContext, WorkerEnv } from './env';
import {
  consumeRateBucket,
  ensureRateLimitSchema,
  INTERNAL_AUTH_HEADER,
  opaqueBucket,
  verifyInternalAuthToken,
} from './rate-limit';

const MAX_BODY_BYTES = 4_096;

interface ReplayRow extends Record<string, unknown> {
  present: number;
}

function urlsFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('turn:') || entry.startsWith('turns:'));
}

function configuredLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : RATE_LIMIT_PER_MIN;
}

/** 以持久重放防護與限流簽發短效 TURN 憑證。 */
export class TokenIssuerDurableObject {
  constructor(
    private readonly ctx: StatefulDurableObjectContext,
    private readonly env: WorkerEnv,
    private readonly now: () => number = Date.now,
  ) {
    ensureRateLimitSchema(ctx.storage.sql);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS turn_nonce (
        signer_hash TEXT NOT NULL,
        nonce_hex TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (signer_hash, nonce_hex)
      )
    `);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS turn_nonce_expiry ON turn_nonce(expires_at)');
  }

  /** 驗證內部授權與用戶證明後簽發 TURN 憑證。 */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'not-found' }, { status: 404 });
    const internalSecret = this.env.INTERNAL_HMAC_SECRET;
    const turnSecret = this.env.TURN_SHARED_SECRET;
    const urls = urlsFromEnv(this.env.TURN_URLS);
    if (
      internalSecret === undefined ||
      internalSecret === '' ||
      turnSecret === undefined ||
      turnSecret === '' ||
      urls.length === 0
    )
      return Response.json({ error: 'not-configured' }, { status: 404 });

    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES)
      return Response.json({ error: 'body-too-large' }, { status: 413 });
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
      return Response.json({ error: 'body-too-large' }, { status: 413 });
    const body = parseTurnTokenRequest(text, { bucket: 'required' });
    if (body === null) return Response.json({ error: 'invalid-request' }, { status: 400 });

    const now = this.now();
    if (
      !(await verifyInternalAuthToken({
        token: request.headers.get(INTERNAL_AUTH_HEADER),
        secret: internalSecret,
        purpose: 'turn-token',
        bucket: body.bucket,
        now,
      }))
    )
      return Response.json({ error: 'forbidden' }, { status: 403 });
    if (!verifyRegisterProof(body.peerId, TURN_TOKEN_PURPOSE, body.proof, now))
      return Response.json({ error: 'invalid-proof' }, { status: 403 });

    const signerHash = await opaqueBucket(internalSecret, 'peer', body.peerId);
    const limit = configuredLimit(this.env.TURN_RATE_LIMIT_PER_MIN);
    const outcome = this.ctx.storage.transactionSync<'ok' | 'replay' | 'rate-limited'>(() => {
      this.ctx.storage.sql.exec('DELETE FROM turn_nonce WHERE expires_at < ?', now);
      this.ctx.storage.sql.exec('DELETE FROM rate_bucket WHERE expires_at < ?', now);
      const replay = this.ctx.storage.sql
        .exec<ReplayRow>(
          `SELECT 1 AS present FROM turn_nonce
           WHERE signer_hash = ? AND nonce_hex = ?`,
          signerHash,
          body.proof.nonce,
        )
        .toArray()[0];
      if (replay !== undefined) return 'replay';

      const ipAllowed = consumeRateBucket(this.ctx.storage.sql, `ip:${body.bucket}`, now, limit);
      const peerAllowed = consumeRateBucket(this.ctx.storage.sql, `peer:${signerHash}`, now, limit);
      if (!ipAllowed || !peerAllowed) return 'rate-limited';

      this.ctx.storage.sql.exec(
        'INSERT INTO turn_nonce (signer_hash, nonce_hex, expires_at) VALUES (?, ?, ?)',
        signerHash,
        body.proof.nonce,
        body.proof.timestamp + TIMESTAMP_TOLERANCE_MS,
      );
      return 'ok';
    });

    if (outcome === 'replay') return Response.json({ error: 'nonce-replayed' }, { status: 409 });
    if (outcome === 'rate-limited')
      return Response.json({ error: 'rate-limited' }, { status: 429 });

    return Response.json(
      await buildTurnToken({
        peerId: body.peerId,
        nowMs: now,
        secret: turnSecret,
        urls,
      }),
    );
  }
}
