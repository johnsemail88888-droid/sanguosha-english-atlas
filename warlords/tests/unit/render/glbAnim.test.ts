// GLB character pipeline: clip retargeting / mirroring / grounding (pure track
// math), the state → weights blend, the two-bone reach, model-path mapping and
// scale normalisation — plus a synthetic-rig integration test of GlbBody +
// GlbAnimator (no asset files needed).
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import {
  VF_AIRBORNE,
  VF_DEAD,
  VF_DODGING,
  VF_DOWNED,
  VF_FIRING,
  VF_FROZEN,
  VF_RELOADING,
  VF_SPRINTING,
  VF_STUNNED,
} from '../../../src/core/types';
import {
  UPPER_BONES,
  analyseGait,
  applyRootPolicy,
  groundLift,
  layerTracks,
  mirrorBoneName,
  mirrorClip,
  modelHipsTrack,
  prepareClip,
  sampleLegs,
  trackBone,
  windowTrack,
  type LegSample,
  type PreparedClip,
} from '../../../src/render/anim/glbRetarget';
import {
  BACK_ENTER,
  BACK_EXIT,
  L,
  U,
  WARP_MAX,
  glbBlend,
  glbCast,
  glbHit,
  glbMelee,
  newGlbBlend,
  newGlbMemory,
  type GlbAnimInput,
} from '../../../src/render/anim/glbAnimator';
import { twoBoneReach } from '../../../src/render/anim/ik';
import { CLIP_IDS, setClipsForTests, type ClipId } from '../../../src/render/anim/glbClips';
import { buildLod, canonicaliseHips, evictUnusedTemplates, normalizeScale, releaseTemplate, retainTemplate, troopModelPath, type CharTemplate } from '../../../src/render/models/glb';
import { GlbBody } from '../../../src/render/models/glbBody';
import { matchModelPaths } from '../../../src/render/models/preload';
import { CharacterRig } from '../../../src/render/models/character';
import { heroSpec } from '../../../src/render/models';
import { setAssetListForTests } from '../../../src/game/assets';

const q = (x: number, y: number, z: number, w: number): THREE.Quaternion => new THREE.Quaternion(x, y, z, w).normalize();
const angleBetween = (a: THREE.Quaternion, b: THREE.Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));

// ── retargeting ─────────────────────────────────────────────────────────────

