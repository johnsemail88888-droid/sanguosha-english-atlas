// Shared helpers for the procedural character builders (humanoid, headgear,
// extras). Kept separate to avoid import cycles.
import * as THREE from 'three';
import { GeoBuilder, PRIM, segmentMatrix, trs, type ColorLike } from '../core/geo';

import type { BodyDims, BoneName } from './rig';
import type { CharacterSpec } from './humanoid';

export const BOOT = '#2b221b';
export const LEATHER = '#5a3f28';
export const EYE = '#17110d';
export const GOLD = '#d8ac4c';

export interface BodyCtx {
  b: GeoBuilder;
  d: BodyDims;
  s: CharacterSpec;
  armored: boolean;
  robed: boolean;
  bare: boolean;
  /** select the bone subsequent geometry is skinned to */
  on(bone: BoneName): BodyCtx;
  v(x: number, y: number, z: number): THREE.Vector3;
}

/** Tapered cylinder from a (radius rA) to b (radius rB). */
export function frustum(c: BodyCtx, a: THREE.Vector3, bb: THREE.Vector3, rA: number, rB: number, color: ColorLike, seg = 7): void {
  const ratio = Math.round((rB / Math.max(1e-4, rA)) * 50) / 50;
  c.b.add(PRIM.cyl(seg, ratio), segmentMatrix(a, bb, rA), color);
}

/** Low-poly ball (optionally squashed vertically). */
export function ball(c: BodyCtx, x: number, y: number, z: number, r: number, color: ColorLike, sy = 1): void {
  c.b.add(PRIM.sphere(8, 6), trs(x, y, z, 0, 0, 0, r, r * sy, r), color);
}

/** Flat strip (ribbon / feather / cloth) along a polyline, width tapering w0→w1, thickness t. */
export function strip(
  c: BodyCtx,
  pts: THREE.Vector3[],
  w0: number,
  w1: number,
  t: number,
  color: ColorLike | ((i: number) => ColorLike),
  side = new THREE.Vector3(1, 0, 0),
): void {
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const w = w0 + (w1 - w0) * ((i + 0.5) / n);
    // box oriented along a→b with its width along `side`
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-5) continue;
    dir.normalize();
    const s = side.clone().sub(dir.clone().multiplyScalar(side.dot(dir)));
    if (s.lengthSq() < 1e-6) s.set(0, 0, 1);
    s.normalize();
    const nrm = new THREE.Vector3().crossVectors(s, dir).normalize();
    const basis = new THREE.Matrix4().makeBasis(s, dir, nrm);
    basis.scale(new THREE.Vector3(w, len * 1.04, t));
    basis.setPosition(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
    c.b.add(PRIM.box(), basis, typeof color === 'function' ? color(i) : color);
  }
}
