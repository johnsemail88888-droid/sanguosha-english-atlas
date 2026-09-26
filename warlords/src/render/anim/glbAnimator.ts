// Mocap animation for the GLB character bodies: one AnimationMixer per
// character, driven by the same inputs as the procedural CharacterAnimator
// (speed, move direction, pitch, VF_* flags, mount, one-shot events).
//
//   glbBlend()     PURE state → target weights (unit-tested): two layers —
//                  lower body (hips + legs: idle / run / backpedal / sprint /
//                  roll / jump / death / knockdown / crawl / dance / sit) and
//                  upper body (the aimed-rifle pose, bow, reload, cast,
//                  melee, hit flinch) over the lower clips' own upper bodies.
//   GlbAnimator    crossfades the weights (linear 0.2 s ramps), drives the
//                  locomotion clips by distance travelled (phase-synced, feet
//                  do not slide), then post-processes the pose: hips turned
//                  toward the travel direction with the chest counter-turned,
//                  an aim solve that turns the torso until the held weapon
//                  points along the camera aim (pitch included), recoil kick,
//                  hit flinch, stun wobble, saddle placement with the legs
//                  astride (IK to the stirrups / the howdah's pad, models/
//                  mounts.ts RIDE_POSE), left-hand IK on the foregrip (a
//                  pistol's support hand cups the grip, a bow's drawing hand
//                  holds the string; a foregrip out of the arm's reach: the
//                  hand slides back along the weapon, ik.slideToReach), and
//                  the cloth followers (capes / robes
//                  skinned to models/glb.ts CLOTH_BONES trail the thighs at a
//                  damped amplitude). Pistols, akimbo pairs, hip-fired
//                  flamers / LMGs, shouldered launchers and staves place the
//                  weapon themselves (GLB_HOLD_POSES, like the procedural
//                  rig's HOLD_POSES) instead of the aimed-rifle clip's arms.
//
// Locomotion set: every movement in the game is a run (heroes 5 m/s, troops
// 5-6 m/s, ADS 3 m/s, sprint 7.5 m/s) while the shipped walk clips are slow
// (≤ 1 m/s), so the forward run is the gait for every direction — the hips
// turn up to 80° toward the travel direction, backwards it plays in reverse
// (slow backpedals use the walking one) — with its stride shortened below
// ~80 % of its authored speed by blending toward the run's own mean pose
// (cadence stays natural instead of slow motion).
import * as THREE from 'three';
import {
  VF_ADS,
  VF_AIRBORNE,
  VF_CHANNELING,
  VF_DANCING,
  VF_DEAD,
  VF_DODGING,
  VF_DOWNED,
  VF_FIRING,
  VF_FROZEN,
  VF_RELOADING,
  VF_SPRINTING,
  VF_STUNNED,
} from '../../core/types';
import type { HoldStyle } from '../models/weapons';
import { CLOTH_BONES, type CharTemplate } from '../models/glb';
import { RIDE_POSE, rideKindOf, type RidePose } from '../models/mounts';
import { CLIP_SPECS, modelClip, type ClipId, type ModelClip } from './glbClips';
import { alignFrames, limbJoints, slideToReach, twoBoneReach } from './ik';

// ── slots ────────────────────────────────────────────────────────────────────

export const LOWER_SLOTS = ['idle', 'run', 'runRev', 'sprint', 'walkBack', 'stride', 'jump', 'roll', 'death', 'knockdown', 'crawl', 'dance', 'sit'] as const;
export type LowerSlot = (typeof LOWER_SLOTS)[number];
export const UPPER_SLOTS = ['aim', 'bow', 'reload', 'cast', 'meleeHeavy', 'meleeThrust', 'hit', 'bowShot'] as const;
export type UpperSlot = (typeof UPPER_SLOTS)[number];
export const L = Object.fromEntries(LOWER_SLOTS.map((s, i) => [s, i])) as Record<LowerSlot, number>;
export const U = Object.fromEntries(UPPER_SLOTS.map((s, i) => [s, i])) as Record<UpperSlot, number>;

/** Clip each slot plays. */
export const SLOT_CLIP: Record<LowerSlot | UpperSlot, ClipId> = {
  idle: 'idle',
  run: 'run',
  runRev: 'run',
  sprint: 'sprint',
  walkBack: 'walkBack',
  stride: 'runMean',
  jump: 'jump',
  roll: 'roll',
  death: 'death',
  knockdown: 'knockdown',
  crawl: 'crawl',
  dance: 'dance',
  sit: 'sit',
  aim: 'aim',
  bow: 'bow',
  reload: 'reload',
  cast: 'cast',
  meleeHeavy: 'meleeHeavy',
  meleeThrust: 'meleeThrust',
  hit: 'hit',
  bowShot: 'bowShot',
};

/** Slots whose clip time follows the distance travelled (gait phase). */
const PHASE_SLOTS: readonly LowerSlot[] = ['run', 'runRev', 'sprint', 'walkBack'];

// ── tuning ───────────────────────────────────────────────────────────────────

/** Crossfade time (s) of a weight ramp. */
export const CROSSFADE = 0.2;
/** Faster ramps for reactions (dodge, hit, melee, death). */
export const CROSSFADE_FAST = 0.1;
/** Enter / leave the backpedal sector at these |travel angles| (rad; hysteresis). */
export const BACK_ENTER = (105 * Math.PI) / 180;
export const BACK_EXIT = (80 * Math.PI) / 180;
/** Largest hips turn toward the travel direction (rad). */
export const WARP_MAX = (80 * Math.PI) / 180;
/** Shortest stride (fraction of the authored run) before the cadence slows instead. */
export const MIN_STRIDE = 0.42;
/** Down to this fraction of its authored speed a gait just slows its cadence (full stride); below, the stride shortens too. */
export const FULL_STRIDE_FROM = 0.78;
/** Below this speed (m/s) a backwards move uses the walking backpedal clip. */
export const WALK_BACK_MAX = 2;
/** One-shot durations (s). */
export const ROLL_TIME = 0.55;
export const CAST_TIME = 0.9;
export const MELEE_TIME = 0.62;
export const HIT_TIME = 0.4;
export const BOW_SHOT_TIME = 0.7;
/** Share of the thigh's rotation the cloth followers take (capes / robes / skirts, see models/glb.ts remapClothWeights). */
export const CLOTH_FOLLOW = 0.35;
/** How fast (1/s) the cloth followers catch up with their target (a little trailing motion). */
export const CLOTH_RATE = 14;
/** Share of the way the cloth followers swing back toward hanging straight down (gravity). */
export const CLOTH_GRAVITY = 0.5;
/** Seated on a mount: the followers drape along the raised thighs and bent shins (more follow, less hang). */
export const CLOTH_FOLLOW_RIDE = 0.55;
export const CLOTH_GRAVITY_RIDE = 0.3;

export interface GlbAnimInput {
  dt: number;
  /** horizontal speed (m/s) */
  speed: number;
  /** travel direction in the character frame (x = right, z = forward), zero when idle */
  moveX: number;
  moveZ: number;
  /** aim pitch (rad, + = up) */
  pitch: number;
  flags: number;
  hold: HoldStyle;
  mounted: boolean;
  /** melee attack of the held weapon: overhead swing (clubs, hammers, glaives) or thrust (spears, guns) */
  meleeStyle: 'heavy' | 'thrust';
  /** showcase idle: weapon at low ready unless aiming down the sights (VF_ADS) */
  lowReady?: boolean;
  /** clip availability (fallback chains) */
  has(id: ClipId): boolean;
  /** authored ground speed (m/s at this character's scale) of a locomotion slot, 0 = unknown */
  natSpeed(slot: LowerSlot): number;
  /** travel direction of the in-place crawl clip in the character frame (rad, 0 = forward, π = backwards) */
  crawlHeading: number;
}

