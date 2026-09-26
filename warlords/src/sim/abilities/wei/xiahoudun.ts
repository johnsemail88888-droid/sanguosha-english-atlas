// 夏侯惇 Xiahou Dun — 刚烈 / 拔矢啖睛 / 独目怒冲.
import type { Entity, EntityId } from '../../../core/types';
import type { AbilityCtx } from '../../api';
import { ext } from '../../ext';
import { deny, flatAimDir, getState, param, setState, unitsAlongLine } from '../common';
import { registerAbility } from '../registry';
import { brakeAtDashEnd, canAct, chestOf, flatDist, immobile, losBetween, setCast } from './shared';

// 刚烈 (passive): 30 % of any damage you take is dealt back to the attacker. Implemented with
// the engine's 'thorns' status, kept up for as long as you live: it reflects the damage
// actually taken (HP + shield) as undodgeable 'normal' damage (the engine's thorns type — the
// data's dtype must stay 'normal'), ignores zone / source-less damage and anything already
// carrying noReflect (DoT ticks, reflects), so it never loops and 无懈可击 never cancels it.
// The status is finite and topped up (not Infinity): the snapshot codec cannot send an
// "until consumed" status yet (docs/SIM_REQUESTS.md WEI-9) and remote clients would see it
// as expired. A refresh with equal params replaces the instance silently (no status event).
const THORNS_SPAN = 60;
const THORNS_REFRESH = 30;

function thornsLeft(e: Entity, selfId: EntityId, now: number): number {
  let left = 0;
  for (const s of e.statuses) if (s.id === 'thorns' && s.sourceId === selfId && s.until > now) left = Math.max(left, s.until - now);
  return left;
}

registerAbility({
  id: 'xiahoudun_ganglie',
  tick(ctx) {
    const { sim, self } = ctx;
    if (!self.alive || self.hero?.dead) return;
    if (thornsLeft(self, self.id, sim.time) >= THORNS_REFRESH) return;
    sim.applyStatus(self.id, 'thorns', THORNS_SPAN, { sourceId: self.id, params: { frac: param(ctx, 'reflectFrac', 0.3) } });
  },
});

// 拔矢啖睛 (Q): heal 30 % of your missing HP and deal ×1.3 damage for 6 s.
registerAbility({
  id: 'xiahoudun_bashi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const missing = Math.max(0, self.maxHp - self.hp);
    if (missing > 0) sim.heal(self.id, missing * param(ctx, 'missingFrac', 0.3), self.id);
    sim.applyStatus(self.id, 'dmgBoost', param(ctx, 'duration', 6), { sourceId: self.id, params: { mul: param(ctx, 'mul', 1.3) } });
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
});

// 独目怒冲 (E): charge 12 m along your aim; the first hero in your path takes 60 melee damage,
// is stunned 1 s and stops the charge. Heroes that dodge / are invulnerable are passed through.
// Contact needs the body to really meet it: roughly the same level (not on a roof / ledge above
// or below the lane) and in line of sight (never through a wall you are running along).
const CONTACT_DY = 1.5;
const passedBy = new WeakMap<Entity, Set<EntityId>>();

function endCharge(ctx: AbilityCtx, stop: boolean): void {
  const self = ctx.self;
  setState(ctx, 'until', 0);
  passedBy.delete(self);
  // stop on impact: the world ends the dash at walking speed at most (WEI-6)
  if (stop) ext(ctx.sim).endDash(self.id);
}

function chargeContact(ctx: AbilityCtx): void {
  const { sim, self } = ctx;
  const from = { x: getState(ctx, 'px'), y: self.pos.y, z: getState(ctx, 'pz') };
  const dx = getState(ctx, 'dx');
  const dz = getState(ctx, 'dz');
  // look a little ahead of the body so contact happens shoulder-to-shoulder, not inside
  const reach = self.radius + 0.35;
  const to = { x: self.pos.x + dx * reach, y: self.pos.y, z: self.pos.z + dz * reach };
  setState(ctx, 'px', self.pos.x);
  setState(ctx, 'pz', self.pos.z);
  const passed = passedBy.get(self) ?? new Set<EntityId>();
  const width = param(ctx, 'width', 1.5);
  const cands = unitsAlongLine(sim, self, from, to, width, { kinds: ['hero'] }).filter(
    (h) => !passed.has(h.id) && !h.hero?.dead && !h.hero?.downed && Math.abs(h.pos.y - self.pos.y) < CONTACT_DY && losBetween(sim, self, h),
  );
  if (cands.length === 0) return;
  cands.sort((a, b) => flatDist(a.pos, from) - flatDist(b.pos, from));
  for (const t of cands) {
    passed.add(t.id);
    passedBy.set(self, passed);
    const res = sim.dealDamage({
      targetId: t.id,
      sourceId: self.id,
      amount: param(ctx, 'damage', 60),
      type: ctx.def.dtype ?? 'melee',
      abilityId: ctx.def.id,
      pos: chestOf(t),
    });
    if (res.blocked === 'dodge' || res.blocked === 'invuln') continue; // rolled aside / immune: keep going
    if (res.blocked !== 'nullify' && t.alive && !t.hero?.dead) {
      sim.applyStatus(t.id, 'stun', Math.min(1.5, param(ctx, 'stun', 1)), { sourceId: self.id });
    }
    sim.emit({ t: 'melee', src: self.id, pos: chestOf(self), dir: { x: dx, y: 0, z: dz }, range: 2, arc: 90 });
    endCharge(ctx, true);
    return;
  }
}

registerAbility({
  id: 'xiahoudun_charge',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx) || immobile(sim, self)) return deny(ctx, 'blocked');
    const dir = flatAimDir(ctx);
    const dist = param(ctx, 'dash', 12);
    const time = Math.max(0.1, param(ctx, 'dashTime', 0.5));
    sim.dash(self.id, dir, dist, time);
    if (!self.forced) return deny(ctx, 'blocked');
    passedBy.delete(self);
    setState(ctx, 'until', self.forced.until);
    setState(ctx, 'px', self.pos.x);
    setState(ctx, 'pz', self.pos.z);
    setState(ctx, 'dx', dir.x);
    setState(ctx, 'dz', dir.z);
    setCast(ctx, { pos: { x: self.pos.x + dir.x * dist, y: self.pos.y, z: self.pos.z + dir.z * dist }, dir });
    return true;
  },
  tick(ctx) {
    const until = getState(ctx, 'until');
    if (until <= 0) return;
    const self = ctx.self;
    // downed, knocked around by something else (forced replaced) or simply over
    if (self.hero?.downed || !self.forced || self.forced.until !== until) {
      endCharge(ctx, false);
      return;
    }
    chargeContact(ctx);
    if (getState(ctx, 'until') > 0) brakeAtDashEnd(ctx.sim, self, until);
  },
});
