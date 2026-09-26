// Static collider spatial index: flat typed arrays + uniform XZ bucket grid.
// Used by the nav-grid builder, map validation and (optionally) by sim/AI for
// cheap clearance / surface / raycast queries against MapData.colliders.
// Deterministic: only + - * / sqrt and dsin/dcos (see noise.ts).
import type { Collider, MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { dcos, dsin } from './noise';

/** ColliderIndex.kind values. */
export const COLLIDER_BOX = 0;
export const COLLIDER_CYL = 1;
const KIND_BOX = COLLIDER_BOX;
const KIND_CYL = COLLIDER_CYL;
/**
 * Containment tolerance for "is this point on that box top". Generated geometry
 * puts step edges exactly on nav cell centres; rotations by exact multiples of
 * 90° go through dsin/dcos (~1e-11 error), so exact tests would flicker.
 */
export const CONTAIN_EPS = 1e-4;

export interface ColliderIndexOptions {
  /** bucket edge length (m) */
  bucket?: number;
  /** colliders are inserted into every bucket their AABB (+pad) touches, so point
   *  queries with radius <= pad only need to visit a single bucket */
  pad?: number;
}

export class ColliderIndex {
  readonly count: number;
  readonly half: number;
  readonly bucket: number;
  readonly pad: number;
  readonly nb: number; // buckets per side
  // per collider (box: centre, half extents, rotation cos/sin; cyl: centre, r in hx)
  readonly kind: Uint8Array;
  readonly cx: Float64Array;
  readonly cz: Float64Array;
  readonly y0: Float64Array;
  readonly y1: Float64Array;
  readonly hx: Float64Array;
  readonly hz: Float64Array;
  readonly cs: Float64Array;
  readonly sn: Float64Array;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly stamp: Uint32Array;
  private gen = 0;

  constructor(colliders: readonly Collider[], worldSize: number, opts: ColliderIndexOptions = {}) {
    const n = colliders.length;
    this.count = n;
    this.half = worldSize / 2;
    this.bucket = opts.bucket ?? 2;
    this.pad = opts.pad ?? 0.6;
    this.nb = Math.ceil(worldSize / this.bucket);
    this.kind = new Uint8Array(n);
    this.cx = new Float64Array(n);
    this.cz = new Float64Array(n);
    this.y0 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.hx = new Float64Array(n);
    this.hz = new Float64Array(n);
    this.cs = new Float64Array(n);
    this.sn = new Float64Array(n);
    this.stamp = new Uint32Array(n);
    const ax0 = new Float64Array(n);
    const ax1 = new Float64Array(n);
    const az0 = new Float64Array(n);
    const az1 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = colliders[i];
      if (c.kind === 'box') {
        const cs = dcos(c.rot);
        const sn = dsin(c.rot);
        this.kind[i] = KIND_BOX;
        this.cx[i] = c.cx;
        this.cz[i] = c.cz;
        this.y0[i] = c.cy - c.hy;
        this.y1[i] = c.cy + c.hy;
        this.hx[i] = c.hx;
        this.hz[i] = c.hz;
        this.cs[i] = cs;
        this.sn[i] = sn;
        const ex = Math.abs(c.hx * cs) + Math.abs(c.hz * sn);
        const ez = Math.abs(c.hx * sn) + Math.abs(c.hz * cs);
        ax0[i] = c.cx - ex;
        ax1[i] = c.cx + ex;
        az0[i] = c.cz - ez;
        az1[i] = c.cz + ez;
      } else {
        this.kind[i] = KIND_CYL;
        this.cx[i] = c.x;
        this.cz[i] = c.z;
        this.y0[i] = c.y0;
        this.y1[i] = c.y1;
        this.hx[i] = c.r;
        this.hz[i] = c.r;
        this.cs[i] = 1;
        ax0[i] = c.x - c.r;
        ax1[i] = c.x + c.r;
        az0[i] = c.z - c.r;
        az1[i] = c.z + c.r;
      }
    }
    // counting sort into buckets
    const nb = this.nb;
    const counts = new Int32Array(nb * nb + 1);
    const range = (i: number): [number, number, number, number] => [
      this.bi(ax0[i] - this.pad),
      this.bi(ax1[i] + this.pad),
      this.bi(az0[i] - this.pad),
      this.bi(az1[i] + this.pad),
    ];
    for (let i = 0; i < n; i++) {
      const [bx0, bx1, bz0, bz1] = range(i);
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) counts[bz * nb + bx + 1]++;
    }
    for (let b = 0; b < nb * nb; b++) counts[b + 1] += counts[b];
    this.start = counts.slice();
    const fill = counts.slice();
    this.items = new Int32Array(counts[nb * nb]);
    for (let i = 0; i < n; i++) {
      const [bx0, bx1, bz0, bz1] = range(i);
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) this.items[fill[bz * nb + bx]++] = i;
    }
  }

  static fromMap(map: MapData, opts?: ColliderIndexOptions): ColliderIndex {
    return new ColliderIndex(map.colliders, map.size, opts);
  }

  private bi(v: number): number {
    const b = Math.floor((v + this.half) / this.bucket);
    return b < 0 ? 0 : b >= this.nb ? this.nb - 1 : b;
  }

  private bucketOf(x: number, z: number): number {
    return this.bi(z) * this.nb + this.bi(x);
  }

  /** Horizontal distance from (x, z) to collider i's footprint (0 if inside). */
  footprintDist(i: number, x: number, z: number): number {
    const dx = x - this.cx[i];
    const dz = z - this.cz[i];
    if (this.kind[i] === KIND_CYL) {
      const d = Math.sqrt(dx * dx + dz * dz) - this.hx[i];
      return d > 0 ? d : 0;
    }
    const lx = dx * this.cs[i] - dz * this.sn[i];
    const lz = dx * this.sn[i] + dz * this.cs[i];
    const ox = Math.abs(lx) - this.hx[i];
    const oz = Math.abs(lz) - this.hz[i];
    const px = ox > 0 ? ox : 0;
    const pz = oz > 0 ? oz : 0;
    return Math.sqrt(px * px + pz * pz);
  }

  /**
   * Highest walkable surface at (x, z) whose height is <= maxY: the terrain
   * height `ground` or the top of a box containing the point. Returns
   * -Infinity if nothing qualifies. `outIsBox[0]` is set to 1 when the result is
   * a box top.
   */
  surfaceBelow(x: number, z: number, maxY: number, ground: number, outIsBox?: Uint8Array): number {
    let best = ground <= maxY ? ground : -Infinity;
    let isBox = 0;
    const b = this.bucketOf(x, z);
    for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
      const i = this.items[k];
      if (this.kind[i] !== KIND_BOX) continue;
      const top = this.y1[i];
      if (top > maxY || top <= best) continue;
      const dx = x - this.cx[i];
      const dz = z - this.cz[i];
      const lx = dx * this.cs[i] - dz * this.sn[i];
      const ex = this.hx[i] + CONTAIN_EPS;
      if (lx > ex || lx < -ex) continue;
      const lz = dx * this.sn[i] + dz * this.cs[i];
      const ez = this.hz[i] + CONTAIN_EPS;
      if (lz > ez || lz < -ez) continue;
      if (top > ground + 0.02) {
        best = top;
        isBox = 1;
      }
    }
    if (outIsBox) outIsBox[0] = isBox;
    return best;
  }

  /** Box tops containing (x, z) that are above `ground` (unsorted). */
  topsAt(x: number, z: number, ground: number, out: number[]): number[] {
    out.length = 0;
    const b = this.bucketOf(x, z);
    for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
      const i = this.items[k];
      if (this.kind[i] !== KIND_BOX) continue;
      const top = this.y1[i];
      if (top <= ground + 0.02) continue;
      const dx = x - this.cx[i];
      const dz = z - this.cz[i];
      const lx = dx * this.cs[i] - dz * this.sn[i];
      const ex = this.hx[i] + CONTAIN_EPS;
      if (lx > ex || lx < -ex) continue;
      const lz = dx * this.sn[i] + dz * this.cs[i];
      const ez = this.hz[i] + CONTAIN_EPS;
      if (lz > ez || lz < -ez) continue;
      out.push(top);
    }
    return out;
  }

  /** True if any collider intersects the vertical cylinder (x, z, r) over [yLo, yHi]. r <= pad. */
  blocked(x: number, z: number, yLo: number, yHi: number, r: number): boolean {
    const b = this.bucketOf(x, z);
    for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
      const i = this.items[k];
      if (this.y1[i] <= yLo || this.y0[i] >= yHi) continue;
      if (this.footprintDist(i, x, z) < r) return true;
    }
    return false;
  }

  /**
   * Distance from (x, z) to the nearest collider overlapping [yLo, yHi], searching
   * up to maxR metres. Returns maxR if none is closer.
   */
  clearance(x: number, z: number, yLo: number, yHi: number, maxR: number): number {
    let best = maxR;
    const g = ++this.gen;
    const bx0 = this.bi(x - maxR);
    const bx1 = this.bi(x + maxR);
    const bz0 = this.bi(z - maxR);
    const bz1 = this.bi(z + maxR);
    for (let bz = bz0; bz <= bz1; bz++)
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = bz * this.nb + bx;
        for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
          const i = this.items[k];
          if (this.stamp[i] === g) continue;
          this.stamp[i] = g;
          if (this.y1[i] <= yLo || this.y0[i] >= yHi) continue;
          const d = this.footprintDist(i, x, z);
          if (d < best) best = d;
        }
      }
    return best;
  }

  /** True when no collider (inflated by `pad`) touches any bucket overlapping the AABB. */
  regionEmpty(x0: number, z0: number, x1: number, z1: number): boolean {
    const bx0 = this.bi(x0);
    const bx1 = this.bi(x1);
    const bz0 = this.bi(z0);
    const bz1 = this.bi(z1);
    for (let bz = bz0; bz <= bz1; bz++)
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = bz * this.nb + bx;
        if (this.start[b + 1] > this.start[b]) return false;
      }
    return true;
  }

  /**
   * Colliders whose footprint lies within r (2D) of segment a-b, written to
   * `out`; returns the count (capped at out.length).
   */
  gatherSegment(ax: number, az: number, bx: number, bz: number, r: number, out: Int32Array): number {
    const g = ++this.gen;
    let n = 0;
    const bx0 = this.bi(Math.min(ax, bx) - r);
    const bx1 = this.bi(Math.max(ax, bx) + r);
    const bz0 = this.bi(Math.min(az, bz) - r);
    const bz1 = this.bi(Math.max(az, bz) + r);
    for (let qz = bz0; qz <= bz1; qz++)
      for (let qx = bx0; qx <= bx1; qx++) {
        const b = qz * this.nb + qx;
        for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
          const i = this.items[k];
          if (this.stamp[i] === g) continue;
          this.stamp[i] = g;
          if (this.segmentDist(i, ax, az, bx, bz) < r && n < out.length) out[n++] = i;
        }
      }
    return n;
  }

  /** 2D distance between segment a-b and collider i's footprint (0 if they touch). */
  segmentDist(i: number, ax: number, az: number, bx: number, bz: number): number {
    if (this.kind[i] === KIND_CYL) {
      const d = pointSegDist(this.cx[i], this.cz[i], ax, az, bx, bz) - this.hx[i];
      return d > 0 ? d : 0;
    }
    // into box-local space
    const c = this.cs[i];
    const s = this.sn[i];
    const dax = ax - this.cx[i];
    const daz = az - this.cz[i];
    const dbx = bx - this.cx[i];
    const dbz = bz - this.cz[i];
    const lax = dax * c - daz * s;
    const laz = dax * s + daz * c;
    const lbx = dbx * c - dbz * s;
    const lbz = dbx * s + dbz * c;
    const hx = this.hx[i];
    const hz = this.hz[i];
    // Liang–Barsky clip: does the segment cross the rect?
    let t0 = 0;
    let t1 = 1;
    const ddx = lbx - lax;
    const ddz = lbz - laz;
    let hit = true;
    // four half-planes: p·t <= q
    for (let e = 0; e < 4 && hit; e++) {
      const p = e === 0 ? -ddx : e === 1 ? ddx : e === 2 ? -ddz : ddz;
      const q = e === 0 ? lax + hx : e === 1 ? hx - lax : e === 2 ? laz + hz : hz - laz;
      if (p === 0) {
        if (q < 0) hit = false;
      } else {
        const t = q / p;
        if (p < 0) {
          if (t > t1) hit = false;
          else if (t > t0) t0 = t;
        } else if (t < t0) hit = false;
        else if (t < t1) t1 = t;
      }
    }
    if (hit) return 0;
    let best = Math.min(rectPointDist(lax, laz, hx, hz), rectPointDist(lbx, lbz, hx, hz));
    let d = pointSegDist(-hx, -hz, lax, laz, lbx, lbz);
    if (d < best) best = d;
    d = pointSegDist(hx, -hz, lax, laz, lbx, lbz);
    if (d < best) best = d;
    d = pointSegDist(hx, hz, lax, laz, lbx, lbz);
    if (d < best) best = d;
    d = pointSegDist(-hx, hz, lax, laz, lbx, lbz);
    if (d < best) best = d;
    return best;
  }

  /** Indices of colliders whose (padded) bucket contains (x, z). */
  near(x: number, z: number, out: number[]): number[] {
    out.length = 0;
    const b = this.bucketOf(x, z);
    for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) out.push(this.items[k]);
    return out;
  }

  /**
   * Ray vs colliders (not terrain). dir need not be normalised; returns the hit
   * distance along dir in units of |dir|·t (t in [0, maxT]) or Infinity.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    const g = ++this.gen;
    let best = maxT;
    // walk buckets along the ray (2D DDA)
    const B = this.bucket;
    let bx = this.bi(ox);
    let bz = this.bi(oz);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const nextBoundX = (bx + (stepX > 0 ? 1 : 0)) * B - this.half;
    const nextBoundZ = (bz + (stepZ > 0 ? 1 : 0)) * B - this.half;
    let tMaxX = stepX !== 0 ? (nextBoundX - ox) / dx : Infinity;
    let tMaxZ = stepZ !== 0 ? (nextBoundZ - oz) / dz : Infinity;
    const tDX = stepX !== 0 ? B / Math.abs(dx) : Infinity;
    const tDZ = stepZ !== 0 ? B / Math.abs(dz) : Infinity;
    let tEnter = 0;
    for (let guard = 0; guard < 4 * this.nb; guard++) {
      const b = bz * this.nb + bx;
      for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
        const i = this.items[k];
        if (this.stamp[i] === g) continue;
        this.stamp[i] = g;
        const t = this.rayCollider(i, ox, oy, oz, dx, dy, dz, best);
        if (t < best) best = t;
      }
      const tExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tExit >= best) break;
      tEnter = tExit;
      if (tMaxX < tMaxZ) {
        bx += stepX;
        tMaxX += tDX;
      } else {
        bz += stepZ;
        tMaxZ += tDZ;
      }
      if (bx < 0 || bz < 0 || bx >= this.nb || bz >= this.nb || tEnter > maxT) break;
    }
    return best < maxT ? best : Infinity;
  }

  private rayCollider(i: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let t0 = 0;
    let t1 = maxT;
    // vertical slab
    if (dy === 0) {
      if (oy < this.y0[i] || oy > this.y1[i]) return Infinity;
    } else {
      let a = (this.y0[i] - oy) / dy;
      let b = (this.y1[i] - oy) / dy;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return Infinity;
    }
    const rx = ox - this.cx[i];
    const rz = oz - this.cz[i];
    if (this.kind[i] === KIND_CYL) {
      const r = this.hx[i];
      const A = dx * dx + dz * dz;
      const Bq = rx * dx + rz * dz;
      const C = rx * rx + rz * rz - r * r;
      if (A < 1e-12) return C <= 0 ? t0 : Infinity;
      const disc = Bq * Bq - A * C;
      if (disc < 0) return Infinity;
      const sq = Math.sqrt(disc);
      const a = (-Bq - sq) / A;
      const b = (-Bq + sq) / A;
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      return t0 <= t1 ? t0 : Infinity;
    }
    const cs = this.cs[i];
    const sn = this.sn[i];
    const lox = rx * cs - rz * sn;
    const loz = rx * sn + rz * cs;
    const ldx = dx * cs - dz * sn;
    const ldz = dx * sn + dz * cs;
    const hx = this.hx[i];
    const hz = this.hz[i];
    if (ldx === 0) {
      if (lox < -hx || lox > hx) return Infinity;
    } else {
      let a = (-hx - lox) / ldx;
      let b = (hx - lox) / ldx;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return Infinity;
    }
    if (ldz === 0) {
      if (loz < -hz || loz > hz) return Infinity;
    } else {
      let a = (-hz - loz) / ldz;
      let b = (hz - loz) / ldz;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return Infinity;
    }
    return t0;
  }
}

function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return Math.sqrt(ex * ex + ez * ez);
}

function rectPointDist(x: number, z: number, hx: number, hz: number): number {
  const ox = Math.abs(x) - hx;
  const oz = Math.abs(z) - hz;
  const px = ox > 0 ? ox : 0;
  const pz = oz > 0 ? oz : 0;
  return Math.sqrt(px * px + pz * pz);
}

/**
 * Line of sight between two points against colliders and terrain (terrain is
 * sampled every `step` metres). Handy for AI + validation; sim may have its own.
 */
export function segmentClear(map: MapData, index: ColliderIndex, ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 1): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  if (index.raycast(ax, ay, az, dx, dy, dz, 1) !== Infinity) return false;
  const len = Math.sqrt(dx * dx + dz * dz);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (terrainHeight(map, ax + dx * t, az + dz * t) > ay + dy * t) return false;
  }
  return true;
}
