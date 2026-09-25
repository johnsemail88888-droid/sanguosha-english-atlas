// Painted card / icon art for the UI (optional AI-generated files in public/assets,
// listed by src/game/assets.ts): identity cards, item / armor / mount emblems,
// ability icons and weapon renders. Pure logic (no DOM) so it is unit-tested;
// artIcons.ts does the DOM side.
//
//   cards/roles/<roleId>.webp        3:4 painted identity card, no text (we draw the frame + name)
//   cards/items/<id>.webp            1:1 round emblem on an ink-wash vignette — some have WHITE
//                                    corners outside the ink circle: always shown through a round mask
//   icons/abilities/<abilityId>.webp 1:1 round emblem in the kingdom colour (same caveat)
//   weapons/<weaponId>.webp          16:9 side view, barrel right, on pure black
//
// Without a file (single-file build, a deploy that dropped the folder) every caller
// keeps today's glyph / seal look: nothing here ever names a file that is not listed.
import { ARMOR_BY_ID, ITEM_BY_ID, MOUNT_BY_ID, WEAPON_BY_ID } from '../data';

/** Identity cards are 3:4 (576×768). */
export const ROLE_CARD_ASPECT = 3 / 4;
/** Weapon renders are 16:9 (768×432 nominal). */
export const WEAPON_ART_ASPECT = 16 / 9;

export function roleCardPath(role: string): string {
  return `assets/cards/roles/${role}.webp`;
}

/** Cards (锦囊), armor and mounts share one folder of round emblems. */
export function itemArtPath(id: string): string {
  return `assets/cards/items/${id}.webp`;
}

export function abilityIconPath(abilityId: string): string {
  return `assets/icons/abilities/${abilityId}.webp`;
}

export function weaponArtPath(weaponId: string): string {
  return `assets/weapons/${weaponId}.webp`;
}

/** How a piece of art is framed: a round emblem, a 16:9 weapon render, a 3:4 identity card. */
export type ArtShape = 'disc' | 'weapon' | 'card';

export interface ArtRef {
  path: string;
  shape: ArtShape;
}

/** Weapons only units use (troops, NPC beasts, turrets): no render. */
export function isUnitWeapon(id: string): boolean {
  return /^(troop|npc|turret)_/.test(id);
}

/**
 * The art of anything you can pick up or hold, by id: a weapon render for weapons,
 * the round emblem for cards / armor / mounts. Null for ids without art (troop /
 * NPC / turret weapons, unknown ids).
 */
export function gearArt(id: string | null | undefined): ArtRef | null {
  if (!id) return null;
  if (WEAPON_BY_ID[id]) return isUnitWeapon(id) ? null : { path: weaponArtPath(id), shape: 'weapon' };
  if (ITEM_BY_ID[id] || ARMOR_BY_ID[id] || MOUNT_BY_ID[id]) return { path: itemArtPath(id), shape: 'disc' };
  return null;
}

/**
 * `path` when this deploy ships it and it has not failed to load, else null — also
 * while the listing is still unknown (callers decide again once it has loaded).
 */
export function shippedPath(files: ReadonlySet<string> | null | undefined, path: string | null | undefined, broken?: ReadonlySet<string>): string | null {
  if (!files || !path) return null;
  return files.has(path) && !broken?.has(path) ? path : null;
}

// ── weapon cut-out ───────────────────────────────────────────────────────────
// The renders sit on black. Blend modes (lighten / screen) only hide it over an
// opaque dark backdrop — the HUD panels are translucent over the 3D view and the
// 玩法说明 tables are parchment — so the black is turned into transparency once
// per render instead (artIcons.ts, on a canvas).

/** Brightness (0..255, the max channel) of the render's background: the 95th percentile of the border pixels. */
export function cutoutFloor(borderMax: ArrayLike<number>): number {
  if (!borderMax.length) return 0;
  const sorted = Array.from(borderMax).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/** Brightness over the background at which a pixel is fully opaque. */
export const CUTOUT_RAMP = 26;

/**
 * Opacity of a render pixel from its brightness: 0 at or below the background
 * (floor + a little noise), 1 from `ramp` above it — dark gunmetal stays solid,
 * only the black backdrop and the anti-aliased rim fade.
 */
export function cutoutAlpha(max: number, floor: number, ramp = CUTOUT_RAMP): number {
  const lo = floor + 3;
  const a = (max - lo) / ramp;
  return a <= 0 ? 0 : a >= 1 ? 1 : a;
}

/**
 * Colour gain for a partly transparent rim pixel: the rim was mixed with black, so
 * without the gain it shows a dark fringe on light backgrounds.
 */
export function cutoutGain(max: number, floor: number, ramp = CUTOUT_RAMP): number {
  const full = floor + 3 + ramp;
  return max > 0 && max < full ? Math.min(4, full / max) : 1;
}
