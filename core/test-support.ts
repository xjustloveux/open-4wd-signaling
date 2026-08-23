/** 測試用：以 Ed25519 私鑰產生合法的 register wire JSON 字串。 */
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  buildRegisterProof,
  publicKeyToPeerId,
  signSignalEnvelope,
  type PeerId,
  type SignalMessage,
  type Signature,
} from './protocol';

export interface TestIdentity {
  readonly peerId: PeerId;
  readonly privateKey: Uint8Array;
}

export function makeIdentity(seedByte: number): TestIdentity {
  const privateKey = new Uint8Array(32).fill(seedByte);
  return { peerId: publicKeyToPeerId(ed25519.getPublicKey(privateKey)), privateKey };
}

export async function makeRegisterRaw(
  identity: TestIdentity,
  room: string,
  now: number,
): Promise<string> {
  const proof = await buildRegisterProof(
    identity.peerId,
    room,
    (message) => ed25519.sign(message, identity.privateKey) as Signature,
    now,
  );
  return JSON.stringify({
    type: 'register',
    sender: identity.peerId,
    payload: { peerId: identity.peerId, proof },
  });
}

export async function makeSignedSignalRaw(input: {
  readonly identity: TestIdentity;
  readonly scope: string;
  readonly target: PeerId;
  readonly message: SignalMessage;
  readonly now: number;
  readonly nonceByte?: number;
}): Promise<string> {
  return JSON.stringify(
    await signSignalEnvelope(
      {
        scope: input.scope,
        target: input.target,
        message: input.message,
        now: input.now,
        nonce: new Uint8Array(16).fill(input.nonceByte ?? 1),
      },
      (message) => Promise.resolve(ed25519.sign(message, input.identity.privateKey) as Signature),
      input.identity.peerId,
    ),
  );
}
