/**
 * 部署後 smoke：連線 → 送出簽章 register → 收到 room-state 即通過。
 * 用法：tsx scripts/smoke.ts wss://signal.example.org
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import { buildRegisterProof, publicKeyToPeerId, type Signature } from '../core/protocol';
import { SIGNALING_SMOKE_SCOPE, signalingSmokeUrl } from './smoke-lib';

const base = process.argv[2];
if (base === undefined) {
  console.error('用法：tsx scripts/smoke.ts <wss base url>');
  process.exit(2);
}

const privateKey = new Uint8Array(32).fill(7);
const peerId = publicKeyToPeerId(ed25519.getPublicKey(privateKey));
const room = SIGNALING_SMOKE_SCOPE;
let target: string;
try {
  target = signalingSmokeUrl(base, room);
} catch (error) {
  console.error(`smoke 失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const socket = new WebSocket(target);

const timer = setTimeout(() => {
  console.error('smoke 失敗：逾時未收到 room-state');
  process.exit(1);
}, 15_000);

socket.on('open', async () => {
  const proof = await buildRegisterProof(
    peerId,
    room,
    (message) => ed25519.sign(message, privateKey) as Signature,
    Date.now(),
  );
  socket.send(JSON.stringify({ type: 'register', sender: peerId, payload: { peerId, proof } }));
});

socket.on('message', (data) => {
  const wire = JSON.parse(data.toString()) as { type: string };
  if (wire.type !== 'room-state') return;
  clearTimeout(timer);
  console.log('smoke 通過');
  socket.close();
  process.exit(0);
});

socket.on('error', (error) => {
  console.error(`smoke 失敗：${error.message}`);
  process.exit(1);
});