describe('clip retargeting (canonical Hips frame)', () => {
  const H = q(0.46, -0.4, 0.56, 0.56); // an arbitrary auto-rig Hips rest frame
  const hipsAt = (t: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t).multiply(H);
  const child = q(0.2, 0.1, -0.3, 0.9);
  const src = (): Parameters<typeof prepareClip>[0] => {
    const times = [0, 0.5, 1];
    const hv: number[] = [];
    const cv: number[] = [];
    for (const t of times) {
      hv.push(...hipsAt(t).toArray());
      cv.push(...child.toArray());
    }
    const clip = new THREE.AnimationClip('t', 1, [
      new THREE.QuaternionKeyframeTrack('Hips.quaternion', times, hv),
      new THREE.QuaternionKeyframeTrack('Spine02.quaternion', times, cv),
      new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', times, cv),
      new THREE.VectorKeyframeTrack('Hips.position', times, [1, 100, 2, 5, 104, 30, 9, 98, 60]),
      new THREE.VectorKeyframeTrack('Hips.scale', times, [1.18, 1.18, 1.18, 1.18, 1.18, 1.18, 1.18, 1.18, 1.18]),
      new THREE.VectorKeyframeTrack('LeftArm.position', times, [0, 15, 0, 0, 15, 0, 0, 15, 0]),
    ]);
    return { clip, hipsRestQ: H.clone(), hipsRestP: new THREE.Vector3(0, 100, 0), hipsChildren: ['Spine02', 'LeftUpLeg', 'RightUpLeg'] };
  };

  it('keeps only rotations + the Hips translation, rest Hips becomes identity, child world rotations unchanged', () => {
    const c = prepareClip(src(), 'loco');
    expect(c.rot.map((t) => t.name).sort()).toEqual(['Hips.quaternion', 'LeftArm.quaternion', 'Spine02.quaternion']);
    expect(c.hips?.name).toBe('Hips.position');
    const hq = c.rot.find((t) => t.name === 'Hips.quaternion')!;
    const cq = c.rot.find((t) => t.name === 'Spine02.quaternion')!;
    // t = 0: the source is at its rest frame → canonical identity
    expect(angleBetween(new THREE.Quaternion().fromArray(hq.values, 0), new THREE.Quaternion())).toBeLessThan(3e-3);
    for (let k = 0; k < 3; k++) {
      const before = hipsAt(k * 0.5).multiply(child);
      const after = new THREE.Quaternion().fromArray(hq.values, k * 4).multiply(new THREE.Quaternion().fromArray(cq.values, k * 4));
      expect(angleBetween(before, after)).toBeLessThan(3e-3); // float32 track values
    }
    // non-children of the Hips are untouched
    const arm = c.rot.find((t) => t.name === 'LeftArm.quaternion')!;
    expect(angleBetween(new THREE.Quaternion().fromArray(arm.values, 0), child)).toBeLessThan(3e-3);
  });

  it('canonicaliseHips re-orients a model without moving its joints', () => {
    const arm = new THREE.Group();
    arm.scale.setScalar(0.01);
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    hips.position.set(0, 95, 0);
    hips.quaternion.copy(H);
    const sp = new THREE.Bone();
    sp.name = 'Spine02';
    sp.position.set(3, 10, -4);
    sp.quaternion.copy(child);
    hips.add(sp);
    arm.add(hips);
    arm.updateMatrixWorld(true);
    const skel = new THREE.Skeleton([hips, sp]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 95, 0, 0, 105, 0], 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0], 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
    arm.add(mesh);
    mesh.bind(skel);
    arm.updateMatrixWorld(true);
    const spBefore = new THREE.Vector3().setFromMatrixPosition(sp.matrixWorld);
    const spQBefore = sp.getWorldQuaternion(new THREE.Quaternion());
    const skinned = (i: number): THREE.Vector3 => mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    const v0 = skinned(0);
    canonicaliseHips(mesh);
    arm.updateMatrixWorld(true);
    skel.update();
    expect(hips.quaternion.w).toBeCloseTo(1, 6);
    expect(new THREE.Vector3().setFromMatrixPosition(sp.matrixWorld).distanceTo(spBefore)).toBeLessThan(1e-6);
    expect(angleBetween(sp.getWorldQuaternion(new THREE.Quaternion()), spQBefore)).toBeLessThan(1e-5);
    // the Hips-weighted vertex stays where it was
    expect(skinned(0).distanceTo(v0)).toBeLessThan(1e-5);
  });

  it('root policies: loco centres the sway, noXZ / none pin the ground position', () => {
    const mk = (): THREE.VectorKeyframeTrack => new THREE.VectorKeyframeTrack('Hips.position', [0, 1, 2], [10, 100, 0, 20, 110, 40, 30, 90, 80]);
    const rest = new THREE.Vector3(1, 99, 2);
    const a = mk();
    applyRootPolicy(a, 'loco', rest);
    expect(Array.from(a.values)).toEqual([-9, 100, -38, 1, 110, 2, 11, 90, 42]);
    const b = mk();
    applyRootPolicy(b, 'noXZ', rest);
    expect(Array.from(b.values)).toEqual([1, 100, 2, 1, 110, 2, 1, 90, 2]);
    const c = mk();
    applyRootPolicy(c, 'none', rest);
    expect(Array.from(c.values)).toEqual([1, 99, 2, 1, 99, 2, 1, 99, 2]);
  });

  it('windows a track: starts at 0, interpolated ends', () => {
    const t = new THREE.NumberKeyframeTrack('x.v', [0, 1, 2, 3], [0, 10, 20, 30]);
    const w = windowTrack(t, 0.5, 2.5);
    expect(Array.from(w.times)).toEqual([0, 0.5, 1.5, 2]);
    expect(Array.from(w.values)).toEqual([5, 10, 20, 25]);
  });

  it('mirrors left ↔ right: names swapped, rotations reflected, hips x negated', () => {
    const c = prepareClip(src(), 'loco');
    const m = mirrorClip(c, 'mirror');
    expect(m.rot.some((t) => t.name === 'RightArm.quaternion')).toBe(true);
    expect(m.rot.some((t) => t.name === 'LeftArm.quaternion')).toBe(false);
    const a0 = c.rot.find((t) => t.name === 'LeftArm.quaternion')!.values;
    const b0 = m.rot.find((t) => t.name === 'RightArm.quaternion')!.values;
    expect([b0[0], b0[1], b0[2], b0[3]]).toEqual([a0[0], -a0[1], -a0[2], a0[3]]);
    expect(m.hips!.values[0]).toBe(-c.hips!.values[0]);
    expect(m.hips!.values[1]).toBe(c.hips!.values[1]);
    expect(mirrorBoneName('LeftToeBase')).toBe('RightToeBase');
    expect(mirrorBoneName('RightHand')).toBe('LeftHand');
    expect(mirrorBoneName('Spine01')).toBe('Spine01');
  });

  it('splits upper / lower layers without overlap', () => {
    const names = ['Hips', 'LeftUpLeg', 'RightToeBase', 'Spine02', 'Spine', 'neck', 'Head', 'LeftArm', 'RightHand'];
    const rot = names.map((n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0], [0, 0, 0, 1]));
    const up = layerTracks(rot, true).map((t) => trackBone(t.name));
    const lo = layerTracks(rot, false).map((t) => trackBone(t.name));
    expect(up.length + lo.length).toBe(names.length);
    expect(lo.sort()).toEqual(['Hips', 'LeftUpLeg', 'RightToeBase']);
    for (const n of up) expect(UPPER_BONES.has(n)).toBe(true);
  });

  it('maps the Hips track onto a model: relative motion scaled by hip height, plus the ground lift', () => {
    const c: PreparedClip = {
      name: 'x',
      duration: 1,
      rot: [],
      hips: new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 100, 0, 10, 110, 0]),
      hipsRest: new THREE.Vector3(0, 100, 0),
    };
    const t = modelHipsTrack(c, new THREE.Vector3(1, 80, 2), -3)!;
    expect(Array.from(t.values)).toEqual([1, 77, 2, 9, 85, 2]);
  });
});

