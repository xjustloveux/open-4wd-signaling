import { isSignalingScope } from '../core/protocol';

export const SIGNALING_SMOKE_SCOPE = 'room:123e4567-e89b-42d3-a456-426614174000';

export function signalingSmokeUrl(base: string, scope: string = SIGNALING_SMOKE_SCOPE): string {
  if (!isSignalingScope(scope)) throw new TypeError('canonical signaling scope required');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new TypeError('invalid signaling base URL');
  }
  if (
    (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
    parsed.hostname.length === 0 ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new TypeError('invalid signaling base URL');
  return `${parsed.origin}/ws?room=${encodeURIComponent(scope)}`;
}
