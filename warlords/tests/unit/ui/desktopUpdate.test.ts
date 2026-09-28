// The page side of desktop updates (src/ui/desktopUpdate.ts): the version label, what crosses
// the preload bridge, the title chip's rules (title only, once per launch, not again within 24 h,
// ✕ for the launch), 设置 → 关于, and telling the app when a match is on.
import { afterEach, describe, expect, it } from 'vitest';
import {
  NAG_EVERY_MS,
  aboutLine,
  buildNumber,
  chipOffer,
  chipSessionForTests,
  chipVisible,
  cleanUpdateState,
  desktopVersion,
  dismissChip,
  isMatchScreen,
  loadChipMemo,
  onUpdateState,
  reportScreen,
  resetDesktopUpdateForTests,
  saveChipMemo,
  updateAction,
  updateState,
  versionMismatchHint,
  versionText,
  type UpdateState,
} from '../../../src/ui/desktopUpdate';
import { overrideLang } from '../../../src/ui/i18n';
import { errorMessage } from '../../../src/ui/screens/online';

const g = globalThis as { sgwlDesktop?: unknown };
afterEach(() => {
  delete g.sgwlDesktop;
  resetDesktopUpdateForTests();
  overrideLang(null);
});

const st = (over: Partial<UpdateState>): UpdateState => ({ kind: 'nsis', auto: true, current: '0.1.42', status: 'idle', ...over });
const fresh = { shown: false, dismissed: false };

/** A fake preload bridge: records the calls, `push` sends a state like the main process does. */
function fakeApp(version = '0.1.42'): { calls: unknown[][]; push(s: unknown): void } {
  const calls: unknown[][] = [];
  let listener: ((s: unknown) => void) | null = null;
  g.sgwlDesktop = {
    isDesktop: true,
    version,
    update: {
      onState: (cb: (s: unknown) => void) => {
        listener = cb;
        cb({ kind: 'nsis', auto: true, current: version, build: 42, status: 'idle' });
        return () => (listener = null);
      },
      download: (which?: string) => calls.push(['download', which]),
      restart: () => calls.push(['restart']),
      check: () => calls.push(['check']),
      playing: (on: boolean) => calls.push(['playing', on]),
    },
  };
  return { calls, push: (s) => listener?.(s) };
}

describe('version label', () => {
  it('a release build shows its build number; a local / web build its version', () => {
    expect(buildNumber('0.1.42')).toBe(42);
    expect(buildNumber('0.1.0')).toBeNull();
    expect(buildNumber('')).toBeNull();
    expect(versionText('0.1.42')).toBe('0.1.42 · build 42');
    expect(versionText('0.1.0')).toBe('0.1.0');
  });

  it('the desktop app’s version comes from the preload (package.json in the renderer bundle stays 0.1.0)', () => {
    expect(desktopVersion()).toBeNull();
    fakeApp('0.1.57');
    expect(desktopVersion()).toBe('0.1.57');
    g.sgwlDesktop = { isDesktop: true, version: '' };
    expect(desktopVersion()).toBeNull();
  });
});

describe('what crosses the bridge', () => {
  it('only a well-formed state; links must be https', () => {
    expect(cleanUpdateState(null)).toBeNull();
    expect(cleanUpdateState({ kind: 'nsis', status: 'nope', current: '0.1.1' })).toBeNull();
    expect(cleanUpdateState({ kind: 'toaster', status: 'idle', current: '0.1.1' })).toBeNull();
    expect(cleanUpdateState({ kind: 'portable', auto: false, status: 'available', current: '0.1.1', version: '0.1.2', url: 'javascript:alert(1)', setupUrl: 'https://github.com/x/setup.exe', percent: 250 })).toEqual({
      kind: 'portable',
      auto: false,
      status: 'available',
      current: '0.1.1',
      version: '0.1.2',
      setupUrl: 'https://github.com/x/setup.exe',
      percent: 100,
    });
  });

  it('subscribes once, relays every change; actions go to the app', () => {
    const app = fakeApp();
    const seen: (UpdateState | null)[] = [];
    const off = onUpdateState((s) => seen.push(s));
    expect(seen.at(-1)).toMatchObject({ status: 'idle' });
    app.push({ kind: 'nsis', auto: true, current: '0.1.42', status: 'ready', version: '0.1.43' });
    expect(updateState()).toMatchObject({ status: 'ready', version: '0.1.43' });
    expect(seen.at(-1)).toMatchObject({ status: 'ready' });
    app.push({ junk: true }); // ignored
    expect(updateState()?.status).toBe('ready');
    off();
    updateAction('restart');
    updateAction('download');
    updateAction('setup');
    updateAction('check');
    expect(app.calls).toEqual([['restart'], ['download', undefined], ['download', 'setup'], ['check']]);
  });

  it('a browser: no state, actions do nothing', () => {
    const seen: unknown[] = [];
    onUpdateState((s) => seen.push(s));
    expect(seen).toEqual([null]);
    expect(() => updateAction('restart')).not.toThrow();
  });
});