// ── grounding / gait ───────────────────────────────────────────────────────

describe('foot contact FK', () => {
  const rest = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
  const put = (n: string, x: number, y: number, z: number): void => void rest.set(n, { p: new THREE.Vector3(x, y, z), q: new THREE.Quaternion() });
  put('Hips', 0, 100, 0);
  for (const [s, sx] of [
    ['Left', 1],
    ['Right', -1],
  ] as const) {
    put(`${s}UpLeg`, 10 * sx, -5, 0);
    put(`${s}Leg`, 0, -45, 0);
    put(`${s}Foot`, 0, -42, 0);
    put(`${s}ToeBase`, 0, -6, 12);
  }

  it('rest pose FK and ground lift of a floating clip', () => {
    const r = sampleLegs([], null, rest, 0, 0)[0];
    expect(r.footL.y).toBeCloseTo(8, 6);
    expect(r.toeL.y).toBeCloseTo(2, 6);
    // a clip whose hips float 7 units above the rest height must be lowered by 7
    const hips = new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 107, 0, 0, 108, 0]);
    const s = sampleLegs([], hips, rest, 1, 10);
    expect(groundLift(s, r)).toBeCloseTo(-7, 6);
  });

  it('measures the authored speed, direction and cycles of an in-place gait', () => {
    // synthetic samples: one foot planted at a time, sliding backwards (−z) at 150 units/s
    const r = sampleLegs([], null, rest, 0, 0)[0];
    const samples: LegSample[] = [];
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const leftDown = t < 0.5 || i === n;
      const ph = leftDown ? t : t - 0.5;
      const zPlant = 37.5 - 150 * ph;
      const mk = (planted: boolean): { f: THREE.Vector3; toe: THREE.Vector3 } => ({
        f: new THREE.Vector3(0, planted ? r.footL.y : r.footL.y + 12, planted ? zPlant : 0),
        toe: new THREE.Vector3(0, planted ? r.toeL.y : r.toeL.y + 12, planted ? zPlant + 12 : 12),
      });
      const Lp = mk(leftDown);
      const Rp = mk(!leftDown);
      samples.push({ t, hips: new THREE.Vector3(0, 100, 0), footL: Lp.f, toeL: Lp.toe, footR: Rp.f, toeR: Rp.toe });
    }
    const g = analyseGait(samples, r, 2)!;
    expect(g.speed).toBeCloseTo(150, 0);
    expect(g.dirZ).toBeCloseTo(1, 3);
    expect(g.cycles).toBe(1);
  });
});

