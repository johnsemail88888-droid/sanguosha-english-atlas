// Shared state + helpers used by the region builders while generating a map.
import type { MapProp, PropType } from '../../core/map';
import { Rng } from '../../core/rng';
import { dcos, dsin, HALF_PI, PI } from './noise';
import { stairStepCount, STAIR_MAX_RISE } from './props';
import { MAP_HALF, MAP_SIZE, Terrain } from './terrain';

/** Yaw whose front (local -Z) faces the given world direction. */
export const ROT_FACE_NORTH = 0; // front -> -Z
export const ROT_FACE_SOUTH = PI; // front -> +Z
export const ROT_FACE_WEST = HALF_PI; // front -> -X
export const ROT_FACE_EAST = -HALF_PI; // front -> +X

export const STAIR_RUN = 0.5; // horizontal run per step used by generated flights

const OCC_RES = 1; // occupancy grid resolution (m)
const OCC_N = MAP_SIZE / OCC_RES;

/** Occupancy values. */
export const OCC_FREE = 0;
export const OCC_SOLID = 1; // structure footprint (+margin)
export const OCC_CLEAR = 2; // keep clear (roads, plazas, spawn clearings) — no scatter

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class MapBuilder {
  readonly props: MapProp[] = [];
  readonly occ = new Uint8Array(OCC_N * OCC_N);

  constructor(
    readonly terrain: Terrain,
    readonly rng: Rng,
  ) {}

  ground(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /**
   * [min, max] terrain height under a rotated footprint, sampled on a grid of
   * at most 2 m spacing (corners and edges included).
   */
  groundRange(x: number, z: number, sx: number, sz: number, rot: number): [number, number] {
    const c = dcos(rot);
    const s = dsin(rot);
    const nx = Math.max(1, Math.ceil(sx / 2));
    const nz = Math.max(1, Math.ceil(sz / 2));
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j <= nz; j++) {
      const lz = -sz / 2 + (sz * j) / nz;
      for (let i = 0; i <= nx; i++) {
        const lx = -sx / 2 + (sx * i) / nx;
        const h = this.ground(x + lx * c + lz * s, z - lx * s + lz * c);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return [lo, hi];
  }

  /** Lowest terrain height under a rotated footprint. */
  groundMin(x: number, z: number, sx: number, sz: number, rot: number): number {
    return this.groundRange(x, z, sx, sz, rot)[0];
  }

  /** Highest terrain height under a rotated footprint. */
  groundMax(x: number, z: number, sx: number, sz: number, rot: number): number {
    return this.groundRange(x, z, sx, sz, rot)[1];
  }

  /**
   * True if a box-shaped prop of height sy sits acceptably on the terrain at
   * this spot: the ground under its footprint varies by at most maxFrac·sy
   * (props take y = lowest ground, so the uphill end is buried by the relief).
   */
  fitsGround(x: number, z: number, sx: number, sy: number, sz: number, rot: number, maxFrac = 0.4): boolean {
    const [lo, hi] = this.groundRange(x, z, sx, sz, rot);
    return hi - lo <= maxFrac * sy;
  }

  /** Add a prop and mark its footprint (+margin) as solid in the occupancy grid. */
  add(p: Omit<MapProp, 'variant'> & { variant?: number }, margin = 1): MapProp {
    const prop: MapProp = { variant: 0, ...p };
    this.props.push(prop);
    if (margin >= 0) this.markObb(prop.x, prop.z, prop.sx / 2 + margin, prop.sz / 2 + margin, prop.rot, OCC_SOLID);
    return prop;
  }

  /** Prop placed on the terrain (y = lowest ground under its footprint, minus a small embed). */
  place(type: PropType, x: number, z: number, rot: number, sx: number, sy: number, sz: number, variant = 0, color?: string, margin = 1): MapProp {
    const y = this.groundMin(x, z, sx, sz, rot) - 0.05;
    const p: Omit<MapProp, 'variant'> & { variant?: number } = { type, x, y, z, rot, sx, sy, sz, variant };
    if (color) p.color = color;
    return this.add(p, margin);
  }

  /**
   * Straight flight of stairs. (x, z) is the footprint centre, `rot` the climbing
   * direction's yaw (front), `base` the bottom height, `rise` the total rise.
   * Run = steps * STAIR_RUN unless `run` given.
   */
  stairs(x: number, z: number, rot: number, width: number, base: number, rise: number, variant = 0, run?: number): MapProp {
    const n = stairStepCount(rise);
    const sz = run ?? n * STAIR_RUN;
    if (rise / n > STAIR_MAX_RISE + 1e-9) throw new Error('stair rise too steep');
    return this.add({ type: 'stairs', x, y: base, z, rot, sx: width, sy: rise, sz, variant }, 0.6);
  }

  markObb(x: number, z: number, hx: number, hz: number, rot: number, v: number): void {
    const c = dcos(rot);
    const s = dsin(rot);
    const ex = Math.abs(hx * c) + Math.abs(hz * s);
    const ez = Math.abs(hx * s) + Math.abs(hz * c);
    const i0 = Math.max(0, Math.floor((x - ex + MAP_HALF) / OCC_RES));
    const i1 = Math.min(OCC_N - 1, Math.floor((x + ex + MAP_HALF) / OCC_RES));
    const j0 = Math.max(0, Math.floor((z - ez + MAP_HALF) / OCC_RES));
    const j1 = Math.min(OCC_N - 1, Math.floor((z + ez + MAP_HALF) / OCC_RES));
    for (let j = j0; j <= j1; j++) {
      const wz = -MAP_HALF + (j + 0.5) * OCC_RES - z;
      for (let i = i0; i <= i1; i++) {
        const wx = -MAP_HALF + (i + 0.5) * OCC_RES - x;
        const lx = wx * c - wz * s;
        const lz = wx * s + wz * c;
        if (lx >= -hx && lx <= hx && lz >= -hz && lz <= hz) {
          const k = j * OCC_N + i;
          if (v === OCC_SOLID || this.occ[k] === OCC_FREE) this.occ[k] = v;
        }
      }
    }
  }

  markRect(r: Rect, v = OCC_CLEAR): void {
    this.markObb((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, (r.x1 - r.x0) / 2, (r.z1 - r.z0) / 2, 0, v);
  }

  markCircle(x: number, z: number, r: number, v = OCC_CLEAR): void {
    const i0 = Math.max(0, Math.floor((x - r + MAP_HALF) / OCC_RES));
    const i1 = Math.min(OCC_N - 1, Math.floor((x + r + MAP_HALF) / OCC_RES));
    const j0 = Math.max(0, Math.floor((z - r + MAP_HALF) / OCC_RES));
    const j1 = Math.min(OCC_N - 1, Math.floor((z + r + MAP_HALF) / OCC_RES));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const dx = -MAP_HALF + (i + 0.5) * OCC_RES - x;
        const dz = -MAP_HALF + (j + 0.5) * OCC_RES - z;
        if (dx * dx + dz * dz <= r * r) {
          const k = j * OCC_N + i;
          if (this.occ[k] === OCC_FREE) this.occ[k] = v;
        }
      }
  }

  /** Keep a corridor clear along a polyline. */
  markRoad(pts: { x: number; z: number }[], width: number): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const n = Math.max(1, Math.ceil(len / (width / 3)));
      for (let k = 0; k <= n; k++) this.markCircle(a.x + (dx * k) / n, a.z + (dz * k) / n, width / 2);
    }
  }

  occAt(x: number, z: number): number {
    const i = Math.floor((x + MAP_HALF) / OCC_RES);
    const j = Math.floor((z + MAP_HALF) / OCC_RES);
    if (i < 0 || j < 0 || i >= OCC_N || j >= OCC_N) return OCC_SOLID;
    return this.occ[j * OCC_N + i];
  }

  /** True if the disc (x, z, r + margin) is entirely free in the occupancy grid. */
  isFree(x: number, z: number, r: number, margin = 0.5): boolean {
    const R = r + margin;
    const i0 = Math.floor((x - R + MAP_HALF) / OCC_RES);
    const i1 = Math.floor((x + R + MAP_HALF) / OCC_RES);
    const j0 = Math.floor((z - R + MAP_HALF) / OCC_RES);
    const j1 = Math.floor((z + R + MAP_HALF) / OCC_RES);
    if (i0 < 0 || j0 < 0 || i1 >= OCC_N || j1 >= OCC_N) return false;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const dx = -MAP_HALF + (i + 0.5) * OCC_RES - x;
        const dz = -MAP_HALF + (j + 0.5) * OCC_RES - z;
        if (dx * dx + dz * dz <= (r + margin) * (r + margin) && this.occ[j * OCC_N + i] !== OCC_FREE) return false;
      }
    return true;
  }

  /** True if no SOLID cell lies in the disc (roads/clear areas allowed). */
  isUnbuilt(x: number, z: number, r: number): boolean {
    const i0 = Math.floor((x - r + MAP_HALF) / OCC_RES);
    const i1 = Math.floor((x + r + MAP_HALF) / OCC_RES);
    const j0 = Math.floor((z - r + MAP_HALF) / OCC_RES);
    const j1 = Math.floor((z + r + MAP_HALF) / OCC_RES);
    if (i0 < 0 || j0 < 0 || i1 >= OCC_N || j1 >= OCC_N) return false;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const dx = -MAP_HALF + (i + 0.5) * OCC_RES - x;
        const dz = -MAP_HALF + (j + 0.5) * OCC_RES - z;
        if (dx * dx + dz * dz <= (r + 0.5) * (r + 0.5) && this.occ[j * OCC_N + i] === OCC_SOLID) return false;
      }
    return true;
  }

  /** Terrain slope magnitude (rise/run) at a point. */
  slope(x: number, z: number): number {
    const gx = (this.ground(x + 1, z) - this.ground(x - 1, z)) / 2;
    const gz = (this.ground(x, z + 1) - this.ground(x, z - 1)) / 2;
    return Math.sqrt(gx * gx + gz * gz);
  }
}

/** Rotations facing each axis direction, for convenience. */
export function rotFacing(dx: number, dz: number): number {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? ROT_FACE_EAST : ROT_FACE_WEST;
  return dz > 0 ? ROT_FACE_SOUTH : ROT_FACE_NORTH;
}

/** True if two axis-aligned rects (inflated by gap) overlap. */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x0 - gap < b.x1 && b.x0 - gap < a.x1 && a.z0 - gap < b.z1 && b.z0 - gap < a.z1;
}

/** World AABB of an axis-rotated (multiple of 90°) footprint. */
export function footprintRect(x: number, z: number, sx: number, sz: number, rot: number): Rect {
  const c = Math.abs(dcos(rot));
  const s = Math.abs(dsin(rot));
  const ex = (sx * c + sz * s) / 2;
  const ez = (sx * s + sz * c) / 2;
  return { x0: x - ex, z0: z - ez, x1: x + ex, z1: z + ez };
}
