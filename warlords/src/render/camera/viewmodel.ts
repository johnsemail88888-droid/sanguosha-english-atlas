// First-person weapon viewmodel: the held weapon (the AI-art GLB when loaded,
// else the procedural one — models/weapons.ts buildWeapon, in its calibrated
// frame: origin = right wrist target, barrel −Z, up +Y) with simple hands and
// sleeves in the hero's colours. It lives in its own little scene in camera
// space and is drawn after the world with the depth buffer cleared
// (scene/post.ts overlay), so it never clips into a wall you hug.
// Pose: lower right at the hip, centred on the sights while aiming (bows drawn
// to the eye), lowered while sprinting, dipped while reloading, raised after a
// weapon switch; recoil kick, idle breathing, look sway and a walk bob on top.
import * as THREE from 'three';
import { clamp, lerpAngle, wrapAngle } from '../../core/math';
import { HERO_BY_ID, WEAPON_BY_ID } from '../../data';
import { aimProfile } from '../../data/weaponFeel';
import { GeoBuilder, PRIM, mixCol, shade, trs, type ColorLike } from '../core/geo';
import { SUN_DIR } from '../scene/lights';
import { buildWeapon, isAkimbo, weaponArtEpoch, type HoldStyle, type WeaponModel, type WeaponModelInfo } from '../models/weapons';
import { requestWeaponArt } from '../models/weaponGlb';

/** Vertical field of view of the viewmodel camera (independent of the world FOV setting, like most shooters). */
export const VIEWMODEL_FOV = 54;

/** Camera-space pose: position (m; x right, y up, z back — the camera looks down −Z) + yaw / pitch / roll (rad, Euler YXZ). */
export interface VmPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

const pose = (x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): VmPose => ({ x, y, z, yaw, pitch, roll });

/**
 * Hip pose of the weapon frame's origin (the right wrist; bows: the left hand
 * on the grip) per hold style: lower right, the barrel almost parallel to the
 * view (a hair inward so it points at the crosshair's far point).
 */
export const HIP_POSE: Readonly<Record<HoldStyle, VmPose>> = {
  rifle: pose(0.19, -0.2, -0.43, 0.045, 0.02),
  hip: pose(0.21, -0.25, -0.5, 0.05, 0.015),
  launcher: pose(0.22, -0.27, -0.48, 0.04, 0.015),
  pistol: pose(0.14, -0.15, -0.4, 0.06, 0.03),
  akimbo: pose(0.16, -0.15, -0.4, 0.07, 0.03),
  bow: pose(-0.15, -0.16, -0.6, 0.06, 0.03, 0.55),
  pole: pose(0.2, -0.25, -0.4, 0.14, 0.3, -0.08),
  sword: pose(0.22, -0.24, -0.42, 0.32, 0.85, -0.35),
  none: pose(0.2, -0.25, -0.42),
};

/**
 * Size of the held weapon + hands in the view: a 1.3 m bow at arm's length
 * would span the screen, so bows are drawn smaller (the viewmodel has its own
 * camera and depth; nothing in the world depends on its size).
 */
export const HOLD_SCALE: Partial<Record<HoldStyle, number>> = { bow: 0.72 };

/** How far a DMR sinks under its marksman near sight once aimed (m, view space). */
export const MARKSMAN_DROP = 0.085;

/**
 * Aim-down-sights pose: the weapon centred under the crosshair with its sight
 * line (the top of the receiver / scope, `sightY` above the wrist) just below
 * the screen centre. Bows are drawn to the eye, canted a little; polearms are
 * levelled at the target.
 */
export function adsPose(hold: HoldStyle, sightY: number, scoped = false): VmPose {
  switch (hold) {
    case 'bow':
      return pose(-0.075, -0.085, -0.62, 0.03, 0, 0.36);
    case 'pole':
      return pose(0.09, -0.17, -0.4, 0.04, 0.06, -0.04);
    case 'sword':
      return HIP_POSE.sword;
    case 'none':
      return HIP_POSE.none;
    case 'akimbo':
      return pose(0.1, -0.13, -0.38, 0.03, 0.01);
    case 'hip':
      // LMG / flamer: a bulky receiver — held lower and further out, so the box does not fill the lower view
      return pose(0.012, -sightY - 0.05, -0.47);
    default:
      // a scope comes right up to the eye (the lens overlay takes over once it is there)
      if (scoped) return pose(0, -sightY + 0.004, -0.2);
      // (the sights a touch under the crosshair: it stays on the target, not on a chunk of gun)
      return pose(0, -sightY - (hold === 'pistol' ? 0.012 : 0.02), hold === 'pistol' ? -0.36 : -0.36);
  }
}

