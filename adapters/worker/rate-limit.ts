import { RATE_LIMIT_WINDOW_MS } from '../../core/constants';
import type { DurableObjectSqlStorage, DurableObjectStorage } from './env';

/** 指定 Worker 內部 Durable Object 呼叫使用的驗證標頭。 */
export const INTERNAL_AUTH_HEADER = 'x-open4wd-internal-auth';
const INTERNAL_AUTH_TOLERANCE_MS = 30_000;

interface RateRow extends Record<string, unknown> {
  count: number;
  window_start: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function internalMessage(purpose: string, bucket: string, now: number): Uint8Array {
  return new TextEncoder().encode(`open4wd-internal-v1\n${purpose}\n${bucket}\n${now}`);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** 建立短效且綁定用途與 bucket 的 Worker 內部 HMAC 權杖。 */
export async function createInternalAuthToken(input: {
  readonly secret: string;
  readonly purpose: 'admission' | 'turn-token';
  readonly bucket: string;
  readonly now: number;
}): Promise<string> {
  if (!Number.isSafeInteger(input.now) || input.secret === '' || input.bucket === '')
    throw new TypeError('invalid internal auth input');
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(input.secret),
    ownedBuffer(internalMessage(input.purpose, input.bucket, input.now)),
  );
  return `v1.${input.now}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 驗證 Worker 內部 HMAC 權杖的用途、bucket 與時間窗。 */
export async function verifyInternalAuthToken(input: {
  readonly token: string | null;
  readonly secret: string;
  readonly purpose: 'admission' | 'turn-token';
  readonly bucket: string;
  readonly now: number;
}): Promise<boolean> {
  if (
    input.token === null ||
    input.secret === '' ||
    input.bucket === '' ||
    !Number.isSafeInteger(input.now)
  )
    return false;
  const match = /^v1\.([0-9]+)\.([A-Za-z0-9_-]+)$/.exec(input.token);
  if (match === null) return false;
  const issuedAt = Number(match[1]);
  const signature = fromBase64Url(match[2]!);
  if (
    signature === null ||
    !Number.isSafeInteger(issuedAt) ||
    Math.abs(input.now - issuedAt) > INTERNAL_AUTH_TOLERANCE_MS
  )
    return false;
  try {
    return crypto.subtle.verify(
      'HMAC',
      await hmacKey(input.secret),
      ownedBuffer(signature),
      ownedBuffer(internalMessage(input.purpose, input.bucket, issuedAt)),
    );
  } catch {
    return false;
  }
}

/** 將 IP／PeerId 轉成不可逆、無跨環境可比性的儲存鍵。 */
export async function opaqueBucket(
  secret: string,
  purpose: 'ip' | 'peer',
  value: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    ownedBuffer(new TextEncoder().encode(`open4wd-bucket-v1\n${purpose}\n${value}`)),
  );
  return toBase64Url(new Uint8Array(signature));
}

/** 建立 Durable Object 限流所需的資料表與到期索引。 */
export function ensureRateLimitSchema(sql: DurableObjectSqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS rate_bucket (
      bucket TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  sql.exec('CREATE INDEX IF NOT EXISTS rate_bucket_expiry ON rate_bucket(expires_at)');
}

/** 呼叫端須已在 transactionSync 內；同一 DO 中 read-modify-write 為原子操作。 */
export function consumeRateBucket(
  sql: DurableObjectSqlStorage,
  bucket: string,
  now: number,
  limit: number,
): boolean {
  const row = sql
    .exec<RateRow>('SELECT count, window_start FROM rate_bucket WHERE bucket = ?', bucket)
    .toArray()[0];
  if (row === undefined || now - row.window_start > RATE_LIMIT_WINDOW_MS) {
    sql.exec(
      `INSERT INTO rate_bucket (bucket, count, window_start, expires_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = 1,
         window_start = excluded.window_start,
         expires_at = excluded.expires_at`,
      bucket,
      now,
      now + RATE_LIMIT_WINDOW_MS,
    );
    return true;
  }
  if (row.count >= limit) return false;
  sql.exec(
    'UPDATE rate_bucket SET count = count + 1, expires_at = ? WHERE bucket = ?',
    row.window_start + RATE_LIMIT_WINDOW_MS,
    bucket,
  );
  return true;
}

/** 在同步交易內清除到期 bucket 並原子消耗一次限流配額。 */
export function consumeDurableRate(
  storage: DurableObjectStorage,
  bucket: string,
  now: number,
  limit: number,
): boolean {
  if (
    bucket.length === 0 ||
    bucket.length > 256 ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  )
    return false;
  return storage.transactionSync(() => {
    storage.sql.exec('DELETE FROM rate_bucket WHERE expires_at < ?', now);
    return consumeRateBucket(storage.sql, bucket, now, limit);
  });
}
