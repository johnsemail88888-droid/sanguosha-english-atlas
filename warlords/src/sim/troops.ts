// 带兵: squad spawning, the follow-formation layout, the shared AI-unit driver
// (movement, separation, commander clearance, facing, firing with accuracy)
// and turrets.
//
// Follow formation (followSlot): the third-person camera hangs 2.8 m behind the
// commander's RIGHT shoulder (sim/aim.ts cameraRig), so soldiers take a wedge
// behind-LEFT plus the flanks, every slot ≥ 4 m from the commander (a brain
// that stops ~1 m short of its slot still stands ≥ FORMATION_MIN_DIST = 3 m
// away) and clear of the camera boom; deeper ranks stand behind the camera.
// Whatever their brain asks, own soldiers (driveUnit → commanderRules):
//  - inside the camera boom (< BOOM_CLEAR from it) walk straight out of it at
//    full speed; in a band around it they slow to a stop on its edge, and one
//    pressing on it walks around it instead (behind the camera) for up to
//    AROUND_MAX s, then waits at the edge;
//  - inside COMMANDER_CLEARANCE likewise walk straight out, slow down toward
//    him within a band around it (walking around him), and are pushed out positionally at
//    the end of their step (enforceClearance: radially, else sideways / along
//    walls). Only a soldier boxed in by walls on every side the push could take
//    (or on another level, |dy| > 2.5 m) can end a tick closer.
import type { Vec3 } from '../core/math';
import type { Entity, EntityId } from '../core/types';
import type { TroopTypeDef, WeaponDef } from '../data/types';
import { UNIT_KINDS } from './ai/perception';
import { newIntent, resetIntent } from './ai/types';
import type { TroopBrain, UnitIntent } from './ai/types';
import { unitFire } from './combat';
import { troopDef, weaponDef } from './defs';
import { CAM_DISTANCE, CAM_SHOULDER } from './aim';
import { brakeForcedEnd, findFreeSpot, forcedMove, moveCharacter, steerMove } from './physics';
import type { MoveState } from './physics';
import { controlState, findStatus, statusSpeedMul, statusValue } from './status';
import type { ControlState } from './status';
import type { World } from './world';

/** Collision capsule for a unit type (big NPCs / riders are larger). */
export function unitSize(def: TroopTypeDef): { radius: number; height: number } {
  if (def.visual.body === 'huge' || def.visual.mountedOn === 'elephant') return { radius: 1.3, height: 3.2 };
  if (def.visual.mountedOn === 'horse') return { radius: 0.6, height: 2.3 };
  if (def.visual.body === 'heavy') return { radius: 0.45, height: 1.85 };
  return { radius: 0.4, height: 1.8 };
}

// ── follow formation ────────────────────────────────────────────────────────
/** Own soldiers never stand closer than this (m, centre to centre) to their commander. */
export const COMMANDER_CLEARANCE = 1.2;
/** Soldiers in follow formation stand at least this far from the commander (slots are ≥ 1 m farther). */
export const FORMATION_MIN_DIST = 3;
/**
 * Camera boom in commander-local coordinates (right, back): from the feet to a
 * little past the camera (behind the right shoulder); soldiers keep BOOM_CLEAR
 * away from that segment.
 */
const BOOM_END_R = CAM_SHOULDER * 1.12;
const BOOM_END_B = CAM_DISTANCE + 0.4;
const BOOM_LEN2 = BOOM_END_R * BOOM_END_R + BOOM_END_B * BOOM_END_B;
/** Own soldiers closer than this to the camera boom walk straight out of it. */
export const BOOM_CLEAR = 1.3;
/** …and within this band outside it they slow down to a stop on its edge (no jitter). */
const BOOM_BAND = 0.5;
/** Band outside COMMANDER_CLEARANCE where soldiers slow down toward their commander and drift away. */
const CLEAR_BAND = 0.8;
/**
 * A soldier whose goal keeps pointing into the boom / its commander walks around
 * the edge for at most this long (s), then just waits at the edge — its goal is
 * inside (unreachable), not across. Pressing on the edge again after a 0.5 s
 * break starts a new walk-around.
 */
