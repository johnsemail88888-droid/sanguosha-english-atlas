// Which page the desktop window shows — and the only places it may show at all.
//
// The window normally shows the game the app bundles, served by the embedded LAN server
// (http://127.0.0.1:<port>/?desktop=1: fast, works offline, the LAN rooms' own build). But a
// server-run room on the official server (src/net/official.ts, the owner's Mac mini) only admits a
// page of the server's own build (src/net/compat.ts: POST /api/rooms 409, hello → versionMismatch),
// and the server updates once a day while the app updates within hours of a push. So before the
// window loads, the app asks the official server which build it runs (GET <web>sgwl.json, ≤ 2.5 s):
//
//   same build as the bundled page                              → the bundled page
//   server unreachable / not ours / silent about its build,
//   bundled build unknown, no official server in this build
//   (a VITE_OFFICIAL_WEB='' build: tests, CI), SGWL_DESKTOP_REMOTE=0 → the bundled page
//   another build                                                → the server's own page <web>?desktop=1
//                                                                  (a failed load of it: the bundled one)
//
// While the app is open the server may update (at 05:07) or the page may be the older side: a
// version mismatch the page meets asks again (fixVersion) and reloads whichever page matches, the
// room code in the URL — at most one such switch a minute; a mismatch that persists shows the message.
//
// The window may thus show remote content, so it shows exactly two origins — the embedded server's
// and the official server's: navigation anywhere else is refused, IPC answers only the top frame of
// the window on one of them, permissions go to them only, and links open in the system browser
// (https only). The bundled page's build and the official server come from dist/sgwl-build.json
// (vite.config.ts, src/net/buildInfo.ts — one source of truth for the official address).
// Plain CommonJS; Electron comes in through deps, so the unit tests run it.
'use strict';

/** How long the official server may take to say which build it runs (ms); then the bundled page loads. */
const PROBE_TIMEOUT_MS = 2500;
/** At most one automatic page switch (a version fix) this often (ms). */
const SWITCH_EVERY_MS = 60_000;
/** dist/<this>: the bundled page's build and official server (src/net/buildInfo.ts BUILD_INFO_FILE). */
const BUILD_FILE = 'sgwl-build.json';
/** What the game asks for: pointer lock (aiming), fullscreen, copying invite links. */
const PERMISSIONS = new Set(['pointerLock', 'fullscreen', 'clipboard-sanitized-write']);
/** Chromium's net error for a navigation replaced by another one: not a failure. */
const ERR_ABORTED = -3;

/** A game-compatibility id (scripts/compat-id.mjs: 12 hex characters). */
const COMPAT_RE = /^[0-9a-f]{8,64}$/;
/** A room code (src/net/roomCode.ts). */
const ROOM_RE = /^[A-Z0-9]{3,12}$/;

/** scheme://host[:port] of an http(s) URL; null for anything else (file:, javascript:, data:, junk). */
function originOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** An http(s) page URL ending in '/' (no query, no hash); '' when it is not one (src/net/official.ts normalizeWebUrl). */
function normalizeWeb(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) return '';
  try {
    const u = new URL(raw.trim());
    u.search = '';
    u.hash = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
  } catch {
    return '';
  }
}

