import {
  verifySignalEnvelope,
  verifyRegisterProof,
  type PeerId,
  type SignalingWire,
  type Timestamp,
} from './protocol';
import { parseRelayWire, type DecodedSignal } from './relay-wire';
import {
  ERR_LEFT,
  ERR_NOT_REGISTERED,
  ERR_PEER_TIMEOUT,
  ERR_REGISTER_REJECTED,
  ERR_REGISTER_TIMEOUT,
  ERR_ROOM_FULL,
  ERR_SENDER_MISMATCH,
  ERR_SUPERSEDED,
  ERR_TARGET_NOT_FOUND,
  MAX_PEERS,
  PEER_TIMEOUT_MS,
  REGISTER_DEADLINE_MS,
  SERVER_SENDER,
  TIMESTAMP_TOLERANCE_MS,
} from './constants';
import { nonceKey, orderedPeerIds, type ConnId, type PeerEntry, type RoomState } from './state';

/** 推進房間狀態機的一次外部輸入。 */
export type Input =
  | { kind: 'message'; conn: ConnId; raw: string }
  | { kind: 'connected'; conn: ConnId }
  | { kind: 'closed'; conn: ConnId }
  | { kind: 'alive'; conn: ConnId }
  | { kind: 'tick' };

/** 房間狀態機要求適配器執行的外部副作用。 */
export type Effect =
  | { kind: 'send'; conn: ConnId; wire: SignalingWire }
  | { kind: 'close'; conn: ConnId; code: string };

/** 狀態機推進後的新狀態與待執行副作用。 */
export interface StepResult {
  readonly state: RoomState;
  readonly effects: readonly Effect[];
}

/** 房間狀態機可由呼叫端調整的時間參數。 */
export interface StepOptions {
  /** 成員逾此毫秒未回報存活即由 tick 回收 */
  readonly peerTimeoutMs: number;
}

const DEFAULT_STEP_OPTIONS: StepOptions = { peerTimeoutMs: PEER_TIMEOUT_MS };
/** 單房 replay state 的 fail-closed 硬頂；正常項目會在 30 秒窗後由 tick 剪枝。 */
const SIGNAL_NONCE_MAX_ENTRIES = 65_536;

const server = SERVER_SENDER as PeerId;

function sendWire(conn: ConnId, wire: SignalingWire): Effect {
  return { kind: 'send', conn, wire };
}

function errorWire(code: string): SignalingWire {
  return { type: 'error', sender: server, payload: { code } };
}

function roomStateWire(state: RoomState): SignalingWire {
  return {
    type: 'room-state',
    sender: server,
    payload: { peers: orderedPeerIds(state) },
  };
}

