// Character physics + static-world raycasts. Shared by the host sim and
// client-side prediction (net/clientView.ts): everything here is pure and
// deterministic for a given (CollisionWorld, state, input, dt, mods).
//
// Character = vertical capsule approximated as a circle on XZ (radius ≈ 0.4)
// extruded from the feet (st.pos.y) to feet + height (≈ 1.8).
// Static world = heightfield + Y-rotated oriented boxes + vertical cylinders.
//  - Colliders whose top is within STEP_HEIGHT of the feet are "steppable":
//    they never push, they only raise the ground (stairs = stacks of boxes).
//  - Colliders entirely above the head are ignored horizontally (ceilings).
//  - Terrain steeper than MAX_SLOPE_DEG cannot be walked up.
import type { Collider, MapData } from '../core/map';
import { terrainHeight } from '../core/map';
import type { Vec3 } from '../core/math';
import type { InputFrame } from '../core/types';
import { BTN_JUMP, BTN_SPRINT } from '../core/types';
import { StaticGrid } from './spatial';

// ── Tunables ────────────────────────────────────────────────────────────────
export const CHAR_RADIUS = 0.4;
export const CHAR_HEIGHT = 1.8;
export const STEP_HEIGHT = 0.45;
export const MAX_SLOPE_DEG = 45;
const MAX_SLOPE_TAN = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180);
export const GRAVITY = 20;
export const JUMP_SPEED = 6.6;
export const WALK_SPEED = 5.0;
export const SPRINT_MUL = 1.5;
export const ADS_MUL = 0.6;
export const BACKPEDAL_MUL = 0.85;
export const DOWNED_MUL = 0.25;
export const WATER_MUL = 0.6;
export const GROUND_ACCEL = 60;
export const AIR_ACCEL = 10;
/** walking down stairs / slopes keeps you glued to the ground up to this drop per tick */
export const SNAP_DOWN = 0.55;
/** in deep water characters float with their feet this far below the surface */
export const SWIM_DEPTH = 1.2;
const SUPPORT_RADIUS = 0.28;
const MAX_SUBSTEP = 0.3;
const MAX_FALL_SPEED = 50;
const STEEP_SLIDE_SPEED = 4;
const BOUNDS_MARGIN = 0.5;

// ── Collision world ─────────────────────────────────────────────────────────
/** Pre-processed static collider (boxes rotate around Y only). */
export interface ColShape {
  box: boolean;
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** cos/sin of the box yaw */
  c: number;
  s: number;
  /** cylinder radius */
  r: number;
  y0: number;
  y1: number;
}

export interface CollisionWorld {
  map: MapData;
  shapes: ColShape[];
  grid: StaticGrid;
  /** highest terrain sample (raycast early-out) */
  maxTerrain: number;
  /** terrain cell size in meters */
  terrainCell: number;
  half: number;
  /** internal scratch buffer (not re-entrant) */
  scratch: number[];
}

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  /** set by predictMove: sprint actually applied this step */
  sprinting?: boolean;
  /** set by the movement functions: feet are in water */
  inWater?: boolean;
  /** standing on terrain steeper than the walkable limit (slides, cannot jump) */
  steep?: boolean;
}

export interface MoveMods {
  speedMul: number;
  canSprint: boolean;
  canJump: boolean;
  rooted: boolean;
  ads: boolean;
  downed: boolean;
  /** sprinting does not break ADS (夏侯渊 神速) */
  sprintAds?: boolean;
  /** capsule overrides (defaults CHAR_RADIUS / CHAR_HEIGHT) */
  radius?: number;
  height?: number;
}

function toShape(c: Collider): ColShape {
  if (c.kind === 'box') {
    return {
      box: true,
      cx: c.cx,
      cy: c.cy,
      cz: c.cz,
      hx: Math.abs(c.hx),
      hy: Math.abs(c.hy),
      hz: Math.abs(c.hz),
      c: Math.cos(c.rot),
      s: Math.sin(c.rot),
      r: 0,
      y0: c.cy - Math.abs(c.hy),
      y1: c.cy + Math.abs(c.hy),
    };
  }
  return {
    box: false,
    cx: c.x,
    cy: (c.y0 + c.y1) / 2,
    cz: c.z,
    hx: c.r,
    hy: Math.abs(c.y1 - c.y0) / 2,
    hz: c.r,
    c: 1,
    s: 0,
    r: Math.abs(c.r),
    y0: Math.min(c.y0, c.y1),
    y1: Math.max(c.y0, c.y1),
  };
}