export interface GlbAnimMemory {
  back: boolean;
  deadT: number;
  downT: number;
  rollT: number;
  rollYaw: number;
  rollRev: boolean;
  prevDodge: boolean;
  /** downed and has started crawling (stays prone until revived) */
  crawled: boolean;
  crawlYaw: number;
  castT: number;
  meleeT: number;
  meleeStyle: 'heavy' | 'thrust';
  hitT: number;
  shotT: number;
  recoil: number;
  fireTimer: number;
}

export const newGlbMemory = (): GlbAnimMemory => ({
  back: false,
  deadT: -1,
  downT: -1,
  rollT: -1,
  rollYaw: 0,
  rollRev: false,
  prevDodge: false,
  crawled: false,
  crawlYaw: 0,
  castT: 0,
  meleeT: 0,
  meleeStyle: 'thrust',
  hitT: 0,
  shotT: 0,
  recoil: 0,
  fireTimer: 0,
});

export interface GlbBlend {
  /** target weights per LOWER_SLOTS (sum 1) */
  lower: Float32Array;
  /** target weights per UPPER_SLOTS (overlays) */
  upper: Float32Array;
  /** weight of the lower clips' own upper bodies (1 − Σ overlays, before the hit flinch) */
  base: number;
  /** hips turn toward the travel direction (rad, + = toward the character's right) */
  warp: number;
  /** whole-body turn (roll / crawl heading, rad) */
  bodyYaw: number;
  /** 0..1: turn the torso so the weapon points along the aim */
  aim: number;
  /** 0..1: counter-turn the chest against the hips warp */
  face: number;
  /** slots restarted this frame: bit i = lower slot i, bit 16 + j = upper slot j */
  start: number;
  weaponVisible: boolean;
  /** global clip rate: 0 frozen, slowed when stunned */
  timeScale: number;
  /** recoil impulse 0..1.5 */
  recoil: number;
  /** hit flinch 0..1 */
  flinch: number;
  stun: number;
  /** run the aimed-pose left-hand IK */
  leftHandIk: boolean;
  /** 0..1: weapon lowered to a low-ready carry (sprinting) instead of following the aim pitch */
  lowered: number;
}

export const newGlbBlend = (): GlbBlend => ({
  lower: new Float32Array(LOWER_SLOTS.length),
  upper: new Float32Array(UPPER_SLOTS.length),
  base: 1,
  warp: 0,
  bodyYaw: 0,
  aim: 0,
  face: 0,
  start: 0,
  weaponVisible: false,
  timeScale: 1,
  recoil: 0,
  flinch: 0,
  stun: 0,
  leftHandIk: false,
  lowered: 0,
});

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smooth01 = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrapAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

/** Events: set one-shot timers (called by the view on shot / melee / cast / hit events). */
export function glbFire(mem: GlbAnimMemory, strength = 1): void {
  mem.recoil = Math.min(1.5, mem.recoil + strength);
  mem.shotT = BOW_SHOT_TIME;
}
export function glbMelee(mem: GlbAnimMemory, style: 'heavy' | 'thrust'): void {
  mem.meleeT = MELEE_TIME;
  mem.meleeStyle = style;
}
export function glbCast(mem: GlbAnimMemory): void {
  mem.castT = CAST_TIME;
}
export function glbHit(mem: GlbAnimMemory): void {
  mem.hitT = HIT_TIME;
}

/**
 * PURE: advance the one-shot timers and compute this frame's target blend.
 * Deterministic for a given (input, memory) — see tests/unit/render/glbAnim.test.ts.
 */
