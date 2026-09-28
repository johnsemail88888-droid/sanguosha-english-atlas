// Desktop app / self-hosted server awareness for the online screens.
//  - The Electron preload (electron/preload.cjs) exposes window.sgwlDesktop =
//    { isDesktop, lanUrls, getLanUrls(), port }: the game is served by the embedded
//    server. `lanUrls` is the list from when the window opened (a laptop that has
//    changed Wi-Fi since shows a dead address); refreshLanUrls() asks for a fresh one.
//    The window may show the official server's page instead of the bundled one (`page`,
//    electron/page.cjs): its own server is then the official one (not "this machine's"), it
//    gets no LAN addresses, and LAN play (自建服务器 without an address) goes to the bundled page.
//  - A browser that opened the game from `npm run server` (e.g. a friend on the
//    LAN at http://192.168.1.5:8787/) is detected through GET /sgwl.json.
// In both cases the WebSocket relay lives on the same origin (/ws), so server
// mode works with no configuration.
import { COMPAT_ID } from '../net/compat';
import { isOfficialRelay, officialServer } from '../net/official';

export interface DesktopInfo {
  isDesktop: boolean;
  /** http://<LAN-IP>:<port>/ for every non-internal IPv4 of this machine */
  lanUrls: string[];
  port: number;
}

/** What the desktop page carries to the bundled page (sgwlDesktop.useBundled): the room, or 创建房间. */
export interface BundledRequest {
  room?: string | null;
  create?: boolean;
}

type DesktopBridge = Partial<DesktopInfo> & {
  getLanUrls?: () => unknown;
  webgl?: unknown;
  page?: unknown;
  bundledCompat?: unknown;
  reportBuild?: (compat: string) => void;
  useBundled?: (req?: { room: string | null; create: boolean }) => void;
};

function bridge(): DesktopBridge | null {
  const d = (globalThis as { sgwlDesktop?: DesktopBridge }).sgwlDesktop;
  return d && d.isDesktop ? d : null;
}

/** Only http(s) URL strings survive (the list crosses the preload bridge). */
export function cleanUrls(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : null;
}

/** the last list refreshLanUrls() got from the app (null: never asked, or the app could not answer) */
let freshLan: string[] | null = null;

export function desktopInfo(): DesktopInfo | null {
  const d = bridge();
  if (!d) return null;
  return {
    isDesktop: true,
    lanUrls: freshLan ?? cleanUrls(d.lanUrls) ?? [],
    port: typeof d.port === 'number' ? d.port : 8787,
  };
}

/**
 * Ask the desktop app for this machine's LAN addresses now (a synchronous IPC round
 * trip — call it when a screen that shows them opens, or on a network change).
 * Returns the list desktopInfo() reports from then on; the startup list when the
 * app has no getLanUrls() (older preload) or it fails.
 */
export function refreshLanUrls(): string[] {
  const d = bridge();
  if (!d) return [];
  if (typeof d.getLanUrls === 'function') {
    try {
      const fresh = cleanUrls(d.getLanUrls());
      if (fresh) freshLan = fresh;
    } catch {
      /* keep the last known list */
    }
  }
  return desktopInfo()?.lanUrls ?? [];
}

/**
 * Desktop app: WebGL does not run on the graphics card (Chromium's GPU feature
 * status for WebGL is not 'enabled…' — a blocklisted / crashed driver) even with the
 * GPU switches the app sets. false in a browser, or when the app did not say.
 */
export function desktopGpuSoftware(): boolean {
  const w = bridge()?.webgl;
  return typeof w === 'string' && w !== '' && !/^enabled/.test(w);
}

/**
 * Desktop app: which page the window shows — 'bundled' (the app's own build, served by its LAN
 * server) or 'official' (the official server's build: the app picked it because the server runs
 * another build than the bundled one, electron/page.cjs). null in a browser or an older app.
 */
export function desktopPage(): 'bundled' | 'official' | null {
  const p = bridge()?.page;
  return p === 'bundled' || p === 'official' ? p : null;
}

/**
 * 切换到本机版本: the app reloads its window with its own build (LAN play) — with `req`, that room
 * joined / a room created there, on the app's own LAN server. false when it cannot.
 */
export function useBundledPage(req?: BundledRequest): boolean {
  const d = bridge();
  if (!d || typeof d.useBundled !== 'function') return false;
  try {
    const room = typeof req?.room === 'string' && req.room ? req.room : null;
    const create = !room && req?.create === true;
    if (room || create) d.useBundled({ room, create });
    else d.useBundled();
    return true;
  } catch {
    return false;
  }
}

/**
 * The official server's page in the desktop app, 自建服务器 without an address of its own: that
 * is the app's LAN server — the bundled page's, where the attempt goes (useBundledPage carries the
 * room / 创建房间 there). This page's own server is the official one: never silently that.
 */
