// Small helpers shared by the 群 Qun ability files (qun/*.ts). Everything goes
// through SimApi / SimExt; nothing here keeps module-level mutable state, so
// several casters (even two copies of one hero) never interfere.
import type { Vec3 } from '../../../core/math';
import type { Entity, EntityId, EntityKind } from '../../../core/types';
import type { AbilityCtx, SimApi } from '../../api';
import { UNIT_KINDS, alive } from '../common';

/**
 * Optional override of the { t: 'ability' } event the world emits after a
 * successful activate(): the resolved target / the range-clamped point instead
 * of the raw crosshair. Same `ctx.cast` property the Shu helper writes
 * (docs/SIM_REQUESTS.md SHU-3 / QUN-1); until SIM-CORE reads it this is a
 * harmless extra property on the ctx.
 */
export interface CastEventOverride {
  pos?: Vec3;
  target?: EntityId;
  dir?: Vec3;
}

export function setCastEvent(ctx: AbilityCtx, ev: CastEventOverride): void {
  const c = ctx as AbilityCtx & { cast?: CastEventOverride };
  const next: CastEventOverride = { ...(c.cast ?? {}) };
  if (ev.pos) next.pos = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
  if (ev.dir) next.dir = { x: ev.dir.x, y: ev.dir.y, z: ev.dir.z };
  if (ev.target !== undefined) next.target = ev.target;
  c.cast = next;
}

/** The caster can act right now (alive, not downed). The world already gates stun/silence. */
export const canAct = (e: Entity): boolean => alive(e) && e.hero?.downed !== true;

/** Living, not-downed hero or any living unit. */
export const standing = (e: Entity | undefined): e is Entity => alive(e) && e.hero?.downed !== true;

/** Chest height of a unit (VFX anchor, knockback origin). */
export function chestOf(e: Entity): Vec3 {
  const h = e.hero?.downed ? 0.3 : e.height * 0.55;
  return { x: e.pos.x, y: e.pos.y + h, z: e.pos.z };
}

export const flatDist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Nearest entity of a list to `p` (ties: lowest id, so results are deterministic). */
export function nearestTo(list: readonly Entity[], p: Vec3): Entity | undefined {
  let best: Entity | undefined;
  let bd = Infinity;
  for (const e of list) {
    const d = flatDist(e.pos, p);
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best !== undefined && e.id < best.id)) {
      bd = d;
      best = e;
    }
  }
  return best;
}

/** Normalised horizontal direction a → b (fallback when they coincide). */
export function flatDirTo(a: Vec3, b: Vec3, fallback: Vec3): Vec3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-4) {
    const fl = Math.hypot(fallback.x, fallback.z) || 1;
    return { x: fallback.x / fl, y: 0, z: fallback.z / fl };
  }
  return { x: dx / l, y: 0, z: dz / l };
}

const norm = (v: Vec3): Vec3 | null => {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-6 ? { x: v.x / l, y: v.y / l, z: v.z / l } : null;
};

/**
 * Direction of a long aimed shot from the eye. The crosshair point is used
 * when the camera ray actually lands on something within range; when it runs
 * out into the sky, SimApi.aimPoint drops it onto the ground below — a long
 * shot must not bend down there, so it follows the camera ray instead.
 */
export function longShotDir(ctx: AbilityCtx, range: number): Vec3 {
  const { sim, self } = ctx;
  const eye = sim.eyePos(self);
  const ray = sim.aimRay(self);
  const lands = sim.raycast(ray.origin, ray.dir, range + 6, { ignore: [self.id] });
  const p = lands ? sim.aimPoint(self, range) : { x: ray.origin.x + ray.dir.x * range, y: ray.origin.y + ray.dir.y * range, z: ray.origin.z + ray.dir.z * range };
  return norm({ x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z }) ?? ray.dir;
}

/**
 * Lob a purely visual projectile (no damage) from the caster's hand so it
 * lands on `to` after the returned flight time; the caller schedules the
 * actual effect for that moment. It passes through units (pierce) so the
 * visual never vanishes early in a crowd.
 */
export function lobVisual(ctx: AbilityCtx, kind: string, to: Vec3, speed = 22, gravity = 14): number {
  const { sim, self } = ctx;
  const eye = sim.eyePos(self);
  const from = { x: eye.x, y: eye.y - 0.25, z: eye.z };
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const t = Math.min(1.2, Math.max(0.3, dist / speed));
  sim.spawnProjectile({
    kind,
    ownerId: self.id,
    pos: from,
    vel: { x: (to.x - from.x) / t, y: (to.y - from.y + 0.5 * gravity * t * t) / t, z: (to.z - from.z) / t },
    damage: 0,
    dtype: 'normal',
    gravity,
    lifetime: t + 0.05,
    pierce: 99,
    canDodge: true,
    abilityId: ctx.def.id,
    radius: 0.12,
  });
  return t;
}

/** Units of `kinds` within r of `center` that are not on `self`'s side (heroes: not dead). */
export function hostileUnitsNear(sim: SimApi, self: Entity, center: Vec3, r: number, kinds: EntityKind[] = UNIT_KINDS): Entity[] {
  return sim.queryRadius(center, r, { kinds, notFriendlyTo: self.id, exclude: [self.id] }).filter((e) => !e.hero?.dead);
}

/** Line of sight from a point just above `p` to a unit's chest or head (blasts don't go through walls). */
export function exposedTo(sim: SimApi, p: Vec3, e: Entity): boolean {
  const o = { x: p.x, y: p.y + 0.8, z: p.z };
  const c = chestOf(e);
  return sim.lineOfSight(o, c) || sim.lineOfSight(o, { x: c.x, y: e.pos.y + e.height - 0.1, z: c.z });
}
