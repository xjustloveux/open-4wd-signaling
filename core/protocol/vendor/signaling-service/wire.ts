/**
 * signaling server wire 協議 — client↔server 的完整訊息 union（≠ interfaces 的
 * SignalMessage＝握手 3 型子集）。server 純轉發、不存長期狀態；連線建立後雙方
 * 直接 P2P、signaling 不再參與。Quick Match 只消費 rooms discovery，不進此協定。
 */
import type { PeerId } from '@open4wd/interfaces';
import type { RegisterProof } from './register-auth';
import type { SignedSignalWire } from './signal-envelope';

/** signaling server 接受與送出的封閉 JSON 訊息聯集。 */
export type SignalingWire =
  /**
   * 連上第一則：登記後 server 回 room-state（現有成員）並廣播 peer-joined。
   * proof＝身分簽章證明（簽 {peerId, room, timestamp, nonce}；server 驗章＋
   * 時戳窗＋nonce 去重、無效即拒——未簽 register 可冒名任意 PeerId 劫持轉發）
   */
  | { type: 'register'; sender: PeerId; payload: { peerId: PeerId; proof?: RegisterProof } }
  | SignedSignalWire
  /** 房間成員快照；觀戰來源由已驗 RoomSession 本地選擇，不由 signaling 指定。 */
  | { type: 'room-state'; sender: PeerId; payload: { peers: PeerId[] } }
  | { type: 'peer-joined'; sender: PeerId; payload: { peerId: PeerId } }
  | { type: 'peer-left'; sender: PeerId; payload: { peerId: PeerId } }
  | { type: 'leave'; sender: PeerId; payload: Record<string, never> }
  | { type: 'error'; sender: PeerId; payload: { code: string; message?: string } };

/** 可用於 parser 分派的所有 signaling wire 判別字。 */
export type SignalingWireType = SignalingWire['type'];
