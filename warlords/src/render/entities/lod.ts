// Distance / visibility LODs of the characters (heroes, troops, NPCs). Pure
// decisions, applied by CharacterView every frame:
//   · body: an AI-art (GLB) body beyond LOD_DIST.*Body swaps to its decimated
//     mesh (same skin, a quarter of the triangles — models/glb.ts buildLod);
//   · animation: characters further out skip frames (the skeleton, IK and
//     skinning matrices update every 2nd / 3rd / 4th frame with the
//     accumulated time), characters outside the view at most every 4th — but
//     nothing on screen drops below ANIM_MIN_HZ updates a second, whatever
//     the frame rate.
// Every distance is scaled by the quality tier's lodScale (quality.ts): 极速
// switches earlier, 极致 later. The local hero is always full detail.
import type * as THREE from 'three';

export const LOD_DIST = {
  /** GLB bodies switch to the decimated mesh beyond these (m) */
  heroBody: 35,
  troopBody: 24,
  /** the animation stride grows by one beyond each of these (m): every 2nd, 3rd, 4th frame */
  heroAnim: [35, 90, 200] as readonly number[],
  troopAnim: [25, 55, 110] as readonly number[],
};

/** Relative hysteresis of the body switch (no flicker at the threshold). */
export const LOD_HYSTERESIS = 0.05;
/** Characters outside the view animate at most every this many frames. */
export const OFFSCREEN_STRIDE = 4;
/** On-screen characters are never animated less often than this (updates per second). */
export const ANIM_MIN_HZ = 10;

/** Should a character at `dist` (m) show its far body? `wasFar`: what it showed last frame. */
export function farBody(hero: boolean, dist: number, lodScale: number, wasFar: boolean): boolean {
  const d = (hero ? LOD_DIST.heroBody : LOD_DIST.troopBody) * lodScale;
  if (dist > d * (1 + LOD_HYSTERESIS)) return true;
  if (dist < d * (1 - LOD_HYSTERESIS)) return false;
  return wasFar;
}

/**
 * Animate every n-th frame: 1 near, +1 beyond each LOD_DIST.*Anim step,
 * at least OFFSCREEN_STRIDE off screen; on screen capped so the character
 * still updates ANIM_MIN_HZ times a second at the current frame time `dt` (s).
 */
export function animStride(hero: boolean, dist: number, lodScale: number, onScreen: boolean, dt: number): number {
  let s = 1;
  for (const t of hero ? LOD_DIST.heroAnim : LOD_DIST.troopAnim) if (dist > t * lodScale) s++;
  if (!onScreen) return Math.max(s, OFFSCREEN_STRIDE);
  const cap = dt > 0 ? Math.max(1, Math.floor(1 / (ANIM_MIN_HZ * dt))) : s;
  return Math.min(s, cap);
}

/** Is frame `frame` one of character `id`'s animation frames at this stride? (ids spread the work) */
export function animDue(stride: number, frame: number, id: number): boolean {
  return stride <= 1 || (frame + id) % stride === 0;
}

/**
 * Sphere (x, y, z, r) inside the side planes of a camera frustum (three's
 * plane order: 0–3 the sides, 4 far, 5 near). The far plane is ignored: the
 * renderer stretches it to far heroes after the characters were updated.
 */
export function inViewSides(f: THREE.Frustum, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 4; i++) {
    const p = f.planes[i];
    if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < -r) return false;
  }
  return true;
}
