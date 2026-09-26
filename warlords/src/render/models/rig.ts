// Humanoid skeleton shared by every hero / troop / NPC. Characters are rigidly
// skinned (each vertex belongs to exactly one bone), so a whole character is a
// single SkinnedMesh draw call. Model space: feet at y=0, facing −Z, right=+X.
import * as THREE from 'three';
import type { BodyType } from '../../data/types';

export const BONES = [
  'root',
  'hips',
  'spine',
  'chest',
  'head',
  'armUL',
  'armLL',
  'handL',
  'armUR',
  'armLR',
  'handR',
  'legUL',
  'legLL',
  'footL',
  'legUR',
  'legLR',
  'footR',
  'weapon',
  'weaponL',
  'cape',
  'plume',
  'backOrn',
] as const;
export type BoneName = (typeof BONES)[number];
export const BONE_COUNT = BONES.length;
export const B = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;

const PARENT: Record<BoneName, BoneName | null> = {
  root: null,
  hips: 'root',
  spine: 'hips',
  chest: 'spine',
  head: 'chest',
  armUL: 'chest',
  armLL: 'armUL',
  handL: 'armLL',
  armUR: 'chest',
  armLR: 'armUR',
  handR: 'armLR',
  legUL: 'hips',
  legLL: 'legUL',
  footL: 'legLL',
  legUR: 'hips',
  legLR: 'legUR',
  footR: 'legLR',
  weapon: 'chest',
  weaponL: 'chest',
  cape: 'chest',
  plume: 'head',
  backOrn: 'chest',
};
export const boneParent = (n: BoneName): BoneName | null => PARENT[n];

/** Body proportions (metres, model space). */
export interface BodyDims {
  h: number; // height scale
  w: number; // width scale
  depth: number; // torso depth scale
  headScale: number;
  hipY: number;
  kneeY: number;
  ankleY: number;
  spineY: number;
  chestY: number;
  shoulderY: number;
  neckY: number;
  headCY: number;
  shoulderX: number;
  hipX: number;
  elbowY: number;
  wristY: number;
  belly: number; // 0..1 belly bulge
  female: boolean;
}

export function bodyDims(body: BodyType, female: boolean, scale = 1): BodyDims {
  const table: Record<BodyType, { h: number; w: number; d: number; belly: number }> = {
    slim: { h: 0.99, w: 0.9, d: 0.92, belly: 0 },
    normal: { h: 1, w: 1, d: 1, belly: 0 },
    heavy: { h: 1.02, w: 1.14, d: 1.12, belly: 0.5 },
    huge: { h: 1.1, w: 1.3, d: 1.25, belly: 0.8 },
  };
  const t = table[body] ?? table.normal;
  const h = t.h * (female ? 0.96 : 1) * scale;
  const w = t.w * (female ? 0.86 : 1) * scale;
  const shoulderY = 1.45 * h;
  const elbowY = shoulderY - 0.28 * h;
  return {
    h,
    w,
    depth: t.d * (female ? 0.92 : 1) * scale,
    headScale: 1.08 * scale * (female ? 0.97 : 1),
    hipY: 0.95 * h,
    kneeY: 0.5 * h,
    ankleY: 0.09 * h,
    spineY: 1.05 * h,
    chestY: 1.24 * h,
    shoulderY,
    neckY: 1.5 * h,
    headCY: 1.645 * h,
    shoulderX: 0.2 * w + (body === 'huge' ? 0.02 : 0),
    hipX: 0.095 * w,
    elbowY,
    wristY: elbowY - 0.25 * h,
    belly: t.belly,
    female,
  };
}

/** Model-space rest position of every bone. */
export function restPositions(d: BodyDims): THREE.Vector3[] {
  const p: Record<BoneName, [number, number, number]> = {
    root: [0, 0, 0],
    hips: [0, d.hipY, 0],
    spine: [0, d.spineY, 0],
    chest: [0, d.chestY, 0],
    head: [0, d.neckY, 0],
    armUL: [-d.shoulderX, d.shoulderY, 0],
    armLL: [-d.shoulderX, d.elbowY, 0],
    handL: [-d.shoulderX, d.wristY, 0],
    armUR: [d.shoulderX, d.shoulderY, 0],
    armLR: [d.shoulderX, d.elbowY, 0],
    handR: [d.shoulderX, d.wristY, 0],
    legUL: [-d.hipX, d.hipY - 0.02, 0],
    legLL: [-d.hipX, d.kneeY, 0],
    footL: [-d.hipX, d.ankleY, 0],
    legUR: [d.hipX, d.hipY - 0.02, 0],
    legLR: [d.hipX, d.kneeY, 0],
    footR: [d.hipX, d.ankleY, 0],
    weapon: [0.13 * d.w, d.chestY + 0.02, -0.28],
    weaponL: [-0.13 * d.w, d.chestY + 0.02, -0.28],
    cape: [0, d.shoulderY - 0.02, 0.12 * d.depth],
    // root of tall head ornaments (吕布's pheasant feathers): shortened for the local TPS view
    plume: [0, d.headCY + 0.14 * d.headScale, -0.06],
    // root of tall back ornaments (靠旗 back flags): shortened for the local TPS view
    backOrn: [0, d.chestY + 0.05, 0.13 * d.depth],
  };
  return BONES.map((n) => new THREE.Vector3(...p[n]));
}

/** Create the bone hierarchy (identity rotations = bind pose). */
export function createSkeleton(d: BodyDims): { bones: THREE.Bone[]; rest: THREE.Vector3[]; skeleton: THREE.Skeleton } {
  const rest = restPositions(d);
  const bones = BONES.map((n) => {
    const b = new THREE.Bone();
    b.name = n;
    return b;
  });
  BONES.forEach((n, i) => {
    const par = PARENT[n];
    if (par) {
      const pi = B[par];
      bones[pi].add(bones[i]);
      bones[i].position.subVectors(rest[i], rest[pi]);
    } else bones[i].position.copy(rest[i]);
  });
  bones[0].updateMatrixWorld(true);
  return { bones, rest, skeleton: new THREE.Skeleton(bones) };
}

/** Local (parent-relative) rest offsets for each bone. */
export function localRest(rest: THREE.Vector3[]): THREE.Vector3[] {
  return BONES.map((n, i) => {
    const par = PARENT[n];
    return par ? rest[i].clone().sub(rest[B[par]]) : rest[i].clone();
  });
}
