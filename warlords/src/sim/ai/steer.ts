// Steering for AI units: straight-line seek with raycast-feeler obstacle
// avoidance, stuck detection (jump / sidestep) and, for long trips without a
// clear line, waypoint following via the map nav grid (SimExt.findPath).
// Per-unit memory lives in the entity's numeric `ai` record.
import type { Vec3 } from '../../core/math';
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import type { UnitIntent } from './types';

const FEELER_LEN = 2.4;
const FEELER_HEIGHT = 0.75;
const PROBE_EVERY = 0.2;
const AVOID_HOLD = 0.7;
const STUCK_CHECK = 1.0;
const PATH_MIN_DIST = 14;
const PATH_REFRESH = 3;
const ANGLES = [0.45, -0.45, 0.9, -0.9, 1.35, -1.35, 1.9, -1.9];

/** Numeric memory keys used by steering (stored on unit ai records). */
export interface SteerMem {
  [k: string]: number;
}

function feelerClear(sim: SimApi, self: Entity, dx: number, dz: number, len: number): boolean {
  const a = { x: self.pos.x, y: self.pos.y + FEELER_HEIGHT, z: self.pos.z };
  const b = { x: a.x + dx * len, y: a.y, z: a.z + dz * len };
  return sim.lineOfSight(a, b);
}

/**
 * Write a movement direction toward `goal` into `out`. Returns the remaining
 * horizontal distance. `mem` persists between calls (avoidance, stuck, path).
 */
