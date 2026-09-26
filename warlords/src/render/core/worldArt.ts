// Optional AI-art for the static world (terrain / structure texture sets, the
// painted sky panorama, prop models): which files a deploy ships, loading them
// into GPU textures, the quality tier they are sized for, and teardown.
//
// Everything is an upgrade on top of the procedural world: materials compile
// their textured variant as soon as the asset listing says the files exist
// (normally before the loading-screen shader warm-up), draw with small
// placeholder layers until the real images are decoded, then swap the texture
// (same sampler type → no recompile). No files (single-file build, file://,
// stripped deploy): nothing here is ever fetched and the world looks exactly
// like the procedural one.
//
// Texture sets are THREE.DataArrayTexture (one sampler2DArray per set, one
// layer per material): the terrain picks its layers per fragment without
// branching on samplers, and every layer tiles / mipmaps independently.
import * as THREE from 'three';
import { assetList, assetListSync } from '../../game/assets';
import { settings, type Quality } from '../../game/settings';

// ── plan (pure) ─────────────────────────────────────────────────────────────

/** Terrain layers, in texture-array order (the terrain shader indexes them). */
export const GROUND_LAYERS = ['grass', 'dirt', 'cliff', 'paving', 'mud'] as const;
/** Structure layers, in texture-array order (SURF ids in structure geometry index them + 1). */
export const STRUCT_LAYERS = ['brick', 'plaster', 'rooftiles', 'planks', 'paving', 'cliff'] as const;
export type GroundLayer = (typeof GROUND_LAYERS)[number];
export type StructLayer = (typeof STRUCT_LAYERS)[number];

export const texFile = (name: string): string => `assets/tex/${name}.webp`;
export const SKY_FILE = 'assets/env/sky.webp';

/** sRGB multiplier applied to dirt when it stands in for a missing mud texture (darker, wetter, greyer). */
export const MUD_FALLBACK_TINT: readonly [number, number, number] = [0.66, 0.62, 0.56];

/** Flat stand-in colours (sRGB) per layer while the real images decode. */
const PLACEHOLDER: Record<string, string> = {
  grass: '#6e8a38',
  dirt: '#8a6a45',
  cliff: '#7d776c',
  paving: '#8c877c',
  mud: '#6c655a',
  brick: '#77736b',
  plaster: '#e2d9c6',
  rooftiles: '#55595f',
  planks: '#6b4a2e',
};

export interface LayerPlan {
  name: string;
  /** file feeding this layer (possibly another layer's file), or null = layer unavailable */
  file: string | null;
  /** sRGB multiplier applied while decoding */
  tint: readonly [number, number, number];
}

/**
 * Which file feeds each layer of a set. Mud falls back to tinted dirt; any
 * other missing layer is null (that surface stays vertex-coloured).
 */
export function planLayers(names: readonly string[], files: ReadonlySet<string>): LayerPlan[] {
  return names.map((name) => {
    const own = texFile(name);
    if (files.has(own)) return { name, file: own, tint: [1, 1, 1] as const };
    if (name === 'mud' && files.has(texFile('dirt'))) return { name, file: texFile('dirt'), tint: MUD_FALLBACK_TINT };
    return { name, file: null, tint: [1, 1, 1] as const };
  });
}

/** The terrain needs at least grass, dirt and cliff to go textured. */
export function groundPlanUsable(plan: readonly LayerPlan[]): boolean {
  return ['grass', 'dirt', 'cliff'].every((n) => plan.some((l) => l.name === n && l.file));
}

/** A structure set is worth loading when any of its layers exists. */
export function structPlanUsable(plan: readonly LayerPlan[]): boolean {
  return plan.some((l) => l.file);
}

export interface TexSizes {
  ground: number;
  struct: number;
  /** longest side of a prop model's texture (the shipped maps are 512–1024) */
  props: number;
  /** sky panorama width (height follows the image aspect) */
  sky: number;
}

/**
 * Texture resolution per quality tier. GPU memory (RGBA8 + mips): ground array
 * ~28 MB, structure array ~8 MB, sky ~9–15 MB, prop models ~13 MB (medium,
 * maps capped at 512) / ~32 MB (high); ~4× less on low.
 * Structures stay at 512 even on high: 2.3 m per repeat is ~220 texels per metre.
 */
