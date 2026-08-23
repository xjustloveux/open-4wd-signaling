import { describe, expect, it } from 'vitest';
import { deriveKeyPair, publicKeyToPeerId, signMessage } from '../key-manager';
import { signSignalEnvelope } from './signal-envelope';
import { parseSignalingWire } from './wire-parser';

const aliceKey = deriveKeyPair(new Uint8Array(32).fill(1));
const bobKey = deriveKeyPair(new Uint8Array(32).fill(2));
const alice = publicKeyToPeerId(aliceKey.publicKey);
const bob = publicKeyToPeerId(bobKey.publicKey);
const ROOM_ID = '00000000-0000-4000-8000-000000000001';
const ROOM_SCOPE = `room:${ROOM_ID}`;

async function signed(message: Parameters<typeof signSignalEnvelope>[0]['message']) {
  return signSignalEnvelope(
    {
      scope: ROOM_SCOPE,
      target: bob,
      message,
      now: 1_700_000_000_000,
      nonce: new Uint8Array(16).fill(1),
    },
    (bytes) => Promise.resolve(signMessage(aliceKey.privateKey, bytes)),
    alice,
  );
}

describe('parseSignalingWire', () => {
  it('接受每一種合法 wire variant', () => {
    const messages = [
      { type: 'register', sender: 'a', payload: { peerId: 'a' } },
      {
        type: 'register',
        sender: 'a',
        payload: { peerId: 'a', proof: { timestamp: 1, nonce: 'ab', signatureHex: 'cd' } },
      },
      { type: 'peer-joined', sender: 'server', payload: { peerId: 'a' } },
      { type: 'peer-left', sender: 'server', payload: { peerId: 'a' } },
      { type: 'leave', sender: 'a', payload: {} },
      { type: 'error', sender: 'server', payload: { code: 'bad', message: 'detail' } },
    ];
    for (const message of messages)
      expect(parseSignalingWire(JSON.stringify(message))?.type).toBe(message.type);
  });

  it('接受合法 room-state 與帶簽章 signal-v1 SDP／ICE', async () => {
    expect(
      parseSignalingWire(
        JSON.stringify({ type: 'room-state', sender: 'server', payload: { peers: ['a', 'b'] } }),
      )?.type,
    ).toBe('room-state');
    expect(
      parseSignalingWire(JSON.stringify(await signed({ type: 'sdp-offer', sdp: 'v=0' })))?.type,
    ).toBe('signal-v1');
    expect(
      parseSignalingWire(
        JSON.stringify(
          await signed({
            type: 'ice-candidate',
            candidate: { candidate: 'candidate:1' },
          }),
        ),
      )?.type,
    ).toBe('signal-v1');
  });

  it.each([
    { type: 'join-request', sender: 'a', payload: { roomId: ROOM_ID, password: 'pw' } },
    { type: 'join-as-spectator', sender: 'a', payload: { roomId: ROOM_ID } },
  ])('拒絕協定外的 signaling 訊息型別 $type', (value) => {
    expect(parseSignalingWire(JSON.stringify(value))).toBeNull();
  });

  it('拒絕帶有協定外欄位 recommendedSource 的 room-state', () => {
    expect(
      parseSignalingWire(
        JSON.stringify({
          type: 'room-state',
          sender: 'server',
          payload: { peers: ['a', 'b'], recommendedSource: 'a' },
        }),
      ),
    ).toBeNull();
  });

  it('拒絕缺 payload、錯型、未知 type 與超限 peers/SDP', () => {
    for (const value of [
      { type: 'room-state', sender: 'server' },
      { type: 'peer-joined', sender: 'server', payload: { peerId: 7 } },
      { type: 'ice-candidate', sender: 'a', target: 'b', payload: { candidate: 'bad' } },
      { type: 'unknown', sender: 'a', payload: {} },
      { type: 'room-state', sender: 'server', payload: { peers: Array(65).fill('a') } },
      { type: 'sdp-answer', sender: 'a', target: 'b', payload: { sdp: 'x'.repeat(131_073) } },
      { type: 'sdp-offer', sender: 'a', target: 'b', payload: { sdp: 'v=0' } },
      {
        type: 'register',
        sender: 'a',
        payload: { peerId: 'a', proof: { timestamp: 'bad', nonce: 'a', signatureHex: 'b' } },
      },
      {
        type: 'match-request',
        sender: 'a',
        payload: { trueSkillMu: 25, trueSkillSigma: 8 },
      },
      { type: 'match-found', sender: 'server', payload: { peers: ['a'], roomId: ROOM_ID } },
      { type: 'ice-candidate', sender: 'a', target: 'b', payload: { candidate: { sdpMid: 7 } } },
      {
        type: 'ice-candidate',
        sender: 'a',
        target: 'b',
        payload: { candidate: { sdpMLineIndex: '0' } },
      },
      { type: 'room-state', sender: 'server', payload: { peers: [7] } },
      { type: 'error', sender: 'server', payload: { code: 'x', message: 7 } },
    ]) {
      expect(parseSignalingWire(JSON.stringify(value))).toBeNull();
    }
  });
});
