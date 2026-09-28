// 「版本不同」 fixes itself. A server-run room on the official server only admits a page of the
// server's own build (src/net/compat.ts: hello → versionMismatch, POST /api/rooms 409). The server
// (the owner's Mac mini) updates once a day, GitHub Pages and the desktop app within hours of a
// push — so for up to a day a page can be of another build than the server. When joining or
// creating a room on the official server meets that, the page of the server's build takes the
// attempt over instead of showing 「版本不同」:
//   the desktop app      asks the app (sgwlDesktop.fixVersion → electron/page.cjs), which reloads
//                        its window with the page whose build matches: its own, or the server's;
//   the official page    (a tab left open across the server's update) reloads itself;
//   any other page       (GitHub Pages, a LAN server's page, the offline file) opens the official page.
// The attempt travels in the URL: ?room=CODE&mode=ws&ws=<relay> joins that room by itself (the
// online screen's invite join), ?create=1&mode=ws&ws=<relay> creates a room on that server (App,
// takeCreateIntent: at once when this tab's own fix — or the desktop app — loaded it, else after a
// click: a link from anywhere must not make every visitor's browser take a server-run room). A page
// of another origin also gets the player's language and name (lang=, name=: its localStorage is
// its own).
// Only when it can help — the official server answers and runs another build than this page —
// and at most once a minute (the app counts its switches; a web tab keeps a sessionStorage mark):
// a mismatch that persists, or one in a room elsewhere (a LAN server, P2P), shows the message.
import { settings, type NetServerConfig } from '../game/settings';
import { COMPAT_ID } from '../net/compat';
import { isOfficialRelay, isOfficialWeb, officialServer, type OfficialServer } from '../net/official';
import { sanitizeName } from '../net/protocol';
import { keyFor, resolveWsUrl } from '../net/relayKey';

/** sessionStorage: when this tab last switched pages for a version mismatch (ms since epoch). */
export const VERSION_FIX_KEY = 'sgwl.versionFix.v1';
/** No second automatic switch within this long of the last one (ms) — electron/page.cjs SWITCH_EVERY_MS. */
export const VERSION_FIX_EVERY_MS = 60_000;
/**
 * How long the official server may take to say its build (ms) — electron/page.cjs
 * FIX_PROBE_TIMEOUT_MS: the player is waiting on a failed join anyway, and a slow link (a
 * cross-border round trip, a cold TLS handshake) must not turn the fix into 「版本不同」.
 */
export const OFFICIAL_PROBE_TIMEOUT_MS = 8000;
/** How long the page says 「正在切换…」 before it gives the screen back with the message (ms). */
export const SWITCH_PENDING_MS = 15_000;

const ROOM_RE = /^[A-Z0-9]{3,12}$/;

/** What the page of the server's build should do once it opens: join `room`, or create a room. */
export interface FixRequest {
  room?: string | null;
  create?: boolean;
}

/** What a page of another origin should know of the player (fixUrl): language and name. */
export interface CarriedPrefs {
  lang?: string | null;
  name?: string | null;
}

export type FixOutcome = 'desktop' | 'reload' | 'open';

type FetchLike = (url: string, init: { cache: 'no-store'; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface DesktopFix {
  fixVersion?: (req: { room: string | null; create: boolean; compat: string | null }) => unknown;
  cancelFix?: () => void;
}

/** The relay `url` (its query — a key — aside) is the official server's. */
export function isOfficialRoomServer(url: string | null | undefined, official: OfficialServer | null = officialServer()): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return isOfficialRelay(u.toString(), official);
  } catch {
    return false;
  }
}

/** A room reached with these settings lives on the official server (官方服务器, or the official page's own relay). */
export function roomOnOfficial(
  net: Pick<NetServerConfig, 'mode' | 'wsUrl'>,
  loc: { protocol: string; host: string } | null = pageLoc(),
  official: OfficialServer | null = officialServer(),
): boolean {
  return net.mode === 'ws' && isOfficialRoomServer(resolveWsUrl(net.wsUrl, loc), official);
}

