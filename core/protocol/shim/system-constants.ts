/** vendored register-auth 讀取的時戳容忍窗；值須與客戶端一致。 */
export const Protocol = {
  security: {
    P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC: 30,
    P2P_MESSAGE_NONCE_BYTES: 16,
    ED25519_SIGNATURE_BYTES: 64,
  },
} as const;

/** vendored ws-provider 讀取的連線握手常數；值須與客戶端一致。 */
export const Network = {
  signaling: {
    HANDSHAKE_TIMEOUT_MS: 30_000,
    TURN_TOKEN_TTL_SEC: 300,
    RETRY_MAX: 3,
    RETRY_BACKOFF_MS: [1000, 2000, 4000] as readonly number[],
  },
} as const;