/** Height of the sight line above the weapon frame's origin: the top of the receiver near the grip (m). */
export function sightHeight(geo: THREE.BufferGeometry): number {
  const p = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!p) return 0.08;
  let top = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    // the receiver / scope over the hand, not side ornaments or a raised muzzle end
    if (Math.abs(x) > 0.05 || z < -0.4 || z > 0.12) continue;
    top = Math.max(top, p.getY(i));
  }
  return Number.isFinite(top) ? clamp(top, 0.02, 0.24) : 0.08;
}

export interface ViewModelInput {
  /** weapon in the hands (null = none shown) */
  weaponId: string | null;
  /** the local hero (sleeve / skin colours) */
  heroId: string;
  /** aiming (ADS) */
  ads: boolean;
  /** eased aim progress 0..1 when known (game/aimFeel.ts: each class's ADS time); else eased here from `ads` */
  adsBlend?: number;
  /** hide the viewmodel (a scope fills the screen, downed, dead) */
  hidden: boolean;
  sprinting: boolean;
  reloading: boolean;
  /** weapon lowered (stunned, dancing, disarmed, channeling) */
  lowered: boolean;
  airborne: boolean;
  /** horizontal speed (m/s) */
  speed: number;
  /** look angles (sway follows their change) */
  yaw: number;
  pitch: number;
  /** the world camera's orientation (the viewmodel's light follows the sun) */
  cameraQuat: THREE.Quaternion;
}

interface Held {
  id: string;
  model: WeaponModel;
  second: WeaponModel | null;
  info: WeaponModelInfo;
  hold: HoldStyle;
  sightY: number;
  /** weaponArtEpoch() it was built at: a procedural stand-in is rebuilt when the art arrives */
  epoch: number;
  art: boolean;
  /** looked through a scope (a lens overlay once aimed: data/weaponFeel.ts) */
  scoped: boolean;
  /** a marksman near sight (DMRs): the HUD draws the sight's window, the gun sits below it */
  near: boolean;
}

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _qi = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();

let handMat: THREE.MeshStandardMaterial | null = null;
function handMaterial(): THREE.MeshStandardMaterial {
  if (!handMat) {
    handMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.78, metalness: 0.05 });
    handMat.name = 'viewmodelHands';
  }
  return handMat;
}

/** Colours of the hands and sleeves: skin, sleeve cloth, cuff trim, leather wrap. */
export interface HandColors {
  skin: ColorLike;
  sleeve: ColorLike;
  cuff: ColorLike;
  wrap: ColorLike;
}

export function handColorsOf(heroId: string): HandColors {
  const v = HERO_BY_ID[heroId]?.visual;
  const skin = v?.skin ?? '#d9a877';
  const sleeve = v?.primary ?? '#5a4a3a';
  return { skin, sleeve, cuff: v?.accent ?? '#c9a04a', wrap: shade(mixCol(v?.secondary ?? '#6a6a6a', '#3a2a1a', 0.5), 0.8) };
}

/** Forearm from `wrist` along `dir` (unit) for `len` m: bare wrist, then the sleeve with a trim cuff. */
function forearm(b: GeoBuilder, wrist: THREE.Vector3, dir: THREE.Vector3, len: number, c: HandColors): void {
  const a = wrist.clone();
  const m1 = wrist.clone().addScaledVector(dir, 0.07);
  const m2 = wrist.clone().addScaledVector(dir, 0.1);
  const end = wrist.clone().addScaledVector(dir, len);
  b.rod(a, m1, 0.03, c.wrap, 8, 1.12); // leather bracer
  b.rod(m1, m2, 0.043, c.cuff, 8); // trim
  b.rod(m2, end, 0.047, c.sleeve, 8, 1.15); // sleeve
}

