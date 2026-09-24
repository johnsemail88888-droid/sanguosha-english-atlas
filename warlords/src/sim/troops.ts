// 带兵: squad spawning, the shared AI-unit driver (movement, separation,
// facing, firing with accuracy) and turrets.
import type { Vec3 } from '../core/math';
import type { Entity, EntityId } from '../core/types';
import type { TroopTypeDef, WeaponDef } from '../data/types';
import { UNIT_KINDS } from './ai/perception';
import { newIntent, resetIntent } from './ai/types';
import type { TroopBrain, UnitIntent } from './ai/types';
import { unitFire } from './combat';
import { troopDef, weaponDef } from './defs';
import { findFreeSpot, forcedMove, steerMove } from './physics';
import type { MoveState } from './physics';
import { controlState, findStatus, statusSpeedMul } from './status';
import type { ControlState } from './status';
import type { World } from './world';

/** Collision capsule for a unit type (big NPCs / riders are larger). */
export function unitSize(def: TroopTypeDef): { radius: number; height: number } {
  if (def.visual.body === 'huge' || def.visual.mountedOn === 'elephant') return { radius: 1.3, height: 3.2 };
  if (def.visual.mountedOn === 'horse') return { radius: 0.6, height: 2.3 };
  if (def.visual.body === 'heavy') return { radius: 0.45, height: 1.85 };
  return { radius: 0.4, height: 1.8 };
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
    const a = ((out.length + 0.5) / Math.max(1, count)) * Math.PI * 2 + commander.yaw;
    const r = 2 + (i % 3) * 0.6;
    const p = findFreeSpot(w.cw, { x: center.x + Math.cos(a) * r, y: center.y, z: center.z + Math.sin(a) * r }, size.radius, size.height, 8);
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
  if (u.forced && now < u.forced.until) {
    forcedMove(w.cw, moveSt, u.forced.vel.x, u.forced.vel.z, dt, u.radius, u.height);
  } else {
    if (u.forced) u.forced = undefined;
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
  const rate = weapon.fireRate * (findStatus(u, 'fireRateUp', now)?.params?.mul ?? 1);
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
    const rate = weapon.fireRate * (findStatus(t, 'fireRateUp', now)?.params?.mul ?? 1);
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