function handleRegister(
  state: RoomState,
  conn: ConnId,
  wire: Extract<SignalingWire, { type: 'register' }>,
  now: Timestamp,
): StepResult {
  // 已註冊的連線重送 register＝協定違規：丟棄並關閉，不進入驗證
  if (state.peers.has(conn))
    return { state, effects: [{ kind: 'close', conn, code: ERR_REGISTER_REJECTED }] };

  const { peerId, proof } = wire.payload;

  // sender 為訊息封套宣告的身分、payload.peerId 為欲註冊的身分；proof 只綁後者，
  // 兩者不一致代表偽造封套或轉發錯置，須在驗 proof 前獨立擋下
  if (wire.sender !== peerId) return reject(state, conn, ERR_SENDER_MISMATCH);

  if (proof === undefined || !verifyRegisterProof(peerId, state.room, proof, now))
    return reject(state, conn, ERR_REGISTER_REJECTED);

  const key = nonceKey(peerId, proof.nonce);
  if (state.seenRegisterNonces.has(key)) return reject(state, conn, ERR_REGISTER_REJECTED);

  // 同 peerId 已在房＝自我取代（proof 綁私鑰，能取代者必為本人）：
  // 原位換鍵保序（房主仍是房主）、不佔新名額、對其餘成員不廣播
  const displacedConn = findConnByPeerId(state, peerId);
  if (displacedConn !== undefined) {
    const peers = new Map<ConnId, PeerEntry>();
    for (const [c, entry] of state.peers)
      if (c === displacedConn) peers.set(conn, { peerId, lastSeenAt: now });
      else peers.set(c, entry);
    const pending = new Map(state.pending);
    pending.delete(conn);
    const seenRegisterNonces = new Map(state.seenRegisterNonces);
    seenRegisterNonces.set(key, proof.timestamp);
    const next: RoomState = { ...state, peers, pending, seenRegisterNonces };
    return {
      state: next,
      effects: [
        { kind: 'close', conn: displacedConn, code: ERR_SUPERSEDED },
        sendWire(conn, roomStateWire(next)),
      ],
    };
  }

  if (state.peers.size >= MAX_PEERS) return reject(state, conn, ERR_ROOM_FULL);

  const peers = new Map(state.peers);
  peers.set(conn, { peerId, lastSeenAt: now });
  const pending = new Map(state.pending);
  pending.delete(conn);
  const seenRegisterNonces = new Map(state.seenRegisterNonces);
  seenRegisterNonces.set(key, proof.timestamp);
  const next: RoomState = { ...state, peers, pending, seenRegisterNonces };

  const effects: Effect[] = [sendWire(conn, roomStateWire(next))];
  for (const other of next.peers.keys())
    if (other !== conn)
      effects.push(sendWire(other, { type: 'peer-joined', sender: server, payload: { peerId } }));
  return { state: next, effects };
}

function findConnByPeerId(state: RoomState, peerId: PeerId): ConnId | undefined {
  for (const [conn, entry] of state.peers) if (entry.peerId === peerId) return conn;
  return undefined;
}

function handleRegistered(
  state: RoomState,
  conn: ConnId,
  entry: PeerEntry,
  wire: SignalingWire,
): StepResult {
  switch (wire.type) {
    case 'leave': {
      // 主動離房：broadcast peer-left 在前，接著伺服器主動關閉這條連線本身——
      // 否則連線既不在 peers 也不在 pending，永不被 tick 回收，形同殭屍連線
      const left = removePeer(state, conn);
      return {
        state: left.state,
        effects: [...left.effects, { kind: 'close', conn, code: ERR_LEFT }],
      };
    }
    default:
      return { state, effects: [] };
  }
}

function handleSignedSignal(
  state: RoomState,
  conn: ConnId,
  entry: PeerEntry,
  wire: Extract<SignalingWire, { type: 'signal-v1' }>,
  signed: DecodedSignal,
  now: Timestamp,
): StepResult {
  if (signed.payload.scope !== state.room || signed.signer !== entry.peerId)
    return { state, effects: [] };

  const key = nonceKey(signed.signer, wire.nonceHex);
  if (
    state.seenSignalNonces.has(key) ||
    state.seenSignalNonces.size >= SIGNAL_NONCE_MAX_ENTRIES ||
    !verifySignalEnvelope(signed, now)
  )
    return { state, effects: [] };

  const targetConn = findConnByPeerId(state, signed.payload.target);
  if (targetConn === undefined)
    return { state, effects: [sendWire(conn, errorWire(ERR_TARGET_NOT_FOUND))] };

  const seenSignalNonces = new Map(state.seenSignalNonces);
  seenSignalNonces.set(key, signed.timestamp);
  return {
    state: { ...state, seenSignalNonces },
    effects: [sendWire(targetConn, wire)],
  };
}

/** 移除一名已註冊成員並向其餘成員廣播 peer-left。 */
function removePeer(state: RoomState, conn: ConnId): StepResult {
  const entry = state.peers.get(conn);
  if (entry === undefined) {
    const pending = new Map(state.pending);
    pending.delete(conn);
    return { state: { ...state, pending }, effects: [] };
  }
  const peers = new Map(state.peers);
  peers.delete(conn);
  const next: RoomState = { ...state, peers };
  const effects: Effect[] = [...next.peers.keys()].map((other) =>
    sendWire(other, {
      type: 'peer-left',
      sender: server,
      payload: { peerId: entry.peerId },
    }),
  );
  return { state: next, effects };
}

