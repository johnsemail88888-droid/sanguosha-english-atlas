// 「版本不同」 fixes itself (src/ui/versionFix.ts): a page of another build than the official
// server's that meets a version mismatch there opens the official page with the room code (or
// reloads, on the official page itself); the desktop page asks the app instead. Only when it can
// help, at most once a minute. Hermetic: the "official server" is a stubbed fetch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBuildMismatch } from '../../../src/net/headlessRooms';
import { hostOnlineSession } from '../../../src/net';
import { setOfficialServerForTests } from '../../../src/net/official';
import { settings } from '../../../src/game/settings';
import {
  desktopBundledCompat,
  desktopInfo,
  lanViaBundledPage,
  officialPageDiffers,
  reportPageBuild,
  servedByLocalServer,
  shareBase,
  useBundledPage,
} from '../../../src/ui/desktop';
import { choiceOf, choicePatch, parseInvite, relayNet } from '../../../src/ui/invite';
import { applyHandedConnection, autoJoinPlan, switchGaveUp } from '../../../src/ui/screens/online';
import {
  cancelVersionFix,
  claimVersionFix,
  fixCreateOnServer,
  fixUrl,
  fixVersionMismatch,
  isOfficialRoomServer,
  OFFICIAL_PROBE_TIMEOUT_MS,
  officialCompat,
  resetVersionFixForTests,
  roomOnOfficial,
  takeCarriedName,
  takeCreateIntent,
  VERSION_FIX_EVERY_MS,
  VERSION_FIX_KEY,
  versionFixPending,
  type FixEnv,
} from '../../../src/ui/versionFix';

const OFFICIAL = { web: 'https://official.test/', relay: 'wss://official.test/ws' };
const MINE = 'aaaaaaaaaaaa';
const SERVER = 'bbbbbbbbbbbb';

afterEach(() => {
  resetVersionFixForTests();
  setOfficialServerForTests(undefined);
});

function store(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** A web page on `origin` whose official server answers `body` (an Error: unreachable). */
function web(origin: string, body: unknown = { app: 'sanguo-warlords', build: { compat: SERVER } }, over: Partial<FixEnv> = {}) {
  const went: { how: 'assign' | 'replace'; url: string }[] = [];
  const asked: string[] = [];
  let t = 5_000_000;
  const env: FixEnv = {
    official: OFFICIAL,
    compat: MINE,
    desktop: null,
    store: store(),
    keys: {},
    prefs: {},
    now: () => t,
    location: { origin, assign: (url) => void went.push({ how: 'assign', url }), replace: (url) => void went.push({ how: 'replace', url }) },
    fetch: async (url) => {
      asked.push(url);
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body };
    },
    ...over,
  };
  return { env, went, asked, tick: (ms: number) => void (t += ms) };
}

