// Display shape of the impassable mountain rim (render only).
//
// The generator raises the rim with (rim distance)², and its rounded-square
// distance reaches 1.24× the edge value at the map corners: the four corner
// peaks climb to 500–620 m within ~50 m of the boundary — sheer rock pillars
// that tower past the top of the frame on either side of every view, and
// through the fog read as pale columns standing in the sky (UX-18). Nobody can
// get there (the boundary walls stand at rim distance BOUNDARY), so the
// terrain the player SEES beyond the walls is capped by a slope-limited
// envelope: a steep foot like the rim's own cliffs along the edges, then
// ~30–45° flanks with spurs running outward, topping out around 100–150 m in
// the corners, where the skirt carries the range on outwards. Everything the
// player can reach — and the rim just beyond the walls, where pines stand —
// keeps the simulation's heights exactly; the display is never ABOVE the sim
// (camera collision and aim still use the sim heights, which can only be
// higher out there).
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { BOUNDARY, MAP_HALF } from '../../sim/map/terrain';
import { fbm2 } from '../core/noise';

/** Envelope parameters (metres; slope = rise per metre beyond the walls). */
export const RIM_SHAPE = {
  /** headroom over the boundary height where the envelope starts */
  lift: 8,
  /** height of the steep foot and the distance it rises over (1 − e^(−d/L)) */
  foot: 60,
  footLen: 8,
  /** flank slope beyond the foot, ± variation along the rim (spurs and gullies) */
  slope: 0.6,
  slopeVar: 0.5,
  /** soft-cap width: the sim height is kept exactly while it stays this far under the envelope */
  soft: 8,
  /** metres beyond the walls over which the display blends from the sim heights */
  blend: 3,
} as const;

/** The boundary walls' rim distance for this map (the generator's BOUNDARY, scaled to the map size). */
export function rimBoundary(map: Pick<MapData, 'size'>): number {
  return (BOUNDARY * (map.size / 2)) / MAP_HALF;
}

/**
 * Metres beyond the walls (≤ 0 inside the playable area): distance past the
 * octagon |x| ≤ b, |z| ≤ b, |x| + |z| ≤ b / 0.62 (the generator's rounded
 * square: rimDistance = max(|x|, |z|, 0.62 (|x| + |z|))).
 */
export function beyondWalls(x: number, z: number, b: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  return Math.max(ax - b, az - b, (ax + az - b / 0.62) / Math.SQRT2);
}

/** Envelope height at (x, z): Infinity inside the walls. */
export function rimEnvelope(map: MapData, x: number, z: number, b = rimBoundary(map)): number {
  const d = beyondWalls(x, z, b);
  if (d <= 0) return Infinity;
  // the point on the walls' contour straight towards the centre: its height is the base
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const e = Math.max(ax, az, 0.62 * (ax + az));
  const k = b / e;
  const bx = x * k;
  const bz = z * k;
  const base = terrainHeight(map, bx, bz);
  // spurs: the flank slope varies along the rim (noise of the contour point), so
  // ridges run outward with gullies between; a little lumpiness on top
  const n = fbm2(bx * 0.03 + 17.3, bz * 0.03 - 5.1, 3);
  const ridge = 1 - Math.abs(2 * n - 1);
  const slope = RIM_SHAPE.slope + RIM_SHAPE.slopeVar * (ridge - 0.5);
  const lumps = 8 * (fbm2(x * 0.045 - 3.3, z * 0.045 + 8.8, 3) - 0.5);
  return base + RIM_SHAPE.lift + RIM_SHAPE.foot * (1 - Math.exp(-d / RIM_SHAPE.footLen)) + slope * d + lumps * Math.min(1, d / 20);
}

/** Soft cap: identity while h ≤ cap − s, then eases (C¹) toward cap, never above it. */
export function softCap(h: number, cap: number, s: number): number {
  const t = cap - s;
  if (h <= t) return h;
  return t + s * (1 - Math.exp(-(h - t) / s));
}

/** Display heights (same layout as map.heights): the rim beyond the walls reshaped, the rest untouched. */
export function rimDisplayHeights(map: MapData): Float32Array {
  const n = map.res + 1;
  const cell = map.size / map.res;
  const half = map.size / 2;
  const b = rimBoundary(map);
  const out = Float32Array.from(map.heights);
  for (let iz = 0; iz < n; iz++) {
    const z = -half + iz * cell;
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * cell;
      const d = beyondWalls(x, z, b);
      if (d <= 0) continue;
      const k = iz * n + ix;
      const h = map.heights[k];
      const capped = softCap(h, rimEnvelope(map, x, z, b), RIM_SHAPE.soft);
      if (capped >= h) continue;
      const w = Math.min(1, d / RIM_SHAPE.blend);
      out[k] = h + (capped - h) * w * w * (3 - 2 * w);
    }
  }
  return out;
}

const cache = new WeakMap<MapData, MapData>();

/**
 * The map as the renderer draws its ground: a shallow copy with the reshaped
 * rim heights (cached per map). Only for visuals (terrain mesh, skirt, ground
 * splat, grass); gameplay-facing queries (camera collision, aim) keep `map`.
 */
export function displayMap(map: MapData): MapData {
  let d = cache.get(map);
  if (!d) {
    d = { ...map, heights: rimDisplayHeights(map) };
    cache.set(map, d);
  }
  return d;
}
