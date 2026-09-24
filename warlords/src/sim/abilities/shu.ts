// 蜀 Shu ability implementations. 关羽 is the wave-1 reference implementation;
// wave-2 engineers add the other Shu heroes here following the same pattern:
// read tunables from AbilityDef.params (with fallbacks), use common.ts helpers,
// return true from activate() only when the ability actually fired.
import { registerAbility } from './registry';
import { coneAttack, crosshairEnemy, dashStrike, flatAimDir, getState, param, setState } from './common';

// 武圣 (passive): fire / explosive / melee damage +25 %; hitting a burning target adds a bonus slash.
registerAbility({
  id: 'guanyu_wusheng',
  modifyOutgoing(ctx, amount) {
    const t = ctx.req.type;
    if (t === 'fire' || t === 'explosive' || t === 'melee') return amount * param(ctx, 'mul', 1.25);
    return amount;
  },
  onDamageDealt(ctx, dealt) {
    const target = ctx.other;
    if (!target || dealt <= 0 || ctx.req.abilityId === ctx.def.id || !target.alive) return;
    if (!ctx.sim.hasStatus(target.id, 'burn')) return;
    const now = ctx.sim.time;
    if (now < getState(ctx, 'slashReady')) return;
    setState(ctx, 'slashReady', now + param(ctx, 'slashCd', 1));
    ctx.sim.dealDamage({
      targetId: target.id,
      sourceId: ctx.self.id,
      amount: param(ctx, 'bonusSlash', 30),
      type: ctx.def.dtype ?? 'melee',
      abilityId: ctx.def.id,
      canDodge: false,
      noReflect: true,
    });
    ctx.sim.emit({ t: 'melee', src: ctx.self.id, pos: ctx.sim.eyePos(ctx.self), dir: flatAimDir(ctx), range: 2, arc: 60 });
  },
});

// 青龙斩 (Q): charge forward, then sweep a wide arc with the glaive (damage + knockback).
registerAbility({
  id: 'guanyu_qinglong',
  activate(ctx) {
    const self = ctx.self;
    if (self.hero?.downed) return false;
    const dir = flatAimDir(ctx);
    const distance = param(ctx, 'dash', 8);
    dashStrike(ctx, {
      distance,
      duration: Math.max(0.1, param(ctx, 'dashTime', 0.35)),
      dir,
      onArrive: (sim, me) => {
        const origin = sim.eyePos(me);
        coneAttack(sim, me, origin, dir, param(ctx, 'range', 4.5), param(ctx, 'arc', 110), {
          damage: param(ctx, 'damage', 90),
          dtype: ctx.def.dtype ?? 'melee',
          abilityId: ctx.def.id,
          knockback: param(ctx, 'knockback', 6),
        });
      },
    });
    return true;
  },
});

// 义绝 (E): the enemy under the crosshair is silenced and takes +30 % damage from you.
registerAbility({
  id: 'guanyu_yijue',
  activate(ctx) {
    const target = crosshairEnemy(ctx, param(ctx, 'range', 30));
    if (!target) return false;
    const duration = param(ctx, 'duration', 8);
    const landed = ctx.sim.applyStatus(target.id, 'silence', duration, { sourceId: ctx.self.id });
    if (landed) {
      setState(ctx, 'target', target.id);
      setState(ctx, 'until', ctx.sim.time + duration);
    }
    // the card is spent even when 无懈可击 cancels it
    return true;
  },
  modifyOutgoing(ctx, amount) {
    if (ctx.req.targetId === getState(ctx, 'target', -1) && ctx.sim.time < getState(ctx, 'until')) {
      return amount * param(ctx, 'mul', 1.3);
    }
    return amount;
  },
});
