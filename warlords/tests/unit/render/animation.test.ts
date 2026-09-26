import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VF_DANCING, VF_DEAD, VF_DODGING, VF_DOWNED, VF_RELOADING, VF_STUNNED } from '../../../src/core/types';
import { solveTwoBone } from '../../../src/render/anim/ik';
import { CharacterAnimator, type AnimInput } from '../../../src/render/anim/animator';
import { CharacterRig } from '../../../src/render/models/character';
import { heroSpec } from '../../../src/render/models';
import { B } from '../../../src/render/models/rig';

const input = (flags: number, over: Partial<AnimInput> = {}): AnimInput => ({
  dt: 1 / 30,
  time: 0,
  speed: 0,
  moveX: 0,
  moveZ: 0,
  pitch: 0,
  flags,
  hold: 'rifle',
  mountHip: 0,
  mountBob: 0,
  leftHandBusy: false,
  akimbo: false,
  ...over,
});

const run = (a: CharacterAnimator, flags: number, seconds: number, over: Partial<AnimInput> = {}): void => {
  for (let t = 0; t < seconds; t += 1 / 30) a.update(input(flags, { time: t, ...over }));
};

describe('two-bone IK', () => {
  it('places the wrist on reachable targets', () => {
    const S = new THREE.Vector3(0.2, 0.2, 0);
    const l1 = 0.28;
    const l2 = 0.25;
    const qu = new THREE.Quaternion();
    const ql = new THREE.Quaternion();
    for (const T of [new THREE.Vector3(0.1, 0, -0.35), new THREE.Vector3(-0.1, 0.25, -0.3), new THREE.Vector3(0.3, -0.2, -0.1)]) {
      solveTwoBone(S, T, new THREE.Vector3(0.7, -1, 0.35), l1, l2, qu, ql);
      // forward kinematics: bones point along local −Y
      const elbow = S.clone().add(new THREE.Vector3(0, -l1, 0).applyQuaternion(qu));
      const wrist = elbow.clone().add(new THREE.Vector3(0, -l2, 0).applyQuaternion(qu.clone().multiply(ql)));
      expect(wrist.distanceTo(T)).toBeLessThan(1e-4);
    }
  });

  it('extends straight toward out-of-reach targets', () => {
    const S = new THREE.Vector3();
    const T = new THREE.Vector3(0, 0, -2);
    const qu = new THREE.Quaternion();
    const ql = new THREE.Quaternion();
    solveTwoBone(S, T, new THREE.Vector3(1, -1, 0), 0.3, 0.3, qu, ql);
    const wrist = new THREE.Vector3(0, -0.3, 0).applyQuaternion(qu).add(new THREE.Vector3(0, -0.3, 0).applyQuaternion(qu.clone().multiply(ql)));
    expect(wrist.z).toBeLessThan(-0.59);
  });
});

describe('CharacterAnimator', () => {
  it('blends into downed and hides the weapon', () => {
    const a = new CharacterAnimator();
    run(a, VF_DOWNED, 1);
    expect(a.w.downed).toBeGreaterThan(0.95);
    expect(a.weaponVisible).toBe(false);
    run(a, 0, 1.5);
    expect(a.w.downed).toBeLessThan(0.05);
    expect(a.weaponVisible).toBe(true);
  });

  it('plays the death fall on a timer and stays down', () => {
    const a = new CharacterAnimator();
    run(a, VF_DEAD, 0.2);
    expect(a.w.dead).toBeGreaterThan(0);
    expect(a.w.dead).toBeLessThan(1);
    run(a, VF_DEAD, 2);
    expect(a.w.dead).toBe(1);
    expect(a.deadTime).toBeGreaterThan(1);
  });

  it('dodge triggers on the rising edge and completes', () => {
    const a = new CharacterAnimator();
    run(a, VF_DODGING, 0.25);
    expect(a.w.dodge).toBeGreaterThan(0.5);
    run(a, 0, 0.6);
    expect(a.w.dodge).toBeLessThan(0.05);
  });

  it('locomotion weights follow speed and phase advances with distance', () => {
    const a = new CharacterAnimator();
    run(a, 0, 1, { speed: 6.5, moveZ: 1 });
    expect(a.w.move).toBeGreaterThan(0.95);
    expect(a.w.run).toBeGreaterThan(0.8);
    const p0 = a.phase;
    run(a, 0, 0.5, { speed: 6.5, moveZ: 1 });
    expect(a.phase).not.toBe(p0);
  });

  it('reload, stun and dance weights react to flags', () => {
    const a = new CharacterAnimator();
    run(a, VF_RELOADING | VF_STUNNED, 1);
    expect(a.w.reload).toBeGreaterThan(0.9);
    expect(a.w.stun).toBeGreaterThan(0.9);
    run(a, VF_DANCING, 1.5);
    expect(a.w.dance).toBeGreaterThan(0.9);
    expect(a.weaponVisible).toBe(false);
  });

  it('recoil impulses decay', () => {
    const a = new CharacterAnimator();
    a.fire(1);
    a.update(input(0));
    expect(a.w.recoil).toBeGreaterThan(0.5);
    run(a, 0, 1);
    expect(a.w.recoil).toBeLessThan(0.01);
  });
});

describe('CharacterRig', () => {
  it('holds the rifle: right wrist reaches the grip after apply()', () => {
    const rig = new CharacterRig(heroSpec('guanyu'));
    rig.setWeapon('qinglong');
    for (let i = 0; i < 20; i++) rig.update(1 / 30, i / 30, { speed: 0, moveX: 0, moveZ: 0, pitch: 0.3, flags: 0 });
    rig.root.updateMatrixWorld(true);
    const bones = rig.rigBones.bones;
    const wrist = new THREE.Vector3().setFromMatrixPosition(bones[B.handR].matrixWorld);
    const grip = new THREE.Vector3().setFromMatrixPosition(bones[B.weapon].matrixWorld);
    expect(wrist.distanceTo(grip)).toBeLessThan(0.02);
    const muzzle = new THREE.Vector3();
    expect(rig.muzzleWorld(muzzle)).toBe(true);
    // aiming up: muzzle above the grip and in front (−Z)
    expect(muzzle.y).toBeGreaterThan(grip.y);
    expect(muzzle.z).toBeLessThan(grip.z);
    rig.dispose();
  });
});
