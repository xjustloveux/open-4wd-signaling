/**
 * 最小 barrel —— vendored register-auth 以 '../key-manager' 匯入這兩個函式。
 * 本檔屬本 repo 自有（shim），不受 hash 檢查；ed25519.ts 才是 vendored 檔。
 */
export {
  deriveKeyPair,
  peerIdToPublicKey,
  publicKeyToPeerId,
  signMessage,
  verifyMessage,
} from './ed25519';
export { buildSignedMessage, verifySignedPayload } from './signed-payload';
