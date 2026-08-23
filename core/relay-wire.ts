import { decodeSignedSignalWire, parseSignalingWire, type SignalingWire } from './protocol';

const MAX_WIRE_BYTES = 256 * 1024;

/** 通過結構解碼的簽章訊號內容。 */
export type DecodedSignal = NonNullable<ReturnType<typeof decodeSignedSignalWire>>;
/** Relay 入口已分類並完成必要解碼的訊息。 */
export type RelayWire =
  | {
      readonly kind: 'signal';
      readonly wire: Extract<SignalingWire, { type: 'signal-v1' }>;
      readonly signed: DecodedSignal;
    }
  | {
      readonly kind: 'control';
      readonly wire: Exclude<SignalingWire, { type: 'signal-v1' }>;
      readonly signed: null;
    };

/** Relay 路徑 parser：signal-v1 在 shape gate 時解碼一次，room 驗證直接重用結果。 */
export function parseRelayWire(data: unknown): RelayWire | null {
  if (typeof data !== 'string') return null;
  if (new TextEncoder().encode(data).byteLength > MAX_WIRE_BYTES) return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>)['type'] === 'signal-v1'
  ) {
    const signed = decodeSignedSignalWire(candidate);
    if (signed === null) return null;
    return {
      kind: 'signal',
      wire: candidate as Extract<SignalingWire, { type: 'signal-v1' }>,
      signed,
    };
  }

  const wire = parseSignalingWire(data);
  if (wire === null || wire.type === 'signal-v1') return null;
  return { kind: 'control', wire, signed: null };
}