export function buildCollisionWorld(map: MapData): CollisionWorld {
  const shapes = map.colliders.map(toShape);
  const grid = new StaticGrid(map.size, 4, shapes.length);
  shapes.forEach((sh, i) => {
    let ex: number;
    let ez: number;
    if (sh.box) {
      ex = Math.abs(sh.c) * sh.hx + Math.abs(sh.s) * sh.hz;
      ez = Math.abs(sh.s) * sh.hx + Math.abs(sh.c) * sh.hz;
    } else {
      ex = sh.r;
      ez = sh.r;
    }
    grid.insert(i, sh.cx - ex, sh.cz - ez, sh.cx + ex, sh.cz + ez);
  });
  let maxTerrain = -Infinity;
  for (let i = 0; i < map.heights.length; i++) if (map.heights[i] > maxTerrain) maxTerrain = map.heights[i];
  if (!Number.isFinite(maxTerrain)) maxTerrain = 0;
  return {
    map,
    shapes,
    grid,
    maxTerrain,
    terrainCell: map.size / Math.max(1, map.res),
    half: map.size / 2,
    scratch: [],
  };
}

export const terrainAt = (cw: CollisionWorld, x: number, z: number): number => terrainHeight(cw.map, x, z);

/** Distance² from (x, z) to the collider footprint, or -1 when inside a box footprint. */
function footprintDist2(sh: ColShape, x: number, z: number): number {
  const rx = x - sh.cx;
  const rz = z - sh.cz;
  if (!sh.box) {
    const d = Math.sqrt(rx * rx + rz * rz) - sh.r;
    return d <= 0 ? -1 : d * d;
  }
  const lx = sh.c * rx - sh.s * rz;
  const lz = sh.s * rx + sh.c * rz;
  const qx = lx < -sh.hx ? -sh.hx : lx > sh.hx ? sh.hx : lx;
  const qz = lz < -sh.hz ? -sh.hz : lz > sh.hz ? sh.hz : lz;
  const dx = lx - qx;
  const dz = lz - qz;
  const d2 = dx * dx + dz * dz;
  return d2 === 0 ? -1 : d2;
}

/** true when the circle (x, z, r) overlaps the collider's footprint. */
export function overlapsFootprint(sh: ColShape, x: number, z: number, r: number): boolean {
  const d2 = footprintDist2(sh, x, z);
  return d2 < r * r;
}

/**
 * Height of the surface a character would stand on at (x, z) given its feet
 * height: the terrain or the highest collider top within STEP_HEIGHT above the feet.
 */
export function supportHeight(cw: CollisionWorld, x: number, z: number, feetY: number, sr = SUPPORT_RADIUS): number {
  let h = terrainHeight(cw.map, x, z);
  const ids = cw.grid.collectRect(x - sr, z - sr, x + sr, z + sr, cw.scratch);
  const limit = feetY + STEP_HEIGHT + 1e-4;
  for (let i = 0; i < ids.length; i++) {
    const sh = cw.shapes[ids[i]];
    if (sh.y1 > limit || sh.y1 <= h) continue;
    if (overlapsFootprint(sh, x, z, sr)) h = sh.y1;
  }
  return h;
}

/** Ground height for spawning/placing things: highest walkable surface under (x, z) at or below `fromY`. */
export function groundAt(cw: CollisionWorld, x: number, z: number, fromY = Infinity): number {
  let h = terrainHeight(cw.map, x, z);
  const ids = cw.grid.collectRect(x - 0.05, z - 0.05, x + 0.05, z + 0.05, cw.scratch);
  for (let i = 0; i < ids.length; i++) {
    const sh = cw.shapes[ids[i]];
    if (sh.y1 > fromY || sh.y1 <= h) continue;
    if (overlapsFootprint(sh, x, z, 0.05)) h = sh.y1;
  }
  return h;
}

function terrainGrad(cw: CollisionWorld, x: number, z: number, out: { x: number; z: number }): void {
  const e = 0.5;
  out.x = (terrainHeight(cw.map, x + e, z) - terrainHeight(cw.map, x - e, z)) / (2 * e);
  out.z = (terrainHeight(cw.map, x, z + e) - terrainHeight(cw.map, x, z - e)) / (2 * e);
}

export function isInWater(cw: CollisionWorld, pos: Vec3): boolean {
  const wl = cw.map.waterLevel;
  return terrainHeight(cw.map, pos.x, pos.z) < wl - 0.25 && pos.y < wl - 0.1;
}