describe('a match is on (never nag, never restart mid-match)', () => {
  it('hero select, loading and the match count; the app hears only the changes', () => {
    expect(['heroSelect', 'loading', 'match'].every((s) => isMatchScreen(s as never))).toBe(true);
    expect(['title', 'single', 'online', 'lobby', 'roles', 'gameOver', 'gallery', 'help'].some((s) => isMatchScreen(s as never))).toBe(false);
    const app = fakeApp();
    reportScreen('title');
    reportScreen('online');
    reportScreen('heroSelect');
    reportScreen('loading');
    reportScreen('match');
    reportScreen('gameOver');
    reportScreen('title');
    expect(app.calls).toEqual([
      ['playing', false],
      ['playing', true],
      ['playing', false],
    ]);
  });
});

describe('the title chip', () => {
  it('offers a downloaded update (auto) or a manual one — nothing while checking / downloading / up to date', () => {
    expect(chipOffer(st({ status: 'ready', version: '0.1.43' }))).toBe('restart');
    expect(chipOffer(st({ kind: 'portable', auto: false, status: 'available', version: '0.1.43' }))).toBe('download');
    expect(chipOffer(st({ kind: 'mac', auto: false, status: 'available', version: '0.1.43' }))).toBe('download');
    expect(chipOffer(st({ status: 'available', version: '0.1.43' }))).toBeNull(); // auto: it downloads by itself
    expect(chipOffer(st({ status: 'downloading', version: '0.1.43' }))).toBeNull();
    for (const status of ['idle', 'checking', 'latest', 'error'] as const) expect(chipOffer(st({ status }))).toBeNull();
    expect(chipOffer(null)).toBeNull();
  });

  it('once per launch, not again within 24 h of the last offer, gone for the launch after ✕', () => {
    const ready = st({ status: 'ready', version: '0.1.43' });
    const now = 10 * NAG_EVERY_MS;
    expect(NAG_EVERY_MS).toBe(24 * 60 * 60 * 1000);
    expect(chipVisible(ready, null, fresh, now)).toBe(true); // never offered before
    expect(chipVisible(ready, null, { shown: true, dismissed: false }, now)).toBe(true); // stays for this launch
    expect(chipVisible(ready, null, { shown: true, dismissed: true }, now)).toBe(false); // ✕
    // another launch 2 h after it was shown: quiet
    expect(chipVisible(ready, { at: now - 2 * 3600_000, version: '0.1.43' }, fresh, now)).toBe(false);
    // a newer build the same day: still quiet (it installs on quit anyway)
    expect(chipVisible(st({ status: 'ready', version: '0.1.44' }), { at: now - 3600_000, version: '0.1.43' }, fresh, now)).toBe(false);
    // a day later: offered again
    expect(chipVisible(ready, { at: now - NAG_EVERY_MS, version: '0.1.43' }, fresh, now)).toBe(true);
    // a clock that went backwards does not silence it forever
    expect(chipVisible(ready, { at: now + 3600_000, version: '0.1.43' }, fresh, now)).toBe(true);
    expect(chipVisible(st({ status: 'latest' }), null, fresh, now)).toBe(false);
  });

  it('a version mismatch makes the update urgent: checked now, the chip back despite the 24 h quiet — ✕ still closes it', () => {
    const ready = st({ status: 'ready', version: '0.1.43' });
    const memo = { at: 1_000, version: '0.1.43' };
    expect(chipVisible(ready, memo, { shown: true, dismissed: false, urgent: true }, 2_000)).toBe(true);
    expect(chipVisible(ready, memo, { shown: false, dismissed: false, urgent: true }, 2_000)).toBe(true);
    expect(chipVisible(ready, memo, { shown: true, dismissed: true, urgent: true }, 2_000)).toBe(false); // ✕ after the mismatch
    expect(chipVisible(st({ status: 'latest' }), null, { shown: false, dismissed: false, urgent: true }, 2_000)).toBe(false);
    // in a browser: nothing to add (the message already says to reload)
    expect(versionMismatchHint()).toBeNull();
    overrideLang('zh');
    const mismatch = { code: 'versionMismatch', zh: '你与房主的游戏版本不同，请双方刷新到最新版本', en: 'x' };
    expect(errorMessage(mismatch)).toBe('你与房主的游戏版本不同，请双方刷新到最新版本');
    // the desktop app, an update known: how to update, and a check right away
    const app = fakeApp();
    updateState(); // (the title screen listens from the start)
    app.push({ kind: 'nsis', auto: true, current: '0.1.42', build: 42, status: 'ready', version: '0.1.43' });
    expect(errorMessage(mismatch)).toBe('你与房主的游戏版本不同，请双方刷新到最新版本 — 桌面版请先更新：标题页的「重启并更新 / 下载」，或 设置 → 通用 → 关于');
    expect(app.calls).toEqual([['check']]);
    expect(errorMessage({ code: 'roomFull', zh: '房间已满', en: 'The room is full' })).toBe('房间已满');
    expect(app.calls).toHaveLength(1);
    for (const status of ['available', 'downloading'] as const) {
      app.push({ kind: 'portable', auto: false, current: '0.1.42', build: 42, status, version: '0.1.43' });
      expect(versionMismatchHint()).toContain('桌面版请先更新');
    }
  });

  it('a version mismatch while the app is up to date (or has not checked): no "update first" — the other side may be behind', () => {
    overrideLang('zh');
    const mismatch = { code: 'versionMismatch', zh: '你与房主的游戏版本不同，请双方刷新到最新版本', en: 'x' };
    const app = fakeApp(); // (idle: not checked yet)
    const other = '你与房主的游戏版本不同，请双方刷新到最新版本 — 已在检查桌面版更新（有新版本时标题页会提示）；若已是最新，说明服务器或对方还没更新，稍后再试';
    expect(errorMessage(mismatch)).toBe(other);
    for (const status of ['latest', 'error', 'checking'] as const) {
      app.push({ kind: 'nsis', auto: true, current: '0.1.44', build: 44, status });
      expect(errorMessage(mismatch)).toBe(other);
    }
    // it still checks each time (a release may have come out since the last check)
    expect(app.calls.filter((c) => c[0] === 'check')).toHaveLength(4);
    overrideLang('en');
    expect(versionMismatchHint()).toMatch(/^Checking for a desktop update now/);
  });

  it('✕ closes the chip for the launch even after a mismatch; the next mismatch brings it back', () => {
    const app = fakeApp();
    updateState(); // (the title screen listens from the start)
    app.push({ kind: 'nsis', auto: true, current: '0.1.42', build: 42, status: 'ready', version: '0.1.43' });
    const ready = updateState();
    const memo = { at: 1_000, version: '0.1.43' }; // offered an hour ago: quiet by the 24 h rule
    expect(chipVisible(ready, memo, chipSessionForTests(), 1_000 + 3600_000)).toBe(false);
    versionMismatchHint();
    expect(chipVisible(ready, memo, chipSessionForTests(), 1_000 + 3600_000)).toBe(true);
    dismissChip();
    expect(chipVisible(ready, memo, chipSessionForTests(), 1_000 + 3600_000)).toBe(false);
    versionMismatchHint();
    expect(chipVisible(ready, memo, chipSessionForTests(), 1_000 + 3600_000)).toBe(true);
  });

  it('the memo survives in localStorage (junk reads as none)', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(loadChipMemo(store)).toBeNull();
    saveChipMemo({ at: 123, version: '0.1.43' }, store);
    expect(loadChipMemo(store)).toEqual({ at: 123, version: '0.1.43' });
    expect([...data.keys()]).toEqual(['sgwl.desktop.updateChip']); // an sgwl key: the app mirrors it with the settings
    data.set('sgwl.desktop.updateChip', '{broken');
    expect(loadChipMemo(store)).toBeNull();
    expect(loadChipMemo(null)).toBeNull();
  });
});

