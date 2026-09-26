// Procedural animation state machine for humanoids. Inputs come straight from
// ViewEntity (speed, flags, pitch) plus derived movement direction and one-shot
// events (fire, melee, cast, hit). Every state is a smoothed weight so
// transitions blend; the final pose is written to the rig's bones, with
// two-bone IK placing the hands on the weapon.
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
import { B, BONE_COUNT } from '../models/rig';
import type { HoldStyle } from '../models/weapons';
import { solveTwoBone } from './ik';

export interface AnimInput {
  dt: number;
  time: number;
  /** horizontal speed (m/s) */
  speed: number;
  /** movement direction in the character's frame (x = right, z = forward); zero when idle */
  moveX: number;
  moveZ: number;
  /** aim pitch (rad, + = up) */
  pitch: number;
  flags: number;
  hold: HoldStyle;
  /** saddle height offset for the hips when riding (0 = on foot) */
  mountHip: number;
  /** vertical bob of the mount's saddle */
  mountBob: number;
  leftHandBusy: boolean;
  akimbo: boolean;
}

/** Smoothed state weights (exposed for tests / debugging). */
export interface AnimWeights {
  move: number;
  run: number;
  sprint: number;
  ads: number;
  reload: number;
  air: number;
  downed: number;
  dead: number;
  dodge: number;
  stun: number;
  dance: number;
  channel: number;
  cast: number;
  melee: number;
  recoil: number;
  hit: number;
  mounted: number;
  frozen: number;
}

export interface WeaponGrip {
  /** left-hand target in weapon space (null = one-handed) */
  fore: THREE.Vector3 | null;
  mag: THREE.Vector3 | null;
}

interface HoldPose {
  hip: [number, number, number];
  ads: [number, number, number];
  rot: [number, number, number]; // base euler (x, y, z) offset
}

