import type { SignalingWire } from './wire';
import { decodeSignedSignalWire } from './signal-envelope';

const MAX_WIRE_BYTES = 256 * 1024;
const MAX_ID = 256;
const MAX_PEERS = 64;
const MAX_MESSAGE = 4096;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max = MAX_ID): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max = MAX_ID): boolean =>
  value === undefined || text(value, max);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** 不信任 signaling JSON 的完整 runtime shape gate。 */
export function parseSignalingWire(data: unknown): SignalingWire | null {
  if (typeof data !== 'string') return null;
  const raw = data;
  if (new TextEncoder().encode(raw).byteLength > MAX_WIRE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const wire = record(parsed);
  if (wire === null || !text(wire['type'])) return null;
  if (wire['type'] === 'signal-v1')
    return decodeSignedSignalWire(wire) === null ? null : (wire as unknown as SignalingWire);
  if (!text(wire['sender'])) return null;
  const payload = record(wire['payload']);
  if (payload === null) return null;
  switch (wire['type']) {
    case 'register':
      if (!text(payload['peerId'])) return null;
      if (payload['proof'] !== undefined) {
        const proof = record(payload['proof']);
        if (
          proof === null ||
          !finite(proof['timestamp']) ||
          !text(proof['nonce']) ||
          !text(proof['signatureHex'], MAX_MESSAGE)
        )
          return null;
      }
      break;
    case 'room-state':
      if (
        !Array.isArray(payload['peers']) ||
        payload['peers'].length > MAX_PEERS ||
        !payload['peers'].every((peer) => text(peer)) ||
        payload['recommendedSource'] !== undefined
      )
        return null;
      break;
    case 'peer-joined':
    case 'peer-left':
      if (!text(payload['peerId'])) return null;
      break;
    case 'error':
      if (!text(payload['code']) || !optionalText(payload['message'], MAX_MESSAGE)) return null;
      break;
    case 'leave':
      break;
    default:
      return null;
  }
  return wire as unknown as SignalingWire;
}
