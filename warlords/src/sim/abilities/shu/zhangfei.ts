// 张飞 Zhang Fei — 蛇矛连击 (passive), 咆哮 (Q), 据水断桥 (E).
import { ext } from '../../ext';
import { registerAbility } from '../registry';
import { enemiesInRadius, flatAimDir, param } from '../common';
import { FIGHTER_KINDS, ahead, ensureLoaded, setCast, strikeUnit, unitsInCone } from './util';

// 蛇矛连击 (passive): shotgun reloads −40 %; any kill → a few seconds of ammo-free fire.
registerAbility({
  id: 'zhangfei_shemao',
  modifiers(ctx) {
    const w = ext(ctx.sim).activeWeapon(ctx.self.id);
    if (w?.def.class === 'shotgun') return { reloadMul: param(ctx, 'reloadMul', 0.6) };
    return undefined;
  },
  onKill(ctx, victim) {
    const self = ctx.self;
    if (victim === self || !self.alive || self.hero?.dead) return;
    // a kill with the last shell (or mid-reload) must not start / keep a reload:
    // rack the gun so the ammo-free window is usable at once (like 咆哮)
    if (ctx.sim.applyStatus(self.id, 'noReload', param(ctx, 'killNoReload', 3), { sourceId: self.id })) ensureLoaded(ctx.sim, self);
  },
});

// 咆哮 (Q): ammo-free rapid fire for a few seconds; enemies close by are slowed.
registerAbility({
  id: 'zhangfei_paoxiao',
  activate(ctx) {
    const { sim, self } = ctx;
    const duration = param(ctx, 'duration', 5);
    sim.applyStatus(self.id, 'noReload', duration, { sourceId: self.id });
    sim.applyStatus(self.id, 'fireRateUp', duration, { sourceId: self.id, params: { mul: param(ctx, 'fireRateMul', 1.4) } });
    // an empty / reloading gun is racked at once: the roar is for shooting now
    ensureLoaded(sim, self);
    const slow = param(ctx, 'slow', 0.3);
    const slowTime = param(ctx, 'slowTime', 2);
    if (slow > 0) {
      for (const t of enemiesInRadius(sim, self, self.pos, param(ctx, 'radius', 8), FIGHTER_KINDS)) {
        sim.applyStatus(t.id, 'slow', slowTime, { sourceId: self.id, params: { amount: slow } });
      }
    }
    setCast(ctx, { pos: { ...self.pos } });
    return true;
  },
});

// 据水断桥 (E): a roar in a cone — light damage, knockback, stun (short on heroes).
registerAbility({
  id: 'zhangfei_duanqiao',
  activate(ctx) {
    const { sim, self } = ctx;
    const dir = flatAimDir(ctx);
    const range = param(ctx, 'range', 10);
    const stunHero = Math.min(1.5, param(ctx, 'stunHero', 0.8));
    const stunTroop = param(ctx, 'stunTroop', 2);
    const opts = { damage: param(ctx, 'damage', 20), dtype: ctx.def.dtype ?? 'normal', abilityId: ctx.def.id, knockback: param(ctx, 'knockback', 10) };
    for (const t of unitsInCone(sim, self, sim.eyePos(self), dir, range, param(ctx, 'arc', 70))) {
      if (!strikeUnit(sim, self, t, opts) || !t.alive || t.hero?.dead) continue;
      const stun = t.kind === 'hero' ? stunHero : stunTroop;
      if (stun > 0) sim.applyStatus(t.id, 'stun', stun, { sourceId: self.id });
    }
    setCast(ctx, { dir, pos: ahead(self.pos, dir, range * 0.5) });
    return true;
  },
});