export function lanViaBundledPage(choice: string, ownWsUrl: string): boolean {
  return desktopPage() === 'official' && choice === 'ws' && !ownWsUrl.trim();
}

/**
 * Desktop app: the build the app bundles (its LAN friends get that one) — null in a browser, an
 * older app, or when the app does not know it.
 */
export function desktopBundledCompat(): string | null {
  const c = bridge()?.bundledCompat;
  return typeof c === 'string' && /^[0-9a-f]{8,64}$/.test(c) ? c : null;
}

/**
 * Desktop app, the official server's page: LAN friends (who get the bundled build) could not play
 * with this page — its build differs from the app's, or the app cannot say.
 */
export function officialPageDiffers(compat: string | null = COMPAT_ID): boolean {
  if (desktopPage() !== 'official') return false;
  const bundled = desktopBundledCompat();
  return !bundled || bundled !== compat;
}

/** Page start: tell the desktop app which build this page is (its LAN dialog compares it with the bundled one). */
export function reportPageBuild(compat: string | null = COMPAT_ID): void {
  const d = bridge();
  if (!d || typeof d.reportBuild !== 'function' || !compat) return;
  try {
    d.reportBuild(compat);
  } catch {
    /* an older app: its dialog says what it knew at load */
  }
}

/** Tests: forget the refreshed list. */
export function resetLanUrlsForTests(): void {
  freshLan = null;
}

function httpPage(): boolean {
  const p = globalThis.location?.protocol;
  return p === 'http:' || p === 'https:';
}

let serverProbe: Promise<boolean> | null = null;
let serverKnown: boolean | null = null;

/**
 * Resolves true when this page is served by our server (relay on same-origin /ws). Cached. The
 * desktop app's window: its bundled page yes (the app's LAN server); the official server's page no
 * — 自建服务器 there means the app's LAN server, which is the bundled page's (online screen).
 */
export function detectLocalServer(): Promise<boolean> {
  if (serverProbe) return serverProbe;
  if (desktopInfo()) {
    serverKnown = desktopPage() !== 'official';
    return (serverProbe = Promise.resolve(serverKnown));
  }
  if (!httpPage() || typeof fetch !== 'function') {
    serverKnown = false;
    return (serverProbe = Promise.resolve(false));
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), 2500);
  serverProbe = fetch('./sgwl.json', { cache: 'no-store', signal: ctrl?.signal })
    .then(async (r) => {
      if (!r.ok) return false;
      const j = (await r.json()) as { app?: unknown; relay?: unknown };
      return j?.app === 'sanguo-warlords' && typeof j.relay === 'string';
    })
    .catch(() => false)
    .then((ok) => {
      clearTimeout(timer);
      serverKnown = ok;
      return ok;
    });
  return serverProbe;
}

/**
 * Synchronous answer once detectLocalServer() settled (desktop: the bundled page always, the
 * official server's page never — its own origin is the official server, not this machine's).
 */
export function servedByLocalServer(): boolean {
  if (desktopInfo()) return desktopPage() !== 'official';
  return serverKnown === true;
}

/** The published web version: anyone on the internet can open it. */
export const PUBLIC_WEB_URL = 'https://johnsemail88888-droid.github.io/sanguosha-english-atlas/warlords/';

/** `origin` is the public web version's (GitHub Pages). */
export function isPublicWebOrigin(origin: string | undefined): boolean {
  return !!origin && origin === new URL(PUBLIC_WEB_URL).origin;
}

/**
 * Base URL (origin + path) other players should open. On the desktop app the
 * page itself is http://127.0.0.1:<port>/: a P2P room is reachable from the
 * public web version, so friends anywhere get that; a room on the app's own
 * relay server (mode 'ws') only from the LAN, so they get the first LAN address.
 * A room on the official relay (`relay`), or a P2P room, sent from the desktop app,
 * the GitHub Pages site or the offline file: the official server's own page when it
 * has one (the same build; github.io is slow or blocked in parts of China).
 */
export function shareBase(loc: { origin: string; pathname: string } = location, mode?: 'peer' | 'ws', relay?: string): string {
  const d = desktopInfo();
  const origin = loc.origin && loc.origin !== 'null' ? loc.origin : '';
  const off = officialServer();
  const onOfficial = mode === 'ws' && isOfficialRelay(relay, off);
  if (off?.web && (mode !== 'ws' || onOfficial) && (d || !origin || isPublicWebOrigin(origin))) return off.web;
  if (d && (mode !== 'ws' || onOfficial)) return PUBLIC_WEB_URL;
  if (d && d.lanUrls.length) return d.lanUrls[0].replace(/\/?$/, '/');
  return `${origin}${loc.pathname}`;
}
