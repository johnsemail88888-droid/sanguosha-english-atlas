// Aim aids the HUD draws from the renderer's world queries (weapons spec C4 /
// C6 / C7 / C8). Pure TS — the ray tests come in as callbacks (render/camera/
// pick.ts in the game, fakes in unit tests):
//  - predictImpact: where a lobbed round / arrow lands if fired now (the live
//    impact diamond of launchers and drawn bows);
//  - blockedAt: third person, the shot leaves the hero's eye, not the camera —
//    static geometry on that segment well before the aim point eats the shot;
//  - lockCandidates: who a fully aimed 方天画戟 would lock (angular lock).
import type { Vec3 } from '../core/math';
import type { EntityId, ViewEntity } from '../core/types';
import { VF_DEAD, VF_DOWNED, VF_EXPOSED, VF_MOUNTED, VF_STEALTH } from '../core/types';
import type { WeaponDef } from '../data/types';
import { drawSpeedMul } from '../data/weaponFeel';

/** What the HUD reads (GameRenderer.aimAids; screen points in CSS px of the game container). */
export interface AimAidsView {
  /** metres to what the crosshair is on (null: nothing within reach — sky) */
  range: number | null;
  /** where a lobbed round / drawn arrow comes down if fired now (hit: false = it bursts / drops in the air first) */
  impact: { x: number; y: number; dist: number; hit: boolean } | null;
  /** third person: the shot would hit a wall here before the aim point */
  blocked: { x: number; y: number } | null;
  /** 方天画戟 fully aimed: who its rockets would lock */
  locks: readonly { id: EntityId; x: number; y: number }[];
}

/**
 * Arrow speed at a draw (weapons spec R5: 0.55 undrawn → 1 at full draw; other
 * classes 1): the sim's own drawSpeedMul (data/weaponFeel.ts), for the impact
 * diamond and the bow ladders.
 */
export const arrowSpeedMul = (def: Pick<WeaponDef, 'class'>, adsT: number): number => drawSpeedMul(def, adsT);

export type CastFn = (origin: Vec3, dir: Vec3, maxDist: number) => { point: Vec3; dist: number } | null;

export interface BallisticShot {
  origin: Vec3;
  /** unit direction the round leaves in */
  dir: Vec3;
  speed: number;
  gravity: number;
  /** seconds before it bursts / drops (the path is followed this long at most) */
  lifetime: number;
}

export interface Impact {
  point: Vec3;
  /** straight-line metres from the muzzle */
  dist: number;
  /** seconds of flight */
  time: number;
  /** false: the round ran out of lifetime in the air (an airburst / a drop) */
  hit: boolean;
}

/**
 * Follow a round's arc (the sim's integration: velocity loses g·dt, then the
 * round moves; `step` seconds per segment) and return the first thing it
 * meets — or where it is when its lifetime runs out.
 */
export function predictImpact(shot: BallisticShot, cast: CastFn, step = 1 / 30, maxDist = 400): Impact | null {
  if (!(shot.speed > 0) || !(shot.lifetime > 0)) return null;
  const p = { x: shot.origin.x, y: shot.origin.y, z: shot.origin.z };
  const v = { x: shot.dir.x * shot.speed, y: shot.dir.y * shot.speed, z: shot.dir.z * shot.speed };
  const dir = { x: 0, y: 0, z: 0 };
  let t = 0;
  while (t < shot.lifetime - 1e-9) {
    const dt = Math.min(step, shot.lifetime - t);
    v.y -= shot.gravity * dt;
    const len = Math.hypot(v.x, v.y, v.z) * dt;
    if (len < 1e-6) break;
    dir.x = (v.x * dt) / len;
    dir.y = (v.y * dt) / len;
    dir.z = (v.z * dt) / len;
    const hit = cast(p, dir, len);
    if (hit) {
      return { point: hit.point, dist: Math.hypot(hit.point.x - shot.origin.x, hit.point.y - shot.origin.y, hit.point.z - shot.origin.z), time: t + dt * (hit.dist / len), hit: true };
    }
    p.x += dir.x * len;
    p.y += dir.y * len;
    p.z += dir.z * len;
    t += dt;
    if (Math.hypot(p.x - shot.origin.x, p.z - shot.origin.z) > maxDist) break;
  }
  return { point: { ...p }, dist: Math.hypot(p.x - shot.origin.x, p.y - shot.origin.y, p.z - shot.origin.z), time: t, hit: false };
}

/** Static geometry nearer than this to the aim point along the shot does not count as blocking (m). */
export const BLOCK_MARGIN = 0.75;

/**
 * Third person: the shot flies from `eye` to `aim`. Returns the point where
 * static geometry stops it when that is more than BLOCK_MARGIN before the aim
 * point (else null: the shot reaches what the crosshair is on).
 */
export function blockedAt(eye: Vec3, aim: Vec3, staticDist: (origin: Vec3, dir: Vec3, maxDist: number) => number): Vec3 | null {
  const dx = aim.x - eye.x;
  const dy = aim.y - eye.y;
  const dz = aim.z - eye.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < BLOCK_MARGIN + 0.2) return null;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  const d = staticDist(eye, dir, len);
  if (!Number.isFinite(d) || d >= len - BLOCK_MARGIN) return null;
  return { x: eye.x + dir.x * d, y: eye.y + dir.y * d, z: eye.z + dir.z * d };
}

export interface LockQuery {
  origin: Vec3;
  dir: Vec3;
  /** half-angle of the lock cone (degrees) */
  coneDeg: number;
  range: number;
  max: number;
  selfId: EntityId | null;
}

/**
 * Up to `max` distinct units inside the lock cone and range, nearest angle
 * first — what a fully aimed 方天画戟 would home on. Skips your own squad and
 * summons (the sim's own-side rule; nothing about hidden roles), the dead and
 * the unseen.
 */
export function lockCandidates(q: LockQuery, ents: readonly ViewEntity[], blocked?: (a: Vec3, b: Vec3) => boolean): { id: EntityId; point: Vec3; off: number }[] {
  const out: { id: EntityId; point: Vec3; off: number }[] = [];
  const cosMax = Math.cos((q.coneDeg * Math.PI) / 180);
  for (const e of ents) {
    if (e.kind !== 'hero' && e.kind !== 'troop' && e.kind !== 'npc') continue;
    if (e.id === q.selfId || (q.selfId !== null && e.owner === q.selfId)) continue;
    if (e.flags & VF_DEAD || (e.flags & VF_STEALTH && !(e.flags & VF_EXPOSED))) continue;
    const h = e.flags & VF_DOWNED ? 0.3 : e.flags & VF_MOUNTED || e.mount ? 1.5 : 1.1;
    const point = { x: e.x, y: e.y + h, z: e.z };
    const tx = point.x - q.origin.x;
    const ty = point.y - q.origin.y;
    const tz = point.z - q.origin.z;
    const dist = Math.hypot(tx, ty, tz);
    if (dist < 1 || dist > q.range) continue;
    const c = (tx * q.dir.x + ty * q.dir.y + tz * q.dir.z) / dist;
    if (c < cosMax) continue;
    if (blocked?.(q.origin, point)) continue;
    out.push({ id: e.id, point, off: Math.acos(Math.min(1, c)) });
  }
  out.sort((a, b) => a.off - b.off);
  return out.slice(0, Math.max(0, q.max));
}
