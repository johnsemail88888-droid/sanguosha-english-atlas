// 夏侯渊 Xiahou Yuan — 疾行 / 神速 / 虎步关右.
import type { Vec3 } from '../../../core/math';
import type { Entity } from '../../../core/types';
import type { WeaponDef } from '../../../data/types';
import type { AbilityCtx } from '../../api';
import { ext } from '../../ext';
import { UNIT_KINDS, alive, crosshairEnemy, crosshairPoint, enemiesInRadius, param } from '../common';
import { registerAbility } from '../registry';
import { BASE_DODGE_CHARGES, canAct, chestOf, flatDist, immobile, losBetween, safeBlink, setCast } from './shared';

// 疾行 (passive): +15 % move speed; sprinting does not break aim-down-sights.
registerAbility({
  id: 'xiahouyuan_jixing',
  modifiers(ctx) {
    return { speedMul: param(ctx, 'speedMul', 1.15), sprintAds: param(ctx, 'sprintAds', 1) > 0 };
  },
});

// 神速 (Q): blink up to 14 m to the crosshair, then instantly volley 5 × 22 at the nearest
// visible enemy within 30 m (the enemy under your crosshair if it is one, else the nearest
// hero, else the nearest unit). weaponHit: the rounds are fired with the held weapon (falloff,
// armor-piercing, 酒, 八卦 / 倾国 evasion and 鬼才 reflect apply) but cost no ammo.
const VOLLEY_GAP = 0.05;

function volleyTarget(ctx: AbilityCtx, preferred: Entity | undefined, range: number): Entity | undefined {
  const { sim, self } = ctx;
  const x = ext(sim);
  const ok = (t: Entity | undefined): t is Entity =>
    alive(t) && !t.hero?.downed && t !== self && !sim.isOwnSide(self, t) && !sim.hasStatus(t.id, 'untargetable') &&
    flatDist(t.pos, self.pos) <= range + t.radius && x.canSee(self, t) && losBetween(sim, self, t);
  if (ok(preferred)) return preferred;
  let best: Entity | undefined;
  let bestScore = Infinity;
  for (const t of enemiesInRadius(sim, self, self.pos, range, UNIT_KINDS)) {
    if (!ok(t)) continue;
    const score = (t.hero ? 0 : 1000) + flatDist(t.pos, self.pos);
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function fireVolleyRound(ctx: AbilityCtx, target: Entity, weapon: WeaponDef | undefined): void {
  const { sim, self } = ctx;
  const eye = sim.eyePos(self);
  const c = chestOf(target);
  let dx = c.x - eye.x;
  let dy = c.y - eye.y;
  let dz = c.z - eye.z;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-3) return;
  // a hair of spread so the tracers fan out (host RNG: deterministic)
  const j = 0.008;
  dx = dx / l + (sim.rng.next() - 0.5) * j;
  dy = dy / l + (sim.rng.next() - 0.5) * j;
  dz = dz / l + (sim.rng.next() - 0.5) * j;
  ext(sim).fireHitscan(self.id, eye, { x: dx, y: dy, z: dz }, {
    damage: param(ctx, 'shotDamage', 22),
    range: param(ctx, 'volleyRange', 30) + 6,
    dtype: ctx.def.dtype ?? 'normal',
    weaponId: weapon?.id,
    abilityId: ctx.def.id,
    falloff: !!weapon,
    canDodge: true,
    ignoreArmor: weapon?.special === 'pierceArmor',
    headshotMul: weapon?.headshotMul,
  });
}

registerAbility({
  id: 'xiahouyuan_shensu',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx) || immobile(sim, self)) return false;
    const range = param(ctx, 'range', 14);
    const volleyRange = param(ctx, 'volleyRange', 30);
    const aimed = crosshairEnemy(ctx, Math.max(range, volleyRange));
    let dest: Vec3 = crosshairPoint(ctx, range);
    // aiming at a unit: stop 2.5 m short of it instead of landing inside it
    if (aimed && flatDist(aimed.pos, dest) < aimed.radius + 1.5) {
      const dx = aimed.pos.x - self.pos.x;
      const dz = aimed.pos.z - self.pos.z;
      const d = Math.hypot(dx, dz);
      const keep = Math.max(0, Math.min(range, d - aimed.radius - 2.5));
      dest = d > 1e-3 ? { x: self.pos.x + (dx / d) * keep, y: self.pos.y, z: self.pos.z + (dz / d) * keep } : { ...self.pos };
    }
    const start = { ...self.pos };
    safeBlink(ctx, dest, range);
    const moved = flatDist(self.pos, start);
    let target = volleyTarget(ctx, aimed, volleyRange);
    if (moved < 0.5 && !target) return false; // nowhere to go and nobody to shoot: keep the cooldown
    // pos = where the blink started (he is at the landing): the VFX streak runs pos → caster
    setCast(ctx, { pos: start, target: target?.id });
    if (!target) return true;
    const shots = Math.max(0, Math.round(param(ctx, 'shots', 5)));
    // the held weapon at cast time (a weapon swap mid-volley does not change the rounds)
    const weapon = param(ctx, 'weaponHit', 1) > 0 ? ext(sim).activeWeapon(self.id)?.def : undefined;
    fireVolleyRound(ctx, target, weapon);
    for (let i = 1; i < shots; i++) {
      sim.schedule(VOLLEY_GAP * i, () => {
        if (!alive(self) || self.hero?.downed) return;
        if (!alive(target) || target.hero?.downed) {
          const next = volleyTarget(ctx, undefined, volleyRange);
          if (!next) return;
          target = next;
        }
        fireVolleyRound(ctx, target, weapon);
      });
    }
    return true;
  },
});

// 虎步关右 (E): 40 % haste for 5 s and every dodge charge refilled at once.
registerAbility({
  id: 'xiahouyuan_hubu',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const h = self.hero!;
    sim.applyStatus(self.id, 'haste', param(ctx, 'duration', 5), { sourceId: self.id, params: { amount: param(ctx, 'haste', 0.4) } });
    const max = BASE_DODGE_CHARGES + ext(sim).modifiers(self.id).extraDodgeCharges;
    if (h.dodgeCharges < max) h.dodgeCharges = max;
    h.dodgeRechargeAt = 0;
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
});