const AROUND_MAX = 3;
const aroundMem = new WeakMap<Entity, { since: number; last: number }>();

/** May `u` (pressing on an edge now) still walk around it? */
function mayWalkAround(u: Entity, now: number): boolean {
  let m = aroundMem.get(u);
  if (!m) {
    m = { since: now, last: now };
    aroundMem.set(u, m);
  } else if (now - m.last > 0.5) {
    m.since = now;
  }
  m.last = now;
  return now - m.since < AROUND_MAX;
}

/**
 * Follow slots as (right, back) offsets in metres: flanks and a wedge
 * behind-left first, then ranks behind the camera. Every slot is ≥ 4 m from
 * the commander and ≥ BOOM_CLEAR + 1 m from the camera boom. Slots past the
 * table extend the ranks backwards.
 */
const FOLLOW_SLOTS: readonly (readonly [number, number])[] = [
  [-4.0, 1.0], // left flank
  [-3.0, 3.4], // behind-left
  [4.0, 0.6], // right flank (clear of the boom)
  [-1.0, 5.2], // behind, behind the camera
  [-5.4, 3.0],
  [2.6, 5.6],
  [-4.4, 6.0],
  [5.6, 2.6],
  [0.8, 7.2],
  [-6.8, 5.0],
  [-2.4, 8.2],
  [4.4, 7.4],
];

/** Local (right, back) offset of follow slot `slot`. */
export function followOffset(slot: number): { right: number; back: number } {
  const i = Math.max(0, Math.floor(slot));
  if (i < FOLLOW_SLOTS.length) return { right: FOLLOW_SLOTS[i][0], back: FOLLOW_SLOTS[i][1] };
  const k = i - FOLLOW_SLOTS.length;
  const rank = Math.floor(k / 3);
  return { right: [-3.2, 0, 3.2][k % 3] - (rank % 2) * 1.2, back: 9.6 + rank * 1.8 };
}

/**
 * World position of follow-formation slot `slot` for a commander (yaw 0 faces
 * −z; right = (cos yaw, −sin yaw)). Troop brains steer to it on 'follow'.
 */
export function followSlot(cmd: Entity, slot: number): Vec3 {
  const o = followOffset(slot);
  const fx = -Math.sin(cmd.yaw);
  const fz = -Math.cos(cmd.yaw);
  const rx = Math.cos(cmd.yaw);
  const rz = -Math.sin(cmd.yaw);
  return { x: cmd.pos.x - fx * o.back + rx * o.right, y: cmd.pos.y, z: cmd.pos.z - fz * o.back + rz * o.right };
}

/** Distance of a commander-local point (right, back) from the camera boom segment. */
export function boomDistance(right: number, back: number): number {
  const t = Math.max(0, Math.min(1, (right * BOOM_END_R + back * BOOM_END_B) / BOOM_LEN2));
  return Math.hypot(right - BOOM_END_R * t, back - BOOM_END_B * t);
}

