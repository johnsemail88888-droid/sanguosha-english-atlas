// Graphics quality presets (settings.quality). Changing preset at runtime is
// supported; toggling shadows recompiles materials once (brief hitch).
import type { Quality } from '../game/settings';
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
  /** multiplier on devicePixelRatio, and an absolute cap */
  pixelRatioScale: number;
  maxPixelRatio: number;
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
  /** decorative grass tufts around the camera */
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
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: {
    pixelRatioScale: 0.75,
    maxPixelRatio: 1,
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
  },
  medium: {
    pixelRatioScale: 1,
    maxPixelRatio: 1.5,
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
  },
  high: {
    pixelRatioScale: 1,
    maxPixelRatio: 2,
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
  },
};

export const qualityPreset = (q: Quality): QualityPreset => QUALITY_PRESETS[q] ?? QUALITY_PRESETS.medium;
