// Invite links and reload-rejoin: an invite carries the room code AND how to
// reach it (P2P or the relay server, plus a non-default PeerJS / relay server),
// so a friend who opens it — or a guest who presses F5 mid-match — connects the
// same way the host did instead of the (possibly different) saved default.
// A relay server that requires an access key (RELAY_KEY) gets it carried too (k=…):
// the page stores it per server and takes it out of the address bar (src/net/relayKey.ts).
import { DEFAULT_SETTINGS, settings, type NetServerConfig } from '../game/settings';
import { isOfficialRelay, officialServer, type OfficialServer } from '../net/official';
import { cleanKey, KEY_PARAM, keyFor, relayOrigin, resolveWsUrl, splitKey, withKey } from '../net/relayKey';
import { isPublicWebOrigin, shareBase } from './desktop';

export type NetMode = 'peer' | 'ws';

/** Server fields an invite / rejoin record may carry (never TURN credentials). */
export type InviteNet = Partial<Pick<NetServerConfig, 'peerHost' | 'peerPort' | 'peerPath' | 'peerSecure' | 'wsUrl'>>;

export interface InviteInfo {
  room: string | null;
  mode: NetMode | null;
  net: InviteNet;
  /** the relay server's access key (k=…, or a k inside ws=); absent when there is none */
  key?: string;
}

/** The PeerJS server differs from the default public cloud. */
export function customPeerServer(net: Pick<NetServerConfig, 'peerHost' | 'peerPort' | 'peerPath' | 'peerSecure'>): boolean {
  const d = DEFAULT_SETTINGS.net;
  return !!net.peerHost.trim() && (net.peerHost.trim() !== d.peerHost || net.peerPort !== d.peerPort || net.peerPath !== d.peerPath || net.peerSecure !== d.peerSecure);
}

/**
 * Invite link for a room code, based on the current page URL. `mode` and a
 * non-default server travel along: `&mode=peer|ws`, then `&ph=&pp=&pa=&ps=0|1`
 * (PeerJS) or `&ws=` (relay), and a relay room on a server that requires a key
 * (one this page has stored for it) `&k=`.
 */
export function inviteLink(
  code: string,
  loc: { origin: string; pathname: string } = location,
  conn?: { mode: NetMode; net: Pick<NetServerConfig, 'peerHost' | 'peerPort' | 'peerPath' | 'peerSecure' | 'wsUrl' | 'keys'> },
): string {
  // desktop app: the page is http://127.0.0.1:<port>/ — friends need the LAN address
  const q = new URLSearchParams();
  q.set('room', code);
  if (conn) {
    q.set('mode', conn.mode);
    if (conn.mode === 'peer' && customPeerServer(conn.net)) {
      q.set('ph', conn.net.peerHost.trim());
      q.set('pp', String(conn.net.peerPort));
      q.set('pa', conn.net.peerPath || '/');
      q.set('ps', conn.net.peerSecure ? '1' : '0');
    } else if (conn.mode === 'ws' && conn.net.wsUrl.trim()) {
      q.set('ws', conn.net.wsUrl.trim());
    }
    const key = conn.mode === 'ws' ? keyFor(conn.net.keys, relayOf(conn.net.wsUrl, loc.origin)) : null;
    if (key) q.set(KEY_PARAM, key);
  }
  return `${shareBase(loc, conn?.mode, conn?.mode === 'ws' ? conn.net.wsUrl : undefined)}?${q.toString()}`;
}

/** The relay a relay-mode room of this page is on: the configured address, else the page's own server. */
function relayOf(wsUrl: string, origin: string): string | null {
  let loc: { protocol: string; host: string } | null = null;
  try {
    const u = new URL(origin);
    loc = { protocol: u.protocol, host: u.host };
  } catch {
    /* no page origin (file://): only a configured address counts */
  }
  return resolveWsUrl(wsUrl, loc);
}

