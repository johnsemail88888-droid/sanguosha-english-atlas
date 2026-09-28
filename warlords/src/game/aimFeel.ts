// The local player's aim, frame by frame (no DOM, no three.js; unit-tested):
// how far the sights are up (the class's ADS time, data/weaponFeel.ts), the
// zoom the camera shows (a sniper scope's two steps, switched with the wheel),
// whether a lens overlay covers the screen, and the breathing sway of a scope
// (Shift holds the breath for a few seconds, then you are winded for a moment),
// and the recoil of your own shots (each class kicks the view its own way; it
// climbs while the trigger is held and settles back once it rests — autos not
// quite all the way: what is left is yours to pull down).
// The InputController owns it: sway + recoil are added to the look angles it
// sends, so the host's crosshair ray (and every shot) follows the reticle exactly.
import { WEAPON_BY_ID } from '../data';
import {
  AIMED_AT,
  adsEase,
  adsZooms,
  aimProfile,
  BREATH_RECOVER,
  HOLD_BREATH_MAX,
  kickCurveMul,
  RECOIL_MAX_DEG,
  recoilSettleDelay,
  shotKick,
  stepAdsT,
  swayAt,
  swayOffset,
  type SightKind,
} from '../data/weaponFeel';

/** What the renderer and the HUD read about the local aim this frame. */
export interface AimSnapshot {
  weaponId: string | null;
  sight: SightKind;
  /** aim progress 0 (hip) … 1 (aimed), linear in time */
  progress: number;
  /** eased progress (camera zoom, viewmodel, reticle fade) */
  blend: number;
  /** the sights are fully up (progress ≥ AIMED_AT): hold breath works, the draw is full */
  aimed: boolean;
  /** zoom factor on the camera now (1 at the hip) */
  zoom: number;
  /** the zoom step selected (applied fully once aimed) */
  stepZoom: number;
  zoomIndex: number;
  zoomSteps: number;
  /** a lens overlay covers the screen: the weapon is hidden */
  scoped: boolean;
  /** breath left 0..1 (scopes) */
  breath: number;
  /** holding the breath now (Shift) */
  holding: boolean;
  /** out of breath: heavier sway for a moment */
  winded: boolean;
  /** bows: seconds held at full draw (the arm tires after a while) */
  drawHeld: number;
  /** sway + scope settle + recoil added to the look angles (radians) */
  swayYaw: number;
  swayPitch: number;
  /** the recoil part of it (radians; pitch ≥ 0 = the view kicked up) */
  kickYaw: number;
  kickPitch: number;
  /** shots of the current held burst (the LMG's kick curve counts them) */
  burstShots: number;
  /** seconds since your last shot of this weapon (large: none yet) */
  shotAge: number;
  /** seconds between shots of this weapon (the next round is chambered after this) */
  cycle: number;
  /** the camera is the hero's eye (near sights draw their housing only then) */
  firstPerson: boolean;
}

export interface AimInput {
  weaponId: string | null;
  /** the aim button is held */
  ads: boolean;
  /** aiming is impossible right now (reloading, downed, stunned, dancing, disarmed) */
  blocked: boolean;
  /** the breath key is held (Shift on a keyboard, the 屏息 button on touch): holds the breath while aimed with a scope */
  hold: boolean;
  moving: boolean;
  airborne: boolean;
  /** horizontal speed (m/s): held breath steadies less on the move */
  speed?: number;
  /** first-person camera (default true) */
  firstPerson?: boolean;
  /** touch controls: the kick is gentler (TOUCH_RECOIL) */
  touch?: boolean;
}

/** Breath comes back in this many seconds from empty. */
const BREATH_REFILL = 3;
/**
 * Overlay sights cover the screen from this aim progress on (the weapon is
 * hidden then). Their zoom only starts here too, and the lens fades in over
 * SCOPE_FADE of progress (opaque at 0.85): no magnified world behind a gun
 * model half way up.
 */
