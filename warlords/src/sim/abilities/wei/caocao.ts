// 曹操 Cao Cao ★ — 奸雄 / 宁教我负天下人 / 望梅止渴 / 护驾 (lord skill).
import type { Entity, SquadOrder } from '../../../core/types';
import type { DamageHookCtx } from '../../api';
import { ext } from '../../ext';
import { crosshairEnemy, getState, param, setState, summonTroops } from '../common';
import { registerAbility } from '../registry';
import { canAct, emitProc, flatDist, setCast } from './shared';

// 奸雄 (passive): 25 % of the weapon damage you take becomes a shield (5 s), up to 100 in total.
const JIANXIONG_PROC_GAP = 8;
registerAbility({
  id: 'caocao_jianxiong',
  onDamageTaken(ctx, dealt) {
    const { sim, self, req } = ctx;
    if (req.weaponId === undefined || !(dealt > 0) || self.hero?.downed || self.hero?.dead) return;
    const room = param(ctx, 'maxShield', 100) - self.shield;
    const amount = Math.min(dealt * param(ctx, 'frac', 0.25), room);
    if (!(amount > 0.05)) return;
    sim.addShield(self.id, amount, param(ctx, 'duration', 5));
    // clients still play a cast gesture + cast sound for procs (docs/SIM_REQUESTS.md WEI-10):
    // at most one every 8 s so sustained fire does not read as constant casting
    emitProc(ctx, JIANXIONG_PROC_GAP);
  },
});

// 宁教我负天下人 (Q): 6 s — squad +50 % damage and charges the crosshair target (free charge
// without one), you gain 20 % lifesteal. The squad's previous order comes back afterwards.
const savedOrders = new WeakMap<Entity, { prev: SquadOrder; mine: SquadOrder }>();

const sameOrder = (a: SquadOrder, b: SquadOrder): boolean => a.kind === b.kind && a.targetId === b.targetId;

registerAbility({
  id: 'caocao_ningjiao',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const h = self.hero!;
    const duration = param(ctx, 'duration', 6);
    const target = crosshairEnemy(ctx, param(ctx, 'range', 60));
    const order: SquadOrder = target ? { kind: 'attack', targetId: target.id, point: { ...target.pos } } : { kind: 'charge' };
    const prev = savedOrders.get(self)?.prev ?? { ...h.order };
    sim.setSquadOrder(self.id, order);
    savedOrders.set(self, { prev, mine: { ...order } });
    setCast(ctx, target ? { pos: target.pos, target: target.id } : { pos: self.pos });
    setState(ctx, 'until', sim.time + duration);
    sim.applyStatus(self.id, 'lifesteal', duration, { sourceId: self.id, params: { frac: param(ctx, 'lifesteal', 0.2) } });
    return true;
  },
  modifiers(ctx) {
    if (ctx.sim.time < getState(ctx, 'until')) return { troopDmgMul: param(ctx, 'troopDmgMul', 1.5) };
    return undefined;
  },
  tick(ctx) {
    const { sim, self } = ctx;
    const until = getState(ctx, 'until');
    if (until <= 0 || sim.time < until) return;
    setState(ctx, 'until', 0);
    const saved = savedOrders.get(self);
    savedOrders.delete(self);
    const h = self.hero;
    // restore the previous order unless the player re-commanded the squad meanwhile
    if (saved && h && !h.dead && sameOrder(h.order, saved.mine)) {
      const prevTarget = sim.get(saved.prev.targetId);
      const stale = saved.prev.kind === 'attack' && saved.prev.targetId !== undefined && (!prevTarget || !prevTarget.alive || prevTarget.hero?.dead);
      sim.setSquadOrder(self.id, stale ? { kind: 'follow' } : saved.prev);
    }
  },
});

// 望梅止渴 (E): fully heal your soldiers, heal yourself 50; you and your squad gain 30 % haste 5 s.
registerAbility({
  id: 'caocao_wangmei',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const duration = param(ctx, 'duration', 5);
    const haste = { amount: param(ctx, 'haste', 0.3) };
    for (const id of [...(self.hero?.squad ?? [])]) {
      const t = sim.get(id);
      if (!t || !t.alive) continue;
      if (t.hp < t.maxHp) sim.heal(t.id, t.maxHp - t.hp, self.id);
      sim.applyStatus(t.id, 'haste', duration, { sourceId: self.id, params: haste });
    }
    sim.heal(self.id, param(ctx, 'selfHeal', 50), self.id);
    sim.applyStatus(self.id, 'haste', duration, { sourceId: self.id, params: haste });
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
});

// 护驾 (lord, real Lord only — the world strips lord skills from everyone else): summon 3
// Tiger Guards (30 s); for 6 s half of the damage you take goes to the nearest Wei unit
// within 10 m (your own soldiers first, then other Wei soldiers, then Wei heroes).
function pickGuard(ctx: DamageHookCtx): Entity | undefined {
  const { sim, self, req } = ctx;
  const x = ext(sim);
  const attackerSide = x.creditOf(req.sourceId);
  const radius = param(ctx, 'radius', 10);
  let best: Entity | undefined;
  let bestScore = Infinity;
  for (const u of sim.queryRadius(self.pos, radius, { kinds: ['troop', 'hero'], exclude: [self.id] })) {
    if (u.kingdom !== 'wei' || !u.alive || u.hp <= 0) continue;
    if (u.hero && (u.hero.dead || u.hero.downed)) continue;
    if (attackerSide !== undefined && x.creditOf(u.id) === attackerSide) continue; // never onto the attacker's own side
    if (sim.hasStatus(u.id, 'invuln')) continue;
    const tier = u.kind === 'troop' ? (x.creditOf(u.id) === self.id ? 0 : 1) : 2;
    const score = tier * 1000 + flatDist(u.pos, self.pos);
    if (score < bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

registerAbility({
  id: 'caocao_hujia',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    summonTroops(ctx, 'wei_tigerGuard', Math.max(0, Math.round(param(ctx, 'count', 3))), param(ctx, 'lifetime', 30));
    setState(ctx, 'until', sim.time + param(ctx, 'duration', 6));
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
  modifyIncoming(ctx, amount) {
    const { sim, self, req } = ctx;
    if (!(amount > 0) || sim.time >= getState(ctx, 'until')) return amount;
    if (req.redirected || req.type === 'zone' || self.hero?.downed || self.hero?.dead) return amount;
    const guard = pickGuard(ctx);
    if (!guard) return amount;
    const moved = amount * Math.min(1, Math.max(0, param(ctx, 'redirectFrac', 0.5)));
    // source-less on purpose: the attacker's outgoing multipliers were already applied to
    // `amount`, and it must not count as the attacker's (nullifiable) ability hit. See
    // docs/SIM_REQUESTS.md (redirected damage) for the proper pipeline fix.
    sim.dealDamage({
      targetId: guard.id,
      amount: moved,
      type: req.type,
      redirected: true,
      noReflect: true,
      canDodge: false,
      abilityId: ctx.def.id,
      pos: { x: guard.pos.x, y: guard.pos.y + guard.height * 0.55, z: guard.pos.z },
    });
    return amount - moved;
  },
});
