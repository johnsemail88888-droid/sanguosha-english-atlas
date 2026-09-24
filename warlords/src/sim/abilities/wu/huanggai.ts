// 黄盖 Huang Gai — 赤胆 (low-HP fire/explosive bonus), 苦肉 (HP for items +
// fire rate), 诈降火船 (slow fire-ship drone: blast + burning field).
import type { Vec3 } from '../../../core/math';
import type { AbilityCtx } from '../../api';
import { param } from '../common';
import { registerAbility } from '../registry';
import { centerOf, grantItems, isUp, registerFieldKind, setCast, whenProjectileGone } from './util';

// 赤胆 (passive): below hpFrac of max HP, your fire and explosive damage ×mul.
registerAbility({
  id: 'huanggai_chidan',
  modifyOutgoing(ctx, amount) {
    const t = ctx.req.type;
    if (t !== 'fire' && t !== 'explosive') return amount;
    const self = ctx.self;
    if (self.hp >= self.maxHp * param(ctx, 'hpFrac', 0.5)) return amount;
    return amount * param(ctx, 'mul', 1.3);
  },
});

// 苦肉 (Q): lose hpCost HP (not damage: no hooks, shields or armor) → `items` random items and
// ×fireRateMul fire rate for `duration` s. Needs more than hpCost HP.
registerAbility({
  id: 'huanggai_kurou',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const cost = Math.max(0, param(ctx, 'hpCost', 40));
    if (self.hp <= cost) return false;
    self.hp -= cost;
    grantItems(sim, self, param(ctx, 'items', 2));
    sim.applyStatus(self.id, 'fireRateUp', param(ctx, 'duration', 5), {
      sourceId: self.id,
      params: { mul: param(ctx, 'fireRateMul', 1.4) },
    });
    setCast(ctx, { pos: centerOf(self) });
    return true;
  },
});

// 诈降火船 (E): a burning drone flies along the aim ray at `speed` m/s and blows up on contact or
// after `lifetime` s: `damage` fire in `radius` m (falloff to 50 % at the rim) and a burning
// field (fieldRadius m, fieldDps/s for fieldTime s). The blast still happens if you die meanwhile.
export const FIRESHIP_FIELD = 'huochuan_fire';
registerFieldKind(FIRESHIP_FIELD, 'fire');

function fireshipBlast(ctx: AbilityCtx, at: Vec3): void {
  const { sim, self, def } = ctx;
  const dtype = def.dtype ?? 'fire';
  const pos = { x: at.x, y: at.y, z: at.z };
  // no shove: the victims stay in the fire they are standing in
  sim.explode(pos, param(ctx, 'radius', 6), param(ctx, 'damage', 120), dtype, self.id, { kind: 'fire', abilityId: def.id });
  const dps = param(ctx, 'fieldDps', 15);
  const time = param(ctx, 'fieldTime', 5);
  if (dps > 0 && time > 0) {
    sim.spawnHazard({
      kind: FIRESHIP_FIELD,
      ownerId: self.id,
      // spawnHazard settles it on the surface below (never on a roof above the blast)
      pos: { x: pos.x, y: pos.y - 1.5, z: pos.z },
      radius: param(ctx, 'fieldRadius', 3),
      duration: time,
      tickEvery: 0.5,
      params: { damage: dps * 0.5 },
      dtype,
    });
  }
}

/**
 * Launch direction: eye → crosshair point, or straight along the aim ray when the
 * crosshair rests on nothing within reach (sky, far away) — aimPoint would drop
 * such a point to the ground and send the ship into the dirt.
 */
function launchDir(ctx: AbilityCtx, reach: number): Vec3 {
  const { sim, self } = ctx;
  const eye = sim.eyePos(self);
  const p = sim.aimPoint(self, reach);
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  const dz = p.z - eye.z;
  const l = Math.hypot(dx, dy, dz);
  if (l < 0.5 || Math.hypot(p.x - self.pos.x, p.z - self.pos.z) >= reach - 0.5) return sim.aimRay(self).dir;
  return { x: dx / l, y: dy / l, z: dz / l };
}

registerAbility({
  id: 'huanggai_huochuan',
  activate(ctx) {
    const { sim, self, def } = ctx;
    if (!isUp(self)) return false;
    const speed = Math.max(1, param(ctx, 'speed', 12));
    const lifetime = Math.max(0.1, param(ctx, 'lifetime', 3));
    const dir = launchDir(ctx, speed * lifetime);
    setCast(ctx, { dir });
    const eye = sim.eyePos(self);
    const ship = sim.spawnProjectile({
      kind: 'fireship',
      ownerId: self.id,
      pos: { x: eye.x + dir.x * 0.8, y: eye.y + dir.y * 0.8, z: eye.z + dir.z * 0.8 },
      vel: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed },
      // the blast is resolved here (damage 0 / no explodeRadius: the projectile only carries it)
      damage: 0,
      dtype: def.dtype ?? 'fire',
      gravity: 0,
      lifetime,
      abilityId: def.id,
      radius: 0.5,
    });
    // bind the ctx data now: the callback may run after the caster died or changed state
    const snapshot: AbilityCtx = { ...ctx };
    whenProjectileGone(sim, ship, lifetime, (at) => fireshipBlast(snapshot, at));
    return true;
  },
});
