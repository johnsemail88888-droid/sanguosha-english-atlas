// Human-like aiming for bot heroes. The bot does not snap its crosshair onto
// targets: it turns toward a desired point with a tracking lag (time constant
// per difficulty, faster right after a flick), capped angular speed, and a
// wandering aim error that is large on a fresh target and settles over time
// (bigger while moving / against fast targets). Moving targets and projectile
// flight are led according to leadSkill. The result is the frame's yaw/pitch
// and aimPoint (the host trusts a bot's aimPoint for hit resolution).
// Abilities and cards use the same model (aimAtPoint for ground casts and
// skillshots, track for lock-ons): there is no instant "snap" anywhere — the
// view only ever moves through turnToward, capped at the difficulty's turn speed.
import type { Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Entity, EntityId } from '../../core/types';
import type { WeaponDef } from '../../data/types';
import { RECOIL_MAX_DEG, adsZooms, aimProfile, recoilSettleDelay, shotKick } from '../../data/weaponFeel';
import type { SimApi } from '../api';
import { aimAnglesFor, cameraRig } from '../aim';
import type { DifficultyProfile } from './difficulty';
import { aimPointOf } from './perception';

const DEG = Math.PI / 180;
/** seconds between fresh lead / holdover misjudgements */
const LEAD_REDRAW = 0.6;
/** A 4× or stronger scope steadies a bot's aim only from this far out (C10-4). */
export const SCOPE_STEADY_FROM = 40;
/** max turn speed (rad/s) — a fast mouse flick, capped per difficulty below */
const TURN_SPEED: Record<string, number> = { easy: 260 * DEG, normal: 480 * DEG, hard: 760 * DEG };

export interface AimOut {
  yaw: number;
  pitch: number;
  point: Vec3;
  /** angle (rad) between the crosshair ray and the target's centre */
  errAngle: number;
  /** angular radius (rad) of the target from here */
  targetAngle: number;
  /**
   * angle (rad) between the crosshair ray and the lead / holdover point the bot believes in (no
   * wander error): the fire gate for projectiles, whose right aim is beside the body (C10-2)
   */
  leadErrAngle: number;
}

export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

export class Aimer {
  yaw = 0;
  pitch = 0;
  private init = false;
  private targetId: EntityId | undefined;
  private since = 0;
  private err: Vec3 = { x: 0, y: 0, z: 0 };
  private errGoal: Vec3 = { x: 0, y: 0, z: 0 };
  private errNextAt = 0;
  /** lead / holdover misjudgement (σ units), re-drawn every LEAD_REDRAW s (C10-5) */
  private leadNext = 0;
  private leadG = 0;
  private dropG = 0;
  /** recoil the bot has not pulled back down (degrees, up / sideways) and when the last shot kicked (C10-8) */
  private kickP = 0;
  private kickY = 0;
  private kickAt = -99;
  private readonly out: AimOut = { yaw: 0, pitch: 0, point: { x: 0, y: 0, z: 0 }, errAngle: Math.PI, targetAngle: 0, leadErrAngle: Math.PI };

  constructor(
    private readonly prof: DifficultyProfile,
    private readonly rng: Rng,
  ) {}

  private ensure(self: Entity): void {
    if (!this.init) {
      this.init = true;
      this.yaw = self.yaw;
      this.pitch = self.pitch;
    }
  }

  /** Seconds the current target has been tracked. */
  trackedFor(now: number): number {
    return this.targetId === undefined ? 0 : now - this.since;
  }

  get currentTarget(): EntityId | undefined {
    return this.targetId;
  }

  /** Forget the current target (next track() counts as a fresh acquisition). */
  release(): void {
    this.targetId = undefined;
  }

