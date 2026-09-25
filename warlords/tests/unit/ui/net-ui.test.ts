// NET-2: a guest's link to the host is one live HUD chip (not a chat line + an
// announcement per status event). NET-1: the desktop app's LAN addresses are
// refreshed, not frozen at window start.
import { afterEach, describe, expect, it } from 'vitest';
import { LinkStatus, OK_CHIP_SECS, TROUBLE_LOG_GAP, WAITING_HOST, linkStateOf, type StatusMsg } from '../../../src/ui/hud/connstatus';
import { cleanUrls, desktopInfo, refreshLanUrls, resetLanUrlsForTests, shareBase } from '../../../src/ui/desktop';
import { WAITING_HOST_KEY } from '../../../src/net/clientSession';

// the exact lines src/net/clientSession.ts emits
const WAITING: StatusMsg = { zh: '等待主机响应…', en: 'Waiting for host…', key: WAITING_HOST_KEY };
const BACK: StatusMsg = { zh: '主机已恢复响应', en: 'Host is responding again', key: WAITING_HOST_KEY, clear: true };
const LOST: StatusMsg = { zh: '连接中断，正在重新连接…', en: 'Connection lost — reconnecting…' };
const REJOINED: StatusMsg = { zh: '已重新连接', en: 'Reconnected' };
const CONNECTED: StatusMsg = { zh: '已连接到房间', en: 'Connected to the room' };
const NOTICE: StatusMsg = { zh: '玩家 A 离开了，由 AI 接管', en: 'Player A left — a bot took over' };

describe('NET-2 link status', () => {
  it('knows the client session’s link lines, and nothing else', () => {
    expect(WAITING_HOST).toBe(WAITING_HOST_KEY);
    expect(linkStateOf(WAITING)).toBe('waiting');
    expect(linkStateOf(BACK)).toBe('ok');
    expect(linkStateOf(LOST)).toBe('reconnecting');
    expect(linkStateOf(REJOINED)).toBe('ok');
    expect(linkStateOf(CONNECTED)).toBe('ok');
    expect(linkStateOf(NOTICE)).toBeNull();
  });

  it('host notices are not handled (they keep their chat line + announcement)', () => {
    const s = new LinkStatus();
    expect(s.push(NOTICE, 1)).toEqual({ handled: false, chat: null });
    expect(s.chip).toBeNull();
  });

  it('a host freeze: one chip replaced in place, one chat line per change, green then hidden', () => {
    const s = new LinkStatus();
    const lines: string[] = [];
    const push = (st: StatusMsg, now: number): void => {
      const r = s.push(st, now);
      expect(r.handled).toBe(true);
      if (r.chat) lines.push(r.chat.zh);
    };
    push(WAITING, 10);
    expect(s.chip).toEqual({ zh: WAITING.zh, en: WAITING.en, tone: 'warn' });
    // the session repeats itself while frozen: no new lines
    push(WAITING, 11);
    push(WAITING, 12);
    push(BACK, 14);
    expect(s.chip?.tone).toBe('ok');
    expect(lines).toEqual([WAITING.zh, BACK.zh]);
    expect(s.update(14 + OK_CHIP_SECS - 0.1)).toBe(false);
    expect(s.chip?.tone).toBe('ok');
    expect(s.update(14 + OK_CHIP_SECS)).toBe(true);
    expect(s.chip).toBeNull();
    expect(s.update(30)).toBe(false);
  });

  it('a lost link escalates in place: waiting → reconnecting → reconnected', () => {
    const s = new LinkStatus();
    const lines: string[] = [];
    for (const [st, t] of [[WAITING, 1], [LOST, 6], [LOST, 7], [REJOINED, 9]] as const) {
      const r = s.push(st, t);
      if (r.chat) lines.push(r.chat.zh);
      if (t === 6) expect(s.chip?.tone).toBe('bad');
    }
    expect(lines).toEqual([WAITING.zh, LOST.zh, REJOINED.zh]);
    expect(s.state).toBe('ok');
    expect(s.chip?.tone).toBe('ok');
  });

  it('a flapping link logs one pair per TROUBLE_LOG_GAP (the chip still follows every change)', () => {
    const s = new LinkStatus();
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = i * 3;
      const a = s.push(WAITING, t);
      expect(s.chip?.tone).toBe('warn');
      const b = s.push(BACK, t + 1);
      expect(s.chip?.tone).toBe('ok');
      for (const r of [a, b]) if (r.chat) lines.push(r.chat.zh);
    }
    expect(lines).toEqual([WAITING.zh, BACK.zh]);
    const late = s.push(WAITING, 5 * 3 + TROUBLE_LOG_GAP);
    expect(late.chat?.zh).toBe(WAITING.zh);
  });

  it('the first "connected" of a session shows nothing', () => {
    const s = new LinkStatus();
    expect(s.push(CONNECTED, 0)).toEqual({ handled: true, chat: null });
    expect(s.chip).toBeNull();
  });
});