describe('设置 → 关于', () => {
  it('says where the app stands and offers the one action that fits', () => {
    overrideLang('zh');
    expect(aboutLine(null, false)).toEqual({ text: '网页版：刷新页面就是最新版', action: null });
    expect(aboutLine(st({ kind: 'none' }), false).action).toBeNull();
    expect(aboutLine(st({ status: 'latest' }), false)).toEqual({ text: '已是最新', action: 'check', label: '检查更新' });
    expect(aboutLine(st({ status: 'ready', version: '0.1.43' }), false)).toEqual({ text: '新版本 build 43 已下载', action: 'restart', label: '重启并更新' });
    // in a match: no restart button — it installs on quit
    expect(aboutLine(st({ status: 'ready', version: '0.1.43' }), true)).toEqual({ text: '新版本 build 43 已下载：退出游戏时自动安装', action: null });
    expect(aboutLine(st({ kind: 'portable', auto: false, status: 'available', version: '0.1.43' }), false)).toEqual({ text: '有新版本 build 43', action: 'download', label: '下载' });
    expect(aboutLine(st({ status: 'downloading', version: '0.1.43', percent: 37 }), false).text).toBe('正在后台下载 build 43… 37%');
    expect(aboutLine(st({ status: 'error' }), false)).toEqual({ text: '暂时无法检查更新（离线？）', action: 'check', label: '检查更新' });
    overrideLang('en');
    expect(aboutLine(st({ status: 'latest' }), false).text).toBe('Up to date');
    expect(aboutLine(st({ kind: 'mac', auto: false, status: 'available', version: '0.1.43' }), false).text).toBe('New version: build 43');
  });
});
