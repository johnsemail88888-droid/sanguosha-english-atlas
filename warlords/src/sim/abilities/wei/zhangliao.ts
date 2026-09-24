// 张辽 Zhang Liao — 辽来 / 突袭 / 威震逍遥津.
import type { Vec3 } from '../../../core/math';
import type { Entity } from '../../../core/types';
import type { AbilityCtx } from '../../api';
import { UNIT_KINDS, crosshairEnemy, enemiesInRadius, param } from '../common';
import { registerAbility } from '../registry';
import { canAct, chestOf, facingOf, flatDist, immobile, setCast, stealOne } from './shared';

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
    if (!t || t === ctx.self || !t.alive) return amount;
    return isBehind(t, ctx.self.pos, param(ctx, 'backArc', 120)) ? amount * param(ctx, 'mul', 1.4) : amount;
  },
});

// 突袭 (Q): blink behind the crosshair target (≤ 12 m), then steal 1 item from up to 2 enemies
// within 6 m (heroes first — only they carry items) and slow them 30 % for 2 s.
function landingSpot(ctx: AbilityCtx, t: Entity): Vec3 | undefined {
  const { sim, self } = ctx;
  const f = facingOf(t);
  const back = t.radius + self.radius + 0.7;
  const side = { x: -f.z, y: 0, z: f.x };
  const toMe = { x: self.pos.x - t.pos.x, z: self.pos.z - t.pos.z };
  const tl = Math.hypot(toMe.x, toMe.z) || 1;
  // behind it, then its flanks, then the near side as a last resort
  const offsets: Vec3[] = [
    { x: -f.x, y: 0, z: -f.z },
    { x: -f.x * 0.7 + side.x * 0.7, y: 0, z: -f.z * 0.7 + side.z * 0.7 },
    { x: -f.x * 0.7 - side.x * 0.7, y: 0, z: -f.z * 0.7 - side.z * 0.7 },
    side,
    { x: -side.x, y: 0, z: -side.z },
    { x: toMe.x / tl, y: 0, z: toMe.z / tl },
  ];
  const tc = chestOf(t);
  for (const o of offsets) {
    const x = t.pos.x + o.x * back;
    const z = t.pos.z + o.z * back;
    const y = sim.groundHeight(x, z);
    if (Math.abs(y - t.pos.y) > 1.5) continue; // ledge / roof edge
    if (!sim.lineOfSight(tc, { x, y: y + 1, z })) continue; // wall behind it
    return { x, y, z };
  }
  return undefined;
}

registerAbility({
  id: 'zhangliao_tuxi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx) || immobile(sim, self)) return false;
    const target = crosshairEnemy(ctx, param(ctx, 'range', 12));
    if (!target) return false;
    const spot = landingSpot(ctx, target);
    if (!spot) return false;
    sim.teleport(self.id, spot);
    setCast(ctx, { pos: self.pos, target: target.id });
    // victims: up to maxTargets enemies around the landing spot, heroes first
    const radius = param(ctx, 'radius', 6);
    const all = enemiesInRadius(sim, self, self.pos, radius, UNIT_KINDS).filter((u) => u !== self && u.alive && !u.hero?.dead);
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
