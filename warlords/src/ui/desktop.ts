// Desktop app / self-hosted server awareness for the online screens.
//  - The Electron preload (electron/preload.cjs) exposes window.sgwlDesktop =
//    { isDesktop, lanUrls, port }: the game is served by the embedded server.
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

export function desktopInfo(): DesktopInfo | null {
  const d = (globalThis as { sgwlDesktop?: Partial<DesktopInfo> }).sgwlDesktop;
  if (!d || !d.isDesktop) return null;
  return {
    isDesktop: true,
    lanUrls: Array.isArray(d.lanUrls) ? d.lanUrls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : [],
    port: typeof d.port === 'number' ? d.port : 8787,
  };
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