export function spawnSquad(
  w: World,
  commander: Entity,
  troopType: string,
  count: number,
  pos?: Vec3,
  temporary?: number,
): Entity[] {
  const h = commander.hero;
  if (!h || count <= 0) return [];
  const def = troopDef(troopType, commander.kingdom);
  const size = unitSize(def);
  const hpMul = w.modifiers(commander.id).troopHpMul;
  const center = pos ?? commander.pos;
  // at (or right next to) the commander: straight into follow formation, out of his camera
  const atCommander = !pos || Math.hypot(pos.x - commander.pos.x, pos.z - commander.pos.z) < 4;
  const used = new Set<number>();
  for (const id of h.squad) {
    const t = w.get(id);
    if (t?.troop) used.add(t.troop.slot);
  }
  const out: Entity[] = [];
  for (let i = 0; i < count; i++) {
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    let want: Vec3;
    if (atCommander) {
      want = followSlot(commander, slot);
    } else {
      const a = ((out.length + 0.5) / Math.max(1, count)) * Math.PI * 2 + commander.yaw;
      const r = 2 + (i % 3) * 0.6;
      want = { x: center.x + Math.cos(a) * r, y: center.y, z: center.z + Math.sin(a) * r };
    }
    const p = findFreeSpot(w.cw, want, size.radius, size.height, 8);
    const hp = Math.round(def.hp * hpMul);
    const e = w.createEntity('troop', p, {
      radius: size.radius,
      height: size.height,
      hp,
      kingdom: def.kingdom === 'neutral' ? commander.kingdom : def.kingdom,
      ownerId: commander.id,
      yaw: commander.yaw,
    });
    e.troop = {
      troopType: def.id,
      commanderId: commander.id,
      slot,
      nextFireAt: w.time + 0.5 + w.rng.next() * 0.5,
      mag: weaponDef(def.weapon).magSize,
      reloadUntil: 0,
      ai: {},
    };
    if (temporary !== undefined && temporary > 0) w.setExpiry(e.id, w.time + temporary);
    h.squad.push(e.id);
    out.push(e);
  }
  return out;
}

// ── shared unit driver ──────────────────────────────────────────────────────
/** Result of commanderRules: the move direction to use, and whether it overrides the brain. */
const rule = { x: 0, z: 0, hard: false };

/** Is `cmd` a living commander on the same level as his soldier `u` (the rules apply)? */
function commanderNear(u: Entity, cmd: Entity | undefined): cmd is Entity {
  return !!cmd && cmd.alive && !cmd.hero?.dead && Math.abs(u.pos.y - cmd.pos.y) <= 2.5;
}

/**
 * The commander's rules on an own soldier's move direction (mx, mz), after
 * separation (see the file header). Writes `rule`: hard = walk straight out of
 * the camera boom / personal space at full speed, whatever the brain asked.
 */