/** 拒絕一次 register：回 error 並關閉連線，連線自 pending 移除。 */
function reject(state: RoomState, conn: ConnId, code: string): StepResult {
  const pending = new Map(state.pending);
  pending.delete(conn);
  return {
    state: { ...state, pending },
    effects: [sendWire(conn, errorWire(code)), { kind: 'close', conn, code }],
  };
}

/**
 * 協定核心。純函式：不做 I/O、不讀時鐘、不用隨機；同輸入必同輸出。
 * 現在時間一律由呼叫端傳入，使時間相關行為可被決定性測試。
 */
export function step(
  state: RoomState,
  input: Input,
  now: Timestamp,
  options: StepOptions = DEFAULT_STEP_OPTIONS,
): StepResult {
  switch (input.kind) {
    case 'connected': {
      const pending = new Map(state.pending);
      pending.set(input.conn, now);
      return { state: { ...state, pending }, effects: [] };
    }
    case 'closed':
      return removePeer(state, input.conn);
    case 'message': {
      const parsed = parseRelayWire(input.raw);
      if (parsed === null) return { state, effects: [] }; // 畸形靜默丟棄、不斷線
      const { wire } = parsed;
      if (wire.type === 'register') return handleRegister(state, input.conn, wire, now);

      // 規則一：未完成 register 的連線不得送出任何非 register 訊息
      const entry = state.peers.get(input.conn);
      if (entry === undefined) return reject(state, input.conn, ERR_NOT_REGISTERED);

      // 規則二：訊息身分必須等於連線綁定的 PeerId——signal-v1 以簽章 signer 綁連線
      // （shape gate 已解碼，handleSignedSignal 直接重用驗證路徑）；其餘 wire 比對封套
      // sender，不符即靜默丟棄。
      if (parsed.kind === 'signal')
        return handleSignedSignal(state, input.conn, entry, parsed.wire, parsed.signed, now);
      if (parsed.wire.sender !== entry.peerId) return { state, effects: [] };

      return handleRegistered(state, input.conn, entry, parsed.wire);
    }
    case 'alive': {
      const entry = state.peers.get(input.conn);
      if (entry === undefined) return { state, effects: [] };
      const peers = new Map(state.peers);
      peers.set(input.conn, { ...entry, lastSeenAt: now });
      return { state: { ...state, peers }, effects: [] };
    }
    case 'tick': {
      let next = state;
      const effects: Effect[] = [];

      // 規則三：逾 REGISTER_DEADLINE_MS 仍未 register 的 pending 連線於 tick 關閉
      const pending = new Map(next.pending);
      for (const [conn, connectedAt] of next.pending)
        if (now - connectedAt > REGISTER_DEADLINE_MS) {
          pending.delete(conn);
          effects.push({ kind: 'close', conn, code: ERR_REGISTER_TIMEOUT });
        }
      next = { ...next, pending };

      for (const [conn, entry] of [...next.peers])
        if (now - entry.lastSeenAt > options.peerTimeoutMs) {
          const removed = removePeer(next, conn);
          next = removed.state;
          effects.push(...removed.effects, { kind: 'close', conn, code: ERR_PEER_TIMEOUT });
        }

      const seenRegisterNonces = new Map(next.seenRegisterNonces);
      for (const [key, timestamp] of next.seenRegisterNonces)
        if (now - timestamp > TIMESTAMP_TOLERANCE_MS) seenRegisterNonces.delete(key);
      const seenSignalNonces = new Map(next.seenSignalNonces);
      for (const [key, timestamp] of next.seenSignalNonces)
        if (now - timestamp > TIMESTAMP_TOLERANCE_MS) seenSignalNonces.delete(key);
      next = { ...next, seenRegisterNonces, seenSignalNonces };

      return { state: next, effects };
    }
    default:
      return { state, effects: [] };
  }
}