describe('NET-1 desktop LAN addresses', () => {
  const g = globalThis as unknown as { sgwlDesktop?: unknown };
  afterEach(() => {
    delete g.sgwlDesktop;
    resetLanUrlsForTests();
  });

  it('cleanUrls keeps http(s) strings only', () => {
    expect(cleanUrls(['http://192.168.1.5:8787/', 'ftp://x', 3, 'https://a/'])).toEqual(['http://192.168.1.5:8787/', 'https://a/']);
    expect(cleanUrls('nope')).toBeNull();
  });

  it('not the desktop app: no info, nothing to refresh', () => {
    expect(desktopInfo()).toBeNull();
    expect(refreshLanUrls()).toEqual([]);
  });

  it('the startup list until refreshed, then the fresh list everywhere (share links too)', () => {
    let now = ['http://192.168.1.5:8787/'];
    let calls = 0;
    g.sgwlDesktop = {
      isDesktop: true,
      lanUrls: ['http://10.0.0.7:8787/'],
      port: 8787,
      getLanUrls: () => {
        calls++;
        return now;
      },
    };
    expect(desktopInfo()?.lanUrls).toEqual(['http://10.0.0.7:8787/']);
    expect(refreshLanUrls()).toEqual(['http://192.168.1.5:8787/']);
    expect(calls).toBe(1);
    expect(desktopInfo()?.lanUrls).toEqual(['http://192.168.1.5:8787/']);
    expect(shareBase({ origin: 'http://127.0.0.1:8787', pathname: '/' })).toBe('http://192.168.1.5:8787/');
    // the network changed again
    now = ['http://172.20.1.9:8787/', 'http://192.168.56.1:8787/'];
    expect(refreshLanUrls()).toEqual(now);
    expect(shareBase({ origin: 'http://127.0.0.1:8787', pathname: '/' })).toBe('http://172.20.1.9:8787/');
    // offline: an empty list is a real answer
    now = [];
    expect(refreshLanUrls()).toEqual([]);
  });

  it('an older preload without getLanUrls, or one that throws / answers junk, keeps the last list', () => {
    g.sgwlDesktop = { isDesktop: true, lanUrls: ['http://10.0.0.7:8787/'], port: 9000 };
    expect(refreshLanUrls()).toEqual(['http://10.0.0.7:8787/']);
    expect(desktopInfo()?.port).toBe(9000);
    g.sgwlDesktop = {
      isDesktop: true,
      lanUrls: ['http://10.0.0.7:8787/'],
      getLanUrls: () => {
        throw new Error('ipc down');
      },
    };
    expect(refreshLanUrls()).toEqual(['http://10.0.0.7:8787/']);
    g.sgwlDesktop = { isDesktop: true, lanUrls: ['http://10.0.0.7:8787/'], getLanUrls: () => 'junk' };
    expect(refreshLanUrls()).toEqual(['http://10.0.0.7:8787/']);
  });
});
