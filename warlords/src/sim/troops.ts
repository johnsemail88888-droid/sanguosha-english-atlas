// 带兵: squad spawning, the follow-formation layout, the shared AI-unit driver
// (movement, separation, commander clearance, facing, firing with accuracy)
// and turrets.
//
// Follow formation (followSlot): the third-person camera hangs 2.8 m behind the
// commander's RIGHT shoulder (sim/aim.ts cameraRig), so soldiers take a wedge
// behind-LEFT plus the flanks, every slot ≥ 3 m from the commander and clear of
// the camera boom; deeper ranks stand behind the camera (out of view). Own
// soldiers never stand closer than COMMANDER_CLEARANCE to their commander and
// are nudged out of the camera boom (driveUnit), whatever their brain asks.
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
/** Follow-formation slots are at least this far from the commander. */
export const FORMATION_MIN_DIST = 3;
/**
 * Camera boom in commander-local coordinates (right, back): from the feet to a
 * little past the camera (behind the right shoulder); soldiers keep BOOM_CLEAR
 * away from that segment.
 */
const BOOM_END_R = CAM_SHOULDER * 1.12;
const BOOM_END_B = CAM_DISTANCE + 0.4;
const BOOM_CLEAR = 1.3;

/**
 * Follow slots as (right, back) offsets in metres: flanks and a wedge
 * behind-left first, then ranks behind the camera. Slots past the table extend
 * the ranks backwards.
 */
const FOLLOW_SLOTS: readonly (readonly [number, number])[] = [
  [-3.0, 1.0], // left flank
  [-2.4, 3.2], // behind-left
  [3.2, 0.6], // right flank (clear of the boom)
  [-0.8, 4.6], // behind, behind the camera
  [-4.6, 2.6],
  [2.2, 4.8],
  [-3.8, 5.4],
  [5.0, 2.2],
  [0.6, 6.4],
  [-6.0, 4.2],
  [-2.2, 7.4],
  [3.8, 6.6],
];

/** Local (right, back) offset of follow slot `slot`. */
export function followOffset(slot: number): { right: number; back: number } {
  const i = Math.max(0, Math.floor(slot));
  if (i < FOLLOW_SLOTS.length) return { right: FOLLOW_SLOTS[i][0], back: FOLLOW_SLOTS[i][1] };
  const k = i - FOLLOW_SLOTS.length;
  const rank = Math.floor(k / 3);
  return { right: [-3, 0, 3][k % 3] - (rank % 2) * 1.2, back: 8.6 + rank * 1.8 };
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
  const len2 = BOOM_END_R * BOOM_END_R + BOOM_END_B * BOOM_END_B;
  const t = Math.max(0, Math.min(1, (right * BOOM_END_R + back * BOOM_END_B) / len2));
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
const clearTmp = { x: 0, z: 0 };

/**
 * Steering that keeps an own soldier out of its commander's personal space
 * (< COMMANDER_CLEARANCE + 0.8 m) and camera boom; (0, 0) for everything else.
 */
function commanderClearance(u: Entity, cmd: Entity | undefined, out: { x: number; z: number }): { x: number; z: number } {
  out.x = 0;
  out.z = 0;
  if (!cmd || !cmd.alive || cmd.hero?.dead || Math.abs(u.pos.y - cmd.pos.y) > 2.5) return out;
  const dx = u.pos.x - cmd.pos.x;
  const dz = u.pos.z - cmd.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > BOOM_END_B + BOOM_CLEAR + 1) return out;
  // personal space
  const soft = COMMANDER_CLEARANCE + 0.8;
  if (d < soft) {
    const k = (soft - d) / soft;
    // exactly on top of him: step out to the left (the formation side)
    const nx = d > 1e-4 ? dx / d : -Math.cos(cmd.yaw);
    const nz = d > 1e-4 ? dz / d : Math.sin(cmd.yaw);
    out.x += nx * k * 2;
    out.z += nz * k * 2;
  }
  // camera boom (behind the right shoulder)
  const rx = Math.cos(cmd.yaw);
  const rz = -Math.sin(cmd.yaw);
  const bx = Math.sin(cmd.yaw); // back = −forward
  const bz = Math.cos(cmd.yaw);
  const right = dx * rx + dz * rz;
  const back = dx * bx + dz * bz;
  const bd = boomDistance(right, back);
  if (bd < BOOM_CLEAR) {
    const len2 = BOOM_END_R * BOOM_END_R + BOOM_END_B * BOOM_END_B;
    const t = Math.max(0, Math.min(1, (right * BOOM_END_R + back * BOOM_END_B) / len2));
    let pr = right - BOOM_END_R * t;
    let pb = back - BOOM_END_B * t;
    const pl = Math.hypot(pr, pb);
    if (pl > 1e-4) {
      pr /= pl;
      pb /= pl;
    } else {
      // on the boom line: step out to the left (the formation side)
      pr = -1;
      pb = 0;
    }
    const k = ((BOOM_CLEAR - bd) / BOOM_CLEAR) * 1.6;
    out.x += (rx * pr + bx * pb) * k;
    out.z += (rz * pr + bz * pb) * k;
  }
  return out;
}

/** Hard constraint: an own soldier ends its step at least COMMANDER_CLEARANCE from its commander. */
function enforceClearance(w: World, u: Entity, cmd: Entity | undefined, st: MoveState): void {
  if (!cmd || !cmd.alive || cmd.hero?.dead || Math.abs(u.pos.y - cmd.pos.y) > 2.5) return;
  const dx = u.pos.x - cmd.pos.x;
  const dz = u.pos.z - cmd.pos.z;
  const d = Math.hypot(dx, dz);
  if (d >= COMMANDER_CLEARANCE) return;
  const nx = d > 1e-4 ? dx / d : -Math.cos(cmd.yaw);
  const nz = d > 1e-4 ? dz / d : Math.sin(cmd.yaw);
  const push = COMMANDER_CLEARANCE - d + 1e-3;
  const vx = u.vel.x;
  const vz = u.vel.z;
  moveCharacter(w.cw, st, nx * push, nz * push, 0, u.radius, u.height);
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
  if (u.forced && now < u.forced.until) {
    forcedMove(w.cw, moveSt, u.forced.vel.x, u.forced.vel.z, dt, u.radius, u.height);
  } else {
    if (u.forced) {
      // forced movement over: stop at the unit's own speed instead of sliding on (SHU-1)
      u.forced = undefined;
      brakeForcedEnd(u.vel, baseSpeed);
    }
    let mx = cs.stunned || cs.rooted ? 0 : it.moveX;
    let mz = cs.stunned || cs.rooted ? 0 : it.moveZ;
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
      // own soldiers: out of the commander's personal space and third-person camera
      const c = cmd ? commanderClearance(u, cmd, clearTmp) : undefined;
      if (c) {
        sx += c.x;
        sz += c.z;
      }
      if (sx !== 0 || sz !== 0) {
        mx += sx * 1.2;
        mz += sz * 1.2;
        const l = Math.hypot(mx, mz);
        if (l > 1) {
          mx /= l;
          mz /= l;
        }
      }
    }
    const speed = baseSpeed * it.speedMul * statusSpeedMul(u, now);
    steerMove(w.cw, moveSt, mx, mz, speed, dt, u.radius, u.height, it.jump && !cs.stunned && !cs.rooted && !cs.frozen);
  }
  if (cmd) enforceClearance(w, u, cmd, moveSt);
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
