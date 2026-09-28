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
// online screen's invite join), ?create=1 creates a room at once (App, takeCreateIntent).
// Only when it can help — the official server answers and runs another build than this page —
// and at most once a minute (the app counts its switches; a web tab keeps a sessionStorage mark):
// a mismatch that persists, or one in a room elsewhere (a LAN server, P2P), shows the message.
import { settings, type NetServerConfig } from '../game/settings';
import { COMPAT_ID } from '../net/compat';
import { isOfficialRelay, isOfficialWeb, officialServer, type OfficialServer } from '../net/official';
import { keyFor, resolveWsUrl } from '../net/relayKey';

/** sessionStorage: when this tab last switched pages for a version mismatch (ms since epoch). */
export const VERSION_FIX_KEY = 'sgwl.versionFix.v1';
/** No second automatic switch within this long of the last one (ms) — electron/page.cjs SWITCH_EVERY_MS. */
export const VERSION_FIX_EVERY_MS = 60_000;
/** How long the official server may take to say its build (ms). */
export const OFFICIAL_PROBE_TIMEOUT_MS = 2500;
/** How long the page says 「正在切换…」 before giving up on the switch (ms). */
export const SWITCH_PENDING_MS = 15_000;

const ROOM_RE = /^[A-Z0-9]{3,12}$/;

/** What the page of the server's build should do once it opens: join `room`, or create a room. */
export interface FixRequest {
  room?: string | null;
  create?: boolean;
}

export type FixOutcome = 'desktop' | 'reload' | 'open';

type FetchLike = (url: string, init: { cache: 'no-store'; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface DesktopFix {
  fixVersion?: (req: { room: string | null; create: boolean; compat: string | null }) => unknown;
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
 * itself) or <web>?create=1. A key this page holds for the official relay goes along (k=, to that
 * server's own page only — it stores the key and takes it out of the address bar).
 */
export function fixUrl(req: FixRequest, official: OfficialServer, key?: string | null): string {
  const q = new URLSearchParams();
  const room = cleanRoom(req.room);
  if (room) {
    q.set('room', room);
    q.set('mode', 'ws');
    q.set('ws', official.relay);
  } else if (req.create) q.set('create', '1');
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
}

/** when the page started a switch (it is going away): the online screen says 正在切换… meanwhile */
let pendingAt = -Infinity;

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
  if (versionFixPending(now())) return null;
  const compat = env.compat !== undefined ? env.compat : COMPAT_ID;
  const room = cleanRoom(req.room);
  const create = !room && req.create === true;
  const desktop = env.desktop !== undefined ? env.desktop : desktopBridge();
  if (desktop) {
    // the app decides (it knows both pages' builds) and counts its switches; the page never navigates itself
    if (typeof desktop.fixVersion !== 'function') return null;
    try {
      const r = (await desktop.fixVersion({ room, create, compat })) as { switched?: unknown; reason?: unknown } | null;
      if (r && r.switched === true) {
        pendingAt = now();
        return 'desktop';
      }
      if (r && typeof r.reason === 'string') console.info(`[app] version mismatch: the app does not switch (${r.reason})`);
    } catch (err) {
      console.warn('[app] the version fix failed', err);
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
  const loc = env.location !== undefined ? env.location : (globalThis as { location?: FixEnv['location'] }).location;
  if (!loc || !claimVersionFix(store, now())) return null;
  const url = fixUrl({ room, create }, official, keyFor(env.keys !== undefined ? env.keys : settings.get().net.keys, official.relay));
  const same = isOfficialWeb(loc.origin, official);
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

/**
 * Page start: ?create=1 (a version fix carried 创建房间 over) — true once; the parameter is taken
 * out of the address bar so a reload does not create another room.
 */
export function takeCreateIntent(
  env: { location?: { href: string }; history?: Pick<History, 'replaceState' | 'state'> } = globalThis as never,
): boolean {
  const href = env.location?.href;
  if (!href) return false;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.searchParams.get('create') !== '1') return false;
  u.searchParams.delete('create');
  try {
    env.history?.replaceState(env.history.state, '', u.toString());
  } catch {
    /* a sandboxed page: a reload would create again — still one room per click */
  }
  return true;
}

/** Tests: no switch in progress. */
export function resetVersionFixForTests(): void {
  pendingAt = -Infinity;
}
