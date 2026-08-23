import type { PeerId, Timestamp } from './protocol';

/** 適配器指派的連線識別；核心不認識底層 socket。 */
export type ConnId = string;

/** 房間內已註冊節點的身分與存活資訊。 */
export interface PeerEntry {
  readonly peerId: PeerId;
  /** 最近一次由適配器回報存活的時間 */
  readonly lastSeenAt: Timestamp;
}

/** 單一房間的完整、不可變狀態快照。 */
export interface RoomState {
  readonly room: string;
  /** 插入序即註冊序，首項為房主。順序是安全相依，不得重排。 */
  readonly peers: ReadonlyMap<ConnId, PeerEntry>;
  /** 已連線但尚未完成 register 的連線；值為連線建立時間 */
  readonly pending: ReadonlyMap<ConnId, Timestamp>;
  /** 已用過的 register 證明，鍵為 `${peerId} ${nonce}`，值為證明時戳（供剪枝） */
  readonly seenRegisterNonces: ReadonlyMap<string, Timestamp>;
  /** 已驗證並轉發的 signal envelope；與 register nonce 分域，避免 key 意外碰撞。 */
  readonly seenSignalNonces: ReadonlyMap<string, Timestamp>;
}

/** 建立尚無連線與防重播紀錄的房間狀態。 */
export function emptyRoom(room: string): RoomState {
  return {
    room,
    peers: new Map(),
    pending: new Map(),
    seenRegisterNonces: new Map(),
    seenSignalNonces: new Map(),
  };
}

/** 房間可回收的判定：無成員且無等待中的連線 */
export function isRoomEmpty(state: RoomState): boolean {
  return state.peers.size === 0 && state.pending.size === 0;
}

/** 依註冊序回傳成員 PeerId；首項為房主 */
export function orderedPeerIds(state: RoomState): PeerId[] {
  return [...state.peers.values()].map((entry) => entry.peerId);
}

/** 建立含節點身分的 nonce 索引鍵，避免不同節點的值互相碰撞。 */
export function nonceKey(peerId: PeerId, nonce: string): string {
  return `${peerId} ${nonce}`;
}
