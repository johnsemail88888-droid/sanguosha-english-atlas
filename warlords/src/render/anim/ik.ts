// Analytic two-bone IK for arms (shoulder → elbow → wrist) in the parent
// (chest) space. Bone convention: rest direction −Y, elbow bends about local
// X with the elbow pointing to local +Z (so the forearm folds toward −Z).
import * as THREE from 'three';

const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qi = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

export interface IkResult {
  /** elbow position (parent space) */
  elbow: THREE.Vector3;
  /** true if the target was out of reach (arm fully extended toward it) */
  clamped: boolean;
}

/**
 * Solve a two-bone chain. Writes the upper bone's local rotation (relative to
 * the parent, assuming an identity bind rotation) into `outUpper` and the lower
 * bone's local rotation (relative to the upper bone) into `outLower`.
 */
export function solveTwoBone(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
  result?: IkResult,
): void {
  _dir.subVectors(target, shoulder);
  let d = _dir.length();
  if (d < 1e-6) {
    _dir.set(0, -1, 0);
    d = 1e-6;
  } else _dir.divideScalar(d);
  const maxD = l1 + l2 - 1e-4;
  const minD = Math.abs(l1 - l2) + 1e-4;
  const clamped = d > maxD;
  d = Math.min(maxD, Math.max(minD, d));
  // pole direction perpendicular to the shoulder→target line
  _n.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_n.lengthSq() < 1e-8) {
    _n.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
    if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0);
  }
  _n.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _e.copy(shoulder).addScaledVector(_dir, a).addScaledVector(_n, h);
  if (result) {
    result.elbow.copy(_e);
    result.clamped = clamped;
  }
  // upper frame: −Y along the upper arm, +Z toward the elbow's outside (pole)
  _u.subVectors(_e, shoulder).normalize();
  _f.copy(shoulder).addScaledVector(_dir, d).sub(_e).normalize(); // forearm dir
  _y.copy(_u).negate();
  _z.copy(_f).addScaledVector(_u, -_f.dot(_u));
  if (_z.lengthSq() < 1e-8) _z.copy(_n);
  else _z.negate().normalize();
  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  outUpper.setFromRotationMatrix(_m);
  // lower: rotation about local X so that (0,−1,0) → forearm dir in upper space
  _qi.copy(outUpper).invert();
  _f.applyQuaternion(_qi);
  const theta = Math.atan2(-_f.z, -_f.y);
  outLower.setFromAxisAngle(X_AXIS, theta);
}

/** Local rotation for a child so that its world (parent-space) rotation equals `desired`, given the chain rotation above it. */
export function localFromDesired(chain: THREE.Quaternion, desired: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.copy(chain).invert().multiply(desired);
}

const _ab = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _hinge = new THREE.Vector3();
const _c2 = new THREE.Vector3();

/**
 * Two-bone reach for rigs with arbitrary bone axes (the GLB characters): from
 * the joint positions `a` (root, e.g. shoulder), `b` (mid, elbow), `c` (end,
 * wrist) and a target `t`, all in one space, returns the rotations IN THAT
 * SPACE to pre-multiply onto the mid bone (`outMid`, about b, applied first)
 * and onto the root bone (`outRoot`, about a) so the end reaches the target —
 * clamped to the chain's reach, bending in the current elbow plane. Returns
 * false when the target is out of reach (the arm points at it, extended).
 */
export function twoBoneReach(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, t: THREE.Vector3, outRoot: THREE.Quaternion, outMid: THREE.Quaternion): boolean {
  _ab.subVectors(a, b);
  _cb.subVectors(c, b);
  const l1 = _ab.length();
  const l2 = _cb.length();
  _ta.subVectors(t, a);
  const dRaw = _ta.length();
  outRoot.identity();
  outMid.identity();
  if (l1 < 1e-6 || l2 < 1e-6 || dRaw < 1e-6) return false;
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, dRaw));
  const cosB0 = Math.max(-1, Math.min(1, _ab.dot(_cb) / (l1 * l2)));
  const cosB1 = Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)));
  _hinge.crossVectors(_cb, _ab);
  if (_hinge.lengthSq() < 1e-10) {
    // straight chain: bend about any axis perpendicular to it and to the target
    _hinge.crossVectors(_ab, _ta);
    if (_hinge.lengthSq() < 1e-10) _hinge.set(1, 0, 0).cross(_ab);
    if (_hinge.lengthSq() < 1e-10) _hinge.set(0, 0, 1);
  }
  _hinge.normalize();
  outMid.setFromAxisAngle(_hinge, Math.acos(cosB0) - Math.acos(cosB1));
  _c2.copy(_cb).applyQuaternion(outMid).add(b);
  _ca.subVectors(_c2, a).normalize();
  outRoot.setFromUnitVectors(_ca, _ta.normalize());
  return dRaw <= l1 + l2;
}
