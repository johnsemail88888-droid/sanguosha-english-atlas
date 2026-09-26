// 孙尚香 Sun Shangxiang — 枭姬 (equipment loss / low HP: haste + full ammo + item),
// 结姻 (heal yourself and a male hero), 弓腰姬 (fan of explosive arrows).
import type { Entity, EntityId } from '../../../core/types';
import type { AbilityCtx } from '../../api';
import { getState, param, projectileVolley, setState } from '../common';
import { registerAbility } from '../registry';
import { centerOf, emitTrigger, fillAllAmmo, grantItems, isUp, setCast } from './util';

// ── 枭姬 (passive) ───────────────────────────────────────────────────────────
// Triggers when your armor or mount is lost (an empty slot afterwards — swapping for another
// piece is not a loss) or when your HP drops below hpFrac (re-arms once back above it).
// Effect: haste for `duration` s, every weapon's magazine + reserve full, `items` random items.
function xiaojiTrigger(ctx: AbilityCtx): void {
  const { sim, self } = ctx;
  if (!isUp(self) || sim.time < getState(ctx, 'ready')) return;
  setState(ctx, 'ready', sim.time + param(ctx, 'icd', 20));
  sim.applyStatus(self.id, 'haste', param(ctx, 'duration', 3), { sourceId: self.id, params: { amount: param(ctx, 'haste', 0.3) } });
  fillAllAmmo(sim, self);
  grantItems(sim, self, param(ctx, 'items', 1));
  emitTrigger(ctx);
}

/** HP threshold crossing (armed while at/above the threshold). */
function xiaojiHpCheck(ctx: AbilityCtx): void {
  const self = ctx.self;
  if (!self.hero || self.hero.dead) return;
  const above = self.hp >= self.maxHp * param(ctx, 'hpFrac', 0.5);
  const armed = getState(ctx, 'armed', -1);
  if (armed < 0 || above) {
    setState(ctx, 'armed', above ? 1 : 0);
    return;
  }
  if (armed === 0) return;
  setState(ctx, 'armed', 0);
  // dropping straight to 0 (濒死) is not a comeback moment
  if (self.hero.downed || self.hp <= 0) return;
  xiaojiTrigger(ctx);
}

registerAbility({
  id: 'sunshangxiang_xiaoji',
  tick(ctx) {
    xiaojiHpCheck(ctx);
  },
  onDamageTaken(ctx) {
    xiaojiHpCheck(ctx);
  },
  onEquipmentLost(ctx, what) {
    const h = ctx.self.hero;
    if (!h || (what === 'armor' ? h.armor : h.mount)) return;
    xiaojiTrigger(ctx);
  },
});

// 结姻 (Q): heal the male hero under your crosshair and yourself for `heal` each. Never a hero
// you know to be hostile; no valid male hero → no cooldown.
function maleUnderCrosshair(ctx: AbilityCtx, range: number): Entity | undefined {
  const { sim, self } = ctx;
  const exclude: EntityId[] = [self.id];
  for (let i = 0; i < 3; i++) {
    const t = sim.aimTarget(self, range, { kinds: ['hero'], exclude });
    if (!t) {
      // nothing aimed at → 'noTarget'; only women / foes / downed heroes → 'invalidTarget'
      ctx.deniedReason ??= i === 0 ? 'noTarget' : 'invalidTarget';
      return undefined;
    }
    const male = param(ctx, 'maleOnly', 1) <= 0 || sim.heroDef(t)?.gender === 'male';
    const ok = isUp(t) && male && (sim.isOwnSide(self, t) || !sim.isHostileTo(self, t));
    if (ok) return t;
    exclude.push(t.id);
  }
  ctx.deniedReason ??= 'invalidTarget';
  return undefined;
}

registerAbility({
  id: 'sunshangxiang_jieyin',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const t = maleUnderCrosshair(ctx, param(ctx, 'range', 25));
    if (!t) return false;
    const amount = param(ctx, 'heal', 100);
    setCast(ctx, { target: t.id, pos: centerOf(t) });
    sim.heal(t.id, amount, self.id);
    sim.heal(self.id, amount, self.id);
    return true;
  },
});

// 弓腰姬 (E): `arrows` explosive arrows in a `spread`° fan toward the crosshair: `damage` on a
// direct hit plus an explodeDamage blast (explodeRadius m). Ability damage, not a weapon hit.
registerAbility({
  id: 'sunshangxiang_gongyao',
  activate(ctx) {
    if (!isUp(ctx.self)) return false;
    projectileVolley(ctx, {
      kind: 'arrow',
      count: Math.max(1, Math.round(param(ctx, 'arrows', 5))),
      fanDeg: param(ctx, 'spread', 30),
      speed: Math.max(5, param(ctx, 'speed', 70)),
      damage: param(ctx, 'damage', 30),
      dtype: ctx.def.dtype ?? 'explosive',
      gravity: 0,
      explodeRadius: param(ctx, 'explodeRadius', 2),
      explodeDamage: param(ctx, 'explodeDamage', 20),
      lifetime: 1.6,
      abilityId: ctx.def.id,
    });
    return true;
  },
});