/** A finger / thumb: a rounded rod from `a` to `b`. */
function digit(b: GeoBuilder, a: THREE.Vector3, e: THREE.Vector3, r: number, color: ColorLike): void {
  b.rod(a, e, r, color, 6);
  b.add(PRIM.sphere(6, 4), trs(e.x, e.y, e.z, 0, 0, 0, r, r, r), color);
  b.add(PRIM.sphere(6, 4), trs(a.x, a.y, a.z, 0, 0, 0, r, r, r), color);
}

/**
 * A hand closed around a vertical grip centred at `at` (the grip runs along
 * local Y, `tilt` leans it back): the back of the hand on the outer side, four
 * fingers wrapped round the front, the thumb along the inner side.
 * `right`: a right hand (its thumb on the −X side); false mirrors it.
 */
function fist(b: GeoBuilder, at: THREE.Vector3, c: HandColors, right: boolean, tilt = 0): void {
  const m = right ? 1 : -1;
  const knuckle = shade(c.skin, 0.92);
  b.push(trs(at.x, at.y, at.z, tilt, 0, 0));
  b.add(PRIM.sphere(8, 6), trs(0.022 * m, 0, 0.01, 0, 0, 0, 0.021, 0.047, 0.036), c.skin); // back of the hand
  for (let i = 0; i < 4; i++) {
    const y = 0.027 - i * 0.018;
    digit(b, v3(0.024 * m, y, -0.014), v3(-0.016 * m, y - 0.002, -0.03), 0.0095, i % 2 ? knuckle : c.skin);
  }
  digit(b, v3(-0.012 * m, 0.028, 0.022), v3(-0.024 * m, 0.042, -0.016), 0.0105, c.skin); // thumb
  b.pop();
}

/** A hand cupped under a barrel / handguard centred at `at` (fingers wrapping up the right side, thumb on the left). */
function supportHand(b: GeoBuilder, at: THREE.Vector3, c: HandColors): void {
  const knuckle = shade(c.skin, 0.92);
  b.push(trs(at.x, at.y, at.z));
  b.add(PRIM.sphere(8, 6), trs(0.002, -0.034, 0.004, 0, 0, 0, 0.031, 0.016, 0.052), c.skin); // palm
  for (let i = 0; i < 4; i++) {
    const z = -0.034 + i * 0.021;
    digit(b, v3(0.024, -0.034, z), v3(0.036, -0.004, z - 0.004), 0.0092, i % 2 ? knuckle : c.skin);
  }
  digit(b, v3(-0.024, -0.03, 0.03), v3(-0.033, -0.008, -0.018), 0.01, c.skin); // thumb
  b.pop();
}

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const dirOf = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).normalize();

/**
 * Hands + forearms for a hold style, in the weapon frame (origin = the right
 * wrist target; bows: the left hand). `fore` = the support hand's point.
 */