export function glbBlend(inp: GlbAnimInput, mem: GlbAnimMemory, out: GlbBlend): void {
  const dt = clamp(inp.dt, 0, 0.1);
  const f = inp.flags;
  const lo = out.lower;
  const up = out.upper;
  lo.fill(0);
  up.fill(0);
  out.start = 0;
  const dead = (f & VF_DEAD) !== 0;
  const downed = !dead && (f & VF_DOWNED) !== 0;
  const dance = !dead && !downed && (f & VF_DANCING) !== 0;
  const mounted = inp.mounted && !dead && !downed;
  const dodge = (f & VF_DODGING) !== 0 && !dead && !downed && !mounted;
  const air = (f & VF_AIRBORNE) !== 0 && !mounted && !dead && !downed;
  const moving = inp.speed > 0.25 && (inp.moveX !== 0 || inp.moveZ !== 0);
  const travel = moving ? Math.atan2(inp.moveX, inp.moveZ) : 0;
  const armed = inp.hold !== 'none';

  // ── timers ───────────────────────────────────────────────────────────────
  const hadCast = mem.castT > 0;
  const hadMelee = mem.meleeT > 0;
  const hadHit = mem.hitT > 0;
  mem.castT = Math.max(0, mem.castT - dt);
  mem.meleeT = Math.max(0, mem.meleeT - dt);
  mem.hitT = Math.max(0, mem.hitT - dt);
  mem.shotT = Math.max(0, mem.shotT - dt);
  if ((f & VF_FIRING) !== 0 && !dead && !downed) {
    // firing flag without explicit shot events → synthesise recoil pulses
    mem.fireTimer -= dt;
    if (mem.fireTimer <= 0) {
      mem.recoil = Math.min(1.5, mem.recoil + 0.6);
      mem.fireTimer = 0.11;
    }
  } else mem.fireTimer = 0;
  mem.recoil = Math.max(0, mem.recoil - dt * 9 * Math.max(0.3, mem.recoil));
  if (dead) {
    if (mem.deadT < 0) {
      mem.deadT = 0;
      out.start |= 1 << L.death;
    } else mem.deadT += dt;
  } else mem.deadT = -1;
  if (downed) {
    if (mem.downT < 0) {
      mem.downT = 0;
      out.start |= 1 << L.knockdown;
    } else mem.downT += dt;
  } else {
    mem.downT = -1;
    mem.crawled = false;
  }
  // dodge roll: rising edge of VF_DODGING, then the roll plays to its end
  if (dodge && !mem.prevDodge && inp.has('roll')) {
    mem.rollT = 0;
    mem.rollYaw = moving ? travel : Math.PI; // no input: the sim dodges backwards
    mem.rollRev = Math.abs(mem.rollYaw) > (120 * Math.PI) / 180;
    out.start |= 1 << L.roll;
  } else if (mem.rollT >= 0) {
    // the travel direction settles during the first frames (smoothed velocity)
    if (moving && mem.rollT < 0.25) {
      mem.rollYaw = travel;
      mem.rollRev = Math.abs(travel) > (120 * Math.PI) / 180;
    }
    mem.rollT += dt / ROLL_TIME;
    if (mem.rollT >= 1 || dead || downed || mounted) mem.rollT = -1;
  }
  mem.prevDodge = dodge;
  const rolling = mem.rollT >= 0;
  if (moving) {
    const a = Math.abs(travel);
    if (!mem.back && a > BACK_ENTER) mem.back = true;
    else if (mem.back && a < BACK_EXIT) mem.back = false;
  }

  // ── lower body ───────────────────────────────────────────────────────────
  out.warp = 0;
  out.bodyYaw = 0;
  let full = false; // full-body state: the lower clip also drives the upper body
  if (dead) {
    full = true;
    if (inp.has('death')) lo[L.death] = 1;
    else if (inp.has('knockdown')) lo[L.knockdown] = 1;
    else lo[L.idle] = 1;
  } else if (downed) {
    full = true;
    // fall (knockdown), then — once the hero starts to move — roll over and crawl
    // head first (the backwards crawl clip played in reverse); it stays prone after
    if (moving && inp.has('crawl')) {
      mem.crawled = true;
      mem.crawlYaw = wrapAngle(travel - inp.crawlHeading - Math.PI);
    }
    if (mem.crawled && inp.has('crawl')) {
      lo[L.crawl] = 1;
      out.bodyYaw = mem.crawlYaw;
    } else if (inp.has('knockdown')) lo[L.knockdown] = 1;
    else if (inp.has('death')) lo[L.death] = 1;
    else lo[L.idle] = 1;
  } else if (dance && inp.has('dance')) {
    full = true;
    lo[L.dance] = 1;
  } else if (mounted && inp.has('sit')) {
    lo[L.sit] = 1;
  } else if (rolling) {
    full = true;
    lo[L.roll] = 1;
    out.bodyYaw = mem.rollRev ? wrapAngle(mem.rollYaw - Math.PI) : mem.rollYaw;
  } else if (air && inp.has('jump')) {
    lo[L.jump] = 1;
  } else {
    const mv = smooth01(0.15, 0.6, inp.speed);
    const sprint = (f & VF_SPRINTING) !== 0 && inp.speed > 2 && inp.has('sprint');
    let gait: LowerSlot = 'run';
    let warp = 0;
    if (sprint) {
      gait = 'sprint';
      warp = clamp(travel, -0.8, 0.8);
    } else if (mem.back) {
      gait = inp.speed < WALK_BACK_MAX && inp.has('walkBack') ? 'walkBack' : 'runRev';
      warp = clamp(wrapAngle(travel - Math.PI * Math.sign(travel || 1)), -WARP_MAX, WARP_MAX);
    } else warp = clamp(travel, -WARP_MAX, WARP_MAX);
    const nat = inp.natSpeed(gait);
    const stride = nat > 0 ? clamp(inp.speed / (nat * FULL_STRIDE_FROM), MIN_STRIDE, 1) : 1;
    lo[L[gait]] = mv * stride;
    // shorter strides: blend toward the gait's mean pose (the idle stance when that is missing)
    if (gait !== 'walkBack' && inp.has('runMean')) {
      lo[L.stride] = mv * (1 - stride);
      lo[L.idle] = 1 - mv;
    } else lo[L.idle] = 1 - mv * stride;
    out.warp = moving ? warp : 0;
  }

  // ── upper body ───────────────────────────────────────────────────────────
  let main: UpperSlot | null = null;
  const sprinting = (f & VF_SPRINTING) !== 0 && inp.speed > 2 && !mounted;
  if (!full && armed) {
    if (inp.hold === 'bow') main = inp.has('bow') ? 'bow' : 'aim';
    else main = 'aim';
    // sprinting: the same hold, weapon lowered (the aim solve points it down-forward)
    if ((f & VF_RELOADING) !== 0 && inp.hold !== 'bow' && inp.has('reload')) main = 'reload';
    if ((f & VF_CHANNELING) !== 0 && inp.has('reload')) main = 'reload';
    if (inp.hold === 'bow' && mem.shotT > 0 && inp.has('bowShot')) main = 'bowShot';
  }
  if (!full && mem.castT > 0 && inp.has('cast')) {
    main = 'cast';
    if (!hadCast || mem.castT > CAST_TIME - dt - 1e-6) out.start |= 1 << (16 + U.cast);
  }
  if (!full && mem.meleeT > 0) {
    const slot: UpperSlot = mem.meleeStyle === 'heavy' ? 'meleeHeavy' : 'meleeThrust';
    const alt: UpperSlot = slot === 'meleeHeavy' ? 'meleeThrust' : 'meleeHeavy';
    const pick = inp.has(SLOT_CLIP[slot]) ? slot : inp.has(SLOT_CLIP[alt]) ? alt : null;
    if (pick) {
      main = pick;
      if (!hadMelee || mem.meleeT > MELEE_TIME - dt - 1e-6) out.start |= 1 << (16 + U[pick]);
    }
  }
  if (main === 'aim' && !inp.has('aim')) main = null;
  if (main) up[U[main]] = 1;
  out.base = main ? 0 : 1;
  // hit flinch: a partial overlay on whatever the upper body does
  out.flinch = full ? 0 : mem.hitT / HIT_TIME;
  if (!full && mem.hitT > 0 && inp.has('hit')) {
    up[U.hit] = 0.5 * out.flinch;
    if (!hadHit || mem.hitT > HIT_TIME - dt - 1e-6) out.start |= 1 << (16 + U.hit);
  }
  if (main === 'bowShot' && mem.shotT > BOW_SHOT_TIME - dt - 1e-6) out.start |= 1 << (16 + U.bowShot);

  out.aim = main === 'aim' || main === 'bow' || main === 'bowShot' ? 1 : 0;
  out.lowered = main === 'aim' && (sprinting || (inp.lowReady === true && (f & VF_ADS) === 0 && (f & VF_FIRING) === 0)) ? 1 : 0;
  out.face = full ? 0 : 1;
  // (a pistol's support hand cups the grip; akimbo's holds the second gun)
  out.leftHandIk = main === 'aim' && inp.hold !== 'akimbo' && inp.hold !== 'sword';
  out.weaponVisible = armed && !dead && !downed && !dance;
  out.stun = (f & VF_STUNNED) !== 0 && !dead ? 1 : 0;
  out.timeScale = (f & VF_FROZEN) !== 0 ? 0 : out.stun ? 0.35 : 1;
  out.recoil = mem.recoil;
}

// ── mixer driver ─────────────────────────────────────────────────────────────

/** What the animator needs to know about the held weapon (from GlbBody). */
export interface GlbWeaponAttach {
  /** hand the weapon is parented to */
  hand: 'RightHand' | 'LeftHand';
  /** barrel direction (−Z of the weapon) in that hand bone's frame (unit) */
  dirInHand: THREE.Vector3;
  /** foregrip (left-hand IK target; bows: the drawing hand's, on the string) in the hand bone's frame, model units; null = none */
  foreInHand: THREE.Vector3 | null;
  /** the weapon's origin (its grip) in the hand bone's frame, model units: where the support hand slides back to */
  originInHand: THREE.Vector3;
  /** weapon rotation in the hand bone's frame (the holds that place the weapon themselves, GLB_HOLD_POSES) */
  grip: THREE.Quaternion;
  /** akimbo: the left gun's rotation in the left hand's frame; else null */
  gripL: THREE.Quaternion | null;
}

/**
 * Holds that place the weapon themselves instead of turning the aimed-rifle
 * clip's arms onto the aim (the rifle / bow holds): the chest squares to the
 * aim (or turns to a bladed stance), the weapon hand goes to a target in front
 * of the shoulders (arm IK with the elbow toward a pole), the weapon is turned
 * along the aim, and the left hand takes the foregrip (the pistol's cups the
 * grip; akimbo's holds its own gun, mirrored). Like the procedural rig's
 * HOLD_POSES (anim/animator.ts).
 */
export interface GlbHoldPose {
  /** weapon hand (the grip, the weapon's origin) from the shoulders' midpoint (m): x right, y up, z forward, at a level aim */
  hand: readonly [number, number, number];
  /** weapon pitch above the aim (rad): a staff's tip up */
  tilt: number;
  /** share of the aim pitch that swings the hand about the shoulders (the weapon itself follows the whole pitch) */
  swing: number;
  /** chest yaw from square to the aim (rad, + = the right shoulder back, the left one forward: a bladed stance) */
  blade: number;
  /** share of the aim pitch the spine bends (the arms take the rest) */
  spine: number;
  /** weapon arm's elbow direction (x right, y up, z forward) */
  elbow: readonly [number, number, number];
  /**
   * the lowered carry (sprinting, the showcase idle of portraits / the gallery):
   * the hand target (same frame) and the weapon's pitch (rad) — instead of the
   * aimed pose swung down to the low-ready pitch
   */
  low: { hand: readonly [number, number, number]; pitch: number };
}

