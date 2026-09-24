// 基本牌 Basic cards: 杀 (ammo box), 闪 (dodge charge), 桃 (heal / revive),
// 酒 (next hit ×2, or self-revive while downed). Tunables come from ItemDef.params.
import { ext } from '../ext';
import { registerItem } from './registry';

const DODGE_CAP = 3;

// 杀: refill a fraction of max reserve ammo on every weapon.
registerItem({
  id: 'sha',
  use(ctx) {
    const h = ctx.self.hero;
    if (!h) return false;
    const before = h.weapons.map((w) => (w ? w.reserve : 0));
    ctx.sim.refillAmmo(ctx.self.id, ctx.def.params.reserveFrac ?? 0.5);
    return h.weapons.some((w, i) => !!w && w.reserve > before[i]);
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
  use(ctx) {
    const h = ctx.self.hero;
    if (!h) return false;
    const cap = ctx.def.params.cap ?? DODGE_CAP;
    if (h.dodgeCharges >= cap) return false;
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
  canRevive: true,
  use(ctx) {
    const self = ctx.self;
    const t = ctx.target;
    const x = ext(ctx.sim);
    if (t && t !== self && t.hero?.downed && !t.hero.dead) {
      const hp = (ctx.def.params.reviveHp ?? 100) + x.modifiers(self.id).reviveHpBonus;
      return x.revive(t.id, hp, self.id);
    }
    if (self.hero?.downed || self.hp >= self.maxHp) return false;
    return ctx.sim.heal(self.id, ctx.def.params.heal ?? 120, self.id) > 0;
  },
  botShouldUse(_sim, self) {
    return self.hp < self.maxHp * 0.55;
  },
});

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
  botShouldUse(_sim, self) {
    return self.hero?.downed === true;
  },
});
