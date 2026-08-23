/**
 * Cloudflare runtime 的最小結構型介面。
 *
 * 這些型別刻意只描述 adapter 實際使用的 API；之後由 `wrangler types` 產生的完整
 * runtime 宣告會在 dry-run 階段驗證相容性，而單元測試可用真正 SQLite 包裝器代入。
 */
export interface SqlCursor<T extends Record<string, unknown>> {
  toArray(): T[];
}

/** 列舉 Durable Object SQL binding 接受的純量值。 */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** 定義 adapter 使用的最小 Durable Object SQL 執行介面。 */
export interface DurableObjectSqlStorage {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** 定義具同步交易與 alarm 的 Durable Object 儲存介面。 */
export interface DurableObjectStorage {
  readonly sql: DurableObjectSqlStorage;
  transactionSync<T>(callback: () => T): T;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** 定義 Cloudflare 可休眠 WebSocket 所需的最小操作。 */
export interface HibernatableWebSocket {
  send(message: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
}

/** 定義具持久儲存的 Durable Object 執行環境。 */
export interface StatefulDurableObjectContext {
  readonly storage: DurableObjectStorage;
}

/** 擴充房間物件所需的 WebSocket 接受與恢復操作。 */
export interface RoomDurableObjectContext extends StatefulDurableObjectContext {
  acceptWebSocket(socket: HibernatableWebSocket): void;
  getWebSockets(): HibernatableWebSocket[];
}

/** 定義從 namespace 取得的 Durable Object 呼叫替身。 */
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/** 定義依名稱解析 Durable Object 替身的最小 namespace。 */
export interface DurableObjectNamespace {
  getByName(name: string): DurableObjectStub;
}

/** 公版不含官方值；正式 binding 由營運者 fork 的 secrets／variables 注入。 */
export interface WorkerEnv {
  readonly INTERNAL_HMAC_SECRET?: string;
  readonly ADMISSION_LIMIT_PER_MIN?: string;
  readonly TURN_SHARED_SECRET?: string;
  readonly TURN_URLS?: string;
  readonly TURN_RATE_LIMIT_PER_MIN?: string;
  readonly ROOMS?: DurableObjectNamespace;
  readonly ADMISSION?: DurableObjectNamespace;
  readonly TOKEN_ISSUERS?: DurableObjectNamespace;
}