/** Push the circle out of every blocking collider (few relaxation passes). Returns true if pushed. */
function resolveHorizontal(cw: CollisionWorld, pos: Vec3, radius: number, height: number): boolean {
  let any = false;
  const stepTop = pos.y + STEP_HEIGHT;
  const head = pos.y + height - 0.05;
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    const ids = cw.grid.collectRect(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius, cw.scratch);
    for (let i = 0; i < ids.length; i++) {
      const sh = cw.shapes[ids[i]];
      if (sh.y1 <= stepTop || sh.y0 >= head) continue;
      const rx = pos.x - sh.cx;
      const rz = pos.z - sh.cz;
      if (!sh.box) {
        const d2 = rx * rx + rz * rz;
        const rr = radius + sh.r;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-6) {
          const pen = rr - d;
          pos.x += (rx / d) * pen;
          pos.z += (rz / d) * pen;
        } else {
          pos.x += rr;
        }
        pushed = true;
        continue;
      }
      const lx = sh.c * rx - sh.s * rz;
      const lz = sh.s * rx + sh.c * rz;
      const qx = lx < -sh.hx ? -sh.hx : lx > sh.hx ? sh.hx : lx;
      const qz = lz < -sh.hz ? -sh.hz : lz > sh.hz ? sh.hz : lz;
      const dx = lx - qx;
      const dz = lz - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      let px: number;
      let pz: number;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        const pen = radius - d;
        px = (dx / d) * pen;
        pz = (dz / d) * pen;
      } else {
        // centre inside the box: leave through the nearest face
        const penX = sh.hx - Math.abs(lx) + radius;
        const penZ = sh.hz - Math.abs(lz) + radius;
        if (penX < penZ) {
          px = (lx >= 0 ? 1 : -1) * penX;
          pz = 0;
        } else {
          px = 0;
          pz = (lz >= 0 ? 1 : -1) * penZ;
        }
      }
      pos.x += sh.c * px + sh.s * pz;
      pos.z += -sh.s * px + sh.c * pz;
      pushed = true;
    }
    if (!pushed) break;
    any = true;
  }
  return any;
}

function clampBounds(cw: CollisionWorld, pos: Vec3): void {
  const lim = cw.half - BOUNDS_MARGIN;
  if (pos.x < -lim) pos.x = -lim;
  else if (pos.x > lim) pos.x = lim;
  if (pos.z < -lim) pos.z = -lim;
  else if (pos.z > lim) pos.z = lim;
}

const gradTmp = { x: 0, z: 0 };

/**
 * Move a character by (dx, dz) with collide-and-slide, step-up, slope limits
 * and world bounds, then integrate vertical motion (gravity, landing, ground
 * snapping, ceilings, swimming) using st.vel.y. Horizontal st.vel is set to the
 * displacement actually achieved.
 */
export function moveCharacter(
  cw: CollisionWorld,
  st: MoveState,
  dx: number,
  dz: number,
  dt: number,
  radius = CHAR_RADIUS,
  height = CHAR_HEIGHT,
): void {
  const pos = st.pos;
  const startX = pos.x;
  const startZ = pos.z;
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / MAX_SUBSTEP));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    let nx = pos.x + sx;
    let nz = pos.z + sz;
    // Terrain slope limit: cannot walk up terrain steeper than MAX_SLOPE.
    const tNew = terrainHeight(cw.map, nx, nz);
    if (tNew > pos.y + 0.05) {
      terrainGrad(cw, nx, nz, gradTmp);
      const gl = Math.hypot(gradTmp.x, gradTmp.z);
      if (gl > MAX_SLOPE_TAN) {
        const ux = gradTmp.x / gl;
        const uz = gradTmp.z / gl;
        const along = sx * ux + sz * uz;
        if (along > 0) {
          nx = pos.x + sx - ux * along;
          nz = pos.z + sz - uz * along;
        }
        if (terrainHeight(cw.map, nx, nz) > pos.y + STEP_HEIGHT) {
          nx = pos.x;
          nz = pos.z;
        }
      }
    }
    pos.x = nx;
    pos.z = nz;
    resolveHorizontal(cw, pos, radius, height);
    clampBounds(cw, pos);
    // step up onto stairs / ledges between substeps so multi-step dashes climb
    if (st.onGround) {
      const g = supportHeight(cw, pos.x, pos.z, pos.y);
      if (g > pos.y && g - pos.y <= STEP_HEIGHT + 1e-4) pos.y = g;
    }
  }
  if (dt > 0) {
    st.vel.x = (pos.x - startX) / dt;
    st.vel.z = (pos.z - startZ) / dt;
  }
  integrateVertical(cw, st, dt, radius, height);
}

