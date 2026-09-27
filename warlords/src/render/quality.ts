// Graphics quality presets (settings.quality): a five-step ladder from 极速
// (software rendering / very old PCs) to 极致 (strong GPUs). Each tier is a
// clarity setting (render scale, DPR cap) plus cost knobs. Changing preset at
// runtime is supported; toggling shadows recompiles materials once (brief
// hitch). The world build (AI-art prop models) follows the tier the match
// started on (see worldArt below).
import { QUALITIES, type Quality } from '../game/settings';
import { WEAPONS } from '../data';

/**
 * Heroes within this distance of the camera are always drawn, on every
 * preset (the far plane is stretched for them): the longest weapon range in
 * the data (麒麟弓 400 m) plus a margin, clamped to a sane band.
 */
export const HERO_VIEW_RANGE = Math.min(640, Math.max(300, WEAPONS.reduce((m, w) => Math.max(m, w.maxRange || 0), 0) + 30));

/** Which characters use their AI-art (GLB) body: every one, heroes only, or none (procedural rigs). */
export type CharacterArt = 'all' | 'heroes' | 'none';

export interface QualityPreset {
  /** multiplier on devicePixelRatio, and an absolute cap (both in canvas pixels per CSS px) */
  pixelRatioScale: number;
  maxPixelRatio: number;
  /**
   * Canvas pixel budget (0 = none): a bigger window renders at a lower ratio
   * instead of multiplying the per-pixel cost (极速: a 2560×1440 window would
   * otherwise draw 4× the pixels of a 1280×720 one).
   */
  maxPixels: number;
  shadows: boolean;
  shadowMapSize: number;
  /** half extent (m) of the orthographic shadow frustum around the player */
  shadowExtent: number;
  bloom: boolean;
  /** use the post-processing composer (vignette, bloom) */
  post: boolean;
  /** MSAA samples for the composer render target */
  msaa: number;
  /** camera far plane / fog end (m) for the world; heroes stay visible to HERO_VIEW_RANGE */
  drawDistance: number;
  /** troops / NPCs beyond this are hidden (m); heroes are never distance-culled */
  characterDistance: number;
  /** dynamic point lights for braziers / VFX */
  brazierLights: number;
  vfxLights: number;
  /** particle budget multiplier */
  particles: number;
  /** decorative grass tufts around the camera (density, ≈1.39 = every cell) */
  grass: number;
  /**
   * AI-art (GLB) character bodies when the deploy ships them: every character,
   * heroes only (troops / NPCs keep the cheaper procedural bodies) or none.
   */
  glbCharacters: CharacterArt;
  /**
   * Longest side (texels) of an AI-art character's texture (heroes ship 1024²,
   * troops / NPCs 512²) and of an AI-art weapon's (they ship 512²): GPU memory
   * on phones — a hero is ~5.6 MB at 1024² with mips, ~1.4 MB at 512².
   */
  charTexture: number;
  weaponTexture: number;
  /**
   * AI-art world: painted ground, textured buildings, prop models, farm art.
   * false = the procedural world (vertex colours; the single-file build's
   * look) — several times cheaper per pixel. The ground / buildings follow a
   * mid-match switch; prop models follow the tier the match was built on.
   */
  worldArt: boolean;
  /** frame-rate cap of the match loop (fps); 0 = the display's rate */
  maxFps: number;
  /**
   * Per-pixel shading cost: 'full' = PBR world, painted sky and sky fog per
   * pixel; 'lite' = sky dome and fog colour evaluated per vertex (scene/sky.ts
   * SKY_CHEAP, scene/skyfog.ts FOG_VERTEX_COLOR); 'basic' = lite + diffuse-only
   * (Lambert) ground, buildings and vegetation.
   */
  shading: 'basic' | 'lite' | 'full';
  /**
   * Distance scale of the character LODs (entities/lod.ts): the far body and
   * the reduced animation rates start this much further out.
   */
  lodScale: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  // 极速: software rendering (SwiftShader / llvmpipe / "Microsoft Basic Render")
  // and very old PCs. Half-resolution canvas, the procedural world and bodies,
  // no shadows / post / dynamic lights, short fog, 30 fps (more CPU for the sim).
  potato: {
    pixelRatioScale: 0.5,
    maxPixelRatio: 0.5,
    maxPixels: 280_000,
    shadows: false,
    shadowMapSize: 512,
    shadowExtent: 30,
    bloom: false,
    post: false,
    msaa: 0,
    drawDistance: 125,
    characterDistance: 40,
    brazierLights: 0,
    vfxLights: 0,
    particles: 0.3,
    grass: 0,
    glbCharacters: 'none',
    charTexture: 256,
    weaponTexture: 256,
    worldArt: false,
    maxFps: 30,
    shading: 'basic',
    lodScale: 0.7,
  },
  // 流畅
  low: {
    pixelRatioScale: 0.75,
    maxPixelRatio: 1,
    maxPixels: 0,
    shadows: false,
    shadowMapSize: 1024,
    shadowExtent: 30,
    bloom: false,
    post: false,
    msaa: 0,
    drawDistance: 230,
    characterDistance: 140,
    brazierLights: 0,
    vfxLights: 1,
    particles: 0.5,
    grass: 0,
    // weak devices (phones): AI-art heroes, the cheaper procedural troops / NPCs
    glbCharacters: 'heroes',
    charTexture: 512,
    weaponTexture: 256,
    worldArt: true,
    maxFps: 0,
    shading: 'lite',
    lodScale: 0.8,
  },
  // 均衡
  medium: {
    pixelRatioScale: 1,
    maxPixelRatio: 1.5,
    maxPixels: 0,
    shadows: true,
    shadowMapSize: 2048,
    shadowExtent: 42,
    bloom: false,
    post: true,
    msaa: 4,
    drawDistance: 340,
    characterDistance: 200,
    brazierLights: 2,
    vfxLights: 2,
    particles: 0.8,
    grass: 0.6,
    glbCharacters: 'all',
    charTexture: 1024,
    weaponTexture: 512,
    worldArt: true,
    maxFps: 0,
    shading: 'full',
    lodScale: 1,
  },
  // 高清
  high: {
    pixelRatioScale: 1,
    maxPixelRatio: 2,
    maxPixels: 0,
    shadows: true,
    shadowMapSize: 4096,
    shadowExtent: 55,
    bloom: true,
    post: true,
    msaa: 4,
    drawDistance: 480,
    characterDistance: 260,
    brazierLights: 3,
    vfxLights: 3,
    particles: 1,
    grass: 1,
    glbCharacters: 'all',
    charTexture: 1024,
    weaponTexture: 512,
    worldArt: true,
    maxFps: 0,
    shading: 'full',
    lodScale: 1.25,
  },
  // 极致: strong discrete GPUs — full DPR, wider shadow frustum, the longest
  // draw distance, every grass cell, the full particle budget and more lights.
  ultra: {
    pixelRatioScale: 1,
    maxPixelRatio: 2,
    maxPixels: 0,
    shadows: true,
    shadowMapSize: 4096,
    shadowExtent: 75,
    bloom: true,
    post: true,
    msaa: 4,
    drawDistance: 620,
    characterDistance: 340,
    brazierLights: 4,
    vfxLights: 4,
    particles: 1,
    grass: 1.39,
    glbCharacters: 'all',
    charTexture: 1024,
    weaponTexture: 512,
    worldArt: true,
    maxFps: 0,
    shading: 'full',
    lodScale: 1.6,
  },
};

