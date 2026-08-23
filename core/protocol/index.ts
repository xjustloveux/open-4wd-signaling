/**
 * 協定層唯一對外入口。全 repo 只從此檔 import，不得直接引用 vendor/ 下的檔案。
 * 上游日後若發布套件，只需把下列 re-export 換成套件路徑、刪除 vendor 目錄。
 */
export type { SignalingWire, SignalingWireType } from './vendor/signaling-service/wire';
export { parseSignalingWire } from './vendor/signaling-service/wire-parser';
export {
  decodeSignedSignalWire,
  isSignalingScope,
  normalizeSignalMessage,
  signSignalEnvelope,
  verifySignalEnvelope,
  type NormalizedSignalMessage,
  type SignalEnvelope,
  type SignedSignalWire,
  type SignSignalEnvelopeInput,
} from './vendor/signaling-service/signal-envelope';
export {
  buildRegisterProof,
  verifyRegisterProof,
  type RegisterProof,
} from './vendor/signaling-service/register-auth';
export type { PeerId, SignalMessage, Signature, Timestamp } from './shim/interfaces';
export { Protocol } from './shim/system-constants';
export { publicKeyToPeerId } from './vendor/key-manager/ed25519';