export function texSizesFor(q: Quality): TexSizes {
  if (q === 'low') return { ground: 512, struct: 256, props: 256, sky: 1024 };
  if (q === 'high') return { ground: 1024, struct: 512, props: 1024, sky: 2560 };
  return { ground: 1024, struct: 512, props: 512, sky: 2048 };
}

// ── runtime state ───────────────────────────────────────────────────────────

/** QA / perf A-B switch: localStorage 'sgwl.worldArt' = '0' keeps the procedural world. */
export function worldArtDisabledByUser(): boolean {
  try {
    return globalThis.localStorage?.getItem('sgwl.worldArt') === '0';
  } catch {
    return false;
  }
}

function browserCanDecode(): boolean {
  return typeof document !== 'undefined' && typeof fetch === 'function' && typeof createImageBitmap === 'function';
}

let possibleOverride: boolean | null = null;

/** Tests: force worldArtPossible() on / off (null: detect from the page). */
export function setWorldArtPossibleForTests(v: boolean | null): void {
  possibleOverride = v;
}

/**
 * False when this page can never show world art: the user switch, no image
 * decoding (tests, old browsers), or a page that cannot fetch side files (the
 * single-file build opened from file://). Synchronous: callers decide before
 * the asset listing has loaded.
 */
export function worldArtPossible(): boolean {
  if (possibleOverride !== null) return possibleOverride;
  if (worldArtDisabledByUser() || !browserCanDecode()) return false;
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
}

export interface TexArraySet {
  /** layer names, in array order */
  names: readonly string[];
  /** which layers carry a real image (others: placeholder colour, shader treats as absent) */
  has: boolean[];
  /** placeholder until `ready`, then the decoded array (same uniform object → no recompile) */
  uniform: { value: THREE.DataArrayTexture };
  /** linear-space average colour per layer (texture normalisation) */
  avg: THREE.Color[];
  ready: Promise<void>;
}

let quality: Quality = safeQuality();
const qualitySubs = new Set<(q: Quality) => void>();
let unsubSettings: (() => void) | null = null;
let qualityPinned = false;

function safeQuality(): Quality {
  try {
    return settings.get().quality;
  } catch {
    return 'medium';
  }
}

/** Current world-art quality tier (follows settings unless the renderer pins it). */
export function worldArtQuality(): Quality {
  ensureSettingsSub();
  return quality;
}

/** Renderer hook: the preset in use (overrides the stored setting, e.g. a dev ?quality=). */
export function setWorldArtQuality(q: Quality): void {
  qualityPinned = true;
  applyQuality(q);
}

/** Subscribe to tier changes (materials switch their sample count). */
export function onWorldArtQuality(cb: (q: Quality) => void): () => void {
  ensureSettingsSub();
  qualitySubs.add(cb);
  return () => qualitySubs.delete(cb);
}

function applyQuality(q: Quality): void {
  if (q === quality) return;
  quality = q;
  for (const cb of qualitySubs) cb(q);
}

function ensureSettingsSub(): void {
  if (unsubSettings) return;
  try {
    unsubSettings = settings.subscribe((u) => {
      if (!qualityPinned) applyQuality(u.quality);
    });
  } catch {
    unsubSettings = () => undefined;
  }
}

let groundSet: TexArraySet | null = null;
let structSet: TexArraySet | null = null;
let skyTexValue: THREE.Texture | null = null;
const placeholders: THREE.DataArrayTexture[] = [];

/**
 * The listing if known (sync), or a promise for it. Returns null when world
 * art is off for this page (no browser decode support / user switch).
 */
function listing(): ReadonlySet<string> | Promise<ReadonlySet<string>> | null {
  if (!worldArtPossible()) return null;
  return assetListSync() ?? assetList();
}

/**
 * Resolve the listing (sync when already known) and call `fn` with it — used by
 * materials to pick their program variant before the first compile. Returns
 * false (and never calls back) when world art is off for this page.
 */
export function withWorldArtListing(fn: (files: ReadonlySet<string>) => void): boolean {
  const l = listing();
  if (!l) return false;
  if (l instanceof Promise) void l.then(fn, () => undefined);
  else fn(l);
  return true;
}

