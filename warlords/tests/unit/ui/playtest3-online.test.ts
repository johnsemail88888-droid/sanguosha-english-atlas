// Playtest round-3 ONLINE UI fixes: the rejoin record never ages out under a live guest
// session (ONL3: a drop 40 min after the join lost 重新加入 and the seat token); the
// loading screen counts a slow host's seconds (离开 / Esc: tests/e2e/ui-harness.spec.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { overrideLang } from '../../../src/ui/i18n';
import { REJOIN_MAX_AGE_MS, loadRejoin, refreshRejoin, saveRejoin } from '../../../src/ui/invite';
import { loadStageText, waitingForHost } from '../../../src/ui/screens/loading';

afterEach(() => overrideLang(null));

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

describe('ONL3: the loading screen while a slow host loads', () => {
  it('counts the seconds of the wait (from the first whole second)', () => {
    overrideLang('zh');
    expect(loadStageText('ready', 1, true, 0)).toBe('等待房主加载…');
    expect(loadStageText('ready', 1, true, 0.9)).toBe('等待房主加载…');
    expect(loadStageText('ready', 1, true, 23.7)).toBe('等待房主加载… 23 秒');
    expect(loadStageText('failed', 1, true, 535)).toBe('等待房主加载… 535 秒');
    // still building here: the progress, no counter
    expect(loadStageText('models', 0.62, true, 40)).toBe('点将列阵（载入模型）… 62%');
    expect(loadStageText('ready', 1, false, 40)).toBe('开战！ 100%');
    overrideLang('en');
    expect(loadStageText('ready', 1, true, 12)).toBe('Waiting for the host to load… 12 s');
  });

  it('waits for the host only once this page is ready and the host has not started the clock', () => {
    expect(waitingForHost('ready', true)).toBe(true);
    expect(waitingForHost('failed', true)).toBe(true);
    expect(waitingForHost('warmup', true)).toBe(false);
    expect(waitingForHost('ready', false)).toBe(false);
  });
});
