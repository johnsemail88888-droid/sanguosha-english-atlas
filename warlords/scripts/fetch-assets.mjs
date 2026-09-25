// Downloads AI-generated art (Higgsfield) listed in assets-src/manifest.json and
// optimises it for the web. Runs in GitHub Actions (.github/workflows/warlords-assets.yml)
// because the dev container cannot reach the Higgsfield CDN; the workflow commits
// the results back to the branch.
//
// manifest entry kinds:
//   image   → resized WebP (maxSize px on the long edge, quality; circleMask: true
//             makes everything outside the inscribed circle transparent)
//   preview → small WebP kept under assets-src/previews for art review only (not shipped)
//   glb     → optimised GLB: textures resized + WebP, meshopt compression
//   anim    → animation-only GLB (meshes/materials/textures stripped, skeleton kept)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'assets-src', 'manifest.json');
const lockPath = join(root, 'assets-src', 'fetched.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};

const sharp = (await import('sharp')).default;
const { NodeIO } = await import('@gltf-transform/core');
const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
const { dedup, prune, resample, textureCompress, meshopt, weld } = await import('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
});

async function download(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function processImage(buf, e) {
  const max = e.maxSize ?? 512;
  const img = sharp(buf).resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
  if (!e.circleMask) return img.webp({ quality: e.quality ?? 82 }).toBuffer();
  // round emblems (item cards, ability icons): everything outside the inscribed
  // circle becomes transparent, with a ~2 % soft edge, so no painted corner (some
  // came back white) can ever show around the disc
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const r = Math.min(w, h) / 2;
  const feather = Math.max(1, r * 0.02);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
      const a = Math.min(1, Math.max(0, (r - d) / feather));
      const i = (y * w + x) * 4 + 3;
      data[i] = Math.round(data[i] * a);
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .webp({ quality: e.quality ?? 82, alphaQuality: 90 })
    .toBuffer();
}

async function processGlb(buf, e) {
  const doc = await io.readBinary(new Uint8Array(buf));
  if (e.kind === 'anim') {
    for (const mesh of doc.getRoot().listMeshes()) mesh.dispose();
    for (const mat of doc.getRoot().listMaterials()) mat.dispose();
    for (const tex of doc.getRoot().listTextures()) tex.dispose();
    // keepLeaves: end bones (HeadTop_End, toe tips) are skeleton leaves with no mesh
    await doc.transform(prune({ keepLeaves: true }), resample());
  } else {
    await doc.transform(
      dedup(),
      weld(),
      resample(),
      prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [e.texSize ?? 1024, e.texSize ?? 1024], quality: 85 }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
  }
  return Buffer.from(await io.writeBinary(doc));
}

let changed = 0;
const failures = [];
for (const e of manifest.entries) {
  const key = e.out;
  const sig = createHash('sha1').update(JSON.stringify(e)).digest('hex');
  const outPath = join(root, e.out);
  if (lock[key] === sig && existsSync(outPath)) continue;
  try {
    const raw = await download(e.url);
    const out =
      e.kind === 'glb' || e.kind === 'anim' ? await processGlb(raw, e) : await processImage(raw, e);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out);
    lock[key] = sig;
    changed++;
    console.log(`✓ ${e.out}  ${(raw.length / 1024).toFixed(0)} KB → ${(out.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    failures.push(`${e.out}: ${err && err.message ? err.message : err}`);
    console.error(`✗ ${e.out}: ${err && err.stack ? err.stack : err}`);
  }
}
writeFileSync(lockPath, JSON.stringify(lock, null, 1) + '\n');
console.log(`${changed} asset(s) updated, ${failures.length} failed`);
if (failures.length) writeFileSync(join(root, 'assets-src', 'failures.txt'), failures.join('\n') + '\n');
