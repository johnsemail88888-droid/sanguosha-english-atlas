// 吕布 Lü Bu — 无双 (passive, incl. the built-in 赤兔), 方天画戟 (Q), 辕门射戟 (E).
import { MOUNT_BY_ID } from '../../../data';
import { ext } from '../../ext';
import { coneAttack, flatAimDir, param } from '../common';
import { registerAbility } from '../registry';
import { canAct, longShotDir, setCastEvent } from './util';

/** hard CC on heroes never exceeds this (data/heroes.ts header) */
const MAX_HERO_STUN = 1.5;

// 无双 (passive): everything Lü Bu deals himself (bullets, rockets, abilities) is undodgeable —
// no roll i-frames, 八卦, dodgeChance or evasion passives — and ignores 50 % of shields.
// Rides 赤兔: +15 % speed, which does not stack with an equipped mount (the faster one counts).
registerAbility({
  id: 'lubu_wushuang',
  beforeDamageDealt(ctx) {
    ctx.req.canDodge = false;
  },
  modifiers(ctx) {
    const base = param(ctx, 'speedMul', 1.15);
    const mount = ctx.self.hero?.mount ? MOUNT_BY_ID[ctx.self.hero.mount] : undefined;
    // the world multiplies the mount's speed in; keep the total at max(赤兔, mount)
    const speedMul = mount && mount.speedMul > 0 ? Math.max(1, base / mount.speedMul) : base;
    return { shieldPierce: param(ctx, 'shieldPierce', 0.5), speedMul };
  },
});

// 方天画戟 (Q): 360° halberd spin (5 m): 110 melee damage + knockback to every enemy around.
registerAbility({
  id: 'lubu_fangtian',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const origin = { x: self.pos.x, y: self.pos.y + self.height * 0.55, z: self.pos.z };
    coneAttack(sim, self, origin, flatAimDir(ctx), param(ctx, 'radius', 5), 360, {
      damage: param(ctx, 'damage', 110),
      dtype: ctx.def.dtype ?? 'melee',
      abilityId: ctx.def.id,
      knockback: param(ctx, 'knockback', 8),
    });
    setCastEvent(ctx, { pos: { ...self.pos } });
    return true;
  },
});

// 辕门射戟 (E): a precise long shot (ability ray, not a weapon hit): the first unit hit takes
// 140 damage and is stunned 1 s. Walls stop it.
registerAbility({
  id: 'lubu_sheji',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const range = param(ctx, 'range', 120);
    const eye = sim.eyePos(self);
    const dir = longShotDir(ctx, range);
    const hit = ext(sim).fireHitscan(self.id, eye, dir, {
      damage: param(ctx, 'damage', 140),
      range,
      dtype: ctx.def.dtype ?? 'normal',
      abilityId: ctx.def.id,
      canDodge: false,
      status: { id: 'stun', duration: Math.min(MAX_HERO_STUN, param(ctx, 'stun', 1)) },
    });
    const end = hit ? hit.point : { x: eye.x + dir.x * range, y: eye.y + dir.y * range, z: eye.z + dir.z * range };
    setCastEvent(ctx, { pos: end, target: hit?.entityId, dir });
    return true;
  },
});
