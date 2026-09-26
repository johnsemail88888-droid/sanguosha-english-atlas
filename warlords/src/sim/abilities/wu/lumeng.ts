// 吕蒙 Lü Meng — 克己 (idle stealth), 白衣渡江 (stealth + haste), 攻心 (disarm + steal).
import type { Entity, StatusInstance } from '../../../core/types';
import type { AbilityCtx } from '../../api';
import { ext } from '../../ext';
import { alive, getState, param, setState, stealFrom } from '../common';
import { registerAbility } from '../registry';
import { applyDebuff, centerOf, crosshairFoe, emitTrigger, isUp, setCast } from './util';

// ── 克己 (passive) ───────────────────────────────────────────────────────────
// After idleTime s without firing or taking damage, turn stealthy for up to
// maxDuration s. Firing (generic stealth rule) or taking damage breaks it. When
// it ends the idle timer restarts, so an idle Lü Meng cycles 8 s hidden / 5 s visible.
// The 克己 instance is tagged params.keji (no source) so breaking it on damage
// never strips 白衣渡江's stealth.
function kejiInstance(e: Entity, now: number): StatusInstance | undefined {
  for (const s of e.statuses) if (s.id === 'stealth' && s.until > now && (s.params?.keji ?? 0) > 0) return s;
  return undefined;
}

function breakKeji(ctx: AbilityCtx): void {
  // only the 克己 instance (白衣渡江's stealth stays): SimExt.removeStatusWhere (WU-3)
  if (kejiInstance(ctx.self, ctx.sim.time)) ext(ctx.sim).removeStatusWhere(ctx.self.id, 'stealth', (s) => (s.params?.keji ?? 0) > 0);
}

registerAbility({
  id: 'lumeng_keji',
  tick(ctx) {
    const { sim, self } = ctx;
    const now = sim.time;
    if (!self.hero || self.hero.dead) return;
    if (kejiInstance(self, now)) {
      if (self.hero.downed) breakKeji(ctx);
      return;
    }
    if (getState(ctx, 'on') > 0) {
      // it ended (expired, fired, hit): restart the idle timer from here
      setState(ctx, 'on', 0);
      setState(ctx, 'lastEnd', now);
    }
    if (self.hero.downed || sim.hasStatus(self.id, 'stealth')) return;
    const idle = param(ctx, 'idleTime', 5);
    const calm = Math.min(now - getState(ctx, 'lastFire'), now - getState(ctx, 'lastEnd'), ext(sim).sinceDamaged(self.id));
    if (calm + 1e-9 < idle) return;
    if (sim.applyStatus(self.id, 'stealth', param(ctx, 'maxDuration', 8), { params: { keji: 1 } })) {
      setState(ctx, 'on', 1);
      emitTrigger(ctx, { privateTo: self.id });
    }
  },
  onFire(ctx) {
    setState(ctx, 'lastFire', ctx.sim.time);
  },
  onDamageTaken(ctx) {
    breakKeji(ctx);
  },
});

// 白衣渡江 (Q): stealth + haste for `duration` s. Only firing breaks this stealth.
registerAbility({
  id: 'lumeng_baiyi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const dur = param(ctx, 'duration', 6);
    sim.applyStatus(self.id, 'stealth', dur, { sourceId: self.id });
    sim.applyStatus(self.id, 'haste', dur, { sourceId: self.id, params: { amount: param(ctx, 'haste', 0.3) } });
    setCast(ctx, { pos: centerOf(self) });
    return true;
  },
});

// 攻心 (E): the crosshair enemy is disarmed and robbed of `steal` item(s) (谦逊 blocks the theft).
registerAbility({
  id: 'lumeng_gongxin',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const t = crosshairFoe(ctx, param(ctx, 'range', 20));
    if (!t) return false;
    setCast(ctx, { target: t.id, pos: centerOf(t) });
    const outcome = applyDebuff(ctx, t, 'disarm', param(ctx, 'disarm', 2));
    if (outcome === 'nullified') return true;
    if (t.hero) {
      const n = Math.max(0, Math.round(param(ctx, 'steal', 1)));
      for (let i = 0; i < n && alive(t); i++) if (!stealFrom(sim, self, t)) break;
    }
    return true;
  },
});
