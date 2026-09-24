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
 * 0.75..1.25: deterministic per-unit, per-tick jitter for scan intervals, so
 * squads and camps never run their target scans in the same tick (tick-time spikes).
 */
export function scanJitter(id: number, tick: number): number {
  const h = Math.imul(id ^ Math.imul(tick, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return 0.75 + (h % 1000) / 2000;
}

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

/** Is this hazard harmful to units that are not on its owner's side? */
export function harmfulHazard(h: Entity): boolean {
  const hz = h.hazard;
  if (!hz) return false;
  const p = hz.params;
  return (p.damage ?? 0) > 0 || (p.strike ?? 0) > 0 || (p.slow ?? 0) > 0 || (p.dps ?? 0) > 0;
}

/**
 * Direction (unit x/z) out of the harmful hazard `self` stands in, or null.
 * Own side's hazards are ignored (they never hurt their owner's side).
 */
export function hazardEscape(sim: SimApi, self: Entity): { x: number; z: number } | null {
  let ex = 0;
  let ez = 0;
  let found = false;
  for (const h of sim.queryRadius(self.pos, 10, { kinds: ['hazard'] })) {
    const hz = h.hazard;
    if (!hz || !harmfulHazard(h)) continue;
    if (sim.isOwnSide(self, h)) continue;
    const dx = self.pos.x - h.pos.x;
    const dz = self.pos.z - h.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > hz.radius + 0.6) continue;
    found = true;
    const w = (hz.radius + 0.6 - d) / Math.max(0.5, hz.radius);
    if (d < 1e-3) {
      ex += Math.sin(self.id);
      ez += Math.cos(self.id);
    } else {
      ex += (dx / d) * w;
      ez += (dz / d) * w;
    }
  }
  if (!found) return null;
  const l = Math.hypot(ex, ez) || 1;
  return { x: ex / l, z: ez / l };
}
