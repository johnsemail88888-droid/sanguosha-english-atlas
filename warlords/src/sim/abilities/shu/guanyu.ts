// 关羽 Guan Yu — 武圣 (passive), 青龙斩 (Q), 义绝 (E). The wave-1 reference
// implementation, reviewed: 青龙斩 now charges INTO the first unit in front of
// him instead of through it (the sweep used to whiff on close targets) — units
// beside or behind him never shorten the charge — and sweeps in place when
// rooted; 武圣's bonus slash ignores damage-over-time ticks.
import { registerAbility } from '../registry';
import { crosshairEnemy, crosshairEnemyHero, flatAimDir, getState, param, setState, unitsAlongLine } from '../common';
import { ahead, charge, coneStrike, isDirectHit, isRooted, isUp, setCast } from './util';

/** gap kept between 关羽 and the unit his charge stops at */
const CHARGE_STOP_GAP = 1.2;

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
    if (!target || dealt <= 0 || ctx.req.abilityId === ctx.def.id || !target.alive || target.hero?.dead) return;
    // a burn / poison tick is not a "hit"
    if (!isDirectHit(ctx.req)) return;
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

// 青龙斩 (Q): charge up to `dash` m (stopping at the first enemy in the way),
// then sweep a wide arc with the glaive (damage + knockback).
registerAbility({
  id: 'guanyu_qinglong',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const dir = flatAimDir(ctx);
    const max = Math.max(0, param(ctx, 'dash', 8));
    let distance = isRooted(sim, self) ? 0 : max;
    if (distance > 0) {
      for (const t of unitsAlongLine(sim, self, self.pos, ahead(self.pos, dir, distance), 1.0)) {
        // the segment query clamps to its start: units beside / behind him come
        // back too — only what stands in front of him stops the charge
        const along = (t.pos.x - self.pos.x) * dir.x + (t.pos.z - self.pos.z) * dir.z;
        if (along <= t.radius) continue;
        distance = Math.min(distance, Math.max(0, along - t.radius - CHARGE_STOP_GAP));
      }
    }
    const sweep = (): void => {
      if (!isUp(self)) return;
      coneStrike(sim, self, sim.eyePos(self), dir, param(ctx, 'range', 4.5), param(ctx, 'arc', 110), {
        damage: param(ctx, 'damage', 90),
        dtype: ctx.def.dtype ?? 'melee',
        abilityId: ctx.def.id,
        knockback: param(ctx, 'knockback', 7),
      });
    };
    if (distance < 0.5) {
      sweep();
    } else {
      const time = Math.max(0.1, param(ctx, 'dashTime', 0.35)) * (max > 0 ? distance / max : 1);
      charge(ctx, { dir, distance, duration: time, width: 0, onArrive: sweep });
    }
    setCast(ctx, { dir, pos: ahead(self.pos, dir, distance) });
    return true;
  },
});

// 义绝 (E): the enemy under the crosshair is silenced and takes +30 % damage from you.
registerAbility({
  id: 'guanyu_yijue',
  activate(ctx) {
    // heroes first (a soldier in front of the crosshair should not eat the silence), then any enemy unit
    const range = param(ctx, 'range', 30);
    const target = crosshairEnemyHero(ctx, range) ?? crosshairEnemy(ctx, range);
    if (!target) return false;
    const duration = param(ctx, 'duration', 6);
    const landed = ctx.sim.applyStatus(target.id, 'silence', duration, { sourceId: ctx.self.id });
    if (landed) {
      setState(ctx, 'target', target.id);
      setState(ctx, 'until', ctx.sim.time + duration);
    }
    setCast(ctx, { target: target.id, pos: ctx.sim.eyePos(target) });
    // the card is spent even when 无懈可击 / 谦逊 cancels it
    return true;
  },
  modifyOutgoing(ctx, amount) {
    if (ctx.req.targetId === getState(ctx, 'target', -1) && ctx.sim.time < getState(ctx, 'until')) {
      return amount * param(ctx, 'mul', 1.3);
    }
    return amount;
  },
});
