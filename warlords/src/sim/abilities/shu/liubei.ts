// 刘备 Liu Bei — 仁德 (passive), 仁德·济民 (Q), 蜀汉旌旗 (E), 激将 (lord).
import type { Entity } from '../../../core/types';
import type { SimApi } from '../../api';
import { registerHazardKind } from '../../hazards';
import { registerAbility } from '../registry';
import { getState, param, setState, summonTroops } from '../common';
import { crosshairFriend, giveOrDrop, isUp, pickWeighted, setCast } from './util';

const BANNER_KIND = 'shuBanner';
const BANNER_TICK = 0.5;

// 仁德 (passive): healing another hero heals you for 30 % of it. Squad +2 is
// HeroDef.troopBonus (added by the world at spawn), never applied here.
registerAbility({
  id: 'liubei_rende',
  onHealGiven(ctx, target, amount) {
    const self = ctx.self;
    if (target === self || target.kind !== 'hero' || !(amount > 0) || !isUp(self)) return;
    // sourced by yourself: the recursive onHealGiven(self → self) is ignored above
    ctx.sim.heal(self.id, amount * param(ctx, 'selfHealFrac', 0.3), self.id);
  },
});

// 仁德·济民 (Q, 2 charges): toss supplies to the hero under the crosshair —
// heal + one 杀/闪/酒; the second toss within the combo window heals you too.
registerAbility({
  id: 'liubei_jimin',
  activate(ctx) {
    const { sim, self } = ctx;
    const target = crosshairFriend(ctx, param(ctx, 'range', 25), false);
    if (!target) return false;
    sim.heal(target.id, param(ctx, 'heal', 80), self.id);
    const cards = Math.max(0, Math.round(param(ctx, 'cards', 1)));
    for (let i = 0; i < cards; i++) {
      const id = pickWeighted(sim, [
        ['sha', param(ctx, 'giftSha', 1)],
        ['shan', param(ctx, 'giftShan', 1)],
        ['jiu', param(ctx, 'giftJiu', 1)],
      ]);
      if (id) giveOrDrop(sim, target, id);
    }
    // combo: 0 = no open chain (sim time is > 0 at every activation)
    const now = sim.time;
    const last = getState(ctx, 'last', 0);
    if (last > 0 && now - last <= param(ctx, 'comboWindow', 12)) {
      sim.heal(self.id, param(ctx, 'selfHeal', 60), self.id);
      setState(ctx, 'last', 0);
    } else {
      setState(ctx, 'last', now);
    }
    setCast(ctx, { target: target.id, pos: sim.eyePos(target) });
    return true;
  },
});

// 蜀汉旌旗 (E): a planted rally banner. Heroes you are not fighting (incl. you)
// and your own soldiers inside regenerate; your soldiers inside deal more damage.
registerHazardKind({
  kind: BANNER_KIND,
  tick(sim, hz, affected) {
    const st = hz.hazard;
    if (!st) return true;
    const p = st.params;
    const owner = sim.get(hz.ownerId);
    const heal = (p.hps ?? 15) * st.tickEvery;
    const mul = p.troopDmgMul ?? 1;
    for (const u of affected) {
      if (!u.alive || u.hero?.dead) continue;
      const own = !!owner && sim.isOwnSide(owner, u);
      if (u.kind === 'hero') {
        if (own || !owner || !sim.isHostileTo(owner, u)) sim.heal(u.id, heal, hz.ownerId);
      } else if (own && (u.kind === 'troop' || u.kind === 'npc')) {
        sim.heal(u.id, heal, hz.ownerId);
        if (mul > 1) sim.applyStatus(u.id, 'dmgBoost', st.tickEvery + 0.3, { sourceId: hz.ownerId, params: { mul } });
      }
    }
    return true; // no generic hazard behaviour
  },
});

registerAbility({
  id: 'liubei_banner',
  activate(ctx) {
    const { sim, self } = ctx;
    const pos = { ...self.pos };
    sim.spawnHazard({
      kind: BANNER_KIND,
      ownerId: self.id,
      pos,
      radius: param(ctx, 'radius', 8),
      duration: param(ctx, 'duration', 10),
      tickEvery: BANNER_TICK,
      params: { hps: param(ctx, 'hps', 15), troopDmgMul: param(ctx, 'troopDmgMul', 1.3) },
      affectsOwner: true,
    });
    setCast(ctx, { pos });
    return true;
  },
});

// 激将 (lord, real Lord only — the world strips lord skills from everyone else):
// summon militia; every Shu hero around you that is not fighting you shoots faster.
registerAbility({
  id: 'liubei_jijiang',
  activate(ctx) {
    const { sim, self } = ctx;
    if (sim.roleOf(self) !== 'lord') return false;
    summonTroops(ctx, 'shu_militia', Math.max(0, Math.round(param(ctx, 'count', 4))), param(ctx, 'lifetime', 30));
    const mul = param(ctx, 'fireRateMul', 1.3);
    const time = param(ctx, 'buffTime', 8);
    for (const h of sim.queryRadius(self.pos, param(ctx, 'radius', 20), { kinds: ['hero'] })) {
      if (!answersCall(sim, self, h)) continue;
      sim.applyStatus(h.id, 'fireRateUp', time, { sourceId: self.id, params: { mul } });
    }
    setCast(ctx, { pos: { ...self.pos } });
    return true;
  },
});

/** A Shu hero answers 激将 unless it is known to be fighting the Lord (a Shu rebel refuses). */
function answersCall(sim: SimApi, lord: Entity, h: Entity): boolean {
  if (!h.hero || h.hero.dead || sim.heroDef(h)?.kingdom !== 'shu') return false;
  return h === lord || !sim.isHostileTo(lord, h);
}
