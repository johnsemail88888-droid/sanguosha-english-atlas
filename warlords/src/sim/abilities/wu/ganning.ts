// 甘宁 Gan Ning — 锦帆 (speed + kills refill the mag), 奇袭 (EMP bolt: strip
// armor/mount/shield + silence), 百骑劫营 (squad stealth, first attack +60 %).
import { BTN_FIRE } from '../../../core/types';
import type { AbilityCtx } from '../../api';
import { weaponDef } from '../../defs';
import { ext } from '../../ext';
import { alive, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { applyDebuff, centerOf, crosshairFoe, isUp, nullifiedBy, setCast } from './util';

// 锦帆 (passive): +10 % move speed; killing any unit (or downing a hero) refills the magazine.
registerAbility({
  id: 'ganning_jinfan',
  modifiers: (ctx) => ({ speedMul: param(ctx, 'speedMul', 1.1) }),
  onKill(ctx) {
    if (isUp(ctx.self)) ext(ctx.sim).refillMag(ctx.self.id);
  },
  onDamageDealt(ctx) {
    // a hero dropping to 0 HP goes down (濒死) before it dies: that is the kill moment for a shooter
    const t = ctx.other;
    if (t?.hero && !t.hero.downed && !t.hero.dead && t.hp <= 0 && isUp(ctx.self)) ext(ctx.sim).refillMag(ctx.self.id);
  },
});

// 奇袭 (Q): EMP bolt at the crosshair enemy — drops its armor and mount as loot, clears its
// shield and silences it. 无懈可击 cancels the whole bolt (spent); no target → no cooldown.
registerAbility({
  id: 'ganning_qixi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const t = crosshairFoe(ctx, param(ctx, 'range', 30));
    if (!t) return false;
    setCast(ctx, { target: t.id, pos: centerOf(t) });
    // 无懈可击 first, for the bolt as a whole: one charge (or the echo of one this tick) and
    // nothing happens — dismount / stripArmor don't consult it themselves (WU-4)
    if (nullifiedBy(sim, t, self.id)) return true;
    const outcome = applyDebuff(ctx, t, 'silence', param(ctx, 'silence', 2.5));
    // 'resisted' here = immune to the silence only (or a zero duration): the EMP still strips
    if (outcome === 'nullified' || !alive(t)) return true;
    const x = ext(sim);
    if (t.hero) {
      x.stripArmor(t.id, true);
      x.dismount(t.id);
    }
    if (t.shield > 0 || sim.hasStatus(t.id, 'shield')) {
      sim.removeStatus(t.id, 'shield');
      t.shield = 0;
    }
    return true;
  },
});

// 百骑劫营 (E): you and your squad turn stealthy for `duration` s. Your first attack from stealth —
// the first trigger pull: every weapon hit fired while it stays held, at most `burst` s (one shot
// for semi-automatic weapons; projectiles launched in it included) — deals ×firstHitMul.
function raidArmed(ctx: AbilityCtx): boolean {
  return ctx.sim.time < getState(ctx, 'armedUntil');
}

function inBurst(ctx: AbilityCtx): boolean {
  return ctx.sim.time <= getState(ctx, 'burstUntil', -1);
}

const triggerHeld = (ctx: AbilityCtx): boolean => (ctx.sim.inputOf(ctx.self).buttons & BTN_FIRE) !== 0;

registerAbility({
  id: 'ganning_jieying',
  activate(ctx) {
    const { sim, self } = ctx;
    const h = self.hero;
    if (!h || !isUp(self)) return false;
    const dur = param(ctx, 'duration', 8);
    sim.applyStatus(self.id, 'stealth', dur, { sourceId: self.id });
    for (const id of h.squad) {
      const u = sim.get(id);
      if (alive(u)) sim.applyStatus(id, 'stealth', dur, { sourceId: self.id });
    }
    setState(ctx, 'armedUntil', sim.time + dur);
    setState(ctx, 'burstUntil', -1);
    setCast(ctx, { pos: centerOf(self) });
    return true;
  },
  tick(ctx) {
    // the attack ends when the trigger is released (or he goes down)
    if (getState(ctx, 'burstUntil', -1) >= 0 && (!inBurst(ctx) || !triggerHeld(ctx) || !isUp(ctx.self))) setState(ctx, 'burstUntil', -1);
  },
  modifyOutgoing(ctx, amount) {
    const req = ctx.req;
    if (req.weaponId === undefined || req.sourceId !== ctx.self.id) return amount;
    if (!raidArmed(ctx) && !inBurst(ctx)) return amount;
    // projectile weapons are boosted at launch (onFire): never twice
    if (weaponDef(req.weaponId).projectile) return amount;
    return amount * param(ctx, 'firstHitMul', 1.6);
  },
  onFire(ctx, weaponId) {
    // hitscan / melee hits of this shot were boosted above (before onFire runs)
    const now = ctx.sim.time;
    if (raidArmed(ctx)) {
      setState(ctx, 'armedUntil', 0);
      setState(ctx, 'burstUntil', now + Math.max(0, param(ctx, 'burst', 1)));
    } else if (!inBurst(ctx)) {
      return;
    }
    const pr = weaponDef(weaponId).projectile;
    if (!pr) return;
    // projectile weapons: boost what this shot just launched (it lands after the attack is over)
    const mul = param(ctx, 'firstHitMul', 1.6);
    const born = now + pr.lifetime;
    for (const e of ctx.sim.entities()) {
      const p = e.proj;
      if (!p || e.ownerId !== ctx.self.id || p.weaponId !== weaponId || Math.abs(p.expiresAt - born) > 1e-6) continue;
      p.damage *= mul;
      p.explodeDamage *= mul;
    }
  },
});
