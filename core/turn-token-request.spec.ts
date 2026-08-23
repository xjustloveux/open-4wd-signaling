import { describe, expect, it } from 'vitest';
import { makeIdentity } from './test-support';
import { parseTurnTokenRequest } from './turn-token-request';

const validRequest = {
  peerId: makeIdentity(31).peerId,
  proof: {
    timestamp: 1_700_000_000_000,
    nonce: 'ab'.repeat(16),
    signatureHex: 'cd'.repeat(64),
  },
};

describe('parseTurnTokenRequest', () => {
  it('Node 與 Worker 共用相同 peer proof shape gate', () => {
    expect(parseTurnTokenRequest(JSON.stringify(validRequest), { bucket: 'forbidden' })).toEqual(
      validRequest,
    );
    expect(
      parseTurnTokenRequest(JSON.stringify({ ...validRequest, bucket: 'opaque-ip' }), {
        bucket: 'required',
      }),
    ).toEqual({ ...validRequest, bucket: 'opaque-ip' });
  });

  it.each([
    { ...validRequest, extra: true },
    { ...validRequest, proof: { ...validRequest.proof, extra: true } },
    { ...validRequest, proof: { ...validRequest.proof, timestamp: 1.5 } },
    { ...validRequest, proof: { ...validRequest.proof, nonce: 'not-hex' } },
    { ...validRequest, proof: { ...validRequest.proof, signatureHex: '00' } },
  ])('拒絕非 canonical body：%j', (body) => {
    expect(parseTurnTokenRequest(JSON.stringify(body), { bucket: 'forbidden' })).toBeNull();
  });

  it('bucket 模式精確限制 transport metadata', () => {
    expect(parseTurnTokenRequest(JSON.stringify(validRequest), { bucket: 'required' })).toBeNull();
    expect(
      parseTurnTokenRequest(JSON.stringify({ ...validRequest, bucket: 'x'.repeat(257) }), {
        bucket: 'required',
      }),
    ).toBeNull();
    expect(
      parseTurnTokenRequest(JSON.stringify({ ...validRequest, bucket: 'opaque-ip' }), {
        bucket: 'forbidden',
      }),
    ).toBeNull();
  });
});