function commanderRules(u: Entity, cmd: Entity, mx: number, mz: number, now: number, speed: number): void {
  rule.x = mx;
  rule.z = mz;
  rule.hard = false;
  const dx = u.pos.x - cmd.pos.x;
  const dz = u.pos.z - cmd.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > BOOM_END_B + BOOM_CLEAR + BOOM_BAND + 0.5) return;
  // away from the commander (exactly on top of him: to the left, the formation side)
  const nx = d > 1e-4 ? dx / d : -Math.cos(cmd.yaw);
  const nz = d > 1e-4 ? dz / d : Math.sin(cmd.yaw);
  // away from the camera boom (feet → behind the right shoulder), in world space
  const rx = Math.cos(cmd.yaw);
  const rz = -Math.sin(cmd.yaw);
  const bx = Math.sin(cmd.yaw); // back = −forward
  const bz = Math.cos(cmd.yaw);
  const right = dx * rx + dz * rz;
  const back = dx * bx + dz * bz;
  const t = Math.max(0, Math.min(1, (right * BOOM_END_R + back * BOOM_END_B) / BOOM_LEN2));
  let pr = right - BOOM_END_R * t;
  let pb = back - BOOM_END_B * t;
  const bd = Math.hypot(pr, pb);
  if (bd > 1e-4) {
    pr /= bd;
    pb /= bd;
  } else {
    // on the boom line: out to the left (the formation side)
    pr = -1;
    pb = 0;
  }
  let ox = rx * pr + bx * pb;
  let oz = rz * pr + bz * pb;
  const inBoom = bd < BOOM_CLEAR;
  const inSpace = d < COMMANDER_CLEARANCE;
  if (inBoom) {
    // the boom sweeps with the commander: when it moves toward this side faster
    // than the soldier can walk away (a strafing / turning commander), crossing
    // its line gets the soldier out sooner
    const vo = cmd.vel.x * ox + cmd.vel.z * oz;
    const tOut = speed - vo > 1e-3 ? (BOOM_CLEAR - bd) / (speed - vo) : Infinity;
    const tAcross = speed + vo > 1e-3 ? (BOOM_CLEAR + bd) / (speed + vo) : Infinity;
    if (tAcross < tOut) {
      ox = -ox;
      oz = -oz;
    }
  }
  if (inBoom || inSpace) {
    let hx = (inBoom ? ox : 0) + (inSpace ? nx : 0);
    let hz = (inBoom ? oz : 0) + (inSpace ? nz : 0);
    const l = Math.hypot(hx, hz);
    if (l < 1e-3) {
      hx = ox;
      hz = oz;
    } else {
      hx /= l;
      hz /= l;
    }
    rule.x = hx;
    rule.z = hz;
    rule.hard = true;
    return;
  }
  const m0 = Math.hypot(mx, mz);
  let x = mx;
  let z = mz;
  let around: boolean | undefined;
  // the bands: a soft wall — the inward component is scaled down to nothing at
  // the edge (soldiers settle on it without jitter) — and a soldier pressing on
  // it walks around instead: around the far end of the boom (behind the camera,
  // out of view; ties to the left) — or, ahead of the commander, around his
  // front — and around the commander toward the side it leans to (ties:
  // behind-left, the formation side)
  if (bd < BOOM_CLEAR + BOOM_BAND) {
    const dot = x * ox + z * oz;
    if (dot < 0) {
      x -= ox * dot;
      z -= oz * dot;
      around = mayWalkAround(u, now);
      if (around) {
        const fb = t > 0 ? 0.96 : -0.96;
        aroundEdge(x, z, ox, oz, fb * bx - 0.29 * rx, fb * bz - 0.29 * rz, m0, 1);
        x = rule.x;
        z = rule.z;
      }
      const f = (bd - BOOM_CLEAR) / BOOM_BAND;
      x += ox * dot * f;
      z += oz * dot * f;
    }
  }
  if (d < COMMANDER_CLEARANCE + CLEAR_BAND) {
    const dot = x * nx + z * nz;
    if (dot < 0) {
      x -= nx * dot;
      z -= nz * dot;
      if (around ?? mayWalkAround(u, now)) {
        aroundEdge(x, z, nx, nz, (bx - rx) * Math.SQRT1_2, (bz - rz) * Math.SQRT1_2, m0, 0.3);
        x = rule.x;
        z = rule.z;
      }
      const f = (d - COMMANDER_CLEARANCE) / CLEAR_BAND;
      x += nx * dot * f;
      z += nz * dot * f;
    }
    // and drift out of his way
    const k = ((COMMANDER_CLEARANCE + CLEAR_BAND - d) / CLEAR_BAND) * 0.6;
    x += nx * k;
    z += nz * k;
  }
  const l = Math.hypot(x, z);
  if (l > 1) {
    x /= l;
    z /= l;
  }
  rule.x = x;
  rule.z = z;
}

/**
 * (x, z): a move of speed `m0` with its component into an edge (outward normal
 * (ox, oz)) dropped. Writes to rule.x/z a move along the edge at speed m0, on
 * the side that the remaining move leans to plus `weight` × the preferred
 * direction (px, pz) (unit) — weight 1 overrides any lean of a move that went
 * into the edge at all; a small weight only breaks ties.
 */
function aroundEdge(x: number, z: number, ox: number, oz: number, px: number, pz: number, m0: number, weight: number): void {
  let tx = -oz;
  let tz = ox;
  if (m0 < 1e-6) {
    rule.x = 0;
    rule.z = 0;
    return;
  }
  if ((x * tx + z * tz) / m0 + weight * (tx * px + tz * pz) < 0) {
    tx = -tx;
    tz = -tz;
  }
  rule.x = tx * m0;
  rule.z = tz * m0;
}

