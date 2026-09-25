// 甄姬 Zhen Ji — 倾国 / 洛神 / 凌波微步.
import { flatAimDir, param, setState } from '../common';
import { registerAbility } from '../registry';
import { canAct, flatDist, grantRandomItems, immobile, safeBlink, setCast } from './shared';

// 倾国 (passive): while moving (horizontal speed ≥ 1.5 m/s) each dodgeable weapon bullet has a
// 25 % chance to miss entirely. Combat folds the chance with 八卦 / dodgeChance statuses as
// 1 − Π(1 − p) under BULLET_EVASION_CAP and rolls once (never roll here).
registerAbility({
  id: 'zhenji_qingguo',
  bulletEvadeChance(ctx) {
    const self = ctx.self;
    if (!self.hero || self.hero.downed || self.hero.dead) return 0;
    const speed = Math.hypot(self.vel.x, self.vel.z);
    return speed >= param(ctx, 'minSpeed', 1.5) ? Math.min(1, Math.max(0, param(ctx, 'chance', 0.25))) : 0;
  },
});

// 洛神 (Q): judge up to 4 times — 60 / 50 / 40 / 30 % — one draw every 0.3 s; each success grants
// 1 random item, the first failure ends it. abilityState 'zhenji_luoshen:won' holds the result.
registerAbility({
  id: 'zhenji_luoshen',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const maxDraws = Math.max(0, Math.min(4, Math.round(param(ctx, 'maxDraws', 4))));
    const chances = [param(ctx, 'chance1', 0.6), param(ctx, 'chance2', 0.5), param(ctx, 'chance3', 0.4), param(ctx, 'chance4', 0.3)];
    const interval = Math.max(0, param(ctx, 'interval', 0.3));
    let won = 0;
    setState(ctx, 'won', 0);
    setState(ctx, 'drawing', 1);
    const draw = (i: number): void => {
      if (!self.alive || self.hero?.dead) return;
      if (i >= maxDraws || !sim.rng.chance(chances[i] ?? 0)) {
        setState(ctx, 'drawing', 0);
        sim.emit({ t: 'sfx', name: 'rim', pos: { ...self.pos } });
        return;
      }
      won++;
      setState(ctx, 'won', won);
      grantRandomItems(sim, self, 1);
      if (i + 1 >= maxDraws) {
        setState(ctx, 'drawing', 0);
        return;
      }
      sim.schedule(interval, () => draw(i + 1));
    };
    setCast(ctx, { pos: self.pos, target: self.id });
    draw(0);
    return true;
  },
});

// 凌波微步 (E): blink 10 m along your aim (targeting 'direction'), leaving a 4 m frost field at
// the start point for 4 s that slows enemies 40 %.
registerAbility({
  id: 'zhenji_lingbo',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx) || immobile(sim, self)) return false;
    const dist = param(ctx, 'blink', 10);
    const dir = flatAimDir(ctx);
    const start = { ...self.pos };
    const dest = safeBlink(ctx, { x: start.x + dir.x * dist, y: start.y, z: start.z + dir.z * dist }, dist);
    if (!dest || flatDist(dest, start) < 1) {
      // a wall right in front: put her back where she stood and keep the ability
      sim.teleport(self.id, start);
      return false;
    }
    sim.spawnHazard({
      kind: 'lingboFrost',
      ownerId: self.id,
      pos: start,
      radius: param(ctx, 'radius', 4),
      duration: param(ctx, 'duration', 4),
      tickEvery: 0.25,
      params: { slow: param(ctx, 'slow', 0.4) },
    });
    // pos = where the blink started (the frost field; she is at the landing): the VFX streak
    setCast(ctx, { pos: start, dir });
    return true;
  },
});
