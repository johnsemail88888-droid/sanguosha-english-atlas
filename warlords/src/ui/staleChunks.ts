// Stale bundles after a redeploy: a tab opened before a new version went live still runs
// the old entry chunk and lazy-loads the old hashed chunks (the match world, the client
// view, the map generator, the relay transport…) by name. A host that removed them answers
// 404 and the dynamic import fails — Vite reports it as `vite:preloadError` (every lazy
// import() of the build goes through its preload helper). The page then reloads ONCE to
// pick up the new build, keeping an online guest's seat (the reload rejoins it, like F5):
// a second failure within CHUNK_RELOAD_WINDOW_MS (the host really lacks the file, a flaky
// network) is left to the normal error path — no reload loop. Offline: no reload either
// (the page would not come back). The Pages deploy keeps old chunks for a week
// (.github/workflows/warlords-pages.yml), so this is the fallback, not the rule.

/** sessionStorage key: when this tab last reloaded for a stale chunk (ms since epoch). */
export const CHUNK_RELOAD_KEY = 'sgwl.chunkReload.v1';
/** No second automatic reload within this long of the last one (ms). */
export const CHUNK_RELOAD_WINDOW_MS = 5 * 60_000;

/** A failed dynamic import / module preload, in any browser's words. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|unable to preload css/i.test(msg);
}

/**
 * May this tab reload for a stale chunk now? Yes at most once per CHUNK_RELOAD_WINDOW_MS —
 * and only with working storage to remember it (otherwise a loop could not be ruled out).
 * A yes is recorded.
 */
export function claimChunkReload(store: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(CHUNK_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
    const stamp = String(now);
    store.setItem(CHUNK_RELOAD_KEY, stamp);
    return store.getItem(CHUNK_RELOAD_KEY) === stamp;
  } catch {
    return false;
  }
}

export interface StaleChunkReloadOptions {
  /** tear the page down first — an online guest leaves keeping its seat token (see main.ts) */
  beforeReload: () => void;
  /** default location.reload() */
  reload?: () => void;
  /** default sessionStorage */
  store?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** default navigator.onLine (unknown counts as online) */
  online?: () => boolean;
}

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>;

function tabStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reload once when a lazy chunk of this build cannot be loaded any more (see above).
 * Returns true when it reloads. Exposed for tests; installStaleChunkReload wires it.
 */
export function reloadForStaleChunk(err: unknown, opts: StaleChunkReloadOptions): boolean {
  if (!isChunkLoadError(err)) return false;
  const online = opts.online ?? (() => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false);
  if (!online()) return false;
  if (!claimChunkReload(opts.store === undefined ? tabStore() : opts.store)) return false;
  console.warn('[app] a part of the game could not be loaded (a new version went live?) — reloading once', err);
  try {
    opts.beforeReload();
  } catch (e) {
    console.error('[app] teardown before the reload failed', e);
  }
  (opts.reload ?? (() => globalThis.location?.reload()))();
  return true;
}

/** Listen for failed lazy chunk loads (vite:preloadError, and unhandled import() rejections). */
export function installStaleChunkReload(win: Target, opts: StaleChunkReloadOptions): () => void {
  const onPreload = (ev: Event): void => {
    // (not preventDefault: the failed import still rejects — the page is going away anyway,
    // and without a reload the normal error path applies)
    reloadForStaleChunk((ev as Event & { payload?: unknown }).payload, opts);
  };
  const onRejection = (ev: Event): void => {
    reloadForStaleChunk((ev as Event & { reason?: unknown }).reason, opts);
  };
  win.addEventListener('vite:preloadError', onPreload);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('vite:preloadError', onPreload);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