/** Push directions tried by enforceClearance, relative to straight away from the commander (rad). */
const CLEAR_TRIES = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4];
const clearSave = { x: 0, y: 0, z: 0, vy: 0, onGround: true, steep: false, inWater: false };
const clearBest = { x: 0, y: 0, z: 0, vy: 0, onGround: true, steep: false, inWater: false };

function saveMove(st: MoveState, out: typeof clearSave): void {
  out.x = st.pos.x;
  out.y = st.pos.y;
  out.z = st.pos.z;
  out.vy = st.vel.y;
  out.onGround = st.onGround;
  out.steep = st.steep === true;
  out.inWater = st.inWater === true;
}

function loadMove(st: MoveState, from: typeof clearSave): void {
  st.pos.x = from.x;
  st.pos.y = from.y;
  st.pos.z = from.z;
  st.vel.y = from.vy;
  st.onGround = from.onGround;
  st.steep = from.steep;
  st.inWater = from.inWater;
}

/**
 * Hard constraint: an own soldier ends its step at least COMMANDER_CLEARANCE
 * from its commander. A positional push (with collision): straight away from
 * him, else — against a wall, a pillar or a slope too steep to climb — at
 * 45°, 90°, 135° off that line (the side the soldier is already moving to
 * first), each just long enough to reach the clearance; boxed in on every
 * side, it keeps the farthest spot any of them reached.
 */
function enforceClearance(w: World, u: Entity, cmd: Entity, st: MoveState): void {
  const d = Math.hypot(u.pos.x - cmd.pos.x, u.pos.z - cmd.pos.z);
  if (d >= COMMANDER_CLEARANCE) return;
  const dx = u.pos.x - cmd.pos.x;
  const dz = u.pos.z - cmd.pos.z;
  const nx = d > 1e-4 ? dx / d : -Math.cos(cmd.yaw);
  const nz = d > 1e-4 ? dz / d : Math.sin(cmd.yaw);
  // turn first toward the side the soldier (or else its commander) is moving to
  const side = (u.vel.x - cmd.vel.x) * -nz + (u.vel.z - cmd.vel.z) * nx >= 0 ? 1 : -1;
  const vx = u.vel.x;
  const vz = u.vel.z;
  saveMove(st, clearSave);
  let bestD = d;
  saveMove(st, clearBest);
  const R = COMMANDER_CLEARANCE + 1e-3;
  for (let i = 0; i < CLEAR_TRIES.length; i++) {
    const a = CLEAR_TRIES[i] * side;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ux = nx * c - nz * s;
    const uz = nx * s + nz * c;
    // distance along (ux, uz) that ends exactly R from the commander
    const m = -d * c + Math.sqrt(Math.max(0, R * R - d * d * s * s));
    if (i > 0) loadMove(st, clearSave);
    moveCharacter(w.cw, st, ux * m, uz * m, 0, u.radius, u.height);
    const nd = Math.hypot(u.pos.x - cmd.pos.x, u.pos.z - cmd.pos.z);
    if (nd >= COMMANDER_CLEARANCE) {
      bestD = nd;
      saveMove(st, clearBest);
      break;
    }
    if (nd > bestD + 1e-6) {
      bestD = nd;
      saveMove(st, clearBest);
    }
  }
  loadMove(st, clearBest);
  // a positional correction, not a velocity change
  u.vel.x = vx;
  u.vel.z = vz;
}

const cs: ControlState = { stunned: false, rooted: false, silenced: false, disarmed: false, dancing: false, frozen: false };
const intent = newIntent();
const moveSt: MoveState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };

interface FireState {
  nextFireAt: number;
  mag: number;
  reloadUntil: number;
}

/**
 * Execute an intent for an AI unit: forced movement / steering with
 * separation, facing, and firing (range, LOS, fire rate, magazine).
 * Returns the (possibly updated) fire state.
 */
