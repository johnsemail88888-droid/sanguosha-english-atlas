// Cheap ray queries for the renderer (crosshair pick, camera collision,
// nameplate occlusion). Built from MapData.colliders + terrain + water +
// ViewEntities — never from render meshes — so the result matches what the
// simulation collides against. Pure TS (no three.js): unit-testable in node.
import type { Collider, MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { Vec3 } from '../../core/math';
import type { EntityId, ViewEntity } from '../../core/types';
import { VF_DEAD, VF_DOWNED, VF_MOUNTED } from '../../core/types';
import { HERO_BY_ID, TROOP_BY_ID } from '../../data';
import type { TroopTypeDef } from '../../data/types';
import { CHAR_HEIGHT, CHAR_RADIUS } from '../../sim/physics';

export interface PickHit {
  point: Vec3;
  dist: number;
  normal: Vec3;
  entityId?: EntityId;
  /** what was hit */
  what: 'entity' | 'collider' | 'terrain' | 'water';
}

export interface PickOptions {
  entities?: readonly ViewEntity[];
  /** entity ids to ignore (the local hero) */
  ignore?: ReadonlySet<EntityId> | EntityId | null;
  /** ignore hits closer than this distance along the ray */
  minDist?: number;
  /** include the water surface (default true) */
  water?: boolean;
}

/**
 * Hit shape of a pickable view entity, mirroring the simulation's hitbox
 * (sim/combat.ts hitbox + raycastEntities): a vertical body cylinder of radius
 * `r` from the feet to `bodyTop`, plus a head sphere (centre `headY`, radius
 * `headR`; 0 = none). `h` is the total height.
 */
export interface EntityHitShape {
  r: number;
  h: number;
  bodyTop: number;
  headY: number;
  headR: number;
}

/** Collision capsule of a unit type — same rule as sim/troops.ts unitSize (checked by a unit test). */
export function unitSizeOf(visual: Pick<TroopTypeDef['visual'], 'body' | 'mountedOn'> | undefined): { radius: number; height: number } {
  if (visual) {
    if (visual.body === 'huge' || visual.mountedOn === 'elephant') return { radius: 1.3, height: 3.2 };
    if (visual.mountedOn === 'horse') return { radius: 0.6, height: 2.3 };
    if (visual.body === 'heavy') return { radius: 0.45, height: 1.85 };
  }
  return { radius: CHAR_RADIUS, height: CHAR_HEIGHT };
}

/**
 * Hit capsule of a mounted hero (VF_MOUNTED, or HeroVisual.mount: 马超 / 吕布):
 * the horse-cavalry size, which is where the renderer seats the rider
 * (models/mounts.ts SADDLE_HIP). Agreed with SIM-CORE — docs/CONTRACT_CHANGES.md.
 */
export const MOUNTED_HERO_SIZE = { radius: 0.6, height: 2.3 } as const;

/** Is this hero drawn (and hit) on horseback? */
export function heroRides(e: Pick<ViewEntity, 'sub' | 'flags' | 'mount'>): boolean {
  return (e.flags & VF_MOUNTED) !== 0 || !!e.mount || !!HERO_BY_ID[e.sub]?.visual.mount;
}

const TURRET = { radius: 0.6, height: 1.2 };
const CRATE = { radius: 0.7, height: 0.9 };
const AIRDROP = { radius: 1.0, height: 1.2 };

/** sim/combat.ts hitbox(): body cylinder up to height − 1.6·headR, head sphere centred at height − headR. */
function withHead(radius: number, height: number, downed = false): EntityHitShape {
  if (downed) return { r: radius, h: 0.6, bodyTop: 0.6 - 0.2 * 1.6, headY: 0.4, headR: 0.2 };
  const headR = Math.max(0.15, 0.22 * (height / 1.8));
  return { r: radius, h: height, bodyTop: height - headR * 1.6, headY: height - headR, headR };
}

/** Hit shape of a view entity (null = not pickable). */
export function entityShape(e: ViewEntity): EntityHitShape | null {
  if (e.flags & VF_DEAD) return null;
  switch (e.kind) {
    case 'hero': {
      const downed = (e.flags & VF_DOWNED) !== 0;
      const size = !downed && heroRides(e) ? MOUNTED_HERO_SIZE : { radius: CHAR_RADIUS, height: CHAR_HEIGHT };
      return withHead(size.radius, size.height, downed);
    }
    case 'troop':
    case 'npc': {
      const size = unitSizeOf(TROOP_BY_ID[e.sub]?.visual);
      return withHead(size.radius, size.height);
    }
    case 'turret':
      return { r: TURRET.radius, h: TURRET.height, bodyTop: TURRET.height, headY: 0, headR: 0 };
    // not hittable by bullets, but aimTargetId steers F-interact towards them
    case 'crate':
      return { r: CRATE.radius, h: CRATE.height, bodyTop: CRATE.height, headY: 0, headR: 0 };
    case 'airdrop':
      return { r: AIRDROP.radius, h: AIRDROP.height, bodyTop: AIRDROP.height, headY: 0, headR: 0 };
    default:
      return null;
  }
}

/** Ray vs an entity's hit shape standing at (x, y, z); entry distance or null. */
export function rayEntityShape(o: Vec3, d: Vec3, x: number, y: number, z: number, s: EntityHitShape): number | null {
  const body = rayCylinderSpan(o, d, x, z, s.r, y, y + s.bodyTop);
  let t = body ? body.t : null;
  if (s.headR > 0) {
    const th = raySphere(o, d, x, y + s.headY, z, s.headR);
    if (th !== null && (t === null || th < t)) t = th;
  }
  return t;
}

/** Ray vs sphere; entry distance (0 when starting inside) or null. */
function raySphere(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number): number | null {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c <= 0) return 0;
  if (b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  return -b - Math.sqrt(disc);
}

const CELL = 8;

export class PickWorld {
  readonly map: MapData;
  private readonly colliders: Collider[];
  private readonly gridN: number;
  private readonly origin: number;
  private readonly cells: Int32Array[];
  private readonly stamp: Uint32Array;
  private stampId = 1;
  private readonly maxTerrain: number;

  constructor(map: MapData) {
    this.map = map;
    this.colliders = map.colliders.slice();
    this.origin = -map.size / 2 - CELL * 2;
    this.gridN = Math.ceil((map.size + CELL * 4) / CELL);
    const lists: number[][] = Array.from({ length: this.gridN * this.gridN }, () => []);
    this.colliders.forEach((c, i) => {
      const [x0, z0, x1, z1] = colliderAabb(c);
      const i0 = this.cellCoord(x0);
      const i1 = this.cellCoord(x1);
      const j0 = this.cellCoord(z0);
      const j1 = this.cellCoord(z1);
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) lists[j * this.gridN + k].push(i);
    });
    this.cells = lists.map((l) => Int32Array.from(l));
    this.stamp = new Uint32Array(this.colliders.length);
    let mx = -Infinity;
    for (let i = 0; i < map.heights.length; i++) if (map.heights[i] > mx) mx = map.heights[i];
    this.maxTerrain = Number.isFinite(mx) ? mx : 0;
  }

  private cellCoord(v: number): number {
    return Math.max(0, Math.min(this.gridN - 1, Math.floor((v - this.origin) / CELL)));
  }

  /** Nearest hit along origin + dir*t for t in [minDist, maxDist]. dir must be normalised. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, opts: PickOptions = {}): PickHit | null {
    const minDist = opts.minDist ?? 0;
    let best: PickHit | null = null;
    let bestT = maxDist;

    // 1. static colliders via 2D DDA over the grid
    const ct = this.raycastColliders(origin, dir, minDist, bestT);
    if (ct) {
      bestT = ct.t;
      best = { point: at(origin, dir, ct.t), dist: ct.t, normal: ct.n, what: 'collider' };
    }
    // 2. terrain
    const tt = this.raycastTerrain(origin, dir, minDist, bestT);
    if (tt !== null && tt < bestT) {
      bestT = tt;
      const p = at(origin, dir, tt);
      best = { point: p, dist: tt, normal: this.terrainNormal(p.x, p.z), what: 'terrain' };
    }
    // 3. water plane
    if (opts.water !== false && dir.y < -1e-6 && origin.y > this.map.waterLevel) {
      const tw = (this.map.waterLevel - origin.y) / dir.y;
      if (tw >= minDist && tw < bestT) {
        const p = at(origin, dir, tw);
        if (terrainHeight(this.map, p.x, p.z) < this.map.waterLevel) {
          bestT = tw;
          best = { point: p, dist: tw, normal: { x: 0, y: 1, z: 0 }, what: 'water' };
        }
      }
    }
    // 4. entities
    if (opts.entities) {
      const ign = opts.ignore;
      for (const e of opts.entities) {
        if (ign !== undefined && ign !== null) {
          if (typeof ign === 'number' ? e.id === ign : ign.has(e.id)) continue;
        }
        const s = entityShape(e);
        if (!s) continue;
        const t = rayEntityShape(origin, dir, e.x, e.y, e.z, s);
        if (t !== null && t >= minDist && t < bestT) {
          bestT = t;
          const p = at(origin, dir, t);
          best = { point: p, dist: t, normal: { x: -dir.x, y: -dir.y, z: -dir.z }, entityId: e.id, what: 'entity' };
        }
      }
    }
    return best;
  }

  /** True if the straight segment a→b is blocked by colliders or terrain (entities ignored). */
  segmentBlocked(a: Vec3, b: Vec3, margin = 0.05): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const maxT = len - margin;
    if (this.raycastColliders(a, dir, 0, maxT)) return true;
    return this.raycastTerrain(a, dir, 0, maxT) !== null;
  }

  /** Static-only distance along a ray (colliders + terrain); Infinity if clear within maxDist. */
  staticDistance(origin: Vec3, dir: Vec3, maxDist: number): number {
    let best = maxDist;
    const c = this.raycastColliders(origin, dir, 0, best);
    if (c) best = c.t;
    const t = this.raycastTerrain(origin, dir, 0, best);
    if (t !== null && t < best) best = t;
    return best < maxDist ? best : Infinity;
  }

  /** True if the point lies inside any static collider (used to keep grass out of buildings). */
  pointInCollider(x: number, y: number, z: number): boolean {
    const ix = Math.floor((x - this.origin) / CELL);
    const iz = Math.floor((z - this.origin) / CELL);
    if (ix < 0 || iz < 0 || ix >= this.gridN || iz >= this.gridN) return false;
    const list = this.cells[iz * this.gridN + ix];
    for (let k = 0; k < list.length; k++) {
      const c = this.colliders[list[k]];
      if (c.kind === 'cyl') {
        if (y >= c.y0 - 0.2 && y <= c.y1 && (x - c.x) ** 2 + (z - c.z) ** 2 <= c.r * c.r) return true;
      } else {
        const dx = x - c.cx;
        const dz = z - c.cz;
        const cs = Math.cos(c.rot);
        const sn = Math.sin(c.rot);
        const lx = dx * cs - dz * sn;
        const lz = dx * sn + dz * cs;
        if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz && Math.abs(y - c.cy) <= c.hy + 0.3) return true;
      }
    }
    return false;
  }

  groundHeight(x: number, z: number): number {
    return terrainHeight(this.map, x, z);
  }

  private terrainNormal(x: number, z: number): Vec3 {
    const e = 0.5;
    const hx = terrainHeight(this.map, x + e, z) - terrainHeight(this.map, x - e, z);
    const hz = terrainHeight(this.map, x, z + e) - terrainHeight(this.map, x, z - e);
    const l = Math.hypot(hx, 2 * e, hz);
    return { x: -hx / l, y: (2 * e) / l, z: -hz / l };
  }

  /** Ray-march the heightfield (adaptive step) then bisect. Returns t or null. */
  private raycastTerrain(o: Vec3, d: Vec3, tMin: number, tMax: number): number | null {
    const half = this.map.size / 2;
    let t = tMin;
    let prevT = t;
    // skip quickly if the whole ray segment is above the highest terrain point
    if (d.y >= 0 && o.y + d.y * tMin > this.maxTerrain) return null;
    const cell = this.map.size / this.map.res;
    for (let iter = 0; iter < 512 && t <= tMax; iter++) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      if (Math.abs(x) > half + 1 || Math.abs(z) > half + 1) {
        // outside the map there is nothing to hit, but the ray may re-enter
        if (d.y > 0 && y > this.maxTerrain) return null;
      }
      const gap = y - terrainHeight(this.map, x, z);
      const above = gap > 0;
      if (!above) {
        if (iter === 0) return t; // starts underground
        // bisect between prevT (above) and t (below)
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 16; k++) {
          const m = (lo + hi) / 2;
          const my = o.y + d.y * m;
          const g = my - terrainHeight(this.map, o.x + d.x * m, o.z + d.z * m);
          if (g > 0) lo = m;
          else hi = m;
        }
        return hi;
      }
      prevT = t;
      if (d.y > 0 && y > this.maxTerrain) return null;
      // adaptive step: bigger when high above ground, never skip a cell entirely
      t += Math.min(Math.max(gap * 0.5, cell * 0.35), cell * 2);
    }
    return null;
  }

  private raycastColliders(o: Vec3, d: Vec3, tMin: number, tMax: number): { t: number; n: Vec3 } | null {
    if (this.colliders.length === 0) return null;
    this.stampId = (this.stampId + 1) >>> 0;
    if (this.stampId === 0) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    let best: { t: number; n: Vec3 } | null = null;
    let bestT = tMax;
    // 2D DDA over XZ
    const sx = o.x + d.x * tMin;
    const sz = o.z + d.z * tMin;
    let ix = Math.floor((sx - this.origin) / CELL);
    let iz = Math.floor((sz - this.origin) / CELL);
    const stepX = d.x > 0 ? 1 : -1;
    const stepZ = d.z > 0 ? 1 : -1;
    const invX = Math.abs(d.x) > 1e-9 ? 1 / d.x : Infinity;
    const invZ = Math.abs(d.z) > 1e-9 ? 1 / d.z : Infinity;
    const nextBoundary = (i: number, step: number): number => this.origin + (step > 0 ? i + 1 : i) * CELL;
    let tMaxX = Number.isFinite(invX) ? (nextBoundary(ix, stepX) - o.x) * invX : Infinity;
    let tMaxZ = Number.isFinite(invZ) ? (nextBoundary(iz, stepZ) - o.z) * invZ : Infinity;
    const tDeltaX = Number.isFinite(invX) ? CELL * Math.abs(invX) : Infinity;
    const tDeltaZ = Number.isFinite(invZ) ? CELL * Math.abs(invZ) : Infinity;
    for (let guard = 0; guard < 4096; guard++) {
      if (ix >= 0 && iz >= 0 && ix < this.gridN && iz < this.gridN) {
        const list = this.cells[iz * this.gridN + ix];
        for (let k = 0; k < list.length; k++) {
          const ci = list[k];
          if (this.stamp[ci] === this.stampId) continue;
          this.stamp[ci] = this.stampId;
          const hit = rayCollider(o, d, this.colliders[ci]);
          if (hit && hit.t >= tMin && hit.t < bestT) {
            bestT = hit.t;
            best = hit;
          }
        }
      } else if (
        (ix < 0 && stepX < 0) ||
        (iz < 0 && stepZ < 0) ||
        (ix >= this.gridN && stepX > 0) ||
        (iz >= this.gridN && stepZ > 0)
      ) {
        break; // left the grid for good
      }
      const tExit = Math.min(tMaxX, tMaxZ);
      if (best && best.t <= tExit) break;
      if (tExit > bestT || tExit > tMax) break;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else {
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }
    return best;
  }
}

