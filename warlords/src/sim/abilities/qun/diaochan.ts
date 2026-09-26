// 貂蝉 Diaochan — 闭月 (passive), 离间 (Q), 连环计 (E).
import type { Entity } from '../../../core/types';
import type { SimApi } from '../../api';
import { ext } from '../../ext';
import { crosshairEnemy, deny, denyTarget, enemiesInRadius, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { canAct, chestOf, flatDist, nearestTo, setCastEvent, standing } from './util';

/** 闭月 heals in pulses (one heal event per pulse instead of one per tick) */
const REGEN_PULSE = 0.5;

/**
 * A unit Diaochan may pull into a stratagem: one she can see (no stealthed unit beyond
 * 6 m — its status events would give it away) and that can be targeted at all (空城).
 */
function pickable(sim: SimApi, self: Entity, u: Entity): boolean {
  return ext(sim).canSee(self, u) && !sim.hasStatus(u.id, 'untargetable');
}

// 闭月 (passive): after 5 s without taking damage, regenerate 5 HP/s.
registerAbility({
  id: 'diaochan_biyue',
  tick(ctx) {
    const { sim, self } = ctx;
    const eligible =
      standing(self) && self.hp < self.maxHp && ext(sim).sinceDamaged(self.id) >= param(ctx, 'delay', 5);
    if (!eligible) {
      if (getState(ctx, 'next') !== 0) setState(ctx, 'next', 0);
      return;
    }
    const now = sim.time;
    const next = getState(ctx, 'next');
    if (next <= 0) {
      setState(ctx, 'next', now + REGEN_PULSE);
      return;
    }
    if (now + 1e-9 < next) return;
    setState(ctx, 'next', next + REGEN_PULSE);
    sim.heal(self.id, param(ctx, 'hps', 5) * REGEN_PULSE, self.id);
  },
});

// 离间 (Q): charm the crosshair enemy hero and the nearest other hero within 15 m of it for
// 2.5 s: they are forced to attack each other (their shots at each other deal ×dmgMul). With no other standing hero around, the target
// is charmed onto the nearest unit (troop / NPC / turret) that isn't its own — preferably
// not yours either, else one of your soldiers (it shoots them instead of you).
registerAbility({
  id: 'diaochan_lijian',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const a = crosshairEnemy(ctx, param(ctx, 'range', 30), ['hero']);
    if (!standing(a)) return denyTarget(ctx, a); // charm needs a hero that can still fight
    const radius = param(ctx, 'radius', 15);
    const duration = param(ctx, 'duration', 2.5);
    const heroes = sim
      .queryRadius(a.pos, radius, { kinds: ['hero'], exclude: [self.id, a.id] })
      .filter((h) => standing(h) && flatDist(h.pos, a.pos) <= radius + h.radius && pickable(sim, self, h));
    // the forced shots hit softer (COMBAT-6: a double near-kill otherwise); the pair forgets
    // the fight when the charm ends (status.ts)
    const dmgMul = param(ctx, 'dmgMul', 0.35);
    let b: Entity | undefined = nearestTo(heroes, a.pos);
    if (b) {
      sim.applyStatus(a.id, 'charm', duration, { sourceId: self.id, params: { targetId: b.id, dmgMul } });
      sim.applyStatus(b.id, 'charm', duration, { sourceId: self.id, params: { targetId: a.id, dmgMul } });
    } else {
      // never its own squad (it can't hurt them); third-party units first, else Diaochan's
      // own soldiers — the target turns its fire on them instead of on her
      const units = sim
        .queryRadius(a.pos, radius, { kinds: ['troop', 'npc', 'turret'], notFriendlyTo: a.id })
        .filter((u) => u.alive && flatDist(u.pos, a.pos) <= radius + u.radius && pickable(sim, self, u));
      b = nearestTo(units.filter((u) => !sim.isOwnSide(self, u)), a.pos) ?? nearestTo(units, a.pos);
      if (!b) return deny(ctx, 'needOther'); // nobody to turn it on: keep the cooldown
      sim.applyStatus(a.id, 'charm', duration, { sourceId: self.id, params: { targetId: b.id, dmgMul } });
    }
    // the event carries the pair: target = the crosshair hero, pos = the one it is turned on
    setCastEvent(ctx, { target: a.id, pos: chestOf(b) });
    return true;
  },
});

// 连环计 (E): chain the crosshair enemy and up to 2 more enemies within 8 m of it for 8 s:
// slowed 25 %, and fire / thunder damage to one spreads to every chained unit (铁索连环).
registerAbility({
  id: 'diaochan_lianhuan',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const first = crosshairEnemy(ctx, param(ctx, 'range', 30));
    // a downed hero can't be slowed into anything: no cast (the cooldown is kept)
    if (!standing(first)) return denyTarget(ctx, first);
    const radius = param(ctx, 'radius', 8);
    const extra = Math.max(0, Math.floor(param(ctx, 'extraTargets', 2)));
    // standing heroes first (the valuable links), then the nearest units; downed heroes are
    // never linked (the slow is pointless on them and they would waste a link)
    const rest = enemiesInRadius(sim, self, first.pos, radius)
      .filter((u) => u !== first && standing(u) && flatDist(u.pos, first.pos) <= radius + u.radius && pickable(sim, self, u))
      .sort((x, y) => (x.kind === 'hero' ? 0 : 1) - (y.kind === 'hero' ? 0 : 1) || flatDist(x.pos, first.pos) - flatDist(y.pos, first.pos) || x.id - y.id)
      .slice(0, extra);
    const duration = param(ctx, 'duration', 8);
    const slow = param(ctx, 'slow', 0.25);
    for (const u of [first, ...rest]) {
      if (!u.alive) continue;
      if (sim.applyStatus(u.id, 'chained', duration, { sourceId: self.id }) && slow > 0) {
        sim.applyStatus(u.id, 'slow', duration, { sourceId: self.id, params: { amount: slow } });
      }
    }
    setCastEvent(ctx, { target: first.id, pos: chestOf(first) });
    return true;
  },
});
