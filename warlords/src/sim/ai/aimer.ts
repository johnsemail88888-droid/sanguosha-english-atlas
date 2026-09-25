// Human-like aiming for bot heroes. The bot does not snap its crosshair onto
// targets: it turns toward a desired point with a tracking lag (time constant
// per difficulty, faster right after a flick), capped angular speed, and a
// wandering aim error that is large on a fresh target and settles over time
// (bigger while moving / against fast targets). Moving targets and projectile
// flight are led according to leadSkill. The result is the frame's yaw/pitch
// and aimPoint (the host trusts a bot's aimPoint for hit resolution).
import type { Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Entity, EntityId } from '../../core/types';
import type { WeaponDef } from '../../data/types';
import type { SimApi } from '../api';
import { aimAnglesFor, cameraRig } from '../aim';
import type { DifficultyProfile } from './difficulty';
import { aimPointOf } from './perception';

const DEG = Math.PI / 180;
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
  private readonly out: AimOut = { yaw: 0, pitch: 0, point: { x: 0, y: 0, z: 0 }, errAngle: Math.PI, targetAngle: 0 };

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
  track(sim: SimApi, self: Entity, target: Entity, weapon: WeaponDef | undefined, dt: number, ads: boolean): AimOut {
    this.ensure(self);
    const now = sim.time;
    const p = this.prof;
    if (this.targetId !== target.id) {
      this.targetId = target.id;
      this.since = now;
      this.errNextAt = 0;
    }
    const eye = sim.eyePos(self);
    const base = aimPointOf(target);
    const dist = Math.max(0.5, Math.hypot(base.x - eye.x, base.y - eye.y, base.z - eye.z));
    // head bias: raise part of the aim toward the head on standing heroes
    if (target.kind === 'hero' && !target.hero?.downed) base.y += p.headBias * target.height * 0.28;
    // lead: tracking lag compensation + projectile flight time (+ gravity drop)
    const proj = weapon?.projectile;
    let t = p.trackTau * 0.8;
    if (proj && proj.speed > 0) t += dist / proj.speed;
    const lead = p.leadSkill;
    const tv = target.vel;
    const desired = { x: base.x + tv.x * t * lead, y: base.y + tv.y * t * lead * 0.3, z: base.z + tv.z * t * lead };
    if (proj && proj.gravity > 0 && proj.speed > 0) {
      const ft = dist / proj.speed;
      desired.y += 0.5 * proj.gravity * ft * ft * (0.35 + 0.65 * lead);
    }
    // wandering aim error, settling over time
    const tracked = now - this.since;
    let sigmaDeg = p.aimErrFloor + (p.aimErrStart - p.aimErrFloor) * Math.exp(-tracked / Math.max(0.05, p.settleTime));
    const selfSpeed = Math.hypot(self.vel.x, self.vel.z);
    const targetSpeed = Math.hypot(tv.x, tv.z);
    if (selfSpeed > 1.5) sigmaDeg *= p.motionErr;
    if (targetSpeed > 3) sigmaDeg *= 1 + (p.motionErr - 1) * Math.min(1.5, targetSpeed / 6);
    if (ads) sigmaDeg *= 0.8;
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
    desired.x += this.err.x;
    desired.y += this.err.y;
    desired.z += this.err.z;
    // turn toward it with lag + capped speed
    const want = aimAnglesFor(self.pos, desired, self.hero?.downed === true);
    const tau = tracked < 0.5 ? p.flickTau : p.trackTau;
    this.turnToward(want.yaw, want.pitch, tau, dt);
    // crosshair point on the ray at the target's distance
    const rig = cameraRig(self.pos, this.yaw, this.pitch, self.hero?.downed === true);
    const along = Math.hypot(desired.x - rig.origin.x, desired.y - rig.origin.y, desired.z - rig.origin.z);
    const o = this.out;
    o.yaw = this.yaw;
    o.pitch = this.pitch;
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
    return o;
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
    return o;
  }

  /** Face a yaw (level pitch) — travelling. */
  face(self: Entity, yaw: number, dt: number, tau = 0.2): void {
    this.ensure(self);
    this.targetId = undefined;
    this.turnToward(yaw, 0, tau, dt);
  }

  /** Instantly set the view (ability flicks). */
  snap(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.init = true;
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

/** Standard normal sample (Box–Muller) from the bot's own RNG. */
export function gauss(rng: Rng): number {
  const u = Math.max(1e-9, rng.next());
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