function integrateVertical(cw: CollisionWorld, st: MoveState, dt: number, radius: number, height: number): void {
  const pos = st.pos;
  const wasOnGround = st.onGround;
  st.vel.y -= GRAVITY * dt;
  if (st.vel.y < -MAX_FALL_SPEED) st.vel.y = -MAX_FALL_SPEED;
  let newY = pos.y + st.vel.y * dt;
  let ground = supportHeight(cw, pos.x, pos.z, pos.y);
  const t = terrainHeight(cw.map, pos.x, pos.z);
  const wl = cw.map.waterLevel;
  const floatY = wl - SWIM_DEPTH;
  if (ground < floatY && pos.y <= wl + 0.2) ground = floatY;

  if (newY <= ground) {
    pos.y = ground;
    st.vel.y = 0;
    st.onGround = true;
  } else if (wasOnGround && st.vel.y <= 0 && pos.y - ground <= SNAP_DOWN) {
    pos.y = ground;
    st.vel.y = 0;
    st.onGround = true;
  } else {
    if (st.vel.y > 0) {
      const r = radius * 0.9;
      const ids = cw.grid.collectRect(pos.x - r, pos.z - r, pos.x + r, pos.z + r, cw.scratch);
      for (let i = 0; i < ids.length; i++) {
        const sh = cw.shapes[ids[i]];
        if (sh.y0 > pos.y + STEP_HEIGHT && sh.y0 < newY + height && overlapsFootprint(sh, pos.x, pos.z, r)) {
          newY = Math.max(pos.y, sh.y0 - height);
          st.vel.y = 0;
        }
      }
    }
    pos.y = newY;
    st.onGround = false;
  }
  st.inWater = t < wl - 0.25 && pos.y < wl - 0.1;
  if (st.onGround && Math.abs(ground - t) < 0.01 && !st.inWater) {
    terrainGrad(cw, pos.x, pos.z, gradTmp);
    st.steep = Math.hypot(gradTmp.x, gradTmp.z) > MAX_SLOPE_TAN;
  } else {
    st.steep = false;
  }
}

/**
 * Advance a character's locomotion by dt from an input frame (pure; deterministic).
 * Handles walk/sprint/ADS/crawl speeds, water, acceleration, jumping, gravity and collision.
 */
export function predictMove(cw: CollisionWorld, st: MoveState, input: InputFrame, dt: number, mods: MoveMods): void {
  const radius = mods.radius ?? CHAR_RADIUS;
  const height = mods.height ?? CHAR_HEIGHT;
  let mx = Number.isFinite(input.moveX) ? input.moveX : 0;
  let mz = Number.isFinite(input.moveZ) ? input.moveZ : 0;
  mx = mx < -1 ? -1 : mx > 1 ? 1 : mx;
  mz = mz < -1 ? -1 : mz > 1 ? 1 : mz;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }
  if (mods.rooted) {
    mx = 0;
    mz = 0;
  }
  const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  const wx = -sy * mz + cy * mx;
  const wz = -cy * mz - sy * mx;

  const inWater = isInWater(cw, st.pos);
  const moving = ml > 0.05 && !mods.rooted;
  const wantSprint = (input.buttons & BTN_SPRINT) !== 0 && mz > 0.3;
  const sprint =
    wantSprint && moving && mods.canSprint && !inWater && !mods.downed && (!mods.ads || mods.sprintAds === true);
  let speed = WALK_SPEED * Math.max(0, mods.speedMul);
  if (mods.downed) speed = WALK_SPEED * DOWNED_MUL * Math.min(1, Math.max(0, mods.speedMul));
  else if (sprint) speed *= SPRINT_MUL;
  else if (mods.ads) speed *= ADS_MUL;
  if (inWater) speed *= WATER_MUL;
  if (mz < -0.1 && !mods.downed) speed *= BACKPEDAL_MUL;

  let tvx = wx * speed;
  let tvz = wz * speed;
  if (st.steep && st.onGround) {
    terrainGrad(cw, st.pos.x, st.pos.z, gradTmp);
    const gl = Math.hypot(gradTmp.x, gradTmp.z) || 1;
    tvx -= (gradTmp.x / gl) * STEEP_SLIDE_SPEED;
    tvz -= (gradTmp.z / gl) * STEEP_SLIDE_SPEED;
  }
  const accel = (st.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt;
  if (mods.rooted && st.onGround) {
    // rooted / stunned: plant the feet immediately
    st.vel.x = 0;
    st.vel.z = 0;
  } else {
    st.vel.x = approach(st.vel.x, tvx, accel);
    st.vel.z = approach(st.vel.z, tvz, accel);
  }

  let wantJump = (input.buttons & BTN_JUMP) !== 0;
  if (!wantJump) {
    for (let i = 0; i < input.actions.length; i++) {
      if (input.actions[i].a === 'jump') {
        wantJump = true;
        break;
      }
    }
  }
  if (wantJump && st.onGround && mods.canJump && !mods.rooted && !mods.downed && !st.steep) {
    st.vel.y = inWater ? JUMP_SPEED * 0.6 : JUMP_SPEED;
    st.onGround = false;
  }
  st.sprinting = sprint;
  moveCharacter(cw, st, st.vel.x * dt, st.vel.z * dt, dt, radius, height);
}

