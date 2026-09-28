// Desktop app / self-hosted server awareness for the online screens.
//  - The Electron preload (electron/preload.cjs) exposes window.sgwlDesktop =
//    { isDesktop, lanUrls, getLanUrls(), port }: the game is served by the embedded
//    server. `lanUrls` is the list from when the window opened (a laptop that has
//    changed Wi-Fi since shows a dead address); refreshLanUrls() asks for a fresh one.
//    The window may show the official server's page instead of the bundled one (`page`,
//    electron/page.cjs): its relay is then that server's, and LAN play needs the bundled page.
//  - A browser that opened the game from `npm run server` (e.g. a friend on the
//    LAN at http://192.168.1.5:8787/) is detected through GET /sgwl.json.
// In both cases the WebSocket relay lives on the same origin (/ws), so server
// mode works with no configuration.
import { isOfficialRelay, officialServer } from '../net/official';

export interface DesktopInfo {
  isDesktop: boolean;
  /** http://<LAN-IP>:<port>/ for every non-internal IPv4 of this machine */
  lanUrls: string[];
  port: number;
}

type DesktopBridge = Partial<DesktopInfo> & { getLanUrls?: () => unknown; webgl?: unknown; page?: unknown; useBundled?: () => void };

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

/** 切换到本机版本: the app reloads its window with its own build (LAN play). false when it cannot. */
export function useBundledPage(): boolean {
  const d = bridge();
  if (!d || typeof d.useBundled !== 'function') return false;
  try {
    d.useBundled();
    return true;
  } catch {
    return false;
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

/** Resolves true when this page is served by our server (relay on same-origin /ws). Cached. */
export function detectLocalServer(): Promise<boolean> {
  if (serverProbe) return serverProbe;
  if (desktopInfo()) {
    serverKnown = true;
    return (serverProbe = Promise.resolve(true));
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

/** Synchronous answer once detectLocalServer() settled (desktop: always true). */
export function servedByLocalServer(): boolean {
  if (desktopInfo()) return true;
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
