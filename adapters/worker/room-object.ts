import {
  ERR_REGISTER_REJECTED,
  MESSAGE_RATE_LIMIT_PER_MIN,
  TIMESTAMP_TOLERANCE_MS,
} from '../../core/constants';
import { checkRate } from '../../core/rate-limit';
import { step, type Effect } from '../../core/room';
import {
  emptyRoom,
  isRoomEmpty,
  nonceKey,
  type ConnId,
  type PeerEntry,
  type RoomState,
} from '../../core/state';
import { isSignalingScope, type PeerId, type Timestamp } from '../../core/protocol';
import type { HibernatableWebSocket, RoomDurableObjectContext, WorkerEnv } from './env';
import { parseSocketAttachment, type SocketAttachment } from './socket-state';

interface PeerRow extends Record<string, unknown> {
  conn_id: string;
  peer_id: string;
  registration_order: number;
}

interface NonceRow extends Record<string, unknown> {
  signer: string;
  nonce_hex: string;
  timestamp: number;
}

const CLOSE_POLICY_VIOLATION = 1008;
const TICK_INTERVAL_MS = 5_000;

interface RuntimeWebSocketPair {
  readonly 0: HibernatableWebSocket;
  readonly 1: HibernatableWebSocket;
}

declare const WebSocketPair: new () => RuntimeWebSocketPair;

function splitNonceKey(key: string): [string, string] {
  const separator = key.lastIndexOf(' ');
  if (separator <= 0 || separator === key.length - 1)
    throw new TypeError('invalid persisted nonce key');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function asMessageText(message: string | ArrayBuffer): string | null {
  if (typeof message === 'string') return message;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(message);
  } catch {
    return null;
  }
}

function samePeerProjection(
  before: ReadonlyMap<ConnId, PeerEntry>,
  after: ReadonlyMap<ConnId, PeerEntry>,
): boolean {
  if (before.size !== after.size) return false;
  const beforeEntries = [...before];
  const afterEntries = [...after];
  return beforeEntries.every(
    ([connId, peer], index) =>
      connId === afterEntries[index]?.[0] && peer.peerId === afterEntries[index]?.[1].peerId,
  );
}

/**
 * 每個 instance 對應一個 canonical signaling scope。
 *
 * WebSocket attachment 保存喚醒所需的連線資料；註冊順序與 replay nonce 使用 SQLite，
 * 所以 isolate 被回收後仍能 fail-closed。SQL 永不保存 SDP、ICE 或 TURN credential。
 */
export class RoomDurableObject {
  /** 依連線識別保存目前喚醒行程內的 WebSocket 物件。 */
  private readonly sockets = new Map<ConnId, HibernatableWebSocket>();
  /** 保存目前房間狀態；尚無有效連線時為空值。 */
  private state: RoomState | null = null;

  constructor(
    private readonly ctx: RoomDurableObjectContext,
    readonly env: WorkerEnv,
    private readonly now: () => number = Date.now,
  ) {
    this.createSchema();
    this.restore();
    this.scheduleAlarm();
  }

