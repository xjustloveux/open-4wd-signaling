import type { PeerId, RegisterProof } from './protocol';

/** Node adapter 接收的 TURN 短期憑證請求。 */
export interface TurnTokenRequest {
  readonly peerId: PeerId;
  readonly proof: RegisterProof;
}

/** Worker adapter 使用、另含限流分桶鍵的 TURN 憑證請求。 */
export interface BucketedTurnTokenRequest extends TurnTokenRequest {
  readonly bucket: string;
}

type BucketMode = 'forbidden' | 'required';

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/** 解析不允許分桶鍵的 TURN 憑證請求。 */
export function parseTurnTokenRequest(
  text: string,
  options: { readonly bucket: 'forbidden' },
): TurnTokenRequest | null;
/** 解析必須含分桶鍵的 TURN 憑證請求。 */
export function parseTurnTokenRequest(
  text: string,
  options: { readonly bucket: 'required' },
): BucketedTurnTokenRequest | null;
/** 依指定模式驗證並解析 TURN 憑證請求。 */
export function parseTurnTokenRequest(
  text: string,
  options: { readonly bucket: BucketMode },
): TurnTokenRequest | BucketedTurnTokenRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const expectedBodyKeys =
    options.bucket === 'required' ? ['peerId', 'proof', 'bucket'] : ['peerId', 'proof'];
  if (!exactKeys(body, expectedBodyKeys)) return null;

  const proofValue = body['proof'];
  if (
    typeof body['peerId'] !== 'string' ||
    body['peerId'].length === 0 ||
    typeof proofValue !== 'object' ||
    proofValue === null ||
    Array.isArray(proofValue)
  )
    return null;
  const proof = proofValue as Record<string, unknown>;
  if (
    !exactKeys(proof, ['timestamp', 'nonce', 'signatureHex']) ||
    typeof proof['timestamp'] !== 'number' ||
    !Number.isSafeInteger(proof['timestamp']) ||
    typeof proof['nonce'] !== 'string' ||
    !/^[0-9a-f]{32}$/.test(proof['nonce']) ||
    typeof proof['signatureHex'] !== 'string' ||
    !/^[0-9a-f]{128}$/.test(proof['signatureHex'])
  )
    return null;

  const request: TurnTokenRequest = {
    peerId: body['peerId'] as PeerId,
    proof: {
      timestamp: proof['timestamp'],
      nonce: proof['nonce'],
      signatureHex: proof['signatureHex'],
    },
  };
  if (options.bucket === 'forbidden') return request;
  const bucket = body['bucket'];
  if (typeof bucket !== 'string' || bucket.length === 0 || bucket.length > 256) return null;
  return { ...request, bucket };
}
