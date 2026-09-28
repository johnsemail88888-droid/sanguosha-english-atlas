// Static files from server/server.mjs (a home uplink serves every player's first load):
// precompressed .br / .gz (scripts/precompress.mjs) by Accept-Encoding, text compressed on the
// fly when there is none, weak ETags + 304, Cache-Control per kind of file; and the two build
// helpers — scripts/precompress.mjs and scripts/keep-old-assets.mjs (the previous build's
// bundles stay for pages still open).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without type declarations
import { acceptedEncodings, cacheControlFor, ENCODED_EXTENSIONS, matchesEtag, startServer } from '../../../server/server.mjs';
// @ts-expect-error plain .mjs without type declarations
import { BROTLI_QUALITY, precompressDir } from '../../../scripts/precompress.mjs';
// @ts-expect-error plain .mjs without type declarations
import { keepOldAssets, RETIRED_FILE } from '../../../scripts/keep-old-assets.mjs';

let dist: string;
let srv: { port: number; close(): Promise<void> };
const BUNDLE = `console.log(${JSON.stringify('三国杀 '.repeat(4000))});\n`;
const APP = `export const x = ${JSON.stringify('枪火乱世 '.repeat(3000))};\n`;

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-static-'));
  fs.mkdirSync(path.join(dist, 'assets', 'models'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><title>t</title>${'<p>page</p>'.repeat(300)}`);
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbCdEf12.js'), BUNDLE);
  fs.writeFileSync(path.join(dist, 'assets', 'app-Zz9_Yy8-.js'), APP);
  fs.writeFileSync(path.join(dist, 'assets', 'art-index.json'), JSON.stringify({ files: Array.from({ length: 200 }, (_, i) => `assets/models/m${i}.glb`) }));
  fs.writeFileSync(path.join(dist, 'assets', 'models', 'hero.glb'), Buffer.alloc(8192, 7));
  fs.writeFileSync(path.join(dist, 'assets', 'models', 'ground-cobblestone.webp'), crypto.getRandomValues(new Uint8Array(4096)));
  await precompressDir(dist);
  // (app-*.js keeps no variants: it is compressed on the fly)
  fs.rmSync(path.join(dist, 'assets', 'app-Zz9_Yy8-.js.br'));
  fs.rmSync(path.join(dist, 'assets', 'app-Zz9_Yy8-.js.gz'));
  srv = (await startServer({ port: 0, host: '127.0.0.1', distDir: dist, quiet: true, peer: false, headless: false })) as typeof srv;
});

afterAll(async () => {
  await srv?.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

function get(p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const decode = (body: Buffer, enc: string | undefined): string =>
  (enc === 'br' ? zlib.brotliDecompressSync(body) : enc === 'gzip' ? zlib.gunzipSync(body) : body).toString('utf8');

describe('static files: encodings', () => {
  it('sends the precompressed .br to a browser that takes brotli, .gz to gzip-only, the file itself otherwise', async () => {
    const br = await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'gzip, deflate, br, zstd' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(br.body.length).toBeLessThan(Buffer.byteLength(BUNDLE) / 5);
    expect(decode(br.body, 'br')).toBe(BUNDLE);
    expect(br.headers['content-type']).toContain('text/javascript');

    const gz = await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(decode(gz.body, 'gzip')).toBe(BUNDLE);

    const plain = await get('/assets/index-AbCdEf12.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString('utf8')).toBe(BUNDLE);
    // q=0 refuses brotli
    expect((await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'br;q=0, gzip' })).headers['content-encoding']).toBe('gzip');
  });

  it('compresses text on the fly when no variant exists (cached); leaves images alone', async () => {
    const a = await get('/assets/app-Zz9_Yy8-.js', { 'Accept-Encoding': 'br, gzip' });
    expect(a.headers['content-encoding']).toBe('br');
    expect(decode(a.body, 'br')).toBe(APP);
    const b = await get('/assets/app-Zz9_Yy8-.js', { 'Accept-Encoding': 'gzip' });
    expect(decode(b.body, 'gzip')).toBe(APP);
    const img = await get('/assets/models/ground-cobblestone.webp', { 'Accept-Encoding': 'br, gzip' });
    expect(img.headers['content-encoding']).toBeUndefined();
    expect(img.body.length).toBe(4096);
    // the SPA fallback page too
    const page = await get('/lobby/ABCDE', { 'Accept-Encoding': 'br' });
    expect(page.status).toBe(200);
    expect(decode(page.body, page.headers['content-encoding'])).toContain('<p>page</p>');
  });

  it('a variant older than its file (a copy that was not recompressed) is not used', async () => {
    const f = path.join(dist, 'assets', 'models', 'hero.glb');
    const buf = Buffer.alloc(8192, 9);
    fs.writeFileSync(f, buf);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(f, later, later);
    const r = await get('/assets/models/hero.glb', { 'Accept-Encoding': 'br' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.body.equals(buf)).toBe(true);
    expect(r.headers['content-type']).toBe('model/gltf-binary');
  });

  it('HEAD: headers only', async () => {
    const r = await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'br' }, 'HEAD');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.body.length).toBe(0);
  });
});

describe('static files: caching', () => {
  it('Cache-Control: hashed bundles a year (immutable), pages revalidate, the rest a day + stale-while-revalidate', async () => {
    expect((await get('/assets/index-AbCdEf12.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/')).headers['cache-control']).toBe('no-cache');
    expect((await get('/lobby/ABCDE')).headers['cache-control']).toBe('no-cache');
    const art = (await get('/assets/models/hero.glb')).headers['cache-control'];
    expect(art).toBe('public, max-age=86400, stale-while-revalidate=604800');
    expect((await get('/assets/art-index.json')).headers['cache-control']).toBe(art);
    // a public file whose name merely looks hashed is not a bundle
    expect(cacheControlFor('assets/models/ground-cobblestone.webp')).toBe(art);
    expect(cacheControlFor('assets/tex/sky-panorama.webp')).toBe(art);
    expect(cacheControlFor('assets/meshopt_decoder.module-DXTYc6wn.js')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('favicon.png')).toBe(art);
  });

  it('weak ETag + 304 for If-None-Match (per encoding)', async () => {
    const first = await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'br' });
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+-br"$/);
    const again = await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'br', 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers.etag).toBe(etag);
    // the gzip representation has its own tag
    const gz = await get('/assets/index-AbCdEf12.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    expect(gz.status).toBe(200);
    const page = await get('/');
    expect((await get('/', { 'If-None-Match': String(page.headers.etag) })).status).toBe(304);
    expect(page.headers['last-modified']).toBeTruthy();
  });

  it('the ETag follows the content, not the file time: a new build that leaves a file as it was keeps its tag (a 304, not the art again)', async () => {
    const file = path.join(dist, 'assets', 'models', 'same.glb');
    fs.writeFileSync(file, Buffer.alloc(3000, 3));
    const first = await get('/assets/models/same.glb');
    const tag = String(first.headers.etag);
    // the update copies it again: a new time, the same bytes
    const later = new Date(Date.now() + 3_600_000);
    fs.writeFileSync(file, Buffer.alloc(3000, 3));
    fs.utimesSync(file, later, later);
    const again = await get('/assets/models/same.glb', { 'If-None-Match': tag });
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe(tag);
    // other bytes (same size): another tag
    fs.writeFileSync(file, Buffer.alloc(3000, 4));
    fs.utimesSync(file, new Date(later.getTime() + 1000), new Date(later.getTime() + 1000));
    const changed = await get('/assets/models/same.glb', { 'If-None-Match': tag });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
  });

  it('Vary: Accept-Encoding on every answer that may be encoded — a model sent plain too; not on images', async () => {
    const plain = await get('/assets/models/hero.glb');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers.vary).toBe('Accept-Encoding');
    expect((await get('/assets/models/hero.glb', { 'Accept-Encoding': 'br' })).headers.vary).toBe('Accept-Encoding');
    expect((await get('/assets/models/ground-cobblestone.webp')).headers.vary).toBeUndefined();
    // (whatever scripts/precompress.mjs writes variants for)
    for (const ext of Object.keys(BROTLI_QUALITY)) expect(ENCODED_EXTENSIONS.has(ext), ext).toBe(true);
  });

  it('parses Accept-Encoding and If-None-Match', () => {
    expect(acceptedEncodings('gzip, deflate, br')).toEqual(['br', 'gzip']);
    expect(acceptedEncodings('gzip;q=1.0, br;q=0.5')).toEqual(['gzip', 'br']);
    expect(acceptedEncodings('identity')).toEqual([]);
    expect(acceptedEncodings(undefined)).toEqual([]);
    expect(acceptedEncodings('*')).toEqual(['br', 'gzip']);
    expect(acceptedEncodings('*;q=0.1, br;q=0')).toEqual(['gzip']);
    expect(matchesEtag('W/"a-b-br", W/"c"', 'W/"c"')).toBe(true);
    expect(matchesEtag('"c"', 'W/"c"')).toBe(true);
    expect(matchesEtag('*', 'W/"c"')).toBe(true);
    expect(matchesEtag('W/"d"', 'W/"c"')).toBe(false);
    expect(matchesEtag(undefined, 'W/"c"')).toBe(false);
  });
});

describe('scripts/precompress.mjs', () => {
  it('writes .br / .gz for text and models, skips images and tiny files, and reuses fresh variants', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-pre-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.js'), BUNDLE);
      fs.writeFileSync(path.join(dir, 'tiny.js'), 'x');
      fs.writeFileSync(path.join(dir, 'p.webp'), Buffer.alloc(5000, 1));
      fs.writeFileSync(path.join(dir, 'noise.glb'), crypto.getRandomValues(new Uint8Array(20_000)));
      const t1 = await precompressDir(dir);
      expect(t1).toMatchObject({ files: 4, compressed: 2, reused: 0, skipped: 2 });
      expect(fs.existsSync(path.join(dir, 'a.js.br'))).toBe(true);
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'a.js.gz'))).toString()).toBe(BUNDLE);
      expect(fs.existsSync(path.join(dir, 'tiny.js.br'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'p.webp.br'))).toBe(false);
      // random bytes do not compress: the variant is left empty (the server ignores those)
      expect(fs.statSync(path.join(dir, 'noise.glb.br')).size).toBe(0);
      const t2 = await precompressDir(dir);
      expect(t2).toMatchObject({ compressed: 0, reused: 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scripts/keep-old-assets.mjs', () => {
  it('carries the previous build’s bundles the new one lacks, for `days` after they were retired', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-keep-'));
    try {
      const mk = (dir: string, files: Record<string, string>) => {
        fs.mkdirSync(path.join(root, dir, 'assets', 'models'), { recursive: true });
        for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(root, dir, 'assets', n), c);
      };
      const day = 86_400_000;
      const t0 = Date.UTC(2026, 8, 1);
      mk('v1', { 'index-AAAAAAAA.js': 'v1', 'index-AAAAAAAA.js.br': 'br1', 'world-WWWWWWWW.js': 'w', 'models/hero.glb': 'h' });
      mk('v2', { 'index-BBBBBBBB.js': 'v2', 'world-WWWWWWWW.js': 'w' });
      const r1 = keepOldAssets(path.join(root, 'v1'), path.join(root, 'v2'), { days: 3, now: t0 });
      expect(r1.kept).toEqual(['index-AAAAAAAA.js', 'index-AAAAAAAA.js.br']);
      expect(fs.readFileSync(path.join(root, 'v2', 'assets', 'index-AAAAAAAA.js'), 'utf8')).toBe('v1');
      expect(fs.existsSync(path.join(root, 'v2', 'assets', 'models', 'hero.glb'))).toBe(false); // (art: not carried)
      expect(JSON.parse(fs.readFileSync(path.join(root, 'v2', 'assets', RETIRED_FILE), 'utf8'))).toEqual({
        'index-AAAAAAAA.js': t0,
        'index-AAAAAAAA.js.br': t0,
      });
      // two days later v3: v1's bundle still within its 3 days, v2's retired now
      mk('v3', { 'index-CCCCCCCC.js': 'v3', 'world-WWWWWWWW.js': 'w' });
      const r2 = keepOldAssets(path.join(root, 'v2'), path.join(root, 'v3'), { days: 3, now: t0 + 2 * day });
      expect(r2.kept.sort()).toEqual(['index-AAAAAAAA.js', 'index-AAAAAAAA.js.br', 'index-BBBBBBBB.js']);
      // four days after v1's retirement: gone
      mk('v4', { 'index-DDDDDDDD.js': 'v4' });
      const r3 = keepOldAssets(path.join(root, 'v3'), path.join(root, 'v4'), { days: 3, now: t0 + 4 * day });
      expect(r3.dropped.sort()).toEqual(['index-AAAAAAAA.js', 'index-AAAAAAAA.js.br']);
      expect(r3.kept.sort()).toEqual(['index-BBBBBBBB.js', 'index-CCCCCCCC.js', 'world-WWWWWWWW.js']);
      // no previous build: nothing to do
      expect(keepOldAssets(path.join(root, 'none'), path.join(root, 'v4'))).toEqual({ kept: [], dropped: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