// ── state → weights ────────────────────────────────────────────────────────

describe('glbBlend (state → layer weights)', () => {
  const all = new Set<ClipId>(CLIP_IDS);
  const input = (o: Partial<GlbAnimInput> = {}): GlbAnimInput => ({
    dt: 1 / 60,
    speed: 0,
    moveX: 0,
    moveZ: 0,
    pitch: 0,
    flags: 0,
    hold: 'rifle',
    mounted: false,
    meleeStyle: 'thrust',
    has: (id) => all.has(id),
    natSpeed: (slot) => (slot === 'run' ? 6.3 : slot === 'sprint' ? 7 : slot === 'walkBack' ? 1 : 0),
    crawlHeading: Math.PI,
    ...o,
  });
  const sum = (a: Float32Array): number => a.reduce((s, v) => s + v, 0);

  it('idle with a rifle: idle legs, aimed upper body, weapon shown', () => {
    const m = newGlbMemory();
    const b = newGlbBlend();
    glbBlend(input(), m, b);
    expect(b.lower[L.idle]).toBe(1);
    expect(sum(b.lower)).toBeCloseTo(1, 6);
    expect(b.upper[U.aim]).toBe(1);
    expect(b.base).toBe(0);
    expect(b.aim).toBe(1);
    expect(b.weaponVisible).toBe(true);
    expect(b.leftHandIk).toBe(true);
  });

  it('unarmed: the lower clips drive the whole body', () => {
    const b = newGlbBlend();
    glbBlend(input({ hold: 'none' }), newGlbMemory(), b);
    expect(sum(b.upper)).toBe(0);
    expect(b.base).toBe(1);
    expect(b.weaponVisible).toBe(false);
  });

  it('runs forward at full stride from ~80 % of the authored speed, shorter strides below', () => {
    const b = newGlbBlend();
    glbBlend(input({ speed: 5, moveZ: 1 }), newGlbMemory(), b);
    expect(b.lower[L.run]).toBeCloseTo(1, 3);
    expect(b.warp).toBe(0);
    glbBlend(input({ speed: 3, moveZ: 1 }), newGlbMemory(), b);
    expect(b.lower[L.run]).toBeGreaterThan(0.4);
    expect(b.lower[L.run]).toBeLessThan(0.8);
    // the rest of the stride goes to the run's mean pose, not to the idle stance
    expect(b.lower[L.run] + b.lower[L.stride]).toBeCloseTo(1, 6);
    expect(b.lower[L.idle]).toBeCloseTo(0, 6);
    // without the mean pose: toward idle
    glbBlend(input({ speed: 3, moveZ: 1, has: (id) => id !== 'runMean' }), newGlbMemory(), b);
    expect(b.lower[L.run] + b.lower[L.idle]).toBeCloseTo(1, 6);
  });

  it('strafes by turning the hips (clamped), backpedals in reverse with hysteresis', () => {
    const m = newGlbMemory();
    const b = newGlbBlend();
    glbBlend(input({ speed: 5, moveX: 1 }), m, b);
    expect(b.lower[L.run]).toBeGreaterThan(0.9);
    expect(b.warp).toBeCloseTo(WARP_MAX, 6);
    const back = (deg: number): void => {
      const a = (deg * Math.PI) / 180;
      glbBlend(input({ speed: 4.25, moveX: Math.sin(a), moveZ: Math.cos(a) }), m, b);
    };
    back(180);
    expect(m.back).toBe(true);
    expect(b.lower[L.runRev]).toBeGreaterThan(0.9);
    expect(b.warp).toBeCloseTo(0, 6);
    back(135);
    expect(b.warp).toBeCloseTo(-Math.PI / 4, 5); // back-right: hips turn left, legs run backwards
    // between the thresholds the sector sticks
    back(((BACK_ENTER + BACK_EXIT) / 2) * (180 / Math.PI));
    expect(m.back).toBe(true);
    back(60);
    expect(m.back).toBe(false);
    // slow backwards: the walking backpedal clip
    glbBlend(input({ speed: 1.2, moveZ: -1 }), (() => {
      const mm = newGlbMemory();
      mm.back = true;
      return mm;
    })(), b);
    expect(b.lower[L.walkBack]).toBeGreaterThan(0.5);
  });

  it('sprints with the weapon lowered', () => {
    const b = newGlbBlend();
    glbBlend(input({ speed: 7.5, moveZ: 1, flags: VF_SPRINTING }), newGlbMemory(), b);
    expect(b.lower[L.sprint]).toBeGreaterThan(0.9);
    expect(b.lowered).toBe(1);
    expect(b.upper[U.aim]).toBe(1);
  });

  it('death plays once (start bit on the first frame only), full body, no weapon', () => {
    const m = newGlbMemory();
    const b = newGlbBlend();
    glbBlend(input({ flags: VF_DEAD }), m, b);
    expect(b.lower[L.death]).toBe(1);
    expect(b.start & (1 << L.death)).not.toBe(0);
    expect(b.base).toBe(1);
    expect(b.weaponVisible).toBe(false);
    glbBlend(input({ flags: VF_DEAD }), m, b);
    expect(b.start & (1 << L.death)).toBe(0);
  });

  it('downed: knockdown pose, crawl when moving (turned to the travel), fallbacks when clips are missing', () => {
    const b = newGlbBlend();
    glbBlend(input({ flags: VF_DOWNED }), newGlbMemory(), b);
    expect(b.lower[L.knockdown]).toBe(1);
    const dm = newGlbMemory();
    glbBlend(input({ flags: VF_DOWNED, speed: 1.2, moveZ: 1 }), dm, b);
    expect(b.lower[L.crawl]).toBe(1);
    // the backwards crawl clip plays reversed: its heading (π) turned by π → no turn for a forward crawl
    expect(Math.abs(b.bodyYaw)).toBeCloseTo(0, 5);
    // stays prone once crawling, even when stopping
    glbBlend(input({ flags: VF_DOWNED }), dm, b);
    expect(b.lower[L.crawl]).toBe(1);
    const noKnock = (id: ClipId): boolean => id !== 'knockdown' && id !== 'crawl';
    glbBlend(input({ flags: VF_DOWNED, speed: 1.2, moveZ: 1, has: noKnock }), newGlbMemory(), b);
    expect(b.lower[L.death]).toBe(1);
  });

  it('dodge: roll starts on the rising edge and finishes after the flag drops', () => {
    const m = newGlbMemory();
    const b = newGlbBlend();
    glbBlend(input({ flags: VF_DODGING, speed: 12, moveX: 1 }), m, b);
    expect(b.start & (1 << L.roll)).not.toBe(0);
    expect(b.lower[L.roll]).toBe(1);
    expect(b.bodyYaw).toBeCloseTo(Math.PI / 2, 5);
    for (let i = 0; i < 10; i++) glbBlend(input({ speed: 0 }), m, b);
    expect(b.lower[L.roll]).toBe(1); // still rolling after the 0.35 s dodge
    for (let i = 0; i < 40; i++) glbBlend(input({ speed: 0 }), m, b);
    expect(b.lower[L.roll]).toBe(0);
    expect(b.lower[L.idle]).toBe(1);
  });

  it('upper-body one-shots: reload, cast, melee (style + fallback), hit flinch', () => {
    const b = newGlbBlend();
    glbBlend(input({ flags: VF_RELOADING }), newGlbMemory(), b);
    expect(b.upper[U.reload]).toBe(1);
    expect(b.aim).toBe(0);
    const m = newGlbMemory();
    glbCast(m);
    glbBlend(input(), m, b);
    expect(b.upper[U.cast]).toBe(1);
    expect(b.start & (1 << (16 + U.cast))).not.toBe(0);
    const m2 = newGlbMemory();
    glbMelee(m2, 'heavy');
    glbBlend(input({ hold: 'pole' }), m2, b);
    expect(b.upper[U.meleeHeavy]).toBe(1);
    const m3 = newGlbMemory();
    glbMelee(m3, 'heavy');
    glbBlend(input({ has: (id) => id !== 'meleeHeavy' }), m3, b);
    expect(b.upper[U.meleeThrust]).toBe(1);
    const m4 = newGlbMemory();
    glbHit(m4);
    glbBlend(input(), m4, b);
    expect(b.upper[U.hit]).toBeGreaterThan(0.3);
    expect(b.upper[U.aim]).toBe(1);
    expect(b.flinch).toBeGreaterThan(0.9);
  });

  it('bow, mount, airborne, frozen / stunned, synthesised recoil', () => {
    const b = newGlbBlend();
    glbBlend(input({ hold: 'bow' }), newGlbMemory(), b);
    expect(b.upper[U.bow]).toBe(1);
    glbBlend(input({ hold: 'bow', has: (id) => id !== 'bow' }), newGlbMemory(), b);
    expect(b.upper[U.aim]).toBe(1);
    glbBlend(input({ mounted: true, speed: 6, moveZ: 1 }), newGlbMemory(), b);
    expect(b.lower[L.sit]).toBe(1);
    expect(b.upper[U.aim]).toBe(1);
    glbBlend(input({ flags: VF_AIRBORNE }), newGlbMemory(), b);
    expect(b.lower[L.jump]).toBe(1);
    glbBlend(input({ flags: VF_FROZEN }), newGlbMemory(), b);
    expect(b.timeScale).toBe(0);
    glbBlend(input({ flags: VF_STUNNED }), newGlbMemory(), b);
    expect(b.timeScale).toBeGreaterThan(0);
    expect(b.timeScale).toBeLessThan(1);
    const m = newGlbMemory();
    glbBlend(input({ flags: VF_FIRING }), m, b);
    expect(b.recoil).toBeGreaterThan(0.3);
  });
});

