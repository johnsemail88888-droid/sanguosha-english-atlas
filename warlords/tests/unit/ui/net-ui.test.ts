// NET-2: a guest's link to the host is one live HUD chip (not a chat line + an
// announcement per status event). NET-1: the desktop app's LAN addresses are
// refreshed, not frozen at window start.
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_UNREACHABLE, LinkStatus, OK_CHIP_SECS, TROUBLE_LOG_AFTER, WAITING_HOST, hostWording, linkActions, linkChipText, linkStateOf, silentSecs, type StatusMsg } from '../../../src/ui/hud/connstatus';
import { loadStageText } from '../../../src/ui/screens/loading';
import { overrideLang } from '../../../src/ui/i18n';
import { cleanUrls, desktopInfo, refreshLanUrls, resetLanUrlsForTests, shareBase } from '../../../src/ui/desktop';
import { HOST_UNREACHABLE_KEY, WAITING_HOST_KEY } from '../../../src/net/clientSession';

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

  it('a short host freeze: one chip replaced in place, green then hidden — and no chat line (MP2-7)', () => {
    const s = new LinkStatus();
    const lines: string[] = [];
    const push = (st: StatusMsg, now: number): void => {
      const r = s.push(st, now);
      expect(r.handled).toBe(true);
      if (r.chat) lines.push(r.chat.zh);
    };
    push(WAITING, 10);
    // UX-17: the chip says 房主 like every other online string
    // (MP2-1: the waiting chip counts the silence and can be left)
    expect(s.chip).toEqual({ zh: '等待房主响应…', en: WAITING.en, tone: 'warn', actions: ['leave'], counter: true });
    // the session repeats itself while frozen: nothing new
    push(WAITING, 11);
    expect(s.update(12)).toEqual({ chip: false, chat: null });
    push(WAITING, 12);
    push(BACK, 14);
    expect(s.chip).toEqual({ zh: '房主已恢复响应', en: BACK.en, tone: 'ok' });
    expect(lines).toEqual([]);
    expect(s.update(14 + OK_CHIP_SECS - 0.1)).toEqual({ chip: false, chat: null });
    expect(s.chip?.tone).toBe('ok');
    expect(s.update(14 + OK_CHIP_SECS)).toEqual({ chip: true, chat: null });
    expect(s.chip).toBeNull();
    expect(s.update(30)).toEqual({ chip: false, chat: null });
  });

  it('a freeze that lasts gets ONE chat line, updated in place when the host is back', () => {
    const s = new LinkStatus();
    s.push(WAITING, 10);
    expect(s.update(10 + TROUBLE_LOG_AFTER - 0.1).chat).toBeNull();
    const line = s.update(10 + TROUBLE_LOG_AFTER).chat;
    expect(line).toEqual({ key: 'link-1', zh: '等待房主响应…', en: WAITING.en });
    expect(s.update(21).chat).toBeNull();
    const back = s.push(BACK, 24);
    expect(back.chat).toEqual({ key: 'link-1', zh: '房主已恢复响应（中断 14 秒）', en: `${BACK.en} (after 14 s)` });
    // the next episode is a new line
    s.push(WAITING, 40);
    expect(s.update(40 + TROUBLE_LOG_AFTER).chat?.key).toBe('link-2');
  });

  it('a lost link escalates in place: waiting → reconnecting (logged at once) → reconnected (same line)', () => {
    const s = new LinkStatus();
    const lines: { key: string; zh: string }[] = [];
    for (const [st, t] of [[WAITING, 1], [LOST, 6], [LOST, 7], [REJOINED, 9]] as const) {
      const r = s.push(st, t);
      if (r.chat) lines.push({ key: r.chat.key, zh: r.chat.zh });
      if (t === 6) expect(s.chip?.tone).toBe('bad');
    }
    expect(lines).toEqual([
      { key: 'link-1', zh: LOST.zh },
      { key: 'link-1', zh: '已重新连接（中断 8 秒）' },
    ]);
    expect(s.state).toBe('ok');
    expect(s.chip?.tone).toBe('ok');
  });

  it('a flapping link (short freezes) never fills the chat; the chip still follows every change', () => {
    const s = new LinkStatus();
    let chat = 0;
    for (let i = 0; i < 6; i++) {
      const t = i * 3;
      if (s.push(WAITING, t).chat) chat++;
      expect(s.chip?.tone).toBe('warn');
      if (s.update(t + 0.5).chat) chat++;
      if (s.push(BACK, t + 1).chat) chat++;
      expect(s.chip?.tone).toBe('ok');
    }
    expect(chat).toBe(0);
    expect(hostWording('等待主机响应…')).toBe('等待房主响应…');
  });

  it('the first "connected" of a session shows nothing', () => {
    const s = new LinkStatus();
    expect(s.push(CONNECTED, 0)).toEqual({ handled: true, chat: null });
    expect(s.chip).toBeNull();
  });
});

