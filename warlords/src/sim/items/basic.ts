// 基本牌 Basic cards: 杀 (ammo box), 闪 (dodge charge), 桃 (heal / revive),
// 酒 (next hit ×2, or self-revive while downed). Tunables come from ItemDef.params.
import type { DeniedReason } from '../../core/types';
import type { ItemCtx } from '../api';
import { maxReserve, usesAmmo, weaponDef } from '../defs';
import { ext } from '../ext';
import { registerItem } from './registry';
import { botView } from './util';

const DODGE_CAP = 3;

// 杀: refill a fraction of max reserve ammo on every weapon.
registerItem({
  id: 'sha',
  canUse(ctx) {
    // every gun already carries its full reserve: nothing to refill
    const h = ctx.self.hero;
    if (!h) return 'blocked';
    const room = h.weapons.some((wi) => {
      if (!wi) return false;
      const def = weaponDef(wi.id);
      return usesAmmo(def) && wi.reserve < maxReserve(def);
    });
    return room ? null : 'cap';
  },
  use(ctx) {
    const h = ctx.self.hero;
    if (!h) return false;
    const before = h.weapons.map((w) => (w ? w.reserve : 0));
    ctx.sim.refillAmmo(ctx.self.id, ctx.def.params.reserveFrac ?? 0.5);
    if (h.weapons.some((w, i) => !!w && w.reserve > before[i])) return true;
    ctx.deniedReason = 'cap';
    return false;
  },
  botShouldUse(sim, self) {
    const w = ext(sim).activeWeapon(self.id);
    if (!w || w.def.magSize <= 0) return false;
    return w.inst.reserve < w.def.magSize * Math.max(1, w.def.reserveMags) * 0.4;
  },
});

// 闪: +1 dodge-roll charge (up to 3).
registerItem({
  id: 'shan',
  canUse(ctx) {
    const h = ctx.self.hero;
    return h && h.dodgeCharges >= (ctx.def.params.cap ?? DODGE_CAP) ? 'cap' : null;
  },
  use(ctx) {
    const h = ctx.self.hero;
    if (!h) return false;
    const cap = ctx.def.params.cap ?? DODGE_CAP;
    if (h.dodgeCharges >= cap) {
      ctx.deniedReason = 'cap';
      return false;
    }
    h.dodgeCharges = Math.min(cap, h.dodgeCharges + (ctx.def.params.charges ?? 1));
    return true;
  },
  botShouldUse(_sim, self) {
    return (self.hero?.dodgeCharges ?? 3) < DODGE_CAP;
  },
});

// 桃: heal yourself, or revive the downed hero you are standing over.
registerItem({
  id: 'tao',
  canUse: taoRefusal,
  canRevive: true,
  use(ctx) {
    const self = ctx.self;
    const t = ctx.target;
    const x = ext(ctx.sim);
    if (t && t !== self && t.hero?.downed && !t.hero.dead) {
      const hp = (ctx.def.params.reviveHp ?? 100) + x.modifiers(self.id).reviveHpBonus;
      if (x.revive(t.id, hp, self.id)) return true;
      ctx.deniedReason = 'invalidTarget';
      return false;
    }
    const why = taoRefusal(ctx);
    if (why) {
      ctx.deniedReason = why;
      return false;
    }
    if (ctx.sim.heal(self.id, ctx.def.params.heal ?? 120, self.id) > 0) return true;
    ctx.deniedReason = 'blocked';
    return false;
  },
  botShouldUse(_sim, self) {
    return !self.hero?.downed && self.hp < self.maxHp * 0.55;
  },
});

/** Why a 桃 cannot be used right now: not on a downed hero and you are at full HP. */
function taoRefusal(ctx: ItemCtx): DeniedReason | null {
  const self = ctx.self;
  const t = ctx.target;
  if (t && t !== self && t.hero?.downed && !t.hero.dead) return null; // a revive
  if (self.hero?.downed) return 'blocked';
  return self.hp >= self.maxHp ? 'fullHp' : null;
}

// 酒: while downed — get back up with some HP; otherwise your next damaging hit ×2.
registerItem({
  id: 'jiu',
  usableWhileDowned: true,
  use(ctx) {
    const self = ctx.self;
    if (self.hero?.downed) return ext(ctx.sim).revive(self.id, ctx.def.params.reviveHp ?? 50, self.id);
    return ctx.sim.applyStatus(self.id, 'drunk', ctx.def.params.duration ?? 8, {
      sourceId: self.id,
      params: { mul: ctx.def.params.mul ?? 2, weaponOnly: ctx.def.params.weaponOnly ?? 1 },
    });
  },
  botShouldUse(sim, self) {
    const h = self.hero;
    if (!h) return false;
    if (h.downed) return true;
    // keep one for the self-revive; spend spares on a big hit against a hero
    const count = h.items.reduce((n, s) => n + (s?.id === 'jiu' ? s.count : 0), 0);
    if (count < 2 || sim.hasStatus(self.id, 'drunk')) return false;
    const v = botView(sim, self);
    const w = ext(sim).activeWeapon(self.id);
    if (!v.target?.hero || !v.los || !w || w.def.melee || w.inst.mag <= 0) return false;
    return v.dist <= Math.min(w.def.maxRange, 45);
  },
});