export const SCOPE_AT = 0.7;
export const SCOPE_FADE = 0.15;
/** A scope settles onto the aim point: SETTLE_DEG off at SCOPE_AT + SCOPE_FADE, dead on at 1. */
export const SETTLE_DEG = 0.6;
/** Each kick eases in over this many seconds (ease-out), not a snap. */
export const KICK_EASE = 0.06;
/** Recoil on touch controls (a thumb cannot pull down like a mouse hand). */
export const TOUCH_RECOIL = 0.6;
/** Held breath at a standstill leaves this share of the sway; on the move it helps less (up to +0.42 at 2.5 m/s). */
export const HOLD_STEADY = 0.08;
const DEG = Math.PI / 180;
/** direction of the scope's settle offset (a touch low and right), unit length */
const SETTLE_YAW = -0.6;
const SETTLE_PITCH = -0.8;

/** Share of the sway left while holding the breath at `speed` m/s: 0.08 standing … 0.5 at a walk. */
export function holdBreathSway(speed: number): number {
  const k = speed <= 0 ? 0 : speed >= 2.5 ? 1 : speed / 2.5;
  return HOLD_STEADY + 0.42 * k;
}

/** Scope settle offset (degrees) at aim progress `t` while the scope comes up. */
export function scopeSettleDeg(t: number): number {
  if (t <= SCOPE_AT) return 0;
  const lens = Math.min(1, (t - SCOPE_AT) / SCOPE_FADE);
  const at = SCOPE_AT + SCOPE_FADE;
  const settle = t <= at ? 1 : 1 - adsEase((t - at) / (1 - at));
  return SETTLE_DEG * lens * settle;
}

interface PendingKick {
  pitch: number;
  yaw: number;
  age: number;
}

const easeOut = (x: number): number => {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return 1 - (1 - c) * (1 - c);
};

export class AimFeel {
  private weaponId: string | null = null;
  private t = 0;
  private time = 0;
  private zoomIdx = 0;
  private step = 1;
  private breath = 1;
  private holding = false;
  /** Shift must be released after running out of breath before it holds again */
  private needRelease = false;
  private winded = 0;
  private drawHeld = 0;
  private amp = 0;
  /** recoil climb still to come back (radians), the kicks easing in, and the time since the last shot */
  private kickP = 0;
  private kickY = 0;
  private readonly kicks: PendingKick[] = [];
  private shotAge = 99;
  private burst = 0;
  /** the settle after the last burst has split off what does not come back */
  private settled = true;
  /** climb that will not come back: moved into the base look by the InputController (takeResidual) */
  private residP = 0;
  private residY = 0;
  private touch = false;
  private readonly snap: AimSnapshot = {
    weaponId: null,
    sight: 'none',
    progress: 0,
    blend: 0,
    aimed: false,
    zoom: 1,
    stepZoom: 1,
    zoomIndex: 0,
    zoomSteps: 1,
    scoped: false,
    breath: 1,
    holding: false,
    winded: false,
    drawHeld: 0,
    swayYaw: 0,
    swayPitch: 0,
    kickYaw: 0,
    kickPitch: 0,
    burstShots: 0,
    shotAge: 99,
    cycle: 1,
    firstPerson: true,
  };

