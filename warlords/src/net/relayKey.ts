// Access keys of relay servers (RELAY_KEY on the server: server/server.mjs, deploy/home-host.sh).
//
// A server started with RELAY_KEY refuses a WebSocket upgrade on /ws without `k=<key>`
// (HTTP 401 before upgrading — to the page that is a plain WebSocket error) and
// POST /api/rooms without it (401 {error:'key-required' | 'bad-key'}); its static files
// and /sgwl.json stay public, and /sgwl.json says `keyRequired: true` (never the key).
// Without RELAY_KEY (LAN, the desktop app, tests) nothing changes.
//
// The key reaches a player in the SHARE LINK the server's owner sends (https://<host>/?k=…)
// or in an invite link made on a keyed server (…?room=ABCDE&mode=ws&ws=…&k=…). The page
// keeps it per server origin (settings.net.keys: {'wss://host[:port]': key}), takes it out
// of the address bar, and adds it as k=… to the relay URL at connect time and to
// /api/rooms — never to the saved relay address (settings.net.wsUrl) itself.

/** The query parameter carrying a key (page URL, invite link, relay URL, /api/rooms). */
export const KEY_PARAM = 'k';
/** Longest key accepted (the server generates 24+ characters). */
export const MAX_KEY_LENGTH = 256;
/** Servers remembered at most (the newest win). */
export const MAX_KEYS = 16;

/** Stored keys: relay origin ('wss://host[:port]') → key. */
export type RelayKeys = Record<string, string>;

/**
 * A usable key, or null: 8–256 characters of base64 / base64url / hex. A '+' of a standard
 * base64 key that reached us as a space (an unencoded '+' in a query string) is put back.
 */
export function cleanKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().replace(/ /g, '+');
  return k.length >= 8 && k.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9+/=_.~-]+$/.test(k) ? k : null;
}

/**
 * Resolve the relay URL: explicit setting (accepts "host:port", "http(s)://…",
 * "ws(s)://…"; adds "/ws" when no path), else same-origin "/ws" when the page is
 * served over http(s) (i.e. by our server). null when nothing applies. Query
 * parameters of the setting are kept.
 */
export function resolveWsUrl(configured: string, loc: { protocol: string; host: string } | null = pageLocation()): string | null {
  const raw = configured.trim();
  if (raw) {
    let url = raw;
    if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
    else if (!/^wss?:\/\//i.test(url)) url = `${loc?.protocol === 'https:' ? 'wss' : 'ws'}://${url}`;
    try {
      const u = new URL(url);
      if (u.pathname === '' || u.pathname === '/') u.pathname = '/ws';
      return u.toString();
    } catch {
      return null;
    }
  }
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.host) {
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  }
  return null;
}

function pageLocation(): { protocol: string; host: string } | null {
  const l = (globalThis as { location?: { protocol: string; host: string } }).location;
  return l ? { protocol: l.protocol, host: l.host } : null;
}

/**
 * The key-store origin of a relay or page URL: 'wss://host[:port]' (http(s) counts as
 * ws(s): the page https://h/ and its relay wss://h/ws share a key). null when it is neither.
 */
export function relayOrigin(url: string): string | null {
  let s = url.trim();
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/** Only well-formed entries of a stored key map survive (settings saved by any version). */
export function cleanKeys(v: unknown): RelayKeys {
  const out: RelayKeys = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const entries = Object.entries(v as Record<string, unknown>).slice(-MAX_KEYS);
  for (const [origin, key] of entries) {
    const o = relayOrigin(origin);
    const k = cleanKey(key);
    if (o && o === origin && k) out[o] = k;
  }
  return out;
}

/** The stored key for the relay at `relayUrl` (any URL on its origin), or null. */
export function keyFor(keys: RelayKeys | undefined, relayUrl: string | null | undefined): string | null {
  if (!keys || !relayUrl) return null;
  const o = relayOrigin(relayUrl);
  return o && Object.prototype.hasOwnProperty.call(keys, o) ? cleanKey(keys[o]) : null;
}

/** `keys` with `key` stored for `origin` (null: forgotten); the newest MAX_KEYS servers are kept. */
export function withKey(keys: RelayKeys | undefined, origin: string, key: string | null): RelayKeys {
  const out: RelayKeys = {};
  for (const [o, k] of Object.entries(keys ?? {})) if (o !== origin) out[o] = k;
  if (key) out[origin] = key;
  const all = Object.entries(out);
  return all.length > MAX_KEYS ? Object.fromEntries(all.slice(-MAX_KEYS)) : out;
}

/**
 * `url` with k=<key> (replacing a k it had; every other query parameter kept). No key:
 * `url` unchanged (a k typed into the address itself still reaches the server).
 */
export function withKeyParam(url: string, key: string | null | undefined): string {
  if (!key) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(KEY_PARAM, key);
    return u.toString();
  } catch {
    return url;
  }
}

/** The URL to open for relay `url`: the stored key of its server appended (see withKeyParam). */
export function keyedRelayUrl(url: string, keys: RelayKeys | undefined): string {
  return withKeyParam(url, keyFor(keys, url));
}

/**
 * A relay address as typed or pasted (settings, an invite's ws=): the address without a
 * k=… it may carry, and that key. Anything that is not a URL comes back as it was.
 */
