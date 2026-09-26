// 马超 Ma Chao — 马术 (passive, permanently mounted), 铁骑 (Q), 西凉冲锋 (E).
import { MOUNT_BY_ID } from '../../../data';
import { registerAbility } from '../registry';
import { deny, flatAimDir, getState, param, setState } from '../common';
import { ahead, charge, isDirectHit, isRooted, setCast } from './util';

// 马术 (passive): always on his Xiliang warhorse (HeroVisual.mount draws it):
// +20 % move speed that does not stack with a looted mount — the faster wins.
// The world multiplies the mount's speed separately, so this returns
// max(own, mount) / mount.
registerAbility({
  id: 'machao_mashu',
  speedMul(ctx) {
    const h = ctx.self.hero;
    if (!h || h.downed || h.dead) return 1;
    const own = Math.max(1, param(ctx, 'speedMul', 1.2));
    const mount = h.mount ? (MOUNT_BY_ID[h.mount]?.speedMul ?? 1) : 1;
    return mount > 0 ? Math.max(own, mount) / mount : own;
  },
});

// 铁骑 (Q): for a few seconds every attack is undodgeable and armor-piercing
// ('undodgeable' + 'pierce' self statuses, read by the damage pipeline); each
// hit on a hero silences it briefly.
registerAbility({
  id: 'machao_tieji',
  activate(ctx) {
    const { sim, self } = ctx;
    const duration = param(ctx, 'duration', 6);
    sim.applyStatus(self.id, 'undodgeable', duration, { sourceId: self.id });
    sim.applyStatus(self.id, 'pierce', duration, { sourceId: self.id });
    setState(ctx, 'until', sim.time + duration);
    setCast(ctx, { pos: sim.eyePos(self) });
    return true;
  },
  onDamageDealt(ctx, dealt) {
    const { sim, self } = ctx;
    const t = ctx.other;
    void dealt;
    if (!t?.hero || t === self || !t.alive || t.hero.dead || t.hero.downed) return;
    if (sim.time >= getState(ctx, 'until') || !isDirectHit(ctx.req)) return;
    sim.applyStatus(t.id, 'silence', param(ctx, 'silence', 1), { sourceId: self.id });
  },
});

// 西凉冲锋 (E): gallop forward; everything in the path is trampled once
// (damage + knockback) as the horse passes it.
registerAbility({
  id: 'machao_charge',
  activate(ctx) {
    const { sim, self } = ctx;
    if (isRooted(sim, self)) return deny(ctx, 'blocked');
    const dir = flatAimDir(ctx);
    const distance = param(ctx, 'dash', 15);
    charge(ctx, {
      dir,
      distance,
      duration: Math.max(0.05, param(ctx, 'dashTime', 0.6)),
      width: param(ctx, 'width', 2),
      strike: {
        damage: param(ctx, 'damage', 70),
        dtype: ctx.def.dtype ?? 'melee',
        abilityId: ctx.def.id,
        knockback: param(ctx, 'knockback', 9),
      },
    });
    setCast(ctx, { dir, pos: ahead(self.pos, dir, distance) });
    return true;
  },
});
