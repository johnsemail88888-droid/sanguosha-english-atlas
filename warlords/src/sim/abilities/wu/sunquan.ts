// 孙权 Sun Quan ★ — 权衡 (reload), 制衡 (reroll items + instant reload + dodges),
// 坐断东南 (recruit over the cap), lord 救援 (Wu damage-reduction aura + regen).
import type { AbilityCtx, SimApi } from '../../api';
import { ext } from '../../ext';
import { UNIT_KINDS, alive, deny, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { centerOf, grantItems, isUp, refillDodges, reloadAllFromReserve, setCast } from './util';

// 权衡 (passive): all weapons reload 20 % faster.
registerAbility({
  id: 'sunquan_quanheng',
  modifiers: (ctx) => ({ reloadMul: param(ctx, 'reloadMul', 0.8) }),
});

// 制衡 (Q): discard every item, draw one per occupied slot (+extra); instant reload; dodges refilled.
registerAbility({
  id: 'sunquan_zhiheng',
  activate(ctx) {
    const { sim, self } = ctx;
    const h = self.hero;
    if (!h || !isUp(self)) return false;
    // an item being used is part of the hand that gets discarded
    if (h.channel?.kind === 'item') ext(sim).cancelChannel(self.id);
    const countCards = param(ctx, 'countStacks', 0) > 0;
    let n = 0;
    for (let i = 0; i < h.items.length; i++) {
      const s = h.items[i];
      if (!s) continue;
      n += countCards ? Math.max(1, s.count) : 1;
      h.items[i] = null;
    }
    grantItems(sim, self, n + Math.max(0, Math.round(param(ctx, 'extra', 1))));
    reloadAllFromReserve(self);
    refillDodges(sim, self);
    setCast(ctx, { pos: centerOf(self) });
    return true;
  },
});

/** Normal squad size of a hero: the world's own spawn rule (SimExt.squadCap, WU-6). */
function squadCap(sim: SimApi, ctx: AbilityCtx): number {
  return ext(sim).squadCap(ctx.self.id);
}

// 坐断东南 (E): recruit `count` of your kingdom's soldiers, up to `overCap` over your squad cap.
registerAbility({
  id: 'sunquan_zuoduan',
  activate(ctx) {
    const { sim, self } = ctx;
    const h = self.hero;
    if (!h || !isUp(self)) return false;
    const living = h.squad.filter((id) => alive(sim.get(id))).length;
    const room = squadCap(sim, ctx) + Math.max(0, Math.round(param(ctx, 'overCap', 2))) - living;
    const n = Math.min(Math.max(0, Math.round(param(ctx, 'count', 2))), room);
    if (n <= 0) return deny(ctx, 'cap'); // squad full: no cooldown
    setCast(ctx, { pos: centerOf(self) });
    return sim.spawnTroops(self.id, ctx.hero.troopType, n).length > 0 || deny(ctx, 'blocked');
  },
});

// 救援 (lord, G): for `duration` s, you and every Wu unit within `radius` take ×takenMul damage;
// you regen hpsPerHero HP/s for each standing Wu hero in range (you included). Ends if you go down.
const AURA_REFRESH = 0.2;
const REGEN_PERIOD = 0.5;

function jiuyuanPulse(ctx: AbilityCtx): void {
  const { sim, self } = ctx;
  const now = sim.time;
  const until = getState(ctx, 'until');
  const left = until - now;
  if (left <= 1e-6) return;
  const radius = param(ctx, 'radius', 15);
  const mul = Math.min(1, Math.max(0, param(ctx, 'takenMul', 0.7)));
  const dur = Math.min(AURA_REFRESH, left);
  let wuHeroes = 0;
  for (const u of sim.queryRadius(self.pos, radius, { kinds: UNIT_KINDS })) {
    if (u.hero?.dead || (u !== self && u.kingdom !== 'wu')) continue;
    sim.applyStatus(u.id, 'dmgTakenDown', dur, { sourceId: self.id, params: { mul } });
    if (u.kind === 'hero' && !u.hero?.downed) wuHeroes++;
  }
  if (now + 1e-9 >= getState(ctx, 'nextRegen')) {
    setState(ctx, 'nextRegen', getState(ctx, 'nextRegen') + REGEN_PERIOD);
    const hps = param(ctx, 'hpsPerHero', 10) * Math.max(1, wuHeroes);
    sim.heal(self.id, hps * REGEN_PERIOD, self.id);
  }
}

registerAbility({
  id: 'sunquan_jiuyuan',
  activate(ctx) {
    if (!isUp(ctx.self)) return false;
    const now = ctx.sim.time;
    setState(ctx, 'until', now + param(ctx, 'duration', 6));
    setState(ctx, 'nextRegen', now);
    jiuyuanPulse(ctx);
    setCast(ctx, { pos: centerOf(ctx.self) });
    return true;
  },
  tick(ctx) {
    if (getState(ctx, 'until') <= ctx.sim.time) return;
    if (!isUp(ctx.self)) {
      setState(ctx, 'until', 0);
      return;
    }
    jiuyuanPulse(ctx);
  },
});