function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}

/**
 * When forced movement (dash / knockback) ends, the unit keeps at most `maxSpeed`
 * of its horizontal velocity instead of sliding on for v²/(2·GROUND_ACCEL) m
 * (SHU-1). Shared by the host (world / troops) and client prediction.
 */
export function brakeForcedEnd(vel: { x: number; z: number }, maxSpeed: number): void {
  const v = Math.hypot(vel.x, vel.z);
  if (!(v > maxSpeed) || v < 1e-9) return;
  const k = maxSpeed / v;
  vel.x *= k;
  vel.z *= k;
}

/** Forced movement (dash / knockback): move with the given horizontal velocity, sliding along walls. */
export function forcedMove(
  cw: CollisionWorld,
  st: MoveState,
  vx: number,
  vz: number,
  dt: number,
  radius = CHAR_RADIUS,
  height = CHAR_HEIGHT,
): void {
  moveCharacter(cw, st, vx * dt, vz * dt, dt, radius, height);
}

/**
 * AI locomotion: steer toward a world-space direction (dirX, dirZ normalised or zero)
 * at `speed` m/s with ground acceleration, then collide.
 */
export function steerMove(
  cw: CollisionWorld,
  st: MoveState,
  dirX: number,
  dirZ: number,
  speed: number,
  dt: number,
  radius = CHAR_RADIUS,
  height = CHAR_HEIGHT,
  jump = false,
): void {
  const inWater = isInWater(cw, st.pos);
  const sp = inWater ? speed * WATER_MUL : speed;
  const accel = (st.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt;
  st.vel.x = approach(st.vel.x, dirX * sp, accel);
  st.vel.z = approach(st.vel.z, dirZ * sp, accel);
  if (jump && st.onGround && !st.steep) {
    st.vel.y = JUMP_SPEED;
    st.onGround = false;
  }
  moveCharacter(cw, st, st.vel.x * dt, st.vel.z * dt, dt, radius, height);
}

/** Does a capsule at `pos` overlap any blocking collider (or sit below the terrain)? */
export function capsuleBlocked(cw: CollisionWorld, pos: Vec3, radius = CHAR_RADIUS, height = CHAR_HEIGHT): boolean {
  const ids = cw.grid.collectRect(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius, cw.scratch);
  const stepTop = pos.y + STEP_HEIGHT;
  const head = pos.y + height - 0.05;
  for (let i = 0; i < ids.length; i++) {
    const sh = cw.shapes[ids[i]];
    if (sh.y1 <= stepTop || sh.y0 >= head) continue;
    if (overlapsFootprint(sh, pos.x, pos.z, radius)) return true;
  }
  return false;
}

/**
 * Find a free standing spot near `pos` (spiral search). Returns a new vector
 * with y on the ground. Falls back to the original xz when nothing is free.
 */
export function findFreeSpot(cw: CollisionWorld, pos: Vec3, radius = CHAR_RADIUS, height = CHAR_HEIGHT, maxDist = 12): Vec3 {
  const lim = cw.half - 2;
  const tryAt = (x: number, z: number): Vec3 | null => {
    if (Math.abs(x) > lim || Math.abs(z) > lim) return null;
    // stay on the requested level: never pop onto roofs / wall tops high above it
    const y = groundAt(cw, x, z, (Number.isFinite(pos.y) ? pos.y : 0) + STEP_HEIGHT + 0.6);
    const p = { x, y, z };
    if (capsuleBlocked(cw, p, radius, height)) return null;
    // avoid spots on terrain steeper than walkable
    terrainGrad(cw, x, z, gradTmp);
    if (Math.abs(y - terrainHeight(cw.map, x, z)) < 0.01 && Math.hypot(gradTmp.x, gradTmp.z) > MAX_SLOPE_TAN) return null;
    return p;
  };
  const direct = tryAt(pos.x, pos.z);
  if (direct) return direct;
  for (let ring = 1; ring * 0.75 <= maxDist; ring++) {
    const r = ring * 0.75;
    const n = Math.max(6, Math.ceil((2 * Math.PI * r) / 0.75));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const p = tryAt(pos.x + Math.cos(a) * r, pos.z + Math.sin(a) * r);
      if (p) return p;
    }
  }
  const cx = Math.max(-lim, Math.min(lim, pos.x));
  const cz = Math.max(-lim, Math.min(lim, pos.z));
  return { x: cx, y: groundAt(cw, cx, cz), z: cz };
}