// ── two-bone reach ─────────────────────────────────────────────────────────

describe('twoBoneReach', () => {
  const apply = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, root: THREE.Quaternion, mid: THREE.Quaternion): THREE.Vector3 => {
    const c1 = c.clone().sub(b).applyQuaternion(mid).add(b);
    return c1.sub(a).applyQuaternion(root).add(a);
  };
  it('puts the end effector on a reachable target', () => {
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(0.3, -0.05, 0.02);
    const c = new THREE.Vector3(0.55, 0.05, 0.1);
    const t = new THREE.Vector3(0.2, 0.25, 0.3);
    const r = new THREE.Quaternion();
    const m = new THREE.Quaternion();
    expect(twoBoneReach(a, b, c, t, r, m)).toBe(true);
    expect(apply(a, b, c, r, m).distanceTo(t)).toBeLessThan(1e-4);
  });
  it('points the extended arm at an unreachable target', () => {
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(0, -0.3, 0);
    const c = new THREE.Vector3(0.1, -0.5, 0);
    const t = new THREE.Vector3(2, 0, 0);
    const r = new THREE.Quaternion();
    const m = new THREE.Quaternion();
    expect(twoBoneReach(a, b, c, t, r, m)).toBe(false);
    const end = apply(a, b, c, r, m);
    expect(end.clone().normalize().dot(new THREE.Vector3(1, 0, 0))).toBeGreaterThan(0.999);
  });
});