describe('a web page meets a version mismatch on the official server', () => {
  it('GitHub Pages / a stale tab / a LAN page: opens the official page with the room code — which joins that room by itself', async () => {
    const p = web('https://johnsemail88888-droid.github.io');
    expect(await fixVersionMismatch({ room: 'kx7qd' }, p.env)).toBe('open');
    expect(p.asked).toEqual(['https://official.test/sgwl.json']);
    expect(p.went).toEqual([{ how: 'assign', url: 'https://official.test/?room=KX7QD&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws' }]);
    const inv = parseInvite(new URL(p.went[0].url).search);
    expect(inv).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: OFFICIAL.relay } });
    setOfficialServerForTests(OFFICIAL);
    expect(choiceOf(inv.mode!, inv.net.wsUrl ?? '')).toBe('official');
    expect(autoJoinPlan({ invited: inv.room, rejoin: false, inviteTried: false, canJoin: true })).toBe('invite');
    // meanwhile the page says 正在切换…
    expect(versionFixPending(p.env.now!())).toBe(true);
  });

  it('the official page itself (a tab left open across the server’s update) reloads, keeping the room code', async () => {
    const p = web('https://official.test');
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBe('reload');
    expect(p.went).toEqual([{ how: 'replace', url: 'https://official.test/?room=KX7QD&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws' }]);
  });

  it('创建房间 carries over as ?create=1 on the official relay; a key this page holds for the official server goes along (to its own page only)', async () => {
    const p = web('https://johnsemail88888-droid.github.io', undefined, { keys: { 'wss://official.test': 'k3y-k3y-k3y-k3y' } });
    expect(await fixVersionMismatch({ create: true }, p.env)).toBe('open');
    expect(p.went[0].url).toBe('https://official.test/?create=1&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws&k=k3y-k3y-k3y-k3y');
    expect(fixUrl({ room: 'KX7QD', create: true }, OFFICIAL)).toBe('https://official.test/?room=KX7QD&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws');
    expect(fixUrl({ room: 'bad code!' }, OFFICIAL)).toBe('https://official.test/');
  });

  it('only when it can help: the server unreachable / of this very build / silent, no official server, a build without an id', async () => {
    const cases: [string, ReturnType<typeof web>][] = [
      ['unreachable', web('https://x.github.io', new Error('offline'))],
      ['same build', web('https://x.github.io', { app: 'sanguo-warlords', build: { compat: MINE } })],
      ['no compat', web('https://x.github.io', { app: 'sanguo-warlords', build: {} })],
      ['a foreign app', web('https://x.github.io', { app: 'other', build: { compat: SERVER } })],
      ['no official server', web('https://x.github.io', undefined, { official: null })],
      ['no official page', web('https://x.github.io', undefined, { official: { web: '', relay: OFFICIAL.relay } })],
      ['no build id', web('https://x.github.io', undefined, { compat: null })],
      ['no storage for the loop guard', web('https://x.github.io', undefined, { store: null })],
    ];
    for (const [name, p] of cases) {
      expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env), name).toBeNull();
      expect(p.went, name).toEqual([]);
    }
  });

  it('no loops: at most one switch a minute per tab (sessionStorage)', async () => {
    const p = web('https://official.test');
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBe('reload');
    resetVersionFixForTests(); // (the reloaded page: a fresh module, the same tab's sessionStorage)
    p.tick(VERSION_FIX_EVERY_MS - 1);
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBeNull();
    expect(p.env.store!.getItem(VERSION_FIX_KEY)).toBe('5000000');
    p.tick(2);
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBe('reload');
    expect(p.went).toHaveLength(2);
    expect(claimVersionFix(null)).toBe(false);
  });

  it('the official server’s build: GET <web>sgwl.json, given up after its time limit', async () => {
    const never = (() => new Promise(() => undefined)) as never;
    expect(await officialCompat(OFFICIAL, never, 30)).toBeNull();
    expect(await officialCompat(null)).toBeNull();
  });
});

describe('the desktop page asks the app instead (it never navigates itself)', () => {
  it('the app switches: the page waits for it; the app says no: the message stays', async () => {
    const calls: unknown[] = [];
    let answer: unknown = { switched: true, page: 'official' };
    const p = web('http://127.0.0.1:8787', undefined, {
      desktop: {
        fixVersion: async (req) => {
          calls.push(req);
          return answer;
        },
      },
    });
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBe('desktop');
    expect(calls).toEqual([{ room: 'KX7QD', create: false, compat: MINE }]);
    resetVersionFixForTests();
    answer = { switched: false, reason: 'switched less than a minute ago' };
    expect(await fixVersionMismatch({ create: true }, p.env)).toBeNull();
    expect(calls[1]).toEqual({ room: null, create: true, compat: MINE });
    // an app without the bridge call, a failing one: the message
    expect(await fixVersionMismatch({ room: 'KX7QD' }, { ...p.env, desktop: {} })).toBeNull();
    expect(await fixVersionMismatch({ room: 'KX7QD' }, { ...p.env, desktop: { fixVersion: () => Promise.reject(new Error('x')) } })).toBeNull();
    expect(p.went).toEqual([]);
    expect(p.asked).toEqual([]);
  });
});