  /**
   * Track `target` with `weapon`. `selfSpeed` = own horizontal speed (m/s),
   * `ads` = aiming down sights.
   */
  track(sim: SimApi, self: Entity, target: Entity, weapon: WeaponDef | undefined, dt: number, ads: boolean, leadSpeed?: number): AimOut {
    this.ensure(self);
    const now = sim.time;
    const p = this.prof;
    this.begin(target.id, now);
    const eye = sim.eyePos(self);
    const base = aimPointOf(target);
    const dist = Math.max(0.5, Math.hypot(base.x - eye.x, base.y - eye.y, base.z - eye.z));
    // head bias: raise part of the aim toward the head on standing heroes
    if (target.kind === 'hero' && !target.hero?.downed) base.y += p.headBias * target.height * 0.28;
    // lead: tracking lag compensation + projectile flight time (+ gravity drop)
    const proj = weapon?.projectile;
    let t = p.trackTau * 0.8;
    if (leadSpeed !== undefined && leadSpeed > 0) t += dist / leadSpeed;
    else if (proj && proj.speed > 0) t += dist / proj.speed;
    const lead = p.leadSkill;
    const tv = target.vel;
    const desired = { x: base.x + tv.x * t * lead, y: base.y + tv.y * t * lead * 0.3, z: base.z + tv.z * t * lead };
    const noise = p.leadNoise ?? 0;
    const tv2 = Math.hypot(tv.x, tv.z);
    // lead / holdover misjudged like a human's (σ = leadNoise × the target's travel / the drop),
    // re-drawn every LEAD_REDRAW s; the bot believes it, so its fire gate cannot filter it (C10-5)
    if (proj && proj.speed > 0 && noise > 0 && now >= this.leadNext) {
      this.leadNext = now + LEAD_REDRAW;
      const u = Math.max(1e-9, this.rng.next());
      const ang = 2 * Math.PI * this.rng.next();
      this.leadG = Math.sqrt(-2 * Math.log(u)) * Math.cos(ang);
      this.dropG = Math.sqrt(-2 * Math.log(u)) * Math.sin(ang);
    }
    if (proj && proj.gravity > 0 && proj.speed > 0) {
      const ft = dist / proj.speed;
      desired.y += 0.5 * proj.gravity * ft * ft * (0.35 + 0.65 * lead) * (1 + this.dropG * noise);
    }
    if (proj && proj.speed > 0 && noise > 0 && tv2 > 0.5) {
      const off = this.leadG * noise * tv2 * (dist / proj.speed);
      desired.x += (tv.x / tv2) * off;
      desired.z += (tv.z / tv2) * off;
    }
    const ideal = { x: desired.x, y: desired.y, z: desired.z };
    // wandering aim error, settling over time
    const tracked = now - this.since;
    let sigmaDeg = p.aimErrFloor + (p.aimErrStart - p.aimErrFloor) * Math.exp(-tracked / Math.max(0.05, p.settleTime));
    const selfSpeed = Math.hypot(self.vel.x, self.vel.z);
    const targetSpeed = tv2;
    // own motion: a ramp from 0.5 to 2.5 m/s (a hard 1.5 m/s step let slow, heavy guns skip it) (C10-3)
    sigmaDeg *= 1 + (p.motionErr - 1) * Math.min(1, Math.max(0, (selfSpeed - 0.5) / 2));
    if (targetSpeed > 3) sigmaDeg *= 1 + (p.motionErr - 1) * Math.min(1.5, targetSpeed / 6);
    // a magnified scope steadies the hand at range; ordinary sights a little (C10-4: zoom-scaled
    // only from 4×, and only from SCOPE_STEADY_FROM m — closer in a 4× / 5× picture is harder to
    // track a strafer with, not easier)
    if (ads) {
      const zs = adsZooms(weapon);
      const z = dist >= 75 && zs.length > 1 ? zs[1] : zs[0];
      sigmaDeg *= z >= 4 && dist >= SCOPE_STEADY_FROM ? 0.55 + 0.45 / z : 0.8;
    }
    this.wander(now, dt, sigmaDeg, base, eye, dist);
    desired.x += this.err.x;
    desired.y += this.err.y;
    desired.z += this.err.z;
    // turn toward it with lag + capped speed
    const want = aimAnglesFor(self.pos, desired, self.hero?.downed === true);
    const tau = tracked < 0.5 ? p.flickTau : p.trackTau;
    this.turnToward(want.yaw, want.pitch, tau, dt);
    // the recoil it did not pull down sits on top of the view and settles once the trigger rests
    if (weapon) this.settleKick(weapon, now, dt);
    const kYaw = this.yaw - this.kickY * DEG;
    const kPitch = Math.max(-1.4, Math.min(1.4, this.pitch + this.kickP * DEG));
    // crosshair point on the ray at the target's distance
    const rig = cameraRig(self.pos, kYaw, kPitch, self.hero?.downed === true);
    const along = Math.hypot(desired.x - rig.origin.x, desired.y - rig.origin.y, desired.z - rig.origin.z);
    const o = this.out;
    o.yaw = kYaw;
    o.pitch = kPitch;
    o.point = { x: rig.origin.x + rig.dir.x * along, y: rig.origin.y + rig.dir.y * along, z: rig.origin.z + rig.dir.z * along };
    // angular error measured from the eye (where shots start) to the real target centre
    const cx = o.point.x - eye.x;
    const cy = o.point.y - eye.y;
    const cz = o.point.z - eye.z;
    const cl = Math.hypot(cx, cy, cz) || 1;
    const tc = aimPointOf(target);
    const tx = tc.x - eye.x;
    const ty = tc.y - eye.y;
    const tz = tc.z - eye.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const cos = (cx * tx + cy * ty + cz * tz) / (cl * tl);
    o.errAngle = Math.acos(Math.max(-1, Math.min(1, cos)));
    const half = target.hero?.downed ? 0.45 : Math.max(target.radius, Math.min(0.9, target.height * 0.35));
    o.targetAngle = Math.atan2(half, tl);
    const ix = ideal.x - eye.x;
    const iy = ideal.y - eye.y;
    const iz = ideal.z - eye.z;
    const il = Math.hypot(ix, iy, iz) || 1;
    o.leadErrAngle = Math.acos(Math.max(-1, Math.min(1, (cx * ix + cy * iy + cz * iz) / (cl * il))));
    return o;
  }