// ── assets / scale ─────────────────────────────────────────────────────────

describe('model paths and scale', () => {
  it('maps troops and NPCs to their model files', () => {
    expect(troopModelPath({ kingdom: 'wei' })).toBe('assets/models/troops/wei.glb');
    expect(troopModelPath({ kingdom: undefined })).toBe('assets/models/troops/qun.glb');
    expect(troopModelPath({ headgear: 'turban', kingdom: 'qun' })).toBe('assets/models/troops/npc_yellowTurban.glb');
    expect(troopModelPath({ headgear: 'featherCrown' })).toBe('assets/models/troops/npc_barbarian.glb');
    const paths = matchModelPaths(['guanyu', 'nobody']);
    expect(paths).toContain('assets/models/heroes/guanyu.glb');
    expect(paths.some((p) => p.includes('nobody'))).toBe(false);
    for (const k of ['shu', 'wei', 'wu', 'qun', 'npc_yellowTurban', 'npc_barbarian']) expect(paths).toContain(`assets/models/troops/${k}.glb`);
  });

  it('builds a far LOD that shares the vertex buffers with fewer triangles', async () => {
    const geo = new THREE.SphereGeometry(1, 64, 48);
    const lod = await buildLod(geo, 0.25);
    expect(lod).not.toBeNull();
    expect(lod!.getAttribute('position')).toBe(geo.getAttribute('position'));
    expect(lod!.index!.count).toBeLessThan(geo.index!.count * 0.5);
    expect(lod!.index!.count % 3).toBe(0);
  });

  it('normalises by the median of box / head / hips estimates', () => {
    // a typical model: every estimate agrees
    expect(normalizeScale({ bboxH: 1.7, hipsY: 0.925, headY: 1.516, headTopY: 1.7 }, 1.8)).toBeCloseTo(1.8 / 1.7, 2);
    // a tall plume inflates the box: the joints win
    const plumed = normalizeScale({ bboxH: 1.7, hipsY: 0.8, headY: 1.216, headTopY: 1.37 }, 1.8);
    expect(plumed).toBeGreaterThan(1.2);
    // a misplaced neck joint alone does not blow the scale up
    const neck = normalizeScale({ bboxH: 1.7, hipsY: 0.968, headY: 1.1, headTopY: 1.7 }, 1.8);
    expect(neck).toBeLessThan(1.1);
  });
});