describe('which rooms it can fix: the official server’s only', () => {
  it('官方服务器 (and the official page’s own relay) yes; P2P, a LAN / self-hosted server no', () => {
    const page = { protocol: 'https:', host: 'official.test' };
    const lan = { protocol: 'http:', host: '192.168.1.5:8787' };
    expect(roomOnOfficial({ mode: 'ws', wsUrl: OFFICIAL.relay }, lan, OFFICIAL)).toBe(true);
    expect(roomOnOfficial({ mode: 'ws', wsUrl: '' }, page, OFFICIAL)).toBe(true);
    expect(roomOnOfficial({ mode: 'ws', wsUrl: '' }, lan, OFFICIAL)).toBe(false);
    expect(roomOnOfficial({ mode: 'ws', wsUrl: 'ws://192.168.1.5:8787/ws' }, page, OFFICIAL)).toBe(false);
    expect(roomOnOfficial({ mode: 'peer', wsUrl: OFFICIAL.relay }, page, OFFICIAL)).toBe(false);
    expect(roomOnOfficial({ mode: 'ws', wsUrl: OFFICIAL.relay }, page, null)).toBe(false);
    // the relay URL the net layer asked carries the key: still the official server
    expect(isOfficialRoomServer('wss://official.test/ws?k=secret', OFFICIAL)).toBe(true);
    expect(isOfficialRoomServer('wss://evil.test/ws', OFFICIAL)).toBe(false);
  });

  it('创建房间 refused with 409 on another server: this page hosts the room, as before (no probe, no switch)', async () => {
    const p = web('https://x.github.io');
    expect(await fixCreateOnServer('ws://192.168.1.5:8787/ws', p.env)).toBe(false);
    expect(p.asked).toEqual([]);
    expect(await fixCreateOnServer('wss://official.test/ws?k=abc', p.env)).toBe(true);
    expect(p.went[0].url).toBe('https://official.test/?create=1&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws');
  });
});

describe('创建房间 against a server of another build (POST /api/rooms 409)', () => {
  it('is a build mismatch; with the page of the server’s build taking over, no room is hosted here', async () => {
    expect(isBuildMismatch({ kind: 'fallback', reason: 'HTTP 409 version-mismatch' })).toBe(true);
    expect(isBuildMismatch({ kind: 'fallback', reason: 'HTTP 503 headless-unavailable' })).toBe(false);
    expect(isBuildMismatch({ kind: 'rateLimited' })).toBe(false);
    const g = globalThis as { fetch?: unknown };
    const realFetch = g.fetch;
    const net0 = settings.get().net;
    const asked: string[] = [];
    g.fetch = async (url: string) => {
      asked.push(url);
      return { status: 409, json: async () => ({ error: 'version-mismatch' }) };
    };
    settings.update({ net: { ...net0, mode: 'ws', wsUrl: OFFICIAL.relay } });
    try {
      const hooked: string[] = [];
      await expect(hostOnlineSession({ name: 'p', mode: 'ws', onBuildMismatch: (url) => (hooked.push(url), true) })).rejects.toMatchObject({ code: 'versionMismatch' });
      expect(asked).toEqual(['https://official.test/api/rooms']);
      expect(hooked).toEqual([OFFICIAL.relay]);
    } finally {
      g.fetch = realFetch;
      settings.update({ net: net0 });
    }
  });
});

