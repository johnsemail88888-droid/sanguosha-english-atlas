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
          const g = canvas.getContext('2d');
          if (!g) throw new Error('no 2d context');
          g.imageSmoothingQuality = 'high';
          g.drawImage(bmp, 0, 0, w, h);
          // analysis on a small copy: sun position, horizon / zenith colours
          const aw = 256;
          const ah = Math.max(8, Math.round((bmp.height * aw) / bmp.width));
          const small = document.createElement('canvas');
          small.width = aw;
          small.height = ah;
          const sg = small.getContext('2d', { willReadFrequently: true });
          if (!sg) throw new Error('no 2d context');
          sg.drawImage(bmp, 0, 0, aw, ah);
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