// the lines src/net/clientSession.ts emits for an automatic rejoin that cannot find the host (MP2-2)
const UNREACHABLE: StatusMsg = { zh: '暂时联系不上房主，正在重试…', en: 'Connection lost — cannot reach the host, retrying…', key: HOST_UNREACHABLE_KEY };
const UNREACHABLE_BACK: StatusMsg = { zh: '已重新连接', en: 'Reconnected', key: HOST_UNREACHABLE_KEY, clear: true };

describe('MP2-1 / MP2-2 link chip: 重试 / 离开, the silence counter, 等待房主加载…', () => {
  afterEach(() => overrideLang(null));

  it('an unreachable host is its own state (by key — its English starts like the reconnect line), cleared by the rejoin', () => {
    expect(HOST_UNREACHABLE).toBe(HOST_UNREACHABLE_KEY);
    expect(linkStateOf(UNREACHABLE)).toBe('unreachable');
    expect(linkStateOf(UNREACHABLE_BACK)).toBe('ok');
    expect(linkActions('unreachable')).toEqual(['retry', 'leave']);
    expect(linkActions('waiting')).toEqual(['leave']);
    expect(linkActions('reconnecting')).toEqual([]);
    expect(linkActions('ok')).toEqual([]);
  });

  it('waiting → reconnecting → unreachable → back: one chat line updated in place, the chip offers 重试 + 离开 meanwhile', () => {
    const s = new LinkStatus();
    const lines: { key: string; zh: string }[] = [];
    const push = (st: StatusMsg, t: number): void => {
      const r = s.push(st, t);
      if (r.chat) lines.push({ key: r.chat.key, zh: r.chat.zh });
    };
    push(WAITING, 1);
    push(LOST, 6);
    push(UNREACHABLE, 9);
    expect(s.state).toBe('unreachable');
    expect(s.chip).toEqual({ zh: UNREACHABLE.zh, en: UNREACHABLE.en, tone: 'bad', actions: ['retry', 'leave'], counter: false });
    push(UNREACHABLE_BACK, 30);
    expect(s.chip).toEqual({ zh: '已重新连接', en: 'Reconnected', tone: 'ok' });
    expect(lines).toEqual([
      { key: 'link-1', zh: LOST.zh },
      { key: 'link-1', zh: UNREACHABLE.zh },
      { key: 'link-1', zh: '已重新连接（中断 29 秒）' },
    ]);
  });

  it('the waiting chip counts whole seconds of silence (session.hostSilentMs); other chips never do', () => {
    expect(silentSecs(undefined)).toBe(0);
    expect(silentSecs(0)).toBe(0);
    expect(silentSecs(12_400)).toBe(12);
    expect(silentSecs(12_600)).toBe(13);
    const s = new LinkStatus();
    s.push(WAITING, 0);
    const chip = s.chip!;
    expect(linkChipText(chip, 0, 'zh')).toBe('等待房主响应…');
    expect(linkChipText(chip, 12, 'zh')).toBe('等待房主响应… 12 秒');
    expect(linkChipText(chip, 12, 'en')).toBe('Waiting for host… 12 s');
    s.push(UNREACHABLE, 5);
    expect(linkChipText(s.chip!, 12, 'zh')).toBe(UNREACHABLE.zh);
  });

  it('loading: ready while the host has not started the clock reads 等待房主加载…, not 开战！', () => {
    expect(loadStageText('ready', 1, false)).toBe('开战！ 100%');
    expect(loadStageText('ready', 1, true)).toBe('等待房主加载…');
    expect(loadStageText('failed', 1, true)).toBe('等待房主加载…');
    // still building: the build's own stage, whatever the host does
    expect(loadStageText('models', 0.62, true)).toBe('点将列阵（载入模型）… 62%');
    overrideLang('en');
    expect(loadStageText('ready', 1, true)).toBe('Waiting for the host to load…');
    expect(loadStageText('ready', 1, false)).toBe('To battle! 100%');
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