describe('?create=1 on the page the fix opened', () => {
  const hist = (replaced: string[]) => ({ state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) });

  it('once, in the connection it names: the parameters leave the address bar (F5 creates none)', () => {
    const replaced: string[] = [];
    const url = `https://official.test/?create=1&mode=ws&ws=${encodeURIComponent(OFFICIAL.relay)}&desktop=1`;
    expect(takeCreateIntent({ location: { href: url }, history: hist(replaced), desktop: {}, store: null })).toEqual({ auto: true, mode: 'ws', wsUrl: OFFICIAL.relay });
    expect(replaced).toEqual(['https://official.test/?desktop=1']);
    // the room is made on the official server whatever the page's own saved connection (P2P, a custom relay)
    setOfficialServerForTests(OFFICIAL);
    expect(choiceOf('ws', OFFICIAL.relay)).toBe('official');
    // the app's own page, the LAN server (mode=ws, no ws=): the page's own server
    const lan = takeCreateIntent({ location: { href: 'http://127.0.0.1:8787/?desktop=1&create=1&mode=ws' }, history: hist([]), desktop: {}, store: null })!;
    expect(lan).toEqual({ auto: true, mode: 'ws', wsUrl: '' });
    expect(relayNet(lan.mode!, { wsUrl: lan.wsUrl! })).toEqual({ wsUrl: '' });
    expect(choiceOf('ws', '')).toBe('ws');
    expect(takeCreateIntent({ location: { href: 'https://official.test/?room=KX7QD' }, history: hist([]) })).toBeNull();
    expect(takeCreateIntent({})).toBeNull();
  });

  it('at once only when this tab’s own fix (or the desktop app) loaded it — a link from anywhere waits for the player’s click', () => {
    const url = 'https://official.test/?create=1&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws';
    // a link posted in a chat: no mark of this tab's fix — the online screen asks for the click
    expect(takeCreateIntent({ location: { href: url }, history: hist([]), desktop: null, store: store() })?.auto).toBe(false);
    expect(takeCreateIntent({ location: { href: url }, history: hist([]), desktop: null, store: null })?.auto).toBe(false);
    // this tab's own version fix reloaded it a moment ago (the official page itself: same origin, same sessionStorage)
    const s = store();
    expect(claimVersionFix(s, 1_000_000)).toBe(true);
    expect(takeCreateIntent({ location: { href: url }, history: hist([]), desktop: null, store: s, now: 1_000_500 })?.auto).toBe(true);
    // … long ago: a link again
    expect(takeCreateIntent({ location: { href: url }, history: hist([]), desktop: null, store: s, now: 1_000_000 + VERSION_FIX_EVERY_MS + 1 })?.auto).toBe(false);
    // junk relays are no relay
    expect(takeCreateIntent({ location: { href: 'https://official.test/?create=1&mode=ws&ws=javascript:x' }, history: hist([]), desktop: {}, store: null })).toEqual({ auto: true, mode: 'ws', wsUrl: '' });
  });
});

describe('the desktop app’s 自建服务器 handoff (own=1): this page’s own saved address', () => {
  const hist = (replaced: string[]) => ({ state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) });
  const relay = encodeURIComponent(OFFICIAL.relay);

  it('own=1 names no relay: read only in relay mode without ws=, and taken out of the address bar with 创建房间', () => {
    const replaced: string[] = [];
    expect(takeCreateIntent({ location: { href: 'http://127.0.0.1:8787/?desktop=1&create=1&mode=ws&own=1' }, history: hist(replaced), desktop: {}, store: null })).toEqual({ auto: true, mode: 'ws', wsUrl: '', own: true });
    expect(replaced).toEqual(['http://127.0.0.1:8787/?desktop=1']);
    // a relay named wins; outside relay mode it means nothing
    expect(takeCreateIntent({ location: { href: `http://127.0.0.1:8787/?create=1&mode=ws&own=1&ws=${relay}` }, history: hist([]), desktop: {}, store: null })).toEqual({ auto: true, mode: 'ws', wsUrl: OFFICIAL.relay });
    expect(takeCreateIntent({ location: { href: 'http://127.0.0.1:8787/?create=1&mode=peer&own=1' }, history: hist([]), desktop: {}, store: null })).toEqual({ auto: true, mode: 'peer', wsUrl: null });
    expect(parseInvite('?desktop=1&room=KX7QD&mode=ws&own=1')).toEqual({ room: 'KX7QD', mode: 'ws', net: {}, own: true });
    expect(parseInvite(`?room=KX7QD&mode=ws&own=1&ws=${relay}`)).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: OFFICIAL.relay } });
    expect(parseInvite('?room=KX7QD&mode=peer&own=1')).toEqual({ room: 'KX7QD', mode: 'peer', net: {} });
    expect(parseInvite('?room=KX7QD&mode=ws&own=0')).toEqual({ room: 'KX7QD', mode: 'ws', net: {} });
  });

  it('the page writes no address and starts on 自建服务器 — even when the relay saved here is the official one (the player last used 官方服务器): its own address comes back', () => {
    setOfficialServerForTests(OFFICIAL);
    const net0 = settings.get().net;
    try {
      settings.update({ net: { ...net0, mode: 'ws', wsUrl: OFFICIAL.relay } });
      for (const handed of [
        { saved: null, link: parseInvite('?desktop=1&room=KX7QD&mode=ws&own=1'), create: null },
        { saved: null, link: null, create: { auto: true, mode: 'ws' as const, wsUrl: '', own: true as const } },
      ]) {
        expect(applyHandedConnection(handed)).toBe('ws'); // 自建服务器, not 官方服务器 (whose build this page may not be)
        expect(settings.get().net.wsUrl).toBe(OFFICIAL.relay); // nothing written
      }
      const s = store();
      s.setItem('sgwl.ui.customWsUrl', 'wss://my.server/ws');
      expect(choicePatch('ws', settings.get().net, OFFICIAL, s)).toEqual({ mode: 'ws', wsUrl: 'wss://my.server/ws' });
      // (a room on the official relay named in the URL: 官方服务器, as before; nothing handed: the page's default)
      expect(applyHandedConnection({ saved: null, link: parseInvite(`?room=KX7QD&mode=ws&ws=${relay}`), create: null })).toBe('official');
      expect(applyHandedConnection({ saved: null, link: parseInvite('?room=KX7QD'), create: null })).toBeNull();
    } finally {
      settings.update({ net: net0 });
    }
  });
});

