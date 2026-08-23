import { describe, expect, it } from 'vitest';
import { emptyRoom } from './state';
import { step } from './room';
import { makeIdentity, makeRegisterRaw } from './test-support';

const NOW = 1_700_000_000_000;
const ROOM_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('step —— 觀戰與入房查詢', () => {
  it.each(['join-request', 'join-as-spectator'] as const)(
    '協定外的 signaling 訊息型別 %s 靜默丟棄',
    async (type) => {
      const alice = makeIdentity(1);
      let state = step(emptyRoom('r1'), { kind: 'connected', conn: 'a' }, NOW).state;
      state = step(
        state,
        { kind: 'message', conn: 'a', raw: await makeRegisterRaw(alice, 'r1', NOW) },
        NOW,
      ).state;

      const result = step(
        state,
        {
          kind: 'message',
          conn: 'a',
          raw: JSON.stringify({ type, sender: alice.peerId, payload: { roomId: ROOM_ID } }),
        },
        NOW,
      );

      expect(result.effects).toEqual([]);
    },
  );

  it('match-request 經 WS 靜默丟棄', async () => {
    const alice = makeIdentity(1);
    let state = step(emptyRoom('r1'), { kind: 'connected', conn: 'a' }, NOW).state;
    state = step(
      state,
      { kind: 'message', conn: 'a', raw: await makeRegisterRaw(alice, 'r1', NOW) },
      NOW,
    ).state;
    const raw = JSON.stringify({
      type: 'match-request',
      sender: alice.peerId,
      payload: { trueSkillMu: 25000, trueSkillSigma: 8333 },
    });
    const result = step(state, { kind: 'message', conn: 'a', raw }, NOW);
    expect(result.effects).toEqual([]);
  });
});