function makePlaceholder(names: readonly string[]): THREE.DataArrayTexture {
  const S = 4;
  const data = new Uint8Array(S * S * 4 * names.length);
  names.forEach((n, i) => {
    const hex = new THREE.Color(PLACEHOLDER[n] ?? '#808080').getHex(); // sRGB bytes
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    for (let p = 0; p < S * S; p++) {
      const o = (i * S * S + p) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  });
  const t = new THREE.DataArrayTexture(data, S, S, names.length);
  configureArray(t);
  t.needsUpdate = true;
  placeholders.push(t);
  return t;
}

function configureArray(t: THREE.DataArrayTexture, anisotropy = 8): void {
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // three clamps to the device maximum: effectively min(8, max) for the ground
  t.anisotropy = anisotropy;
}

let lut: Float32Array | null = null;
/** sRGB byte → linear float. */
function srgbLut(): Float32Array {
  if (!lut) {
    lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      lut[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
  }
  return lut;
}

async function decodeInto(file: string, size: number, tint: readonly [number, number, number], out: Uint8Array, layer: number, avg: THREE.Color): Promise<void> {
  const res = await fetch(file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('no 2d context');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, size, size);
    const px = g.getImageData(0, 0, size, size).data;
    const o = layer * size * size * 4;
    const [tr, tg, tb] = tint;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    const lin = srgbLut();
    for (let i = 0; i < px.length; i += 4) {
      const r = Math.min(255, Math.round(px[i] * tr));
      const gg = Math.min(255, Math.round(px[i + 1] * tg));
      const b = Math.min(255, Math.round(px[i + 2] * tb));
      out[o + i] = r;
      out[o + i + 1] = gg;
      out[o + i + 2] = b;
      out[o + i + 3] = 255;
      // average on a sparse grid (every 8th pixel) — plenty for a mean colour
      if (((i >> 2) & 7) === 0) {
        sr += lin[r];
        sg += lin[gg];
        sb += lin[b];
      }
    }
    const count = Math.ceil(px.length / 32);
    avg.setRGB(sr / count, sg / count, sb / count);
  } finally {
    bmp.close();
  }
}

function buildSet(names: readonly string[], plan: readonly LayerPlan[], size: number, anisotropy: number): TexArraySet {
  const has = plan.map((l) => !!l.file);
  const avg = names.map((n) => new THREE.Color(PLACEHOLDER[n] ?? '#808080'));
  const uniform = { value: makePlaceholder(names) };
  const data = new Uint8Array(size * size * 4 * names.length);
  const ready = (async () => {
    // decode one image at a time (bounded memory, keeps the main thread responsive)
    for (let i = 0; i < plan.length; i++) {
      const l = plan[i];
      if (!l.file) continue;
      try {
        await decodeInto(l.file, size, l.tint, data, i, avg[i]);
      } catch (err) {
        has[i] = false;
        console.warn('[render] world texture failed', l.file, err);
      }
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (!has.some(Boolean)) return;
    const tex = new THREE.DataArrayTexture(data, size, size, names.length);
    configureArray(tex, anisotropy);
    tex.needsUpdate = true;
    uniform.value = tex;
  })();
  return { names, has, uniform, avg, ready };
}

/**
 * The terrain texture set, or null when this deploy cannot texture the ground.
 * Calls back synchronously when the listing is already known.
 */
export function requestGroundSet(cb: (set: TexArraySet) => void): void {
  if (groundSet) {
    cb(groundSet);
    return;
  }
  withWorldArtListing((files) => {
    if (!groundSet) {
      const plan = planLayers(GROUND_LAYERS, files);
      if (!groundPlanUsable(plan)) return;
      // the ground is seen at grazing angles: full anisotropy (low tier: cheap filtering)
      const q = worldArtQuality();
      groundSet = buildSet(GROUND_LAYERS, plan, texSizesFor(q).ground, q === 'low' ? 2 : 8);
    }
    cb(groundSet);
  });
}

/** The structure texture set (brick / plaster / roof tiles / planks / paving / cliff), or nothing. */
export function requestStructSet(cb: (set: TexArraySet) => void): void {
  if (structSet) {
    cb(structSet);
    return;
  }
  withWorldArtListing((files) => {
    if (!structSet) {
      const plan = planLayers(STRUCT_LAYERS, files);
      if (!structPlanUsable(plan)) return;
      // walls and roofs face the camera: 4× is plenty (low tier: none)
      const q = worldArtQuality();
      structSet = buildSet(STRUCT_LAYERS, plan, texSizesFor(q).struct, q === 'low' ? 1 : 4);
    }
    cb(structSet);
  });
}

/** The painted sky panorama plus what the sky / water / fog need to know about it. */
export interface SkyArt {
  tex: THREE.Texture;
  /** image aspect (width / height) */
  aspect: number;
  /** painted sun position in texture space (u → right, v → down), detected from the brightest pixels */
  sunU: number;
  sunV: number;
  /** linear mean colours: the band just above the painted horizon, and the top rows */
  horizon: THREE.Color;
  zenith: THREE.Color;
  /** texture v of the painted horizon (skyHorizonV) */
  horizonV: number;
  /** small sRGB RGBA copy of the painting (analysis / fog LUT) */
  preview: { px: Uint8ClampedArray; w: number; h: number };
}

/** Brightest-blob centroid of an RGBA image (the painted sun), or null when there is no clear peak. */
export function findSun(px: Uint8ClampedArray | Uint8Array, w: number, h: number): { u: number; v: number } | null {
  let max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
    if (l > max) max = l;
  }
  if (max < 200) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
      if (l >= max - 3) {
        sx += x;
        sy += y;
        n++;
      }
    }
  if (!n || n > w * h * 0.02) return null; // no single bright disc
  return { u: (sx / n + 0.5) / w, v: (sy / n + 0.5) / h };
}

