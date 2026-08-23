import { describe, expect, it } from 'vitest';
import { emptyRoom } from './state';
import { step } from './room';
import { makeIdentity, makeRegisterRaw, makeSignedSignalRaw } from './test-support';
import { REGISTER_DEADLINE_MS } from './constants';

const NOW = 1_700_000_000_000;
const ROOM = 'room:123e4567-e89b-42d3-a456-426614174000';

describe('step —— 安全規則', () => {
  it('規則一：未 register 的連線送 signed offer 即被丟棄並關閉', async () => {
    const attacker = makeIdentity(1);
    const victim = makeIdentity(2);
    const opened = step(emptyRoom(ROOM), { kind: 'connected', conn: 'c1' }, NOW);
    const raw = await makeSignedSignalRaw({
      identity: attacker,
      scope: ROOM,
      target: victim.peerId,
      message: { type: 'sdp-offer', sdp: 'v=0' },
      now: NOW,
    });
    const result = step(opened.state, { kind: 'message', conn: 'c1', raw }, NOW);
    expect(result.effects.some((e) => e.kind === 'close')).toBe(true);
  });

  it('規則二：sender 與綁定 PeerId 不符即丟棄', async () => {
    const alice = makeIdentity(1);
    const bob = makeIdentity(2);
    let state = step(emptyRoom(ROOM), { kind: 'connected', conn: 'c1' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'c1', raw: await makeRegisterRaw(alice, ROOM, NOW) },
      NOW,
    ).state;
    state = step(state, { kind: 'connected', conn: 'c2' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'c2', raw: await makeRegisterRaw(bob, ROOM, NOW) },
      NOW,
    ).state;

    // c1 已綁定 alice，卻送出 bob 私鑰簽署的 envelope
    const spoofed = await makeSignedSignalRaw({
      identity: bob,
      scope: ROOM,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'v=0' },
      now: NOW,
    });
    const result = step(state, { kind: 'message', conn: 'c1', raw: spoofed }, NOW);
    expect(result.effects).toEqual([]);
  });

  it('規則三：逾 REGISTER_DEADLINE_MS 未 register 的連線於 tick 被關閉', () => {
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const ticked = step(opened.state, { kind: 'tick' }, NOW + REGISTER_DEADLINE_MS + 1);
    expect(ticked.state.pending.size).toBe(0);
    expect(ticked.effects.some((e) => e.kind === 'close')).toBe(true);
  });

  it('規則三：未逾期的 pending 連線不受影響', () => {
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, NOW);
    const ticked = step(opened.state, { kind: 'tick' }, NOW + REGISTER_DEADLINE_MS - 1);
    expect(ticked.state.pending.size).toBe(1);
    expect(ticked.effects).toEqual([]);
  });
});