export function driveUnit(
  w: World,
  u: Entity,
  it: UnitIntent,
  baseSpeed: number,
  weapon: WeaponDef,
  accuracy: number,
  attackRange: number,
  fire: FireState,
  dmgMul: number,
  dt: number,
): void {
  const now = w.time;
  controlState(u, now, cs);
  // movement
  moveSt.pos = u.pos;
  moveSt.vel = u.vel;
  moveSt.onGround = u.onGround;
  moveSt.steep = false;
  const cmd = u.troop ? w.get(u.troop.commanderId) : undefined;
  const own = commanderNear(u, cmd) ? cmd : undefined;
  if (u.forced && now < u.forced.until) {
    forcedMove(w.cw, moveSt, u.forced.vel.x, u.forced.vel.z, dt, u.radius, u.height);
  } else {
    if (u.forced) {
      // forced movement over: stop at the unit's own speed instead of sliding on (SHU-1)
      u.forced = undefined;
      brakeForcedEnd(u.vel, baseSpeed);
    }
    const still = cs.stunned || cs.rooted;
    let mx = still ? 0 : it.moveX;
    let mz = still ? 0 : it.moveZ;
    let speedMul = it.speedMul;
    if (!cs.stunned) {
      // soft separation from nearby units
      let sx = 0;
      let sz = 0;
      const r0 = u.radius;
      w.unitGrid().forEachNear(u.pos.x, u.pos.z, r0 + 1.5, (o) => {
        if (o === u || !o.alive || (o.kind !== 'troop' && o.kind !== 'npc' && o.kind !== 'hero')) return;
        const dx = u.pos.x - o.pos.x;
        const dz = u.pos.z - o.pos.z;
        const d = Math.hypot(dx, dz);
        const min = r0 + o.radius + 0.25;
        if (d < min && d > 1e-4 && Math.abs(u.pos.y - o.pos.y) < 1.5) {
          const k = (min - d) / min;
          sx += (dx / d) * k;
          sz += (dz / d) * k;
        }
      });
      if (sx !== 0 || sz !== 0) {
        mx += sx * 1.2;
        mz += sz * 1.2;
        const l = Math.hypot(mx, mz);
        if (l > 1) {
          mx /= l;
          mz /= l;
        }
      }
      // own soldiers: out of the commander's personal space and third-person camera
      if (own && !still) {
        commanderRules(u, own, mx, mz, now, baseSpeed * Math.max(1, speedMul) * statusSpeedMul(u, now));
        mx = rule.x;
        mz = rule.z;
        if (rule.hard) speedMul = Math.max(1, speedMul);
      }
    }
    const speed = baseSpeed * speedMul * statusSpeedMul(u, now);
    steerMove(w.cw, moveSt, mx, mz, speed, dt, u.radius, u.height, it.jump && !cs.stunned && !cs.rooted && !cs.frozen);
  }
  if (commanderNear(u, cmd)) enforceClearance(w, u, cmd, moveSt);
  w.markUnitMoved(u.id);
  u.onGround = moveSt.onGround;
  // facing
  if (!cs.stunned) {
    if (!Number.isNaN(it.faceYaw)) u.yaw = turnToward(u.yaw, it.faceYaw, 10 * dt);
    else if (Math.hypot(u.vel.x, u.vel.z) > 0.5) u.yaw = turnToward(u.yaw, Math.atan2(-u.vel.x, -u.vel.z), 8 * dt);
  }
  // reload
  if (fire.reloadUntil > 0 && now >= fire.reloadUntil) {
    fire.reloadUntil = 0;
    fire.mag = Math.max(1, weapon.magSize);
  }
  // firing
  if (it.targetId === undefined || cs.stunned || cs.disarmed || cs.dancing) return;
  if (fire.reloadUntil > 0 || now < fire.nextFireAt) return;
  const target = w.get(it.targetId);
  if (!target || !target.alive || target.hero?.dead) return;
  const d = Math.hypot(target.pos.x - u.pos.x, target.pos.z - u.pos.z) - target.radius - u.radius;
  const reach = weapon.melee ? Math.max(weapon.melee.range, attackRange) : Math.min(attackRange, weapon.maxRange);
  if (d > reach) return;
  if (weapon.melee) {
    // must roughly face the target
    const want = Math.atan2(-(target.pos.x - u.pos.x), -(target.pos.z - u.pos.z));
    if (Math.abs(wrap(want - u.yaw)) > 0.9) return;
  }
  const rate = weapon.fireRate * statusValue(u, 'fireRateUp', now, 1);
  if (unitFire(w, u, target, weapon, accuracy, dmgMul)) {
    fire.nextFireAt = now + 1 / Math.max(0.05, rate) * (0.9 + w.rng.next() * 0.2);
    if (!weapon.melee && weapon.magSize > 0 && !findStatus(u, 'noReload', now)) {
      fire.mag--;
      if (fire.mag <= 0) fire.reloadUntil = now + weapon.reloadTime;
    }
  } else {
    fire.nextFireAt = now + 0.25;
  }
}

