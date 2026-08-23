import { describe, expect, it } from 'vitest';
import { emptyRoom, isRoomEmpty } from './state';
import { step } from './room';

describe('step —— 連線生命週期', () => {
  it('connected 把連線放進 pending、不產生 effect', () => {
    const result = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, 1_000);
    expect(result.state.pending.get('c1')).toBe(1_000);
    expect(result.state.peers.size).toBe(0);
    expect(result.effects).toEqual([]);
  });

  it('closed 移除尚未 register 的連線、不廣播', () => {
    const opened = step(emptyRoom('lobby'), { kind: 'connected', conn: 'c1' }, 1_000);
    const closed = step(opened.state, { kind: 'closed', conn: 'c1' }, 2_000);
    expect(isRoomEmpty(closed.state)).toBe(true);
    expect(closed.effects).toEqual([]);
  });

  it('不變異傳入的 state', () => {
    const original = emptyRoom('lobby');
    step(original, { kind: 'connected', conn: 'c1' }, 1_000);
    expect(original.pending.size).toBe(0);
  });
});
