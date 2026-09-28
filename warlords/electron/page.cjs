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
//   (a VITE_OFFICIAL_WEB='' build: tests, CI; a plain-http one),
//   SGWL_DESKTOP_REMOTE=0                                        → the bundled page
//   another build                                                → the server's own page <web>?desktop=1
//                                                                  (a failed or stalled load of it, or a
//                                                                  game that does not start: the bundled one)
//
// While the app is open the server may update (at 05:07) or the page may be the older side: a
// version mismatch the page meets asks again (fixVersion) and reloads whichever page matches, the
// room code in the URL — at most one such switch a minute; a mismatch that persists shows the message.
//
// The window may thus show remote content, so it shows exactly two origins — the embedded server's
// and the official server's: navigation anywhere else is refused, IPC answers only the top frame of
// the window on one of them, permissions go to them only, and links open in the system browser
// (https only, rationed). The official origin is remote content: it gets no LAN addresses and only
// the player's preferences (state.cjs), and it cannot hold updates back for good (updater.cjs).
// The bundled page's build and the official server come from dist/sgwl-build.json
// (vite.config.ts, src/net/buildInfo.ts — one source of truth for the official address).
// Plain CommonJS; Electron comes in through deps, so the unit tests run it.
'use strict';

/** How long the official server may take to say which build it runs at start-up (ms); then the bundled page loads. */
const PROBE_TIMEOUT_MS = 2500;
/**
 * The same question after a version mismatch (fixVersion, ms): the player is waiting on a failed
 * join anyway — a slow link (a cross-border round trip, a cold TLS handshake) must not turn the fix
 * into 「版本不同」.
 */
const FIX_PROBE_TIMEOUT_MS = 8000;
/** The official server must answer the page's load (the navigation commits) within this long (ms), else the bundled page takes over. */
const ANSWER_TIMEOUT_MS = 15_000;
/**
 * … and the game must be on screen (its UI root) this long after the load (ms): a script that never
 * arrived leaves 正在加载… for ever. A page still loading (a slow link: the 2 MB bundle) gets another
 * look every BOOT_RECHECK_MS, up to BOOT_MAX_MS in all.
 */
const BOOT_TIMEOUT_MS = 30_000;
const BOOT_RECHECK_MS = 10_000;
const BOOT_MAX_MS = 120_000;
/** What main.cjs asks the page to tell whether the game started (every build of the game has this root). */
const BOOTED_JS = "!!document.querySelector('.sg-root')";
/** At most one link to the system browser this often (ms), and at most OPEN_MAX_PER_MIN a minute: no page floods the browser with tabs. */
const OPEN_EVERY_MS = 2000;
const OPEN_MAX_PER_MIN = 5;
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

/**
 * The official page is shown in the app's window with the desktop bridge and the player's
 * preferences: https only (nobody on the network path can answer for an https origin). Plain
 * http only on this machine (tests). '' for anything else.
 */
function secureWeb(web) {
  if (!web) return '';
  try {
    const u = new URL(web);
    if (u.protocol === 'https:') return web;
    return u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) ? web : '';
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
 * dist/sgwl-build.json → { compat, sha, officialWeb, officialRelay, insecureWeb } (compat null:
 * unknown; officialWeb '': this build has no official page — none at all, or a plain-http one,
 * which insecureWeb then names: it is never shown). Junk reads as "nothing known".
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
  // (no relay: no official server — src/net/official.ts officialFrom)
  const web = officialRelay ? normalizeWeb(official.web) : '';
  const officialWeb = secureWeb(web);
  return {
    compat: typeof o.compat === 'string' && COMPAT_RE.test(o.compat) ? o.compat : null,
    sha: typeof o.sha === 'string' && o.sha ? o.sha : null,
    officialWeb,
    officialRelay,
    insecureWeb: web && !officialWeb ? web : '',
  };
}

/** SGWL_DESKTOP_REMOTE=0 (or false / off / no): never the official page. */
const remoteOff = (env) => /^(0|false|off|no)$/i.test(String((env && env.SGWL_DESKTOP_REMOTE) || '').trim());