/** Read an invite (or any page URL) query string: room code, mode, server overrides and key. */
export function parseInvite(search: string): InviteInfo {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return { room: null, mode: null, net: {} };
  }
  const roomRaw = q.get('room');
  const room = roomRaw ? roomRaw.trim().toUpperCase() : null;
  const m = q.get('mode');
  const mode: NetMode | null = m === 'peer' || m === 'ws' ? m : null;
  const net: InviteNet = {};
  const ph = q.get('ph');
  if (ph && ph.trim().length <= 253) {
    net.peerHost = ph.trim();
    const pp = Number.parseInt(q.get('pp') ?? '', 10);
    if (Number.isFinite(pp) && pp > 0 && pp < 65536) net.peerPort = pp;
    const pa = q.get('pa');
    if (pa && pa.length <= 200) net.peerPath = pa.startsWith('/') ? pa : `/${pa}`;
    const ps = q.get('ps');
    if (ps === '0' || ps === '1') net.peerSecure = ps === '1';
  }
  const ws = q.get('ws');
  let key = cleanKey(q.get(KEY_PARAM));
  if (ws && /^wss?:\/\//i.test(ws.trim()) && ws.length <= 500) {
    // a key pasted into the relay address travels as the key, never inside the address
    const split = splitKey(ws);
    net.wsUrl = split.url;
    key ??= split.key;
  }
  return key ? { room, mode, net, key } : { room, mode, net };
}

/**
 * The relay server a page URL's key is for: its ws= relay; else the page's own server
 * (the SHARE LINK https://<host>/?k=…); on a page without a server of its own (GitHub
 * Pages, the offline file) this build's official relay. null when none applies.
 */
export function keyTargetOrigin(page: URL, inv: InviteInfo, official: OfficialServer | null = officialServer()): string | null {
  if (inv.net.wsUrl) return relayOrigin(resolveWsUrl(inv.net.wsUrl, { protocol: page.protocol, host: page.host }) ?? '');
  if ((page.protocol === 'http:' || page.protocol === 'https:') && !isPublicWebOrigin(page.origin)) return relayOrigin(page.origin);
  return official ? relayOrigin(official.relay) : null;
}

/**
 * A page URL carrying a key (k=…, or a k inside ws=): the key, the server it is for, and
 * the same URL without it (room / mode / ws= kept). null when the URL has no key at all.
 */
export function keyFromPageUrl(href: string, official: OfficialServer | null = officialServer()): { origin: string | null; key: string | null; cleanHref: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const ws = u.searchParams.get('ws');
  const wsHasKey = !!ws && splitKey(ws).url !== ws.trim();
  if (!u.searchParams.has(KEY_PARAM) && !wsHasKey) return null;
  const inv = parseInvite(u.search);
  u.searchParams.delete(KEY_PARAM);
  if (wsHasKey && ws) u.searchParams.set('ws', splitKey(ws).url);
  const key = inv.key ?? null;
  return { origin: key ? keyTargetOrigin(u, inv, official) : null, key, cleanHref: u.toString() };
}

/**
 * At page start: a key in the address (a SHARE / invite link) is stored for its server
 * (settings.net.keys) and taken out of the address bar — it must not end up in a
 * bookmark, a screenshot or a link copied from there. The room, mode and ws= stay (the
 * online screen reads them). Returns the server origin the key was stored for.
 */
export function captureKeyFromPage(
  env: { location?: { href: string }; history?: Pick<History, 'replaceState' | 'state'> } = globalThis as never,
  official: OfficialServer | null = officialServer(),
): string | null {
  const href = env.location?.href;
  if (!href) return null;
  const got = keyFromPageUrl(href, official);
  if (!got) return null;
  if (got.key && got.origin) {
    const net = settings.get().net;
    if (net.keys?.[got.origin] !== got.key) settings.update({ net: { ...net, keys: withKey(net.keys, got.origin, got.key) } });
  }
  try {
    env.history?.replaceState(env.history.state, '', got.cleanHref);
  } catch {
    /* a sandboxed page: the key stays visible, it still works */
  }
  return got.key ? got.origin : null;
}

// ── reload rejoin ────────────────────────────────────────────────────────────

/**
 * A lost link to a room that may still be there (not kicked / closed / full / gone):
 * the rejoin record and the seat token are kept, and the player is offered
 * 重新加入 {CODE} (MP2-3).
 */
export function isReconnectable(code: string | undefined): boolean {
  return code === 'connectionLost' || code === 'timeout' || code === 'closed' || code === 'serverUnreachable' || code === 'networkRestricted';
}

