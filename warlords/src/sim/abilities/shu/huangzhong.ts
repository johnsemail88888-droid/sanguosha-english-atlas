// 黄忠 Huang Zhong — 烈弓 (passive), 百步穿杨 (Q), 老当益壮 (E).
import type { Entity } from '../../../core/types';
import type { DamageHookCtx, SimApi } from '../../api';
import { registerAbility } from '../registry';
import { aimDir, param } from '../common';
import { isDirectHit, setCast } from './util';

/** max flight range of the 百步穿杨 arrow (m) */
const ARROW_RANGE = 250;

/** Is this hit of 黄忠 against a target beyond 烈弓's distance? */
function farShot(ctx: DamageHookCtx, target: Entity | undefined): boolean {
  if (!target || target === ctx.self || !isDirectHit(ctx.req)) return false;
  const a = ctx.self.pos;
  const b = target.pos;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > param(ctx, 'minDist', 30);
}

// 烈弓 (passive): attacks (weapon and ability hits) on targets beyond 30 m can't
// be dodged and deal +25 %. The dodge flag must be set before the dodge checks
// (beforeDamageDealt); the multiplier is an outgoing modifier.
registerAbility({
  id: 'huangzhong_liegong',
  beforeDamageDealt(ctx) {
    if (farShot(ctx, ctx.other)) ctx.req.canDodge = false;
  },
  modifyOutgoing(ctx, amount) {
    return farShot(ctx, ctx.other) ? amount * param(ctx, 'mul', 1.25) : amount;
  },
});

// 百步穿杨 (Q): an armor-piercing arrow (dtype 'pierce' skips armor entirely)
// that passes through up to `pierce` targets. Ability damage, not a weapon hit.
registerAbility({
  id: 'huangzhong_chuanyang',
  activate(ctx) {
    const { sim, self } = ctx;
    const speed = Math.max(20, param(ctx, 'speed', 160));
    const eye = sim.eyePos(self);
    const d = aimDir(ctx, ARROW_RANGE);
    const arrow = sim.spawnProjectile({
      kind: 'arrow',
      ownerId: self.id,
      pos: { x: eye.x + d.x * 0.6, y: eye.y + d.y * 0.6, z: eye.z + d.z * 0.6 },
      vel: { x: d.x * speed, y: d.y * speed, z: d.z * speed },
      damage: param(ctx, 'damage', 140),
      dtype: ctx.def.dtype ?? 'pierce',
      gravity: 0,
      lifetime: ARROW_RANGE / speed,
      pierce: Math.max(0, Math.round(param(ctx, 'pierce', 3))),
      abilityId: ctx.def.id,
      radius: 0.15,
    });
    seedPierceSet(sim, arrow.id);
    setCast(ctx, { dir: d, pos: eye });
    return true;
  },
});

/**
 * Workaround (docs/SIM_REQUESTS.md "piercing projectiles re-hit"): combat.ts
 * updateProjectiles reads World.projPierced once per tick, before the first
 * pierce creates the set, so the arrow re-hits its first target up to 4× in
 * that tick. Creating the (empty) set up front makes the skip list live.
 * Duck-typed: a no-op on any SimApi without that field.
 */
function seedPierceSet(sim: SimApi, projectileId: number): void {
  const m = (sim as unknown as { projPierced?: unknown }).projPierced;
  if (m instanceof Map && !m.has(projectileId)) m.set(projectileId, new Set<number>());
}

// 老当益壮 (E): heal a quarter of your max HP and gain haste.
registerAbility({
  id: 'huangzhong_laodang',
  activate(ctx) {
    const { sim, self } = ctx;
    sim.heal(self.id, self.maxHp * param(ctx, 'healFrac', 0.25), self.id);
    sim.applyStatus(self.id, 'haste', param(ctx, 'duration', 5), { sourceId: self.id, params: { amount: param(ctx, 'haste', 0.3) } });
    setCast(ctx, { target: self.id, pos: sim.eyePos(self) });
    return true;
  },
});
