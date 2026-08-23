/**
 * WebSocket signaling provider。所有相容端點共用 scoped v1 wire：
 * `GET /ws?room=<canonical-scope>`，server 只轉發帶 target 的點對點訊息。
 * WebSocket 工廠可注入測試假件；wire＝JSON（無二進位欄位）。
 */
import type {
  PeerId,
  Result,
  SignalMessage,
  Signature,
  SignalingProvider,
  SignalingSession,
} from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
import { Network } from '@open4wd/system-constants';
import { buildRegisterProof } from './register-auth';
import {
  decodeSignedSignalWire,
  isSignalingScope,
  signSignalEnvelope,
  verifySignalEnvelope,
} from './signal-envelope';
import type { SignalingWire } from './wire';
import { parseSignalingWire } from './wire-parser';
import { createSignalingSessionObservers } from './session-observers';

/** WebSocketSignalingProvider 所需的最小瀏覽器 socket 表面。 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** 單一 scoped WebSocket signaling 端點的工廠、優先序與身分設定。 */
export interface WsProviderConfig {
  /** scoped v1 provider 的穩定識別；providerName 僅供顯示相容。 */
  providerId?: string;
  /** 維運者可讀名稱；不代表不同協議或固定部署層級。 */
  providerName?: string;
  /** 越小越優先；由設定中的端點順序決定。 */
  priority: number;
  /** scope 通道 URL（如 `wss://…/ws?room=<canonical-scope>`） */
  wsUrl: (room: string) => string;
  createWebSocket: (url: string) => WebSocketLike;
  /** register 後等 room-state 的逾時（預設 HANDSHAKE_TIMEOUT_MS；測試可縮） */
  registerTimeoutMs?: number;
  /**
   * register 簽章埠（身分私鑰）：供給時每次 register 產 proof（簽 {peerId,
   * room, timestamp, nonce}）；server 驗無效即拒。未供給＝無 proof（server 政策裁）
   */
  sign?: (message: Uint8Array) => Promise<Signature> | Signature;
}

