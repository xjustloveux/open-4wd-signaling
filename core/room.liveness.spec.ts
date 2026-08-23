import { describe, expect, it } from 'vitest';
import { emptyRoom } from './state';
import { step } from './room';
import { makeIdentity, makeRegisterRaw } from './test-support';
import { ERR_PEER_TIMEOUT, PEER_TIMEOUT_MS, TIMESTAMP_TOLERANCE_MS } from './constants';

const NOW = 1_700_000_000_000;

async function onePeerRoom(now = NOW) {
  const alice = makeIdentity(1);
  let state = step(emptyRoom('lobby'), { kind: 'connected', conn: 'a' }, now).state;
  state = step(
    state,
    { kind: 'message', conn: 'a', raw: await makeRegisterRaw(alice, 'lobby', now) },
    now,
  ).state;
  return { alice, state };
}

describe('step —— liveness', () => {
  it('alive 更新 lastSeenAt', async () => {
    const { state } = await onePeerRoom();
    const later = step(state, { kind: 'alive', conn: 'a' }, NOW + 5_000);
    expect(later.state.peers.get('a')!.lastSeenAt).toBe(NOW + 5_000);
    expect(later.effects).toEqual([]);
  });

  it('alive 作用於尚未 register 的連線＝no-op（不誤建 peer）', () => {
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const result = step(opened.state, { kind: 'alive', conn: 'c1' }, NOW + 1_000);
    expect(result.state.pending.size).toBe(1);
    expect(result.state.pending.get('c1')).toBe(NOW);
    expect(result.effects).toEqual([]);
    expect(result.state.peers.size).toBe(0);
  });

  it('逾 PEER_TIMEOUT_MS 未回報存活即被回收', async () => {
    const { alice, state } = await onePeerRoom();
    const ticked = step(state, { kind: 'tick' }, NOW + PEER_TIMEOUT_MS + 1);
    expect(ticked.state.peers.size).toBe(0);
    expect(
      ticked.effects.some(
        (e) => e.kind === 'close' && e.conn === 'a' && e.code === ERR_PEER_TIMEOUT,
      ),
    ).toBe(true);
    void alice;
  });

  it('同一 tick 內多名逾時者一併回收，存活者收到對應的 peer-left', async () => {
    const alice = makeIdentity(1);
    const bob = makeIdentity(2);
    const carol = makeIdentity(3);
    let state = step(emptyRoom('lobby'), { kind: 'connected', conn: 'a' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'a', raw: await makeRegisterRaw(alice, 'lobby', NOW) },
      NOW,
    ).state;
    state = step(state, { kind: 'connected', conn: 'b' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'b', raw: await makeRegisterRaw(bob, 'lobby', NOW) },
      NOW,
    ).state;
    state = step(state, { kind: 'connected', conn: 'c' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'c', raw: await makeRegisterRaw(carol, 'lobby', NOW) },
      NOW,
    ).state;
    // 只有 c 續命；a、b 同一 tick 一併逾時
    state = step(state, { kind: 'alive', conn: 'c' }, NOW + PEER_TIMEOUT_MS).state;
    const ticked = step(state, { kind: 'tick' }, NOW + PEER_TIMEOUT_MS + 1);
    expect(ticked.state.peers.size).toBe(1);
    const closes = ticked.effects.filter((e) => e.kind === 'close');
    expect(closes).toHaveLength(2);
    expect(closes.every((e) => e.kind === 'close' && e.code === ERR_PEER_TIMEOUT)).toBe(true);
    const leftToC = ticked.effects.filter(
      (e) => e.kind === 'send' && e.conn === 'c' && e.wire.type === 'peer-left',
    );
    expect(leftToC).toHaveLength(2);
  });

  it('回收會向其餘成員廣播 peer-left', async () => {
    const alice = makeIdentity(1);
    const bob = makeIdentity(2);
    let state = step(emptyRoom('lobby'), { kind: 'connected', conn: 'a' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'a', raw: await makeRegisterRaw(alice, 'lobby', NOW) },
      NOW,
    ).state;
    state = step(state, { kind: 'connected', conn: 'b' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'b', raw: await makeRegisterRaw(bob, 'lobby', NOW) },
      NOW,
    ).state;
    // b 持續存活，a 不再回報
    state = step(state, { kind: 'alive', conn: 'b' }, NOW + PEER_TIMEOUT_MS).state;
    const ticked = step(state, { kind: 'tick' }, NOW + PEER_TIMEOUT_MS + 1);
    expect(ticked.state.peers.size).toBe(1);
    const left = ticked.effects.filter((e) => e.kind === 'send' && e.wire.type === 'peer-left');
    expect(left).toHaveLength(1);
    expect(left[0]!.kind === 'send' && left[0]!.conn).toBe('b');
  });

  it('tick 剪枝超出時戳窗的 nonce', async () => {
    const { state } = await onePeerRoom();
    expect(state.seenRegisterNonces.size).toBe(1);
    const kept = step(state, { kind: 'alive', conn: 'a' }, NOW + TIMESTAMP_TOLERANCE_MS);
    const ticked = step(kept.state, { kind: 'tick' }, NOW + TIMESTAMP_TOLERANCE_MS + 1);
    expect(ticked.state.seenRegisterNonces.size).toBe(0);
  });

  it('自訂 peerTimeoutMs 生效於回收判定', async () => {
    const { state } = await onePeerRoom();
    const ticked = step(state, { kind: 'tick' }, NOW + 1_001, { peerTimeoutMs: 1_000 });
    expect(ticked.state.peers.size).toBe(0);
  });
});