export function buildHands(hold: HoldStyle, fore: THREE.Vector3 | null, c: HandColors): THREE.BufferGeometry {
  const b = new GeoBuilder();
  switch (hold) {
    case 'bow': {
      // left fist around the bow's grip, arm reaching out from the chest; right hand pinching the string at the nock
      fist(b, v3(0, 0, 0.01), c, false);
      forearm(b, v3(-0.01, -0.02, 0.045), dirOf(-0.16, -0.36, 0.92), 0.3, c);
      // the drawing hand pinches the string at the nock (its arm runs back to the cheek, out of view)
      const nock = fore ?? v3(0, 0, 0.3);
      digit(b, v3(nock.x + 0.02, nock.y + 0.012, nock.z + 0.012), v3(nock.x + 0.004, nock.y + 0.012, nock.z - 0.004), 0.011, c.skin);
      digit(b, v3(nock.x + 0.02, nock.y - 0.012, nock.z + 0.012), v3(nock.x + 0.004, nock.y - 0.012, nock.z - 0.004), 0.011, c.skin);
      b.add(PRIM.sphere(8, 6), trs(nock.x + 0.03, nock.y, nock.z + 0.03, 0, 0, 0, 0.022, 0.032, 0.03), c.skin);
      break;
    }
    case 'pole':
    case 'sword': {
      // fists around the shaft / hilt (the shaft runs along Z)
      b.push(trs(0, 0, 0, Math.PI / 2, 0, 0));
      fist(b, v3(0, 0, 0), c, true);
      b.pop();
      forearm(b, v3(0.012, -0.03, 0.03), dirOf(0.3, -0.55, 0.78), 0.32, c);
      if (hold === 'pole' && fore) {
        b.push(trs(fore.x, fore.y, fore.z, Math.PI / 2, 0, 0));
        fist(b, v3(0, 0, 0), c, false);
        b.pop();
        forearm(b, v3(fore.x - 0.015, fore.y - 0.03, fore.z + 0.03), dirOf(-0.35, -0.55, 0.76), 0.34, c);
      }
      break;
    }
    case 'none':
      break;
    default: {
      // right fist on the pistol grip (below and ahead of the wrist target, tilted back)
      fist(b, v3(0.004, -0.052, 0.022), c, true, 0.28);
      forearm(b, v3(0.008, -0.012, 0.055), dirOf(0.26, -0.5, 0.83), 0.3, c);
      if (hold === 'akimbo') break;
      if (hold === 'pistol') {
        // left hand cupping the right fist
        const f = fore ?? v3(-0.03, -0.03, 0.02);
        b.add(PRIM.box(), trs(f.x - 0.012, f.y - 0.03, f.z + 0.01, 0, 0, 0.3, 0.05, 0.075, 0.07), shade(c.skin, 0.95));
        forearm(b, v3(f.x - 0.03, f.y - 0.05, f.z + 0.05), dirOf(-0.5, -0.5, 0.7), 0.3, c);
      } else if (fore) {
        supportHand(b, fore, c);
        forearm(b, v3(fore.x - 0.018, fore.y - 0.05, fore.z + 0.035), dirOf(-0.34, -0.58, 0.74), 0.34, c);
      }
    }
  }
  return b.build();
}

