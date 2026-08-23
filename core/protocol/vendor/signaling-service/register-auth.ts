/**
 * register 簽章——WS signaling 的 register 為身分宣告入口，未簽章＝任一連線
 * 可冒名任意 PeerId（劫持其 SDP 轉發／污染房間成員快照）。硬化＝register 攜
 * 域標籤簽章證明：簽 {peerId, room, timestamp, nonce}（綁房防跨房重放、時戳窗
 * ＋nonce 防重放）；server（open-4wd-signaling、Template 化）與測試共用 verify。
 * wire 為 JSON＝簽章 hex 編碼。傳輸層非共識、時戳用牆鐘（±窗驗）。
 */
import type { PeerId, Signature, Timestamp } from '@open4wd/interfaces';
import { Protocol } from '@open4wd/system-constants';
import { lowercaseHex as toHex } from '../encoding/bytes';
import { peerIdToPublicKey, verifyMessage } from '../key-manager';
// 深路徑匯入 serialize（dag-cbor＋noble 葉檔）——不拖 ledger barrel 進傳輸層
import { signingDigest } from '../ledger/serialize';

/** signaling register 的短效防重放身分證明。 */
export interface RegisterProof {
  timestamp: Timestamp;
  /** 16B hex（每次 register 新產） */
  nonce: string;
  /** Ed25519 簽章 hex（wire 為 JSON、無二進位欄位） */
  signatureHex: string;
}

const TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

function registerDigest(
  peerId: PeerId,
  room: string,
  timestamp: Timestamp,
  nonce: string,
): Uint8Array {
  return signingDigest({ type: 'signaling-register', peerId, room, timestamp, nonce });
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** 產 register 證明（sign＝身分私鑰簽章埠；nonce 走 WebCrypto 隨機） */
export async function buildRegisterProof(
  peerId: PeerId,
  room: string,
  sign: (message: Uint8Array) => Promise<Signature> | Signature,
  now: Timestamp,
): Promise<RegisterProof> {
  const nonceBytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(nonceBytes);
  const nonce = toHex(nonceBytes);
  const signature = await sign(registerDigest(peerId, room, now, nonce));
  return { timestamp: now, nonce, signatureHex: toHex(signature) };
}

/**
 * 驗 register 證明（server 端／測試）：時戳窗（±容差）＋簽章對 (peerId, room,
 * timestamp, nonce) 有效；nonce 重放去重由 server 以 (peerId, nonce) 短窗表承接
 * （本函式無狀態）。畸形＝fail-closed。
 */
export function verifyRegisterProof(
  peerId: PeerId,
  room: string,
  proof: RegisterProof,
  now: Timestamp,
): boolean {
  try {
    if (Math.abs(now - proof.timestamp) > TOLERANCE_MS) return false;
    const signature = fromHex(proof.signatureHex);
    if (signature === null || signature.length === 0) return false;
    const publicKey = peerIdToPublicKey(peerId);
    if (publicKey === null) return false;
    return verifyMessage(
      publicKey,
      registerDigest(peerId, room, proof.timestamp, proof.nonce),
      signature as Signature,
    );
  } catch {
    return false;
  }
}
