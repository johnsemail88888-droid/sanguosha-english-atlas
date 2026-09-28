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
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_INFO_FILE, buildInfo } from '../../../src/net/buildInfo';
import { OFFICIAL_SERVER, officialFrom } from '../../../src/net/official';
import { choiceOf, parseInvite } from '../../../src/ui/invite';
import { autoJoinPlan } from '../../../src/ui/screens/online';
import { appFolder, callSync, ELECTRON_DIR, launch, memStorage, pageEvent, preload, type FetchAnswer, type Launch } from './desktopHarness';

const require = createRequire(import.meta.url);

interface Build {
  compat: string | null;
  sha: string | null;
  officialWeb: string;
  officialRelay: string;
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
  current(): { page: string; compat: string | null; url: string | null };
  pick(): Promise<Decision>;
  open(d: Decision): Promise<void>;
  onFailLoad(code: number, desc: string, url: string, isMainFrame: boolean): boolean;
  onNavigate(url: string, httpCode: number): boolean;
  fallback(why: string): boolean;
  fixVersion(req: unknown): Promise<{ switched: boolean; page?: string; reason?: string }>;
  useBundled(why?: string): boolean;
}
const P = require(path.join(ELECTRON_DIR, 'page.cjs')) as {
  PROBE_TIMEOUT_MS: number;
  SWITCH_EVERY_MS: number;
  BUILD_FILE: string;
  ERR_ABORTED: number;
  originOf(url: unknown): string | null;
  readBuildInfo(text: unknown): Build;
  pickPage(o: { build: Build; env?: Record<string, string>; fetch?: unknown; online?: () => boolean; timeoutMs?: number }): Promise<Decision>;
  probeOfficial(web: string, fetch: unknown, timeoutMs?: number): Promise<{ ok: boolean; compat?: string | null; reason?: string }>;
  externalUrl(url: unknown): string | null;
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
    expect(shipped).toEqual({ compat: BUNDLED, sha: 'deadbeef', officialWeb: OFFICIAL_SERVER.web, officialRelay: OFFICIAL_SERVER.relay });
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
    expect(await pick(build(), s.fetch, { SGWL_DESKTOP_REMOTE: '0' })).toEqual({ page: 'bundled', reason: 'remote page off (SGWL_DESKTOP_REMOTE=0)' });
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
    expect(h.loads[1]).toBe(`${WEB}?desktop=1&create=1`);
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
  const info = opts.info ?? buildInfo(BUNDLED, { web: WEB, relay: RELAY });
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
    // no sgwl-build.json at all (an older dist): nothing known, nothing asked
    const none = await start(game(SERVER), { info: '' });
    expect(none.asked).toEqual([]);
    expect(none.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?desktop=1$/);
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
    expect(callSync(app, 'sgwl:lan-urls', pageEvent(app, official))).toEqual(expect.any(Array));
  });

  it('the settings follow to the official page’s origin (its own localStorage) and back — stale ones never win', async () => {
    const app = await start(game(SERVER));
    const bundled = memStorage();
    let unload = preload(bundled, app, { origin: bundledOrigin(app) });
    bundled.setItem('sgwl.settings.v1', '{"playerName":"赵云"}');
    unload();
    // the official origin's own localStorage: stale, from a visit long ago — the newer settings are restored into it
    const official = memStorage({ 'sgwl.settings.v1': '{"playerName":"主公"}', 'sgwl.old.v0': 'x' });
    const bridge: Record<string, unknown> = {};
    unload = preload(official, app, { origin: 'https://official.test', exposed: bridge });
    expect(official.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云"}');
    expect(official.getItem('sgwl.old.v0')).toBeNull();
    official.setItem('sgwl.keys.v1', 'custom');
    // a version fix flushes the settings before the other page reads them (here: nothing to switch)
    await (bridge.fixVersion as (req: unknown) => Promise<unknown>)({ room: 'KX7QD', compat: SERVER });
    // back on the bundled page: it catches up
    const back = preload(bundled, app, { origin: bundledOrigin(app) });
    expect(bundled.getItem('sgwl.keys.v1')).toBe('custom');
    expect(bundled.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云"}');
    // the official page going away late (its pagehide after the switch) writes what it changed — and does
    // not undo newer settings it never touched (a whole-snapshot save would put 赵云 back)
    bundled.setItem('sgwl.settings.v1', '{"playerName":"张飞"}');
    back();
    official.setItem('sgwl.guide.v1', '5');
    unload();
    const later = memStorage();
    preload(later, app, { origin: bundledOrigin(app) })();
    expect(later.getItem('sgwl.settings.v1')).toBe('{"playerName":"张飞"}');
    expect(later.getItem('sgwl.guide.v1')).toBe('5');
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
});
