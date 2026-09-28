// Aim assist for touch (and gamepad) — never for a mouse (weapons spec C9).
// Pure TS, no DOM / three.js; the InputController applies it to the look
// deltas of a frame:
//  - slowdown: the look turns slower while the crosshair is on a target, so a
//    thumb stops on it (× 0.6 at the hip, × 0.5 aimed; × 0.75 through a scope);
//  - follow: while a finger drags or the stick moves, the view drifts along with
//    the target's angular motion — 30 % of it at the hip, 40 % aimed, never more
//    than FOLLOW_MAX_DEG a second (none through a scope);
//  - no bullet magnetism: shots still go where the crosshair is.
// "On a target" = inside 1.5 × the target's angular half-width (0.8°…5°).
// Hidden roles: your own squad, your summons and the allies you already KNOW
// (a public role on your side, 影武者 / 主公 pairs) are skipped; every other unit
// is treated the same, so the assist never tells a hidden ally from an enemy.
import type { EntityId, RoleId, ViewEntity } from '../core/types';
import { VF_DEAD, VF_EXPOSED, VF_MOUNTED, VF_DOWNED, VF_STEALTH } from '../core/types';
import { ROLE_BY_ID } from '../data/roles';

export type AssistDevice = 'mouse' | 'touch' | 'gamepad';
export type AssistLevel = 'off' | 'low' | 'standard';

/** Slowdown multipliers (look speed) on a target. */
export const SLOW_HIP = 0.6;
export const SLOW_AIMED = 0.5;
export const SLOW_SCOPE = 0.75;
/** Share of the target's angular velocity the view follows. */
export const FOLLOW_HIP = 0.3;
export const FOLLOW_AIMED = 0.4;
/** The follow never turns the view faster than this (degrees / s). */
export const FOLLOW_MAX_DEG = 10;
/** The assist cone: this × the target's angular half-width, clamped to [CONE_MIN_DEG, CONE_MAX_DEG]. */
export const CONE_MUL = 1.5;
export const CONE_MIN_DEG = 0.8;
export const CONE_MAX_DEG = 5;
/** Targets farther than this are ignored (m): the hip, fully aimed. */
export const RANGE_HIP = 45;
export const RANGE_AIMED = 70;

const DEG = Math.PI / 180;

export interface AssistViewer {
  id: EntityId;
  role?: RoleId;
  /** your squad's unit ids (PrivateHeroView.squad) */
  squad?: readonly EntityId[];
  /** heroes you know are on your side (PrivateHeroView.knownAllies) */
  knownAllies?: readonly EntityId[];
}

export interface AssistFrame {
  device: AssistDevice;
  level: AssistLevel;
  /** the crosshair ray: camera origin and look angles (core/math convention) */
  origin: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  /** eased aim progress 0 (hip) … 1 (aimed) */
  blend: number;
  /** looking through a scope (sniper / DMR sight up): gentler slowdown, no follow */
  scoped: boolean;
  /** a finger drags / the stick moves this frame (the follow only helps an active aim) */
  active: boolean;
  dt: number;
  viewer: AssistViewer;
  entities: readonly ViewEntity[];
  /** optional line-of-sight test: true when static geometry blocks a → b */
  blocked?: (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => boolean;
}

export interface AssistResult {
  /** look-speed multiplier this frame (1 = none) */
  slow: number;
  /** extra look turn this frame (radians) */
  yaw: number;
  pitch: number;
  /** the unit the assist is on (null: none) */
  targetId: EntityId | null;
  /** the assist cone of that target (degrees; debug display) */
  coneDeg: number;
}

export const NO_ASSIST: Readonly<AssistResult> = { slow: 1, yaw: 0, pitch: 0, targetId: null, coneDeg: 0 };

/** Is `e` someone the assist must skip for this viewer (own squad / summons / a known ally)? */
export function assistExcluded(e: Pick<ViewEntity, 'id' | 'kind' | 'owner' | 'role'>, v: AssistViewer): boolean {
  if (e.id === v.id) return true;
  if (e.owner !== undefined && e.owner === v.id) return true;
  if (v.squad?.includes(e.id)) return true;
  const known = v.knownAllies ?? [];
  if (known.includes(e.id) || (e.owner !== undefined && known.includes(e.owner))) return true;
  // a public role on your own side (the Lord for a loyalist, a revealed rebel for a rebel)
  if (e.kind === 'hero' && e.role && v.role) {
    const mine = ROLE_BY_ID[v.role]?.faction;
    const theirs = ROLE_BY_ID[e.role]?.faction;
    if ((mine === 'lord' || mine === 'rebel') && mine === theirs) return true;
  }
  return false;
}

/** Aim point and body radius the assist uses for a unit. */
function bodyOf(e: ViewEntity): { x: number; y: number; z: number; r: number } {
  const mounted = (e.flags & VF_MOUNTED) !== 0 || !!e.mount;
  const downed = (e.flags & VF_DOWNED) !== 0;
  const h = downed ? 0.3 : mounted ? 1.5 : 1.1;
  return { x: e.x, y: e.y + h, z: e.z, r: mounted ? 0.6 : 0.4 };
}

/** Angle (radians) between two unit-ish direction triples. */
function angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la < 1e-9 || lb < 1e-9) return Math.PI;
  const c = (ax * bx + ay * by + az * bz) / (la * lb);
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

