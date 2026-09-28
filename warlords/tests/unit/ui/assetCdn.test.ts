// VITE_ASSET_CDN (src/game/assetCdn.ts): the URL builder, the probe that decides whether the
// CDN is used, and the same-origin fallback when a CDN load fails. Unset: no change at all.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeCdn, assetFetch, cdnBaseFrom, cdnState, cdnUrl, CDN_PROBE_MARK, CDN_PROBE_PATH, disableCdn, isCdnPath, prepareCdn, setAssetCdnForTests, withCdnFallback } from '../../../src/game/assetCdn';
import { ART_INDEX_PATH, assetList, CDN_LISTING_WAIT_MS, setAssetListForTests } from '../../../src/game/assets';

const CDN = 'https://cdn.example.com/warlords/';
const PROBE = { ok: true, text: async () => `${CDN_PROBE_MARK}\n# …\n` };

afterEach(() => {
  setAssetCdnForTests(null);
  vi.restoreAllMocks();
});

describe('URL builder', () => {
  it('normalises the build-time base (http(s) only, trailing slash, no query / hash)', () => {
    expect(cdnBaseFrom('https://cdn.example.com/warlords')).toBe(CDN);
    expect(cdnBaseFrom(' https://cdn.example.com/warlords/?v=1#x ')).toBe(CDN);
    expect(cdnBaseFrom('https://cdn.example.com')).toBe('https://cdn.example.com/');
    expect(cdnBaseFrom('http://192.168.1.5:9000/art/')).toBe('http://192.168.1.5:9000/art/');
    for (const bad of ['', '   ', 'cdn.example.com', 'ftp://cdn.example.com/', 'javascript:alert(1)', undefined, null, 42, true]) expect(cdnBaseFrom(bad)).toBeNull();
  });

  it('only large art files under assets/ go to the CDN — not the listing, bundles, blobs or absolute URLs', () => {
    for (const p of ['assets/models/heroes/liubei.glb', 'assets/anim/run.glb', 'assets/tex/grass.webp', 'assets/env/sky.webp', 'assets/models/props/tent.glb', 'assets/x/y.PNG', 'assets/a.jpg']) {
      expect(isCdnPath(p)).toBe(true);
      expect(cdnUrl(p, CDN)).toBe(`${CDN}${p}`);
    }
    for (const p of ['assets/art-index.json', 'assets/index-AbCd1234.js', 'blob:https://x/123', 'https://other/x.glb', '/assets/a.glb', 'assets/../secret.glb', 'models/a.glb', 'assets/a b.glb']) {
      expect(isCdnPath(p)).toBe(false);
      expect(cdnUrl(p, CDN)).toBe(p);
    }
    // no CDN: every path unchanged
    expect(cdnUrl('assets/models/heroes/liubei.glb', null)).toBe('assets/models/heroes/liubei.glb');
  });
});

describe('the probe decides', () => {
  it('unset (the default): never probes, never used', async () => {
    const f = vi.fn(async () => PROBE);
    expect(cdnState()).toBe('none');
    expect(await prepareCdn({ fetchImpl: f })).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(activeCdn()).toBeNull();
  });

  it('set: used only after its copy of the probe file answered (once, cached)', async () => {
    setAssetCdnForTests(CDN);
    expect(activeCdn()).toBeNull(); // not before the answer
    const f = vi.fn(async (_url: string) => PROBE);
    expect(await prepareCdn({ fetchImpl: f })).toBe(true);
    expect(await prepareCdn({ fetchImpl: f })).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe(`${CDN}assets/cdn-probe.txt`);
    expect(activeCdn()).toBe(CDN);
  });

  it('a CDN that is down, slow, not ours or not CORS-enabled is never used', async () => {
    const cases: [string, Parameters<typeof prepareCdn>[0]][] = [
      ['404', { fetchImpl: async () => ({ ok: false, text: async () => CDN_PROBE_MARK }) }],
      ['html', { fetchImpl: async () => ({ ok: true, text: async () => '<!doctype html><title>SPA</title>' }) }],
      ['other file', { fetchImpl: async () => ({ ok: true, text: async () => 'hello' }) }],
      ['body error', { fetchImpl: async () => ({ ok: true, text: async () => { throw new TypeError('network'); } }) }],
      ['cors / network', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }],
      ['timeout', { fetchImpl: () => new Promise(() => undefined), timeoutMs: 30 }],
    ];
    for (const [name, opts] of cases) {
      setAssetCdnForTests(CDN);
      expect(await prepareCdn(opts), name).toBe(false);
      expect(activeCdn(), name).toBeNull();
      expect(cdnState(), name).toBe('off');
    }
  });
  it('the probe file is committed in public/assets (a copy of the repository has it, not only a copy of dist/)', () => {
    // deploy/install.sh bakes jsDelivr's commit-pinned copy of warlords/public/: the generated
    // art listing (assets/art-index.json) is not in git, this file is
    const text = readFileSync(new URL(`../../../public/${CDN_PROBE_PATH}`, import.meta.url), 'utf8');
    expect(text.startsWith(CDN_PROBE_MARK)).toBe(true);
    expect(isCdnPath(CDN_PROBE_PATH)).toBe(false); // (never itself loaded through the CDN)
  });
});

