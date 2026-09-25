// Hero path following: nav-grid paths (SimExt.findPath, budgeted per tick by
// the world — a refused search is simply retried a little later), string-pulled
// skipping of waypoints, direct walking when the straight segment is walkable,
// and stuck handling (jump → re-plan → sidestep → give up on the goal so the
// caller picks another). Deterministic: no wall clock, bot RNG only.
import type { Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { buildNavGrid, locateNode, nearestWalkable, navWalkSegment } from '../map/nav';
import type { NavGrid } from '../map/nav';

const DIRECT_CHECK_EVERY = 0.5;
const DIRECT_MAX = 45;
const SKIP_CHECK_EVERY = 0.45;
const WAYPOINT_REACH = 1.4;
const REPLAN_AFTER = 9;
const PATH_RETRY = 0.35;
const MAX_NULL_PATHS = 6;
const STUCK_WINDOW = 1.5;
const STUCK_MIN_MOVE = 0.7;
const FEELER_HEIGHT = 0.8;

export interface NavOut {
  /** world-space move direction (unit or zero) */
  x: number;
  z: number;
  jump: boolean;
  /** horizontal distance to the goal */
  dist: number;
  /** the next corner is far and straight: sprinting makes sense */
  straight: boolean;
}

const navs = new WeakMap<object, NavGrid | null>();

/** The (cached) nav grid of the sim's map, or null when unavailable. */
export function navOf(sim: SimApi): NavGrid | null {
  const map = sim.map;
  if (navs.has(map)) return navs.get(map) ?? null;
  let nav: NavGrid | null = null;
  try {
    nav = buildNavGrid(map);
  } catch {
    nav = null;
  }
  navs.set(map, nav);
  return nav;
}

export class Navigator {
  private path: Vec3[] | null = null;
  private idx = 1;
  private goal: Vec3 | null = null;
  private pathAt = -99;
  private nextPathTry = 0;
  private nullPaths = 0;
  private direct = false;
  private directAt = -99;
  private skipAt = 0;
  // stuck
  private sampleAt = 0;
  private samples: { t: number; x: number; z: number }[] = [];
  private stuckLevel = 0;
  private unstickUntil = 0;
  private unstickX = 0;
  private unstickZ = 0;
  private jumpAt = 0;
  /** set when the current goal could not be reached (stuck repeatedly / no path) */
  unreachable = false;
  private readonly out: NavOut = { x: 0, z: 0, jump: false, dist: 0, straight: false };

  constructor(private readonly rng: Rng) {}

  /** Forget the current route (goal changed a lot / teleported). */
  reset(): void {
    this.path = null;
    this.goal = null;
    this.direct = false;
    this.directAt = -99;
    this.nullPaths = 0;
    this.unreachable = false;
    this.stuckLevel = 0;
  }

  get stuck(): number {
    return this.stuckLevel;
  }

  /** Steer toward `goal`; returns the world-space move direction. */
  steer(sim: SimApi, self: Entity, goal: Vec3, arrive = 1): NavOut {
    const now = sim.time;
    const o = this.out;
    o.jump = false;
    o.straight = false;
    const px = self.pos.x;
    const pz = self.pos.z;
    const dist = Math.hypot(goal.x - px, goal.z - pz);
    o.dist = dist;
    // new goal?
    if (!this.goal || Math.hypot(this.goal.x - goal.x, this.goal.z - goal.z) > 3 || Math.abs(this.goal.y - goal.y) > 2.5) {
      const keepPath = this.path && Math.hypot(this.path[this.path.length - 1].x - goal.x, this.path[this.path.length - 1].z - goal.z) < 4;
      if (!keepPath) {
        this.path = null;
        this.nullPaths = 0;
        this.unreachable = false;
      }
      this.goal = { x: goal.x, y: goal.y, z: goal.z };
      this.directAt = -99;
    }
    if (dist <= arrive && Math.abs(goal.y - self.pos.y) < 2) {
      o.x = 0;
      o.z = 0;
      this.samples.length = 0;
      this.stuckLevel = 0;
      return o;
    }
    const nav = navOf(sim);
    // unstick manoeuvre in progress
    if (now < this.unstickUntil) {
      o.x = this.unstickX;
      o.z = this.unstickZ;
      if (now >= this.jumpAt) {
        o.jump = true;
        this.jumpAt = now + 0.6;
      }
      return o;
    }
    // is the straight line walkable?
    if (now - this.directAt >= DIRECT_CHECK_EVERY) {
      this.directAt = now;
      if (dist < 4) this.direct = true;
      else if (!nav || dist > DIRECT_MAX) this.direct = !nav && dist <= DIRECT_MAX;
      else {
        const h = navWalkSegment(nav, self.pos, goal);
        this.direct = !Number.isNaN(h) && Math.abs(h - goal.y) < 2.5;
      }
      if (this.direct) this.path = null;
    }
    let tx = goal.x;
    let tz = goal.z;
    if (!this.direct && nav) {
      if ((!this.path || now - this.pathAt > REPLAN_AFTER) && now >= this.nextPathTry && this.nullPaths < MAX_NULL_PATHS) {
        const p = ext(sim).findPath(self.pos, goal, self.id);
        if (p && p.length > 1) {
          this.path = p;
          this.idx = 1;
          this.pathAt = now;
          this.nullPaths = 0;
        } else {
          this.nextPathTry = now + PATH_RETRY + this.rng.next() * 0.3;
          this.nullPaths++;
          if (this.nullPaths >= MAX_NULL_PATHS && !this.path) this.unreachable = true;
        }
      }
      const path = this.path;
      if (path) {
        let idx = Math.min(this.idx, path.length - 1);
        while (idx < path.length - 1 && Math.hypot(path[idx].x - px, path[idx].z - pz) < WAYPOINT_REACH && Math.abs(path[idx].y - self.pos.y) < 2.2) idx++;
        // string-pull: skip a waypoint when the next one is directly walkable
        if (now >= this.skipAt && idx < path.length - 1) {
          this.skipAt = now + SKIP_CHECK_EVERY;
          const h = navWalkSegment(nav, self.pos, path[idx + 1]);
          if (!Number.isNaN(h) && Math.abs(h - path[idx + 1].y) < 1) idx++;
        }
        this.idx = idx;
        tx = path[idx].x;
        tz = path[idx].z;
        // wandered off the route: plan again
        if (Math.hypot(tx - px, tz - pz) > 14) this.path = null;
        const legLen = Math.hypot(tx - px, tz - pz);
        o.straight = legLen > 8;
        if (idx === path.length - 1 && Math.hypot(path[idx].x - goal.x, path[idx].z - goal.z) > 3 && Math.hypot(tx - px, tz - pz) < 1.5) {
          // path ended short of the goal (unreachable surface): stop there
          this.unreachable = true;
        }
      }
    } else {
      o.straight = dist > 8;
    }
    let dx = tx - px;
    let dz = tz - pz;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) {
      o.x = 0;
      o.z = 0;
      return o;
    }
    dx /= l;
    dz /= l;
    // no nav: raycast feelers around static obstacles
    if (!nav && !sim.lineOfSight(feelerFrom(self), feelerTo(self, dx, dz, 2.2))) {
      const side = self.id % 2 === 0 ? 1 : -1;
      for (const a0 of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
        const a = a0 * side;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const rx = dx * c - dz * s;
        const rz = dx * s + dz * c;
        if (sim.lineOfSight(feelerFrom(self), feelerTo(self, rx, rz, 2.2))) {
          dx = rx;
          dz = rz;
          break;
        }
      }
    }
    o.x = dx;
    o.z = dz;
    this.checkStuck(sim, self, goal);
    return o;
  }

  /** Called every tick the bot wants to move. */
  private checkStuck(sim: SimApi, self: Entity, goal: Vec3): void {
    const now = sim.time;
    if (now < this.sampleAt) return;
    this.sampleAt = now + 0.25;
    // being held in place is not being stuck
    if (self.forced || sim.hasStatus(self.id, 'stun') || sim.hasStatus(self.id, 'root') || self.hero?.channel) {
      this.samples.length = 0;
      return;
    }
    const s = this.samples;
    s.push({ t: now, x: self.pos.x, z: self.pos.z });
    while (s.length > 0 && now - s[0].t > STUCK_WINDOW + 0.01) s.shift();
    if (s.length < 2 || now - s[0].t < STUCK_WINDOW - 0.3) return;
    const moved = Math.hypot(self.pos.x - s[0].x, self.pos.z - s[0].z);
    if (moved >= STUCK_MIN_MOVE) {
      if (moved > 2) this.stuckLevel = Math.max(0, this.stuckLevel - 1);
      return;
    }
    // stuck
    s.length = 0;
    this.stuckLevel++;
    this.out.jump = true;
    this.jumpAt = now + 0.5;
    if (this.stuckLevel >= 2) {
      this.path = null;
      this.pathAt = -99;
      this.nextPathTry = now;
      this.directAt = -99;
    }
    if (this.stuckLevel >= 3) {
      // sidestep in a random direction, back toward walkable ground we can actually reach, or —
      // stranded on a slope too steep to climb, off the nav grid — downhill
      const nav = navOf(sim);
      let ux = 0;
      let uz = 0;
      const w = nav ? nearestWalkable(nav, self.pos) : null;
      const climbable = !!w && w.y - self.pos.y < 0.8;
      if (w && climbable && Math.hypot(w.x - self.pos.x, w.z - self.pos.z) > 0.8) {
        ux = w.x - self.pos.x;
        uz = w.z - self.pos.z;
      } else if (nav && w && !climbable) {
        const esc = this.escapeDownhill(sim, self, nav);
        ux = esc.x;
        uz = esc.z;
      } else {
        const gx = goal.x - self.pos.x;
        const gz = goal.z - self.pos.z;
        const side = this.rng.next() < 0.5 ? 1 : -1;
        const a = side * (Math.PI / 2 + (this.rng.next() - 0.5) * 1.2);
        const c = Math.cos(a);
        const sn = Math.sin(a);
        ux = gx * c - gz * sn;
        uz = gx * sn + gz * c;
      }
      const l = Math.hypot(ux, uz) || 1;
      this.unstickX = ux / l;
      this.unstickZ = uz / l;
      this.unstickUntil = Math.max(this.unstickUntil, now + 0.6 + this.rng.next() * 0.5);
    }
    if (this.stuckLevel >= 5) this.unreachable = true;
  }

  /**
   * Best of 12 directions 5 m out: prefer walkable ground at or below our feet,
   * else simply the lowest terrain (the way off a steep slope).
   */
  private escapeDownhill(sim: SimApi, self: Entity, nav: NavGrid): { x: number; z: number } {
    let best = { x: 0, z: 0 };
    let bs = Infinity;
    const off = this.rng.next() * Math.PI * 2;
    for (let i = 0; i < 12; i++) {
      const a = off + (i / 12) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const x = self.pos.x + dx * 5;
      const z = self.pos.z + dz * 5;
      const h = sim.groundHeight(x, z);
      const walk = locateNode(nav, { x, y: h, z }) >= 0;
      const s = h - self.pos.y - (walk ? 3 : 0);
      if (s < bs) {
        bs = s;
        best = { x: dx, z: dz };
      }
    }
    this.unstickUntil = sim.time + 1.2;
    return best;
  }
}

function feelerFrom(self: Entity): Vec3 {
  return { x: self.pos.x, y: self.pos.y + FEELER_HEIGHT, z: self.pos.z };
}

function feelerTo(self: Entity, dx: number, dz: number, len: number): Vec3 {
  return { x: self.pos.x + dx * len, y: self.pos.y + FEELER_HEIGHT, z: self.pos.z + dz * len };
}