/** How makePanoramaTileable reshapes the painting near its two edges (fractions of the width). */
export interface TileableOptions {
  /** width of the low-frequency colour ramp on the left edge */
  rampL: number;
  /** …and on the right edge (kept clear of the painted sun) */
  rampR: number;
  /** mean width of the detail cross-fade at the right edge (into the mirrored left edge; varies per row) */
  fade: number;
  /** where the matched edge colour sits between the left (0) and right (1) edge colour (before leaning to the brighter one) */
  bias: number;
  /** how much of the detail contrast is gone at the edges (0 = kept, 1 = only the matched colour) */
  soften: number;
}

export const SKY_TILEABLE: TileableOptions = { rampL: 0.24, rampR: 0.13, fade: 0.05, bias: 0.5, soften: 0.6 };

/**
 * Make a panorama wrap seamlessly around 360° (RGBA bytes, in place). The
 * painting was not made to tile — deep blue on its left edge, sunset clouds and
 * dark ranges on its right — so a plain wrap is a colour wall (and bilinear /
 * mip filtering draws a 1 px line of the other edge right on it). Per row, both
 * edges' low frequencies (block means, blurred) are pulled to one matched colour
 * over wide ramps — a gradual shift of tint over 45–85° of sky, the details
 * kept — then the right edge's remaining detail cross-fades into the mirrored
 * left edge over a few degrees. Afterwards the last column continues into the
 * first. Pure.
 */
