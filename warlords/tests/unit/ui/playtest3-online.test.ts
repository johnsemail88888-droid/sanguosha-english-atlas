// Playtest round-3 ONLINE UI fixes: the rejoin record never ages out under a live guest
// session (ONL3: a drop 40 min after the join lost 重新加入 and the seat token); the
// loading screen counts a slow host's seconds (离开 / Esc: tests/e2e/ui-harness.spec.ts); a
// long wait for the host gets its own, correctly timed chat line (the order of the chat
// lines: tests/e2e/ui-harness.spec.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_UNREACHABLE_KEY, WAITING_HOST_KEY } from '../../../src/net/clientSession';
import { LinkStatus, TROUBLE_LOG_AFTER, outageText, type StatusMsg } from '../../../src/ui/hud/connstatus';
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

// the exact lines src/net/clientSession.ts emits
const WAITING: StatusMsg = { zh: '等待房主响应…', en: 'Waiting for host…', key: WAITING_HOST_KEY };
const BACK: StatusMsg = { zh: '房主已恢复响应', en: 'Host is responding again', key: WAITING_HOST_KEY, clear: true };
const LOST: StatusMsg = { zh: '连接中断，正在重新连接…', en: 'Connection lost — reconnecting…' };
const REJOINED: StatusMsg = { zh: '已重新连接', en: 'Reconnected' };
const UNREACHABLE_BACK: StatusMsg = { zh: '已重新连接', en: 'Reconnected', key: HOST_UNREACHABLE_KEY, clear: true };

describe('ONL3: 房主已恢复响应（中断 N 秒） tells the real length of the wait', () => {
  it('a wait the HUD never logged (the guest was on the loading screen) gets one line when it ends, with its whole length', () => {
    const s = new LinkStatus();
    // 04:14:05 the host goes silent; the HUD is not running (no update() calls) until 04:23:00
    expect(s.push(WAITING, 845).chat).toBeNull();
    const back = s.push(BACK, 845 + 535);
    expect(back.chat).toEqual({ key: 'link-1', zh: '房主已恢复响应（中断 8 分 55 秒）', en: 'Host is responding again (after 8 min 55 s)' });
    // the next, short episode stays a chip (MP2-7) and never borrows the long one's line
    s.push(WAITING, 2000);
    expect(s.push(BACK, 2004).chat).toBeNull();
  });

  it('a short freeze is still only the chip; a logged one keeps its line, updated in place', () => {
    const s = new LinkStatus();
    s.push(WAITING, 0);
    expect(s.push(BACK, TROUBLE_LOG_AFTER - 1).chat).toBeNull();
    s.push(WAITING, 100);
    expect(s.update(100 + TROUBLE_LOG_AFTER).chat).toEqual({ key: 'link-2', zh: '等待房主响应…', en: 'Waiting for host…' });
    expect(s.push(BACK, 100 + 75).chat).toEqual({ key: 'link-2', zh: '房主已恢复响应（中断 1 分 15 秒）', en: 'Host is responding again (after 1 min 15 s)' });
  });

  it('a reconnect, a rejoin that could not find the host: the same wording of the length', () => {
    const s = new LinkStatus();
    expect(s.push(LOST, 10).chat?.zh).toBe(LOST.zh);
    expect(s.push(REJOINED, 43).chat?.zh).toBe('已重新连接（中断 33 秒）');
    s.push(LOST, 100);
    expect(s.push(UNREACHABLE_BACK, 100 + 180).chat?.zh).toBe('已重新连接（中断 3 分钟）');
  });

  it('outageText: seconds, then minutes and seconds', () => {
    expect(outageText(0.2, 'zh')).toBe('1 秒');
    expect(outageText(14, 'zh')).toBe('14 秒');
    expect(outageText(59.6, 'zh')).toBe('1 分钟');
    expect(outageText(535, 'zh')).toBe('8 分 55 秒');
    expect(outageText(14, 'en')).toBe('14 s');
    expect(outageText(535, 'en')).toBe('8 min 55 s');
    expect(outageText(540, 'en')).toBe('9 min');
  });
});