  /** Advance one frame (dt in seconds) and return the snapshot (the same object every frame). */
  update(dt: number, inp: AimInput): AimSnapshot {
    const d = Math.min(0.1, Math.max(0, dt));
    this.time += d;
    this.touch = !!inp.touch;
    if (inp.weaponId !== this.weaponId) {
      // another weapon in hand: from the hip, first zoom step, no recoil
      this.weaponId = inp.weaponId;
      this.t = 0;
      this.zoomIdx = 0;
      this.drawHeld = 0;
      this.step = 0;
      this.kickP = this.kickY = 0;
      this.kicks.length = 0;
      this.shotAge = 99;
      this.burst = 0;
      this.settled = true;
    }
    const def = inp.weaponId ? WEAPON_BY_ID[inp.weaponId] : undefined;
    const prof = aimProfile(def);
    const aiming = inp.ads && !inp.blocked && !!def && !def.melee;
    this.t = stepAdsT(this.t, aiming, prof.adsTime, d);
    const blend = adsEase(this.t);
    const zooms = adsZooms(def);
    this.zoomIdx = Math.min(this.zoomIdx, zooms.length - 1);
    const want = zooms[this.zoomIdx] ?? 1;
    // switching 4× ↔ 8× glides (a fresh weapon starts at its first step)
    this.step = this.step <= 0 ? want : this.step + (want - this.step) * (1 - Math.exp(-d * 16));
    if (Math.abs(this.step - want) < 1e-3) this.step = want;
    // a scope magnifies only once the eye is at it (from SCOPE_AT on, as the lens fades in); other sights with the aim
    const zoomBlend = prof.overlay ? adsEase((this.t - SCOPE_AT) / (1 - SCOPE_AT)) : blend;
    const zoom = 1 + (this.step - 1) * zoomBlend;

    // hold breath (scopes): the breath key once fully aimed, up to HOLD_BREATH_MAX s, then winded
    const full = aiming && this.t >= AIMED_AT;
    if (!inp.hold) this.needRelease = false;
    if (this.winded > 0) this.winded = Math.max(0, this.winded - d);
    if (prof.holdBreath && full && inp.hold && !this.needRelease && this.winded <= 0 && this.breath > 0) {
      this.holding = true;
      this.breath = Math.max(0, this.breath - d / HOLD_BREATH_MAX);
      if (this.breath <= 0) {
        this.holding = false;
        this.needRelease = true;
        this.winded = BREATH_RECOVER;
      }
    } else {
      this.holding = false;
      this.breath = Math.min(1, this.breath + d / BREATH_REFILL);
    }
    // bows: the arm tires held at full draw
    if (full && prof.fatigueAfter > 0) this.drawHeld += d;
    else this.drawHeld = 0;

    // sway: the class's amplitude (the sniper's per zoom step) once aimed; moving / airborne / tired /
    // winded shake more, held breath almost none standing (less help on the move)
    let amp = swayAt(prof, this.zoomIdx);
    if (prof.fatigueAfter > 0 && this.drawHeld > prof.fatigueAfter) amp += Math.min(0.35, (this.drawHeld - prof.fatigueAfter) * 0.14);
    if (inp.moving) amp *= 2;
    if (inp.airborne) amp *= 1.6;
    if (this.holding) amp *= holdBreathSway(inp.speed ?? (inp.moving ? 2.5 : 0));
    else if (this.winded > 0) amp *= 2.2;
    amp *= blend;
    this.amp += (amp - this.amp) * (1 - Math.exp(-d * 6));
    const sw = swayOffset(this.time, this.amp);
    // a scope swims onto the aim point as it comes up (only on the way in)
    const settle = prof.overlay && aiming ? scopeSettleDeg(this.t) * DEG : 0;

    this.stepRecoil(d, def ? recoilSettleDelay(def) : 0.2, prof.recoverFrac, prof.recover);

    const s = this.snap;
    s.weaponId = inp.weaponId;
    s.sight = prof.sight;
    s.progress = this.t;
    s.blend = blend;
    s.aimed = full;
    s.zoom = zoom;
    s.stepZoom = this.step;
    s.zoomIndex = this.zoomIdx;
    s.zoomSteps = zooms.length;
    s.scoped = prof.overlay && this.t >= SCOPE_AT;
    s.breath = this.breath;
    s.holding = this.holding;
    s.winded = this.winded > 0;
    s.drawHeld = this.drawHeld;
    s.swayYaw = sw.yaw + settle * SETTLE_YAW + this.kickY;
    s.swayPitch = sw.pitch + settle * SETTLE_PITCH + this.kickP;
    s.kickYaw = this.kickY;
    s.kickPitch = this.kickP;
    s.burstShots = this.burst;
    s.shotAge = this.shotAge;
    s.cycle = def ? 1 / Math.max(0.05, def.fireRate) : 1;
    s.firstPerson = inp.firstPerson ?? true;
    return s;
  }

