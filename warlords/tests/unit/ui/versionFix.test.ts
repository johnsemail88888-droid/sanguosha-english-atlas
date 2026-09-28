// 「版本不同」 fixes itself (src/ui/versionFix.ts): a page of another build than the official
// server's that meets a version mismatch there opens the official page with the room code (or
// reloads, on the official page itself); the desktop page asks the app instead. Only when it can
// help, at most once a minute. Hermetic: the "official server" is a stubbed fetch.
import { afterEach, describe, expect, it } from 'vitest';
import { isBuildMismatch } from '../../../src/net/headlessRooms';
import { hostOnlineSession } from '../../../src/net';
import { setOfficialServerForTests } from '../../../src/net/official';
import { settings } from '../../../src/game/settings';
import { choiceOf, parseInvite } from '../../../src/ui/invite';
import { autoJoinPlan } from '../../../src/ui/screens/online';
import {
  claimVersionFix,
  fixCreateOnServer,
  fixUrl,
  fixVersionMismatch,
  isOfficialRoomServer,
  officialCompat,
  resetVersionFixForTests,
  roomOnOfficial,
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

  it('创建房间 carries over as ?create=1; a key this page holds for the official server goes along (to its own page only)', async () => {
    const p = web('https://johnsemail88888-droid.github.io', undefined, { keys: { 'wss://official.test': 'k3y-k3y-k3y-k3y' } });
    expect(await fixVersionMismatch({ create: true }, p.env)).toBe('open');
    expect(p.went[0].url).toBe('https://official.test/?create=1&k=k3y-k3y-k3y-k3y');
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
    expect(p.went[0].url).toBe('https://official.test/?create=1');
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
  it('creates the room once: the parameter leaves the address bar (F5 creates none)', () => {
    const replaced: string[] = [];
    const env = { location: { href: 'https://official.test/?create=1&desktop=1' }, history: { state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) } };
    expect(takeCreateIntent(env)).toBe(true);
    expect(replaced).toEqual(['https://official.test/?desktop=1']);
    expect(takeCreateIntent({ location: { href: 'https://official.test/?room=KX7QD' }, history: env.history })).toBe(false);
    expect(takeCreateIntent({})).toBe(false);
  });
});
