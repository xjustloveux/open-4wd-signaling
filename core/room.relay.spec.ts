import { describe, expect, it } from 'vitest';
import { emptyRoom } from './state';
import { step } from './room';
import { makeIdentity, makeRegisterRaw, makeSignedSignalRaw } from './test-support';
import { ERR_LEFT, ERR_TARGET_NOT_FOUND } from './constants';

const NOW = 1_700_000_000_000;
const ROOM = 'room:123e4567-e89b-42d3-a456-426614174000';

async function twoPeerRoom() {
  const alice = makeIdentity(1);
  const bob = makeIdentity(2);
  let state = emptyRoom(ROOM);
  state = step(state, { kind: 'connected', conn: 'a' }, NOW).state;
  state = step(
    state,
    { kind: 'message', conn: 'a', raw: await makeRegisterRaw(alice, ROOM, NOW) },
    NOW,
  ).state;
  state = step(state, { kind: 'connected', conn: 'b' }, NOW).state;
  state = step(
    state,
    { kind: 'message', conn: 'b', raw: await makeRegisterRaw(bob, ROOM, NOW) },
    NOW,
  ).state;
  return { alice, bob, state };
}

describe('step —— 轉發', () => {
  it('sdp-offer 轉發給 target 所在連線', async () => {
    const { alice, bob, state } = await twoPeerRoom();
    const raw = await makeSignedSignalRaw({
      identity: alice,
      scope: ROOM,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'v=0' },
      now: NOW,
    });
    const result = step(state, { kind: 'message', conn: 'a', raw }, NOW);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({ kind: 'send', conn: 'b' });
    // 轉發不改寫、不上鎖：送出的 wire 須與收到的原始 JSON 逐位元相同
    expect((result.effects[0] as { wire: unknown }).wire).toEqual(JSON.parse(raw));
  });

  it('target 不存在回 target-not-found 給發送者', async () => {
    const { alice, state } = await twoPeerRoom();
    const nobody = makeIdentity(3);
    const raw = await makeSignedSignalRaw({
      identity: alice,
      scope: ROOM,
      target: nobody.peerId,
      message: { type: 'ice-candidate', candidate: { candidate: 'x' } },
      now: NOW,
    });
    const result = step(state, { kind: 'message', conn: 'a', raw }, NOW);
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0]!;
    expect(effect.kind === 'send' && effect.conn).toBe('a');
    expect(effect.kind === 'send' && effect.wire.type).toBe('error');
    expect(
      effect.kind === 'send' && (effect.wire as { payload: { code: string } }).payload.code,
    ).toBe(ERR_TARGET_NOT_FOUND);
  });

  it('連線關閉使其餘成員收到 peer-left', async () => {
    const { alice, state } = await twoPeerRoom();
    const result = step(state, { kind: 'closed', conn: 'a' }, NOW);
    expect(result.state.peers.size).toBe(1);
    const left = result.effects.filter((e) => e.kind === 'send' && e.wire.type === 'peer-left');
    expect(left).toHaveLength(1);
    expect(left[0]!.kind === 'send' && left[0]!.conn).toBe('b');
    expect(
      left[0]!.kind === 'send' && (left[0]!.wire as { payload: { peerId: string } }).payload.peerId,
    ).toBe(alice.peerId);
  });

  it('leave 等同連線關閉，且伺服器主動關閉該連線（不留殭屍連線）', async () => {
    const { alice, state } = await twoPeerRoom();
    const raw = JSON.stringify({ type: 'leave', sender: alice.peerId, payload: {} });
    const result = step(state, { kind: 'message', conn: 'a', raw }, NOW);
    expect(result.state.peers.has('a')).toBe(false);
    expect(result.effects.some((e) => e.kind === 'send' && e.wire.type === 'peer-left')).toBe(true);
    expect(result.effects).toContainEqual({ kind: 'close', conn: 'a', code: ERR_LEFT });
  });

  it('被自我取代的舊連線其後 closed＝no-op（不減員、不發 peer-left）', async () => {
    const { alice, state } = await twoPeerRoom();
    let s = step(state, { kind: 'connected', conn: 'a2' }, NOW + 5_000).state;
    s = step(
      s,
      { kind: 'message', conn: 'a2', raw: await makeRegisterRaw(alice, ROOM, NOW + 5_000) },
      NOW + 5_000,
    ).state;
    const closedOld = step(s, { kind: 'closed', conn: 'a' }, NOW + 6_000);
    expect(closedOld.state.peers.size).toBe(2);
    expect(closedOld.effects).toEqual([]);
  });

  it('同一 signed envelope 只轉發一次，且不可跨 scope 重放', async () => {
    const { alice, bob, state } = await twoPeerRoom();
    const raw = await makeSignedSignalRaw({
      identity: alice,
      scope: ROOM,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'offer' },
      now: NOW,
      nonceByte: 9,
    });

    const first = step(state, { kind: 'message', conn: 'a', raw }, NOW);
    expect(first.effects).toEqual([{ kind: 'send', conn: 'b', wire: JSON.parse(raw) }]);
    expect(step(first.state, { kind: 'message', conn: 'a', raw }, NOW).effects).toEqual([]);

    const otherRoom = { ...state, room: 'room:123e4567-e89b-42d3-b456-426614174001' };
    expect(step(otherRoom, { kind: 'message', conn: 'a', raw }, NOW).effects).toEqual([]);
  });
});
