/**
 * vendored 協定檔所需的最小型別集。定義逐字對應上游 brands 與 interfaces，
 * 但本檔屬本 repo 自有（非 vendored），不受 hash 檢查。
 */
export type PeerId = string & { __brand: 'PeerId' };
/** 已編碼的數位簽章位元組。 */
export type Signature = Uint8Array & { __brand: 'Signature' };
/** 協定訊息使用的 Unix 毫秒時戳。 */
export type Timestamp = number;

/** 將負載、簽署者與防重播資料綁定的簽章封套。 */
export interface SignedPayload<T> {
  readonly payload: T;
  readonly timestamp: Timestamp;
  readonly nonce: Uint8Array;
  readonly signer: PeerId;
  readonly signature: Signature;
}

/** 簽章演算法所需的公開金鑰與私密金鑰。 */
export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** 以判別欄位表示成功值或失敗原因的結果型別。 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
/** 建立成功結果。 */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
/** 建立失敗結果。 */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * 握手三型子集（點對點轉發用，扁平結構）；wire 協議另有完整型別（含 sender／target／
 * payload 包裝），provider 負責兩者互轉，故此處刻意不與 wire 同形，以免循環匯入。
 */
export type SignalMessage =
  | { type: 'sdp-offer'; sdp: string }
  | { type: 'sdp-answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit };

/** 解除事件訂閱的函式。 */
export type Unsubscribe = () => void;

/** 單一 signaling scope 內可收送訊息的連線工作階段。 */
export interface SignalingSession {
  readonly providerId: string;
  readonly scope: string;
  readonly peers?: readonly PeerId[];
  send(target: PeerId, message: SignalMessage): Promise<Result<void>>;
  onMessage(
    handler: (from: PeerId, message: SignalMessage, meta: { readonly nonce: string }) => void,
  ): Unsubscribe;
  onPeerJoined?(handler: (peer: PeerId) => void): Unsubscribe;
  onPeerLeft?(handler: (peer: PeerId) => void): Unsubscribe;
  /** 傳輸層存活狀態；只有舊版或測試介面可以省略。 */
  isOpen?(): boolean;
  /** 非預期的傳輸層關閉；明確呼叫 close() 時不得觸發。 */
  onClose?(handler: () => void): Unsubscribe;
  close(): Promise<void>;
}

/** 建立 signaling 工作階段的可替換提供者介面。 */
export interface SignalingProvider {
  readonly providerId: string;
  readonly priority: number;
  openSession(input: {
    readonly localPeerId: PeerId;
    readonly scope: string;
  }): Promise<Result<SignalingSession>>;
  isHealthy(): Promise<boolean>;
}
