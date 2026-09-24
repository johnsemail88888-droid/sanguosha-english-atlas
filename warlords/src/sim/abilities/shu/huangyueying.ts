// 黄月英 Huang Yueying — 集智 (passive), 木牛流马 (Q, turrets), 奇才 (E).
import type { Entity } from '../../../core/types';
import type { AbilityCtx, SimApi } from '../../api';
import { registerAbility } from '../registry';
import { crosshairPoint, getState, param, setState } from '../common';
import { emitAbility, ensureLoaded, setCast } from './util';

const TURRET_KIND = 'muniu';
const TURRET_WEAPON = 'turret_smg';
/** how often a deployed turret checks that its engineer still lives */
const TURRET_WATCH = 0.5;
/** 奇才 re-applies its buff to freshly deployed turrets / recruits this often */
const QICAI_REFRESH = 0.5;

/** This hero's live 木牛流马 turrets, oldest first. */
function ownTurrets(sim: SimApi, owner: Entity): Entity[] {
  const out: Entity[] = [];
  for (const e of sim.entities()) {
    if (e.kind === 'turret' && e.alive && e.ownerId === owner.id && e.turret?.kind === TURRET_KIND) out.push(e);
  }
  return out.sort((a, b) => (a.turret!.expiresAt - b.turret!.expiresAt) || a.id - b.id);
}

/** Own soldiers (squad incl. temporary recruits) and turrets. */
function ownGunners(sim: SimApi, owner: Entity): Entity[] {
  const out = ownTurrets(sim, owner);
  for (const id of owner.hero?.squad ?? []) {
    const t = sim.get(id);
    if (t && t.alive) out.push(t);
  }
  return out;
}

// 集智 (passive): every item you use cuts `cdr` s off all your ability cooldowns.
registerAbility({
  id: 'huangyueying_jizhi',
  onItemUsed(ctx) {
    const { sim, self } = ctx;
    const cdr = param(ctx, 'cdr', 3);
    if (!(cdr > 0) || !self.hero) return;
    let cut = false;
    for (const a of ctx.hero.abilities) {
      if (a.cooldown === undefined) continue;
      const left = sim.cooldownLeft(self.id, a.id);
      if (left <= 0) continue;
      sim.setCooldown(self.id, a.id, Math.max(0, left - cdr));
      cut = true;
    }
    if (cut) emitAbility(sim, self, ctx.def.id, { pos: sim.eyePos(self) });
  },
});

// 木牛流马 (Q): deploy an auto-turret next to you; at most `maxActive` stand at
// once (a new one replaces the oldest). Turrets fall apart when you die.
registerAbility({
  id: 'huangyueying_muniu',
  activate(ctx) {
    const { sim, self } = ctx;
    const max = Math.max(1, Math.round(param(ctx, 'maxActive', 2)));
    const existing = ownTurrets(sim, self);
    for (let i = 0; i <= existing.length - max; i++) dismantle(sim, existing[i]);
    const point = crosshairPoint(ctx, param(ctx, 'range', 6));
    const turret = sim.spawnTurret(self.id, point, TURRET_KIND, TURRET_WEAPON, param(ctx, 'lifetime', 15), param(ctx, 'hp', 200));
    // (an active 奇才 picks the new turret up on its next refresh)
    watchTurret(sim, self, turret);
    setCast(ctx, { pos: { ...turret.pos }, target: turret.id });
    return true;
  },
});

/** Take a turret down with a puff of smoke (replaced by a newer one, or its engineer died). */
function dismantle(sim: SimApi, turret: Entity): void {
  sim.emit({ t: 'explosion', pos: { ...turret.pos }, radius: 1, kind: 'smoke' });
  sim.removeEntity(turret.id);
}

/** Remove the turret once its engineer is dead (it would fight for nobody). */
function watchTurret(sim: SimApi, owner: Entity, turret: Entity): void {
  const check = (): void => {
    if (!turret.alive || !turret.turret) return;
    if (owner.hero?.dead) {
      dismantle(sim, turret);
      return;
    }
    if (sim.time < turret.turret.expiresAt) sim.schedule(TURRET_WATCH, check);
  };
  sim.schedule(TURRET_WATCH, check);
}

// 奇才 (E): your turrets and soldiers fire faster and your weapon uses no ammo.
registerAbility({
  id: 'huangyueying_qicai',
  activate(ctx) {
    const { sim, self } = ctx;
    const duration = param(ctx, 'duration', 6);
    setState(ctx, 'until', sim.time + duration);
    setState(ctx, 'next', 0);
    sim.applyStatus(self.id, 'noReload', duration, { sourceId: self.id });
    ensureLoaded(sim, self);
    overclock(ctx, duration);
    setCast(ctx, { pos: sim.eyePos(self) });
    return true;
  },
  tick(ctx) {
    const { sim } = ctx;
    const until = getState(ctx, 'until');
    if (until <= 0) return;
    const left = until - sim.time;
    if (left <= 0) {
      setState(ctx, 'until', 0);
      return;
    }
    if (sim.time < getState(ctx, 'next')) return;
    overclock(ctx, left);
  },
});

/** Apply the fire-rate buff to every own gunner that does not have it yet. */
function overclock(ctx: AbilityCtx, duration: number): void {
  const { sim, self } = ctx;
  setState(ctx, 'next', sim.time + QICAI_REFRESH);
  const mul = param(ctx, 'fireRateMul', 1.6);
  for (const u of ownGunners(sim, self)) {
    if (sim.statusParam(u.id, 'fireRateUp', 'mul', 1) >= mul) continue;
    sim.applyStatus(u.id, 'fireRateUp', duration, { sourceId: self.id, params: { mul } });
  }
}