/**
 * Open ground for something dropped from the sky (airdrops): dry terrain with a
 * walkable slope and no collider taller than a step anywhere over the
 * footprint (roofs, trees, statues, bridge decks…), so it lands within reach.
 * `margin`: minimum distance from the map edge.
 */
export function isOpenGround(cw: CollisionWorld, x: number, z: number, r: number, margin = 2): boolean {
  const lim = cw.half - Math.max(r, margin);
  if (!(Math.abs(x) <= lim && Math.abs(z) <= lim)) return false;
  const t = terrainHeight(cw.map, x, z);
  if (t < cw.map.waterLevel + 0.3) return false;
  terrainGrad(cw, x, z, gradTmp);
  if (Math.hypot(gradTmp.x, gradTmp.z) > MAX_SLOPE_TAN * 0.8) return false;
  const ids = cw.grid.collectRect(x - r, z - r, x + r, z + r, cw.scratch);
  const low = t + STEP_HEIGHT;
  for (let i = 0; i < ids.length; i++) {
    const sh = cw.shapes[ids[i]];
    if (sh.y1 <= low) continue;
    if (overlapsFootprint(sh, x, z, r)) return false;
  }
  return true;
}

export interface OpenGroundOptions {
  /** footprint radius (default 1.2) */
  radius?: number;
  /** minimum distance from the map edge (default 2) */
  margin?: number;
  /** random samples inside maxR before the spiral (default 40) */
  tries?: number;
  /** extra acceptance test, e.g. "on the nav grid's main component" */
  accept?: (p: Vec3) => boolean;
}

/**
 * An open-ground spot (see isOpenGround) near (cx, cz): `tries` random samples
 * inside `maxR` (uniform over the disc, using `rand`), then a deterministic
 * outward spiral up to maxR + 120 m. y is the terrain height. null if none.
 */
export function findOpenGround(cw: CollisionWorld, cx: number, cz: number, maxR: number, rand: () => number, o: OpenGroundOptions = {}): Vec3 | null {
  const r = o.radius ?? 1.2;
  const margin = o.margin ?? 2;
  const R = Math.max(0, maxR);
  const test = (x: number, z: number): Vec3 | null => {
    if (!isOpenGround(cw, x, z, r, margin)) return null;
    const p = { x, y: terrainHeight(cw.map, x, z), z };
    return !o.accept || o.accept(p) ? p : null;
  };
  const tries = o.tries ?? 40;
  for (let i = 0; i < tries; i++) {
    const d = R * Math.sqrt(rand());
    const a = rand() * Math.PI * 2;
    const p = test(cx + Math.cos(a) * d, cz + Math.sin(a) * d);
    if (p) return p;
  }
  const c = test(cx, cz);
  if (c) return c;
  const step = 2;
  for (let ring = 1; ring * step <= R + 120; ring++) {
    const rr = ring * step;
    const n = Math.max(8, Math.ceil((2 * Math.PI * rr) / step));
    const phase = rand() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = phase + (k / n) * Math.PI * 2;
      const p = test(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr);
      if (p) return p;
    }
  }
  return null;
}