const REJOIN_KEY = 'sgwl.rejoin.v1';
/** a rejoin record older than this is ignored (the match is long over) */
export const REJOIN_MAX_AGE_MS = 30 * 60_000;

export interface RejoinInfo {
  code: string;
  mode: NetMode;
  net: InviteNet;
  /** Date.now() when saved */
  at: number;
}

function tabStore(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Remember how this tab joined `code` (next to the net layer's seat token, also per tab). */
export function saveRejoin(info: Omit<RejoinInfo, 'at'>, store: Pick<Storage, 'setItem'> | null = tabStore(), now = Date.now()): void {
  try {
    store?.setItem(REJOIN_KEY, JSON.stringify({ ...info, at: now }));
  } catch {
    /* storage blocked: F5 falls back to the saved default mode */
  }
}

/**
 * The rejoin record of a guest session that is still alive (`joined`: how this tab joined
 * its room, kept by the app for the session's lifetime) saved again with a fresh age — a
 * drop or an F5 an hour into the session still offers 重新加入 and keeps the seat token
 * (a record dated at the join aged out after REJOIN_MAX_AGE_MS: the drop wiped both).
 * Without a live session: the stored record, if it is young enough.
 */
export function refreshRejoin(
  joined: Omit<RejoinInfo, 'at'> | null,
  store: Pick<Storage, 'setItem' | 'getItem'> | null = tabStore(),
  now = Date.now(),
): RejoinInfo | null {
  if (!joined) return loadRejoin(store, now);
  saveRejoin(joined, store, now);
  return { ...joined, at: now };
}

export function clearRejoin(store: Pick<Storage, 'removeItem'> | null = tabStore()): void {
  try {
    store?.removeItem(REJOIN_KEY);
  } catch {
    /* ignore */
  }
}

export function loadRejoin(store: Pick<Storage, 'getItem'> | null = tabStore(), now = Date.now()): RejoinInfo | null {
  try {
    const raw = store?.getItem(REJOIN_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<RejoinInfo>;
    if (typeof r.code !== 'string' || !/^[A-Z0-9]{3,12}$/.test(r.code)) return null;
    if (r.mode !== 'peer' && r.mode !== 'ws') return null;
    if (typeof r.at !== 'number' || now - r.at > REJOIN_MAX_AGE_MS) return null;
    return { code: r.code, mode: r.mode, net: typeof r.net === 'object' && r.net ? r.net : {}, at: r.at };
  } catch {
    return null;
  }
}

/** The server fields of the current settings worth carrying for `mode`. */
export function netFor(mode: NetMode, net: NetServerConfig): InviteNet {
  if (mode === 'ws') return net.wsUrl.trim() ? { wsUrl: net.wsUrl.trim() } : {};
  return customPeerServer(net) ? { peerHost: net.peerHost, peerPort: net.peerPort, peerPath: net.peerPath, peerSecure: net.peerSecure } : {};
}

/**
 * Settings patch for a relay address typed / pasted in the settings: a k=… in it goes to
 * the key store for that server (settings.net.keys), the address is saved without it.
 */
export function relayAddressPatch(
  raw: string,
  net: Pick<NetServerConfig, 'keys'>,
  loc: { protocol: string; host: string } | null = (globalThis as { location?: { protocol: string; host: string } }).location ?? null,
): Partial<NetServerConfig> {
  const { url, key } = splitKey(raw);
  const origin = key ? relayOrigin(resolveWsUrl(url, loc) ?? '') : null;
  return origin && key ? { wsUrl: url, keys: withKey(net.keys, origin, key) } : { wsUrl: url };
}

/** Settings patch applying an invite's server fields (null when nothing changes). */
export function netPatch(current: NetServerConfig, over: InviteNet): Partial<NetServerConfig> | null {
  const patch: Partial<NetServerConfig> = {};
  let changed = false;
  for (const k of ['peerHost', 'peerPort', 'peerPath', 'peerSecure', 'wsUrl'] as const) {
    const v = over[k];
    if (v === undefined || v === current[k]) continue;
    (patch as Record<string, unknown>)[k] = v;
    changed = true;
  }
  return changed ? patch : null;
}

// ── explicit mode choice ─────────────────────────────────────────────────────

const CHOSEN_KEY = 'sgwl.ui.netModeChosen';

/** The player picked a connection mode themselves (online screen / settings): no auto-switching. */
export function modeChosen(): boolean {
  try {
    return globalThis.localStorage?.getItem(CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markModeChosen(): void {
  try {
    globalThis.localStorage?.setItem(CHOSEN_KEY, '1');
    if (officialServer()) globalThis.localStorage?.setItem(CHOICE_KEY, '1');
  } catch {
    /* ignore */
  }
}

// ── official server (src/net/official.ts) ────────────────────────────────────

/**
 * What the online screen offers: 'official' = the relay mode through this build's
 * official server; 'peer' = public P2P; 'ws' = a relay of the player's own (LAN /
 * self-hosted / the desktop app's). Stored as settings.net (mode + wsUrl), which is
 * what the net layer, invite links and rejoin records read.
 */
export type ConnChoice = 'official' | NetMode;

export const modeOfChoice = (c: ConnChoice): NetMode => (c === 'peer' ? 'peer' : 'ws');

/** The choice a mode + relay address amounts to. */
export function choiceOf(mode: NetMode, wsUrl: string, official: OfficialServer | null = officialServer()): ConnChoice {
  if (mode === 'peer') return 'peer';
  return isOfficialRelay(wsUrl, official) ? 'official' : 'ws';
}

/** A relay address of the player's own (not empty, not the official one). */
export function customRelay(wsUrl: string, official: OfficialServer | null = officialServer()): boolean {
  return !!wsUrl.trim() && !isOfficialRelay(wsUrl, official);
}

const CUSTOM_WS_KEY = 'sgwl.ui.customWsUrl';
const CHOICE_KEY = 'sgwl.ui.netChoice.v2';

function localStore(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Settings patch that makes `choice` the connection. Picking the official server keeps
 * the player's own relay address aside (`store`) and 自建服务器 brings it back.
 */
export function choicePatch(
  choice: ConnChoice,
  net: Pick<NetServerConfig, 'wsUrl'>,
  official: OfficialServer | null = officialServer(),
  store: Pick<Storage, 'getItem' | 'setItem'> | null = localStore(),
): Partial<NetServerConfig> {
  if (choice === 'peer') return { mode: 'peer' };
  if (choice === 'official') {
    if (!official) return { mode: 'ws' };
    if (customRelay(net.wsUrl, official)) {
      try {
        store?.setItem(CUSTOM_WS_KEY, net.wsUrl.trim());
      } catch {
        /* ignore */
      }
    }
    return { mode: 'ws', wsUrl: official.relay };
  }
  if (!isOfficialRelay(net.wsUrl, official)) return { mode: 'ws' };
  let own = '';
  try {
    own = store?.getItem(CUSTOM_WS_KEY) ?? '';
  } catch {
    /* ignore */
  }
  return { mode: 'ws', wsUrl: own };
}

/** The player picked a connection on a build with an official server (a pick made before it existed does not count). */
export function choiceChosen(): boolean {
  try {
    return globalThis.localStorage?.getItem(CHOICE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * What the online screen / 邀请朋友一起玩 start on when neither an invite nor a saved room
 * says: the official server when this build has one — unless the player picked a
 * connection since it exists, or set up a relay address of their own — else the saved mode
 * (today's behaviour: public P2P unless they picked the server).
 */
export function defaultChoice(i: { mode: NetMode; wsUrl: string; chosen: boolean }, official: OfficialServer | null = officialServer()): ConnChoice {
  if (!official || i.chosen) return choiceOf(i.mode, i.wsUrl, official);
  if (i.mode === 'ws' && customRelay(i.wsUrl, official)) return 'ws';
  return 'official';
}

/**
 * The relay fields of an invite / rejoin record in relay mode: no `ws=` means the page's
 * own server (same origin) — never whatever relay the settings happen to hold (the
 * official one, from an earlier room).
 */
export function relayNet(mode: NetMode, net: InviteNet): InviteNet {
  return mode === 'ws' && net.wsUrl === undefined ? { ...net, wsUrl: '' } : net;
}