describe('what the page of another origin gets of the player', () => {
  it('the language and the name travel with the fix to another origin (its localStorage is its own) — not on a reload', async () => {
    const p = web('https://johnsemail88888-droid.github.io', undefined, { prefs: { lang: 'en', name: '小明 ' } });
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBe('open');
    const u = new URL(p.went[0].url);
    expect(u.searchParams.get('lang')).toBe('en');
    expect(u.searchParams.get('name')).toBe('小明');
    resetVersionFixForTests();
    const same = web('https://official.test', undefined, { prefs: { lang: 'en', name: '小明' } });
    expect(await fixVersionMismatch({ room: 'KX7QD' }, same.env)).toBe('reload');
    expect(same.went[0].url).not.toMatch(/lang=|name=/);
    // junk is not carried
    expect(fixUrl({ room: 'KX7QD' }, OFFICIAL, null, { lang: 'fr', name: '   ' })).toBe('https://official.test/?room=KX7QD&mode=ws&ws=wss%3A%2F%2Fofficial.test%2Fws');
  });

  it('?name= becomes the player’s name only on a page without one of its own; it leaves the address bar', () => {
    const before = settings.get().playerName;
    try {
      settings.update({ playerName: '' });
      const replaced: string[] = [];
      const history = { state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) };
      expect(takeCarriedName({ location: { href: 'https://official.test/?room=KX7QD&name=%E5%B0%8F%E6%98%8E' }, history })).toBe('小明');
      expect(settings.get().playerName).toBe('小明');
      expect(replaced).toEqual(['https://official.test/?room=KX7QD']);
      // a name of its own wins
      expect(takeCarriedName({ location: { href: 'https://official.test/?name=%E5%85%B3%E7%BE%BD' }, history })).toBeNull();
      expect(settings.get().playerName).toBe('小明');
      expect(takeCarriedName({ location: { href: 'https://official.test/?room=KX7QD' }, history })).toBeNull();
    } finally {
      settings.update({ playerName: before });
    }
  });
});

