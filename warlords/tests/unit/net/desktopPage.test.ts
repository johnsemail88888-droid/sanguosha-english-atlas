// electron/page.cjs: the desktop window shows the page whose build matches the official server's —
// the bundled one (same build, server unreachable, nothing known) or the server's own page (another
// build: a server-run room only admits its own) — falls back to the bundled page when that fails,
// switches again on a version mismatch (at most once a minute, the room code kept), and only ever
// shows the embedded server's and the official server's origins. Hermetic: every "server" here is a
// stubbed fetch; nothing reaches the network.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_INFO_FILE, buildInfo } from '../../../src/net/buildInfo';
import { OFFICIAL_SERVER, officialFrom } from '../../../src/net/official';
import { choiceOf, parseInvite, relayNet } from '../../../src/ui/invite';
import { autoJoinPlan } from '../../../src/ui/screens/online';
import { appFolder, callSync, ELECTRON_DIR, launch, memStorage, menuItem, pageEvent, preload, type FetchAnswer, type Launch } from './desktopHarness';

const require = createRequire(import.meta.url);

interface Build {
  compat: string | null;
  sha: string | null;
  officialWeb: string;
  officialRelay: string;
  insecureWeb?: string;
}
interface Decision {
  page: 'bundled' | 'official';
  reason: string;
  serverCompat?: string;
}
interface Guard {
  origins(): string[];
  allowsUrl(url: unknown): boolean;
  senderAllowed(ev: unknown, wc: unknown): boolean;
  permits(permission: string, where: unknown): boolean;
}
interface Pages {
  origins(): string[];
  bundledOrigin(): string;
  bundledCompat(): string | null;
  current(): { page: string; compat: string | null; url: string | null };
  pick(): Promise<Decision>;
  open(d: Decision): Promise<void>;
  onFailLoad(code: number, desc: string, url: string, isMainFrame: boolean): boolean;
  onNavigate(url: string, httpCode: number): boolean;
  onDomReady(): void;
  fallback(why: string): boolean;
  fixVersion(req: unknown): Promise<{ switched: boolean; page?: string; reason?: string }>;
  cancelFix(): void;
  useBundled(why?: string, req?: unknown): boolean;
  notePageBuild(compat: unknown): boolean;
}
const P = require(path.join(ELECTRON_DIR, 'page.cjs')) as {
  PROBE_TIMEOUT_MS: number;
  FIX_PROBE_TIMEOUT_MS: number;
  ANSWER_TIMEOUT_MS: number;
  BOOT_TIMEOUT_MS: number;
  BOOT_RECHECK_MS: number;
  BOOT_MAX_MS: number;
  BOOTED_JS: string;
  OPEN_EVERY_MS: number;
  OPEN_MAX_PER_MIN: number;
  SWITCH_EVERY_MS: number;
  BUILD_FILE: string;
  ERR_ABORTED: number;
  originOf(url: unknown): string | null;
  secureWeb(web: string): string;
  readBuildInfo(text: unknown): Build;
  pickPage(o: { build: Build; env?: Record<string, string>; fetch?: unknown; online?: () => boolean; timeoutMs?: number }): Promise<Decision>;
  probeOfficial(web: string, fetch: unknown, timeoutMs?: number): Promise<{ ok: boolean; compat?: string | null; reason?: string }>;
  externalUrl(url: unknown): string | null;
  createOpenLimiter(now?: () => number): () => boolean;
  createGuard(origins: () => string[]): Guard;
  guardNavigation(wc: unknown, guard: Guard, o?: { log?: unknown; onRefused?: (url: string, isMainFrame: boolean, what: string) => void }): void;
  cleanFixRequest(req: unknown): { room: string | null; create: boolean; compat: string | null };
  createPages(deps: Record<string, unknown>): Pages;
};

const WEB = 'https://official.test/';
const RELAY = 'wss://official.test/ws';
const BUNDLED = 'aaaaaaaaaaaa';
const SERVER = 'bbbbbbbbbbbb';
const quiet = { info: () => undefined, warn: () => undefined };
const build = (over: Partial<Build> = {}): Build => ({ compat: BUNDLED, sha: null, officialWeb: WEB, officialRelay: RELAY, ...over });

interface StubServer {
  fetch: (url: string) => Promise<FetchAnswer>;
  asked: string[];
  /** from now on it answers `body` (the server updated) */
  set(body: unknown): void;
}

/** A stubbed fetch answering GET <web>sgwl.json with `body` (an Error: it fails; 'hang': never answers). */
function server(body0: unknown, status = 200): StubServer {
  const asked: string[] = [];
  let body = body0;
  return {
    asked,
    set: (b) => void (body = b),
    fetch: (url: string) => {
      asked.push(url);
      if (body instanceof Error) return Promise.reject(body);
      if (body === 'hang') return new Promise<FetchAnswer>(() => undefined);
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
    },
  };
}
const game = (compat?: unknown): unknown => ({ app: 'sanguo-warlords', relay: '/ws', build: compat === undefined ? {} : { compat, sha: 'abc' } });

