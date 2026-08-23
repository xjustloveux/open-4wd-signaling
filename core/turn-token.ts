/**
 * TURN REST 短期憑證（與 coturn use-auth-secret 驗證端對齊）：
 * username＝"<到期 unix 秒>:<peerId>"、credential＝base64(HMAC-SHA1(secret, username))。
 * HMAC-SHA1 為對端協定固定選擇——僅作短壽命憑證推導、非安全雜湊選型。
 * 實作只使用 Web Crypto，Node 與 Cloudflare Worker 共用且不把 node:crypto 打進 bundle。
 */
import { TURN_TOKEN_TTL_SEC } from './constants';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 依 coturn REST 規則推導指定使用者名稱的短期憑證。 */
export async function turnCredential(
  secret: string,
  username: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, encoder.encode(username));
  return toBase64(new Uint8Array(signature));
}

/** 下發給 WebRTC 客戶端的 TURN 連線資訊。 */
export interface TurnToken {
  readonly urls: string[];
  readonly username: string;
  readonly credential: string;
  readonly ttlSec: number;
}

/** 由節點身分、目前時間與共享密鑰建立限時 TURN token。 */
export async function buildTurnToken(opts: {
  peerId: string;
  nowMs: number;
  secret: string;
  urls: readonly string[];
}): Promise<TurnToken> {
  const expiry = Math.floor(opts.nowMs / 1000) + TURN_TOKEN_TTL_SEC;
  const username = `${expiry}:${opts.peerId}`;
  return {
    urls: [...opts.urls],
    username,
    credential: await turnCredential(opts.secret, username),
    ttlSec: TURN_TOKEN_TTL_SEC,
  };
}
