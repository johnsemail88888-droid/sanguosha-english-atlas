// 大乔 Da Qiao — 流离 (bullet redirect), 国色 (乐不思蜀 dance), 安娴 (group heal).
import type { Entity } from '../../../core/types';
import type { DamageHookCtx, DamageRequest } from '../../api';
import { ext } from '../../ext';
import { UNIT_KINDS, param } from '../common';
import { registerAbility } from '../registry';
import { applyDebuff, centerOf, crosshairFoe, emitTrigger, isUp, setCast } from './util';

/** A weapon bullet (combat.isBulletDamage): only these can be displaced. */
const isBullet = (req: DamageRequest): boolean => req.weaponId !== undefined && (req.type === 'normal' || req.type === 'pierce');

/**
 * Who takes a displaced bullet: a unit within `radius` m that is neither Da Qiao nor on the
 * attacker's side (the pipeline ignores damage to the attacker's own side). Preference:
 * units she knows are hostile → other non-hero units → other heroes → her own soldiers;
 * nearest first within a tier.
 */
function displaceTarget(ctx: DamageHookCtx, radius: number): Entity | undefined {
  const { sim, self, req } = ctx;
  const x = ext(sim);
  const attacker = x.creditOf(req.sourceId);
  let best: Entity | undefined;
  let bestTier = Infinity;
  let bestD = Infinity;
  for (const u of sim.queryRadius(self.pos, radius, { kinds: UNIT_KINDS, exclude: [self.id] })) {
    if (u.hero?.dead || u.id === req.sourceId) continue;
    if (attacker !== undefined && x.creditOf(u.id) === attacker) continue;
    if (sim.hasStatus(u.id, 'untargetable') || sim.hasStatus(u.id, 'invuln')) continue;
    const tier = sim.isOwnSide(self, u) ? 3 : sim.isHostileTo(self, u) ? 0 : u.kind !== 'hero' ? 1 : 2;
    const d = Math.hypot(u.pos.x - self.pos.x, u.pos.z - self.pos.z);
    if (tier < bestTier || (tier === bestTier && d < bestD)) {
      best = u;
      bestTier = tier;
      bestD = d;
    }
  }
  return best;
}

// 流离 (passive): a bullet hitting you has `chance` to be redirected, whole, to another unit
// within `radius` m (not the attacker). The redirected hit is flagged so it never bounces again.
registerAbility({
  id: 'daqiao_liuli',
  modifyIncoming(ctx, amount) {
    const { sim, self, req } = ctx;
    if (req.redirected || !(amount > 0) || !isBullet(req) || !isUp(self)) return amount;
    if (req.sourceId === undefined || req.sourceId === self.id) return amount;
    const other = displaceTarget(ctx, param(ctx, 'radius', 8));
    if (!other || !sim.rng.chance(Math.min(1, Math.max(0, param(ctx, 'chance', 0.3))))) return amount;
    emitTrigger(ctx, { target: other.id, pos: centerOf(other) });
    // the attacker's own modifiers are re-applied against the new victim, so pass the raw amount
    sim.dealDamage({ ...req, targetId: other.id, pos: undefined, head: false, redirected: true });
    return 0;
  },
});

// 国色 (Q): 乐不思蜀 on the crosshair enemy — it dances for `duration` s (no shooting, no
// abilities, half speed). 谦逊-immune targets can't be chosen (no cooldown).
registerAbility({
  id: 'daqiao_guose',
  activate(ctx) {
    if (!isUp(ctx.self)) return false;
    const t = crosshairFoe(ctx, param(ctx, 'range', 20));
    if (!t) return false;
    setCast(ctx, { target: t.id, pos: centerOf(t) });
    return applyDebuff(ctx, t, 'dance', param(ctx, 'duration', 2.5)) !== 'resisted';
  },
});

// 安娴 (E): heal yourself, your soldiers and every other hero within `radius` m for `heal`.
registerAbility({
  id: 'daqiao_anxian',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const amount = param(ctx, 'heal', 80);
    sim.heal(self.id, amount, self.id);
    for (const u of sim.queryRadius(self.pos, param(ctx, 'radius', 8), { kinds: ['hero', 'troop'], exclude: [self.id] })) {
      if (!isUp(u)) continue;
      if (u.kind === 'troop' && !sim.isOwnSide(self, u)) continue;
      sim.heal(u.id, amount, self.id);
    }
    setCast(ctx, { pos: centerOf(self) });
    return true;
  },
});