describe('取消 while the server is asked; a slow link', () => {
  it('the web page: the tab stays, nothing is claimed', async () => {
    let wanted = true;
    const p = web('https://x.github.io', undefined, {
      wanted: () => wanted,
      fetch: async (url) => {
        p.asked.push(url);
        wanted = false; // 取消 pressed while the server answered
        return { ok: true, json: async () => ({ app: 'sanguo-warlords', build: { compat: SERVER } }) };
      },
    });
    expect(await fixVersionMismatch({ room: 'KX7QD' }, p.env)).toBeNull();
    expect(p.went).toEqual([]);
    expect(p.env.store!.getItem(VERSION_FIX_KEY)).toBeNull();
    expect(versionFixPending(p.env.now!())).toBe(false);
  });

  it('the desktop page: 取消 tells the app, whose fix then switches nothing', async () => {
    let cancelled = 0;
    let answer!: (r: unknown) => void;
    const p = web('http://127.0.0.1:8787', undefined, {
      desktop: { fixVersion: () => new Promise((r) => (answer = r)), cancelFix: () => void cancelled++ },
    });
    const fix = fixVersionMismatch({ room: 'KX7QD' }, p.env);
    cancelVersionFix();
    expect(cancelled).toBe(1);
    answer({ switched: false, reason: 'cancelled' });
    expect(await fix).toBeNull();
    cancelVersionFix(); // nothing in flight: nothing to tell
    expect(cancelled).toBe(1);
  });

  it('a server answering after 3 s (a cross-border link) still fixes it', async () => {
    expect(OFFICIAL_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
    vi.useFakeTimers();
    try {
      const p = web('https://x.github.io', undefined, {
        fetch: () => new Promise((r) => setTimeout(() => r({ ok: true, json: async () => ({ app: 'sanguo-warlords', build: { compat: SERVER } }) }), 3000)),
      });
      const fix = fixVersionMismatch({ room: 'KX7QD' }, p.env);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await fix).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('正在切换… for too long (the page is still here): the screen is the player’s again, with the mismatch it met', () => {
    expect(switchGaveUp('你与房主的游戏版本不同', 'join')).toEqual({ errorText: expect.stringContaining('你与房主的游戏版本不同'), retryJoin: true });
    expect(switchGaveUp('x', 'host')?.retryJoin).toBe(false);
    expect(switchGaveUp(null, 'join')).toBeNull(); // the LAN switch: nothing went wrong
  });
});

describe('the desktop app’s window on the official server’s page', () => {
  const g = globalThis as { sgwlDesktop?: unknown };
  afterEach(() => {
    delete g.sgwlDesktop;
  });

  it('its own server is the official one, not this machine’s: 自建服务器 without an address goes to the app’s page, the room carried', () => {
    const sent: unknown[] = [];
    g.sgwlDesktop = { isDesktop: true, page: 'official', bundledCompat: MINE, useBundled: (req?: unknown) => void sent.push(req ?? null) };
    expect(servedByLocalServer()).toBe(false);
    expect(lanViaBundledPage('ws', '')).toBe(true);
    expect(lanViaBundledPage('ws', 'ws://10.0.0.2:8787/ws')).toBe(false); // an address of the player's own: as it says
    expect(lanViaBundledPage('official', '')).toBe(false);
    expect(useBundledPage({ room: 'KX7QD' })).toBe(true);
    expect(useBundledPage({ create: true })).toBe(true);
    expect(useBundledPage()).toBe(true);
    expect(sent).toEqual([{ room: 'KX7QD', create: false }, { room: null, create: true }, null]);
    // no LAN addresses here: an invite link never points at the LAN for a room of this page
    expect(desktopInfo()).toEqual({ isDesktop: true, lanUrls: [], port: 8787 });
    expect(shareBase({ origin: 'https://official.test', pathname: '/' }, 'ws', '')).toBe('https://official.test/');
    // the app's own page: its LAN server, as before
    g.sgwlDesktop = { isDesktop: true, page: 'bundled', lanUrls: ['http://192.168.1.5:8787/'], port: 8787 };
    expect(servedByLocalServer()).toBe(true);
    expect(lanViaBundledPage('ws', '')).toBe(false);
  });

  it('LAN friends get the app’s build: the warning only when this page’s build differs from it (or the app cannot say)', () => {
    g.sgwlDesktop = { isDesktop: true, page: 'official', bundledCompat: MINE };
    expect(desktopBundledCompat()).toBe(MINE);
    expect(officialPageDiffers(SERVER)).toBe(true);
    expect(officialPageDiffers(MINE)).toBe(false); // the server updated to the app's build, F5
    g.sgwlDesktop = { isDesktop: true, page: 'official' }; // an app that does not say
    expect(officialPageDiffers(MINE)).toBe(true);
    g.sgwlDesktop = { isDesktop: true, page: 'bundled', bundledCompat: MINE };
    expect(officialPageDiffers(SERVER)).toBe(false);
    // the page tells the app its build when it starts
    const told: string[] = [];
    g.sgwlDesktop = { isDesktop: true, page: 'official', reportBuild: (c: string) => void told.push(c) };
    reportPageBuild(SERVER);
    reportPageBuild(null);
    expect(told).toEqual([SERVER]);
  });
});