const at = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t });

/** XZ bounding rectangle of a collider: [minX, minZ, maxX, maxZ]. */
export function colliderAabb(c: Collider): [number, number, number, number] {
  if (c.kind === 'cyl') return [c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r];
  const cs = Math.abs(Math.cos(c.rot));
  const sn = Math.abs(Math.sin(c.rot));
  const ex = c.hx * cs + c.hz * sn;
  const ez = c.hx * sn + c.hz * cs;
  return [c.cx - ex, c.cz - ez, c.cx + ex, c.cz + ez];
}

/** Ray vs collider; returns entry distance (or 0 when starting inside) and the surface normal. */
export function rayCollider(o: Vec3, d: Vec3, c: Collider): { t: number; n: Vec3 } | null {
  if (c.kind === 'cyl') {
    const t = rayCylinderSpan(o, d, c.x, c.z, c.r, c.y0, c.y1);
    if (!t) return null;
    const p = at(o, d, t.t);
    let n: Vec3;
    if (t.cap) n = { x: 0, y: t.cap, z: 0 };
    else {
      const l = Math.hypot(p.x - c.x, p.z - c.z) || 1;
      n = { x: (p.x - c.x) / l, y: 0, z: (p.z - c.z) / l };
    }
    return { t: t.t, n };
  }
  // oriented box: rotate ray into box space (rotation about Y by -rot)
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  const rx = o.x - c.cx;
  const rz = o.z - c.cz;
  // world → local: local = R(-rot) * world ; three.js Y rotation: x' = x cos + z sin, z' = -x sin + z cos
  const lox = rx * cs - rz * sn;
  const loz = rx * sn + rz * cs;
  const loy = o.y - c.cy;
  const ldx = d.x * cs - d.z * sn;
  const ldz = d.x * sn + d.z * cs;
  const ldy = d.y;
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = -1;
  let sign = 0;
  const slab = (oo: number, dd: number, h: number, ax: number): boolean => {
    if (Math.abs(dd) < 1e-12) return oo >= -h && oo <= h;
    let t1 = (-h - oo) / dd;
    let t2 = (h - oo) / dd;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tNear) {
      tNear = t1;
      axis = ax;
      sign = s;
    }
    if (t2 < tFar) tFar = t2;
    return tNear <= tFar && tFar >= 0;
  };
  if (!slab(lox, ldx, c.hx, 0)) return null;
  if (!slab(loy, ldy, c.hy, 1)) return null;
  if (!slab(loz, ldz, c.hz, 2)) return null;
  const t = tNear >= 0 ? tNear : 0;
  // local normal → world
  let nx = 0;
  let ny = 0;
  let nz = 0;
  if (axis === 0) nx = sign;
  else if (axis === 1) ny = sign;
  else if (axis === 2) nz = sign;
  // local → world: x = lx cos - lz sin ... inverse of the above rotation
  const wx = nx * cs + nz * sn;
  const wz = -nx * sn + nz * cs;
  return { t, n: { x: wx, y: ny, z: wz } };
}

