import { describe, expect, it } from 'vitest';
import { emptyRoom, orderedPeerIds } from './state';
import { step } from './room';
import { makeIdentity, makeRegisterRaw } from './test-support';
import {
  ERR_REGISTER_REJECTED,
  ERR_ROOM_FULL,
  ERR_SENDER_MISMATCH,
  ERR_SUPERSEDED,
  MAX_PEERS,
  TIMESTAMP_TOLERANCE_MS,
} from './constants';

const NOW = 1_700_000_000_000;

async function register(state = emptyRoom('lobby'), seed = 1, conn = 'c1', now = NOW) {
  const identity = makeIdentity(seed);
  const opened = step(state, { kind: 'connected', conn }, now);
  const raw = await makeRegisterRaw(identity, 'lobby', now);
  return { identity, result: step(opened.state, { kind: 'message', conn, raw }, now) };
}

describe('step —— register', () => {
  it('合法 register 回 room-state（含自己）並移出 pending', async () => {
    const { identity, result } = await register();
    expect(result.state.peers.size).toBe(1);
    expect(result.state.pending.size).toBe(0);
    const sent = result.effects.filter((e) => e.kind === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.wire.type).toBe('room-state');
    expect((sent[0]!.wire as { payload: { peers: string[] } }).payload.peers).toEqual([
      identity.peerId,
    ]);
  });

  it('第二人 register 使既有成員收到 peer-joined，且 peers 保留註冊序', async () => {
    const first = await register(emptyRoom('lobby'), 1, 'c1');
    const second = await register(first.result.state, 2, 'c2');
    expect(orderedPeerIds(second.result.state)).toEqual([
      first.identity.peerId,
      second.identity.peerId,
    ]);
    const joined = second.result.effects.filter(
      (e) => e.kind === 'send' && e.wire.type === 'peer-joined',
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.kind === 'send' && joined[0]!.conn).toBe('c1');
  });

  it('簽章無效即拒絕並關閉連線', async () => {
    const identity = makeIdentity(1);
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const raw = JSON.stringify({
      type: 'register',
      sender: identity.peerId,
      payload: {
        peerId: identity.peerId,
        proof: { timestamp: NOW, nonce: 'a'.repeat(32), signatureHex: 'b'.repeat(128) },
      },
    });
    const result = step(opened.state, { kind: 'message', conn: 'c1', raw }, NOW);
    expect(result.state.peers.size).toBe(0);
    expect(result.effects.some((e) => e.kind === 'close')).toBe(true);
  });

  it('sender 與 payload.peerId 不一致即拒絕（proof 仍合法，只綁 payload.peerId）', async () => {
    const alice = makeIdentity(1);
    const mallory = makeIdentity(2);
    const raw = await makeRegisterRaw(alice, 'lobby', NOW);
    const spoofed = JSON.parse(raw) as { sender: string };
    spoofed.sender = mallory.peerId;
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const result = step(
      opened.state,
      { kind: 'message', conn: 'c1', raw: JSON.stringify(spoofed) },
      NOW,
    );
    expect(result.state.peers.size).toBe(0);
    const errors = result.effects.filter((e) => e.kind === 'send' && e.wire.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]! as { wire: { payload: { code: string } } }).wire.payload.code).toBe(
      ERR_SENDER_MISMATCH,
    );
    expect(result.effects.some((e) => e.kind === 'close')).toBe(true);
  });

  it('同一 nonce 重放即拒絕', async () => {
    const identity = makeIdentity(1);
    const raw = await makeRegisterRaw(identity, 'lobby', NOW);
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const first = step(opened.state, { kind: 'message', conn: 'c1', raw }, NOW);
    const reopened = step(first.state, { kind: 'connected', conn: 'c2' }, NOW);
    const replay = step(reopened.state, { kind: 'message', conn: 'c2', raw }, NOW);
    expect(replay.state.peers.size).toBe(1);
    expect(replay.effects.some((e) => e.kind === 'close')).toBe(true);
  });

  it('時戳超出容忍窗即拒絕', async () => {
    const identity = makeIdentity(1);
    const raw = await makeRegisterRaw(identity, 'lobby', NOW);
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const late = step(opened.state, { kind: 'message', conn: 'c1', raw }, NOW + 31_000);
    expect(late.state.peers.size).toBe(0);
    expect(late.effects).toEqual([
      {
        kind: 'send',
        conn: 'c1',
        wire: { type: 'error', sender: 'server', payload: { code: ERR_REGISTER_REJECTED } },
      },
      { kind: 'close', conn: 'c1', code: ERR_REGISTER_REJECTED },
    ]);
  });

  it('時戳恰等於容忍窗上界仍接受（嚴格大於才拒絕）', async () => {
    const identity = makeIdentity(1);
    const raw = await makeRegisterRaw(identity, 'lobby', NOW);
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const result = step(
      opened.state,
      { kind: 'message', conn: 'c1', raw },
      NOW + TIMESTAMP_TOLERANCE_MS,
    );
    expect(result.state.peers.size).toBe(1);
  });

  it('房滿 64 人時第 65 人被拒，且錯誤碼為 room-full', async () => {
    let state = emptyRoom('lobby');
    for (let index = 0; index < MAX_PEERS; index++) {
      state = (await register(state, index + 1, `c${index}`)).result.state;
    }
    expect(state.peers.size).toBe(MAX_PEERS);
    const overflow = await register(state, 200, 'c-overflow');
    expect(overflow.result.state.peers.size).toBe(MAX_PEERS);
    const errors = overflow.result.effects.filter(
      (e) => e.kind === 'send' && e.wire.type === 'error',
    );
    expect(errors).toHaveLength(1);
    expect((errors[0]! as { wire: { payload: { code: string } } }).wire.payload.code).toBe(
      ERR_ROOM_FULL,
    );
  });
});

