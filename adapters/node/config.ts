import { PEER_TIMEOUT_MS, RATE_LIMIT_PER_MIN } from '../../core/constants';

/** 定義 Node signaling 伺服器的監聽、限流與 TURN 設定。 */
export interface ServerConfig {
  readonly port: number;
  /**
   * 是否採信反向代理注入的 client IP 標頭。預設關閉：若無條件採信，
   * 任何人都能偽造標頭繞過限流。僅在代理確定會覆寫該標頭時才開啟。
   */
  readonly trustProxy: boolean;
  readonly rateLimitPerMin: number;
  readonly peerTimeoutMs: number;
  /** TURN REST 共享密鑰；與 turnUrls 皆備妥時才掛出 POST /turn-token 端點 */
  readonly turnSharedSecret?: string;
  /** 簽發 TurnToken 時原樣下發的 TURN 伺服器 URL 清單；僅接受 turn:／turns: 前綴 */
  readonly turnUrls: string[];
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** TURN_URLS：逗號分隔、逐項 trim、去空項；非 turn:／turns: 前綴屬設定錯誤，丟棄並警告一次。 */
function readTurnUrls(value: string | undefined): string[] {
  if (value === undefined) return [];
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const isTurnUrl = (item: string): boolean =>
    item.startsWith('turn:') || item.startsWith('turns:');
  const dropped = items.filter((item) => !isTurnUrl(item));
  if (dropped.length > 0)
    console.warn(`TURN_URLS 含非 turn:／turns: 前綴項，已丟棄：${dropped.join('、')}`);
  return items.filter(isTurnUrl);
}

/** 從環境載入並正規化 Node signaling 伺服器設定。 */
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const turnSharedSecret = env['TURN_SHARED_SECRET'];
  return {
    port: readInt(env['PORT'], 8080),
    trustProxy: env['TRUST_PROXY'] === 'true',
    rateLimitPerMin: readInt(env['RATE_LIMIT_PER_MIN'], RATE_LIMIT_PER_MIN),
    peerTimeoutMs: readInt(env['PEER_TIMEOUT_MS'], PEER_TIMEOUT_MS),
    // 空字串視同未設：值缺席時端點不掛，避免以空密鑰簽出人人可仿造的憑證
    turnSharedSecret:
      turnSharedSecret === undefined || turnSharedSecret === '' ? undefined : turnSharedSecret,
    turnUrls: readTurnUrls(env['TURN_URLS']),
  };
}
