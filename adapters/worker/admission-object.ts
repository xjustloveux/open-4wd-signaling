import { RATE_LIMIT_PER_MIN } from '../../core/constants';
import type { StatefulDurableObjectContext, WorkerEnv } from './env';
import {
  consumeDurableRate,
  ensureRateLimitSchema,
  INTERNAL_AUTH_HEADER,
  verifyInternalAuthToken,
} from './rate-limit';

function configuredLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : RATE_LIMIT_PER_MIN;
}

/** 以 Durable Object 持久限流房間准入請求。 */
export class AdmissionLimiterDurableObject {
  constructor(
    private readonly ctx: StatefulDurableObjectContext,
    private readonly env: WorkerEnv,
    private readonly now: () => number = Date.now,
  ) {
    ensureRateLimitSchema(ctx.storage.sql);
  }

  /** 對單一不透明 bucket 原子消耗一次准入配額。 */
  consume(bucket: string, limit = configuredLimit(this.env.ADMISSION_LIMIT_PER_MIN)): boolean {
    return consumeDurableRate(this.ctx.storage, bucket, this.now(), limit);
  }

  /** 驗證內部 HMAC 後處理准入限流請求。 */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'not-found' }, { status: 404 });
    const secret = this.env.INTERNAL_HMAC_SECRET;
    if (secret === undefined || secret === '')
      return Response.json({ error: 'not-configured' }, { status: 503 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid-request' }, { status: 400 });
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>)['bucket'] !== 'string'
    )
      return Response.json({ error: 'invalid-request' }, { status: 400 });
    const bucket = (body as { bucket: string }).bucket;
    const now = this.now();
    if (
      !(await verifyInternalAuthToken({
        token: request.headers.get(INTERNAL_AUTH_HEADER),
        secret,
        purpose: 'admission',
        bucket,
        now,
      }))
    )
      return Response.json({ error: 'forbidden' }, { status: 403 });
    return Response.json({ allowed: this.consume(bucket) });
  }
}
