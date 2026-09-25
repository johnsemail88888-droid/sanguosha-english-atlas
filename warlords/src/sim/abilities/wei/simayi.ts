// 司马懿 Sima Yi — 反馈 / 鬼才 / 狼顾.
import type { Entity } from '../../../core/types';
import type { AbilityCtx, DamageRequest } from '../../api';
import { getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { attackerUnit, canAct, emitProc, heroAttacker, isBullet, isDirectHit, isReflected, setCast, statusFrom, stealOne } from './shared';

// 反馈 (passive): when a hero damages you (personally — not its troops), steal 1 random item
// from it. 8 s internal cooldown, spent only when something was actually taken.
registerAbility({
  id: 'simayi_fankui',
  onDamageTaken(ctx) {
    const { sim, self, req } = ctx;
    if (self.hero?.dead || !isDirectHit(req)) return;
    const now = sim.time;
    if (now < getState(ctx, 'readyAt')) return;
    const attacker = heroAttacker(sim, req);
    if (!attacker || attacker === self) return;
    const got = stealOne(sim, self, attacker);
    if (!got) return;
    setState(ctx, 'readyAt', now + param(ctx, 'icd', 8));
    emitProc(ctx, 0, { target: attacker.id });
  },
});

// 鬼才 (Q): 2.5 s — weapon bullets that hit you deal ×0.5 and the full original amount is
// reflected back at the shooter. A 'reflect' status (frac 0: the engine's own reflect stays
// off) marks it for HUD / bots, and a 'guicai' hazard following you draws the dome.
const pendingReflect = new WeakMap<DamageRequest, number>();

function endGuicai(ctx: AbilityCtx, early: boolean): void {
  const { sim, self } = ctx;
  setState(ctx, 'until', 0);
  const hz = getState(ctx, 'hazard', -1);
  setState(ctx, 'hazard', -1);
  if (early) {
    if (hz >= 0) sim.removeEntity(hz);
    sim.removeStatus(self.id, 'reflect');
  }
}

registerAbility({
  id: 'simayi_guicai',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const duration = param(ctx, 'duration', 2.5);
    const old = getState(ctx, 'hazard', -1);
    if (old >= 0) sim.removeEntity(old);
    setState(ctx, 'until', sim.time + duration);
    sim.applyStatus(self.id, 'reflect', duration, { sourceId: self.id, params: { frac: 0 } });
    const dome = sim.spawnHazard({
      kind: 'guicai',
      ownerId: self.id,
      pos: { ...self.pos },
      radius: 1.6,
      duration,
      tickEvery: 10,
      params: {},
      followId: self.id,
    });
    setState(ctx, 'hazard', dome.id);
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
  modifyIncoming(ctx, amount) {
    const { sim, self, req } = ctx;
    if (!(amount > 0) || sim.time >= getState(ctx, 'until') || self.hero?.downed || !isBullet(req)) return amount;
    pendingReflect.set(req, amount);
    return amount * Math.max(0, param(ctx, 'takenMul', 0.5));
  },
  onDamageTaken(ctx) {
    const { sim, self, req } = ctx;
    const original = pendingReflect.get(req);
    if (original === undefined) return;
    pendingReflect.delete(req);
    const shooter = attackerUnit(sim, req);
    if (!shooter || shooter === self || sim.isOwnSide(self, shooter)) return;
    const amount = original * Math.max(0, param(ctx, 'reflect', 1));
    if (!(amount > 0)) return;
    // same semantics as the engine's reflect status: undodgeable, ignores armor, no loops,
    // never cancelled by 无懈可击 (reflects are exempt), untouched by outgoing multipliers
    sim.dealDamage({
      targetId: shooter.id,
      sourceId: self.id,
      amount,
      type: ctx.def.dtype ?? 'normal',
      noReflect: true,
      canDodge: false,
      ignoreArmor: true,
      abilityId: 'status:reflect',
    });
  },
  tick(ctx) {
    const until = getState(ctx, 'until');
    if (until <= 0) return;
    if (ctx.self.hero?.downed) endGuicai(ctx, true);
    else if (ctx.sim.time >= until) endGuicai(ctx, false);
  },
});

// 狼顾 (E): every other hero within 40 m is revealed to you alone for 5 s (private reveal:
// params.viewerId); meanwhile your damage against them is ×1.4.
function revealedByMe(e: Entity, selfId: number, now: number): boolean {
  for (const s of e.statuses) {
    if (s.id === 'reveal' && s.until > now && s.sourceId === selfId && s.params?.viewerId === selfId) return true;
  }
  return false;
}

registerAbility({
  id: 'simayi_langgu',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const radius = param(ctx, 'radius', 40);
    const duration = param(ctx, 'duration', 5);
    const priv = param(ctx, 'privateReveal', 1) > 0;
    for (const h of sim.queryRadius(self.pos, radius, { kinds: ['hero'], exclude: [self.id] })) {
      if (h.hero?.dead) continue;
      sim.applyStatus(h.id, 'reveal', duration, { sourceId: self.id, params: priv ? { viewerId: self.id } : undefined });
    }
    setState(ctx, 'until', sim.time + duration);
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
  modifyOutgoing(ctx, amount) {
    const t = ctx.other;
    if (!t?.hero || ctx.sim.time >= getState(ctx, 'until')) return amount;
    // 鬼才 / thorns reflections return what came in: never boosted (DoT ticks still are)
    if (isReflected(ctx.req)) return amount;
    const priv = param(ctx, 'privateReveal', 1) > 0;
    const marked = priv ? revealedByMe(t, ctx.self.id, ctx.sim.time) : statusFrom(ctx.sim, t, 'reveal', ctx.self.id);
    return marked ? amount * param(ctx, 'mul', 1.4) : amount;
  },
});