const wrap = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
};

function turnToward(cur: number, target: number, maxStep: number): number {
  const d = wrap(target - cur);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export function updateTroops(w: World, list: readonly Entity[], brain: TroopBrain, dt: number): void {
  for (const u of list) {
    if (!u.alive || !u.troop) continue;
    const tr = u.troop;
    const def = troopDef(tr.troopType);
    resetIntent(intent);
    try {
      brain.think(w, u, dt, intent);
    } catch (err) {
      w.warn('troopBrain', `troop brain threw: ${String(err)}`);
    }
    const weapon = weaponDef(def.weapon);
    driveUnit(w, u, intent, def.speed, weapon, def.accuracy, def.attackRange, tr, 1, dt);
  }
}

// ── turrets ─────────────────────────────────────────────────────────────────
const TURRET_ACCURACY = 0.6;

export function updateTurrets(w: World, list: readonly Entity[], dt: number): void {
  const now = w.time;
  for (const t of list) {
    const tu = t.turret;
    if (!t.alive || !tu) continue;
    if (now >= tu.expiresAt) {
      w.killUnit(t, undefined);
      continue;
    }
    const weapon = weaponDef(tu.weaponId);
    const range = Math.min(weapon.maxRange, 45);
    const ai = w.turretAi(t.id);
    if (now >= ai.nextScan) {
      ai.nextScan = now + 0.3;
      let best: Entity | undefined;
      let bd = Infinity;
      for (const c of w.queryRadius(t.pos, range, { kinds: UNIT_KINDS, exclude: [t.id] })) {
        if (c.hero?.dead || !w.isHostileTo(t, c) || findStatus(c, 'untargetable', now) || !w.canSee(t, c)) continue;
        const d = Math.hypot(c.pos.x - t.pos.x, c.pos.z - t.pos.z);
        if (d < bd && w.lineOfSight(w.eyePos(t), w.centerOf(c))) {
          bd = d;
          best = c;
        }
      }
      tu.targetId = best?.id;
    }
    const target = tu.targetId !== undefined ? w.get(tu.targetId) : undefined;
    if (!target || !target.alive || target.hero?.dead) {
      tu.targetId = undefined;
      continue;
    }
    t.yaw = Math.atan2(-(target.pos.x - t.pos.x), -(target.pos.z - t.pos.z));
    if (now < tu.nextFireAt || findStatus(t, 'stun', now)) continue;
    const rate = weapon.fireRate * statusValue(t, 'fireRateUp', now, 1);
    // commander troopDmgMul is applied by the damage pipeline
    if (unitFire(w, t, target, weapon, TURRET_ACCURACY)) tu.nextFireAt = now + 1 / Math.max(0.05, rate);
    else tu.nextFireAt = now + 0.3;
    void dt;
  }
}

/** Troop ids of a commander that are still alive. */
export function aliveSquad(w: World, commander: Entity): EntityId[] {
  return (commander.hero?.squad ?? []).filter((id) => w.get(id)?.alive);
}
