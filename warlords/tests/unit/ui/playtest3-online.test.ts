// Playtest round-3 ONLINE UI fixes: the rejoin record never ages out under a live guest
// session (ONL3: a drop 40 min after the join lost 重新加入 and the seat token).
import { describe, expect, it } from 'vitest';
import { REJOIN_MAX_AGE_MS, loadRejoin, refreshRejoin, saveRejoin } from '../../../src/ui/invite';

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('ONL3: the rejoin record lives as long as the guest session', () => {
  const joined = { code: 'YKP6Z', mode: 'ws' as const, net: {} };
  const t0 = 1_000_000_000;

  it('a record dated at the join ages out; refreshed from the live session it is offered again, dated now', () => {
    const st = new MemStore();
    saveRejoin(joined, st, t0);
    const late = t0 + REJOIN_MAX_AGE_MS + 10 * 60_000; // a drop 40 min into the session
    expect(loadRejoin(st, late)).toBeNull();
    const r = refreshRejoin(joined, st, late);
    expect(r).toEqual({ ...joined, at: late });
    // stored again: F5 / the online screen's 重新加入 find it too
    expect(loadRejoin(st, late + 1000)).toEqual({ ...joined, at: late });
  });

  it('without a live session: only a young stored record', () => {
    const st = new MemStore();
    saveRejoin(joined, st, t0);
    expect(refreshRejoin(null, st, t0 + 60_000)).toMatchObject({ code: 'YKP6Z', mode: 'ws', at: t0 });
    expect(refreshRejoin(null, st, t0 + REJOIN_MAX_AGE_MS + 1)).toBeNull();
    // (and nothing was written)
    expect(loadRejoin(st, t0)).toMatchObject({ at: t0 });
  });
});