export function splitKey(raw: string): { url: string; key: string | null } {
  const s = raw.trim();
  if (!/[?&]k=/.test(s)) return { url: s, key: null };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `ws://${s}`);
  } catch {
    return { url: s, key: null };
  }
  const key = cleanKey(u.searchParams.get(KEY_PARAM));
  u.searchParams.delete(KEY_PARAM);
  let url = u.toString();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) url = url.replace(/^ws:\/\//, '');
  return { url, key };
}

/**
 * The server's own http(s) base next to a relay URL: wss://h/ws → https://h/,
 * ws://h:8787/ws → http://h:8787/, a relay under a path keeps it (wss://h/x/ws → https://h/x/).
 * null for anything that is not a ws(s) URL.
 */
export function serverHttpBase(wsUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(wsUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  const base = u.pathname.replace(/\/ws\/?$/, '/').replace(/\/?$/, '/');
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}${base}`;
}

type InfoFetch = (url: string, init: { cache: RequestCache; signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

/**
 * Does the server behind relay `wsUrl` require a key? Its /sgwl.json says (public, CORS *).
 * null: it could not tell (unreachable, an older server, not ours).
 */
export async function relayKeyRequired(wsUrl: string, opts: { fetchImpl?: InfoFetch; timeoutMs?: number } = {}): Promise<boolean | null> {
  const base = serverHttpBase(wsUrl);
  const f = opts.fetchImpl ?? (globalThis as { fetch?: InfoFetch }).fetch;
  if (!base || !f) return null;
  const Ctl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctl = Ctl ? new Ctl() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve(null);
    }, opts.timeoutMs ?? 3000);
  });
  const ask = (async (): Promise<boolean | null> => {
    const r = await f(`${base}sgwl.json`, { cache: 'no-store', signal: ctl?.signal });
    if (!r.ok) return null;
    const j = (await r.json()) as { app?: unknown; keyRequired?: unknown } | null;
    if (!j || j.app !== 'sanguo-warlords') return null;
    return j.keyRequired === true;
  })().catch(() => null);
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ── keys a relay accepted (this page) ─────────────────────────────────────────

const accepted = new Set<string>();

/** A WebSocket opened with this URL: its key (if any) is right — a later failure is not about the key. */
export function noteRelayAccepted(url: string): void {
  const o = relayOrigin(url);
  if (!o) return;
  let k: string | null = null;
  try {
    k = new URL(url).searchParams.get(KEY_PARAM);
  } catch {
    /* keep null */
  }
  accepted.add(`${o} ${k ?? ''}`);
}

/** The relay accepted this very URL's key before (this page load). */
export function relayAcceptedBefore(url: string): boolean {
  const o = relayOrigin(url);
  if (!o) return false;
  let k: string | null = null;
  try {
    k = new URL(url).searchParams.get(KEY_PARAM);
  } catch {
    /* keep null */
  }
  return accepted.has(`${o} ${k ?? ''}`);
}

/** Tests: forget what the relays accepted. */
export function resetRelayAcceptedForTests(): void {
  accepted.clear();
}

/**
 * Why a relay connection failed, once more precisely: a server that requires a key and
 * refused the upgrade (no key, a wrong or an outdated one) looks to the page like any
 * unreachable server — /sgwl.json tells. 'keyRequired' | null (nothing more to say).
 * A key this relay accepted earlier in this page is not the cause (a network blip).
 */
export async function diagnoseRelayFailure(url: string, opts: { fetchImpl?: InfoFetch; timeoutMs?: number } = {}): Promise<'keyRequired' | null> {
  if (relayAcceptedBefore(url)) return null;
  if ((await relayKeyRequired(url, opts)) !== true) return null;
  let key: string | null = null;
  try {
    key = new URL(url).searchParams.get(KEY_PARAM);
  } catch {
    /* keep null */
  }
  // a key the server says is right: the relay refused for another reason (too many sockets
  // from one address, a full server…) — "ask for the invite link" would send the player astray
  return key && (await relayKeyAccepted(url, key, opts)) === true ? null : 'keyRequired';
}

/**
 * Is `key` the key of the server behind relay `wsUrl`? A keyed server checks the key of
 * /api/rooms before the method, so a GET creates nothing: 401 = refused, any other answer
 * (405 method-not-allowed) = right. null: no answer (unreachable, timeout).
 */
export async function relayKeyAccepted(wsUrl: string, key: string, opts: { fetchImpl?: InfoFetch; timeoutMs?: number } = {}): Promise<boolean | null> {
  const base = serverHttpBase(wsUrl);
  const f = opts.fetchImpl ?? (globalThis as { fetch?: InfoFetch }).fetch;
  if (!base || !f) return null;
  const Ctl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctl = Ctl ? new Ctl() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve(null);
    }, opts.timeoutMs ?? 3000);
  });
  const ask = (async (): Promise<boolean | null> => {
    const r = await f(`${base}api/rooms?${KEY_PARAM}=${encodeURIComponent(key)}`, { cache: 'no-store', signal: ctl?.signal });
    return typeof r.status === 'number' && r.status > 0 ? r.status !== 401 : null;
  })().catch(() => null);
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** The key in a relay URL (k=…), for messages: whether there was one. */
export function hasKeyParam(url: string): boolean {
  try {
    return !!new URL(url).searchParams.get(KEY_PARAM);
  } catch {
    return false;
  }
}