export const GLB_HOLD_POSES: Partial<Record<HoldStyle, GlbHoldPose>> = {
  // isosceles two-handed grip: arms forward, the gun on the midline at chin height;
  // lowered: compressed ready, the gun at the belly pointing down-forward
  pistol: { hand: [0.05, -0.08, 0.44], tilt: 0, swing: 1, blade: 0, spine: 0.4, elbow: [0.7, -1, -0.1], low: { hand: [0.06, -0.32, 0.3], pitch: -0.6 } },
  // a gun in each hand, side by side 0.34 m apart; lowered: down-forward at the sides
  akimbo: { hand: [0.17, -0.09, 0.42], tilt: 0, swing: 1, blade: 0, spine: 0.4, elbow: [0.9, -1, -0.1], low: { hand: [0.18, -0.36, 0.26], pitch: -0.7 } },
  // Two-handed holds keep the grip close to the body and the chest well bladed (the left
  // shoulder forward): the models' arms reach ~0.46 m, so the support hand gets to a
  // foregrip ~0.2–0.35 m ahead of the grip (farther ones: it slides back, leftHandIk).
  // flamers / LMGs from the hip: the stock under the forearm by the right hip
  hip: { hand: [0.16, -0.28, 0.12], tilt: 0, swing: 0.45, blade: 0.9, spine: 0.3, elbow: [0.4, -0.3, -1], low: { hand: [0.16, -0.3, 0.1], pitch: -0.35 } },
  // launchers on the right shoulder, the tube beside the head; lowered: still shouldered, the muzzle down a little
  launcher: { hand: [0.18, 0.0, 0.12], tilt: 0, swing: 1, blade: 0.6, spine: 0.4, elbow: [0.3, -1, 0.3], low: { hand: [0.18, -0.04, 0.1], pitch: -0.3 } },
  // staves / spears at the right hip, the shaft along the aim with the tip a little up, the
  // left hand forward on it; lowered: carried at port, the tip high across the chest
  pole: { hand: [0.17, -0.28, 0.08], tilt: 0.3, swing: 0.45, blade: 0.9, spine: 0.3, elbow: [0.4, -0.3, -1], low: { hand: [0.17, -0.3, 0.16], pitch: 0.7 } },
};

/**
 * PURE: a hold's weapon-hand target (m, armature axes: +X = the model's left,
 * +Y up, +Z forward; from the shoulders' midpoint) and the weapon direction
 * for an aim pitch, blended toward the hold's lowered carry by `lowered`
 * (0..1). side −1 = the left hand (akimbo), mirrored.
 */
export function glbHoldTarget(pose: GlbHoldPose, pitch: number, lowered: number, side: 1 | -1, outHand: THREE.Vector3, outDir: THREE.Vector3): void {
  const a = pitch * pose.swing;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 - lowered;
  const x = pose.hand[0] * k + pose.low.hand[0] * lowered;
  const y0 = pose.hand[1];
  const z0 = pose.hand[2];
  const y = (y0 * c + z0 * s) * k + pose.low.hand[1] * lowered;
  const z = (z0 * c - y0 * s) * k + pose.low.hand[2] * lowered;
  outHand.set(-x * side, y, z);
  const d = (pitch + pose.tilt) * k + pose.low.pitch * lowered;
  outDir.set(0, Math.sin(d), Math.cos(d));
}

export interface GlbFrameInput extends Omit<GlbAnimInput, 'has' | 'natSpeed' | 'crawlHeading'> {
  /** saddle height (m, rig-root space) when mounted, else 0; plus its bob */
  mountHip: number;
  mountBob: number;
  /** held weapon's reload time (s), for the reload clip's rate */
  reloadTime: number;
}

type Bones = Partial<Record<string, THREE.Bone>>;

const SPINE = ['Spine02', 'Spine01', 'Spine'] as const;
/** Share of the torso solves taken by each spine joint. */
const SPINE_SHARE = [0.3, 0.3, 0.4];
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DOWN_AXIS = new THREE.Vector3(0, -1, 0);
const RIGHT_AXIS = new THREE.Vector3(-1, 0, 0); // the model's right in armature space (it faces +Z)
const FWD_AXIS = new THREE.Vector3(0, 0, 1);

// scratch (no per-frame allocation)
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _pC = new THREE.Vector3();
const _pT = new THREE.Vector3();
const _pD = new THREE.Vector3();
const _pO = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _hold = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _xW = new THREE.Vector3();
const _yW = new THREE.Vector3();
const _zW = new THREE.Vector3();
const _mW = new THREE.Matrix4();
const _qW = new THREE.Quaternion();
/** Joint names per side (no per-frame string building). */
const LIMB = {
  Left: { shoulder: 'LeftShoulder', arm: 'LeftArm', fore: 'LeftForeArm', hand: 'LeftHand', upLeg: 'LeftUpLeg', leg: 'LeftLeg', foot: 'LeftFoot', toe: 'LeftToeBase' },
  Right: { shoulder: 'RightShoulder', arm: 'RightArm', fore: 'RightForeArm', hand: 'RightHand', upLeg: 'RightUpLeg', leg: 'RightLeg', foot: 'RightFoot', toe: 'RightToeBase' },
} as const;
const _kneeT = new THREE.Vector3();
const _ankleT = new THREE.Vector3();
const _nA = new THREE.Vector3();
const _nB = new THREE.Vector3();
const _dA = new THREE.Vector3();
const _qRide = new THREE.Quaternion();
const _gW = new THREE.Vector3();
const _chainQ = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _chainP = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

export class GlbAnimator {
  readonly mixer: THREE.AnimationMixer;
  readonly mem = newGlbMemory();
  readonly blend = newGlbBlend();
  private readonly tpl: CharTemplate;
  private readonly bones: Bones;
  /** smoothed weights */
  private readonly wLo = new Float32Array(LOWER_SLOTS.length);
  private readonly wUp = new Float32Array(UPPER_SLOTS.length);
  private wBase = 1;
  private readonly actLo: (THREE.AnimationAction | null | undefined)[] = [];
  private readonly actLoUp: (THREE.AnimationAction | null | undefined)[] = [];
  private readonly actUp: (THREE.AnimationAction | null | undefined)[] = [];
  private readonly clips = new Map<ClipId, ModelClip | null>();
  /** gait phase 0..1 over the authored cycle, advanced by distance */
  private phase = 0;
  private warp = 0;
  private bodyYaw = 0;
  private aimW = 0;
  private faceW = 1;
  private recoilPitch = 0;
  private lowered = 0;
  private time = 0;
  /** model units → metres at this instance's scale (template.unit × normalisation scale) */
  private readonly unitM: number;
  private readonly hipsRest: THREE.Vector3;
  /** input adapter for the pure blend (reused) */
  private readonly inp: GlbAnimInput;
  /** cloth followers (left, right), their thighs and rest rotations; empty when the model has none */
  private readonly cloth: { bone: THREE.Bone; thigh: THREE.Bone; rest: THREE.Quaternion }[] = [];
  private clothSettled = false;