// ── synthetic rig: GlbBody + GlbAnimator ────────────────────────────────────

function syntheticTemplate(): CharTemplate {
  const defs: [string, string | null, number, number, number][] = [
    ['Hips', null, 0, 95, 0],
    ['Spine02', 'Hips', 0, 12, 0],
    ['Spine01', 'Spine02', 0, 13, 0],
    ['Spine', 'Spine01', 0, 13, 0],
    ['neck', 'Spine', 0, 12, 0],
    ['Head', 'neck', 0, 7, 0],
    ['head_end', 'Head', 0, 15, 0],
    ['headfront', 'Head', 0, 5, 8],
  ];
  for (const [s, sx] of [
    ['Left', 1],
    ['Right', -1],
  ] as const) {
    defs.push([`${s}Shoulder`, 'Spine', 4 * sx, 10, 0], [`${s}Arm`, `${s}Shoulder`, 12 * sx, 0, 0], [`${s}ForeArm`, `${s}Arm`, 26 * sx, 0, 0], [`${s}Hand`, `${s}ForeArm`, 24 * sx, 0, 0]);
    defs.push([`${s}UpLeg`, 'Hips', 10 * sx, -5, 0], [`${s}Leg`, `${s}UpLeg`, 0, -42, 0], [`${s}Foot`, `${s}Leg`, 0, -40, 0], [`${s}ToeBase`, `${s}Foot`, 0, -6, 12]);
  }
  const bones = new Map<string, THREE.Bone>();
  for (const [n, p, x, y, z] of defs) {
    const b = new THREE.Bone();
    b.name = n;
    b.position.set(x, y, z);
    bones.set(n, b);
    if (p) bones.get(p)!.add(b);
  }
  const scene = new THREE.Group();
  const armature = new THREE.Group();
  armature.name = 'Armature';
  armature.scale.setScalar(0.01);
  scene.add(armature);
  armature.add(bones.get('Hips')!);
  const list = [...bones.values()];
  const pos: number[] = [];
  const si: number[] = [];
  const sw: number[] = [];
  armature.updateMatrixWorld(true);
  list.forEach((b, i) => {
    const w = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).divideScalar(0.01);
    pos.push(w.x, w.y, w.z);
    si.push(i, 0, 0, 0);
    sw.push(1, 0, 0, 0);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.SkinnedMesh(geo, material);
  armature.add(mesh);
  mesh.bind(new THREE.Skeleton(list));
  const rest = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
  for (const b of list) rest.set(b.name, { p: b.position.clone(), q: b.quaternion.clone() });
  return {
    url: 'test',
    scene,
    mesh,
    material,
    rest,
    unit: 0.01,
    landmarks: { bboxH: 1.7, hipsY: 0.95, headY: 1.52, headTopY: 1.67 },
    cloneScene: (o) => skeletonClone(o),
    lod: null,
  };
}

function syntheticClips(): Partial<Record<ClipId, PreparedClip>> {
  const still = (name: string, extra: THREE.QuaternionKeyframeTrack[] = []): PreparedClip => ({
    name,
    duration: 1,
    rot: extra,
    hips: new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 95, 0, 0, 95, 0]),
    hipsRest: new THREE.Vector3(0, 95, 0),
  });
  // aimed pose: right hand at the chest, left hand forward (the gun line points forward-left)
  const fwd = (deg: number): number[] => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180).toArray();
  const aim = still('aim', [
    new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', [0, 1], [...fwd(-80), ...fwd(-80)]),
    new THREE.QuaternionKeyframeTrack('RightArm.quaternion', [0, 1], [...fwd(60), ...fwd(60)]),
  ]);
  const swing = (a: number): number[] => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a).toArray();
  const run = still('run', [
    new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', [0, 0.5, 1], [...swing(-0.5), ...swing(0.5), ...swing(-0.5)]),
    new THREE.QuaternionKeyframeTrack('RightUpLeg.quaternion', [0, 0.5, 1], [...swing(0.5), ...swing(-0.5), ...swing(0.5)]),
  ]);
  return { idle: still('idle'), aim, run, sprint: run, death: still('death'), sit: still('sit'), reload: still('reload') };
}