  /**
   * Recoil over one frame: kicks ease in over KICK_EASE; once the trigger has
   * rested past the settle delay, the share of the climb that does not come
   * back (1 − recoverFrac) moves into the base look (takeResidual) and the rest
   * settles back with the class's time constant.
   */
  private stepRecoil(d: number, settleDelay: number, recoverFrac: number, recover: number): void {
    for (let i = this.kicks.length - 1; i >= 0; i--) {
      const k = this.kicks[i]!;
      const before = easeOut(k.age / KICK_EASE);
      k.age += d;
      const after = easeOut(k.age / KICK_EASE);
      this.kickP += k.pitch * (after - before);
      this.kickY += k.yaw * (after - before);
      if (k.age >= KICK_EASE) this.kicks.splice(i, 1);
    }
    this.shotAge += d;
    if (this.shotAge <= settleDelay || this.kicks.length > 0) return;
    if (!this.settled) {
      this.settled = true;
      const keep = 1 - Math.min(1, Math.max(0, recoverFrac));
      if (keep > 0) {
        this.residP += this.kickP * keep;
        this.residY += this.kickY * keep;
        this.kickP -= this.kickP * keep;
        this.kickY -= this.kickY * keep;
      }
    }
    const k = Math.exp(-d / Math.max(0.03, recover));
    this.kickP *= k;
    this.kickY *= k;
    if (Math.abs(this.kickP) < 1e-5) this.kickP = 0;
    if (Math.abs(this.kickY) < 1e-5) this.kickY = 0;
  }

  /**
   * A shot of ours left the weapon (the renderer's predicted local fire): the
   * view kicks up (and a little sideways) by the class's recoil — less once
   * aimed for steady classes, per the class's burst curve, gentler on touch —
   * easing in over KICK_EASE. `rand` (0..1) picks the sideways direction.
   * The outstanding climb never exceeds RECOIL_MAX_DEG.
   */
  onShot(weaponId: string, rand = Math.random()): void {
    if (weaponId !== this.weaponId) return;
    const def = WEAPON_BY_ID[weaponId];
    if (!def || def.melee) return;
    const prof = aimProfile(def);
    // a new burst once the trigger had rested (the settle began)
    if (this.shotAge > recoilSettleDelay(def)) this.burst = 0;
    this.burst++;
    const k = shotKick(def, adsEase(this.t));
    const mul = kickCurveMul(prof, this.burst) * (this.touch ? TOUCH_RECOIL : 1);
    let pendP = 0;
    let pendY = 0;
    for (const p of this.kicks) {
      const left = 1 - easeOut(p.age / KICK_EASE);
      pendP += p.pitch * left;
      pendY += p.yaw * left;
    }
    const max = RECOIL_MAX_DEG * DEG;
    const pitch = Math.max(0, Math.min(k.pitch * mul * DEG, max - this.kickP - pendP));
    const maxYaw = max * 0.5;
    const yawNow = this.kickY + pendY;
    const yaw = Math.max(-maxYaw - yawNow, Math.min(maxYaw - yawNow, (rand * 2 - 1) * k.yaw * mul * DEG));
    if (pitch > 0 || yaw !== 0) this.kicks.push({ pitch, yaw, age: 0 });
    this.shotAge = 0;
    this.settled = false;
  }

  /**
   * The look moved by `dPitch` radians (mouse / stick / finger): a pull down
   * while the view is still up from recoil first eats that climb, so the settle
   * never drags the aim under a target you already pulled back onto. Returns
   * the part of `dPitch` left for the base look.
   */
  absorbPitch(dPitch: number): number {
    if (!(dPitch < 0) || this.kickP <= 0) return dPitch;
    const used = Math.min(this.kickP, -dPitch);
    this.kickP -= used;
    return dPitch + used;
  }

  /** The climb that will not come back (radians): the caller adds it to its base look angles. Cleared on read. */
  takeResidual(): { yaw: number; pitch: number } {
    const r = { yaw: this.residY, pitch: this.residP };
    this.residY = this.residP = 0;
    return r;
  }

  /** The latest snapshot (without advancing). */
  get snapshot(): Readonly<AimSnapshot> {
    return this.snap;
  }

  /**
   * Mouse wheel while the sights are up on a weapon with zoom steps: the next
   * step (`dir` > 0: in). Returns true when it was used (no weapon switch then).
   */
  cycleZoom(dir: number): boolean {
    const def = this.weaponId ? WEAPON_BY_ID[this.weaponId] : undefined;
    const n = adsZooms(def).length;
    if (n < 2 || this.t < 0.5) return false;
    const next = this.zoomIdx + (dir > 0 ? 1 : -1);
    this.zoomIdx = next < 0 ? n - 1 : next >= n ? 0 : next;
    return true;
  }
}