  constructor(tpl: CharTemplate, root: THREE.Object3D, bones: Bones, unitM: number) {
    this.tpl = tpl;
    this.bones = bones;
    this.unitM = unitM;
    this.mixer = new THREE.AnimationMixer(root);
    this.hipsRest = (tpl.rest.get('Hips')?.p ?? new THREE.Vector3()).clone();
    for (const side of ['Left', 'Right'] as const) {
      const bone = bones[CLOTH_BONES[side]];
      const thigh = bones[`${side}UpLeg`];
      const rest = tpl.rest.get(CLOTH_BONES[side])?.q;
      if (bone && thigh && rest) this.cloth.push({ bone, thigh, rest });
    }
    const self = this;
    this.inp = {
      dt: 0,
      speed: 0,
      moveX: 0,
      moveZ: 0,
      pitch: 0,
      flags: 0,
      hold: 'none',
      mounted: false,
      meleeStyle: 'thrust',
      has: (id) => self.clip(id) !== null,
      natSpeed: (slot) => self.natSpeed(slot),
      crawlHeading: Math.PI,
    };
  }

  private clip(id: ClipId): ModelClip | null {
    let c = this.clips.get(id);
    if (c === undefined) {
      c = modelClip(this.tpl, id);
      // not loaded yet (undefined in the library) stays uncached so it is picked up later
      if (c) this.clips.set(id, c);
    }
    return c ?? null;
  }

  /** Authored speed (m/s at this scale) of a locomotion slot. */
  natSpeed(slot: LowerSlot): number {
    const c = this.clip(SLOT_CLIP[slot]);
    return c?.gait ? (c.gait.speed / (this.tpl.unit || 0.01)) * this.unitM : 0;
  }

  /** Stride length (m) of one authored clip loop of a locomotion slot. */
  private strideLen(slot: LowerSlot): number {
    const c = this.clip(SLOT_CLIP[slot]);
    if (!c) return 1;
    const v = this.natSpeed(slot);
    return v > 0 ? v * c.duration : 1;
  }

