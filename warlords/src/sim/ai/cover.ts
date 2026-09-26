// Cover points. Built once per map from the static colliders (walls, houses,
// rocks, crate stacks, trees…): candidate standing spots just outside every
// collider tall enough to hide a crouching-height body, bucketed in a coarse
// grid. A query picks the nearest walkable spot that the given threats cannot
// see (static LOS at chest height), limited to a few LOS checks per call.
import type { Vec3 } from '../../core/math';
import type { Collider, MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { isWalkable, navWalkSegment } from '../map/nav';
import { navOf } from './navigator';

const CELL = 8;
const MIN_HEIGHT = 1.3;
const OFFSET = 0.75;
const SIDE_SPACING = 4;
const CHEST = 1.2;

export interface CoverIndex {
  x: Float32Array;
  z: Float32Array;
  /** 0 = unchecked, 1 = walkable, -1 = not */
  ok: Int8Array;
  cells: Map<number, number[]>;
  cols: number;
  half: number;
}

const indexes = new WeakMap<MapData, CoverIndex>();

function cellKey(ci: CoverIndex, x: number, z: number): number {
  const c = Math.floor((x + ci.half) / CELL);
  const r = Math.floor((z + ci.half) / CELL);
  return r * ci.cols + c;
}

function pointsFor(c: Collider, map: MapData, out: number[]): void {
  if (c.kind === 'cyl') {
    if (c.r < 0.25 || c.y1 - c.y0 < MIN_HEIGHT) return;
    const ground = terrainHeight(map, c.x, c.z);
    if (c.y1 - Math.max(c.y0, ground) < MIN_HEIGHT) return;
    const n = c.r > 1.5 ? 8 : 5;
    const r = c.r + OFFSET;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + c.x * 0.13;
      out.push(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r);
    }
    return;
  }
  if (c.hy * 2 < MIN_HEIGHT || c.hx < 0.25 || c.hz < 0.25) return;
  const top = c.cy + c.hy;
  const ground = terrainHeight(map, c.cx, c.cz);
  if (top - ground < MIN_HEIGHT || c.cy - c.hy > ground + 0.8) return; // floating slabs (roofs, decks) hide nothing
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  // local (lx, lz) → world, same convention as the physics (yaw rotation)
  const toWorld = (lx: number, lz: number): void => {
    out.push(c.cx + lx * cos + lz * sin, c.cz - lx * sin + lz * cos);
  };
  for (const [ax, len, other] of [
    [1, c.hz, c.hx],
    [-1, c.hz, c.hx],
  ] as const) {
    const n = Math.max(1, Math.round((len * 2) / SIDE_SPACING));
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * Math.max(0, len - 0.4);
      toWorld(ax * (other + OFFSET), t);
    }
  }
  for (const [az, len, other] of [
    [1, c.hx, c.hz],
    [-1, c.hx, c.hz],
  ] as const) {
    const n = Math.max(1, Math.round((len * 2) / SIDE_SPACING));
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * Math.max(0, len - 0.4);
      toWorld(t, az * (other + OFFSET));
    }
  }
}

export function coverIndexFor(map: MapData): CoverIndex {
  const hit = indexes.get(map);
  if (hit) return hit;
  const pts: number[] = [];
  for (const c of map.colliders) pointsFor(c, map, pts);
  const n = pts.length / 2;
  const half = map.size / 2;
  const cols = Math.ceil(map.size / CELL) + 1;
  const ci: CoverIndex = { x: new Float32Array(n), z: new Float32Array(n), ok: new Int8Array(n), cells: new Map(), cols, half };
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const z = pts[i * 2 + 1];
    if (Math.abs(x) > half - 2 || Math.abs(z) > half - 2) {
      ci.ok[i] = -1;
    }
    ci.x[i] = x;
    ci.z[i] = z;
    const k = cellKey(ci, x, z);
    let list = ci.cells.get(k);
    if (!list) {
      list = [];
      ci.cells.set(k, list);
    }
    list.push(i);
  }
  indexes.set(map, ci);
  return ci;
}

export interface CoverQuery {
  /** eye positions of the threats to hide from (1–3) */
  threats: Vec3[];
  maxDist: number;
  /** max LOS checks spent on this query */
  budget?: number;
  /** don't pick spots that bring us closer to the first threat by more than this (m) */
  maxAdvance?: number;
}

/** Nearest reachable spot hidden from every threat, or null. */
export function findCover(sim: SimApi, self: Entity, q: CoverQuery): Vec3 | null {
  const ci = coverIndexFor(sim.map);
  const nav = navOf(sim);
  const px = self.pos.x;
  const pz = self.pos.z;
  const r = q.maxDist;
  const c0 = Math.floor((px - r + ci.half) / CELL);
  const c1 = Math.floor((px + r + ci.half) / CELL);
  const r0 = Math.floor((pz - r + ci.half) / CELL);
  const r1 = Math.floor((pz + r + ci.half) / CELL);
  const main = q.threats[0];
  const dMain = main ? Math.hypot(main.x - px, main.z - pz) : 0;
  const cands: { i: number; s: number }[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const list = ci.cells.get(row * ci.cols + col);
      if (!list) continue;
      for (const i of list) {
        if (ci.ok[i] < 0) continue;
        const d = Math.hypot(ci.x[i] - px, ci.z[i] - pz);
        if (d > r) continue;
        let s = d;
        if (main) {
          const dm = Math.hypot(main.x - ci.x[i], main.z - ci.z[i]);
          const adv = dMain - dm;
          if (adv > (q.maxAdvance ?? 4)) continue;
          if (adv > 0) s += adv * 1.5;
          if (dm < 6) continue;
        }
        cands.push({ i, s });
      }
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.s - b.s);
  let budget = q.budget ?? 8;
  for (const c of cands) {
    if (budget <= 0) break;
    const i = c.i;
    const x = ci.x[i];
    const z = ci.z[i];
    const y = sim.groundHeight(x, z);
    if (ci.ok[i] === 0) ci.ok[i] = !nav || isWalkable(nav, { x, y, z }) ? 1 : -1;
    if (ci.ok[i] < 0) continue;
    if (Math.abs(y - self.pos.y) > 3) continue;
    budget--;
    const chest = { x, y: y + CHEST, z };
    let hidden = true;
    for (const t of q.threats) {
      if (sim.lineOfSight(t, chest)) {
        hidden = false;
        break;
      }
    }
    if (!hidden) continue;
    if (nav && c.s > 3) {
      const h = navWalkSegment(nav, self.pos, { x, y, z });
      if (Number.isNaN(h)) {
        budget--;
        continue;
      }
    }
    return { x, y, z };
  }
  return null;
}