describe('dist/sgwl-build.json: one source of truth for the official page', () => {
  it('the shipped build names the official server of src/net/official.ts; a VITE_OFFICIAL_*="" build names none', () => {
    const shipped = P.readBuildInfo(JSON.stringify(buildInfo(BUNDLED, officialFrom(OFFICIAL_SERVER, {}), 'deadbeef')));
    expect(shipped).toEqual({ compat: BUNDLED, sha: 'deadbeef', officialWeb: OFFICIAL_SERVER.web, officialRelay: OFFICIAL_SERVER.relay, insecureWeb: '' });
    // tests / CI (vite.config.ts test.env, warlords-mac.yml): no official page — the app never loads a remote one
    for (const env of [{ VITE_OFFICIAL_WEB: '', VITE_OFFICIAL_RELAY: '' }, { VITE_OFFICIAL_RELAY: '' }, { VITE_OFFICIAL_WEB: '' }]) {
      expect(P.readBuildInfo(JSON.stringify(buildInfo(BUNDLED, officialFrom(OFFICIAL_SERVER, env)))).officialWeb).toBe('');
    }
    // a fork's own server travels the same way
    const fork = officialFrom(OFFICIAL_SERVER, { VITE_OFFICIAL_WEB: 'https://x.example', VITE_OFFICIAL_RELAY: 'wss://x.example/ws' });
    expect(P.readBuildInfo(JSON.stringify(buildInfo(BUNDLED, fork))).officialWeb).toBe('https://x.example/');
    expect(P.BUILD_FILE).toBe(BUILD_INFO_FILE);
  });

  it('the vite build writes it (multi-file builds) from the env the page gets; junk reads as nothing known', () => {
    const cfg = fs.readFileSync(path.resolve(ELECTRON_DIR, '../vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/officialFrom\(OFFICIAL_SERVER, loadEnv\(mode, process\.cwd\(\), 'VITE_'\)\)/);
    expect(cfg).toMatch(/\[artIndex\(\), buildInfoFile\(mode\)\]/);
    // (the packaged app carries dist/**)
    expect(JSON.parse(fs.readFileSync(path.resolve(ELECTRON_DIR, '../package.json'), 'utf8')).build.files).toContain('dist/**/*');
    for (const junk of ['', '{', 'null', '[]', JSON.stringify({ compat: 'NOT HEX', official: { web: 'javascript:alert(1)', relay: RELAY } })]) {
      const b = P.readBuildInfo(junk);
      expect(b.compat).toBeNull();
      expect(b.officialWeb).toBe('');
    }
    // no relay: no official server at all (src/net/official.ts)
    expect(P.readBuildInfo(JSON.stringify({ compat: BUNDLED, official: { web: WEB, relay: '' } })).officialWeb).toBe('');
  });

  it('an official page over plain http is never shown (anyone on the network path could answer for it): https only, this machine aside', async () => {
    const http = P.readBuildInfo(JSON.stringify({ compat: BUNDLED, official: { web: 'http://example.com/', relay: 'ws://example.com/ws' } }));
    expect(http).toMatchObject({ officialWeb: '', insecureWeb: 'http://example.com/' });
    // → the bundled page, nobody asked
    const s = server(game(SERVER));
    expect(await P.pickPage({ build: http, env: {}, fetch: s.fetch, timeoutMs: 60 })).toEqual({ page: 'bundled', reason: 'the official server is not https (http://example.com/): never shown in the window' });
    expect(s.asked).toEqual([]);
    // … nor its origin allowed
    expect(P.createPages({ port: 8787, build: http, log: quiet, load: async () => undefined }).origins()).toEqual(['http://127.0.0.1:8787']);
    for (const [web, ok] of [
      ['https://x.example/', true],
      ['http://x.example/', false],
      ['http://192.168.1.5:8787/', false],
      ['http://127.0.0.1:9000/', true], // this machine (tests)
      ['http://localhost:9000/', true],
      ['ftp://x.example/', false],
      ['', false],
    ] as const) {
      expect(P.secureWeb(web), web).toBe(ok ? web : '');
    }
  });
});

describe('which page the window opens with', () => {
  const pick = (b: Build, fetchImpl: unknown, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    P.pickPage({ build: b, env, fetch: fetchImpl, timeoutMs: 60, ...extra });

  it('another build on the official server → its own page; the same build → the bundled page', async () => {
    const other = server(game(SERVER));
    expect(await pick(build(), other.fetch)).toEqual({ page: 'official', reason: `server ${SERVER} ≠ bundled ${BUNDLED}`, serverCompat: SERVER });
    expect(other.asked).toEqual([`${WEB}sgwl.json`]);
    expect(await pick(build(), server(game(BUNDLED)).fetch)).toMatchObject({ page: 'bundled', reason: `same build as the official server: ${BUNDLED}` });
  });

  it('anything unclear → the bundled page (fast, offline, no download)', async () => {
    const cases: [string, unknown, RegExp][] = [
      ['unreachable', server(new Error('ENOTFOUND')).fetch, /unreachable \(ENOTFOUND\)/],
      ['timeout', server('hang').fetch, /timeout/],
      ['non-JSON', server('<html>502 Bad Gateway</html>').fetch, /no JSON/],
      ['HTTP error', server(game(SERVER), 502).fetch, /HTTP 502/],
      ['a foreign app', server({ app: 'something-else', build: { compat: SERVER } }).fetch, /not a game server/],
      ['no compat', server(game()).fetch, /did not say its build/],
      ['junk compat', server(game('<script>')).fetch, /did not say its build/],
      ['no network API', null, /no network API/],
    ];
    for (const [name, f, reason] of cases) {
      const d = await pick(build(), f);
      expect(d.page, name).toBe('bundled');
      expect(d.reason, name).toMatch(reason);
    }
  });

  it('never asks when it cannot matter: SGWL_DESKTOP_REMOTE=0, no official server in the build, bundled build unknown, offline', async () => {
    const s = server(game(SERVER));
    // (every spelling of "off")
    for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
      expect(await pick(build(), s.fetch, { SGWL_DESKTOP_REMOTE: off }), off).toEqual({ page: 'bundled', reason: 'remote page off (SGWL_DESKTOP_REMOTE=0)' });
    }
    // anything else leaves it on
    expect((await pick(build(), server(game(SERVER)).fetch, { SGWL_DESKTOP_REMOTE: '1' })).page).toBe('official');
    expect(await pick(build({ officialWeb: '' }), s.fetch)).toEqual({ page: 'bundled', reason: 'no official server in this build' });
    expect(await pick(build({ compat: null }), s.fetch)).toEqual({ page: 'bundled', reason: 'bundled build unknown' });
    expect(await pick(build(), s.fetch, {}, { online: () => false })).toEqual({ page: 'bundled', reason: 'offline' });
    expect(s.asked).toEqual([]);
  });

  it('the probe gives up within its time limit (2.5 s by default)', async () => {
    expect(P.PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2500);
    const t0 = Date.now();
    expect(await P.probeOfficial(WEB, server('hang').fetch, 80)).toMatchObject({ ok: false });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

/** createPages with a stubbed window: every URL loaded, deferred loads run at once, a controllable clock. */
function pagesHarness(o: { body?: unknown; b?: Build; env?: Record<string, string> } = {}) {
  const loads: string[] = [];
  const s = server(o.body ?? game(SERVER));
  let t = 1_000_000;
  const logs: string[] = [];
  const pages = P.createPages({
    port: 8787,
    build: o.b ?? build(),
    env: o.env ?? {},
    fetch: s.fetch,
    load: async (url: string) => void loads.push(url),
    log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    now: () => t,
    defer: (fn: () => void) => fn(),
    timeoutMs: 60,
  });
  return { pages, loads, server: s, logs, tick: (ms: number) => void (t += ms), flush: () => new Promise((r) => setTimeout(r, 0)) };
}

describe('the official page, then the bundled one if it fails', () => {
  it('logs the decision and loads <official web>?desktop=1', async () => {
    const h = pagesHarness();
    const d = await h.pages.pick();
    expect(h.logs).toContain(`[desktop] page: official (server ${SERVER} ≠ bundled ${BUNDLED})`);
    await h.pages.open(d);
    expect(h.loads).toEqual([`${WEB}?desktop=1`]);
    expect(h.pages.current()).toMatchObject({ page: 'official', compat: SERVER });
  });

  it('a failed main-frame load falls back to the bundled page once; a replaced load (ERR_ABORTED) or a sub-frame is no failure', async () => {
    const h = pagesHarness();
    await h.pages.open(await h.pages.pick());
    expect(h.pages.onFailLoad(P.ERR_ABORTED, 'ERR_ABORTED', WEB, true)).toBe(false);
    expect(h.pages.onFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', `${WEB}x.png`, false)).toBe(false);
    expect(h.loads).toHaveLength(1);
    expect(h.pages.onFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', WEB, true)).toBe(true);
    await h.flush();
    expect(h.loads[1]).toBe('http://127.0.0.1:8787/?desktop=1');
    expect(h.pages.current().page).toBe('bundled');
    expect(h.logs.some((l) => /page: bundled \(the official page failed: -105 ERR_NAME_NOT_RESOLVED\)/.test(l))).toBe(true);
    // the bundled page failing is not the official page's business; no second fallback
    expect(h.pages.onFailLoad(-102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:8787/', true)).toBe(false);
    expect(h.loads).toHaveLength(2);
  });

  it('an HTTP error page from the official server (down behind its proxy) falls back too', async () => {
    const h = pagesHarness();
    await h.pages.open(await h.pages.pick());
    expect(h.pages.onNavigate(`${WEB}?desktop=1`, 200)).toBe(false);
    expect(h.pages.onNavigate(`${WEB}?desktop=1`, 502)).toBe(true);
    await h.flush();
    expect(h.loads[1]).toBe('http://127.0.0.1:8787/?desktop=1');
  });

  it('the same build: the bundled page, exactly the URL of before', async () => {
    const h = pagesHarness({ body: game(BUNDLED) });
    await h.pages.open(await h.pages.pick());
    expect(h.loads).toEqual(['http://127.0.0.1:8787/?desktop=1']);
    expect(h.pages.onFailLoad(-105, 'x', 'http://127.0.0.1:8787/', true)).toBe(false);
  });
});

describe('a version mismatch while the app is open: the page of the server’s build, the room kept', () => {
  it('the bundled page meets a server of another build → the official page joins the same room', async () => {
    const h = pagesHarness();
    await h.pages.open({ page: 'bundled', reason: 'test' });
    const r = await h.pages.fixVersion({ room: 'KX7QD', compat: BUNDLED });
    expect(r).toEqual({ switched: true, page: 'official' });
    const url = h.loads[1];
    expect(url).toBe(`${WEB}?desktop=1&room=KX7QD&mode=ws&ws=${encodeURIComponent(RELAY)}`);
    // the page it opens joins that room by itself, on the official server
    const inv = parseInvite(new URL(url).search);
    expect(inv).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: RELAY } });
    expect(autoJoinPlan({ invited: inv.room, rejoin: false, inviteTried: false, canJoin: true })).toBe('invite');
  });

  it('the official page left open across the server’s update reloads (the server’s new build); a server back on the bundled build → the bundled page', async () => {
    const h = pagesHarness({ body: game('cccccccccccc') });
    await h.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    expect(await h.pages.fixVersion({ create: true })).toEqual({ switched: true, page: 'official' });
    // (创建房间 names the server too: the page creates the room there, whatever its own saved connection)
    expect(h.loads[1]).toBe(`${WEB}?desktop=1&create=1&mode=ws&ws=${encodeURIComponent(RELAY)}`);
    const back = pagesHarness({ body: game(BUNDLED) });
    await back.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    expect(await back.pages.fixVersion({ room: 'KX7QD', compat: SERVER })).toEqual({ switched: true, page: 'bundled' });
    expect(back.loads[1]).toBe(`http://127.0.0.1:8787/?desktop=1&room=KX7QD&mode=ws&ws=${encodeURIComponent(RELAY)}`);
    expect(choiceOf('ws', parseInvite(new URL(back.loads[1]).search).net.wsUrl ?? '')).toBe('ws'); // (tests have no official server)
  });

  it('no loops: at most one switch a minute; a page of the server’s build, an unreachable server or the remote page off: no switch', async () => {
    const h = pagesHarness();
    await h.pages.open({ page: 'bundled', reason: 'test' });
    expect((await h.pages.fixVersion({ room: 'KX7QD' })).switched).toBe(true);
    h.tick(P.SWITCH_EVERY_MS - 1000);
    expect(await h.pages.fixVersion({ room: 'KX7QD' })).toMatchObject({ switched: false, reason: /less than a minute/ });
    h.tick(2000);
    // now on the official page, which is the server's build: nothing to fix
    expect(await h.pages.fixVersion({ room: 'KX7QD', compat: SERVER })).toMatchObject({ switched: false, reason: /already is the server's build/ });
    expect(h.loads).toHaveLength(2);
    const down = pagesHarness({ body: new Error('offline') });
    expect(await down.pages.fixVersion({ room: 'KX7QD', compat: BUNDLED })).toMatchObject({ switched: false, reason: /unreachable/ });
    const off = pagesHarness({ env: { SGWL_DESKTOP_REMOTE: '0' } });
    expect(off.pages.origins()).toEqual(['http://127.0.0.1:8787']);
    expect(await off.pages.fixVersion({ room: 'KX7QD', compat: BUNDLED })).toMatchObject({ switched: false, reason: /remote page is off/ });
    expect(off.server.asked).toEqual([]);
    expect([...down.loads, ...off.loads]).toEqual([]);
  });

  it('the request is cleaned: a room code, or 创建房间, and a compat id — nothing else reaches the URL', () => {
    expect(P.cleanFixRequest({ room: 'KX7QD', create: true, compat: SERVER, extra: 'x' })).toEqual({ room: 'KX7QD', create: false, compat: SERVER });
    expect(P.cleanFixRequest({ room: 'kx7qd&ws=evil', compat: 'x' })).toEqual({ room: null, create: false, compat: null });
    expect(P.cleanFixRequest({ create: true })).toEqual({ room: null, create: true, compat: null });
    expect(P.cleanFixRequest(null)).toEqual({ room: null, create: false, compat: null });
  });

  it('切换到本机版本 (LAN play) loads the bundled page', async () => {
    const h = pagesHarness();
    await h.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    expect(h.pages.useBundled('LAN')).toBe(true);
    await h.flush();
    expect(h.loads[1]).toBe('http://127.0.0.1:8787/?desktop=1');
    expect(h.pages.useBundled('LAN')).toBe(false);
  });

  it('自建服务器 on the official page (the app’s LAN server): the bundled page joins / creates the room on its own server — never the official one', async () => {
    const h = pagesHarness();
    await h.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    expect(h.pages.useBundled('LAN', { room: 'KX7QD', compat: SERVER })).toBe(true);
    await h.flush();
    const url = h.loads[1];
    expect(url).toBe('http://127.0.0.1:8787/?desktop=1&room=KX7QD&mode=ws');
    // no ws=: the page's own server (the online screen's relayNet) — the LAN relay on the bundled page
    const inv = parseInvite(new URL(url).search);
    expect(inv).toEqual({ room: 'KX7QD', mode: 'ws', net: {} });
    expect(relayNet(inv.mode!, inv.net)).toEqual({ wsUrl: '' });
    expect(choiceOf('ws', '')).toBe('ws');
    const c = pagesHarness();
    await c.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    c.pages.useBundled('LAN', { create: true });
    await c.flush();
    expect(c.loads[1]).toBe('http://127.0.0.1:8787/?desktop=1&create=1&mode=ws');
    // junk is no request
    const j = pagesHarness();
    await j.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    j.pages.useBundled('LAN', { room: 'kx7qd&ws=wss://evil.test/ws' });
    await j.flush();
    expect(j.loads[1]).toBe('http://127.0.0.1:8787/?desktop=1');
  });

  it('the page says its build when it starts: what the LAN dialog compares with the bundled build', async () => {
    const h = pagesHarness();
    await h.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    expect(h.pages.bundledCompat()).toBe(BUNDLED);
    expect(h.pages.bundledOrigin()).toBe('http://127.0.0.1:8787');
    // F5 after the server's 05:07 update: the official page is the bundled build now
    expect(h.pages.notePageBuild(BUNDLED)).toBe(true);
    expect(h.pages.current()).toMatchObject({ page: 'official', compat: BUNDLED });
    expect(h.pages.notePageBuild('<b>')).toBe(false);
    expect(h.pages.current().compat).toBe(BUNDLED);
  });
});

describe('the official page must answer and start the game — else the bundled page (a watchdog)', () => {
  interface Timer {
    fn: () => void;
    ms: number;
    cleared: boolean;
  }
  /** createPages with timers run by hand, a clock, and a page that says whether the game started (`booted`) and whether it is still loading. */
  function watched(booted?: () => Promise<boolean>, loading: () => boolean = () => false) {
    const loads: string[] = [];
    const timers: Timer[] = [];
    const logs: string[] = [];
    let t = 5_000_000;
    const pages = P.createPages({
      port: 8787,
      build: build(),
      env: {},
      fetch: server(game(SERVER)).fetch,
      load: async (url: string) => void loads.push(url),
      log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      now: () => t,
      defer: (fn: () => void) => fn(),
      booted,
      loading,
      setTimer: (fn: () => void, ms: number): Timer => {
        const x = { fn, ms, cleared: false };
        timers.push(x);
        return x;
      },
      clearTimer: (x: Timer) => void (x.cleared = true),
      timeoutMs: 60,
      fixTimeoutMs: 60,
    });
    /** the armed timers of `ms` go off (the clock moves on by `ms`; the page's answer arrives) */
    const fire = async (ms: number): Promise<void> => {
      t += ms;
      for (const x of timers.filter((y) => y.ms === ms && !y.cleared)) {
        x.cleared = true;
        x.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    };
    const armed = (): number[] => timers.filter((x) => !x.cleared).map((x) => x.ms);
    return { pages, loads, logs, fire, armed };
  }
  const committed = (w: ReturnType<typeof watched>): boolean => w.pages.onNavigate(`${WEB}?desktop=1`, 200);

  it('no answer within 15 s (the server stalls its response): the bundled page — the room the load carried goes along', async () => {
    const w = watched(async () => true);
    await w.pages.open({ page: 'bundled', reason: 'test' });
    expect(w.armed()).toEqual([]); // the bundled page is never watched
    expect(await w.pages.fixVersion({ room: 'KX7QD', compat: BUNDLED })).toEqual({ switched: true, page: 'official' });
    expect(w.armed()).toEqual([P.ANSWER_TIMEOUT_MS, P.BOOT_TIMEOUT_MS]);
    await w.fire(P.ANSWER_TIMEOUT_MS);
    expect(w.loads.at(-1)).toBe(`http://127.0.0.1:8787/?desktop=1&room=KX7QD&mode=ws&ws=${encodeURIComponent(RELAY)}`);
    expect(w.pages.current().page).toBe('bundled');
    expect(w.logs.some((l) => l.includes('the official page failed: no answer within 15 s'))).toBe(true);
    expect(w.armed()).toEqual([]);
  });

  it('answered, but the game never started (its script did not arrive: 正在加载… for ever): the bundled page after 30 s', async () => {
    let asked = 0;
    const w = watched(async () => (asked++, false));
    await w.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    expect(committed(w)).toBe(false); // (the navigation committed: answered)
    await w.fire(P.ANSWER_TIMEOUT_MS);
    expect(w.loads).toHaveLength(1);
    await w.fire(P.BOOT_TIMEOUT_MS);
    expect(asked).toBe(1);
    expect(w.loads).toEqual([`${WEB}?desktop=1`, 'http://127.0.0.1:8787/?desktop=1']);
    expect(w.logs.some((l) => /the game did not start within \d+ s/.test(l))).toBe(true);
    // a page that cannot answer (its renderer stuck) counts as not started
    const stuck = watched(() => Promise.reject(new Error('no answer')));
    await stuck.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    stuck.pages.onDomReady();
    await stuck.fire(P.BOOT_TIMEOUT_MS);
    expect(stuck.pages.current().page).toBe('bundled');
    expect(P.BOOTED_JS).toContain('.sg-root');
  });

  it('a slow link (the bundle still on its way): it waits while the page loads — up to 2 minutes in all', async () => {
    let started = false;
    const slow = watched(async () => started, () => !started);
    await slow.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    committed(slow);
    await slow.fire(P.BOOT_TIMEOUT_MS);
    expect(slow.armed()).toEqual([P.ANSWER_TIMEOUT_MS, P.BOOT_RECHECK_MS]); // not yet, still loading: another look (the answer came: its timer is a no-op)
    await slow.fire(P.BOOT_RECHECK_MS);
    started = true; // the game is on screen by the next look
    await slow.fire(P.BOOT_RECHECK_MS);
    expect(slow.loads).toHaveLength(1);
    expect(slow.pages.current().page).toBe('official');
    // a page that keeps "loading" for ever (a stalled script): the bundled page at BOOT_MAX_MS
    const stalled = watched(async () => false, () => true);
    await stalled.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    committed(stalled);
    await stalled.fire(P.BOOT_TIMEOUT_MS);
    let looks = 0;
    while (stalled.armed().includes(P.BOOT_RECHECK_MS) && looks < 100) {
      await stalled.fire(P.BOOT_RECHECK_MS);
      looks++;
    }
    expect(looks).toBe((P.BOOT_MAX_MS - P.BOOT_TIMEOUT_MS) / P.BOOT_RECHECK_MS);
    expect(stalled.pages.current().page).toBe('bundled');
    expect(stalled.logs.some((l) => l.includes('the game did not start within 120 s'))).toBe(true);
  });

  it('a game that started stays; a newer load disarms the older one’s watchdog; nothing to ask: no fallback on a guess', async () => {
    const w = watched(async () => true);
    await w.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    w.pages.onDomReady();
    await w.fire(P.ANSWER_TIMEOUT_MS);
    await w.fire(P.BOOT_TIMEOUT_MS);
    expect(w.loads).toHaveLength(1);
    expect(w.pages.current().page).toBe('official');
    expect(w.armed()).toEqual([]);
    // 切换到本机版本 before the watchdog went off: it does nothing then
    const v = watched(async () => false);
    await v.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    v.pages.useBundled('LAN');
    expect(v.armed()).toEqual([]);
    await v.fire(P.BOOT_TIMEOUT_MS);
    expect(v.loads).toHaveLength(2);
    // no way to ask the page (deps.booted absent): counts as started
    const n = watched(undefined);
    await n.pages.open({ page: 'official', reason: 'test', serverCompat: SERVER });
    n.pages.onDomReady();
    await n.fire(P.BOOT_TIMEOUT_MS);
    expect(n.pages.current().page).toBe('official');
  });
});

describe('a version fix waits longer than the start-up does; 取消 stops it', () => {
  it('a server answering after 3 s: too slow for the start-up (the bundled page), in time for the fix', async () => {
    expect(P.FIX_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
    vi.useFakeTimers();
    try {
      const slow = (): Promise<FetchAnswer> =>
        new Promise((r) => setTimeout(() => r({ ok: true, status: 200, text: async () => JSON.stringify(game(SERVER)) }), 3000));
      const loads: string[] = [];
      const pages = P.createPages({ port: 8787, build: build(), env: {}, fetch: slow, load: async (u: string) => void loads.push(u), log: quiet, defer: (fn: () => void) => fn(), setTimer: () => 0, clearTimer: () => undefined });
      const picked = pages.pick();
      await vi.advanceTimersByTimeAsync(P.PROBE_TIMEOUT_MS + 10);
      expect(await picked).toMatchObject({ page: 'bundled', reason: expect.stringMatching(/timeout/) });
      await pages.open(await picked);
      const fixed = pages.fixVersion({ room: 'KX7QD', compat: BUNDLED });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await fixed).toEqual({ switched: true, page: 'official' });
      expect(loads.at(-1)).toMatch(/^https:\/\/official\.test\/\?desktop=1&room=KX7QD/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('取消 while the server is asked: that fix switches nothing; a later one does', async () => {
    let answer!: (a: FetchAnswer) => void;
    const loads: string[] = [];
    const pages = P.createPages({
      port: 8787,
      build: build(),
      env: {},
      fetch: () => new Promise<FetchAnswer>((r) => (answer = r)),
      load: async (u: string) => void loads.push(u),
      log: quiet,
      defer: (fn: () => void) => fn(),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    await pages.open({ page: 'bundled', reason: 'test' });
    const fix = pages.fixVersion({ room: 'KX7QD', compat: BUNDLED });
    pages.cancelFix();
    answer({ ok: true, status: 200, text: async () => JSON.stringify(game(SERVER)) });
    expect(await fix).toEqual({ switched: false, reason: 'cancelled' });
    expect(loads).toHaveLength(1);
    const again = pages.fixVersion({ room: 'KX7QD', compat: BUNDLED });
    answer({ ok: true, status: 200, text: async () => JSON.stringify(game(SERVER)) });
    expect(await again).toEqual({ switched: true, page: 'official' });
  });
});

describe('the window only ever shows the game’s two origins', () => {
  const origins = ['http://127.0.0.1:8787', 'https://official.test'];
  const guard = P.createGuard(() => origins);
  const wc = { id: 1 };
  const ev = (frame: Record<string, unknown> | null, sender: unknown = wc) => ({ sender, senderFrame: frame });

  it('the allowlist: exactly the embedded server and the official server (scheme + host + port)', () => {
    const pages = pagesHarness().pages;
    expect(pages.origins()).toEqual(origins);
    for (const ok of ['http://127.0.0.1:8787/?desktop=1', 'https://official.test/?room=KX7QD', 'https://official.test/assets/x.js']) expect(guard.allowsUrl(ok), ok).toBe(true);
    for (const bad of [
      'https://evil.test/',
      'http://official.test/', // another scheme
      'https://official.test:8443/', // another port
      'http://localhost:8787/', // another host name
      'http://127.0.0.1:8788/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'sgwl://x',
      'about:blank',
      '',
      null,
    ]) {
      expect(guard.allowsUrl(bad), String(bad)).toBe(false);
    }
  });

  it('IPC: only the top frame of our window on an allowed origin (one helper for every sgwl:* channel)', () => {
    expect(guard.senderAllowed(ev({ origin: 'http://127.0.0.1:8787', parent: null }), wc)).toBe(true);
    expect(guard.senderAllowed(ev({ origin: 'https://official.test', parent: null }), wc)).toBe(true);
    expect(guard.senderAllowed(ev({ origin: 'https://evil.test', parent: null }), wc)).toBe(false);
    expect(guard.senderAllowed(ev({ origin: 'https://official.test', parent: {} }), wc)).toBe(false); // a sub-frame
    expect(guard.senderAllowed(ev({ origin: 'null', url: 'https://official.test/', parent: null }), wc)).toBe(false); // opaque origin
    expect(guard.senderAllowed(ev(null), wc)).toBe(false); // the frame is gone
    expect(guard.senderAllowed(ev({ origin: 'https://official.test', parent: null }, { id: 2 }), wc)).toBe(false); // another webContents
    expect(guard.senderAllowed(ev({ origin: 'https://official.test', parent: null }, { id: 1 }), wc)).toBe(true); // ours, another wrapper
    expect(guard.senderAllowed(ev({ origin: 'https://official.test', parent: null }, {}), {})).toBe(false); // no ids to match
    expect(guard.senderAllowed(ev({ origin: 'https://official.test', parent: null }), null)).toBe(false); // no window
    expect(guard.senderAllowed(null, wc)).toBe(false);
    // (an older Electron without frame.origin: the frame's URL)
    expect(guard.senderAllowed(ev({ url: 'https://official.test/?desktop=1', parent: null }), wc)).toBe(true);
    // nothing is allowed before the embedded server is up
    expect(P.createGuard(() => []).senderAllowed(ev({ origin: 'http://127.0.0.1:8787', parent: null }), wc)).toBe(false);
  });

  it('permissions: pointer lock, fullscreen, copying — for the allowed origins only', () => {
    for (const p of ['pointerLock', 'fullscreen', 'clipboard-sanitized-write']) {
      expect(guard.permits(p, 'https://official.test/?desktop=1')).toBe(true);
      expect(guard.permits(p, 'http://127.0.0.1:8787')).toBe(true);
      expect(guard.permits(p, 'https://evil.test')).toBe(false);
    }
    for (const p of ['notifications', 'media', 'geolocation', 'clipboard-read', 'openExternal', 'hid']) expect(guard.permits(p, 'https://official.test')).toBe(false);
  });

  it('navigation, redirects and sub-frames elsewhere are refused; no <webview> attaches', () => {
    const listeners: Record<string, (...a: unknown[]) => void> = {};
    const refused: [string, boolean, string][] = [];
    P.guardNavigation({ on: (e: string, cb: (...a: unknown[]) => void) => void (listeners[e] = cb) }, guard, { log: quiet, onRefused: (u, m, w) => void refused.push([u, m, w]) });
    const nav = (event: string, url: string, isMainFrame = true) => {
      let prevented = false;
      listeners[event]({ url, isMainFrame, preventDefault: () => void (prevented = true) }, url);
      return prevented;
    };
    expect(nav('will-navigate', 'https://official.test/?room=KX7QD')).toBe(false);
    expect(nav('will-navigate', 'http://127.0.0.1:8787/?desktop=1')).toBe(false);
    expect(nav('will-navigate', 'https://evil.test/')).toBe(true);
    expect(nav('will-navigate', 'file:///C:/Windows/')).toBe(true);
    expect(nav('will-redirect', 'https://evil.test/login')).toBe(true);
    expect(nav('will-frame-navigate', 'https://ads.test/frame', false)).toBe(true);
    expect(refused).toEqual([
      ['https://evil.test/', true, 'navigation'],
      ['file:///C:/Windows/', true, 'navigation'],
      ['https://evil.test/login', true, 'redirect'],
      ['https://ads.test/frame', false, 'frame navigation'],
    ]);
    let blocked = false;
    listeners['will-attach-webview']({ preventDefault: () => void (blocked = true) });
    expect(blocked).toBe(true);
  });

  it('links open in the system browser: https only — never file:, javascript: or custom schemes', () => {
    expect(P.externalUrl('https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases')).toBe('https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases');
    for (const bad of ['http://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'ms-settings:privacy', 'vbscript:x', '', null, 'not a url']) {
      expect(P.externalUrl(bad), String(bad)).toBeNull();
    }
  });

  it('… rationed: one every 2 s, five a minute at most (a page’s window.open in a loop cannot flood the browser with tabs)', () => {
    let t = 0;
    const may = P.createOpenLimiter(() => t);
    expect(may()).toBe(true);
    expect(may()).toBe(false); // at once again
    t += P.OPEN_EVERY_MS - 1;
    expect(may()).toBe(false);
    let opened = 1;
    for (let i = 0; i < 20; i++) {
      t += P.OPEN_EVERY_MS;
      if (may()) opened++;
    }
    // 20 × 2 s = 40 s: within the minute, five at most
    expect(opened).toBe(P.OPEN_MAX_PER_MIN);
    t += 60_000;
    expect(may()).toBe(true);
  });

  it('the preload requires nothing but electron (the renderer is sandboxed: anything else would leave the page without its bridge)', () => {
    const src = fs.readFileSync(path.join(ELECTRON_DIR, 'preload.cjs'), 'utf8');
    expect([...src.matchAll(/\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2])).toEqual(['electron']);
    expect(src).not.toMatch(/\brequire\s*\(\s*[^'"`\s]/); // no computed require either
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});

// ── main.cjs with a stubbed Electron: the whole start-up ────────────────────
const tmpDirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-page-'));
  tmpDirs.push(d);
  return d;
};
const apps: Launch[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.quit();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A packaged app whose dist/sgwl-build.json says `info`, against an official server answering `body`. */
async function start(body: unknown, opts: { env?: Record<string, string>; info?: unknown } = {}): Promise<Launch & { asked: string[]; server: StubServer }> {
  const s = server(body);
  // (info: null — no dist/sgwl-build.json at all)
  const info = 'info' in opts ? opts.info : buildInfo(BUNDLED, { web: WEB, relay: RELAY });
  const app = await launch(tmp(), { appDir: appFolder(tmp(), info), fetch: s.fetch, env: opts.env });
  apps.push(app);
  return Object.assign(app, { asked: s.asked, server: s });
}

/** The embedded server's origin of a launch (its --sgwl-port). */
const bundledOrigin = (app: Launch): string => `http://127.0.0.1:${Number(/--sgwl-port=(\d+)/.exec((app.prefs.additionalArguments as string[]).join(' '))?.[1])}`;

describe('desktop start-up (electron/main.cjs, stubbed Electron)', () => {
  it('another build on the official server: the window opens its page; the renderer is sandboxed and locked down', async () => {
    const app = await start(game(SERVER));
    expect(app.url).toBe(`${WEB}?desktop=1`);
    expect(app.asked).toEqual([`${WEB}sgwl.json`]);
    expect(app.logs).toContain(`[desktop] page: official (server ${SERVER} ≠ bundled ${BUNDLED})`);
    expect(app.prefs).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false });
    const args = app.prefs.additionalArguments as string[];
    const port = Number(/--sgwl-port=(\d+)/.exec(args.join(' '))?.[1]);
    const origins = JSON.parse(decodeURIComponent(args.find((a) => a.startsWith('--sgwl-origins='))!.split('=')[1]));
    expect(origins).toEqual([`http://127.0.0.1:${port}`, 'https://official.test']);
    // permissions: request and check handlers, both origin-bound
    const granted: boolean[] = [];
    app.permissions.request!(app.wc, 'pointerLock', (ok: boolean) => granted.push(ok), { requestingUrl: `${WEB}?desktop=1` });
    app.permissions.request!(app.wc, 'pointerLock', (ok: boolean) => granted.push(ok), { requestingUrl: 'https://evil.test/' });
    app.permissions.request!(app.wc, 'notifications', (ok: boolean) => granted.push(ok), { requestingUrl: `${WEB}?desktop=1` });
    expect(granted).toEqual([true, false, false]);
    expect(app.permissions.check!(app.wc, 'clipboard-sanitized-write', 'https://official.test', {})).toBe(true);
    expect(app.permissions.check!(app.wc, 'clipboard-sanitized-write', 'https://evil.test', {})).toBe(false);
    // links: the system browser, https only
    expect(app.openHandler!({ url: 'https://github.com/x' })).toEqual({ action: 'deny' });
    expect(app.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(app.opened).toEqual(['https://github.com/x']);
    // navigation elsewhere is refused
    let prevented = false;
    app.wc.emit('will-navigate', { url: 'https://evil.test/', isMainFrame: true, preventDefault: () => void (prevented = true) }, 'https://evil.test/');
    expect(prevented).toBe(true);
    // the official page does not load: the bundled one
    app.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', `${WEB}?desktop=1`, true);
    expect(await app.load(1)).toBe(`http://127.0.0.1:${port}/?desktop=1`);
  });

  it('the official page answers an HTTP error (its server down behind the proxy), or redirects off its origin: the bundled page', async () => {
    const bad = await start(game(SERVER));
    // (did-navigate: event, url, httpResponseCode — as Electron passes them)
    bad.wc.emit('did-navigate', {}, `${WEB}?desktop=1`, 502);
    expect(await bad.load(1)).toBe(`${bundledOrigin(bad)}/?desktop=1`);
    const moved = await start(game(SERVER));
    let prevented = false;
    moved.wc.emit('will-redirect', { url: 'https://evil.test/', isMainFrame: true, preventDefault: () => void (prevented = true) }, 'https://evil.test/');
    expect(prevented).toBe(true);
    expect(await moved.load(1)).toBe(`${bundledOrigin(moved)}/?desktop=1`);
    // a sub-frame's redirect is refused, and the page stays
    const sub = await start(game(SERVER));
    sub.wc.emit('will-redirect', { url: 'https://ads.test/', isMainFrame: false, preventDefault: () => undefined }, 'https://ads.test/');
    await new Promise((r) => setTimeout(r, 20));
    expect(sub.loads).toHaveLength(1);
  });

  it('downloads are refused (no native Save dialog for a page’s file); links open rationed', async () => {
    const app = await start(game(SERVER));
    let prevented = false;
    const item = { getURL: () => 'https://official.test/SanguoWarlords-Windows-setup.exe' };
    for (const cb of app.sessionOn['will-download'] ?? []) cb({ preventDefault: () => void (prevented = true) }, item);
    expect(app.sessionOn['will-download']).toHaveLength(1);
    expect(prevented).toBe(true);
    expect(app.logs.some((l) => l.includes('download refused https://official.test/SanguoWarlords-Windows-setup.exe'))).toBe(true);
    // window.open in a loop: one tab
    for (let i = 0; i < 10; i++) app.openHandler!({ url: `https://phish.test/${i}` });
    expect(app.opened).toEqual(['https://phish.test/0']);
  });

  it('the same build, SGWL_DESKTOP_REMOTE=0, a build without an official server: the bundled page as before', async () => {
    const same = await start(game(BUNDLED));
    expect(same.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?desktop=1$/);
    expect(same.logs).toContain(`[desktop] page: bundled (same build as the official server: ${BUNDLED})`);
    const off = await start(game(SERVER), { env: { SGWL_DESKTOP_REMOTE: '0' } });
    expect(off.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?desktop=1$/);
    expect(off.asked).toEqual([]);
    const offOrigins = JSON.parse(decodeURIComponent((off.prefs.additionalArguments as string[]).find((a) => a.startsWith('--sgwl-origins='))!.split('=')[1]));
    expect(offOrigins).toEqual([new URL(off.url).origin]);
    // a CI / test build (VITE_OFFICIAL_*=''): never asks anyone
    const ci = await start(game(SERVER), { info: buildInfo(BUNDLED, officialFrom(OFFICIAL_SERVER, { VITE_OFFICIAL_RELAY: '', VITE_OFFICIAL_WEB: '' })) });
    expect(ci.asked).toEqual([]);
    expect(ci.logs).toContain('[desktop] page: bundled (no official server in this build)');
    // no sgwl-build.json at all (an older dist: the file cannot be read): nothing known, nothing asked
    const none = await start(game(SERVER), { info: null });
    expect(none.asked).toEqual([]);
    expect(none.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?desktop=1$/);
    expect(none.logs).toContain('[desktop] page: bundled (no official server in this build)');
    // an empty one: the same
    const empty = await start(game(SERVER), { info: '' });
    expect(empty.asked).toEqual([]);
    // every spelling of SGWL_DESKTOP_REMOTE=0
    for (const v of ['false', 'off', 'no']) {
      const o = await start(game(SERVER), { env: { SGWL_DESKTOP_REMOTE: v } });
      expect(o.asked, v).toEqual([]);
      expect(o.url, v).toBe(`${bundledOrigin(o)}/?desktop=1`);
    }
  }, 30_000);

  it('every sgwl:* IPC channel answers the game’s pages only; the preload exposes sgwlDesktop to them only', async () => {
    const app = await start(game(SERVER));
    const official = 'https://official.test';
    // the official page: the bridge, told which page it is
    const bridge: Record<string, unknown> = {};
    const unload = preload(memStorage(), app, { origin: official, exposed: bridge });
    expect(bridge).toMatchObject({ isDesktop: true, page: 'official' });
    unload();
    // a foreign origin, a sub-frame: nothing exposed
    const foreign: Record<string, unknown> = {};
    preload(memStorage(), app, { origin: 'https://evil.test', exposed: foreign })();
    preload(memStorage(), app, { origin: official, exposed: foreign, subFrame: true })();
    expect(foreign).toEqual({});
    // … and main refuses them anyway: a synchronous call gets null, an invoke null
    const evil = pageEvent(app, 'https://evil.test');
    for (const ch of ['sgwl:storage-load', 'sgwl:update-get', 'sgwl:lan-urls', 'sgwl:webgl']) {
      expect(callSync(app, ch, evil), ch).toBeNull();
      expect(callSync(app, ch, pageEvent(app, official, { senderFrame: { origin: official, parent: {} } })), ch).toBeNull();
      expect(callSync(app, ch, pageEvent(app, official, { sender: {} })), ch).toBeNull();
    }
    expect(await app.handle['sgwl:fix-version'](evil, { room: 'KX7QD' })).toBeNull();
    expect(callSync(app, 'sgwl:update-get', pageEvent(app, official))).toMatchObject({ status: 'idle' });
  });

  it('this machine’s LAN addresses and the embedded server’s port go to the app’s own page only — never to the official server’s (remote) page', async () => {
    const app = await start(game(SERVER));
    const official = 'https://official.test';
    const remote: Record<string, unknown> = {};
    preload(memStorage(), app, { origin: official, exposed: remote })();
    expect(remote).toMatchObject({ isDesktop: true, page: 'official', bundledCompat: BUNDLED });
    for (const k of ['lanUrls', 'getLanUrls', 'port']) expect(remote, k).not.toHaveProperty(k);
    // and main refuses to hand them over
    expect(callSync(app, 'sgwl:lan-urls', pageEvent(app, official))).toBeNull();
    // the app's own page has them
    const own: Record<string, unknown> = {};
    preload(memStorage(), app, { origin: bundledOrigin(app), exposed: own })();
    expect(own).toMatchObject({ page: 'bundled', port: Number(new URL(bundledOrigin(app)).port), lanUrls: expect.any(Array) });
    expect(callSync(app, 'sgwl:lan-urls', pageEvent(app, bundledOrigin(app)))).toEqual(expect.any(Array));
  });

  it('the settings follow to the official page’s origin (its own localStorage) and back — stale ones never win', async () => {
    const app = await start(game(SERVER));
    const bundled = memStorage();
    let unload = preload(bundled, app, { origin: bundledOrigin(app) });
    bundled.setItem('sgwl.settings.v1', '{"playerName":"赵云"}');
    unload();
    // the official origin's own localStorage: stale, from a visit long ago — the newer settings are restored into it
    // (its own keys the mirror does not share with it stay as they are)
    const official = memStorage({ 'sgwl.settings.v1': '{"playerName":"主公"}', 'sgwl.old.v0': 'x', 'sgwl.sktips.v1': 'old' });
    const bridge: Record<string, unknown> = {};
    unload = preload(official, app, { origin: 'https://official.test', exposed: bridge });
    expect(official.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云"}');
    expect(official.getItem('sgwl.old.v0')).toBe('x');
    expect(official.getItem('sgwl.sktips.v1')).toBeNull(); // a shared key the app's page does not have
    official.setItem('sgwl.guide.v1', '3');
    // a version fix flushes the settings before the other page reads them (here: nothing to switch)
    await (bridge.fixVersion as (req: unknown) => Promise<unknown>)({ room: 'KX7QD', compat: SERVER });
    // back on the bundled page: it catches up
    const back = preload(bundled, app, { origin: bundledOrigin(app) });
    expect(bundled.getItem('sgwl.guide.v1')).toBe('3');
    expect(bundled.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云"}');
    // the official page going away late (its pagehide after the switch) writes what it changed — and does
    // not undo newer settings it never touched (a whole-snapshot save would put 赵云 back)
    bundled.setItem('sgwl.settings.v1', '{"playerName":"张飞"}');
    back();
    official.setItem('sgwl.gpuWarn.off', '1');
    unload();
    const later = memStorage();
    preload(later, app, { origin: bundledOrigin(app) })();
    expect(later.getItem('sgwl.settings.v1')).toBe('{"playerName":"张飞"}');
    expect(later.getItem('sgwl.guide.v1')).toBe('3');
    expect(later.getItem('sgwl.gpuWarn.off')).toBe('1');
  });

  it('the official page (remote content) gets the preferences only: no relay keys, TURN password, relay addresses or switches — and plants none', async () => {
    const app = await start(game(SERVER));
    const OWN_RELAY = 'ws://192.168.1.5:8787/ws';
    const net = {
      mode: 'ws',
      wsUrl: OWN_RELAY,
      keys: { 'ws://192.168.1.5:8787': 'lan-secret-key', 'wss://friend.example': 'friend-secret', 'wss://official.test': 'official-own-key' },
      turnUrl: 'turn:turn.example',
      turnUser: 'u',
      turnPass: 'turn-password',
      peerHost: 'peers.example',
    };
    const mine = { playerName: '赵云', lang: 'en', quality: 'high', fov: 90, net };
    const bundled = memStorage();
    let unload = preload(bundled, app, { origin: bundledOrigin(app) });
    bundled.setItem('sgwl.settings.v1', JSON.stringify(mine));
    bundled.setItem('sgwl.ui.netChoice.v2', '1');
    bundled.setItem('sgwl.ui.customWsUrl', OWN_RELAY);
    bundled.setItem('sgwl.debug', '1');
    bundled.setItem('sgwl.guide.v1', '4');
    unload();

    // → the official page: name, language, graphics, guide — and of the keys the official server's own only
    const official = memStorage({ 'sgwl.settings.v1': JSON.stringify({ playerName: '主公', net: { mode: 'peer', wsUrl: '' } }) });
    unload = preload(official, app, { origin: 'https://official.test' });
    const got = JSON.parse(official.getItem('sgwl.settings.v1')!);
    expect(got).toMatchObject({ playerName: '赵云', lang: 'en', quality: 'high', fov: 90 });
    expect(got.net).toEqual({ mode: 'peer', wsUrl: '', keys: { 'wss://official.test': 'official-own-key' } });
    const everything = JSON.stringify(Object.fromEntries(Array.from({ length: official.length }, (_, i) => [official.key(i), official.getItem(official.key(i)!)])));
    for (const secret of ['lan-secret-key', 'friend-secret', 'turn-password', '192.168.1.5', 'peers.example', 'turn.example']) expect(everything, secret).not.toContain(secret);
    for (const k of ['sgwl.ui.netChoice.v2', 'sgwl.ui.customWsUrl', 'sgwl.debug']) expect(official.getItem(k), k).toBeNull();
    expect(official.getItem('sgwl.guide.v1')).toBe('4');

    // ← the official page (compromised) plants an attacker's relay, a debug switch, wipes the keys — and renames the player
    official.setItem('sgwl.settings.v1', JSON.stringify({ ...got, playerName: '关羽', quality: 'nonsense', fov: 'x', net: { mode: 'ws', wsUrl: 'wss://attacker.example/ws', keys: {}, turnUrl: 'turn:attacker.example' } }));
    official.setItem('sgwl.ui.netChoice.v2', '1');
    official.setItem('sgwl.ui.customWsUrl', 'wss://attacker.example/ws');
    official.setItem('sgwl.debug', '1');
    official.setItem('sgwl.x.v9', 'planted');
    official.removeItem('sgwl.guide.v1');
    unload();

    // the app's own page afterwards: its connection exactly as it was; the (valid) name did cross
    const later = memStorage();
    preload(later, app, { origin: bundledOrigin(app) })();
    const after = JSON.parse(later.getItem('sgwl.settings.v1')!);
    expect(after.net).toEqual(net);
    expect(after).toMatchObject({ playerName: '关羽', quality: 'high', fov: 90 }); // junk values are dropped
    expect(later.getItem('sgwl.ui.customWsUrl')).toBe(OWN_RELAY);
    expect(later.getItem('sgwl.x.v9')).toBeNull();
    expect(later.getItem('sgwl.guide.v1')).toBeNull(); // (a shared preference: removing it is the page's to do)
    const file = JSON.parse(fs.readFileSync(path.join(app.userData, 'web-storage.json'), 'utf8')) as { items: Record<string, string> };
    expect(file.items['sgwl.ui.customWsUrl']).toBe(OWN_RELAY);
    expect(file.items['sgwl.debug']).toBe('1'); // the app page's own switch, untouched
    expect(JSON.stringify(file)).not.toContain('attacker.example');
  });

  it('the server updates while the app is open: a version fix reloads the window with its page, the room code kept — once a minute', async () => {
    const app = await start(game(BUNDLED));
    expect(app.url).toBe(`${bundledOrigin(app)}/?desktop=1`);
    // the bundled page claims the server's build: nothing to fix
    expect(await app.handle['sgwl:fix-version'](pageEvent(app), { room: 'KX7QD', compat: BUNDLED })).toMatchObject({ switched: false, reason: /already is the server's build/ });
    // 05:07: the server runs another build now
    app.server.set(game(SERVER));
    expect(await app.handle['sgwl:fix-version'](pageEvent(app), { room: 'KX7QD', compat: BUNDLED })).toEqual({ switched: true, page: 'official' });
    expect(await app.load(1)).toBe(`${WEB}?desktop=1&room=KX7QD&mode=ws&ws=${encodeURIComponent(RELAY)}`);
    expect(app.logs.some((l) => l.startsWith(`[desktop] page: official (version fix: server ${SERVER} ≠ page ${BUNDLED}, room KX7QD`))).toBe(true);
    // and not again within the minute, whatever the page says
    app.server.set(game('cccccccccccc'));
    expect(await app.handle['sgwl:fix-version'](pageEvent(app, 'https://official.test'), { room: 'KX7QD', compat: SERVER })).toMatchObject({ switched: false, reason: /less than a minute/ });
  });

  it('菜单「局域网联机地址…」 on the official page of another build: says so, offers 切换到本机版本 — but Enter / Esc only close it', async () => {
    const app = await start(game(SERVER));
    const lanItem = menuItem(app.menu, '局域网联机地址…')!;
    expect(lanItem).toBeTruthy();
    lanItem.click!();
    await new Promise((r) => setTimeout(r, 10));
    expect(app.dialogs[0]).toMatchObject({ buttons: ['切换到本机版本 / Use this app’s version', '关闭 / Close'], defaultId: 1, cancelId: 1 });
    expect(String(app.dialogs[0].detail)).toContain('与本机版本不同');
    expect(app.loads).toHaveLength(1); // closed: nothing switched
    // a click on it switches
    app.answers.push(0);
    lanItem.click!();
    expect(await app.load(1)).toBe(`${bundledOrigin(app)}/?desktop=1`);
  });

  it('… mid-match it asks once more (取消 the default); a new page (did-navigate) is no longer mid-match', async () => {
    const app = await start(game(SERVER));
    const official = pageEvent(app, 'https://official.test');
    app.ipc['sgwl:update-playing'](official, true);
    const lanItem = menuItem(app.menu, '局域网联机地址…')!;
    app.answers.push(0); // 切换到本机版本 — then the confirmation's default: 取消
    lanItem.click!();
    await new Promise((r) => setTimeout(r, 10));
    expect(app.dialogs).toHaveLength(2);
    expect(app.dialogs[1]).toMatchObject({ type: 'warning', defaultId: 1, cancelId: 1 });
    expect(app.loads).toHaveLength(1);
    app.answers.push(0, 0); // … and 仍然切换
    lanItem.click!();
    expect(await app.load(1)).toBe(`${bundledOrigin(app)}/?desktop=1`);
    // the page went away: the match is over as far as the app knows
    const again = await start(game(SERVER));
    again.ipc['sgwl:update-playing'](pageEvent(again, 'https://official.test'), true);
    again.wc.emit('did-navigate', {}, `${WEB}?desktop=1`, 200);
    again.answers.push(0);
    menuItem(again.menu, '局域网联机地址…')!.click!();
    expect(await again.load(1)).toBe(`${bundledOrigin(again)}/?desktop=1`);
    expect(again.dialogs).toHaveLength(1);
  });

  it('… the official page of the very build the app bundles (the page said so), or the bundled page: no warning, no switch to offer', async () => {
    const app = await start(game(SERVER));
    // F5 after the server's update: the page reports the bundled build
    app.ipc['sgwl:page-build'](pageEvent(app, 'https://official.test'), BUNDLED);
    menuItem(app.menu, '局域网联机地址…')!.click!();
    await new Promise((r) => setTimeout(r, 10));
    expect(app.dialogs[0]).not.toHaveProperty('buttons');
    expect(String(app.dialogs[0].detail)).not.toContain('与本机版本不同');
    const own = await start(game(BUNDLED));
    menuItem(own.menu, '局域网联机地址…')!.click!();
    await new Promise((r) => setTimeout(r, 10));
    expect(own.dialogs[0]).not.toHaveProperty('buttons');
  });

  it('the official page’s 自建服务器 (no address): the bundled page takes the room over on the app’s own server', async () => {
    const app = await start(game(SERVER));
    const bridge: Record<string, unknown> = {};
    preload(memStorage(), app, { origin: 'https://official.test', exposed: bridge })();
    (bridge.useBundled as (req?: unknown) => void)({ room: 'KX7QD' });
    expect(await app.load(1)).toBe(`${bundledOrigin(app)}/?desktop=1&room=KX7QD&mode=ws`);
    const c = await start(game(SERVER));
    const cb: Record<string, unknown> = {};
    preload(memStorage(), c, { origin: 'https://official.test', exposed: cb })();
    (cb.useBundled as (req?: unknown) => void)({ create: true });
    expect(await c.load(1)).toBe(`${bundledOrigin(c)}/?desktop=1&create=1&mode=ws`);
    // 取消 through the bridge reaches the app
    expect(typeof cb.cancelFix).toBe('function');
    expect(() => (cb.cancelFix as () => void)()).not.toThrow();
  });
});
