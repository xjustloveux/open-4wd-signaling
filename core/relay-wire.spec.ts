import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { makeIdentity } from './test-support';
import { signSignalEnvelope, type Signature } from './protocol';
import { parseRelayWire } from './relay-wire';

describe('parseRelayWire', () => {
  it('signal-v1 一次解析同時產出原始 wire 與已解碼 signed payload', async () => {
    const sender = makeIdentity(41);
    const target = makeIdentity(42);
    const wire = await signSignalEnvelope(
      {
        scope: 'match:' + 'ab'.repeat(32),
        target: target.peerId,
        message: { type: 'sdp-offer', sdp: 'v=0' },
        now: 1_700_000_000_000,
        nonce: new Uint8Array(16).fill(7),
      },
      (message) => Promise.resolve(ed25519.sign(message, sender.privateKey) as Signature),
      sender.peerId,
    );

    const parsed = parseRelayWire(JSON.stringify(wire));

    expect(parsed?.wire).toEqual(wire);
    expect(parsed?.signed?.signer).toBe(sender.peerId);
    expect(parsed?.signed?.payload.target).toBe(target.peerId);
  });

  it('一般控制訊息沿用既有 parser 且沒有 signed payload', () => {
    const wire = { type: 'leave', sender: makeIdentity(43).peerId, payload: {} } as const;
    expect(parseRelayWire(JSON.stringify(wire))).toEqual({ kind: 'control', wire, signed: null });
  });
});
