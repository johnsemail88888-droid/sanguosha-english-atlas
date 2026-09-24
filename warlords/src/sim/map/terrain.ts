// Heightfield synthesis for 虎牢·赤壁: rolling fBm hills, the 虎牢关 ridges in the
// north, the 赤壁 river valley in the south third, flattened pads under
// structures and an impassable mountain rim. Deterministic (noise.ts math only).
import { Rng } from '../../core/rng';
import { Noise2, dsin, len2, lerpN, smooth01, smoothstep } from './noise';

export const MAP_SIZE = 320;
export const MAP_RES = 160; // 2 m cells
export const MAP_HALF = MAP_SIZE / 2;
export const WATER_LEVEL = 2;
/** Everything beyond this Chebyshev-ish radius is the mountain rim. */
export const RIM_START = 143;
/** Invisible boundary walls stand here. */
export const BOUNDARY = 151;

/** Centre-line of the 虎牢关 pass (x) and the fortress wall line (z). */
export const PASS_X = 0;
export const FORTRESS_Z = -100;

export interface RiverSpec {
  baseZ: number;
  a1: number;
  f1: number;
  p1: number;
  a2: number;
  f2: number;
  p2: number;
  hw0: number;
  hwA: number;
  hwF: number;
  hwP: number;
  /** max depth below the water surface at the centre-line */
  depth: number;
  /** width of the sloped valley flank beyond the water's edge */
  bank: number;
}

export function makeRiver(rng: Rng): RiverSpec {
  return {
    baseZ: 92,
    a1: 5.5,
    f1: 0.021,
    p1: rng.range(0, 6.283),
    a2: 2.2,
    f2: 0.055,
    p2: rng.range(0, 6.283),
    hw0: 11.5,
    hwA: 1.5,
    hwF: 0.04,
    hwP: rng.range(0, 6.283),
    depth: 1.15,
    bank: 24,
  };
}

export const riverCenterZ = (r: RiverSpec, x: number): number =>
  r.baseZ + r.a1 * dsin(x * r.f1 + r.p1) + r.a2 * dsin(x * r.f2 + r.p2);

export const riverHalfWidth = (r: RiverSpec, x: number): number => r.hw0 + r.hwA * dsin(x * r.hwF + r.hwP);

export type PadShape = { kind: 'rect'; x: number; z: number; hx: number; hz: number } | { kind: 'circle'; x: number; z: number; r: number };

export interface Pad {
  shape: PadShape;
  /** width of the smooth transition outside the shape (m) */
  blend: number;
  /** absolute target height; if undefined the mean height of the inner half of the shape is used */
  height?: number;
  /**
   * Linear ramp instead of a flat target: height h0 at coordinate `from` along
   * `axis`, h1 at `to` (clamped beyond). h1 = 'natural' samples the current
   * terrain at the shape centre-line at `to`. Used for approach roads.
   */
  ramp?: { axis: 'x' | 'z'; from: number; to: number; h0: number; h1: number | 'natural' };
  /** clamp for the automatic height */
  min?: number;
  max?: number;
}

/** Distance from (x,z) to the outside of the shape (0 inside). */
function padDist(s: PadShape, x: number, z: number): number {
  if (s.kind === 'circle') {
    const d = len2(x - s.x, z - s.z) - s.r;
    return d > 0 ? d : 0;
  }
  const ox = Math.abs(x - s.x) - s.hx;
  const oz = Math.abs(z - s.z) - s.hz;
  const px = ox > 0 ? ox : 0;
  const pz = oz > 0 ? oz : 0;
  return len2(px, pz);
}

export class Terrain {
  readonly n = MAP_RES + 1;
  readonly cell = MAP_SIZE / MAP_RES;
  readonly h: Float64Array;
  readonly noise: Noise2;
  readonly river: RiverSpec;

  constructor(seed: number, river: RiverSpec) {
    this.noise = new Noise2(seed);
    this.river = river;
    this.h = new Float64Array(this.n * this.n);
    for (let row = 0; row < this.n; row++) {
      const z = -MAP_HALF + row * this.cell;
      for (let col = 0; col < this.n; col++) {
        const x = -MAP_HALF + col * this.cell;
        this.h[row * this.n + col] = this.natural(x, z);
      }
    }
  }

  /** Rolling hills + ridges + river valley (before pads and rim). */
  private natural(x: number, z: number): number {
    const nz = this.noise;
    let h = 9 + 6.5 * nz.fbm(x / 95, z / 95, 4) + 1.7 * nz.fbm(x / 27 + 50, z / 27 - 20, 3);
    // 长坂坡: hillier west
    const wm = smooth01(1 - len2(x + 108, z - 8) / 72);
    h += wm * (2.5 + 6 * nz.ridged(x / 42, z / 42, 3));
    // 北邙山: rolling tomb hills in the north-west
    const bm = smooth01(1 - len2(x + 100, z + 104) / 40);
    h += bm * (2 + 3 * nz.fbm(x / 20, z / 20, 2));
    // keep dry land well above the water outside the river
    if (h < 5) h = 5 - (5 - h) * 0.35;

    // 虎牢关 ridges: two long ridges either side of the pass, steep inner cliffs
    const tz = smoothstep(-56, -80, z) * smoothstep(-136, -120, z);
    if (tz > 0) {
      const wp = 19 + 0.22 * Math.abs(z - FORTRESS_Z);
      const d = Math.abs(x - PASS_X);
      const across = smoothstep(wp, wp + 9, d) * (1 - smoothstep(wp + 20, wp + 60, d));
      h += (17 + 4 * nz.fbm(x / 30, z / 30, 3)) * across * tz;
    }

    // 赤壁 river valley
    const r = this.river;
    const hw = riverHalfWidth(r, x);
    const dz = Math.abs(z - riverCenterZ(r, x));
    if (dz <= hw) {
      const u = dz / hw;
      h = WATER_LEVEL - 0.15 - r.depth * (1 - u * u);
    } else {
      const s = smooth01((dz - hw) / r.bank);
      h = lerpN(WATER_LEVEL - 0.15, h, s);
    }
    return h;
  }