export const qualityPreset = (q: Quality): QualityPreset => QUALITY_PRESETS[q] ?? QUALITY_PRESETS.medium;

/**
 * Canvas pixel ratio of a preset for a `w`×`h` CSS px view at devicePixelRatio
 * `dpr`: the scale and the cap, then the pixel budget.
 */
export function presetPixelRatio(p: QualityPreset, dpr: number, w: number, h: number): number {
  const pr = Math.min(p.maxPixelRatio, dpr * p.pixelRatioScale);
  const area = Math.max(1, w * h);
  return p.maxPixels > 0 && area * pr * pr > p.maxPixels ? Math.sqrt(p.maxPixels / area) : pr;
}

/** Position of a tier on the ladder (0 = 极速 … 4 = 极致); unknown ids rank as 均衡. */
export function qualityRank(q: Quality): number {
  const i = QUALITIES.indexOf(q);
  return i < 0 ? QUALITIES.indexOf('medium') : i;
}

/** True when `q` is `than` or a cheaper tier (e.g. atMost(q, 'low'): 流畅 and 极速). */
export function atMost(q: Quality, than: Quality): boolean {
  return qualityRank(q) <= qualityRank(than);
}

/**
 * The ground shader variant a tier draws (a change recompiles the terrain):
 * the procedural ground, the single-sample painted ground (流畅) or the full one.
 */
export function groundVariant(q: Quality): 'plain' | 'lq' | 'full' {
  if (!qualityPreset(q).worldArt) return 'plain';
  return atMost(q, 'low') ? 'lq' : 'full';
}