// ── Raycasts ────────────────────────────────────────────────────────────────
export interface StaticHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Ray vs terrain heightfield: march + bisection refine. `d` must be normalised. */
export function rayTerrain(
  cw: CollisionWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: StaticHit,
): boolean {
  const map = cw.map;
  let t0 = 0;
  const top = cw.maxTerrain + 0.01;
  if (oy > top) {
    if (dy >= 0) return false;
    t0 = (top - oy) / dy;
    if (t0 > maxDist) return false;
  }
  if (oy + dy * t0 < terrainHeight(map, ox + dx * t0, oz + dz * t0)) {
    // origin below ground (e.g. muzzle clipped into a hill): immediate hit
    if (t0 === 0) {
      out.t = 0;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      return true;
    }
  }
  const horiz = Math.hypot(dx, dz);
  const step = Math.max(0.25, Math.min(1.0, cw.terrainCell * 0.5)) / Math.max(0.2, horiz);
  let prevT = t0;
  let t = t0;
  while (t < maxDist) {
    t = Math.min(maxDist, t + step);
    const y = oy + dy * t;
    if (y > top && dy >= 0) return false;
    const h = terrainHeight(map, ox + dx * t, oz + dz * t);
    if (y <= h) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) * 0.5;
        const my = oy + dy * mid;
        if (my <= terrainHeight(map, ox + dx * mid, oz + dz * mid)) hi = mid;
        else lo = mid;
      }
      const hx = ox + dx * hi;
      const hz = oz + dz * hi;
      terrainGrad(cw, hx, hz, gradTmp);
      const nl = Math.hypot(gradTmp.x, 1, gradTmp.z);
      out.t = hi;
      out.nx = -gradTmp.x / nl;
      out.ny = 1 / nl;
      out.nz = -gradTmp.z / nl;
      return true;
    }
    prevT = t;
    if (t >= maxDist) break;
  }
  return false;
}

/** Ray vs one oriented box / cylinder; returns t (>= 0) or -1 and writes the normal. */
export function rayShape(
  sh: ColShape,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: StaticHit,
): number {
  if (sh.box) {
    const rx = ox - sh.cx;
    const rz = oz - sh.cz;
    const lox = sh.c * rx - sh.s * rz;
    const loz = sh.s * rx + sh.c * rz;
    const loy = oy - sh.cy;
    const ldx = sh.c * dx - sh.s * dz;
    const ldz = sh.s * dx + sh.c * dz;
    const ldy = dy;
    let tmin = -Infinity;
    let tmax = Infinity;
    let axis = -1;
    let sign = 0;
    // x slab
    if (Math.abs(ldx) < 1e-12) {
      if (lox < -sh.hx || lox > sh.hx) return -1;
    } else {
      const inv = 1 / ldx;
      let t1 = (-sh.hx - lox) * inv;
      let t2 = (sh.hx - lox) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = 0;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
    }
    // y slab
    if (Math.abs(ldy) < 1e-12) {
      if (loy < -sh.hy || loy > sh.hy) return -1;
    } else {
      const inv = 1 / ldy;
      let t1 = (-sh.hy - loy) * inv;
      let t2 = (sh.hy - loy) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = 1;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
    }
    // z slab
    if (Math.abs(ldz) < 1e-12) {
      if (loz < -sh.hz || loz > sh.hz) return -1;
    } else {
      const inv = 1 / ldz;
      let t1 = (-sh.hz - loz) * inv;
      let t2 = (sh.hz - loz) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = 2;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
    }
    if (tmax < tmin || tmax < 0) return -1;
    if (tmin < 0) {
      // origin inside the box
      out.t = 0;
      out.nx = -dx;
      out.ny = -dy;
      out.nz = -dz;
      return 0;
    }
    if (tmin > maxT) return -1;
    let lnx = 0;
    let lny = 0;
    let lnz = 0;
    if (axis === 0) lnx = sign;
    else if (axis === 1) lny = sign;
    else lnz = sign;
    out.t = tmin;
    out.nx = sh.c * lnx + sh.s * lnz;
    out.ny = lny;
    out.nz = -sh.s * lnx + sh.c * lnz;
    return tmin;
  }
  const t = rayCylinder(ox, oy, oz, dx, dy, dz, sh.cx, sh.cz, sh.r, sh.y0, sh.y1, maxT, out);
  return t;
}

/** Ray vs finite vertical cylinder (with caps). Returns t or -1 and writes the normal. */
export function rayCylinder(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
  maxT: number,
  out: StaticHit,
): number {
  const px = ox - cx;
  const pz = oz - cz;
  const inside2d = px * px + pz * pz <= r * r;
  if (inside2d && oy >= y0 && oy <= y1) {
    out.t = 0;
    out.nx = -dx;
    out.ny = -dy;
    out.nz = -dz;
    return 0;
  }
  let best = -1;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= maxT) {
        const y = oy + dy * t;
        if (y >= y0 && y <= y1) {
          best = t;
          out.t = t;
          out.nx = (px + dx * t) / r;
          out.ny = 0;
          out.nz = (pz + dz * t) / r;
        }
      }
    }
  }
  // caps
  if (Math.abs(dy) > 1e-12) {
    const capY = dy < 0 ? y1 : y0;
    const t = (capY - oy) / dy;
    if (t >= 0 && t <= maxT && (best < 0 || t < best)) {
      const qx = px + dx * t;
      const qz = pz + dz * t;
      if (qx * qx + qz * qz <= r * r) {
        best = t;
        out.t = t;
        out.nx = 0;
        out.ny = dy < 0 ? 1 : -1;
        out.nz = 0;
      }
    }
  }
  return best;
}