export function makePanoramaTileable(px: Uint8ClampedArray | Uint8Array, w: number, h: number, o: TileableOptions = SKY_TILEABLE): void {
  if (w < 8 || h < 2) return;
  // 1. low-pass: block means on a coarse grid, box-blurred (clamped at the image edges)
  const gw = Math.min(w, 64);
  const gh = Math.max(2, Math.min(h, Math.round((gw * h) / w)));
  const grid = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * h) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
      const n = (y1 - y0) * (x1 - x0);
      const k = (gy * gw + gx) * 3;
      grid[k] = r / n;
      grid[k + 1] = g / n;
      grid[k + 2] = b / n;
    }
  }
  const blur = (src: Float32Array, horizontal: boolean): Float32Array => {
    const dst = new Float32Array(src.length);
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        let n = 0;
        const k = (gy * gw + gx) * 3;
        for (let d = -1; d <= 1; d++) {
          const x = horizontal ? gx + d : gx;
          const y = horizontal ? gy : gy + d;
          if (x < 0 || x >= gw || y < 0 || y >= gh) continue;
          const s = (y * gw + x) * 3;
          dst[k] += src[s];
          dst[k + 1] += src[s + 1];
          dst[k + 2] += src[s + 2];
          n++;
        }
        dst[k] /= n;
        dst[k + 1] /= n;
        dst[k + 2] /= n;
      }
    return dst;
  };
  const low = blur(blur(grid, true), false);
  // bilinear lookup in the blurred grid (texel centres, clamped)
  const lowAt = (fx: number, fy: number, out: number[]): void => {
    const gx = Math.min(gw - 1, Math.max(0, fx * gw - 0.5));
    const gy = Math.min(gh - 1, Math.max(0, fy * gh - 0.5));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(gw - 1, x0 + 1);
    const y1 = Math.min(gh - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    for (let c = 0; c < 3; c++) {
      const a = low[(y0 * gw + x0) * 3 + c] * (1 - tx) + low[(y0 * gw + x1) * 3 + c] * tx;
      const b = low[(y1 * gw + x0) * 3 + c] * (1 - tx) + low[(y1 * gw + x1) * 3 + c] * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
  };
  const sstep = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // 2. per row: pull both edges' low frequencies to the matched colour, then cross-fade the detail
  const row = new Float32Array(w * 3);
  const lo = [0, 0, 0];
  const eL = [0, 0, 0];
  const eR = [0, 0, 0];
  const xl1 = Math.min(w, Math.ceil(o.rampL * w) + 1);
  const xr0 = Math.max(0, Math.floor((1 - o.rampR) * w) - 1);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / h;
    lowAt(0, fy, eL);
    lowAt(1, fy, eR);
    // the matched colour leans to the brighter edge: dark painted ranges dissolve into
    // the haze (ink-wash style) instead of the haze darkening into a smudge
    const dl = 0.3 * (eR[0] - eL[0]) + 0.59 * (eR[1] - eL[1]) + 0.11 * (eR[2] - eL[2]);
    const bias = Math.min(1, Math.max(0, o.bias + 0.35 * Math.tanh(dl / 30)));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row[x * 3] = px[i];
      row[x * 3 + 1] = px[i + 1];
      row[x * 3 + 2] = px[i + 2];
      if (x >= xl1 && x < xr0) continue;
      const u = (x + 0.5) / w;
      const k = (1 - sstep(0, o.rampL, u)) + sstep(1 - o.rampR, 1, u);
      if (k <= 0) continue;
      lowAt(u, fy, lo);
      for (let c = 0; c < 3; c++) {
        const m = eL[c] + (eR[c] - eL[c]) * bias;
        // low frequencies → the matched colour; details (ranges, cloud edges) soften toward the seam
        row[x * 3 + c] += k * (m - lo[c]) - k * o.soften * (row[x * 3 + c] - lo[c]);
      }
    }
    // the fade's start wanders from row to row (a ragged, misty edge, not a vertical cut
    // through the painted ranges)
    const fade = o.fade * (1 + 0.45 * Math.sin(fy * 17.3 + 1.1) + 0.3 * Math.sin(fy * 41.7 + 2.3));
    const xf0 = Math.max(0, Math.floor((1 - fade) * w) - 1);
    for (let x = xf0; x < w; x++) {
      const t = fade > 0 ? sstep(1 - fade, 1, (x + 0.5) / w) : 0;
      if (t <= 0) continue;
      const m = w - 1 - x; // mirrored column: the last column continues into column 0
      for (let c = 0; c < 3; c++) row[x * 3 + c] += (row[m * 3 + c] - row[x * 3 + c]) * t;
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = Math.min(255, Math.max(0, Math.round(row[x * 3])));
      px[i + 1] = Math.min(255, Math.max(0, Math.round(row[x * 3 + 1])));
      px[i + 2] = Math.min(255, Math.max(0, Math.round(row[x * 3 + 2])));
    }
  }
}

/** Where the painted sun sits when nothing can be detected (env/sky.webp as shipped). */
const SUN_FALLBACK = { u: 0.81, v: 0.56 };

let skyArt: Promise<SkyArt | null> | null = null;

