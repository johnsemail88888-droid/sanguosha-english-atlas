// 许褚 Xu Chu — 虎痴 / 裸衣 / 虎卫猛击.
import { GRAVITY } from '../../physics';
import { UNIT_KINDS, alive, deny, flatAimDir, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { brakeAtDashEnd, canAct, chestOf, immobile, setCast } from './shared';

// 虎痴 (passive): immune to knockback and knock-up. Squad +1 comes from HeroDef.troopBonus
// (params.troopBonus only mirrors it — never added twice).
registerAbility({
  id: 'xuchu_huchi',
  modifiers() {
    return { knockbackImmune: true };
  },
});

// 裸衣 (Q): 7 s — deal ×1.5 damage, take ×1.25 damage (self-applied statuses: visible to
// everyone, and a teammate's cleanse can strip the drawback).
registerAbility({
  id: 'xuchu_luoyi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const duration = param(ctx, 'duration', 7);
    sim.applyStatus(self.id, 'dmgBoost', duration, { sourceId: self.id, params: { mul: param(ctx, 'mul', 1.5) } });
    sim.applyStatus(self.id, 'dmgTakenUp', duration, { sourceId: self.id, params: { mul: param(ctx, 'takenMul', 1.25) } });
    setCast(ctx, { pos: self.pos, target: self.id });
    return true;
  },
});

// 虎卫猛击 (E): leap 6 m along your aim (0.5 s arc) and slam down: every enemy within 6 m takes
// 80 melee damage and is knocked up (each unit hit once). Cancelled if you are downed mid-air.
registerAbility({
  id: 'xuchu_slam',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx) || immobile(sim, self)) return deny(ctx, 'blocked');
    const dir = flatAimDir(ctx);
    const leap = param(ctx, 'leap', 6);
    const leapTime = Math.max(0.15, param(ctx, 'leapTime', 0.5));
    sim.dash(self.id, dir, leap, leapTime);
    if (!self.forced) return deny(ctx, 'blocked');
    setState(ctx, 'until', self.forced.until);
    setCast(ctx, { pos: { x: self.pos.x + dir.x * leap, y: self.pos.y, z: self.pos.z + dir.z * leap }, dir });
    // a hop that lands when the dash ends
    self.vel.y = Math.max(self.vel.y, (GRAVITY * leapTime) / 2);
    self.onGround = false;
    const radius = param(ctx, 'radius', 6);
    const damage = param(ctx, 'damage', 80);
    const knockUp = param(ctx, 'knockUp', 8);
    const dtype = ctx.def.dtype ?? 'melee';
    const abilityId = ctx.def.id;
    sim.schedule(leapTime, () => {
      if (!alive(self) || self.hero?.downed) return;
      const center = { ...self.pos };
      sim.emit({ t: 'melee', src: self.id, pos: chestOf(self), dir, range: radius, arc: 360 });
      sim.emit({ t: 'sfx', name: 'stomp', pos: center });
      const eye = { x: center.x, y: center.y + 0.8, z: center.z };
      const hits = sim.queryRadius(center, radius, { kinds: UNIT_KINDS, notFriendlyTo: self.id, exclude: [self.id] });
      for (const t of hits) {
        if (!t.alive || t.hero?.dead) continue;
        if (!sim.lineOfSight(eye, chestOf(t)) && !sim.lineOfSight(eye, sim.eyePos(t))) continue; // not through walls
        const res = sim.dealDamage({ targetId: t.id, sourceId: self.id, amount: damage, type: dtype, abilityId, pos: chestOf(t) });
        if (res.blocked === 'dodge' || res.blocked === 'invuln' || res.blocked === 'nullify') continue;
        if (!t.alive || t.hero?.dead || t.hero?.downed) continue;
        const dx = t.pos.x - center.x;
        const dz = t.pos.z - center.z;
        const l = Math.hypot(dx, dz) || 1;
        sim.knockback(t.id, { x: (dx / l) * 0.35, y: 1, z: (dz / l) * 0.35 }, knockUp);
      }
    });
    return true;
  },
  tick(ctx) {
    const until = getState(ctx, 'until');
    if (until <= 0) return;
    if (ctx.sim.time >= until) setState(ctx, 'until', 0);
    else brakeAtDashEnd(ctx.sim, ctx.self, until);
  },
});