  /**
   * A shot went off: its recoil (data/weaponFeel.ts shotKick at aim blend `blend`), less the
   * share `comp` the bot pulls back down, climbs its view (C10-8). `n` shots at once (an
   * automatic's shots this tick).
   */
  kick(def: WeaponDef, blend: number, comp: number, now: number, n = 1): void {
    if (!(n > 0)) return;
    const k = shotKick(def, blend);
    const rest = Math.max(0, 1 - comp) * n;
    this.kickP = Math.min(RECOIL_MAX_DEG, this.kickP + k.pitch * rest);
    this.kickY += (this.rng.next() * 2 - 1) * k.yaw * rest;
    this.kickAt = now;
  }

  /**
   * The unpulled kick comes back down: the bot sees its crosshair climb off the target and
   * re-centres it at its tracking pace (trackTau) even mid-burst — as a player does, and as the
   * human model the classes are balanced on does (tests/unit/balance/ttkModel.ts: tc) — and the
   * gun settles too (the class's recover time) once the trigger rests past the settle delay.
   * (Settling only on a rest let a held carbine burst climb off a 30 m body: 38 % hits, not 46 %.)
   */
  private settleKick(def: WeaponDef, now: number, dt: number): void {
    if (this.kickP === 0 && this.kickY === 0) return;
    let k = Math.exp(-dt / Math.max(0.05, this.prof.trackTau));
    if (now - this.kickAt >= recoilSettleDelay(def)) k *= Math.exp(-dt / Math.max(0.03, aimProfile(def).recover));
    this.kickP *= k;
    this.kickY *= k;
    if (Math.abs(this.kickP) < 1e-3 && Math.abs(this.kickY) < 1e-3) this.kickP = this.kickY = 0;
  }