/** A ws(s) relay URL; '' when it is not one. */
function normalizeRelay(raw) {
  if (typeof raw !== 'string' || !/^wss?:\/\//i.test(raw.trim())) return '';
  try {
    return new URL(raw.trim()).toString();
  } catch {
    return '';
  }
}

/**
 * dist/sgwl-build.json → { compat, sha, officialWeb, officialRelay } (compat null: unknown;
 * officialWeb '': this build has no official page). Junk reads as "nothing known".
 */
function readBuildInfo(text) {
  let j = null;
  try {
    j = JSON.parse(String(text));
  } catch {
    j = null;
  }
  const o = j && typeof j === 'object' ? j : {};
  const official = o.official && typeof o.official === 'object' ? o.official : {};
  const officialRelay = normalizeRelay(official.relay);
  return {
    compat: typeof o.compat === 'string' && COMPAT_RE.test(o.compat) ? o.compat : null,
    sha: typeof o.sha === 'string' && o.sha ? o.sha : null,
    // (no relay: no official server — src/net/official.ts officialFrom)
    officialWeb: officialRelay ? normalizeWeb(official.web) : '',
    officialRelay,
  };
}

/** SGWL_DESKTOP_REMOTE=0 (or false / off / no): never the official page. */
const remoteOff = (env) => /^(0|false|off|no)$/i.test(String((env && env.SGWL_DESKTOP_REMOTE) || '').trim());

/** A reason to show the bundled page without asking the server; null: ask it. */
function skipProbe(build, env) {
  if (remoteOff(env)) return 'remote page off (SGWL_DESKTOP_REMOTE=0)';
  if (!build.officialWeb) return 'no official server in this build';
  if (!build.compat) return 'bundled build unknown';
  return null;
}

const message = (err) => (err && err.message ? err.message : String(err));

/**
 * Ask the official server which build it runs: GET <web>sgwl.json (public, no-store) through
 * `fetchImpl` (Electron's net.fetch: the system proxy applies). Never throws, never takes longer
 * than `timeoutMs`. → { ok: true, compat (null: it did not say), sha } | { ok: false, reason }.
 */
async function probeOfficial(web, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, timers = { setTimeout, clearTimeout }) {
  if (!web) return { ok: false, reason: 'not configured' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'unreachable (no network API)' };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = timers.setTimeout(() => {
      if (ctrl) ctrl.abort();
      resolve({ ok: false, reason: `timeout (no answer within ${timeoutMs} ms)` });
    }, timeoutMs);
  });
  const ask = (async () => {
    let res;
    try {
      res = await fetchImpl(`${web}sgwl.json`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    } catch (err) {
      return { ok: false, reason: `unreachable (${message(err)})` };
    }
    if (!res || !res.ok) return { ok: false, reason: `answered HTTP ${res ? res.status : '?'}` };
    let j;
    try {
      j = JSON.parse(await res.text());
    } catch {
      return { ok: false, reason: 'answered no JSON' };
    }
    if (!j || typeof j !== 'object' || j.app !== 'sanguo-warlords') return { ok: false, reason: 'is not a game server' };
    const b = j.build && typeof j.build === 'object' ? j.build : {};
    return { ok: true, compat: typeof b.compat === 'string' && COMPAT_RE.test(b.compat) ? b.compat : null, sha: typeof b.sha === 'string' && b.sha ? b.sha : null };
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    timers.clearTimeout(timer);
  }
}

/** The page for the official server's answer: { page: 'bundled' | 'official', reason, serverCompat? }. */
function pageFor(build, probe) {
  if (!probe.ok) return { page: 'bundled', reason: `official server ${probe.reason}` };
  if (!probe.compat) return { page: 'bundled', reason: 'the official server did not say its build' };
  if (probe.compat === build.compat) return { page: 'bundled', reason: `same build as the official server: ${build.compat}` };
  return { page: 'official', reason: `server ${probe.compat} ≠ bundled ${build.compat}`, serverCompat: probe.compat };
}

/** Which page the window opens with (see the table above). Never throws. */
async function pickPage({ build, env, fetch, online, timeoutMs, timers }) {
  const skip = skipProbe(build, env);
  if (skip) return { page: 'bundled', reason: skip };
  if (typeof online === 'function' && !online()) return { page: 'bundled', reason: 'offline' };
  return pageFor(build, await probeOfficial(build.officialWeb, fetch, timeoutMs, timers));
}

/** A link the page opens in a new window: its https URL for the system browser; null for anything else (never file:, javascript:, custom schemes). */
function externalUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The origin allowlist (`origins()`: the embedded server's and the official server's, whatever
 * shows now) and the checks built on it — ONE place for all of them:
 *   allowsUrl(url)            navigation / redirects
 *   senderAllowed(ev, wc)     IPC: the top frame of `wc` (our window) showing an allowed origin
 *   permits(perm, url|origin) permission requests and checks
 */
function createGuard(origins) {
  const allowed = (origin) => typeof origin === 'string' && origin !== 'null' && origins().includes(origin);
  return {
    origins: () => origins().slice(),
    allowsUrl: (url) => allowed(originOf(url)),
    senderAllowed(ev, wc) {
      if (!ev || !wc || !ev.sender) return false;
      // our window's webContents (the same object — or, to be safe, the same id)
      if (ev.sender !== wc && !(typeof wc.id === 'number' && ev.sender.id === wc.id)) return false;
      const f = ev.senderFrame;
      // gone (navigated away / destroyed), or a sub-frame
      if (!f || f.parent) return false;
      // (the frame's own origin: an opaque one — sandboxed document, data: URL — is 'null')
      return allowed(typeof f.origin === 'string' ? f.origin : originOf(f.url));
    },
    permits: (permission, where) => PERMISSIONS.has(permission) && allowed(originOf(where)),
  };
}

/**
 * Keep `wc` on the allowed origins: page-initiated navigation, server redirects and sub-frame
 * navigation to anywhere else are refused (links go through setWindowOpenHandler: the system
 * browser), and no <webview> ever attaches. `onRefused(url, isMainFrame, what)` hears each refusal.
 */
function guardNavigation(wc, guard, { log = console, onRefused } = {}) {
  const refuse = (what) => (e, legacyUrl, _inPlace, legacyMain) => {
    const url = e && typeof e.url === 'string' && e.url ? e.url : legacyUrl;
    if (guard.allowsUrl(url)) return;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : !!legacyMain;
    log.warn(`[desktop] ${what} refused: ${String(url).slice(0, 200)}`);
    if (typeof onRefused === 'function') onRefused(url, main, what);
  };
  wc.on('will-navigate', refuse('navigation'));
  wc.on('will-frame-navigate', refuse('frame navigation'));
  wc.on('will-redirect', refuse('redirect'));
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

/** A version-fix request from the page, cleaned: { room | null, create, compat | null }. */
function cleanFixRequest(req) {
  const o = req && typeof req === 'object' ? req : {};
  const room = typeof o.room === 'string' && ROOM_RE.test(o.room) ? o.room : null;
  return { room, create: !room && o.create === true, compat: typeof o.compat === 'string' && COMPAT_RE.test(o.compat) ? o.compat : null };
}

/**
 * The window's page, for one app run.
 * deps: { port (the embedded server's), build (readBuildInfo), env, fetch (net.fetch),
 *   load(url) → Promise (the window's loadURL), online() → bool, log, now, defer(fn), timeoutMs }
 * Returns { origins(), current(), pick(), open(decision), onFailLoad(code, desc, url, isMainFrame),
 *   onNavigate(url, httpCode), fallback(why), fixVersion(req), useBundled(why) }.
 */
function createPages(deps) {
  const log = deps.log || console;
  const now = deps.now || Date.now;
  const defer = deps.defer || ((fn) => setTimeout(fn, 150));
  const build = deps.build;
  const env = deps.env || {};
  const bundledBase = `http://127.0.0.1:${deps.port}/`;
  // SGWL_DESKTOP_REMOTE=0 or a build without one: no official page at all (nor its origin)
  const officialWeb = remoteOff(env) ? '' : build.officialWeb;
  const officialOrigin = originOf(officialWeb);
  const allowed = [originOf(bundledBase), officialOrigin].filter(Boolean);
  const ask = () => probeOfficial(officialWeb, deps.fetch, deps.timeoutMs || PROBE_TIMEOUT_MS, deps.timers);
  /** what the window shows (or is loading): page, its build, the request it carries */
  let cur = { page: 'bundled', compat: build.compat, url: null, req: null };
  /** the official page failed since it was last chosen: the bundled page took over */
  let fellBack = false;
  let lastSwitch = -Infinity;

  /** <page>?desktop=1 — with the room (joined there by itself: mode + the official relay) or 创建房间 carried over */
  function urlFor(page, req) {
    const q = new URLSearchParams({ desktop: '1' });
    if (req && req.room) {
      q.set('room', req.room);
      if (build.officialRelay) {
        q.set('mode', 'ws');
        q.set('ws', build.officialRelay);
      }
    } else if (req && req.create) q.set('create', '1');
    return `${page === 'official' ? officialWeb : bundledBase}?${q.toString()}`;
  }

  function load(page, req, compat) {
    const url = urlFor(page, req);
    cur = { page, compat: compat || null, url, req: req || null };
    return Promise.resolve()
      .then(() => deps.load(url))
      .catch((err) => {
        // replaced by the next load (a fallback, a switch): not worth a line
        if (err && (err.code === 'ERR_ABORTED' || err.errno === ERR_ABORTED)) return;
        log.warn(`[desktop] loading ${url} failed:`, message(err));
      });
  }

  /** The official page failed: the bundled one, once (the room / 创建房间 it carried goes along). */
  function fallback(why) {
    if (cur.page !== 'official' || fellBack) return false;
    fellBack = true;
    log.warn(`[desktop] page: bundled (the official page failed: ${why})`);
    void load('bundled', cur.req, build.compat);
    return true;
  }

  return {
    origins: () => allowed.slice(),
    current: () => ({ page: cur.page, compat: cur.compat, url: cur.url }),
    /** Ask the official server (≤ timeoutMs) and log the choice: '[desktop] page: official (…)' / 'page: bundled (…)'. */
    async pick() {
      const d = await pickPage({ build: { ...build, officialWeb }, env, fetch: deps.fetch, online: deps.online, timeoutMs: deps.timeoutMs, timers: deps.timers });
      log.info(`[desktop] page: ${d.page} (${d.reason})`);
      return d;
    },
    /** Load the page `pick()` chose. */
    open(d) {
      fellBack = false;
      return d && d.page === 'official' ? load('official', null, d.serverCompat) : load('bundled', null, build.compat);
    },
    /** webContents 'did-fail-load': a main-frame failure of the official page (not a replaced load) falls back. */
    onFailLoad(code, desc, url, isMainFrame) {
      if (!isMainFrame || code === ERR_ABORTED) return false;
      return fallback(`${code} ${desc || ''}`.trim());
    },
    /** webContents 'did-navigate': the official page answered an HTTP error (the server is down behind its proxy) → fall back. */
    onNavigate(url, httpCode) {
      if (officialOrigin && originOf(url) === officialOrigin && Number(httpCode) >= 400) return fallback(`HTTP ${httpCode}`);
      return false;
    },
    fallback,
    /**
     * The page met a version mismatch on the official server: ask it again and reload the page
     * whose build matches — the bundled one, or the server's own — carrying the room / 创建房间.
     * → { switched: true, page } | { switched: false, reason } (the page shows the message then).
     */
    async fixVersion(raw) {
      const req = cleanFixRequest(raw);
      // (SGWL_DESKTOP_REMOTE=0, a build without an official server: the bundled page is all there is — nobody is asked)
      if (!officialWeb) return { switched: false, reason: 'the remote page is off (or this build has no official server)' };
      if (now() - lastSwitch < SWITCH_EVERY_MS) return { switched: false, reason: 'switched less than a minute ago' };
      const probe = await ask();
      if (!probe.ok) return { switched: false, reason: `official server ${probe.reason}` };
      if (!probe.compat) return { switched: false, reason: 'the official server did not say its build' };
      // what the page says it is (its COMPAT_ID); else what was loaded
      const pageCompat = req.compat || cur.compat;
      if (pageCompat && pageCompat === probe.compat) return { switched: false, reason: `this page already is the server's build ${probe.compat}` };
      const page = probe.compat === build.compat ? 'bundled' : 'official';
      // (checked again: another fix may have switched while this one asked)
      if (now() - lastSwitch < SWITCH_EVERY_MS) return { switched: false, reason: 'switched less than a minute ago' };
      lastSwitch = now();
      fellBack = false;
      log.info(`[desktop] page: ${page} (version fix: server ${probe.compat} ≠ page ${pageCompat || 'unknown'}${req.room ? `, room ${req.room}` : req.create ? ', create a room' : ''})`);
      // after this answer has reached the page (it says 正在切换… meanwhile)
      defer(() => void load(page, req, probe.compat));
      return { switched: true, page };
    },
    /** 切换到本机版本 (LAN play: friends on the LAN get the bundled build). false: it shows already. */
    useBundled(why) {
      if (cur.page === 'bundled') return false;
      log.info(`[desktop] page: bundled (${why || 'asked for'})`);
      void load('bundled', null, build.compat);
      return true;
    },
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  SWITCH_EVERY_MS,
  BUILD_FILE,
  PERMISSIONS,
  ERR_ABORTED,
  originOf,
  normalizeWeb,
  readBuildInfo,
  remoteOff,
  skipProbe,
  probeOfficial,
  pageFor,
  pickPage,
  externalUrl,
  createGuard,
  guardNavigation,
  cleanFixRequest,
  createPages,
};