const HOLD_POSES: Record<HoldStyle, HoldPose> = {
  rifle: { hip: [0.12, 0.02, -0.3], ads: [0.07, 0.25, -0.26], rot: [0, 0, 0] },
  hip: { hip: [0.15, -0.08, -0.26], ads: [0.12, 0.08, -0.3], rot: [0, 0, 0] },
  pistol: { hip: [0.12, 0.06, -0.4], ads: [0.05, 0.22, -0.46], rot: [0, 0, 0] },
  akimbo: { hip: [0.2, 0.04, -0.38], ads: [0.17, 0.16, -0.44], rot: [0, 0, 0] },
  launcher: { hip: [0.17, 0.23, -0.06], ads: [0.13, 0.26, -0.08], rot: [0, 0, 0] },
  bow: { hip: [-0.1, 0.18, -0.5], ads: [-0.04, 0.24, -0.55], rot: [0, 0, 0.25] },
  pole: { hip: [0.16, -0.06, -0.24], ads: [0.14, 0.04, -0.3], rot: [0.95, 0, 0] },
  sword: { hip: [0.24, -0.04, -0.24], ads: [0.2, 0.06, -0.3], rot: [1.15, 0, 0] },
  none: { hip: [0.2, -0.3, -0.1], ads: [0.2, -0.3, -0.1], rot: [0, 0, 0] },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const approach = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const ease = (t: number): number => t * t * (3 - 2 * t);

// scratch
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qwl = new THREE.Quaternion();
const _qu = new THREE.Quaternion();
const _ql = new THREE.Quaternion();
const _chain = new THREE.Quaternion();
const _wp = new THREE.Vector3();
const _wpl = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _pole = new THREE.Vector3();

export interface RigBones {
  bones: THREE.Bone[];
  /** local rest positions per bone */
  localRest: THREE.Vector3[];
  /** upper / lower arm lengths */
  armL1: number;
  armL2: number;
}

export class CharacterAnimator {
  readonly w: AnimWeights = {
    move: 0,
    run: 0,
    sprint: 0,
    ads: 0,
    reload: 0,
    air: 0,
    downed: 0,
    dead: 0,
    dodge: 0,
    stun: 0,
    dance: 0,
    channel: 0,
    cast: 0,
    melee: 0,
    recoil: 0,
    hit: 0,
    mounted: 0,
    frozen: 0,
  };
  /** radians; advances with distance travelled */
  phase = 0;
  crawlPhase = 0;
  /** seconds since VF_DEAD appeared (−1 = alive) */
  deadTime = -1;
  private dodgeT = -1;
  private dodgeAxis = 0; // 0 = forward roll, ±1 = side roll
  private castT = 0;
  private meleeT = -1;
  private hitT = 0;
  private recoilV = 0;
  private reloadT = 0;
  private fireTimer = 0;
  private legYaw = 0;
  private legDir = 1;
  private deathTwist = 0;
  private lastInput: AnimInput | null = null;
  private readonly euler = new Float32Array(BONE_COUNT * 3);
  private readonly rootPos = new THREE.Vector3();
  private readonly wPos = new THREE.Vector3();
  private readonly wRot = new THREE.Vector3();
  private readonly wlPos = new THREE.Vector3();
  private readonly wlRot = new THREE.Vector3();
  private holdR = 1;
  private holdL = 1;
  /** whether the held weapon should be visible this frame */
  weaponVisible = true;

  // ── events ────────────────────────────────────────────────────────────────
  fire(strength = 1): void {
    this.recoilV = Math.min(1.5, this.recoilV + strength);
  }
  melee(): void {
    this.meleeT = 0;
  }
  cast(): void {
    this.castT = 0.7;
  }
  hit(): void {
    this.hitT = 0.25;
  }

  /** Advance the state machine. */
  update(inp: AnimInput): void {
    const dt = Math.min(0.1, Math.max(0, inp.dt));
    const f = inp.flags;
    const w = this.w;
    const has = (bit: number): number => ((f & bit) !== 0 ? 1 : 0);
    const dead = has(VF_DEAD);
    const downed = dead ? 0 : has(VF_DOWNED);
    if (dead) {
      if (this.deadTime < 0) {
        this.deadTime = 0;
        this.deathTwist = (Math.random() - 0.5) * 0.8;
      } else this.deadTime += dt;
    } else this.deadTime = -1;
    w.dead = dead ? ease(clamp01(this.deadTime / 0.7)) : approach(w.dead, 0, 10, dt);
    w.downed = approach(w.downed, downed, 7, dt);
    const mounted = inp.mountHip > 0 && !dead && !downed ? 1 : 0;
    w.mounted = approach(w.mounted, mounted, 8, dt);
    const speed = mounted ? 0 : inp.speed;
    w.move = approach(w.move, clamp01(speed / 2.2), 8, dt);
    w.run = approach(w.run, clamp01((speed - 3.2) / 2.5), 6, dt);
    w.sprint = approach(w.sprint, has(VF_SPRINTING) * (speed > 2 ? 1 : 0), 6, dt);
    w.ads = approach(w.ads, has(VF_ADS), 14, dt);
    const reloading = has(VF_RELOADING);
    w.reload = approach(w.reload, reloading, 10, dt);
    this.reloadT = reloading ? this.reloadT + dt : 0;
    w.air = approach(w.air, has(VF_AIRBORNE) && !mounted ? 1 : 0, 10, dt);
    w.stun = approach(w.stun, has(VF_STUNNED), 8, dt);
    w.dance = approach(w.dance, has(VF_DANCING), 6, dt);
    w.channel = approach(w.channel, has(VF_CHANNELING) && !mounted ? 1 : 0, 8, dt);
    w.frozen = approach(w.frozen, has(VF_FROZEN), 8, dt);
    // dodge roll: timer-driven, triggered on the rising edge of VF_DODGING
    if (has(VF_DODGING) && this.dodgeT < 0) {
      this.dodgeT = 0;
      const lx = inp.moveX;
      const lz = inp.moveZ;
      this.dodgeAxis = Math.abs(lx) > Math.abs(lz) * 1.2 ? Math.sign(lx) : 0;
      this.legDir = lz < -0.3 ? -1 : 1;
    }
    if (this.dodgeT >= 0) {
      this.dodgeT += dt / 0.5;
      if (this.dodgeT >= 1) this.dodgeT = has(VF_DODGING) ? 0.999 : -1;
    }
    w.dodge = this.dodgeT >= 0 ? Math.sin(Math.PI * clamp01(this.dodgeT)) : approach(w.dodge, 0, 12, dt);
    // one-shots
    this.castT = Math.max(0, this.castT - dt);
    w.cast = approach(w.cast, this.castT > 0 || (has(VF_CHANNELING) && inp.leftHandBusy) ? 1 : 0, 12, dt);
    if (this.meleeT >= 0) {
      this.meleeT += dt / 0.38;
      if (this.meleeT >= 1) this.meleeT = -1;
    }
    w.melee = this.meleeT >= 0 ? this.meleeT : 0;
    this.hitT = Math.max(0, this.hitT - dt);
    w.hit = this.hitT / 0.25;
    // firing flag without explicit shot events → synthesise recoil pulses
    if (has(VF_FIRING)) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this.fire(0.6);
        this.fireTimer = 0.11;
      }
    } else this.fireTimer = 0;
    this.recoilV = Math.max(0, this.recoilV - dt * 9 * Math.max(0.3, this.recoilV));
    w.recoil = this.recoilV;
    // gait phase
    const stride = 1.35 + w.run * 1.1 + w.sprint * 0.5;
    this.phase = (this.phase + ((dt * speed) / stride) * Math.PI * 2 * (w.frozen > 0.5 ? 0.6 : 1)) % (Math.PI * 200);
    this.crawlPhase += dt * (0.6 + inp.speed * 2.2);
    // movement direction → hip yaw (strafe) / backpedal
    if (speed > 0.4 && (inp.moveX !== 0 || inp.moveZ !== 0)) {
      let ang = Math.atan2(inp.moveX, inp.moveZ);
      let dir = 1;
      if (Math.abs(ang) > 1.75) {
        ang = ang > 0 ? ang - Math.PI : ang + Math.PI;
        dir = -1;
      }
      this.legYaw = approach(this.legYaw, Math.max(-1, Math.min(1, -ang)), 8, dt);
      this.legDir = dir;
    } else this.legYaw = approach(this.legYaw, 0, 6, dt);
    // hand holds
    const noHands = Math.max(w.dead, w.downed, w.dance);
    const handsOn = inp.hold === 'none' ? 0 : 1 - noHands;
    this.holdR = handsOn * (1 - w.stun * 0.6);
    const leftFree = inp.leftHandBusy || inp.hold === 'sword';
    this.holdL = leftFree && !inp.akimbo ? 0 : this.holdR * (1 - w.cast) * (1 - w.channel * 0.8);
    this.weaponVisible = inp.hold !== 'none' && noHands < 0.5;
    this.lastInput = inp;
  }

  /** Write the pose into the bones (call after update). */
  apply(rig: RigBones, grip: WeaponGrip): void {
    const inp = this.lastInput;
    if (!inp) return;
    const w = this.w;
    const E = this.euler;
    E.fill(0);
    const set = (bone: number, x: number, y: number, z: number): void => {
      E[bone * 3] += x;
      E[bone * 3 + 1] += y;
      E[bone * 3 + 2] += z;
    };
    const t = inp.time;
    const ph = this.phase;
    const root = this.rootPos.set(0, 0, 0);

    // ── locomotion ───────────────────────────────────────────────────────────
    const onFoot = 1 - w.mounted;
    const amp = (0.5 + 0.35 * w.run + 0.2 * w.sprint) * w.move * onFoot * (1 - w.frozen * 0.5);
    const dir = this.legDir;
    const sL = Math.sin(ph) * dir;
    const sR = Math.sin(ph + Math.PI) * dir;
    const kneeK = 0.55 + 0.8 * w.run + 0.3 * w.sprint;
    set(B.legUL, sL * amp, 0, 0);
    set(B.legUR, sR * amp, 0, 0);
    set(B.legLL, -(0.12 + kneeK * Math.max(0, Math.cos(ph) * dir)) * w.move * onFoot, 0, 0);
    set(B.legLR, -(0.12 + kneeK * Math.max(0, Math.cos(ph + Math.PI) * dir)) * w.move * onFoot, 0, 0);
    set(B.footL, -sL * amp * 0.4, 0, 0);
    set(B.footR, -sR * amp * 0.4, 0, 0);
    root.y += (Math.abs(Math.cos(ph)) - 0.6) * 0.05 * (0.5 + w.run) * w.move * onFoot;
    const lean = (0.06 * w.run + 0.2 * w.sprint) * onFoot;
    set(B.spine, -lean, 0, 0);
    set(B.hips, 0, this.legYaw * w.move * onFoot, Math.sin(ph) * 0.04 * w.move * onFoot);
    // counter-rotate so the chest keeps facing the aim
    set(B.spine, 0, -this.legYaw * w.move * onFoot * 0.6, -Math.sin(ph) * 0.03 * w.move);
    set(B.chest, 0, -this.legYaw * w.move * onFoot * 0.4, 0);
    // free-arm swing (used when a hand is not on the weapon)
    set(B.armUL, -sL * amp * 0.9, 0, -0.08);
    set(B.armUR, -sR * amp * 0.9, 0, 0.08);
    set(B.armLL, 0.25 + 0.3 * w.run, 0, 0);
    set(B.armLR, 0.25 + 0.3 * w.run, 0, 0);
    // idle breathing
    const breathe = Math.sin(t * 1.7) * (1 - w.move);
    set(B.chest, breathe * 0.02, 0, 0);
    set(B.head, Math.sin(t * 0.43) * 0.04 * (1 - w.move), Math.sin(t * 0.31) * 0.12 * (1 - w.move) * (1 - w.ads), 0);

    // ── aim: distribute pitch across spine / chest / head ────────────────────
    const pitch = Math.max(-1.3, Math.min(1.3, inp.pitch)) * (1 - w.dead) * (1 - w.downed) * (1 - w.dance);
    set(B.spine, pitch * 0.22, 0, 0);
    set(B.chest, pitch * 0.25, 0, 0);
    set(B.head, pitch * 0.35, 0, 0);

    // ── weapon pose (chest space) ────────────────────────────────────────────
    const hp = HOLD_POSES[inp.hold];
    const adsW = w.ads * (1 - w.sprint);
    const wp = this.wPos.set(
      hp.hip[0] + (hp.ads[0] - hp.hip[0]) * adsW,
      hp.hip[1] + (hp.ads[1] - hp.hip[1]) * adsW,
      hp.hip[2] + (hp.ads[2] - hp.hip[2]) * adsW,
    );
    const wr = this.wRot.set(hp.rot[0], hp.rot[1], hp.rot[2]);
    // sprint: port arms
    if (inp.hold !== 'pole' && inp.hold !== 'sword') {
      wp.x -= 0.06 * w.sprint;
      wp.y -= 0.06 * w.sprint;
      wp.z += 0.06 * w.sprint;
      wr.x -= 0.55 * w.sprint;
      wr.y += 0.65 * w.sprint;
      wr.z += 0.35 * w.sprint;
    }
    // recoil kick
    wp.z += 0.06 * w.recoil;
    wr.x += 0.1 * w.recoil;
    set(B.chest, -0.03 * w.recoil, 0, 0);
    // reload: tilt the weapon, left hand goes to the magazine
    wr.x -= 0.35 * w.reload;
    wr.z += 0.55 * w.reload;
    wp.y -= 0.05 * w.reload;
    // melee: sweep (blades) or bayonet thrust (guns)
    if (w.melee > 0) {
      const m = w.melee;
      if (inp.hold === 'pole' || inp.hold === 'sword') {
        const sweep = Math.cos(m * Math.PI); // +1 → −1
        wr.y += sweep * 1.3;
        wr.x += -0.8 * Math.sin(m * Math.PI);
        wp.x -= 0.1 * Math.sin(m * Math.PI);
        set(B.chest, 0, sweep * 0.45, 0);
        set(B.spine, 0, sweep * 0.25, 0);
      } else {
        const k = Math.sin(m * Math.PI);
        wp.z -= 0.28 * k;
        set(B.chest, -0.1 * k, 0.25 * k, 0);
      }
    }
    // hit flinch
    set(B.chest, -0.14 * w.hit, 0, 0.05 * w.hit);
    set(B.head, -0.12 * w.hit, 0, 0);

    // ── overrides ────────────────────────────────────────────────────────────
    // airborne: tucked legs
    if (w.air > 0.001) {
      const a = w.air;
      set(B.legUL, 0.7 * a, 0, 0);
      set(B.legLL, -1.0 * a, 0, 0);
      set(B.legUR, 0.25 * a, 0, 0);
      set(B.legLR, -0.55 * a, 0, 0);
    }
    // channel (revive / open / item): kneel
    if (w.channel > 0.001) {
      const c = w.channel;
      set(B.legUL, 1.45 * c, 0, 0);
      set(B.legLL, -1.35 * c, 0, 0);
      set(B.legUR, 0.35 * c, 0, 0);
      set(B.legLR, -2.1 * c, 0, 0);
      set(B.footR, 0.7 * c, 0, 0);
      set(B.spine, -0.35 * c, 0, 0);
      root.y -= 0.42 * c;
      set(B.armUL, 0.9 * c, 0, 0.1 * c);
    }
    // cast: left palm thrust forward
    if (w.cast > 0.001) {
      const c = w.cast;
      set(B.armUL, 1.35 * c, 0, -0.1 * c);
      set(B.armLL, 0.2 * c, 0, 0);
      set(B.chest, 0, 0.25 * c, 0);
    }
    // fan holder: left hand raises the fan in front of the chest
    if (inp.leftHandBusy && inp.hold !== 'akimbo') {
      const k = 1 - Math.max(w.dead, w.downed, w.dance);
      set(B.armUL, 0.5 * k, 0.3 * k, -0.15 * k);
      set(B.armLL, 1.45 * k, 0, 0.0);
      set(B.handL, 0.1 * k, 0, Math.sin(t * 2.2) * 0.25 * k * (1 - w.move));
    }
    // mounted: legs astride, hips at saddle height
    if (w.mounted > 0.001) {
      const m = w.mounted;
      for (const [u, l, ft, sgn] of [
        [B.legUL, B.legLL, B.footL, -1],
        [B.legUR, B.legLR, B.footR, 1],
      ] as const) {
        set(u, 1.2 * m, 0, sgn * 0.38 * m);
        set(l, -1.35 * m, 0, 0);
        set(ft, 0.35 * m, 0, 0);
      }
      root.y += (inp.mountHip - (rig.localRest[B.hips].y + 0.0)) * m + inp.mountBob * m;
      root.z += 0.05 * m;
    }
    // dodge roll
    if (w.dodge > 0.001 && this.dodgeT >= 0) {
      const k = w.dodge;
      const p = clamp01(this.dodgeT);
      const spin = -Math.PI * 2 * ease(p) * this.legDir;
      set(B.legUL, 1.6 * k, 0, 0);
      set(B.legUR, 1.5 * k, 0, 0);
      set(B.legLL, -2.1 * k, 0, 0);
      set(B.legLR, -2.1 * k, 0, 0);
      set(B.spine, -0.6 * k, 0, 0);
      set(B.head, -0.5 * k, 0, 0);
      root.y += 0.45 * Math.sin(Math.PI * p) - 0.35 * k;
      if (this.dodgeAxis === 0) set(B.root, spin, 0, 0);
      else set(B.root, 0, 0, Math.PI * 2 * ease(p) * -this.dodgeAxis);
    }
    // stunned: dazed sway
    if (w.stun > 0.001) {
      const s = w.stun;
      set(B.root, 0, 0, Math.sin(t * 2.3) * 0.07 * s);
      set(B.spine, -0.25 * s, 0, Math.sin(t * 2.3 + 1) * 0.08 * s);
      set(B.head, -0.35 * s + Math.sin(t * 3.1) * 0.12 * s, Math.sin(t * 1.9) * 0.25 * s, 0);
      set(B.legLL, -0.25 * s, 0, 0);
      set(B.legLR, -0.2 * s, 0, 0);
      root.y -= 0.04 * s;
    }
    // dance (乐不思蜀)
    if (w.dance > 0.001) {
      const d = w.dance;
      const b4 = Math.sin(t * 7);
      set(B.root, 0, t * 2.2 * d, 0);
      set(B.armUL, 0.4 * Math.sin(t * 3.5) * d, 0, -(2.3 + 0.35 * b4) * d);
      set(B.armUR, 0.4 * Math.sin(t * 3.5 + 1.5) * d, 0, (2.3 - 0.35 * b4) * d);
      set(B.armLL, (0.6 + 0.4 * b4) * d, 0, 0);
      set(B.armLR, (0.6 - 0.4 * b4) * d, 0, 0);
      set(B.hips, 0, 0, Math.sin(t * 3.5) * 0.18 * d);
      set(B.spine, 0, 0, -Math.sin(t * 3.5) * 0.14 * d);
      set(B.head, Math.abs(b4) * 0.2 * d, 0, Math.sin(t * 3.5) * 0.2 * d);
      set(B.legUL, (0.35 + 0.2 * b4) * d, 0, 0);
      set(B.legUR, (0.35 - 0.2 * b4) * d, 0, 0);
      set(B.legLL, -(0.6 + 0.3 * b4) * d, 0, 0);
      set(B.legLR, -(0.6 - 0.3 * b4) * d, 0, 0);
      root.y -= (0.06 + 0.05 * Math.abs(b4)) * d;
    }
    // downed: prone crawl
    if (w.downed > 0.001) {
      const d = w.downed;
      const c = this.crawlPhase;
      this.blendBone(d, B.root, -1.45, 0, 0);
      this.blendBone(d, B.head, 0.95, 0, 0);
      this.blendBone(d, B.armUL, 2.55 + Math.sin(c) * 0.45, 0, -0.25);
      this.blendBone(d, B.armUR, 2.55 - Math.sin(c) * 0.45, 0, 0.25);
      this.blendBone(d, B.armLL, 0.4 + Math.max(0, Math.cos(c)) * 0.6, 0, 0);
      this.blendBone(d, B.armLR, 0.4 + Math.max(0, -Math.cos(c)) * 0.6, 0, 0);
      this.blendBone(d, B.legUL, 0.15 + Math.sin(c + Math.PI) * 0.2, 0, -0.1);
      this.blendBone(d, B.legUR, 0.15 + Math.sin(c) * 0.2, 0, 0.1);
      this.blendBone(d, B.legLL, -0.5, 0, 0);
      this.blendBone(d, B.legLR, -0.3, 0, 0);
      root.y = root.y * (1 - d) + 0.16 * d;
      root.z = root.z * (1 - d) + 0.85 * d;
    }
    // dead: fall onto the back and stay down
    if (w.dead > 0.001) {
      const d = w.dead;
      const stagger = clamp01(1 - this.deadTime / 0.35);
      this.blendBone(d, B.root, 1.5, this.deathTwist, 0);
      this.blendBone(d, B.spine, 0.1, 0, 0);
      this.blendBone(d, B.head, -0.35, 0.4 * this.deathTwist, 0);
      this.blendBone(d, B.armUL, 0.5, 0, -1.25);
      this.blendBone(d, B.armUR, 0.2, 0, 1.35);
      this.blendBone(d, B.armLL, 0.3, 0, 0);
      this.blendBone(d, B.armLR, 0.5, 0, 0);
      this.blendBone(d, B.legUL, 0.35 + stagger * 0.5, 0, -0.12);
      this.blendBone(d, B.legUR, 0.1 + stagger * 0.3, 0, 0.1);
      this.blendBone(d, B.legLL, -0.4 - stagger * 0.6, 0, 0);
      this.blendBone(d, B.legLR, -0.15, 0, 0);
      root.y = root.y * (1 - d) + 0.12 * d;
    }

    // weapon bone world pitch must equal aim pitch → compensate torso tilt
    const torsoPitch = E[B.spine * 3] + E[B.chest * 3];
    const torsoYaw = E[B.hips * 3 + 1] + E[B.spine * 3 + 1] + E[B.chest * 3 + 1];
    wr.x += pitch - torsoPitch;
    wr.y += -torsoYaw * (w.melee > 0 ? 0.5 : 1);
    // left akimbo mirror
    const wl = this.wlPos.set(-wp.x, wp.y, wp.z);
    const wlr = this.wlRot.set(wr.x, -wr.y, -wr.z);

    // ── write FK rotations ───────────────────────────────────────────────────
    const bones = rig.bones;
    for (let i = 0; i < BONE_COUNT; i++) {
      if (i === B.weapon || i === B.weaponL) continue;
      _e.set(E[i * 3], E[i * 3 + 1], E[i * 3 + 2], 'YXZ');
      bones[i].quaternion.setFromEuler(_e);
      bones[i].position.copy(rig.localRest[i]);
    }
    bones[B.root].position.add(root);
    // cape trails with speed
    _e.set(0.12 + w.move * 0.25 + w.run * 0.3 + Math.sin(t * 2.7) * 0.03, 0, Math.sin(t * 1.9) * 0.03, 'YXZ');
    bones[B.cape].quaternion.setFromEuler(_e);

    // weapon bones (chest-relative)
    const wb = bones[B.weapon];
    wb.position.copy(wp);
    _e.set(wr.x, wr.y, wr.z, 'YXZ');
    wb.quaternion.setFromEuler(_e);
    const wbl = bones[B.weaponL];
    wbl.position.copy(wl);
    _e.set(wlr.x, wlr.y, wlr.z, 'YXZ');
    wbl.quaternion.setFromEuler(_e);

    // ── hands on weapon (IK in chest space) ──────────────────────────────────
    if (this.holdR > 0.001 || this.holdL > 0.001) this.solveArms(rig, grip, inp);
  }

  /** Blend one bone of the current pose toward an override euler (x, y, z) by weight k (allocation-free). */
  private blendBone(k: number, bone: number, x: number, y: number, z: number): void {
    const E = this.euler;
    const i = bone * 3;
    E[i] = E[i] * (1 - k) + x * k;
    E[i + 1] = E[i + 1] * (1 - k) + y * k;
    E[i + 2] = E[i + 2] * (1 - k) + z * k;
  }

  private solveArms(rig: RigBones, grip: WeaponGrip, inp: AnimInput): void {
    const bones = rig.bones;
    // weapon transforms in chest space
    _qw.copy(bones[B.weapon].quaternion);
    _wp.copy(bones[B.weapon].position);
    _qwl.copy(bones[B.weaponL].quaternion);
    _wpl.copy(bones[B.weaponL].position);
    const bow = inp.hold === 'bow';
    const arms: {
      u: number;
      l: number;
      h: number;
      w: number;
      side: number;
    }[] = [
      { u: B.armUR, l: B.armLR, h: B.handR, w: this.holdR, side: 1 },
      { u: B.armUL, l: B.armLL, h: B.handL, w: this.holdL, side: -1 },
    ];
    for (const a of arms) {
      if (a.w <= 0.001) continue;
      const right = a.side > 0;
      let handQ = _qw;
      if (inp.akimbo && !right) {
        _tgt.copy(_wpl);
        handQ = _qwl;
      } else if (bow) {
        if (right && grip.fore) _tgt.copy(grip.fore).applyQuaternion(_qw).add(_wp);
        else _tgt.copy(_wp);
      } else if (right) {
        _tgt.copy(_wp);
      } else {
        const reloadK = this.w.reload;
        const fore = grip.fore;
        if (reloadK > 0.5 && grip.mag) {
          _tgt.copy(grip.mag);
          _tgt.y += -0.06 * Math.abs(Math.sin(this.reloadT * 5));
          _tgt.applyQuaternion(_qw).add(_wp);
        } else if (fore) _tgt.copy(fore).applyQuaternion(_qw).add(_wp);
        else {
          // one-handed weapon: left hand cups the right (pistols) or relaxes
          if (inp.hold === 'pistol') _tgt.set(-0.03, -0.03, 0.03).applyQuaternion(_qw).add(_wp);
          else continue;
        }
      }
      // shoulder in chest space (rest offset of the upper arm bone)
      const shoulder = rig.localRest[a.u];
      _pole.set(a.side * 0.7, -1, 0.35);
      solveTwoBone(shoulder, _tgt, _pole, rig.armL1, rig.armL2, _qu, _ql);
      const bu = bones[a.u];
      const bl = bones[a.l];
      const bh = bones[a.h];
      if (a.w >= 0.999) {
        bu.quaternion.copy(_qu);
        bl.quaternion.copy(_ql);
      } else {
        bu.quaternion.slerp(_qu, a.w);
        bl.quaternion.slerp(_ql, a.w);
      }
      // hand orientation follows the weapon
      _chain.copy(bu.quaternion).multiply(bl.quaternion);
      _q.copy(_chain).invert().multiply(handQ);
      if (a.w >= 0.999) bh.quaternion.copy(_q);
      else bh.quaternion.slerp(_q, a.w);
    }
  }
}

