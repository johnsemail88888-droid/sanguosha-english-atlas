// A redeploy while a tab is open: its lazy chunks 404 → reload once (no loop), torn down
// like F5 first so an online guest keeps its seat (src/ui/staleChunks.ts, src/main.ts).
import { describe, expect, it } from 'vitest';
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, claimChunkReload, installStaleChunkReload, isChunkLoadError, reloadForStaleChunk } from '../../../src/ui/staleChunks';

function memStore(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, String(v)) };
}

const CHROME = new TypeError('Failed to fetch dynamically imported module: https://x.github.io/warlords/assets/world-l9k5lhJ4.js');
const FIREFOX = new TypeError('error loading dynamically imported module: https://x.github.io/warlords/assets/clientView-ZJZ0BzDo.js');
const SAFARI = new TypeError('Importing a module script failed.');
const CSS = new Error('Unable to preload CSS for /assets/index-abc.css');

describe('stale chunk detection', () => {
  it('recognises a failed chunk load in every browser’s words — and nothing else', () => {
    for (const e of [CHROME, FIREFOX, SAFARI, CSS]) expect(isChunkLoadError(e)).toBe(true);
    expect(isChunkLoadError('Failed to fetch dynamically imported module: x')).toBe(true);
    // a module that loaded but threw, a network error of the game, nothing at all
    expect(isChunkLoadError(new ReferenceError('THREE is not defined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: 'Importing a module script failed.' })).toBe(false);
  });

  it('claims a reload once per window (no loop); no storage → no reload', () => {
    const s = memStore();
    const t = 1_700_000_000_000;
    expect(claimChunkReload(s, t)).toBe(true);
    expect(s.data.get(CHUNK_RELOAD_KEY)).toBe(String(t));
    expect(claimChunkReload(s, t + 1000)).toBe(false);
    expect(claimChunkReload(s, t + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(claimChunkReload(s, t + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
    expect(claimChunkReload(null, t)).toBe(false);
    const blocked = { getItem: () => null, setItem: () => undefined };
    expect(claimChunkReload(blocked, t)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    expect(claimChunkReload(throwing, t)).toBe(false);
    // a clock that went backwards does not block forever
    const s2 = memStore();
    s2.data.set(CHUNK_RELOAD_KEY, String(t + 10 * CHUNK_RELOAD_WINDOW_MS));
    expect(claimChunkReload(s2, t)).toBe(true);
  });
});

describe('reloadForStaleChunk / installStaleChunkReload', () => {
  it('tears down first (the guest keeps its seat), then reloads — once', () => {
    const order: string[] = [];
    const store = memStore();
    const opts = { beforeReload: () => void order.push('teardown'), reload: () => void order.push('reload'), store, online: () => true };
    expect(reloadForStaleChunk(CHROME, opts)).toBe(true);
    expect(order).toEqual(['teardown', 'reload']);
    // the reloaded page fails again at once: the normal error path, no second reload
    expect(reloadForStaleChunk(CHROME, opts)).toBe(false);
    expect(order).toEqual(['teardown', 'reload']);
  });

  it('never reloads offline, for other errors, or when the teardown throws (still reloads then)', () => {
    const order: string[] = [];
    const base = { reload: () => void order.push('reload'), store: memStore() };
    expect(reloadForStaleChunk(CHROME, { ...base, beforeReload: () => void order.push('x'), online: () => false })).toBe(false);
    expect(reloadForStaleChunk(new Error('boom'), { ...base, beforeReload: () => void order.push('x'), online: () => true })).toBe(false);
    expect(order).toEqual([]);
    expect(
      reloadForStaleChunk(SAFARI, {
        ...base,
        beforeReload: () => {
          throw new Error('dispose failed');
        },
        online: () => true,
      }),
    ).toBe(true);
    expect(order).toEqual(['reload']);
  });

  it('listens for vite:preloadError (payload) and unhandled import() rejections (reason); the returned function stops it', () => {
    const target = new EventTarget();
    let reloads = 0;
    const off = installStaleChunkReload(target as unknown as Window, { beforeReload: () => undefined, reload: () => void reloads++, store: memStore(), online: () => true });
    const preload = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: FIREFOX });
    target.dispatchEvent(preload);
    expect(reloads).toBe(1);
    // the failed import still rejects (not prevented): without a reload the normal error path applies
    expect(preload.defaultPrevented).toBe(false);
    off();
    target.dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload: FIREFOX }));
    expect(reloads).toBe(1);

    let r2 = 0;
    installStaleChunkReload(target as unknown as Window, { beforeReload: () => undefined, reload: () => void r2++, store: memStore(), online: () => true });
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new TypeError('Something else') }));
    expect(r2).toBe(0);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: CHROME }));
    expect(r2).toBe(1);
  });
});