  /** 驗證 WebSocket upgrade 與房間 scope 後接受新連線。 */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const scope = url.searchParams.get('room');
    if (
      request.method !== 'GET' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
      scope === null ||
      !isSignalingScope(scope)
    )
      return new Response(null, { status: 400 });
    if (this.state !== null && this.state.room !== scope)
      return new Response(null, { status: 409 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.acceptSocket(server, scope, crypto.randomUUID(), this.now());
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: HibernatableWebSocket });
  }

  /**
   * 由 fetch upgrade 路徑呼叫；公開成 adapter operation，讓單元測試不必模擬
   * Node 不支援的 HTTP 101 Response。
   */
  acceptSocket(
    socket: HibernatableWebSocket,
    scope: string,
    connId: string,
    connectedAt = this.now(),
  ): void {
    const currentScope = this.state?.room;
    if (
      !Number.isSafeInteger(connectedAt) ||
      connId.length === 0 ||
      connId.length > 128 ||
      !isSignalingScope(scope) ||
      (currentScope !== undefined && currentScope !== scope)
    ) {
      socket.close(CLOSE_POLICY_VIOLATION, ERR_REGISTER_REJECTED);
      return;
    }

    const attachment: SocketAttachment = {
      version: 1,
      connId,
      scope,
      peerId: null,
      connectedAt,
      lastAliveAt: connectedAt,
      messageRateCount: 0,
      messageRateWindowStart: connectedAt,
    };
    socket.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(socket);
    this.sockets.set(connId, socket);

    const before = this.state ?? emptyRoom(scope);
    this.state = step(before, { kind: 'connected', conn: connId }, connectedAt as Timestamp).state;
    this.scheduleAlarm();
  }

  /** 將已喚醒 WebSocket 訊息交由核心狀態機處理並持久化。 */
  webSocketMessage(socket: HibernatableWebSocket, message: string | ArrayBuffer): void {
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    const raw = asMessageText(message);
    if (attachment === null || raw === null || this.state?.room !== attachment.scope) return;

    const now = this.now() as Timestamp;
    const messageRate = checkRate(
      {
        count: attachment.messageRateCount,
        windowStart: attachment.messageRateWindowStart,
      },
      now,
      MESSAGE_RATE_LIMIT_PER_MIN,
    );
    const rateAttachment: SocketAttachment = {
      ...attachment,
      messageRateCount: messageRate.window.count,
      messageRateWindowStart: messageRate.window.windowStart,
    };
    socket.serializeAttachment(rateAttachment);
    if (!messageRate.allowed) return;

    const alive = step(this.state, { kind: 'alive', conn: attachment.connId }, now).state;
    socket.serializeAttachment({ ...rateAttachment, lastAliveAt: now });

    const result = step(alive, { kind: 'message', conn: attachment.connId, raw }, now);
    if (!this.persistTransition(alive, result.state)) return;
    this.state = result.state;
    this.refreshAttachments();
    this.deliver(result.effects);
    this.scheduleAlarm();
  }

  /** 在 WebSocket 正常關閉時移除連線並更新房間狀態。 */
  webSocketClose(socket: HibernatableWebSocket): void {
    this.removeSocket(socket);
  }

  /** 在 WebSocket 錯誤時移除連線並更新房間狀態。 */
  webSocketError(socket: HibernatableWebSocket): void {
    this.removeSocket(socket);
  }

  /** Cloudflare alarm handler：喚醒後執行核心 tick，回收未註冊或失聯的連線。 */
  alarm(): void {
    if (this.state === null) return;
    const now = this.now() as Timestamp;
    const before = this.state;
    let present = before;
    const runtimeSockets = new Map<
      ConnId,
      { socket: HibernatableWebSocket; attachment: SocketAttachment }
    >();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseSocketAttachment(socket.deserializeAttachment());
      if (
        attachment !== null &&
        attachment.scope === before.room &&
        !runtimeSockets.has(attachment.connId)
      )
        runtimeSockets.set(attachment.connId, { socket, attachment });
    }
    for (const connId of before.peers.keys()) {
      const live = runtimeSockets.get(connId);
      if (live === undefined) continue;
      present = step(present, { kind: 'alive', conn: connId }, now).state;
      live.socket.serializeAttachment({ ...live.attachment, lastAliveAt: now });
    }
    const result = step(present, { kind: 'tick' }, now);
    if (!this.persistTransition(before, result.state)) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM register_nonce WHERE expires_at < ?', now);
      this.ctx.storage.sql.exec('DELETE FROM signal_nonce WHERE expires_at < ?', now);
    });
    this.state = result.state;
    this.refreshAttachments();
    this.deliver(result.effects);
    this.scheduleAlarm();
  }

  /** 建立房間連線與重放 nonce 所需的持久資料表。 */
  private createSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room_peer (
        conn_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL UNIQUE,
        registration_order INTEGER NOT NULL UNIQUE
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS register_nonce (
        signer TEXT NOT NULL,
        nonce_hex TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (signer, nonce_hex)
      )
    `);
    sql.exec('CREATE INDEX IF NOT EXISTS register_nonce_expiry ON register_nonce(expires_at)');
    sql.exec(`
      CREATE TABLE IF NOT EXISTS signal_nonce (
        signer TEXT NOT NULL,
        nonce_hex TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (signer, nonce_hex)
      )
    `);
    sql.exec('CREATE INDEX IF NOT EXISTS signal_nonce_expiry ON signal_nonce(expires_at)');
  }

  /** 從 WebSocket attachments 與 SQL 恢復可驗證的房間狀態。 */
  private restore(): void {
    const now = this.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM register_nonce WHERE expires_at < ?', now);
      this.ctx.storage.sql.exec('DELETE FROM signal_nonce WHERE expires_at < ?', now);
    });

    const attachments = new Map<
      ConnId,
      {
        socket: HibernatableWebSocket;
        attachment: SocketAttachment;
      }
    >();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseSocketAttachment(socket.deserializeAttachment());
      if (attachment === null || attachments.has(attachment.connId)) {
        socket.close(CLOSE_POLICY_VIOLATION, ERR_REGISTER_REJECTED);
        continue;
      }
      attachments.set(attachment.connId, { socket, attachment });
    }
    if (attachments.size === 0) return;

    const scopes = new Set([...attachments.values()].map(({ attachment }) => attachment.scope));
    if (scopes.size !== 1) {
      for (const { socket } of attachments.values())
        socket.close(CLOSE_POLICY_VIOLATION, ERR_REGISTER_REJECTED);
      return;
    }
    const scope = scopes.values().next().value;
    if (typeof scope !== 'string') return;

    const peers = new Map<ConnId, PeerEntry>();
    const peerRows = this.ctx.storage.sql
      .exec<PeerRow>(
        'SELECT conn_id, peer_id, registration_order FROM room_peer ORDER BY registration_order',
      )
      .toArray();
    const livePeerConnections = new Set<string>();
    for (const row of peerRows) {
      const live = attachments.get(row.conn_id);
      if (
        live === undefined ||
        live.attachment.scope !== scope ||
        live.attachment.peerId !== row.peer_id
      )
        continue;
      peers.set(row.conn_id, {
        peerId: row.peer_id as PeerId,
        lastSeenAt: live.attachment.lastAliveAt as Timestamp,
      });
      livePeerConnections.add(row.conn_id);
    }

    const stalePeerRows = peerRows.filter((row) => !livePeerConnections.has(row.conn_id));
    if (stalePeerRows.length > 0)
      this.ctx.storage.transactionSync(() => {
        for (const row of stalePeerRows)
          this.ctx.storage.sql.exec('DELETE FROM room_peer WHERE conn_id = ?', row.conn_id);
      });

    const pending = new Map<ConnId, Timestamp>();
    for (const [connId, live] of attachments) {
      if (live.attachment.peerId === null)
        pending.set(connId, live.attachment.connectedAt as Timestamp);
      else if (!livePeerConnections.has(connId)) {
        live.socket.close(CLOSE_POLICY_VIOLATION, ERR_REGISTER_REJECTED);
        continue;
      }
      this.sockets.set(connId, live.socket);
    }

    const seenRegisterNonces = this.loadNonces('register_nonce');
    const seenSignalNonces = this.loadNonces('signal_nonce');
    this.state = { room: scope, peers, pending, seenRegisterNonces, seenSignalNonces };
  }

  /** 從指定資料表載入未到期的重放 nonce。 */
  private loadNonces(table: 'register_nonce' | 'signal_nonce'): Map<string, Timestamp> {
    const rows = this.ctx.storage.sql
      .exec<NonceRow>(`SELECT signer, nonce_hex, timestamp FROM ${table}`)
      .toArray();
    return new Map(
      rows.map((row) => [
        nonceKey(row.signer as PeerId, row.nonce_hex),
        row.timestamp as Timestamp,
      ]),
    );
  }

  /**
   * 先持久化再送 effect；唯一鍵衝突時整筆 transition fail-closed，不會先把訊息轉發。
   */
  private persistTransition(before: RoomState, after: RoomState): boolean {
    try {
      this.ctx.storage.transactionSync(() => {
        this.persistNewNonces(
          'register_nonce',
          before.seenRegisterNonces,
          after.seenRegisterNonces,
        );
        this.persistNewNonces('signal_nonce', before.seenSignalNonces, after.seenSignalNonces);

        if (!samePeerProjection(before.peers, after.peers)) {
          this.ctx.storage.sql.exec('DELETE FROM room_peer');
          let order = 0;
          for (const [connId, peer] of after.peers) {
            this.ctx.storage.sql.exec(
              'INSERT INTO room_peer (conn_id, peer_id, registration_order) VALUES (?, ?, ?)',
              connId,
              peer.peerId,
              order,
            );
            order += 1;
          }
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 僅持久化狀態轉移新加入的 nonce，讓唯一鍵負責重放防護。 */
  private persistNewNonces(
    table: 'register_nonce' | 'signal_nonce',
    before: ReadonlyMap<string, Timestamp>,
    after: ReadonlyMap<string, Timestamp>,
  ): void {
    for (const [key, timestamp] of after) {
      if (before.has(key)) continue;
      const [signer, nonceHex] = splitNonceKey(key);
      this.ctx.storage.sql.exec(
        `INSERT INTO ${table} (signer, nonce_hex, timestamp, expires_at) VALUES (?, ?, ?, ?)`,
        signer,
        nonceHex,
        timestamp,
        timestamp + TIMESTAMP_TOLERANCE_MS,
      );
    }
  }

  /** 將目前 peer 身分投影回所有有效 WebSocket attachments。 */
  private refreshAttachments(): void {
    if (this.state === null) return;
    for (const [connId, socket] of this.sockets) {
      const attachment = parseSocketAttachment(socket.deserializeAttachment());
      if (attachment === null) continue;
      socket.serializeAttachment({
        ...attachment,
        peerId: this.state.peers.get(connId)?.peerId ?? null,
      });
    }
  }

  /** 將核心狀態機產生的傳送或關閉效果交付至對應連線。 */
  private deliver(effects: readonly Effect[]): void {
    for (const effect of effects) {
      const socket = this.sockets.get(effect.conn);
      if (socket === undefined) continue;
      if (effect.kind === 'send') socket.send(JSON.stringify(effect.wire));
      else socket.close(CLOSE_POLICY_VIOLATION, effect.code);
    }
  }

  /** 從執行期與持久狀態移除指定 WebSocket。 */
  private removeSocket(socket: HibernatableWebSocket): void {
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    if (attachment === null || this.state === null) return;
    this.sockets.delete(attachment.connId);
    const result = step(
      this.state,
      { kind: 'closed', conn: attachment.connId },
      this.now() as Timestamp,
    );
    if (!this.persistTransition(this.state, result.state)) return;
    this.state = result.state;
    this.deliver(result.effects);
  }

  /** 在房間非空時排程下一次逾時回收 alarm。 */
  private scheduleAlarm(): void {
    if (this.state === null || isRoomEmpty(this.state)) return;
    void this.ctx.storage.setAlarm(this.now() + TICK_INTERVAL_MS);
  }
}