function pageLoc(): { protocol: string; host: string } | null {
  const l = (globalThis as { location?: { protocol: string; host: string } }).location;
  return l ? { protocol: l.protocol, host: l.host } : null;
}

/**
 * The official server's build: GET <web>sgwl.json (public, CORS *) → its compat id; null when it
 * does not answer in time, is not the game's server or does not say.
 */
export async function officialCompat(official: OfficialServer | null, fetchImpl?: FetchLike, timeoutMs = OFFICIAL_PROBE_TIMEOUT_MS): Promise<string | null> {
  if (!official?.web) return null;
  const f = fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) return null;
  const Ctl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctl = Ctl ? new Ctl() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve(null);
    }, timeoutMs);
  });
  const ask = (async (): Promise<string | null> => {
    try {
      const r = await f(`${official.web}sgwl.json`, { cache: 'no-store', signal: ctl?.signal });
      if (!r.ok) return null;
      const j = (await r.json()) as { app?: unknown; build?: { compat?: unknown } } | null;
      if (!j || j.app !== 'sanguo-warlords') return null;
      const c = j.build?.compat;
      return typeof c === 'string' && /^[0-9a-f]{8,64}$/.test(c) ? c : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The official page that carries the attempt over: <web>?room=CODE&mode=ws&ws=<relay> (joins by
 * itself) or <web>?create=1&mode=ws&ws=<relay> (a room on that server). `prefs` (a page of another
 * origin: its localStorage is its own): lang= and name=. A key this page holds for the official
 * relay goes along (k=, to that server's own page only — it stores the key and takes it out of the
 * address bar).
 */
export function fixUrl(req: FixRequest, official: OfficialServer, key?: string | null, prefs?: CarriedPrefs): string {
  const q = new URLSearchParams();
  const room = cleanRoom(req.room);
  if (room) q.set('room', room);
  else if (req.create) q.set('create', '1');
  if (room || req.create) {
    q.set('mode', 'ws');
    q.set('ws', official.relay);
  }
  if (prefs?.lang === 'zh' || prefs?.lang === 'en') q.set('lang', prefs.lang);
  const name = typeof prefs?.name === 'string' ? sanitizeName(prefs.name, '') : '';
  if (name) q.set('name', name);
  if (key) q.set('k', key);
  const s = q.toString();
  return s ? `${official.web}?${s}` : official.web;
}

const cleanRoom = (r: string | null | undefined): string | null => {
  const s = typeof r === 'string' ? r.trim().toUpperCase() : '';
  return ROOM_RE.test(s) ? s : null;
};

/** This tab switched within VERSION_FIX_EVERY_MS (unknown storage counts as yes: a loop could not be ruled out). */
export function versionFixRecent(store: Pick<Storage, 'getItem'> | null, now = Date.now()): boolean {
  if (!store) return true;
  try {
    const last = Number(store.getItem(VERSION_FIX_KEY));
    return Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < VERSION_FIX_EVERY_MS;
  } catch {
    return true;
  }
}

/** May this tab switch now? At most once per VERSION_FIX_EVERY_MS, with working storage only. A yes is recorded. */
export function claimVersionFix(store: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): boolean {
  if (!store || versionFixRecent(store, now)) return false;
  try {
    const stamp = String(now);
    store.setItem(VERSION_FIX_KEY, stamp);
    return store.getItem(VERSION_FIX_KEY) === stamp;
  } catch {
    return false;
  }
}

function tabStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function desktopBridge(): DesktopFix | null {
  const d = (globalThis as { sgwlDesktop?: DesktopFix & { isDesktop?: boolean } }).sgwlDesktop;
  return d && d.isDesktop ? d : null;
}

/** Everything the fix touches (tests pass their own). */
export interface FixEnv {
  official?: OfficialServer | null;
  /** this page's build (COMPAT_ID) */
  compat?: string | null;
  /** window.sgwlDesktop (null: a browser) */
  desktop?: DesktopFix | null;
  location?: { origin: string; assign(url: string): void; replace(url: string): void } | null;
  store?: Pick<Storage, 'getItem' | 'setItem'> | null;
  fetch?: FetchLike;
  now?: () => number;
  /** settings.net.keys */
  keys?: NetServerConfig['keys'];
  /** the player's language and name (settings), for a page of another origin */
  prefs?: CarriedPrefs;
  /** the attempt is still wanted (false: 取消 was pressed while the server was asked — nothing switches) */
  wanted?: () => boolean;
}

/** when the page started a switch (it is going away): the online screen says 正在切换… meanwhile */
let pendingAt = -Infinity;
/** the desktop app is asking the server for a fix of this page (取消 tells it: cancelVersionFix) */
let desktopAsking: DesktopFix | null = null;

/** 取消 while a version fix asks the official server: it switches nothing (the web fix checks `wanted` itself). */
export function cancelVersionFix(): void {
  const d = desktopAsking;
  if (!d || typeof d.cancelFix !== 'function') return;
  try {
    d.cancelFix();
  } catch {
    /* an older app: its switch may still come */
  }
}

/** A switch started less than SWITCH_PENDING_MS ago: the page is about to be replaced. */
export function versionFixPending(now = Date.now()): boolean {
  return now - pendingAt >= 0 && now - pendingAt < SWITCH_PENDING_MS;
}

/**
 * Joining / creating a room on the official server met a version mismatch: switch to the page of
 * the server's build when that can help (see the top of this file). Resolves how ('desktop': the
 * app reloads the window; 'reload'; 'open': the official page) — the page is being replaced — or
 * null: it cannot help, the message stays.
 */
export async function fixVersionMismatch(req: FixRequest, env: FixEnv = {}): Promise<FixOutcome | null> {
  const now = env.now ?? Date.now;
  const wanted = env.wanted ?? (() => true);
  if (versionFixPending(now()) || !wanted()) return null;
  const compat = env.compat !== undefined ? env.compat : COMPAT_ID;
  const room = cleanRoom(req.room);
  const create = !room && req.create === true;
  const desktop = env.desktop !== undefined ? env.desktop : desktopBridge();
  if (desktop) {
    // the app decides (it knows both pages' builds) and counts its switches; the page never navigates itself
    if (typeof desktop.fixVersion !== 'function') return null;
    desktopAsking = desktop;
    try {
      const r = (await desktop.fixVersion({ room, create, compat })) as { switched?: unknown; reason?: unknown } | null;
      if (r && r.switched === true) {
        pendingAt = now();
        return 'desktop';
      }
      if (r && typeof r.reason === 'string') console.info(`[app] version mismatch: the app does not switch (${r.reason})`);
    } catch (err) {
      console.warn('[app] the version fix failed', err);
    } finally {
      desktopAsking = null;
    }
    return null;
  }
  const official = env.official !== undefined ? env.official : officialServer();
  // (a build without an id is refused for its protocol, not its build: the server's page may not match either)
  if (!official?.web || !compat) return null;
  const store = env.store !== undefined ? env.store : tabStore();
  if (versionFixRecent(store, now())) return null;
  const server = await officialCompat(official, env.fetch);
  if (!server || server === compat) return null;
  // 取消 while the server was asked: the tab stays
  if (!wanted()) return null;
  const loc = env.location !== undefined ? env.location : (globalThis as { location?: FixEnv['location'] }).location;
  if (!loc || !claimVersionFix(store, now())) return null;
  const same = isOfficialWeb(loc.origin, official);
  const s = settings.get();
  const prefs = same ? undefined : (env.prefs ?? { lang: s.lang, name: s.playerName });
  const url = fixUrl({ room, create }, official, keyFor(env.keys !== undefined ? env.keys : s.net.keys, official.relay), prefs);
  console.info(`[app] the official server runs build ${server}, this page ${compat}: ${same ? 'reloading' : 'opening the official page'}${room ? ` (room ${room})` : create ? ' (create a room)' : ''}`);
  pendingAt = now();
  if (same) loc.replace(url);
  else loc.assign(url);
  return same ? 'reload' : 'open';
}

/**
 * The official server refused to run a room for this page (POST /api/rooms 409: another build):
 * true when the page of its build takes 创建房间 over (then this page must not host the room
 * itself); false: nothing can help — this page hosts it, as before. `relay`: the server asked.
 */
export async function fixCreateOnServer(relay: string, env: FixEnv = {}): Promise<boolean> {
  if (!isOfficialRoomServer(relay, env.official !== undefined ? env.official : officialServer())) return false;
  return (await fixVersionMismatch({ create: true }, env)) !== null;
}

/** ?create=1 on a page the version fix opened: 创建房间 carried over. */
export interface CreateIntent {
  /**
   * create the room at once: the desktop app loaded this page, or this tab's own version fix
   * reloaded it (its sessionStorage mark); else — a link from anywhere — the player clicks 创建房间
   */
  auto: boolean;
  /** how the room is reached (mode=, ws=: '' is the page's own server); null: the page's default */
  mode: 'peer' | 'ws' | null;
  wsUrl: string | null;
  /** own=1 without ws= (the desktop app's 自建服务器 handoff): this page's own saved relay address (src/ui/invite.ts InviteInfo.own) */
  own?: true;
}

/** The page's address bar: read, and rewritten without the parameters a page start consumes. */
interface PageUrlEnv {
  location?: { href: string };
  history?: Pick<History, 'replaceState' | 'state'>;
}

function takeParams(env: PageUrlEnv, names: string[], when: (u: URL) => boolean): URL | null {
  const href = env.location?.href;
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!when(u)) return null;
  const orig = new URL(u.toString());
  for (const n of names) u.searchParams.delete(n);
  try {
    env.history?.replaceState(env.history.state, '', u.toString());
  } catch {
    /* a sandboxed page: the parameters stay visible */
  }
  return orig;
}

/**
 * Page start: ?create=1 (a version fix — or the desktop app's 自建服务器 handoff — carried 创建房间
 * over) — its intent, once; the parameters (create, mode, ws, own) are taken out of the address bar
 * so a reload does not create another room.
 */
export function takeCreateIntent(
  env: PageUrlEnv & { desktop?: unknown; store?: Pick<Storage, 'getItem'> | null; now?: number } = globalThis as never,
): CreateIntent | null {
  const u = takeParams(env, ['create', 'mode', 'ws', 'own'], (x) => x.searchParams.get('create') === '1');
  if (!u) return null;
  const m = u.searchParams.get('mode');
  const mode = m === 'ws' || m === 'peer' ? m : null;
  const ws = u.searchParams.get('ws');
  const wsUrl = mode === 'ws' ? (ws && /^wss?:\/\//i.test(ws.trim()) && ws.length <= 500 ? ws.trim() : '') : null;
  const desktop = 'desktop' in env ? !!env.desktop : !!desktopBridge();
  const store = 'store' in env ? (env.store ?? null) : tabStore();
  // (a tab of this origin that switched a minute ago: its own fix — unknown storage is no proof of that)
  const auto = desktop || (!!store && versionFixRecent(store, env.now ?? Date.now()));
  return mode === 'ws' && !wsUrl && u.searchParams.get('own') === '1' ? { auto, mode, wsUrl, own: true } : { auto, mode, wsUrl };
}

/**
 * Page start: ?name= (the version fix of a page of another origin carried the player's name) — the
 * name, if this page has none of its own yet; the parameter leaves the address bar. Returns the
 * name taken, or null.
 */
export function takeCarriedName(env: PageUrlEnv = globalThis as never): string | null {
  const u = takeParams(env, ['name'], (x) => x.searchParams.has('name'));
  if (!u) return null;
  const name = sanitizeName(u.searchParams.get('name') ?? '', '');
  if (!name || settings.get().playerName.trim()) return null;
  settings.update({ playerName: name });
  return name;
}

/** Tests: no switch in progress. */
export function resetVersionFixForTests(): void {
  pendingAt = -Infinity;
  desktopAsking = null;
}