export function steerTo(sim: SimApi, self: Entity, goal: Vec3, mem: SteerMem, out: UnitIntent, arrive = 0.8): number {
  const now = sim.time;
  const pathCache = cacheFor(sim);
  let tx = goal.x;
  let tz = goal.z;
  const fullDist = Math.hypot(goal.x - self.pos.x, goal.z - self.pos.z);
  if (fullDist <= arrive && Math.abs(goal.y - self.pos.y) <= 1.5) {
    out.moveX = 0;
    out.moveZ = 0;
    mem.stuckT = 0;
    return fullDist;
  }

  // waypoint following for long trips, or when the goal is on another level (bridge decks, walls…)
  const otherLevel = Math.abs(goal.y - self.pos.y) > 1.5 && Number.isFinite(goal.y);
  if (fullDist > PATH_MIN_DIST || otherLevel) {
    const goalMoved = Math.hypot((mem.pgx ?? 1e9) - goal.x, (mem.pgz ?? 1e9) - goal.z) > 4;
    const blocked = (mem.blockedFor ?? 0) > 0.6;
    const pathId = mem.pathId ?? 0;
    const cache = pathCache.get(self.id);
    const stale = now - (mem.pathAt ?? -99) > PATH_REFRESH;
    const need = otherLevel ? (!cache || goalMoved) && stale : (goalMoved && blocked) || (blocked && (!cache || stale));
    if (need) {
      const path = ext(sim).findPath(self.pos, goal, self.id);
      mem.pathAt = now;
      mem.pgx = goal.x;
      mem.pgz = goal.z;
      if (path && path.length > 1) {
        pathCache.set(self.id, path);
        mem.pathIdx = 1;
        mem.pathId = pathId + 1;
      } else {
        pathCache.delete(self.id);
      }
    }
    const path = pathCache.get(self.id);
    if (path) {
      let idx = mem.pathIdx ?? 1;
      while (idx < path.length - 1 && Math.hypot(path[idx].x - self.pos.x, path[idx].z - self.pos.z) < 1.5) idx++;
      mem.pathIdx = idx;
      if (idx < path.length) {
        tx = path[idx].x;
        tz = path[idx].z;
      }
      if (goalMoved && Math.hypot(path[path.length - 1].x - goal.x, path[path.length - 1].z - goal.z) > 8) pathCache.delete(self.id);
    }
  } else if (pathCache.has(self.id)) {
    pathCache.delete(self.id);
  }

  let dx = tx - self.pos.x;
  let dz = tz - self.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) {
    out.moveX = 0;
    out.moveZ = 0;
    return fullDist;
  }
  dx /= dist;
  dz /= dist;

  // obstacle avoidance
  if (now >= (mem.probeAt ?? 0)) {
    mem.probeAt = now + PROBE_EVERY;
    const len = Math.min(FEELER_LEN, dist);
    if (feelerClear(sim, self, dx, dz, len)) {
      if (now >= (mem.avoidUntil ?? 0)) mem.avoid = 0;
      mem.blockedFor = Math.max(0, (mem.blockedFor ?? 0) - PROBE_EVERY);
    } else {
      mem.blockedFor = (mem.blockedFor ?? 0) + PROBE_EVERY;
      let chosen = NaN;
      // prefer the side we already chose (avoid oscillation)
      const pref = mem.avoid && Math.abs(mem.avoid) > 0 ? Math.sign(mem.avoid) : self.id % 2 === 0 ? 1 : -1;
      for (const a0 of ANGLES) {
        const a = a0 * pref;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const rx = dx * c - dz * s;
        const rz = dx * s + dz * c;
        if (feelerClear(sim, self, rx, rz, FEELER_LEN)) {
          chosen = a;
          break;
        }
      }
      if (!Number.isNaN(chosen)) {
        mem.avoid = chosen;
        mem.avoidUntil = now + AVOID_HOLD;
      } else {
        mem.avoid = Math.PI * 0.75 * pref;
        mem.avoidUntil = now + AVOID_HOLD;
      }
    }
  }
  const avoid = now < (mem.avoidUntil ?? 0) ? (mem.avoid ?? 0) : 0;
  if (avoid !== 0) {
    const c = Math.cos(avoid);
    const s = Math.sin(avoid);
    const rx = dx * c - dz * s;
    const rz = dx * s + dz * c;
    dx = rx;
    dz = rz;
  }

  // stuck detection → jump + random sidestep
  if (now >= (mem.stuckAt ?? 0)) {
    const moved = Math.hypot(self.pos.x - (mem.lastX ?? self.pos.x + 9), self.pos.z - (mem.lastZ ?? self.pos.z + 9));
    mem.stuckAt = now + STUCK_CHECK;
    mem.lastX = self.pos.x;
    mem.lastZ = self.pos.z;
    if (moved < 0.35) {
      mem.stuckT = (mem.stuckT ?? 0) + 1;
      out.jump = true;
      mem.avoid = ((((self.id * 7919 + Math.floor(now)) % 5) - 2) / 2) * 1.6 || 1.2;
      mem.avoidUntil = now + 0.9;
      mem.blockedFor = (mem.blockedFor ?? 0) + 1;
    } else {
      mem.stuckT = 0;
    }
  }
  out.moveX = dx;
  out.moveZ = dz;
  return fullDist;
}

/** Waypoint caches per world, keyed by entity id (the numeric ai record cannot hold arrays). */
const caches = new WeakMap<SimApi, Map<number, Vec3[]>>();

function cacheFor(sim: SimApi): Map<number, Vec3[]> {
  let c = caches.get(sim);
  if (!c) {
    c = new Map();
    caches.set(sim, c);
  }
  return c;
}

/** Drop a unit's cached path (on death / despawn). */
export function forgetPath(sim: SimApi, id: number): void {
  caches.get(sim)?.delete(id);
}

/** Flat direction away from a point. */
export function fleeFrom(self: Entity, from: Vec3, out: UnitIntent): void {
  let dx = self.pos.x - from.x;
  let dz = self.pos.z - from.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-4) {
    dx = Math.sin(self.id);
    dz = Math.cos(self.id);
  } else {
    dx /= l;
    dz /= l;
  }
  out.moveX = dx;
  out.moveZ = dz;
}