  private action(kind: 'lo' | 'loUp' | 'up', i: number): THREE.AnimationAction | null {
    const arr = kind === 'lo' ? this.actLo : kind === 'loUp' ? this.actLoUp : this.actUp;
    const cached = arr[i];
    if (cached !== undefined) return cached;
    const slot = kind === 'up' ? UPPER_SLOTS[i] : LOWER_SLOTS[i];
    const c = this.clip(SLOT_CLIP[slot]);
    if (!c) return null; // unavailable (or loading): not cached
    // slots sharing a clip (run / runRev) need their own clip objects → own actions
    let clip = kind === 'lo' ? c.lower : c.upper;
    const alias = slot === 'runRev';
    if (alias) clip = new THREE.AnimationClip(`${clip.name}:${slot}`, clip.duration, clip.tracks);
    const a = this.mixer.clipAction(clip);
    const spec = CLIP_SPECS[c.id];
    if (!spec.loop) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    }
    arr[i] = a;
    return a;
  }

  // events
  fire(strength = 1): void {
    glbFire(this.mem, strength);
  }
  melee(style: 'heavy' | 'thrust'): void {
    glbMelee(this.mem, style);
  }
  cast(): void {
    glbCast(this.mem);
  }
  hit(): void {
    glbHit(this.mem);
  }

  get weaponVisible(): boolean {
    return this.blend.weaponVisible;
  }

  /** Advance, blend and pose. `attach` = held weapon (null = unarmed). */
  update(fi: GlbFrameInput, attach: GlbWeaponAttach | null): void {
    const dt = clamp(fi.dt, 0, 0.2);
    this.time += dt;
    const inp = this.inp;
    inp.dt = dt;
    inp.speed = fi.speed;
    inp.moveX = fi.moveX;
    inp.moveZ = fi.moveZ;
    inp.pitch = fi.pitch;
    inp.flags = fi.flags;
    inp.hold = fi.hold;
    inp.mounted = fi.mounted;
    inp.meleeStyle = fi.meleeStyle;
    inp.lowReady = fi.lowReady;
    const crawl = this.clip('crawl');
    inp.crawlHeading = crawl?.gait ? Math.atan2(-crawl.gait.dirX, crawl.gait.dirZ) : Math.PI;
    const b = this.blend;
    glbBlend(inp, this.mem, b);

    // ── weights: linear ramps, then normalised per layer ─────────────────
    const fast = (b.start & ((1 << L.death) | (1 << L.roll) | (1 << L.knockdown))) !== 0 || (b.lower[L.roll] > 0 && this.wLo[L.roll] < 1);
    const stepLo = dt / (fast ? CROSSFADE_FAST : CROSSFADE);
    let sumLo = 0;
    for (let i = 0; i < this.wLo.length; i++) {
      const tgt = b.lower[i];
      const w = this.wLo[i];
      this.wLo[i] = w < tgt ? Math.min(tgt, w + stepLo) : Math.max(tgt, w - stepLo);
      sumLo += this.wLo[i];
    }
    const stepUp = dt / CROSSFADE_FAST;
    const stepUpSlow = dt / CROSSFADE;
    for (let i = 0; i < this.wUp.length; i++) {
      const tgt = b.upper[i];
      const w = this.wUp[i];
      const st = i === U.aim || i === U.bow ? stepUpSlow : stepUp;
      this.wUp[i] = w < tgt ? Math.min(tgt, w + st) : Math.max(tgt, w - st);
    }
    this.wBase = this.wBase < b.base ? Math.min(b.base, this.wBase + stepUpSlow) : Math.max(b.base, this.wBase - stepUpSlow);
    let sumUp = this.wBase;
    for (let i = 0; i < this.wUp.length; i++) sumUp += this.wUp[i];
    const nLo = sumLo > 1e-4 ? 1 / sumLo : 0;
    const nUp = sumUp > 1e-4 ? 1 / sumUp : 0;

    // ── gait phase (distance-driven, shared by every locomotion slot) ─────
    // stride = the blended authored stride × the amplitude left after the idle / mean-pose blend
    let strideW = 0;
    let strideSum = 0;
    for (let k = 0; k < PHASE_SLOTS.length; k++) {
      const s = PHASE_SLOTS[k];
      const w = this.wLo[L[s]];
      if (w > 1e-3) {
        strideSum += w * this.strideLen(s);
        strideW += w;
      }
    }
    if (strideW > 0 && b.timeScale > 0) {
      const amp = Math.max(MIN_STRIDE, strideW * nLo);
      this.phase = (this.phase + (fi.speed * dt * b.timeScale) / Math.max(0.2, (amp * strideSum) / strideW)) % 1;
    }

    // ── actions ───────────────────────────────────────────────────────────
    const mixer = this.mixer;
    for (let i = 0; i < LOWER_SLOTS.length; i++) {
      const slot = LOWER_SLOTS[i];
      const w = this.wLo[i] * nLo;
      const restart = (b.start & (1 << i)) !== 0;
      this.drive(this.action('lo', i), w, restart, slot, fi);
      this.drive(this.action('loUp', i), w * this.wBase * nUp, restart, slot, fi);
    }
    for (let i = 0; i < UPPER_SLOTS.length; i++) {
      const slot = UPPER_SLOTS[i];
      const restart = (b.start & (1 << (16 + i))) !== 0;
      this.drive(this.action('up', i), this.wUp[i] * nUp, restart, slot, fi);
    }
    mixer.timeScale = b.timeScale;
    mixer.update(dt);

    this.post(fi, attach, dt);
  }

  /** Weight / time control of one action. */
  private drive(a: THREE.AnimationAction | null, w: number, restart: boolean, slot: LowerSlot | UpperSlot, fi: GlbFrameInput): void {
    if (!a) return;
    if (w < 1e-3 && !restart) {
      if (a.isRunning() || a.enabled) {
        a.stop();
        a.enabled = false;
      }
      return;
    }
    if (restart || !a.isRunning()) {
      if (restart) a.reset();
      a.enabled = true;
      a.play();
    }
    a.setEffectiveWeight(w);
    const dur = a.getClip().duration;
    switch (slot) {
      case 'run':
      case 'sprint':
      case 'walkBack': {
        // phase-synced: every gait's left-foot plant at the same phase
        const c = this.clip(SLOT_CLIP[slot]);
        const off = c?.gait ? c.gait.phase0 / c.duration : 0;
        a.timeScale = 0;
        a.time = ((this.phase + off) % 1) * dur;
        break;
      }
      case 'runRev': {
        const c = this.clip('run');
        const off = c?.gait ? c.gait.phase0 / c.duration : 0;
        a.timeScale = 0;
        a.time = ((1 - this.phase + off) % 1) * dur;
        break;
      }
      case 'jump': {
        a.timeScale = 0;
        a.time = Math.min(dur, JUMP_HOLD);
        break;
      }
      case 'roll': {
        const rev = this.mem.rollRev;
        const p = clamp(this.mem.rollT, 0, 1);
        a.timeScale = 0;
        a.time = (rev ? 1 - p : p) * dur;
        break;
      }
      case 'crawl': {
        // reversed (head first), paused while the downed hero lies still
        const moving = fi.speed > 0.25;
        a.timeScale = moving ? -clamp(fi.speed / 0.5, 0.4, 2.5) : 0;
        break;
      }
      case 'reload': {
        a.timeScale = (fi.flags & VF_CHANNELING) !== 0 ? 0.8 : clamp(dur / Math.max(0.3, fi.reloadTime), 0.8, 3);
        break;
      }
      case 'cast':
        a.timeScale = dur / CAST_TIME;
        break;
      case 'meleeHeavy':
      case 'meleeThrust':
        a.timeScale = dur / MELEE_TIME;
        break;
      case 'hit':
        a.timeScale = dur / HIT_TIME;
        break;
      case 'bowShot':
        a.timeScale = dur / BOW_SHOT_TIME;
        break;
      default:
        a.timeScale = 1;
    }
  }

  // ── post-process ─────────────────────────────────────────────────────────

  private post(fi: GlbFrameInput, attach: GlbWeaponAttach | null, dt: number): void {
    const bones = this.bones;
    const hips = bones.Hips;
    if (!hips) return;
    const b = this.blend;
    const k = 1 - Math.exp(-dt * 12);
    this.warp += (b.warp - this.warp) * k;
    // body yaw: snap-free but quick (rolls turn within a few frames)
    this.bodyYaw += wrapAngle(b.bodyYaw - this.bodyYaw) * (1 - Math.exp(-dt * 20));
    this.aimW += (b.aim - this.aimW) * (1 - Math.exp(-dt * 10));
    this.faceW += (b.face - this.faceW) * k;
    this.lowered += (b.lowered - this.lowered) * (1 - Math.exp(-dt * 8));
    this.recoilPitch = b.recoil;

    // 1. hips: turn toward the travel direction / roll heading (about the vertical)
    // warp + is toward the character's right = −X in armature space = a negative turn about +Y
    const hipsYaw = -(this.warp + this.bodyYaw);
    if (Math.abs(hipsYaw) > 1e-4) {
      _q.setFromAxisAngle(Y_AXIS, hipsYaw);
      hips.quaternion.premultiply(_q);
    }
    // mount: hips at the saddle (bouncing a little more than it), legs astride (IK to the stirrups)
    const mountW = this.wLo[L.sit];
    const ride = mountW > 1e-3 && fi.mountHip > 0 ? RIDE_POSE[rideKindOf(fi.mountHip)] : null;
    if (ride) {
      // metres in the rig-root frame → model units (the clone's Armature space)
      const saddle = (fi.mountHip + fi.mountBob * (1 + ride.bounce)) / this.unitM;
      hips.position.y += (saddle - hips.position.y) * mountW;
      hips.position.x += (this.hipsRest.x - hips.position.x) * mountW;
      hips.position.z += (this.hipsRest.z - 0.06 / this.unitM - hips.position.z) * mountW;
      this.rideLeg(ride, 1, fi.mountBob, mountW);
      this.rideLeg(ride, -1, fi.mountBob, mountW);
      // a nod with each stride (the aim solve below keeps the weapon on target)
      this.rotateWorld(bones.Spine02, 'Hips', RIGHT_AXIS, -ride.lean * fi.mountBob * mountW);
    }

    // 2. torso: keep the chest on the aim yaw (counter the hips turn), then aim the weapon
    const counter = -hipsYaw * this.faceW;
    if (Math.abs(counter) > 1e-4) {
      for (let i = 0; i < SPINE.length; i++) this.rotateWorld(bones[SPINE[i]], i === 0 ? 'Hips' : SPINE[i - 1], Y_AXIS, counter * SPINE_SHARE[i]);
    }
    if (attach && this.aimW > 1e-3 && b.weaponVisible) {
      const aimPitch = clamp(fi.pitch, -1.3, 1.3) + 0.12 * this.recoilPitch;
      const pitch = aimPitch * (1 - this.lowered) + LOW_READY_PITCH * this.lowered;
      let spinePitch = 0;
      // holds that place the weapon themselves (while the aim slot plays)
      const hold = this.wUp[U.aim] > 1e-3 ? GLB_HOLD_POSES[fi.hold] : undefined;
      if (hold) {
        // (the lowered carry keeps the chest upright)
        spinePitch = this.squareChest(hold, aimPitch * (1 - this.lowered));
        this.holdArms(hold, attach, aimPitch, this.lowered, this.wUp[U.aim] * this.aimW, fi.hold === 'akimbo');
      }
      for (let iter = 0; iter < (hold ? 0 : 3); iter++) {
        this.weaponDir(attach, _v);
        const yawErr = wrapAngle(-Math.atan2(_v.x, _v.z)) * this.aimW;
        const pitchErr = (pitch - Math.asin(clamp(_v.y, -1, 1))) * this.aimW;
        // the torso bends up to its limits, the arms (both, about the shoulders) take the rest:
        // a lowered weapon keeps the chest upright, a steep aim does not fold the spine
        const sp = clamp(pitchErr, -SPINE_PITCH_DOWN - spinePitch, SPINE_PITCH_UP - spinePitch);
        spinePitch += sp;
        for (let i = 0; i < SPINE.length; i++) {
          const parent = i === 0 ? 'Hips' : SPINE[i - 1];
          this.rotateWorld(bones[SPINE[i]], parent, Y_AXIS, yawErr * SPINE_SHARE[i]);
          this.rotateWorld(bones[SPINE[i]], parent, RIGHT_AXIS, sp * SPINE_SHARE[i]);
        }
        const armP = pitchErr - sp;
        if (Math.abs(armP) > 1e-4) {
          this.rotateWorld(bones.RightArm, 'RightShoulder', RIGHT_AXIS, armP);
          this.rotateWorld(bones.LeftArm, 'LeftShoulder', RIGHT_AXIS, armP);
        }
      }
      // weapon lowered: the head keeps looking ahead
      if (this.lowered > 0.01 && spinePitch < 0) this.rotateWorld(bones.Head, 'neck', RIGHT_AXIS, -spinePitch * 0.8 * this.lowered);
    } else if (this.faceW > 1e-3) {
      // unarmed / melee: the head follows the aim pitch a little
      this.rotateWorld(bones.Spine, 'Spine01', RIGHT_AXIS, clamp(fi.pitch, -1, 1) * 0.35 * this.faceW);
    }
    // recoil kick + hit flinch + stun wobble (torso)
    const kick = 0.05 * this.recoilPitch + 0.16 * b.flinch;
    if (kick > 1e-4) this.rotateWorld(bones.Spine, 'Spine01', RIGHT_AXIS, kick);
    if (b.stun > 0) {
      const t = this.time;
      this.rotateWorld(bones.Spine01, 'Spine02', FWD_AXIS, Math.sin(t * 2.3) * 0.08);
      this.rotateWorld(bones.Head, 'neck', RIGHT_AXIS, -0.25 + Math.sin(t * 3.1) * 0.1);
    }

    // 3. left hand on the foregrip; a bow's drawing hand on the string
    if (attach && attach.foreInHand && b.leftHandIk && b.weaponVisible && this.wUp[U.aim] > 0.5 && this.wUp[U.reload] < 0.05) {
      this.leftHandIk(attach, this.wUp[U.aim] * this.aimW);
    }
    if (attach && attach.foreInHand && fi.hold === 'bow' && b.weaponVisible && this.wUp[U.bow] > 1e-3) {
      this.foreTarget(attach, _pT);
      this.handReach('Right', _pT, this.wUp[U.bow] * this.aimW);
    }

    // 4. cloth: a damped share of each thigh's final rotation, pulled toward
    //    hanging straight down (a bent-over or leaning body does not lift its
    //    cape into a wall), trailing slightly
    if (this.cloth.length) {
      const follow = this.clothSettled ? 1 - Math.exp(-dt * CLOTH_RATE) : 1;
      const rideW = ride ? mountW : 0;
      const share = CLOTH_FOLLOW + (CLOTH_FOLLOW_RIDE - CLOTH_FOLLOW) * rideW;
      const gravity = CLOTH_GRAVITY + (CLOTH_GRAVITY_RIDE - CLOTH_GRAVITY) * rideW;
      for (let i = 0; i < this.cloth.length; i++) {
        const c = this.cloth[i];
        _q.copy(c.rest).slerp(c.thigh.quaternion, share);
        // armature-space hang axis (the thigh's bone axis, toward the knee)
        _qa.copy(hips.quaternion).multiply(_q);
        _v.copy(Y_AXIS).applyQuaternion(_qa);
        // −_v.y = cos(angle to straight down); upside down (mid-roll) the pull fades out
        const g = gravity * smooth01(-0.85, -0.45, -_v.y);
        if (g > 1e-3) {
          _q2.setFromUnitVectors(_v, DOWN_AXIS);
          _q2.slerp(IDENTITY_Q, 1 - g);
          _qa.premultiply(_q2);
          _q.copy(hips.quaternion).invert().multiply(_qa);
        }
        c.bone.quaternion.slerp(_q, follow);
      }
      this.clothSettled = true;
    }
  }

  /**
   * Rotate a bone by `angle` about an ARMATURE-space axis (pivot at the bone):
   * local' = P⁻¹ · R · P · local, P = the parent's armature-space rotation.
   */
  private rotateWorld(bone: THREE.Bone | undefined, parentName: string, axis: THREE.Vector3, angle: number): void {
    if (!bone || Math.abs(angle) < 1e-5) return;
    this.chainQuat(parentName, _qp);
    _axis.copy(axis).applyQuaternion(_q2.copy(_qp).invert());
    _q.setFromAxisAngle(_axis, angle);
    bone.quaternion.premultiply(_q);
  }

  /** Armature-space rotation of a bone (product of the local rotations from the Hips down). */
  private chainQuat(name: string, out: THREE.Quaternion): THREE.Quaternion {
    out.identity();
    let n: THREE.Object3D | null | undefined = this.bones[name];
    // walk up to the Hips (≤ 8 joints), then multiply down
    let depth = 0;
    while (n && depth < 8) {
      _chainQ[depth].copy(n.quaternion);
      depth++;
      if (n.name === 'Hips') break;
      n = n.parent;
    }
    for (let i = depth - 1; i >= 0; i--) out.multiply(_chainQ[i]);
    return out;
  }

  /** Armature-space position of a bone (FK from the Hips). */
  private chainPos(name: string, out: THREE.Vector3): THREE.Vector3 {
    let n: THREE.Object3D | null | undefined = this.bones[name];
    let depth = 0;
    while (n && depth < 8) {
      _chainP[depth].copy(n.position);
      _chainQ[depth].copy(n.quaternion);
      depth++;
      if (n.name === 'Hips') break;
      n = n.parent;
    }
    // from the Hips down: p = p_parent + Q_parent · local_p
    out.set(0, 0, 0);
    _qa.identity();
    for (let i = depth - 1; i >= 0; i--) {
      _v2.copy(_chainP[i]).applyQuaternion(_qa);
      out.add(_v2);
      _qa.multiply(_chainQ[i]);
    }
    return out;
  }

  /**
   * Rotate a bone by the ARMATURE-space rotation `q` (pivot at the bone),
   * blended in by `w`: local' = P⁻¹ · q · P · local, P = the parent's armature rotation.
   */
  private premultiplyWorld(bone: THREE.Bone | undefined, parentName: string, q: THREE.Quaternion, w: number): void {
    if (!bone) return;
    if (w < 0.999) q.slerp(IDENTITY_Q, 1 - w);
    this.chainQuat(parentName, _qp);
    _q.copy(_qp).invert().multiply(q).multiply(_qp);
    bone.quaternion.premultiply(_q);
  }

  /**
   * One leg of a mounted rider (side +1 = left, the armature's +X): thigh and
   * shin turned so the ankle reaches the pose's target with the knee toward
   * its pole (the bend plane turned along, see ik.alignFrames), then the foot
   * turned along the pose's foot direction.
   */
  private rideLeg(pose: RidePose, side: 1 | -1, bob: number, w: number): void {
    const n = LIMB[side > 0 ? 'Left' : 'Right'];
    const foot = this.bones[n.foot];
    if (!foot) return;
    const u = this.unitM;
    // thigh + shin: the ankle to the stirrup, the knee toward the pose's pole
    _pT.set((side * pose.ankle[0]) / u, (pose.ankle[1] + bob) / u, pose.ankle[2] / u);
    _v3.set(side * pose.knee[0], pose.knee[1], pose.knee[2]);
    this.limbTo(n.upLeg, n.leg, n.foot, 'Hips', _pT, _v3, w);
    // foot: ankle → toe along the pose's foot direction (heel down, toe a little out)
    const toe = this.bones[n.toe];
    if (!toe) return;
    this.chainPos(n.foot, _pC);
    this.chainPos(n.toe, _pT);
    _v.subVectors(_pT, _pC).normalize();
    _v2.set(side * pose.foot[0], pose.foot[1], pose.foot[2]).normalize();
    _qRide.setFromUnitVectors(_v, _v2);
    this.premultiplyWorld(foot, n.leg, _qRide, w);
  }

  /** Current barrel direction in armature space. */
  private weaponDir(attach: GlbWeaponAttach, out: THREE.Vector3): THREE.Vector3 {
    this.chainQuat(attach.hand, _qb);
    return out.copy(attach.dirInHand).applyQuaternion(_qb);
  }

  /** The weapon's fore point (foregrip / bow string) in armature space. */
  private foreTarget(attach: GlbWeaponAttach, out: THREE.Vector3): THREE.Vector3 {
    this.chainPos(attach.hand, out);
    this.chainQuat(attach.hand, _qb);
    if (attach.foreInHand) out.add(_v.copy(attach.foreInHand).applyQuaternion(_qb));
    return out;
  }

  /**
   * The support hand on the foregrip — or, out of the arm's reach (a long LMG
   * from the hip, a staff: the model's short arms), as far toward it along the
   * weapon as it reaches (ik.slideToReach), so it holds the weapon instead of
   * pointing at the foregrip in mid-air.
   */
  private leftHandIk(attach: GlbWeaponAttach, w: number): void {
    if (!attach.foreInHand) return;
    this.foreTarget(attach, _pT);
    // (foreTarget left the weapon hand's armature rotation in _qb)
    this.chainPos(attach.hand, _gW).add(_v.copy(attach.originInHand).applyQuaternion(_qb));
    this.chainPos('LeftArm', _pA);
    this.chainPos('LeftForeArm', _pB);
    this.chainPos('LeftHand', _pC);
    const reach = _pA.distanceTo(_pB) + _pB.distanceTo(_pC);
    slideToReach(_pA, _gW, _pT, reach * LEFT_REACH, _pT);
    this.handReach('Left', _pT, w);
  }

  /** Two-bone reach of one arm to an armature-space target, bending in its current elbow plane. */
  private handReach(side: 'Left' | 'Right', target: THREE.Vector3, w: number): void {
    const n = LIMB[side];
    const arm = this.bones[n.arm];
    const fore = this.bones[n.fore];
    if (!arm || !fore || !this.bones[n.hand]) return;
    _pD.copy(target);
    this.chainPos(n.arm, _pA);
    this.chainPos(n.fore, _pB);
    this.chainPos(n.hand, _pC);
    const qRoot = _ikRoot;
    const qMid = _ikMid;
    twoBoneReach(_pA, _pB, _pC, _pD, qRoot, qMid);
    // mid first (about the elbow, expressed through the upper arm's frame), then the root
    this.premultiplyWorld(fore, n.arm, qMid, w);
    this.premultiplyWorld(arm, n.shoulder, qRoot, w);
  }

  /**
   * Hold poses (GLB_HOLD_POSES): turn the chest square to the aim (or to the
   * hold's bladed stance) and bend the spine by the hold's share of the pitch.
   * Returns the spine pitch applied.
   */
  private squareChest(hold: GlbHoldPose, pitch: number): number {
    const bones = this.bones;
    for (let iter = 0; iter < 2; iter++) {
      // chest forward: across the shoulder line (left − right) × up = (−v.z, 0, v.x); its yaw
      // is + toward the armature's +X (the model's left), so a bladed chest (the left shoulder
      // forward, facing right of the aim) is at −blade
      this.chainPos('RightArm', _pA);
      this.chainPos('LeftArm', _pB);
      _v.subVectors(_pB, _pA);
      const yawErr = wrapAngle(-hold.blade - Math.atan2(-_v.z, _v.x)) * this.aimW;
      if (Math.abs(yawErr) < 1e-4) break;
      for (let i = 0; i < SPINE.length; i++) this.rotateWorld(bones[SPINE[i]], i === 0 ? 'Hips' : SPINE[i - 1], Y_AXIS, yawErr * SPINE_SHARE[i]);
    }
    const sp = clamp(pitch * hold.spine, -SPINE_PITCH_DOWN, SPINE_PITCH_UP) * this.aimW;
    for (let i = 0; i < SPINE.length; i++) this.rotateWorld(bones[SPINE[i]], i === 0 ? 'Hips' : SPINE[i - 1], RIGHT_AXIS, sp * SPINE_SHARE[i]);
    return sp;
  }

  /** Hold poses: the weapon hand(s) to the hold's target, the weapon(s) along the aim. */
  private holdArms(hold: GlbHoldPose, attach: GlbWeaponAttach, pitch: number, lowered: number, w: number, akimbo: boolean): void {
    if (w < 1e-3) return;
    // the shoulders' midpoint (the arms do not move it)
    this.chainPos('RightArm', _pA);
    this.chainPos('LeftArm', _pB);
    _pO.addVectors(_pA, _pB).multiplyScalar(0.5);
    for (let k = 0; k < (akimbo ? 2 : 1); k++) {
      const side = k === 0 ? 1 : -1;
      const n = LIMB[side > 0 ? 'Right' : 'Left'];
      const grip = side > 0 ? attach.grip : attach.gripL;
      if (!grip) continue;
      glbHoldTarget(hold, pitch, lowered, side, _hold, _dir);
      _pT.copy(_hold).divideScalar(this.unitM).add(_pO);
      _v3.set(-hold.elbow[0] * side, hold.elbow[1], hold.elbow[2]);
      this.limbTo(n.arm, n.fore, n.hand, n.shoulder, _pT, _v3, w);
      // the hand turned so the weapon lies along the aim, its top up: weapon = hand · grip
      _zW.copy(_dir).negate();
      _yW.set(0, 1, 0).addScaledVector(_zW, -_zW.y).normalize();
      _xW.crossVectors(_yW, _zW);
      _mW.makeBasis(_xW, _yW, _zW);
      _qW.setFromRotationMatrix(_mW).multiply(_q2.copy(grip).invert());
      this.chainQuat(n.fore, _qp);
      _qW.premultiply(_qp.invert());
      const hand = this.bones[n.hand];
      if (hand) hand.quaternion.slerp(_qW, w);
    }
  }

  /**
   * Two-bone limb (root → mid → end joints) to an armature-space target, the
   * middle joint bent toward `pole`: the root segment is turned onto its new
   * direction with the bend plane turned along (ik.alignFrames), then the
   * middle segment onto the target. Blended in by `w`.
   */
  private limbTo(root: string, mid: string, end: string, rootParent: string, target: THREE.Vector3, pole: THREE.Vector3, w: number): void {
    const rb = this.bones[root];
    const mb = this.bones[mid];
    if (!rb || !mb || !this.bones[end]) return;
    const a = this.chainPos(root, _pA);
    const m = this.chainPos(mid, _pB);
    const e = this.chainPos(end, _pC);
    const l1 = a.distanceTo(m);
    const l2 = m.distanceTo(e);
    if (l1 < 1e-6 || l2 < 1e-6) return;
    _pD.copy(target);
    limbJoints(a, _pD, pole, l1, l2, _kneeT, _ankleT);
    _v.subVectors(m, a);
    _v2.subVectors(e, m);
    _nA.crossVectors(_v, _v2);
    _dA.subVectors(_kneeT, a);
    _v2.subVectors(_ankleT, _kneeT);
    _nB.crossVectors(_dA, _v2);
    alignFrames(_v, _nA, _dA, _nB, _qRide);
    this.premultiplyWorld(rb, rootParent, _qRide, w);
    this.chainPos(mid, _pB);
    this.chainPos(end, _pC);
    _v.subVectors(_pC, _pB).normalize();
    _v2.subVectors(_ankleT, _kneeT).normalize();
    _qRide.setFromUnitVectors(_v, _v2);
    this.premultiplyWorld(mb, root, _qRide, w);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}

const IDENTITY_Q = new THREE.Quaternion();
const _ikRoot = new THREE.Quaternion();
const _ikMid = new THREE.Quaternion();
/** How far the spine bends to aim up / down (rad); the arms take the rest. */
export const SPINE_PITCH_UP = 0.7;
export const SPINE_PITCH_DOWN = 0.25;
/** Weapon pitch (rad) of the low-ready carry while sprinting. */
export const LOW_READY_PITCH = -0.62;
/** Share of the support arm's full length it reaches out to (a straight elbow reads as locked). */
export const LEFT_REACH = 0.97;
/** Clip time (s) of the jump clip's airborne tuck (held while VF_AIRBORNE). */
export const JUMP_HOLD = 0.8;