/** Ray vs finite vertical cylinder [y0, y1]; returns entry t (0 if inside). */
function rayCylinderSpan(
  o: Vec3,
  d: Vec3,
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
): { t: number; cap: number } | null {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (ox * d.x + oz * d.z);
  const cc = ox * ox + oz * oz - r * r;
  let tSide0 = -Infinity;
  let tSide1 = Infinity;
  if (a < 1e-12) {
    if (cc > 0) return null;
  } else {
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    tSide0 = (-b - sq) / (2 * a);
    tSide1 = (-b + sq) / (2 * a);
  }
  let tCap0 = -Infinity;
  let tCap1 = Infinity;
  let capSign = 0;
  if (Math.abs(d.y) < 1e-12) {
    if (o.y < y0 || o.y > y1) return null;
  } else {
    const ta = (y0 - o.y) / d.y;
    const tb = (y1 - o.y) / d.y;
    tCap0 = Math.min(ta, tb);
    tCap1 = Math.max(ta, tb);
    capSign = d.y > 0 ? -1 : 1;
  }
  const tNear = Math.max(tSide0, tCap0);
  const tFar = Math.min(tSide1, tCap1);
  if (tNear > tFar || tFar < 0) return null;
  const cap = tCap0 > tSide0 ? capSign : 0;
  return { t: Math.max(0, tNear), cap };
}

/** Ray vs entity cylinder standing at (x, y, z) with radius r and height h. */
export function rayCylinder(o: Vec3, d: Vec3, x: number, y: number, z: number, r: number, h: number): number | null {
  const s = rayCylinderSpan(o, d, x, z, r, y, y + h);
  return s ? s.t : null;
}