  /** Bilinear height (same formula as core terrainHeight). */
  heightAt(x: number, z: number): number {
    const fx = ((x + MAP_HALF) / MAP_SIZE) * MAP_RES;
    const fz = ((z + MAP_HALF) / MAP_SIZE) * MAP_RES;
    const cx = fx < 0 ? 0 : fx > MAP_RES - 1e-6 ? MAP_RES - 1e-6 : fx;
    const cz = fz < 0 ? 0 : fz > MAP_RES - 1e-6 ? MAP_RES - 1e-6 : fz;
    const ix = Math.floor(cx);
    const iz = Math.floor(cz);
    const tx = cx - ix;
    const tz = cz - iz;
    const n = this.n;
    const h = this.h;
    const h00 = h[iz * n + ix];
    const h10 = h[iz * n + ix + 1];
    const h01 = h[(iz + 1) * n + ix];
    const h11 = h[(iz + 1) * n + ix + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Mean height over the inner half of a pad shape (vertex samples). */
  meanInside(s: PadShape): number {
    let sum = 0;
    let cnt = 0;
    const ext = s.kind === 'circle' ? s.r : Math.max(s.hx, s.hz);
    const inner: PadShape = s.kind === 'circle' ? { ...s, r: s.r * 0.5 } : { ...s, hx: s.hx * 0.5, hz: s.hz * 0.5 };
    this.forVerts(s.x, s.z, ext, (i, x, z) => {
      if (padDist(inner, x, z) === 0) {
        sum += this.h[i];
        cnt++;
      }
    });
    return cnt > 0 ? sum / cnt : this.heightAt(s.x, s.z);
  }

  private forVerts(cx: number, cz: number, ext: number, fn: (i: number, x: number, z: number) => void): void {
    const c0 = Math.max(0, Math.floor((cx - ext + MAP_HALF) / this.cell));
    const c1 = Math.min(MAP_RES, Math.ceil((cx + ext + MAP_HALF) / this.cell));
    const r0 = Math.max(0, Math.floor((cz - ext + MAP_HALF) / this.cell));
    const r1 = Math.min(MAP_RES, Math.ceil((cz + ext + MAP_HALF) / this.cell));
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) fn(row * this.n + col, -MAP_HALF + col * this.cell, -MAP_HALF + row * this.cell);
  }

  /** Flatten towards a pad height (or ramp) with a smooth skirt. Returns the (start) height used. */
  applyPad(p: Pad): number {
    const s = p.shape;
    let target = p.height ?? (p.ramp ? p.ramp.h0 : this.meanInside(s));
    if (p.min !== undefined && target < p.min) target = p.min;
    if (p.max !== undefined && target > p.max) target = p.max;
    const r = p.ramp;
    let h1 = target;
    if (r) h1 = r.h1 === 'natural' ? (r.axis === 'z' ? this.heightAt(s.x, r.to) : this.heightAt(r.to, s.z)) : r.h1;
    const ext = (s.kind === 'circle' ? s.r : Math.max(s.hx, s.hz)) + p.blend + this.cell;
    this.forVerts(s.x, s.z, ext, (i, x, z) => {
      const d = padDist(s, x, z);
      if (d >= p.blend) return;
      const w = 1 - smooth01(d / p.blend);
      let t = target;
      if (r) {
        const u = ((r.axis === 'z' ? z : x) - r.from) / (r.to - r.from);
        t = lerpN(target, h1, u < 0 ? 0 : u > 1 ? 1 : u);
      }
      this.h[i] = lerpN(this.h[i], t, w);
    });
    return target;
  }

  /** Raise the impassable mountain rim (call last). */
  applyRim(): void {
    const nz = this.noise;
    for (let row = 0; row < this.n; row++) {
      const z = -MAP_HALF + row * this.cell;
      for (let col = 0; col < this.n; col++) {
        const x = -MAP_HALF + col * this.cell;
        const e = rimDistance(x, z);
        if (e <= RIM_START) continue;
        const t = (e - RIM_START) / (MAP_HALF - RIM_START);
        const k = 0.75 + 0.5 * nz.ridged(x / 38, z / 38, 3);
        this.h[row * this.n + col] += t * t * 46 * k + t * 8;
      }
    }
  }

  toFloat32(): Float32Array {
    return Float32Array.from(this.h);
  }
}

/** Rounded-square radius used for the rim (corners are cut). */
export function rimDistance(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const d = 0.62 * (ax + az);
  return Math.max(ax, az, d);
}
