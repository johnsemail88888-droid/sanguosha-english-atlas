// 张辽 Zhang Liao — 辽来 / 突袭 / 威震逍遥津.
import type { Vec3 } from '../../../core/math';
import type { Entity } from '../../../core/types';
import type { AbilityCtx } from '../../api';
import { UNIT_KINDS, crosshairEnemy, deny, enemiesInRadius, param } from '../common';
import { registerAbility } from '../registry';
import { canAct, chestOf, facingOf, flatDist, immobile, isReflected, losBetween, setCast, stealOne } from './shared';

// 辽来 (passive): +40 % damage to targets facing away from you — you are inside the rear
// `backArc` (120°) cone centred on the target's back.
export function isBehind(target: Entity, attackerPos: Vec3, backArcDeg: number): boolean {
  const dx = attackerPos.x - target.pos.x;
  const dz = attackerPos.z - target.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return false;
  const f = facingOf(target);
  const cos = (dx * f.x + dz * f.z) / d; // 1 = right in front of its face, −1 = right behind it
  return cos <= -Math.cos(((Math.min(360, Math.max(0, backArcDeg)) / 2) * Math.PI) / 180);
}

registerAbility({
  id: 'zhangliao_liaolai',
  modifyOutgoing(ctx, amount) {
    const t = ctx.other;
    if (!t || t === ctx.self || !t.alive || isReflected(ctx.req)) return amount;
    return isBehind(t, ctx.self.pos, param(ctx, 'backArc', 120)) ? amount * param(ctx, 'mul', 1.4) : amount;
  },
});

// 突袭 (Q): blink behind the crosshair target (≤ 12 m), then steal 1 item from up to 2 enemies
// within 6 m that you can see from the landing spot (heroes first — only they carry items) and
// slow them 30 % for 2 s.
const DOWN = { x: 0, y: -1, z: 0 };
/** How far below / above the target's feet a landing floor may be (a step, a kerb — not a ledge). */
const LEVEL_TOLERANCE = 1.5;

/**
 * The floor at (x, z) on the target's own level: cast down from just above its feet, so a roof
 * or an upper storey over its head is ignored. undefined = a drop (ledge, pit) or inside a wall.
 */
function floorAtLevel(ctx: AbilityCtx, t: Entity, x: number, z: number): number | undefined {
  const top = t.pos.y + 1.2;
  const hit = ctx.sim.raycast({ x, y: top, z }, DOWN, 1.2 + LEVEL_TOLERANCE, { entities: false });
  if (!hit || hit.dist < 0.05) return undefined; // nothing under it, or the ray starts inside geometry
  return hit.point.y;
}

/** Candidate landing spots around `t`: behind it, then its flanks, then the near side as a last resort. */
function landingSpots(ctx: AbilityCtx, t: Entity): Vec3[] {
  const { sim, self } = ctx;
  const f = facingOf(t);
  const back = t.radius + self.radius + 0.7;
  const side = { x: -f.z, y: 0, z: f.x };
  const toMe = { x: self.pos.x - t.pos.x, z: self.pos.z - t.pos.z };
  const tl = Math.hypot(toMe.x, toMe.z) || 1;
  const offsets: Vec3[] = [
    { x: -f.x, y: 0, z: -f.z },
    { x: -f.x * 0.7 + side.x * 0.7, y: 0, z: -f.z * 0.7 + side.z * 0.7 },
    { x: -f.x * 0.7 - side.x * 0.7, y: 0, z: -f.z * 0.7 - side.z * 0.7 },
    side,
    { x: -side.x, y: 0, z: -side.z },
    { x: toMe.x / tl, y: 0, z: toMe.z / tl },
  ];
  const tc = chestOf(t);
  const out: Vec3[] = [];
  for (const o of offsets) {
    const x = t.pos.x + o.x * back;
    const z = t.pos.z + o.z * back;
    const y = floorAtLevel(ctx, t, x, z);
    if (y === undefined) continue;
    if (!sim.lineOfSight(tc, { x, y: y + 1, z })) continue; // wall behind it
    out.push({ x, y, z });
  }
  return out;
}

/**
 * Teleport to the first spot the body really fits: the world's free-spot search may shift a
 * blocked spot (up to 6 m, onto the requested level), so the result is checked — still next
 * to the target and in its line of sight — before it is accepted. Puts the hero back and
 * returns false when no spot works.
 */
function blinkBehind(ctx: AbilityCtx, t: Entity): boolean {
  const { sim, self } = ctx;
  const start = { ...self.pos };
  const maxOff = t.radius + self.radius + 1.6;
  for (const spot of landingSpots(ctx, t)) {
    sim.teleport(self.id, spot);
    if (flatDist(self.pos, t.pos) <= maxOff && Math.abs(self.pos.y - spot.y) < 0.8 && losBetween(sim, self, t)) return true;
  }
  if (flatDist(self.pos, start) > 1e-3 || self.pos.y !== start.y) sim.teleport(self.id, start);
  return false;
}

registerAbility({
  id: 'zhangliao_tuxi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx) || immobile(sim, self)) return deny(ctx, 'blocked');
    const target = crosshairEnemy(ctx, param(ctx, 'range', 12));
    if (!target) return deny(ctx, 'noTarget');
    const start = { ...self.pos };
    if (!blinkBehind(ctx, target)) return deny(ctx, 'blocked');
    // pos = where the blink started (the caster itself is at the landing): the VFX streak
    setCast(ctx, { pos: start, target: target.id });
    // victims: up to maxTargets enemies around the landing spot that he can see, heroes first
    const radius = param(ctx, 'radius', 6);
    const all = enemiesInRadius(sim, self, self.pos, radius, UNIT_KINDS).filter(
      (u) => u !== self && u.alive && !u.hero?.dead && (u === target || losBetween(sim, self, u)),
    );
    all.sort((a, b) => (a.hero ? 0 : 1) - (b.hero ? 0 : 1) || flatDist(a.pos, self.pos) - flatDist(b.pos, self.pos));
    const victims = all.slice(0, Math.max(0, Math.floor(param(ctx, 'maxTargets', 2))));
    const slow = { amount: param(ctx, 'slow', 0.3) };
    const slowTime = param(ctx, 'slowTime', 2);
    for (const v of victims) {
      if (v.hero) stealOne(sim, self, v);
      if (v.alive) sim.applyStatus(v.id, 'slow', slowTime, { sourceId: self.id, params: slow });
    }
    return true;
  },
});

// 威震逍遥津 (E): enemy heroes within 10 m are silenced 2 s and slowed 30 % (2 s); enemy
// soldiers and NPCs are stunned 2.5 s.
registerAbility({
  id: 'zhangliao_weizhen',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const radius = param(ctx, 'radius', 10);
    const silence = param(ctx, 'silence', 2);
    const slow = { amount: param(ctx, 'slow', 0.3) };
    const slowTime = param(ctx, 'slowTime', 2);
    const troopStun = param(ctx, 'troopStun', 2.5);
    for (const u of enemiesInRadius(sim, self, self.pos, radius, ['hero', 'troop', 'npc'])) {
      if (!u.alive || u === self) continue;
      if (u.hero) {
        if (u.hero.dead || u.hero.downed) continue;
        sim.applyStatus(u.id, 'silence', silence, { sourceId: self.id });
        if (u.alive) sim.applyStatus(u.id, 'slow', slowTime, { sourceId: self.id, params: slow });
      } else {
        sim.applyStatus(u.id, 'stun', troopStun, { sourceId: self.id });
      }
    }
    setCast(ctx, { pos: self.pos });
    return true;
  },
});