/** Painted sky panorama (callback only when shipped, decoded and world art is on). */
export function requestSkyArt(cb: (art: SkyArt) => void): void {
  withWorldArtListing((files) => {
    if (!files.has(SKY_FILE)) return;
    if (!skyArt) {
      const width = texSizesFor(worldArtQuality()).sky;
      skyArt = (async () => {
        try {
          const res = await fetch(SKY_FILE);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bmp = await createImageBitmap(await res.blob());
          const w = Math.min(width, bmp.width);
          const h = Math.round((bmp.height * w) / bmp.width);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          if (!g) throw new Error('no 2d context');
          g.imageSmoothingQuality = 'high';
          g.drawImage(bmp, 0, 0, w, h);
          // wrapped around 360°: its two painted edges must meet (no seam at any azimuth)
          const img = g.getImageData(0, 0, w, h);
          makePanoramaTileable(img.data, w, h);
          g.putImageData(img, 0, 0);
          // analysis on a small copy of the tileable painting: sun position, horizon / zenith colours, fog LUT
          const aw = 256;
          const ah = Math.max(8, Math.round((h * aw) / w));
          const small = document.createElement('canvas');
          small.width = aw;
          small.height = ah;
          const sg = small.getContext('2d', { willReadFrequently: true });
          if (!sg) throw new Error('no 2d context');
          sg.imageSmoothingQuality = 'high';
          sg.drawImage(canvas, 0, 0, aw, ah);
          const px = sg.getImageData(0, 0, aw, ah).data;
          bmp.close();
          const sun = findSun(px, aw, ah) ?? SUN_FALLBACK;
          const lin = srgbLut();
          const band = (v0: number, v1: number): THREE.Color => {
            let r = 0;
            let gg = 0;
            let b = 0;
            let n = 0;
            for (let y = Math.floor(v0 * ah); y < Math.max(Math.floor(v0 * ah) + 1, Math.floor(v1 * ah)); y++)
              for (let x = 0; x < aw; x++) {
                const i = (y * aw + x) * 4;
                r += lin[px[i]];
                gg += lin[px[i + 1]];
                b += lin[px[i + 2]];
                n++;
              }
            return new THREE.Color(r / n, gg / n, b / n);
          };
          const t = new THREE.CanvasTexture(canvas);
          t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.ClampToEdgeWrapping;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = 4;
          t.needsUpdate = true;
          skyTexValue = t;
          const horizonV = skyHorizonV(sun.v);
          return {
            tex: t,
            aspect: w / h,
            sunU: sun.u,
            sunV: sun.v,
            horizon: band(horizonV - 0.08, horizonV - 0.02),
            zenith: band(0, 0.06),
            horizonV,
            preview: { px, w: aw, h: ah },
          };
        } catch (err) {
          console.warn('[render] sky panorama failed', err);
          return null;
        }
      })();
    }
    void skyArt.then((a) => {
      if (a) cb(a);
    });
  });
}

/** Elevation (radians) of the scene's sun: the painted sun is lined up with it. */
let sunElevation = Math.asin(0.5144);

/** Tell the sky mapping where the light comes from (scene/lights.ts SUN_DIR). */
export function setSkySunElevation(rad: number): void {
  sunElevation = rad;
}

/**
 * Elevation span of the panorama's full height (radians). The 21:9 painting
 * wraps 360° horizontally; at square pixels its height would span ~150° and
 * the painted ranges would tower 40° over the map, so it is squeezed to 80°
 * (pixels ~1.9× wider than tall: ranges read broad and distant, clouds long).
 */
export const SKY_RAD_PER_IMAGE = (80 * Math.PI) / 180;

/** Highest elevation (rad) the painted sun is lifted to: it is painted low, near the ranges. */
const PAINTED_SUN_MAX_EL = 0.34;

/**
 * Texture v of the painted horizon. The panorama is turned so the painted sun
 * sits at the light's azimuth; vertically it follows the light's elevation up
 * to ~20° (lifting a low painted sun to the 31° key light would push the
 * painted ranges into the sky), which keeps the misty bases of the ranges on
 * the real horizon.
 */
export function skyHorizonV(sunV: number): number {
  return Math.min(0.88, Math.max(0.62, sunV + Math.min(sunElevation, PAINTED_SUN_MAX_EL) / SKY_RAD_PER_IMAGE));
}

/** Resolves when every world texture that was requested has settled (never rejects). */
export async function worldTexturesSettled(): Promise<void> {
  await Promise.all([groundSet?.ready, structSet?.ready, skyArt].map((p) => (p ? p.catch(() => undefined) : undefined)));
}

/** Renderer teardown: free GPU textures (the next match reloads them from the HTTP cache). */
export function disposeWorldArt(): void {
  for (const s of [groundSet, structSet]) {
    if (!s) continue;
    s.uniform.value.dispose();
  }
  for (const p of placeholders) p.dispose();
  placeholders.length = 0;
  skyTexValue?.dispose();
  skyTexValue = null;
  groundSet = structSet = null;
  skyArt = null;
}