describe('the art listing does not wait for a CDN that hangs', () => {
  it('a probe that never answers holds the listing CDN_LISTING_WAIT_MS at most (not its 3 s); art meanwhile comes from this server', async () => {
    const g = globalThis as { location?: unknown };
    const hadLocation = 'location' in g;
    const oldLocation = g.location;
    g.location = { protocol: 'https:', host: 'mini.example', origin: 'https://mini.example', pathname: '/' };
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return url === ART_INDEX_PATH
        ? Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ files: ['assets/heroes/liubei.glb'] }) })
        : new Promise(() => undefined); // (the CDN: silently dropped on this network)
    });
    try {
      setAssetCdnForTests(CDN);
      setAssetListForTests(null);
      const t0 = Date.now();
      await assetList(); // (the listing itself: the dev file list under vitest, the fetched one in a build)
      const took = Date.now() - t0;
      expect(asked).toContain(`${CDN}${CDN_PROBE_PATH}`);
      expect(took).toBeGreaterThanOrEqual(CDN_LISTING_WAIT_MS - 50);
      expect(took).toBeLessThan(1500);
      expect(activeCdn()).toBeNull();
      expect(cdnUrl('assets/heroes/liubei.glb', activeCdn())).toBe('assets/heroes/liubei.glb');
    } finally {
      vi.unstubAllGlobals();
      if (hadLocation) g.location = oldLocation;
      else delete g.location;
      setAssetListForTests(null);
    }
  });
});

describe('same-origin fallback', () => {
  it('loads from the CDN when it is in use; a failure loads the same file from this server and drops the CDN', async () => {
    setAssetCdnForTests(CDN, true);
    const urls: string[] = [];
    const ok = await withCdnFallback('assets/models/heroes/liubei.glb', async (u) => (urls.push(u), 'model'));
    expect(ok).toBe('model');
    expect(urls).toEqual([`${CDN}assets/models/heroes/liubei.glb`]);
    urls.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const got = await withCdnFallback('assets/models/heroes/caocao.glb', async (u) => {
      urls.push(u);
      if (u.startsWith(CDN)) throw new Error('404');
      return 'from this server';
    });
    expect(got).toBe('from this server');
    expect(urls).toEqual([`${CDN}assets/models/heroes/caocao.glb`, 'assets/models/heroes/caocao.glb']);
    // the next ones go straight to this server
    expect(activeCdn()).toBeNull();
    urls.length = 0;
    await withCdnFallback('assets/tex/grass.webp', async (u) => (urls.push(u), 1));
    expect(urls).toEqual(['assets/tex/grass.webp']);
  });

  it('this server failing too is the caller’s error, as without a CDN; other paths never touch the CDN', async () => {
    setAssetCdnForTests(CDN, true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(withCdnFallback('assets/a.glb', async () => { throw new Error('gone'); })).rejects.toThrow('gone');
    setAssetCdnForTests(CDN, true);
    const urls: string[] = [];
    await withCdnFallback('blob:https://x/1', async (u) => (urls.push(u), 1));
    expect(urls).toEqual(['blob:https://x/1']);
  });

  it('assetFetch: an HTTP error from the CDN counts as a failure (this server answers instead); without a CDN it is fetch()', async () => {
    setAssetCdnForTests(CDN, true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: string[] = [];
    const fake = (async (u: string) => {
      seen.push(u);
      return new Response('x', { status: u.startsWith(CDN) ? 403 : 200 });
    }) as unknown as typeof fetch;
    const r = await assetFetch('assets/env/sky.webp', undefined, fake);
    expect(r.status).toBe(200);
    expect(seen).toEqual([`${CDN}assets/env/sky.webp`, 'assets/env/sky.webp']);
    setAssetCdnForTests(null);
    seen.length = 0;
    const r404 = await assetFetch('assets/env/sky.webp', undefined, (async (u: string) => (seen.push(u), new Response('', { status: 404 }))) as unknown as typeof fetch);
    expect(r404.status).toBe(404); // the caller sees this server's answer, as before
    expect(seen).toEqual(['assets/env/sky.webp']);
  });

  it('disableCdn is a no-op without a CDN', () => {
    disableCdn('x');
    expect(cdnState()).toBe('none');
  });
});
