// 赵云 Zhao Yun — 龙胆 (passive), 七进七出 (Q, 3 charges), 长坂救主 (E).
import { registerAbility } from '../registry';
import { flatAimDir, getState, param, setState } from '../common';
import { ahead, charge, crosshairFriend, emitAbility, flatDist, isRooted, setCast } from './util';

/** base dodge-roll charges every hero has (world.ts BASE_DODGE_CHARGES) */
const BASE_DODGES = 2;

// 龙胆 (passive): 3 dodge charges (you spawn with all 3); every dodge roll
// empowers your WEAPON damage for a short window.
registerAbility({
  id: 'zhaoyun_longdan',
  modifiers(ctx) {
    return { extraDodgeCharges: Math.max(0, Math.round(param(ctx, 'maxDodges', 3)) - BASE_DODGES) };
  },
  tick(ctx) {
    // spawn with the full 3 charges instead of recharging the third one
    const h = ctx.self.hero;
    if (!h || ctx.sim.tick > 1) return;
    h.dodgeCharges = Math.max(h.dodgeCharges, Math.round(param(ctx, 'maxDodges', 3)));
  },
  onDodge(ctx) {
    const { sim, self } = ctx;
    setState(ctx, 'until', sim.time + param(ctx, 'duration', 2.5));
    emitAbility(sim, self, ctx.def.id, { pos: sim.eyePos(self) });
  },
  modifyOutgoing(ctx, amount) {
    if (ctx.req.weaponId === undefined || ctx.sim.time >= getState(ctx, 'until')) return amount;
    return amount * param(ctx, 'mul', 1.4);
  },
});

// 七进七出 (Q): an invulnerable dash; every enemy passed through is struck once.
registerAbility({
  id: 'zhaoyun_qijin',
  activate(ctx) {
    const { sim, self } = ctx;
    if (isRooted(sim, self)) return false;
    const dir = flatAimDir(ctx);
    const distance = param(ctx, 'dash', 7);
    const time = charge(ctx, {
      dir,
      distance,
      duration: Math.max(0.05, param(ctx, 'dashTime', 0.25)),
      invuln: true,
      width: param(ctx, 'width', 1.5),
      strike: { damage: param(ctx, 'damage', 40), dtype: ctx.def.dtype ?? 'melee', abilityId: ctx.def.id },
    });
    // true invulnerability (the dash's own i-frames only stop dodgeable hits)
    sim.applyStatus(self.id, 'invuln', time + 0.05, { sourceId: self.id });
    setCast(ctx, { dir, pos: ahead(self.pos, dir, distance) });
    return true;
  },
});

// 长坂救主 (E): dash to the hero under the crosshair and shield you both; with
// no one to rescue, shield yourself. Downed allies can be shielded (their bleed-out).
registerAbility({
  id: 'zhaoyun_jiuzhu',
  activate(ctx) {
    const { sim, self } = ctx;
    const shield = param(ctx, 'shield', 120);
    const duration = param(ctx, 'duration', 6);
    const target = crosshairFriend(ctx, param(ctx, 'range', 20), true);
    sim.addShield(self.id, shield, duration);
    if (target) {
      sim.addShield(target.id, shield, duration);
      const d = flatDist(self.pos, target.pos) - (self.radius + target.radius + 0.6);
      if (d > 0.5 && !isRooted(sim, self)) {
        const dir = { x: target.pos.x - self.pos.x, y: 0, z: target.pos.z - self.pos.z };
        charge(ctx, { dir, distance: d, duration: Math.max(0.05, param(ctx, 'dashTime', 0.35)), width: 0 });
      }
      setCast(ctx, { target: target.id, pos: sim.eyePos(target) });
    } else {
      setCast(ctx, { target: self.id, pos: sim.eyePos(self) });
    }
    return true;
  },
});
