import { isSignalingScope, type PeerId } from '../../core/protocol';

/** 保存 Durable Object 休眠後恢復連線所需的最小狀態。 */
export interface SocketAttachment {
  readonly version: 1;
  readonly connId: string;
  readonly scope: string;
  readonly peerId: PeerId | null;
  readonly connectedAt: number;
  readonly lastAliveAt: number;
  readonly messageRateCount: number;
  readonly messageRateWindowStart: number;
}

const ATTACHMENT_KEYS = [
  'version',
  'connId',
  'scope',
  'peerId',
  'connectedAt',
  'lastAliveAt',
  'messageRateCount',
  'messageRateWindowStart',
] as const;

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

const hasValidBase = (record: Record<string, unknown>): boolean =>
  typeof record['connId'] === 'string' &&
  record['connId'].length > 0 &&
  record['connId'].length <= 128 &&
  isSignalingScope(record['scope']) &&
  (record['peerId'] === null ||
    (typeof record['peerId'] === 'string' && record['peerId'].length > 0)) &&
  Number.isSafeInteger(record['connectedAt']) &&
  Number.isSafeInteger(record['lastAliveAt']);

/** 驗證並解析目前版本的 WebSocket attachment。 */
export function parseSocketAttachment(value: unknown): SocketAttachment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasValidBase(record)) return null;

  const connectedAt = record['connectedAt'] as number;
  if (
    record['version'] !== 1 ||
    !hasExactKeys(record, ATTACHMENT_KEYS) ||
    !Number.isSafeInteger(record['messageRateCount']) ||
    (record['messageRateCount'] as number) < 0 ||
    !Number.isSafeInteger(record['messageRateWindowStart']) ||
    (record['messageRateWindowStart'] as number) < 0
  )
    return null;

  return {
    version: 1,
    connId: record['connId'] as string,
    scope: record['scope'] as string,
    peerId: record['peerId'] as PeerId | null,
    connectedAt,
    lastAliveAt: record['lastAliveAt'] as number,
    messageRateCount: record['messageRateCount'] as number,
    messageRateWindowStart: record['messageRateWindowStart'] as number,
  };
}