  /**
   * Aim at a world point WITH the human error model (ground-targeted casts,
   * skillshots, thrown cards): the view turns toward the point plus a
   * wandering error that is large right after starting and settles over
   * time; `key` identifies the aim (a new key = a fresh flick). errAngle is
   * measured against the erroneous point the bot believes is right, so a cast
   * released when errAngle is small lands with the bot's error.
   */
  aimAtPoint(sim: SimApi, self: Entity, point: Vec3, dt: number, key: number, errScale = 1): AimOut {
    this.ensure(self);
    const now = sim.time;
    const p = this.prof;
    this.begin(key, now);
    const eye = sim.eyePos(self);
    const dist = Math.max(0.5, Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z));
    const tracked = now - this.since;
    let sigmaDeg = (p.aimErrFloor + (p.aimErrStart - p.aimErrFloor) * Math.exp(-tracked / Math.max(0.05, p.settleTime))) * errScale;
    if (Math.hypot(self.vel.x, self.vel.z) > 1.5) sigmaDeg *= p.motionErr;
    this.wander(now, dt, sigmaDeg, point, eye, dist);
    const desired = { x: point.x + this.err.x, y: point.y + this.err.y, z: point.z + this.err.z };
    const downed = self.hero?.downed === true;
    const want = solveAim(self.pos, desired, downed);
    this.turnToward(want.yaw, want.pitch, tracked < 0.5 ? p.flickTau : p.trackTau, dt);
    const rig = cameraRig(self.pos, this.yaw, this.pitch, downed);
    const along = Math.hypot(desired.x - rig.origin.x, desired.y - rig.origin.y, desired.z - rig.origin.z);
    const o = this.out;
    o.yaw = this.yaw;
    o.pitch = this.pitch;
    o.point = { x: rig.origin.x + rig.dir.x * along, y: rig.origin.y + rig.dir.y * along, z: rig.origin.z + rig.dir.z * along };
    // on screen: the angle between the crosshair ray and the point, seen from the camera
    o.errAngle = angleBetween(rig.origin, o.point, desired);
    o.targetAngle = 0;
    o.leadErrAngle = o.errAngle;
    return o;
  }

  /** Angle (rad) between the current crosshair ray and the direction from the eye to `p`. */
  crosshairAngleTo(self: Entity, p: Vec3): number {
    const rig = cameraRig(self.pos, this.yaw, this.pitch, self.hero?.downed === true);
    const along = Math.max(1, Math.hypot(p.x - rig.origin.x, p.y - rig.origin.y, p.z - rig.origin.z));
    const c = { x: rig.origin.x + rig.dir.x * along, y: rig.origin.y + rig.dir.y * along, z: rig.origin.z + rig.dir.z * along };
    return angleBetween(rig.origin, c, p);
  }

  private begin(key: number, now: number): void {
    if (this.targetId !== key) {
      this.targetId = key;
      this.since = now;
      this.errNextAt = 0;
    }
  }

  /** Advance the wandering aim error toward a fresh random goal every ~0.3–0.6 s. */
  private wander(now: number, dt: number, sigmaDeg: number, base: Vec3, eye: Vec3, dist: number): void {
    if (now >= this.errNextAt) {
      this.errNextAt = now + 0.28 + this.rng.next() * 0.3;
      const sm = Math.tan(sigmaDeg * DEG) * dist;
      // error in the plane facing the shooter: lateral + vertical
      const fx = (base.x - eye.x) / dist;
      const fz = (base.z - eye.z) / dist;
      const lat = gauss(this.rng) * sm;
      const vert = gauss(this.rng) * sm * 0.6;
      this.errGoal = { x: -fz * lat, y: vert, z: fx * lat };
    }
    const ek = 1 - Math.exp(-dt / 0.22);
    this.err.x += (this.errGoal.x - this.err.x) * ek;
    this.err.y += (this.errGoal.y - this.err.y) * ek;
    this.err.z += (this.errGoal.z - this.err.z) * ek;
  }

  /** Look toward a world point (no target): used while moving, reviving, looting. */
  lookAt(self: Entity, point: Vec3, dt: number, tau = 0.25): AimOut {
    this.ensure(self);
    this.targetId = undefined;
    const want = aimAnglesFor(self.pos, point, self.hero?.downed === true);
    this.turnToward(want.yaw, want.pitch, tau, dt);
    const o = this.out;
    o.yaw = this.yaw;
    o.pitch = this.pitch;
    const rig = cameraRig(self.pos, this.yaw, this.pitch, self.hero?.downed === true);
    const along = Math.max(2, Math.hypot(point.x - rig.origin.x, point.y - rig.origin.y, point.z - rig.origin.z));
    o.point = { x: rig.origin.x + rig.dir.x * along, y: rig.origin.y + rig.dir.y * along, z: rig.origin.z + rig.dir.z * along };
    o.errAngle = Math.PI;
    o.targetAngle = 0;
    o.leadErrAngle = Math.PI;
    return o;
  }

  /** Face a yaw (level pitch) — travelling. */
  face(self: Entity, yaw: number, dt: number, tau = 0.2): void {
    this.ensure(self);
    this.targetId = undefined;
    this.turnToward(yaw, 0, tau, dt);
  }

  private turnToward(yaw: number, pitch: number, tau: number, dt: number): void {
    const k = 1 - Math.exp(-dt / Math.max(0.02, tau));
    const maxStep = (TURN_SPEED[this.prof.name] ?? TURN_SPEED.normal) * dt;
    let dy = wrapAngle(yaw - this.yaw) * k;
    let dp = (pitch - this.pitch) * k;
    if (Math.abs(dy) > maxStep) dy = Math.sign(dy) * maxStep;
    if (Math.abs(dp) > maxStep) dp = Math.sign(dp) * maxStep;
    this.yaw = wrapAngle(this.yaw + dy);
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + dp));
  }
}

/** aimAnglesFor with a few more fixed-point iterations (close points: the shoulder offset matters). */
function solveAim(pos: Vec3, target: Vec3, downed: boolean): { yaw: number; pitch: number } {
  let { yaw, pitch } = aimAnglesFor(pos, target, downed);
  for (let i = 0; i < 4; i++) {
    const rig = cameraRig(pos, yaw, pitch, downed);
    const dx = target.x - rig.origin.x;
    const dy = target.y - rig.origin.y;
    const dz = target.z - rig.origin.z;
    yaw = Math.atan2(-dx, -dz);
    pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  return { yaw, pitch };
}

function angleBetween(eye: Vec3, a: Vec3, b: Vec3): number {
  const ax = a.x - eye.x;
  const ay = a.y - eye.y;
  const az = a.z - eye.z;
  const bx = b.x - eye.x;
  const by = b.y - eye.y;
  const bz = b.z - eye.z;
  const l = (Math.hypot(ax, ay, az) || 1) * (Math.hypot(bx, by, bz) || 1);
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / l)));
}

/** Standard normal sample (Box–Muller) from the bot's own RNG. */
export function gauss(rng: Rng): number {
  const u = Math.max(1e-9, rng.next());
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
