// Shared perception helpers for AI brains.
import type { Vec3 } from '../../core/math';
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';

export const UNIT_KINDS: Entity['kind'][] = ['hero', 'troop', 'npc', 'turret'];

/** Center-of-mass point used for aiming / LOS. */
export function aimPointOf(e: Entity): Vec3 {
  const h = e.hero?.downed ? 0.35 : e.height * 0.6;
  return { x: e.pos.x, y: e.pos.y + h, z: e.pos.z };
}

export function isTargetable(sim: SimApi, viewer: Entity, e: Entity): boolean {
  if (!e.alive || e.hero?.dead) return false;
  if (sim.hasStatus(e.id, 'untargetable')) return false;
  return ext(sim).canSee(viewer, e);
}

export function hasLineOfSight(sim: SimApi, a: Entity, b: Entity): boolean {
  return sim.lineOfSight(sim.eyePos(a), aimPointOf(b));
}

export const dist2d = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Best visible target within `range` accepted by `accept`, scored by
 * distance minus `bonus(e)` (meters). LOS is checked only for the few best
 * candidates to keep scans cheap.
 */
export function pickTarget(
  sim: SimApi,
  self: Entity,
  range: number,
  accept: (e: Entity) => boolean,
  bonus?: (e: Entity) => number,
  maxLosChecks = 4,
): Entity | undefined {
  const cands = sim.queryRadius(self.pos, range, { kinds: UNIT_KINDS, exclude: [self.id] });
  const scored: { e: Entity; s: number }[] = [];
  for (const c of cands) {
    if (!isTargetable(sim, self, c)) continue;
    if (!accept(c)) continue;
    scored.push({ e: c, s: dist2d(self.pos, c.pos) - (bonus ? bonus(c) : 0) });
  }
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => a.s - b.s);
  const n = Math.min(maxLosChecks, scored.length);
  for (let i = 0; i < n; i++) if (hasLineOfSight(sim, self, scored[i].e)) return scored[i].e;
  return undefined;
}