/**
 * The viewmodel: its own scene + camera (camera space; the camera never moves),
 * posed every frame from the local hero's state.
 */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** false: the overlay pass skips it */
  visible = false;
  private readonly rig = new THREE.Group();
  /** akimbo: the left weapon (a mirrored copy of the rig's contents) */
  private readonly left = new THREE.Group();
  private readonly sun = new THREE.DirectionalLight('#ffe2b0', 2.3);
  private readonly hemi = new THREE.HemisphereLight('#bcd0e0', '#6a5638', 1.3);
  private held: Held | null = null;
  private hands: THREE.Mesh | null = null;
  private handsLeft: THREE.Mesh | null = null;
  private handGeo: THREE.BufferGeometry | null = null;
  private handKey = '';
  private readonly cur = pose(0, 0, 0);
  private initialised = false;
  // animation state
  private adsBlend = 0;
  private sprintBlend = 0;
  private reloadBlend = 0;
  private lowerBlend = 0;
  private airBlend = 0;
  private raise = 1;
  private kickBack = 0;
  private kickPitch = 0;
  private kickYaw = 0;
  private swing = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private swayX = 0;
  private swayY = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private time = 0;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(VIEWMODEL_FOV, 16 / 9, 0.01, 6);
    this.camera.updateMatrixWorld();
    this.scene.name = 'viewmodel';
    this.rig.name = 'viewmodelRig';
    this.left.name = 'viewmodelLeft';
    this.left.scale.x = -1;
    this.left.visible = false;
    this.scene.add(this.rig, this.left, this.sun, this.sun.target, this.hemi);
    this.scene.visible = false;
  }

  setAspect(aspect: number): void {
    if (Math.abs(this.camera.aspect - aspect) < 1e-4) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Current weapon id shown (null = none). */
  get weaponId(): string | null {
    return this.held?.id ?? null;
  }

  /** The hold style shown (for tests / the renderer). */
  get hold(): HoldStyle {
    return this.held?.hold ?? 'none';
  }

  /** A shot left the weapon: recoil kick (`recoil` = the weapon's data recoil, degrees-ish), or a swing for melee. */
  fire(recoil: number, melee = false): void {
    if (melee) {
      this.swing = 1;
      return;
    }
    const k = clamp(recoil, 0.3, 6);
    const ads = 1 - this.adsBlend * 0.55;
    this.kickBack = Math.min(0.09, this.kickBack + (0.012 + k * 0.006) * ads);
    this.kickPitch = Math.min(0.3, this.kickPitch + (0.02 + k * 0.012) * ads);
    this.kickYaw += (Math.random() - 0.5) * 0.02 * k * ads;
  }

  /** Advance one frame. */
  update(dt: number, inp: ViewModelInput): void {
    this.time += dt;
    this.setWeapon(inp.weaponId, inp.heroId);
    const show = !inp.hidden && this.held !== null && this.held.hold !== 'none';
    this.visible = show;
    this.scene.visible = show;
    if (!show) {
      this.lastYaw = inp.yaw;
      this.lastPitch = inp.pitch;
      return;
    }
    const held = this.held!;
    const k = (rate: number): number => 1 - Math.exp(-dt * rate);
    if (inp.adsBlend !== undefined) this.adsBlend = clamp(inp.adsBlend, 0, 1);
    else this.adsBlend += ((inp.ads && !inp.sprinting && !inp.reloading && !inp.lowered ? 1 : 0) - this.adsBlend) * k(14);
    this.sprintBlend += ((inp.sprinting && !inp.ads ? 1 : 0) - this.sprintBlend) * k(9);
    this.reloadBlend += ((inp.reloading ? 1 : 0) - this.reloadBlend) * k(10);
    this.lowerBlend += ((inp.lowered ? 1 : 0) - this.lowerBlend) * k(8);
    this.airBlend += ((inp.airborne ? 1 : 0) - this.airBlend) * k(8);
    this.raise = Math.min(1, this.raise + dt / 0.28);
    const kd = Math.exp(-dt * 13);
    this.kickBack *= kd;
    this.kickPitch *= kd;
    this.kickYaw *= kd;
    this.swing = Math.max(0, this.swing - dt / 0.32);
    // look sway: the weapon lags behind the turn a little
    if (this.initialised && dt > 1e-4) {
      const dy = wrapAngle(inp.yaw - this.lastYaw) / dt;
      const dp = (inp.pitch - this.lastPitch) / dt;
      const calm = 1 - this.adsBlend * 0.75;
      this.swayX += (clamp(dy * 0.0065, -0.03, 0.03) * calm - this.swayX) * k(10);
      this.swayY += (clamp(-dp * 0.0065, -0.025, 0.025) * calm - this.swayY) * k(10);
    }
    this.lastYaw = inp.yaw;
    this.lastPitch = inp.pitch;
    // walk bob (sprint: bigger, aiming: almost none)
    const sp = clamp(inp.speed / 5, 0, 1.5) * (inp.airborne ? 0 : 1);
    this.bobAmp += (sp * (1 + this.sprintBlend * 0.6) * (1 - this.adsBlend * 0.85) - this.bobAmp) * k(6);
    this.bobPhase += dt * (6.5 + inp.speed * 0.9);

    const hip = HIP_POSE[held.hold];
    const ads = adsPose(held.hold, held.sightY, held.scoped);
    const a = this.adsBlend;
    const t = this.time;
    const breathe = 1 - a * 0.7;
    const p = this.cur;
    p.x = hip.x + (ads.x - hip.x) * a;
    p.y = hip.y + (ads.y - hip.y) * a;
    p.z = hip.z + (ads.z - hip.z) * a;
    p.yaw = lerpAngle(hip.yaw, ads.yaw, a);
    p.pitch = hip.pitch + (ads.pitch - hip.pitch) * a;
    p.roll = hip.roll + (ads.roll - hip.roll) * a;
    // sprint: muzzle swung down and to the left
    const s = this.sprintBlend;
    p.x += 0.03 * s;
    p.y -= 0.045 * s;
    p.z += 0.03 * s;
    p.yaw += 0.55 * s;
    p.pitch -= 0.28 * s;
    // reload: dip and roll toward you
    const r = this.reloadBlend;
    p.y -= 0.05 * r;
    p.pitch -= 0.32 * r;
    p.roll += 0.45 * r + Math.sin(t * 9) * 0.02 * r;
    // a scope: the weapon comes up and then drops out of the frame as the eye meets the lens
    // (the lens overlay takes over from game/aimFeel.ts SCOPE_AT — no gun model filling the view)
    // a marksman near sight: the HUD draws the sight's round window at the screen centre — the gun
    // itself settles low under it (the stock at the cheek, the scope body out of the window)
    if (held.near) {
      p.y -= MARKSMAN_DROP * a;
      p.pitch -= 0.03 * a;
    }
    if (held.scoped) {
      // (it is fully down by blend 0.75 ≈ progress 0.68, just before SCOPE_AT 0.70 hides it)
      const out = clamp((a - 0.55) / 0.2, 0, 1);
      p.y -= 0.15 * out;
      p.pitch -= 0.25 * out;
    }
    // lowered (stunned / dancing / disarmed): out of the way
    const lo = this.lowerBlend;
    p.y -= 0.12 * lo;
    p.pitch -= 0.5 * lo;
    // switch: raised from below
    const up = 1 - this.raise;
    const ease = up * up;
    p.y -= 0.22 * ease;
    p.pitch -= 0.7 * ease;
    // airborne: pulled up a touch
    p.y += 0.012 * this.airBlend;
    // breathing + walk bob + look sway
    p.y += Math.sin(t * 1.6) * 0.0022 * breathe - Math.abs(Math.cos(this.bobPhase)) * 0.011 * this.bobAmp;
    p.x += Math.sin(this.bobPhase) * 0.008 * this.bobAmp + this.swayX;
    p.y += this.swayY;
    p.pitch += Math.sin(t * 1.1) * 0.005 * breathe;
    p.yaw += this.swayX * 1.6;
    p.pitch += this.swayY * 1.6;
    // recoil
    p.z += this.kickBack;
    p.pitch += this.kickPitch;
    p.yaw += this.kickYaw;
    // melee swing: a quick diagonal cut
    if (this.swing > 0) {
      const w = Math.sin((1 - this.swing) * Math.PI);
      p.yaw -= 0.9 * w;
      p.pitch -= 0.4 * w;
      p.x -= 0.08 * w;
    }
    this.applyPose(this.rig, p, false);
    if (this.left.visible) this.applyPose(this.left, p, true);
    const sc = HOLD_SCALE[held.hold] ?? 1;
    this.rig.scale.setScalar(sc);
    this.left.scale.set(-sc, sc, sc);
    this.initialised = true;
    // the sun lights the weapon from where it is in the world
    _qi.copy(inp.cameraQuat).invert();
    this.sun.position.copy(SUN_DIR).applyQuaternion(_qi).multiplyScalar(5);
    this.hemi.position.set(0, 1, 0).applyQuaternion(_qi);
  }

  /** `mirror`: the akimbo left group (scale.x = −1): the same pose reflected to the left of the view. */
  private applyPose(g: THREE.Object3D, p: VmPose, mirror: boolean): void {
    const m = mirror ? -1 : 1;
    g.position.set(p.x * m, p.y, p.z);
    _e.set(p.pitch, p.yaw * m, p.roll * m, 'YXZ');
    g.quaternion.setFromEuler(_e);
  }

  /**
   * World-space point where the muzzle appears on screen, `depth` along the
   * world camera's view (the muzzle flash / tracer start there, so they leave
   * the viewmodel's barrel although it is drawn with its own camera).
   */
  muzzleWorld(main: THREE.PerspectiveCamera, out: THREE.Vector3): boolean {
    const held = this.held;
    if (!this.visible || !held) return false;
    const mesh = held.model.mesh;
    mesh.updateWorldMatrix(true, false);
    _p.copy(held.info.muzzle).applyMatrix4(mesh.matrixWorld);
    const depth = Math.max(0.2, -_p.z);
    _p.project(this.camera);
    if (!Number.isFinite(_p.x) || !Number.isFinite(_p.y)) return false;
    main.updateMatrixWorld();
    _d.set(_p.x, _p.y, 0.5).unproject(main).sub(main.position).normalize();
    main.getWorldDirection(_f);
    const along = Math.max(0.2, _d.dot(_f));
    out.copy(main.position).addScaledVector(_d, depth / along);
    return true;
  }

  /** Equip (cheap when unchanged; rebuilt when the weapon's AI art finished loading). */
  private setWeapon(id: string | null, heroId: string): void {
    const cur = this.held;
    if (cur && id === cur.id && (cur.art || cur.epoch === weaponArtEpoch())) {
      this.setHands(cur, heroId);
      return;
    }
    if (!id) {
      if (cur) this.dropWeapon();
      return;
    }
    const changed = !cur || cur.id !== id;
    this.dropWeapon();
    const waiting = requestWeaponArt(id);
    const model = buildWeapon(id);
    const art = model.mesh.userData.weaponArt === true;
    const akimbo = isAkimbo(id);
    let hold: HoldStyle = akimbo ? 'akimbo' : model.info.hold;
    if (hold === 'rifle' && model.info.length < 0.45) hold = 'pistol';
    model.mesh.castShadow = false;
    model.mesh.frustumCulled = false;
    this.rig.add(model.mesh);
    let second: WeaponModel | null = null;
    if (akimbo) {
      second = buildWeapon(id);
      second.mesh.castShadow = false;
      second.mesh.frustumCulled = false;
      this.left.add(second.mesh);
    }
    this.left.visible = akimbo;
    const prof = aimProfile(WEAPON_BY_ID[id]);
    const scoped = prof.overlay;
    this.held = { id, model, second, info: model.info, hold, sightY: sightHeight(model.mesh.geometry), epoch: weaponArtEpoch(), art: art || !waiting, scoped, near: prof.sight === 'marksman' };
    this.setHands(this.held, heroId);
    if (changed) this.raise = 0;
  }

  private setHands(h: Held, heroId: string): void {
    const key = `${heroId}|${h.hold}|${h.info.fore?.toArray().join(',') ?? ''}`;
    if (key === this.handKey) return;
    this.handKey = key;
    this.dropHands();
    const geo = buildHands(h.hold, h.info.fore, handColorsOf(heroId));
    this.handGeo = geo;
    this.hands = new THREE.Mesh(geo, handMaterial());
    this.hands.name = 'viewmodelHands';
    this.hands.frustumCulled = false;
    this.rig.add(this.hands);
    if (h.hold === 'akimbo') {
      this.handsLeft = new THREE.Mesh(geo, handMaterial());
      this.handsLeft.frustumCulled = false;
      this.left.add(this.handsLeft);
    }
  }

  private dropHands(): void {
    this.hands?.removeFromParent();
    this.handsLeft?.removeFromParent();
    this.handGeo?.dispose();
    this.hands = this.handsLeft = null;
    this.handGeo = null;
  }

  private dropWeapon(): void {
    const h = this.held;
    if (!h) return;
    // geometry / material are shared per weapon id (models/weapons.ts caches)
    h.model.mesh.removeFromParent();
    h.second?.mesh.removeFromParent();
    this.held = null;
    this.left.visible = false;
  }

  /** Test / debug: the current animated pose of the weapon frame (camera space). */
  get currentPose(): Readonly<VmPose> {
    return this.cur;
  }

  /** Programs of the viewmodel's materials, compiled ahead (loading warm-up). */
  compile(renderer: THREE.WebGLRenderer): void {
    const vis = this.scene.visible;
    this.scene.visible = true;
    const probe = new THREE.Mesh(PRIM.box(), handMaterial());
    this.rig.add(probe);
    try {
      renderer.compile(this.scene, this.camera);
    } finally {
      probe.removeFromParent();
      this.scene.visible = vis;
    }
  }

  dispose(): void {
    this.dropWeapon();
    this.dropHands();
    this.handKey = '';
    this.scene.clear();
  }
}

/** Quaternion of a yaw / pitch camera (core/math convention), for tests. */
export function lookQuat(yaw: number, pitch: number, out = new THREE.Quaternion()): THREE.Quaternion {
  _e.set(pitch, yaw, 0, 'YXZ');
  return out.setFromEuler(_e);
}