/** Ray vs sphere; returns t or -1. */
export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  maxT: number,
): number {
  const px = ox - cx;
  const py = oy - cy;
  const pz = oz - cz;
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - r * r;
  if (c <= 0) return 0;
  if (b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxT ? t : -1;
}

const shapeHit: StaticHit = { t: 0, nx: 0, ny: 0, nz: 0 };

/** Ray vs static colliders using a 2D DDA through the collider grid. */
export function rayColliders(
  cw: CollisionWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: StaticHit,
): boolean {
  const g = cw.grid;
  const gmin = g.min;
  const gmax = g.min + g.dim * g.cell;
  // clip the ray to the grid square
  let tEnter = 0;
  let tExit = maxDist;
  if (Math.abs(dx) < 1e-12) {
    if (ox < gmin || ox > gmax) return false;
  } else {
    let t1 = (gmin - ox) / dx;
    let t2 = (gmax - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tEnter = Math.max(tEnter, t1);
    tExit = Math.min(tExit, t2);
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < gmin || oz > gmax) return false;
  } else {
    let t1 = (gmin - oz) / dz;
    let t2 = (gmax - oz) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tEnter = Math.max(tEnter, t1);
    tExit = Math.min(tExit, t2);
  }
  if (tEnter > tExit) return false;
  let cx = g.cellCoord(ox + dx * tEnter);
  let cz = g.cellCoord(oz + dz * tEnter);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? g.cell / Math.abs(dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? g.cell / Math.abs(dz) : Infinity;
  let tMaxX = stepX !== 0 ? (gmin + (cx + (stepX > 0 ? 1 : 0)) * g.cell - ox) / dx : Infinity;
  let tMaxZ = stepZ !== 0 ? (gmin + (cz + (stepZ > 0 ? 1 : 0)) * g.cell - oz) / dz : Infinity;
  let best = maxDist;
  let found = false;
  g.beginQuery();
  for (let guard = 0; guard < 4096; guard++) {
    const list = g.cells[cz * g.dim + cx];
    for (let i = 0; i < list.length; i++) {
      const idx = list[i];
      if (!g.visit(idx)) continue;
      const t = rayShape(cw.shapes[idx], ox, oy, oz, dx, dy, dz, best, shapeHit);
      if (t >= 0 && t <= best) {
        best = t;
        found = true;
        out.t = t;
        out.nx = shapeHit.nx;
        out.ny = shapeHit.ny;
        out.nz = shapeHit.nz;
      }
    }
    const tNext = Math.min(tMaxX, tMaxZ);
    if (found && best <= tNext) break;
    if (tNext > tExit) break;
    if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDeltaX;
      if (cx < 0 || cx >= g.dim) break;
    } else {
      cz += stepZ;
      tMaxZ += tDeltaZ;
      if (cz < 0 || cz >= g.dim) break;
    }
  }
  return found;
}

const tHit: StaticHit = { t: 0, nx: 0, ny: 0, nz: 0 };

/** Nearest hit against terrain + static colliders. `d` must be normalised. */
export function raycastStatic(
  cw: CollisionWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: StaticHit,
): boolean {
  let found = false;
  let best = maxDist;
  if (rayColliders(cw, ox, oy, oz, dx, dy, dz, best, tHit)) {
    found = true;
    best = tHit.t;
    out.t = tHit.t;
    out.nx = tHit.nx;
    out.ny = tHit.ny;
    out.nz = tHit.nz;
  }
  if (rayTerrain(cw, ox, oy, oz, dx, dy, dz, best, tHit) && tHit.t <= best) {
    found = true;
    out.t = tHit.t;
    out.nx = tHit.nx;
    out.ny = tHit.ny;
    out.nz = tHit.nz;
  }
  return found;
}

const losHit: StaticHit = { t: 0, nx: 0, ny: 0, nz: 0 };

/** Static line of sight between two points (terrain + colliders). */
export function lineOfSight(cw: CollisionWorld, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  return !raycastStatic(cw, a.x, a.y, a.z, dx / len, dy / len, dz / len, len - 0.05, losHit);
}
