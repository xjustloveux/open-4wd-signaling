import { isSignalingScope } from '../../core/protocol';
import { AdmissionLimiterDurableObject } from './admission-object';
import type { WorkerEnv } from './env';
import { createInternalAuthToken, INTERNAL_AUTH_HEADER, opaqueBucket } from './rate-limit';
import { RoomDurableObject } from './room-object';
import { TokenIssuerDurableObject } from './token-object';

const MAX_TURN_BODY_BYTES = 4_096;
const INTERNAL_TIME_HEADER = 'x-open4wd-internal-time';

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

async function admission(
  env: WorkerEnv,
  bucket: string,
  now: number,
): Promise<'allowed' | 'denied' | 'unavailable'> {
  const secret = env.INTERNAL_HMAC_SECRET;
  const namespace = env.ADMISSION;
  if (secret === undefined || secret === '' || namespace === undefined) return 'unavailable';
  const request = new Request('https://internal/consume', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INTERNAL_AUTH_HEADER]: await createInternalAuthToken({
        secret,
        purpose: 'admission',
        bucket,
        now,
      }),
      [INTERNAL_TIME_HEADER]: String(now),
    },
    body: JSON.stringify({ bucket }),
  });
  const response = await namespace.getByName(bucket).fetch(request);
  if (!response.ok) return 'unavailable';
  try {
    const body = (await response.json()) as { allowed?: unknown };
    return body.allowed === true ? 'allowed' : 'denied';
  } catch {
    return 'unavailable';
  }
}

function clientIp(request: Request): string | null {
  const value = request.headers.get('CF-Connecting-IP');
  return value === null || value.trim() === '' ? null : value.trim();
}

async function routeWebSocket(request: Request, env: WorkerEnv, now: number): Promise<Response> {
  const url = new URL(request.url);
  const scope = url.searchParams.get('room');
  const ip = clientIp(request);
  if (
    request.method !== 'GET' ||
    request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
    scope === null ||
    !isSignalingScope(scope)
  )
    return json(400, { error: 'invalid-websocket-request' });
  if (ip === null) return json(403, { error: 'client-ip-unavailable' });
  if (
    env.INTERNAL_HMAC_SECRET === undefined ||
    env.INTERNAL_HMAC_SECRET === '' ||
    env.ROOMS === undefined
  )
    return json(503, { error: 'not-configured' });

  const bucket = await opaqueBucket(env.INTERNAL_HMAC_SECRET, 'ip', ip);
  const admitted = await admission(env, bucket, now);
  if (admitted === 'denied') return json(429, { error: 'rate-limited' });
  if (admitted === 'unavailable') return json(503, { error: 'admission-unavailable' });
  return env.ROOMS.getByName(scope).fetch(request);
}

async function routeTurnToken(request: Request, env: WorkerEnv, now: number): Promise<Response> {
  if (
    env.INTERNAL_HMAC_SECRET === undefined ||
    env.INTERNAL_HMAC_SECRET === '' ||
    env.TURN_SHARED_SECRET === undefined ||
    env.TURN_SHARED_SECRET === '' ||
    env.TURN_URLS === undefined ||
    env.TURN_URLS.trim() === '' ||
    env.TOKEN_ISSUERS === undefined
  )
    return json(404, { error: 'not-found' });
  const ip = clientIp(request);
  if (ip === null) return json(403, { error: 'client-ip-unavailable' });

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_TURN_BODY_BYTES)
    return json(413, { error: 'body-too-large' });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_TURN_BODY_BYTES)
    return json(413, { error: 'body-too-large' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid-request' });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, 'peerId') ||
    !Object.hasOwn(parsed, 'proof') ||
    typeof (parsed as Record<string, unknown>)['peerId'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['proof'] !== 'object' ||
    (parsed as Record<string, unknown>)['proof'] === null
  )
    return json(400, { error: 'invalid-request' });

  const publicBody = parsed as { peerId: string; proof: unknown };
  const ipBucket = await opaqueBucket(env.INTERNAL_HMAC_SECRET, 'ip', ip);
  // IP limiter 與 peer-sharded issuer 分離：多 PeerId 仍共用同一 opaque IP bucket。
  const admitted = await admission(env, `turn:${ipBucket}`, now);
  if (admitted === 'denied') return json(429, { error: 'rate-limited' });
  if (admitted === 'unavailable') return json(503, { error: 'admission-unavailable' });

  const peerBucket = await opaqueBucket(env.INTERNAL_HMAC_SECRET, 'peer', publicBody.peerId);
  const internal = new Request('https://internal/issue', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INTERNAL_AUTH_HEADER]: await createInternalAuthToken({
        secret: env.INTERNAL_HMAC_SECRET,
        purpose: 'turn-token',
        bucket: ipBucket,
        now,
      }),
      [INTERNAL_TIME_HEADER]: String(now),
    },
    body: JSON.stringify({ ...publicBody, bucket: ipBucket }),
  });
  return env.TOKEN_ISSUERS.getByName(peerBucket).fetch(internal);
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === '/ws') return routeWebSocket(request, env, now);
    if (url.pathname === '/turn-token' && request.method === 'POST')
      return routeTurnToken(request, env, now);
    return json(404, { error: 'not-found' });
  },
};

export default worker;
export { AdmissionLimiterDurableObject, RoomDurableObject, TokenIssuerDurableObject };