/** 使用帶簽章 signal-v1 wire 建立 scoped signaling session 的 WebSocket provider。 */
export class WebSocketSignalingProvider implements SignalingProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly priority: number;

  /** 連線後等待 server room-state 確認 register 的時間上限。 */
  private readonly registerTimeoutMs: number;

  constructor(
    /** 保存 WebSocket endpoint、逾時與健康檢查設定，建立後不在 session 間變更。 */ private readonly config: WsProviderConfig,
  ) {
    this.providerId = config.providerId ?? config.providerName ?? 'websocket';
    this.providerName = config.providerName ?? this.providerId;
    this.priority = config.priority;
    this.registerTimeoutMs = config.registerTimeoutMs ?? Network.signaling.HANDSHAKE_TIMEOUT_MS;
  }

  /** 開啟指定房間的 WebSocket 信令 session，驗證握手後隔離其訊息與關閉生命週期。 */
  async openSession(input: {
    readonly localPeerId: PeerId;
    readonly scope: string;
  }): Promise<Result<SignalingSession>> {
    if (!isSignalingScope(input.scope)) return err(new Error('signaling scope 無效'));
    const sign = this.config.sign;
    if (sign === undefined) return err(new Error('signaling session 缺少身分簽章埠'));

    const proof = await buildRegisterProof(input.localPeerId, input.scope, sign, Date.now());
    let socket: WebSocketLike;
    try {
      socket = this.config.createWebSocket(this.config.wsUrl(input.scope));
    } catch (error) {
      return err(new Error(`WebSocket 建立失敗: ${String(error)}`));
    }

    const registered = await new Promise<Result<Extract<SignalingWire, { type: 'room-state' }>>>(
      (resolve) => {
        let settled = false;
        const settle = (result: Result<Extract<SignalingWire, { type: 'room-state' }>>): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          socket.close();
          settle(err(new Error('signaling register 逾時')));
        }, this.registerTimeoutMs);
        socket.onerror = () => settle(err(new Error('WebSocket 連線錯誤')));
        socket.onclose = () => settle(err(new Error('WebSocket 提前關閉')));
        socket.onopen = () => {
          const register: SignalingWire = {
            type: 'register',
            sender: input.localPeerId,
            payload: { peerId: input.localPeerId, proof },
          };
          socket.send(JSON.stringify(register));
        };
        socket.onmessage = (event) => {
          const wire = parseSignalingWire(event.data);
          if (wire?.type === 'room-state') settle(ok(wire));
          else if (wire?.type === 'error')
            settle(err(new Error(`signaling 拒絕: ${wire.payload.code}`)));
        };
      },
    );
    if (!registered.ok) return registered;

    let open = true;
    const peers = new Set<PeerId>(registered.value.payload.peers);
    const joinedHandlers = new Set<(peer: PeerId) => void>();
    const leftHandlers = new Set<(peer: PeerId) => void>();
    const closeHandlers = new Set<() => void>();
    const handlers = new Set<
      (from: PeerId, message: SignalMessage, meta: { readonly nonce: string }) => void
    >();
    const seen = new Set<string>();
    const seenOrder: string[] = [];
    let explicitlyClosed = false;
    let closeNotified = false;
    const remember = (key: string): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      seenOrder.push(key);
      if (seenOrder.length > 4096) {
        const oldest = seenOrder.shift();
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    };
    const markUnexpectedClose = (): void => {
      open = false;
      if (explicitlyClosed || closeNotified) return;
      closeNotified = true;
      for (const handler of [...closeHandlers]) handler();
    };
    socket.onclose = markUnexpectedClose;
    socket.onerror = markUnexpectedClose;
    socket.onmessage = (event) => {
      const wire = parseSignalingWire(event.data);
      if (wire?.type === 'peer-joined') {
        if (!peers.has(wire.payload.peerId)) {
          peers.add(wire.payload.peerId);
          for (const handler of [...joinedHandlers]) handler(wire.payload.peerId);
        }
        return;
      }
      if (wire?.type === 'peer-left') {
        if (peers.delete(wire.payload.peerId))
          for (const handler of [...leftHandlers]) handler(wire.payload.peerId);
        return;
      }
      if (wire?.type !== 'signal-v1') return;
      const signed = decodeSignedSignalWire(wire);
      if (
        signed === null ||
        signed.payload.scope !== input.scope ||
        signed.payload.target !== input.localPeerId ||
        !verifySignalEnvelope(signed, Date.now()) ||
        !remember(`${signed.signer} ${wire.nonceHex}`)
      )
        return;
      for (const handler of [...handlers])
        handler(signed.signer, signed.payload.message, { nonce: wire.nonceHex });
    };

    const observers = createSignalingSessionObservers(
      { messages: handlers, joined: joinedHandlers, left: leftHandlers, close: closeHandlers },
      () => !open && closeNotified,
    );
    return ok({
      providerId: this.providerId,
      scope: input.scope,
      get peers() {
        return [...peers];
      },
      send: async (target, message) => {
        if (!open) return err(new Error('signaling session 已關閉'));
        try {
          const nonce = new Uint8Array(16);
          crypto.getRandomValues(nonce);
          const wire = await signSignalEnvelope(
            {
              scope: input.scope,
              target,
              message,
              now: Date.now(),
              nonce,
            },
            async (bytes) => new Uint8Array(await sign(bytes)),
            input.localPeerId,
          );
          socket.send(JSON.stringify(wire));
          return ok(undefined);
        } catch (error) {
          return err(new Error(`signaling 傳送失敗: ${String(error)}`));
        }
      },
      ...observers,
      isOpen: () => open,
      close: () => {
        if (explicitlyClosed) return Promise.resolve();
        explicitlyClosed = true;
        open = false;
        handlers.clear();
        joinedHandlers.clear();
        leftHandlers.clear();
        closeHandlers.clear();
        socket.close();
        return Promise.resolve();
      },
    });
  }

  /** 判斷 endpoint 設定與最近連線狀態是否仍允許建立新 session。 */
  async isHealthy(): Promise<boolean> {
    // scoped v1 不存在可安全探測的全域 lobby；真正可用性由 openSession 的有限重試判定。
    return true;
  }
}
