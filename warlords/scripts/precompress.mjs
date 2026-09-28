#!/usr/bin/env node
// Precompress a production build for server/server.mjs: next to every compressible file of the
// directory it writes FILE.br (brotli) and FILE.gz (gzip -9), which the server sends to browsers
// that accept them (Content-Encoding, weak ETag, Vary). deploy/install.sh runs it on the build
// before the build goes live (the Mac mini / cloud server) — not part of `npm run build`: GitHub
// Pages and the desktop app compress (or do not need to) by themselves.
//
//   node scripts/precompress.mjs [dist]
//
// Text (JS, CSS, HTML, JSON, SVG, wasm): brotli at its best quality (11) — the 2 MB main bundle
// becomes ~0.55 MB. Models (GLB / glTF buffers): brotli 5 — 11 would take a minute for ~3 % more
// (measured: 24.5 MB of GLB → 21.4 MB at 5 in 0.5 s, 20.7 MB at 11 in 57 s). Images and audio
// (webp, png, jpg, mp3 …) are compressed already: skipped. A variant that saves under 5 % is left
// empty (the server ignores empty variants). Re-running skips files whose variants are newer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Extensions compressed, and the brotli quality each gets. */
export const BROTLI_QUALITY = Object.freeze({
  '.html': 11,
  '.js': 11,
  '.mjs': 11,
  '.css': 11,
  '.json': 11,
  '.map': 11,
  '.svg': 11,
  '.txt': 11,
  '.webmanifest': 11,
  '.wasm': 11,
  '.glb': 5,
  '.gltf': 11,
  '.bin': 5,
});
/** Smaller files are sent as they are (the headers would eat the saving). */
export const MIN_SIZE = 1024;
/** A variant must be at most this fraction of the original to be kept. */
export const MAX_RATIO = 0.95;

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && !/\.(br|gz)$/.test(ent.name)) yield p;
  }
}

const fresh = (variant, st) => {
  try {
    const vs = fs.statSync(variant);
    return vs.mtimeMs >= st.mtimeMs;
  } catch {
    return false;
  }
};

/**
 * Precompress every eligible file under `dir`. Resolves to totals: files looked at, compressed
 * now, reused (variants already fresh), and bytes before / after (brotli / gzip).
 * @param {string} dir
 * @param {{ concurrency?: number }} [opts]
 */
export async function precompressDir(dir, opts = {}) {
  const totals = { files: 0, compressed: 0, reused: 0, skipped: 0, raw: 0, br: 0, gz: 0 };
  const jobs = [];
  for (const file of walk(dir)) {
    totals.files++;
    const q = BROTLI_QUALITY[path.extname(file).toLowerCase()];
    const st = fs.statSync(file);
    if (q === undefined || st.size < MIN_SIZE) {
      totals.skipped++;
      continue;
    }
    jobs.push({ file, q, st });
  }
  const one = async ({ file, q, st }) => {
    const br = `${file}.br`;
    const gz = `${file}.gz`;
    if (fresh(br, st) && fresh(gz, st)) {
      totals.reused++;
      totals.raw += st.size;
      totals.br += fs.statSync(br).size || st.size;
      totals.gz += fs.statSync(gz).size || st.size;
      return;
    }
    const buf = await fs.promises.readFile(file);
    const [b, g] = await Promise.all([
      brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
      gzip(buf, { level: 9 }),
    ]);
    totals.compressed++;
    totals.raw += buf.length;
    for (const [variant, out, key] of /** @type {const} */ ([
      [br, b, 'br'],
      [gz, g, 'gz'],
    ])) {
      if (out.length <= buf.length * MAX_RATIO) {
        await fs.promises.writeFile(variant, out);
        totals[key] += out.length;
      } else {
        // not worth it: an empty variant says so (the server ignores it; a re-run skips the file)
        await fs.promises.writeFile(variant, '');
        totals[key] += buf.length;
      }
    }
  };
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) await one(jobs[next++]);
    }),
  );
  return totals;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const dir = path.resolve(process.argv[2] ?? 'dist');
  const t0 = Date.now();
  const t = await precompressDir(dir);
  const mb = (n) => (n / 1e6).toFixed(2);
  console.log(
    `precompress ${dir}: ${t.compressed} compressed, ${t.reused} unchanged, ${t.skipped} skipped — ${mb(t.raw)} MB → brotli ${mb(t.br)} MB / gzip ${mb(t.gz)} MB (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
  );
}