/** The assist cone (degrees) for a body of radius `r` at distance `dist`. */
export function assistConeDeg(r: number, dist: number): number {
  const half = Math.atan2(r, Math.max(0.1, dist)) / DEG;
  return Math.min(CONE_MAX_DEG, Math.max(CONE_MIN_DEG, half * CONE_MUL));
}

const wrap = (a: number): number => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
};

/** Stateful: the follow needs each target's angular velocity (bearing change between frames). */
export class AimAssist {
  private lastId: EntityId | null = null;
  private lastYaw = 0;
  private lastPitch = 0;
  /** the last result (debug display) */
  last: AssistResult = { ...NO_ASSIST };

  reset(): void {
    this.lastId = null;
    this.last = { ...NO_ASSIST };
  }

  update(f: AssistFrame): AssistResult {
    if (f.device === 'mouse' || f.level === 'off' || !(f.dt > 0)) {
      this.reset();
      return this.last;
    }
    const cp = Math.cos(f.pitch);
    const dx = -Math.sin(f.yaw) * cp;
    const dy = Math.sin(f.pitch);
    const dz = -Math.cos(f.yaw) * cp;
    const blend = f.blend <= 0 ? 0 : f.blend >= 1 ? 1 : f.blend;
    const range = RANGE_HIP + (RANGE_AIMED - RANGE_HIP) * blend;
    let best: ViewEntity | null = null;
    let bestOff = Infinity;
    let bestCone = 0;
    let bestBody = { x: 0, y: 0, z: 0, r: 0 };
    for (const e of f.entities) {
      if (e.kind !== 'hero' && e.kind !== 'troop' && e.kind !== 'npc') continue;
      if (e.flags & VF_DEAD) continue;
      if (e.flags & VF_STEALTH && !(e.flags & VF_EXPOSED)) continue;
      if (assistExcluded(e, f.viewer)) continue;
      const b = bodyOf(e);
      const tx = b.x - f.origin.x;
      const ty = b.y - f.origin.y;
      const tz = b.z - f.origin.z;
      const dist = Math.hypot(tx, ty, tz);
      if (dist > range || dist < 0.5) continue;
      const off = angleBetween(dx, dy, dz, tx, ty, tz) / DEG;
      const cone = assistConeDeg(b.r, dist);
      if (off > cone || off >= bestOff) continue;
      if (f.blocked?.(f.origin, b)) continue;
      best = e;
      bestOff = off;
      bestCone = cone;
      bestBody = b;
    }
    if (!best) {
      this.lastId = null;
      this.last = { ...NO_ASSIST };
      return this.last;
    }
    const k = f.level === 'low' ? 0.5 : 1;
    let slow = f.scoped ? SLOW_SCOPE : SLOW_HIP + (SLOW_AIMED - SLOW_HIP) * blend;
    slow = 1 - (1 - slow) * k;
    // the target's bearing from the camera (world angles): its change is the relative angular velocity
    const tx = bestBody.x - f.origin.x;
    const ty = bestBody.y - f.origin.y;
    const tz = bestBody.z - f.origin.z;
    const byaw = Math.atan2(-tx, -tz);
    const bpitch = Math.atan2(ty, Math.hypot(tx, tz));
    let yaw = 0;
    let pitch = 0;
    if (this.lastId === best.id && f.active && !f.scoped) {
      const frac = (FOLLOW_HIP + (FOLLOW_AIMED - FOLLOW_HIP) * blend) * k;
      let wy = (wrap(byaw - this.lastYaw) / f.dt) * frac;
      let wp = ((bpitch - this.lastPitch) / f.dt) * frac;
      const w = Math.hypot(wy, wp);
      const cap = FOLLOW_MAX_DEG * DEG;
      if (w > cap) {
        wy *= cap / w;
        wp *= cap / w;
      }
      yaw = wy * f.dt;
      pitch = wp * f.dt;
    }
    this.lastId = best.id;
    this.lastYaw = byaw;
    this.lastPitch = bpitch;
    this.last = { slow, yaw, pitch, targetId: best.id, coneDeg: bestCone };
    return this.last;
  }
}