/** A reason to show the bundled page without asking the server; null: ask it. */
function skipProbe(build, env) {
  if (remoteOff(env)) return 'remote page off (SGWL_DESKTOP_REMOTE=0)';
  if (!build.officialWeb && build.insecureWeb) return `the official server is not https (${build.insecureWeb}): never shown in the window`;
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
 * Links to the system browser, rationed: at most one every OPEN_EVERY_MS and OPEN_MAX_PER_MIN a
 * minute (Electron has no popup blocker: a page's window.open in a loop would fill the player's
 * browser with tabs that seem to come from the game). → allow(): true when this one may open.
 */
function createOpenLimiter(now = Date.now) {
  const recent = [];
  return () => {
    const t = now();
    while (recent.length && t - recent[0] >= 60_000) recent.shift();
    if (recent.length && t - recent[recent.length - 1] < OPEN_EVERY_MS) return false;
    if (recent.length >= OPEN_MAX_PER_MIN) return false;
    recent.push(t);
    return true;
  };
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

/** A game-compatibility id, or null. */
const cleanCompat = (v) => (typeof v === 'string' && COMPAT_RE.test(v) ? v : null);

/**
 * The window's page, for one app run.
 * deps: { port (the embedded server's), build (readBuildInfo), env, fetch (net.fetch),
 *   load(url) → Promise (the window's loadURL), online() → bool, booted() → Promise<bool> (the game
 *   is on screen: main.cjs runs BOOTED_JS in the page), loading() → bool (the page is still
 *   loading), log, now, defer(fn), setTimer(fn, ms), clearTimer(t), timeoutMs (the start-up
 *   probe's), fixTimeoutMs (a version fix's) }
 * Returns { origins(), bundledOrigin(), bundledCompat(), current(), pick(), open(decision),
 *   onFailLoad(code, desc, url, isMainFrame), onNavigate(url, httpCode), onDomReady(), fallback(why),
 *   fixVersion(req), cancelFix(), useBundled(why, req), notePageBuild(compat) }.
 */
function createPages(deps) {
  const log = deps.log || console;
  const now = deps.now || Date.now;
  const defer = deps.defer || ((fn) => setTimeout(fn, 150));
  const setTimer =
    deps.setTimer ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    });
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const build = deps.build;
  const env = deps.env || {};
  const bundledBase = `http://127.0.0.1:${deps.port}/`;
  const bundledOrigin = originOf(bundledBase);
  // SGWL_DESKTOP_REMOTE=0 or a build without one: no official page at all (nor its origin)
  const officialWeb = remoteOff(env) ? '' : build.officialWeb;
  const officialOrigin = originOf(officialWeb);
  const allowed = [bundledOrigin, officialOrigin].filter(Boolean);
  // (a version fix waits longer than the start-up does: FIX_PROBE_TIMEOUT_MS)
  const ask = () => probeOfficial(officialWeb, deps.fetch, deps.fixTimeoutMs || FIX_PROBE_TIMEOUT_MS, deps.timers);
  /** what the window shows (or is loading): page, its build, the request it carries */
  let cur = { page: 'bundled', compat: build.compat, url: null, req: null };
  /** the official page failed since it was last chosen: the bundled page took over */
  let fellBack = false;
  let lastSwitch = -Infinity;
  /** bumped by every load: the watchdog of an earlier load does nothing */
  let loadSeq = 0;
  /** the official server answered the page's load (its navigation committed) */
  let answered = false;
  let watch = [];
  /** version fixes asked, and the last one the page cancelled (取消 while the server was asked) */
  let fixSeq = 0;
  let cancelledUpTo = 0;

  /**
   * <page>?desktop=1 — with the room (joined there by itself) or 创建房间 carried over, and how that
   * room is reached: mode=ws + the official relay; `lan`: mode=ws alone (the page's own server — the
   * bundled page's is the app's LAN server).
   */
  function urlFor(page, req) {
    const q = new URLSearchParams({ desktop: '1' });
    if (req && req.room) q.set('room', req.room);
    else if (req && req.create) q.set('create', '1');
    if (req && (req.room || req.create)) {
      if (req.lan) q.set('mode', 'ws');
      else if (build.officialRelay) {
        q.set('mode', 'ws');
        q.set('ws', build.officialRelay);
      }
    }
    return `${page === 'official' ? officialWeb : bundledBase}?${q.toString()}`;
  }

  function disarm() {
    for (const t of watch) clearTimer(t);
    watch = [];
  }

  /** The game is on screen (deps.booted; none: it counts as started — never a fallback on a guess). */
  function isBooted() {
    if (typeof deps.booted !== 'function') return Promise.resolve(true);
    return Promise.resolve()
      .then(() => deps.booted())
      .then(
        (v) => v !== false,
        () => false,
      );
  }

  /** The page is still loading (deps.loading: a slow link's bundle on its way); unknown: no. */
  function stillLoading() {
    try {
      return typeof deps.loading === 'function' && deps.loading() === true;
    } catch {
      return false;
    }
  }

  /**
   * The official page must be answered (its navigation commits within ANSWER_TIMEOUT_MS) and start
   * the game (its UI within BOOT_TIMEOUT_MS — longer while it is still loading, BOOT_MAX_MS at most),
   * else the bundled page: a stalled response, or an entry script that never arrived (a Funnel
   * reset, the server restarting between the HTML and its scripts), would leave the window blank or
   * on 正在加载… with nothing to click.
   */
  function arm(seq) {
    answered = false;
    const since = now();
    const still = () => seq === loadSeq && cur.page === 'official';
    const bootCheck = () => {
      if (!still()) return;
      void isBooted().then((ok) => {
        if (ok || !still()) return;
        if (stillLoading() && now() - since + BOOT_RECHECK_MS <= BOOT_MAX_MS) watch.push(setTimer(bootCheck, BOOT_RECHECK_MS));
        else fallback(`the game did not start within ${Math.round((now() - since) / 1000)} s`);
      });
    };
    watch.push(
      setTimer(() => {
        if (still() && !answered) fallback(`no answer within ${ANSWER_TIMEOUT_MS / 1000} s`);
      }, ANSWER_TIMEOUT_MS),
      setTimer(bootCheck, BOOT_TIMEOUT_MS),
    );
  }

  function load(page, req, compat) {
    const url = urlFor(page, req);
    cur = { page, compat: compat || null, url, req: req || null };
    const seq = ++loadSeq;
    disarm();
    if (page === 'official') arm(seq);
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
    /** http://127.0.0.1:<port>: the app's own page (the other allowed origin is remote content) */
    bundledOrigin: () => bundledOrigin,
    /** the bundled page's build (null: unknown) */
    bundledCompat: () => build.compat,
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
    /**
     * webContents 'did-navigate' (the main frame's navigation committed): the official server
     * answered — with an HTTP error (the server is down behind its proxy) → fall back.
     */
    onNavigate(url, httpCode) {
      if (!officialOrigin || originOf(url) !== officialOrigin) return false;
      answered = true;
      if (Number(httpCode) >= 400) return fallback(`HTTP ${httpCode}`);
      return false;
    },
    /** webContents 'dom-ready': the page's document is there (answered, at the latest now; the watchdog then waits for the game). */
    onDomReady() {
      answered = true;
    },
    fallback,
    /**
     * The page met a version mismatch on the official server: ask it again and reload the page
     * whose build matches — the bundled one, or the server's own — carrying the room / 创建房间.
     * → { switched: true, page } | { switched: false, reason } (the page shows the message then).
     */
    async fixVersion(raw) {
      const req = cleanFixRequest(raw);
      const ticket = ++fixSeq;
      // (SGWL_DESKTOP_REMOTE=0, a build without an official server: the bundled page is all there is — nobody is asked)
      if (!officialWeb) return { switched: false, reason: 'the remote page is off (or this build has no official server)' };
      if (now() - lastSwitch < SWITCH_EVERY_MS) return { switched: false, reason: 'switched less than a minute ago' };
      const probe = await ask();
      // 取消 while the server was asked: the screen is the player's again
      if (ticket <= cancelledUpTo) return { switched: false, reason: 'cancelled' };
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
    /** 取消 on the page while a version fix asks the server: the fixes asked so far switch nothing. */
    cancelFix() {
      cancelledUpTo = fixSeq;
    },
    /**
     * The bundled page: 切换到本机版本 (LAN play — friends on the LAN get the bundled build), or the
     * official page's 自建服务器 without an address of its own (that is the app's LAN server) with
     * the room / 创建房间 carried over (`req`). false: it shows already.
     */
    useBundled(why, raw) {
      if (cur.page === 'bundled') return false;
      const r = raw ? cleanFixRequest(raw) : null;
      const req = r && (r.room || r.create) ? { room: r.room, create: r.create, lan: true } : null;
      log.info(`[desktop] page: bundled (${why || 'asked for'}${req ? (req.room ? `, room ${req.room}` : ', create a room') : ''})`);
      void load('bundled', req, build.compat);
      return true;
    },
    /** The page says which build it is (its COMPAT_ID, when it starts): what the LAN dialog compares with the bundled build. */
    notePageBuild(compat) {
      const c = cleanCompat(compat);
      if (c) cur = { ...cur, compat: c };
      return !!c;
    },
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  FIX_PROBE_TIMEOUT_MS,
  ANSWER_TIMEOUT_MS,
  BOOT_TIMEOUT_MS,
  BOOT_RECHECK_MS,
  BOOT_MAX_MS,
  BOOTED_JS,
  OPEN_EVERY_MS,
  OPEN_MAX_PER_MIN,
  SWITCH_EVERY_MS,
  BUILD_FILE,
  PERMISSIONS,
  ERR_ABORTED,
  originOf,
  normalizeWeb,
  secureWeb,
  readBuildInfo,
  remoteOff,
  skipProbe,
  probeOfficial,
  pageFor,
  pickPage,
  externalUrl,
  createOpenLimiter,
  createGuard,
  guardNavigation,
  cleanFixRequest,
  createPages,
};
