// 大乔 Da Qiao — 流离 (bullet redirect), 国色 (乐不思蜀 dance), 安娴 (group heal).
import type { Entity } from '../../../core/types';
import type { DamageHookCtx, DamageRequest, SimApi } from '../../api';
import { ext } from '../../ext';
import { UNIT_KINDS, param } from '../common';
import { registerAbility } from '../registry';
import { applyDebuff, centerOf, crosshairFoe, emitTrigger, isUp, knownAlly, publiclyVisible, setCast } from './util';

/** A weapon bullet (combat.isBulletDamage): only these can be displaced. */
const isBullet = (req: DamageRequest): boolean => req.weaponId !== undefined && (req.type === 'normal' || req.type === 'pierce');

/** Clear line between two units: chest to chest, or eye to eye over low cover. */
const inSight = (sim: SimApi, a: Entity, b: Entity): boolean => sim.lineOfSight(centerOf(a), centerOf(b)) || sim.lineOfSight(sim.eyePos(a), sim.eyePos(b));

/**
 * How much Da Qiao would rather hand the bullet to `u` (lower = sooner), from her own
 * knowledge only; −1 = never:
 *   0 standing units she knows are hostile
 *   1 other non-hero units (neutral NPCs, soldiers of heroes she can't place)
 *   2 downed heroes she knows are hostile (it only shortens their bleed-out)
 *   3 other standing heroes (unknown allegiance)
 *   4 her own soldiers / summons and her known allies' soldiers
 *  −1 known-allied heroes (her Lord as a loyalist…) and every other downed hero — a
 *     downed friend bleeds out 0.1 s per point, so a volley would finish him.
 */
function displaceTier(sim: SimApi, self: Entity, u: Entity): number {
  const own = sim.isOwnSide(self, u);
  const hostile = !own && sim.isHostileTo(self, u);
  if (u.kind === 'hero') {
    if (u.hero?.downed) return hostile ? 2 : -1;
    if (hostile) return 0;
    return knownAlly(sim, self, u) ? -1 : 3;
  }
  if (own || knownAlly(sim, self, u)) return 4;
  return hostile ? 0 : 1;
}

/**
 * Who takes a displaced bullet: a unit within `radius` m that the attacker can hurt (not
 * the attacker or its own side), that Da Qiao can see (line of sight, not hidden by
 * stealth) and that is a valid pick (displaceTier); best tier, then nearest.
 */
function displaceTarget(ctx: DamageHookCtx, radius: number): Entity | undefined {
  const { sim, self, req } = ctx;
  const x = ext(sim);
  const attacker = x.creditOf(req.sourceId);
  let best: Entity | undefined;
  let bestTier = Infinity;
  let bestD = Infinity;
  for (const u of sim.queryRadius(self.pos, radius, { kinds: UNIT_KINDS, exclude: [self.id] })) {
    if (!u.alive || u.hero?.dead || u.id === req.sourceId) continue;
    if (attacker !== undefined && x.creditOf(u.id) === attacker) continue;
    if (sim.hasStatus(u.id, 'untargetable') || sim.hasStatus(u.id, 'invuln')) continue;
    const tier = displaceTier(sim, self, u);
    if (tier < 0) continue;
    const d = Math.hypot(u.pos.x - self.pos.x, u.pos.z - self.pos.z);
    if (tier > bestTier || (tier === bestTier && d >= bestD)) continue;
    // never through walls, never onto what she can't see
    if (!x.canSee(self, u) || !inSight(sim, self, u)) continue;
    best = u;
    bestTier = tier;
    bestD = d;
  }
  return best;
}

/**
 * Deal the displaced bullet to `other` as the attacker's own hit on it (SimExt.redirectDamage,
 * WU-10): the amount after the attacker's outgoing step (dmgBoost, weapon multipliers,
 * modifyOutgoing, 酒 — spent by this very bullet) is re-dealt `redirected` (no second outgoing
 * step, never bounces again), then the new victim's side runs (dodge, armor, shield). Kill
 * credit, attack memory and the weapon's on-hit special go to the attacker; the shooter's
 * hit on Da Qiao reads 'redirect'.
 */
function redirectBullet(ctx: DamageHookCtx, other: Entity): void {
  ext(ctx.sim).redirectDamage(ctx.req, other.id);
}

// 流离 (passive): a bullet hitting you has `chance` to be displaced, whole, to another unit
// within `radius` m that you can see (never the attacker; enemies first, your soldiers last).
registerAbility({
  id: 'daqiao_liuli',
  modifyIncoming(ctx, amount) {
    const { sim, self, req } = ctx;
    if (req.redirected || !(amount > 0) || !isBullet(req) || !isUp(self)) return amount;
    if (req.sourceId === undefined || req.sourceId === self.id) return amount;
    let out = amount;
    if (sim.rng.chance(Math.min(1, Math.max(0, param(ctx, 'chance', 0.3))))) {
      const other = displaceTarget(ctx, param(ctx, 'radius', 8));
      if (other) {
        // a public flourish must not point at a unit in stealth
        emitTrigger(ctx, publiclyVisible(sim, other) ? { target: other.id, pos: centerOf(other) } : {});
        redirectBullet(ctx, other);
        out = 0;
      }
    }
    return out;
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