describe('step —— 重複 register 語意', () => {
  it('已註冊連線重送 register＝協定違規關閉', async () => {
    const alice = makeIdentity(1);
    let state = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'c1', raw: await makeRegisterRaw(alice, 'lobby', NOW) },
      NOW,
    ).state;
    const again = step(
      state,
      { kind: 'message', conn: 'c1', raw: await makeRegisterRaw(alice, 'lobby', NOW + 1_000) },
      NOW + 1_000,
    );
    expect(again.effects).toEqual([{ kind: 'close', conn: 'c1', code: ERR_REGISTER_REJECTED }]);
    expect(again.state.peers.size).toBe(1);
  });

  it('同 peerId 自新連線＝自我取代：原位保序、舊連線 superseded、只回 room-state 給新連線', async () => {
    const alice = makeIdentity(1);
    const bob = makeIdentity(2);
    let state = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'c1', raw: await makeRegisterRaw(alice, 'lobby', NOW) },
      NOW,
    ).state;
    state = step(state, { kind: 'connected', conn: 'c2' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'c2', raw: await makeRegisterRaw(bob, 'lobby', NOW) },
      NOW,
    ).state;
    state = step(state, { kind: 'connected', conn: 'c3' }, NOW + 5_000).state;
    const displaced = step(
      state,
      { kind: 'message', conn: 'c3', raw: await makeRegisterRaw(alice, 'lobby', NOW + 5_000) },
      NOW + 5_000,
    );
    expect([...displaced.state.peers.keys()]).toEqual(['c3', 'c2']);
    expect(orderedPeerIds(displaced.state)).toEqual([alice.peerId, bob.peerId]);
    expect(displaced.effects).toEqual([
      { kind: 'close', conn: 'c1', code: ERR_SUPERSEDED },
      {
        kind: 'send',
        conn: 'c3',
        wire: {
          type: 'room-state',
          sender: 'server',
          payload: { peers: [alice.peerId, bob.peerId] },
        },
      },
    ]);
  });

  it('房滿 64 時自我取代仍可行（不佔新名額）', async () => {
    let state = emptyRoom('lobby');
    for (let i = 1; i <= 64; i++) {
      const conn = `c${i}`;
      state = step(state, { kind: 'connected', conn }, NOW).state;
      state = step(
        state,
        { kind: 'message', conn, raw: await makeRegisterRaw(makeIdentity(i), 'lobby', NOW) },
        NOW,
      ).state;
    }
    state = step(state, { kind: 'connected', conn: 'c65' }, NOW + 5_000).state;
    const displaced = step(
      state,
      {
        kind: 'message',
        conn: 'c65',
        raw: await makeRegisterRaw(makeIdentity(7), 'lobby', NOW + 5_000),
      },
      NOW + 5_000,
    );
    expect(displaced.state.peers.size).toBe(64);
    expect(
      displaced.effects.some(
        (e) => e.kind === 'close' && e.conn === 'c7' && e.code === ERR_SUPERSEDED,
      ),
    ).toBe(true);
  });
});
