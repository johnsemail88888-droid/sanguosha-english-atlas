// Desktop app / self-hosted server awareness for the online screens.
//  - The Electron preload (electron/preload.cjs) exposes window.sgwlDesktop =
//    { isDesktop, lanUrls, getLanUrls(), port }: the game is served by the embedded
//    server. `lanUrls` is the list from when the window opened (a laptop that has
//    changed Wi-Fi since shows a dead address); refreshLanUrls() asks for a fresh one.
//  - A browser that opened the game from `npm run server` (e.g. a friend on the
//    LAN at http://192.168.1.5:8787/) is detected through GET /sgwl.json.
// In both cases the WebSocket relay lives on the same origin (/ws), so server
// mode works with no configuration.

export interface DesktopInfo {
  isDesktop: boolean;
  /** http://<LAN-IP>:<port>/ for every non-internal IPv4 of this machine */
  lanUrls: string[];
  port: number;
}

type DesktopBridge = Partial<DesktopInfo> & { getLanUrls?: () => unknown };

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

/**
 * Base URL (origin + path) other players should open: on the desktop app the
 * page itself is http://127.0.0.1:<port>/, so use the first LAN address.
 */
export function shareBase(loc: { origin: string; pathname: string } = location): string {
  const d = desktopInfo();
  if (d && d.lanUrls.length) return d.lanUrls[0].replace(/\/?$/, '/');
  const origin = loc.origin && loc.origin !== 'null' ? loc.origin : '';
  return `${origin}${loc.pathname}`;
}