describe('GlbBody + GlbAnimator on a synthetic rig', () => {
  afterEach(() => setClipsForTests(null));

  it('holds the weapon in the right hand, aims it along the pitch, stays finite, disposes', () => {
    setClipsForTests(syntheticClips());
    const tpl = syntheticTemplate();
    const body = new GlbBody(tpl, 1.8);
    const root = new THREE.Group();
    root.add(body.group);
    body.setWeapon('carbine', 'rifle', false);
    const fi = { dt: 1 / 30, speed: 0, moveX: 0, moveZ: 0, pitch: 0.4, flags: 0, hold: 'rifle' as const, mounted: false, meleeStyle: 'thrust' as const, mountHip: 0, mountBob: 0, reloadTime: 2 };
    for (let i = 0; i < 30; i++) body.update(fi);
    root.updateMatrixWorld(true);
    const muzzle = new THREE.Vector3();
    expect(body.muzzleWorld(muzzle)).toBe(true);
    const hand = new THREE.Vector3();
    expect(body.boneWorld('RightHand', hand)).toBe(true);
    const dir = muzzle.clone().sub(hand).normalize();
    // the game's forward is −Z; aiming 0.4 rad up
    expect(dir.z).toBeLessThan(-0.7);
    expect(Math.asin(dir.y)).toBeGreaterThan(0.25);
    expect(Math.asin(dir.y)).toBeLessThan(0.55);
    // running + dying never produce NaNs, the corpse keeps no weapon
    for (let i = 0; i < 20; i++) body.update({ ...fi, speed: 5, moveX: 0.6, moveZ: 0.8 });
    for (let i = 0; i < 20; i++) body.update({ ...fi, flags: VF_DEAD });
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) for (const v of o.quaternion.toArray()) expect(Number.isFinite(v)).toBe(true);
    });
    expect(body.muzzleWorld(muzzle)).toBe(false);
    // sensible scale: ~1.8 m tall
    expect(body.headTop()).toBeGreaterThan(1.6);
    expect(body.headTop()).toBeLessThan(2);
    body.dispose();
    expect(body.group.parent).toBeNull();
    // the instance released its template (nothing loaded through the cache here, so nothing to evict)
    retainTemplate(tpl);
    releaseTemplate(tpl);
    expect(evictUnusedTemplates()).toBe(0);
  });

  it('CharacterRig stays procedural when the deploy ships no model (and never throws)', async () => {
    setAssetListForTests([]);
    setClipsForTests(syntheticClips());
    const rig = new CharacterRig(heroSpec('guanyu'));
    rig.setWeapon('qinglong');
    expect(rig.usesGlb).toBe(false);
    // no listing / file in unit tests: stays procedural and never throws
    rig.useGlb('assets/models/heroes/guanyu.glb');
    await new Promise((r) => setTimeout(r, 10));
    rig.update(1 / 30, 0, { speed: 0, moveX: 0, moveZ: 0, pitch: 0, flags: 0 });
    expect(rig.usesGlb).toBe(false);
    expect(rig.mesh.visible).toBe(true);
    rig.dispose();
    setAssetListForTests(null);
  });
});
