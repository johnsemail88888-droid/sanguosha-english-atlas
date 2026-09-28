// The official online server: a small cloud server set up with
// warlords/deploy/install.sh (server/server.mjs behind HTTPS). It serves the same
// build as the public web page (`web`) and the WebSocket relay (`relay`).
//
// When `relay` is set, online play defaults to it — 「官方服务器（推荐）」 on the online
// screen, 邀请朋友一起玩 / 创建房间, the desktop app — and public P2P stays selectable;
// invites from the GitHub Pages site / the desktop app open `web` (github.io is slow or
// blocked in parts of China). Empty = no official server: public P2P by default, as before.
//
// Build-time override (tests, a fork's own server) without a code edit:
//   VITE_OFFICIAL_RELAY=wss://x.example/ws VITE_OFFICIAL_WEB=https://x.example/ npm run build
// (an empty VITE_OFFICIAL_RELAY switches the official server off).
export const OFFICIAL_SERVER = {
  /** e.g. https://47-242-10-3.sslip.io/ — the page friends open; '' = the public GitHub Pages site */
  web: 'https://zhifengmac-mini.tail1ae114.ts.net/',
  /** e.g. wss://47-242-10-3.sslip.io/ws — '' = no official server */
  relay: 'wss://zhifengmac-mini.tail1ae114.ts.net/ws',
};

export interface OfficialServer {
  /** normalised https?://host[:port]/path/ ('' = none) */
  web: string;
  /** normalised wss?://host[:port]/path */
  relay: string;
}

type Env = Record<string, string | boolean | undefined>;

/** ws(s) URL of a relay (http(s) → ws(s), no path → /ws); null when it is not one. */
export function normalizeRelayUrl(raw: string): string | null {
  let url = raw.trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.pathname === '' || u.pathname === '/') u.pathname = '/ws';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** http(s) page URL ending in '/' (a directory: the invite adds ?room=…); '' when it is not one. */
export function normalizeWebUrl(raw: string): string {
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    u.search = '';
    u.hash = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
  } catch {
    return '';
  }
}

/** The official server from the built-in constant and the build-time env (VITE_OFFICIAL_*). */
export function officialFrom(base: { web: string; relay: string }, env: Env = {}): OfficialServer | null {
  const pick = (key: string, fallback: string): string => {
    const v = env[key];
    return typeof v === 'string' ? v : fallback;
  };
  const relay = normalizeRelayUrl(pick('VITE_OFFICIAL_RELAY', base.relay));
  if (!relay) return null;
  return { relay, web: normalizeWebUrl(pick('VITE_OFFICIAL_WEB', base.web)) };
}

function buildEnv(): Env {
  // written out as `import.meta.env` so Vite substitutes it at build time
  return (import.meta.env ?? {}) as unknown as Env;
}

let override: OfficialServer | null | undefined;
let resolved: OfficialServer | null | undefined;

/** This build's official server (null: none configured). */
export function officialServer(): OfficialServer | null {
  if (override !== undefined) return override;
  if (resolved === undefined) resolved = officialFrom(OFFICIAL_SERVER, buildEnv());
  return resolved;
}

/** Tests: pretend this build has (or has no) official server; undefined = back to the real one. */
export function setOfficialServerForTests(o: { web?: string; relay: string } | null | undefined): void {
  override = o === undefined ? undefined : o === null ? null : officialFrom({ web: o.web ?? '', relay: o.relay });
}

/** `url` is the official relay (same address once normalised). */
export function isOfficialRelay(url: string | undefined, official: OfficialServer | null = officialServer()): boolean {
  if (!official || !url) return false;
  const n = normalizeRelayUrl(url);
  return !!n && n.replace(/\/+$/, '') === official.relay.replace(/\/+$/, '');
}

/** The page at `origin` is the official server's own web page. */
export function isOfficialWeb(origin: string | undefined, official: OfficialServer | null = officialServer()): boolean {
  if (!official?.web || !origin) return false;
  try {
    return new URL(official.web).origin === origin;
  } catch {
    return false;
  }
}
