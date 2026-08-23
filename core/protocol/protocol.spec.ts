/**
 * core/protocol/index.ts barrel 的簽章往返常駐測試——本 repo 存在的核心理由即
 * dag-cbor digest 須跨端位元組完全一致；序列化或簽章鏈路只要有一處細節錯誤，
 * 型別檢查會全綠、看起來一切正常，但 verifyRegisterProof 就是回 false，且這類
 * 錯誤無法從型別層面被抓到，只有跑真實 crypto + 真實序列化的往返才驗得出來。
 *
 * 全部經由 barrel（./index）匯入，不直接引用 vendor 內部檔案：buildRegisterProof
 * ／verifyRegisterProof／RegisterProof 型別為被測介面本身；publicKeyToPeerId 是
 * 建構測試用 PeerId 所需的 multicodec + base58btc 編碼，barrel 已重新匯出，故一
 * 併經此入口取得——自行重新實作編碼邏輯只會製造「測到自己重寫版本」的假象。
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  buildRegisterProof,
  decodeSignedSignalWire,
  Protocol,
  publicKeyToPeerId,
  signSignalEnvelope,
  verifySignalEnvelope,
  verifyRegisterProof,
  type PeerId,
  type RegisterProof,
  type Signature,
  type Timestamp,
} from './index';

const SEED = new Uint8Array(32).fill(1);
const PUBLIC_KEY = ed25519.getPublicKey(SEED);
const PEER_ID: PeerId = publicKeyToPeerId(PUBLIC_KEY);
const NOW: Timestamp = 1_700_000_000_000;
const TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

const sign = (message: Uint8Array): Signature => ed25519.sign(message, SEED) as Signature;

/** 保證回傳值與輸入不同、且維持合法 hex 格式（讓斷言真正驗到簽章比對失敗，而非提前被格式檢查擋下）。 */
function tamperHex(hex: string): string {
  const flipped = hex[0] === 'a' ? 'b' : 'a';
  return flipped + hex.slice(1);
}

describe('protocol barrel：register proof 簽章往返（真實 Ed25519 + dag-cbor）', () => {
  it('合法簽章通過驗證', async () => {
    const proof = await buildRegisterProof(PEER_ID, 'room-a', sign, NOW);
    expect(verifyRegisterProof(PEER_ID, 'room-a', proof, NOW)).toBe(true);
  });

  it('跨房重放遭拒——room-a 簽出的 proof 拿到 room-b 驗證', async () => {
    const proof = await buildRegisterProof(PEER_ID, 'room-a', sign, NOW);
    expect(verifyRegisterProof(PEER_ID, 'room-b', proof, NOW)).toBe(false);
  });

  it('篡改 signatureHex 遭拒', async () => {
    const proof = await buildRegisterProof(PEER_ID, 'room-a', sign, NOW);
    const tampered: RegisterProof = { ...proof, signatureHex: tamperHex(proof.signatureHex) };
    expect(tampered.signatureHex).not.toBe(proof.signatureHex);
    expect(verifyRegisterProof(PEER_ID, 'room-a', tampered, NOW)).toBe(false);
  });

  it('時戳超出 ±30 秒容忍窗遭拒', async () => {
    const proof = await buildRegisterProof(PEER_ID, 'room-a', sign, NOW);
    expect(verifyRegisterProof(PEER_ID, 'room-a', proof, NOW + TOLERANCE_MS + 1)).toBe(false);
  });
});

describe('protocol barrel：signed signaling v1', () => {
  it('簽出、解析並驗證與 client 相同的 canonical envelope', async () => {
    const target = publicKeyToPeerId(ed25519.getPublicKey(new Uint8Array(32).fill(2)));
    const wire = await signSignalEnvelope(
      {
        scope: 'room:123e4567-e89b-42d3-a456-426614174000',
        target,
        message: { type: 'sdp-offer', sdp: 'v=0' },
        now: NOW,
        nonce: new Uint8Array(16).fill(0xab),
      },
      (bytes) => Promise.resolve(sign(bytes)),
      PEER_ID,
    );

    expect(wire.nonceHex).toBe('ab'.repeat(16));
    const decoded = decodeSignedSignalWire(wire);
    expect(decoded?.payload.scope).toBe('room:123e4567-e89b-42d3-a456-426614174000');
    expect(decoded === null ? false : verifySignalEnvelope(decoded, NOW)).toBe(true);
  });
});
