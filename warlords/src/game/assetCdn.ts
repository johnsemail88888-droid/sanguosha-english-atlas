// Optional CDN for the large static art (hero / troop / mount / weapon / prop GLBs,
// animation clips, world textures and the sky): a server on a home uplink serves every
// player 13–20 MB of it on the first load. A build made with
//   VITE_ASSET_CDN=https://cdn.example/warlords/ npm run build
// loads those files from <cdn>assets/… instead of the page's own server. The CDN holds a
// copy of public/ (or of the whole dist/) with CORS allowed (fetch() / GLTFLoader):
// deploy/install.sh bakes jsDelivr's commit-pinned copy of warlords/public/ from the repo.
//
// Safe by default: unset → no change at all. Set, the CDN is used only after it answered
// one small probe (<cdn>assets/cdn-probe.txt, a tiny file committed in public/assets, so a
// copy of the repository has it as well as a copy of dist/ — the art listing is generated
// at build time and is not in git; started with the art listing, which every art load
// waits for anyway); a CDN that is down, blocked or not CORS-enabled is never used. A file the CDN then fails to deliver is loaded from the page's own server
// instead, and the CDN is dropped for the rest of the page (one failure is enough: the
// next ones would only add waiting). The art listing itself (assets/art-index.json, what
// this deploy ships) always comes from the page's own server.

/** The CDN base from a VITE_ASSET_CDN value: an http(s) URL ending in '/', or null (unset / invalid). */
export function cdnBaseFrom(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.search = '';
    u.hash = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
  } catch {
    return null;
  }
}

/** Large art files a CDN may serve: relative 'assets/…' GLBs and images (not the listing, not bundles). */
export function isCdnPath(path: string): boolean {
  return /^assets\/[A-Za-z0-9_./-]+\.(glb|webp|png|jpe?g|ktx2)$/i.test(path) && !path.includes('..');
}

/** Where to load `path` from with CDN base `base` (null: the page's own server). */
export function cdnUrl(path: string, base: string | null): string {
  return base && isCdnPath(path) ? `${base}${path}` : path;
}

export type CdnState = 'none' | 'unknown' | 'on' | 'off';

let base: string | null = cdnBaseFrom((import.meta.env ?? {}).VITE_ASSET_CDN);
let state: CdnState = base ? 'unknown' : 'none';
let probe: Promise<boolean> | null = null;

/** The CDN base in use right now: only once the probe answered, and until a load failed. */
export function activeCdn(): string | null {
  return state === 'on' ? base : null;
}

export function cdnState(): CdnState {
  return state;
}

/** Stop using the CDN for this page (a load from it failed). */
export function disableCdn(reason: string): void {
  if (state !== 'on' && state !== 'unknown') return;
  state = 'off';
  console.warn(`[assets] CDN ${base} not used any more (${reason}) — loading art from this server`);
}

/** The probe file (public/assets/cdn-probe.txt) and the text it starts with. */
export const CDN_PROBE_PATH = 'assets/cdn-probe.txt';
export const CDN_PROBE_MARK = 'sgwl-asset-cdn';

type ProbeFetch = (url: string, init: { cache: RequestCache; mode: RequestMode; signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * Ask the CDN once (its copy of the tiny probe file) whether it serves this deploy's art.
 * Resolves true when it will be used. Without a CDN: false at once. Never rejects.
 */
export function prepareCdn(opts: { fetchImpl?: ProbeFetch; timeoutMs?: number } = {}): Promise<boolean> {
  if (!base || state === 'none') return Promise.resolve(false);
  if (probe) return probe;
  const b = base;
  const f = opts.fetchImpl ?? (globalThis as { fetch?: ProbeFetch }).fetch;
  if (!f) {
    state = 'off';
    return (probe = Promise.resolve(false));
  }
  const Ctl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctl = Ctl ? new Ctl() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve(false);
    }, opts.timeoutMs ?? 3000);
  });
  const ask = (async (): Promise<boolean> => {
    const r = await f(`${b}${CDN_PROBE_PATH}`, { cache: 'no-cache', mode: 'cors', signal: ctl?.signal });
    if (!r.ok) return false;
    // (an SPA-style host answers any path with its index.html)
    return (await r.text()).startsWith(CDN_PROBE_MARK);
  })().catch(() => false);
  probe = Promise.race([ask, timeout]).then((ok) => {
    if (timer !== null) clearTimeout(timer);
    if (state === 'unknown') state = ok ? 'on' : 'off';
    if (!ok) console.info(`[assets] CDN ${b} did not answer — loading art from this server`);
    return state === 'on';
  });
  return probe;
}

/**
 * Load `path` through `load` — from the CDN when it is in use, and from the page's own
 * server when that fails (the CDN is dropped for the page then). Other paths (blob: URLs,
 * registered overrides, the listing) go to `load` unchanged.
 */
export async function withCdnFallback<T>(path: string, load: (url: string) => Promise<T>): Promise<T> {
  const url = cdnUrl(path, activeCdn());
  if (url === path) return load(path);
  try {
    return await load(url);
  } catch (err) {
    disableCdn(err instanceof Error ? err.message : String(err));
    return load(path);
  }
}

/** fetch() for an art file with the CDN fallback (an HTTP error from the CDN counts as a failure). */
export function assetFetch(path: string, init?: RequestInit, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Response> {
  return withCdnFallback(path, async (url) => {
    const r = await fetchImpl(url, init);
    if (url !== path && !r.ok) throw new Error(`HTTP ${r.status} from the CDN`);
    return r;
  });
}

/** Tests: pretend the build set VITE_ASSET_CDN to `raw` (null: unset); `on` skips the probe. */
export function setAssetCdnForTests(raw: string | null, on = false): void {
  base = cdnBaseFrom(raw);
  state = base ? (on ? 'on' : 'unknown') : 'none';
  probe = null;
}
