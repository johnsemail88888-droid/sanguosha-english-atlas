// The local player's aim, frame by frame (no DOM, no three.js; unit-tested):
// how far the sights are up (the class's ADS time, data/weaponFeel.ts), the
// zoom the camera shows (a sniper scope's two steps, switched with the wheel),
// whether a lens overlay covers the screen, and the breathing sway of a scope
// (Shift holds the breath for a few seconds, then you are winded for a moment).
// The InputController owns it: the sway is added to the look angles it sends,
// so the host's crosshair ray (and every shot) follows the reticle exactly.
import { WEAPON_BY_ID } from '../data';
import { adsEase, adsZooms, aimProfile, BREATH_RECOVER, HOLD_BREATH_MAX, stepAdsT, swayOffset, type SightKind } from '../data/weaponFeel';

/** What the renderer and the HUD read about the local aim this frame. */
export interface AimSnapshot {
  weaponId: string | null;
  sight: SightKind;
  /** aim progress 0 (hip) … 1 (aimed), linear in time */
  progress: number;
  /** eased progress (camera zoom, viewmodel, reticle fade) */
  blend: number;
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
  /** sway added to the look angles (radians) */
  swayYaw: number;
  swayPitch: number;
  /** the camera is the hero's eye (near sights draw their housing only then) */
  firstPerson: boolean;
}

export interface AimInput {
  weaponId: string | null;
  /** the aim button is held */
  ads: boolean;
  /** aiming is impossible right now (reloading, downed, stunned, dancing, disarmed) */
  blocked: boolean;
  /** Shift held (hold breath while scoped) */
  hold: boolean;
  moving: boolean;
  airborne: boolean;
  /** first-person camera (default true) */
  firstPerson?: boolean;
}

/** Breath comes back in this many seconds from empty. */
const BREATH_REFILL = 3;
/** Overlay sights cover the screen from this aim progress on. */
export const SCOPE_AT = 0.7;

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
  private readonly snap: AimSnapshot = {
    weaponId: null,
    sight: 'none',
    progress: 0,
    blend: 0,
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
    firstPerson: true,
  };

  /** Advance one frame (dt in seconds) and return the snapshot (the same object every frame). */
  update(dt: number, inp: AimInput): AimSnapshot {
    const d = Math.min(0.1, Math.max(0, dt));
    this.time += d;
    if (inp.weaponId !== this.weaponId) {
      // another weapon in hand: from the hip, first zoom step
      this.weaponId = inp.weaponId;
      this.t = 0;
      this.zoomIdx = 0;
      this.drawHeld = 0;
      this.step = 0;
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
    const zoom = 1 + (this.step - 1) * blend;

    // hold breath (scopes): Shift once fully aimed, up to HOLD_BREATH_MAX s, then winded
    const full = aiming && this.t >= 0.95;
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

    // sway: the class's amplitude once aimed; moving / airborne / tired / winded shake more, held breath almost none
    let amp = prof.sway;
    if (prof.fatigueAfter > 0 && this.drawHeld > prof.fatigueAfter) amp += Math.min(0.35, (this.drawHeld - prof.fatigueAfter) * 0.14);
    if (inp.moving) amp *= 2;
    if (inp.airborne) amp *= 1.6;
    if (this.holding) amp *= 0.08;
    else if (this.winded > 0) amp *= 2.2;
    amp *= blend;
    this.amp += (amp - this.amp) * (1 - Math.exp(-d * 6));
    const sw = swayOffset(this.time, this.amp);

    const s = this.snap;
    s.weaponId = inp.weaponId;
    s.sight = prof.sight;
    s.progress = this.t;
    s.blend = blend;
    s.zoom = zoom;
    s.stepZoom = this.step;
    s.zoomIndex = this.zoomIdx;
    s.zoomSteps = zooms.length;
    s.scoped = prof.overlay && this.t >= SCOPE_AT;
    s.breath = this.breath;
    s.holding = this.holding;
    s.winded = this.winded > 0;
    s.drawHeld = this.drawHeld;
    s.swayYaw = sw.yaw;
    s.swayPitch = sw.pitch;
    s.firstPerson = inp.firstPerson ?? true;
    return s;
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
