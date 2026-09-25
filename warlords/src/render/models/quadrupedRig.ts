// Quadruped skeleton + procedural skin weights for the static AI-art mount
// meshes (models/mounts/horse.glb, elephant.glb: textured, NOT rigged — the
// auto-rigger is biped-only). Pure logic (no GPU): mountGlb.ts turns the
// result into a SkinnedMesh.
//
// Per model a calibration table gives the joints in the file's own model
// coordinates (measured on side / front renders of the shipped meshes), the
// seat point where the rider's hips go, and the rigid regions (saddle, pad,
// howdah, breastplate). The mesh is normalised into rig space — head towards
// −Z (the character's forward), hooves on y = 0, the seat over the origin —
// and the leg columns are re-measured from the vertices (a regenerated mesh
// with slightly different stance still gets its legs right).
//
// Skin weights: every vertex considers the body chain (spine, neck, head,
// tail, trunk, ears) plus the chain of ONE leg — the one of its quadrant (side
// of the midline, in front of / behind the barrel centre) — so legs never pull
// on each other. Weights fall off with the distance to each bone's segment
// divided by the bone's radius (inverse 4th power, top 4 kept). Below the
// elbow / stifle a vertex takes either its leg's chain only (its best bone is a
// leg bone: legs strictly to their own chain) or the body chain only (a tail or
// trunk hanging next to a leg), and a vertex inside a rigid region (saddle,
// pad, howdah, breastplate) is bound 100 % to that region's bone.
import * as THREE from 'three';

export type QuadKind = 'horse' | 'elephant';
export type LegId = 'FL' | 'FR' | 'BL' | 'BR';
export const LEG_IDS: readonly LegId[] = ['FL', 'FR', 'BL', 'BR'];

type V3 = readonly [number, number, number];

/** One bone: pivot at `at`; its skin segment runs from `seg[0]` to `seg[1]` (joint names or points), radius r. */
export interface QuadBoneSpec {
  name: string;
  parent: string | null;
  /** pivot (joint name) */
  at: string;
  /** skinning segment (joint names) */
  seg: readonly [string, string];
  /** thickness of the body part around the segment (model units) */
  r: number;
  /** leg chain membership (upper … hoof order in the chain) */
  leg?: LegId;
}

export interface QuadCalib {
  kind: QuadKind;
  /** direction of the head in the file's coordinates along Z (+1: +Z) */
  head: 1 | -1;
  /** top of the saddle seat / howdah pad (model units): the rider's hips go right above it */
  seat: V3;
  /** named joints, model units (for head = +1 the left legs are at +x in the file) */
  joints: Record<string, V3>;
  bones: readonly QuadBoneSpec[];
  /** vertices inside these boxes (model units, min / max) are bound to `bone` only */
  rigid: readonly { bone: string; min: V3; max: V3 }[];
  /** coat recolour regions (model units): tack boxes kept, lower-leg band, forehead blaze */
  regions: {
    tack: readonly { min: V3; max: V3 }[];
    /** hooves / feet below this height are never recoloured */
    hoofY: number;
    /** lower-leg band: from `bottom` up to the front knee / hind hock */
    legs: { bottom: number; front: number; hind: number };
    blaze: { c: V3; r: V3 } | null;
  };
}

const leg = (id: LegId, parent: string, names: readonly string[], radii: readonly number[]): QuadBoneSpec[] => {
  // names: joints top → ground, 5 joints → 4 bones (u, l, c, h)
  const out: QuadBoneSpec[] = [];
  const suffix = ['u', 'l', 'c', 'h'];
  for (let i = 0; i < names.length - 1; i++) {
    out.push({ name: `${id}${suffix[i]}`, parent: i === 0 ? parent : `${id}${suffix[i - 1]}`, at: names[i], seg: [names[i], names[i + 1]], r: radii[i], leg: id });
  }
  return out;
};

const legJoints = (id: LegId, pts: readonly V3[]): Record<string, V3> => Object.fromEntries(pts.map((p, i) => [`${id}${i}`, p]));
const mirror = (pts: readonly V3[]): V3[] => pts.map(([x, y, z]) => [-x, y, z] as const);

/**
 * War horse (models/mounts/horse.glb as shipped: 1.9 long, head +Z, bay coat,
 * lacquered saddle, breastplate). File units; these are the right legs (−x:
 * facing +Z the animal's right is −X), the left ones mirror them.
 */
const HORSE_FRONT: V3[] = [
  [-0.1, 0.05, 0.31],
  [-0.085, -0.13, 0.166],
  [-0.08, -0.342, 0.212],
  [-0.08, -0.626, 0.2],
  [-0.08, -0.746, 0.25],
];
const HORSE_HIND: V3[] = [
  [-0.12, 0.12, -0.64],
  [-0.11, -0.16, -0.66],
  [-0.11, -0.3, -0.765],
  [-0.11, -0.64, -0.755],
  [-0.11, -0.746, -0.72],
];

export const HORSE_CALIB: QuadCalib = {
  kind: 'horse',
  head: 1,
  seat: [0, 0.387, -0.11],
  joints: {
    barrel: [0, 0.13, -0.05],
    pelvis: [0, 0.27, -0.45],
    rump: [0, 0.29, -0.8],
    chest: [0, 0.24, 0.14],
    neck0: [0, 0.3, 0.36],
    neck1: [0, 0.47, 0.52],
    poll: [0, 0.64, 0.71],
    muzzle: [0, 0.43, 0.93],
    tail0: [0, 0.29, -0.83],
    tail1: [0, 0.02, -0.93],
    tail2: [0, -0.42, -0.92],
    ...legJoints('FL', mirror(HORSE_FRONT)),
    ...legJoints('FR', HORSE_FRONT),
    ...legJoints('BL', mirror(HORSE_HIND)),
    ...legJoints('BR', HORSE_HIND),
  },
  bones: [
    { name: 'root', parent: null, at: 'root', seg: ['barrel', 'barrel'], r: 0 },
    { name: 'body', parent: 'root', at: 'barrel', seg: ['pelvis', 'chest'], r: 0.26 },
    { name: 'pelvis', parent: 'body', at: 'pelvis', seg: ['pelvis', 'rump'], r: 0.24 },
    { name: 'chest', parent: 'body', at: 'chest', seg: ['chest', 'neck0'], r: 0.24 },
    { name: 'neck', parent: 'chest', at: 'neck0', seg: ['neck0', 'neck1'], r: 0.15 },
    { name: 'neck2', parent: 'neck', at: 'neck1', seg: ['neck1', 'poll'], r: 0.11 },
    { name: 'head', parent: 'neck2', at: 'poll', seg: ['poll', 'muzzle'], r: 0.1 },
    { name: 'tail', parent: 'pelvis', at: 'tail0', seg: ['tail0', 'tail1'], r: 0.07 },
    { name: 'tail2', parent: 'tail', at: 'tail1', seg: ['tail1', 'tail2'], r: 0.06 },
    ...leg('FL', 'chest', ['FL0', 'FL1', 'FL2', 'FL3', 'FL4'], [0.08, 0.045, 0.035, 0.04]),
    ...leg('FR', 'chest', ['FR0', 'FR1', 'FR2', 'FR3', 'FR4'], [0.08, 0.045, 0.035, 0.04]),
    ...leg('BL', 'pelvis', ['BL0', 'BL1', 'BL2', 'BL3', 'BL4'], [0.1, 0.055, 0.035, 0.04]),
    ...leg('BR', 'pelvis', ['BR0', 'BR1', 'BR2', 'BR3', 'BR4'], [0.1, 0.055, 0.035, 0.04]),
  ],
  rigid: [
    // saddle, pad, stirrups and girth ride on the barrel
    { bone: 'body', min: [-0.34, -0.16, -0.34], max: [0.34, 0.56, 0.135] },
    // the lamellar breastplate hangs from the chest (spans both front legs)
    { bone: 'chest', min: [-0.26, -0.09, 0.3], max: [0.26, 0.16, 0.48] },
  ],
  regions: {
    tack: [{ min: [-0.3, 0.075, -0.34], max: [0.3, 0.56, 0.135] }],
    hoofY: -0.705,
    legs: { bottom: -0.705, front: -0.342, hind: -0.3 },
    blaze: { c: [0, 0.585, 0.86], r: [0.03, 0.065, 0.08] },
  },
};

/** Nanman war elephant (models/mounts/elephant.glb: rattan pad + small howdah, head +Z; right legs as above). */
const ELE_FRONT: V3[] = [
  [-0.2, 0.15, 0.09],
  [-0.18, -0.2, 0.04],
  [-0.17, -0.5, 0.06],
  [-0.165, -0.716, 0.1],
];
const ELE_HIND: V3[] = [
  [-0.2, 0.15, -0.62],
  [-0.16, -0.38, -0.69],
  [-0.15, -0.6, -0.72],
  [-0.14, -0.716, -0.7],
];

export const ELEPHANT_CALIB: QuadCalib = {
  kind: 'elephant',
  head: 1,
  seat: [0, 0.57, -0.27],
  joints: {
    barrel: [0, 0.15, -0.3],
    pelvis: [0, 0.2, -0.62],
    rump: [0, 0.25, -0.9],
    chest: [0, 0.2, 0.08],
    neck0: [0, 0.25, 0.3],
    brow: [0, 0.35, 0.52],
    trunk0: [0, 0.13, 0.62],
    trunk1: [0, -0.08, 0.675],
    trunk2: [0, -0.29, 0.67],
    trunk3: [0, -0.5, 0.655],
    trunk4: [0, -0.62, 0.57],
    earL0: [-0.3, 0.42, 0.31],
    earL1: [-0.45, 0.3, 0.18],
    earR0: [0.3, 0.42, 0.31],
    earR1: [0.45, 0.3, 0.18],
    tail0: [0, 0.3, -0.92],
    tail1: [0, -0.05, -0.94],
    tail2: [0, -0.42, -0.93],
    ...legJoints('FL', mirror(ELE_FRONT)),
    ...legJoints('FR', ELE_FRONT),
    ...legJoints('BL', mirror(ELE_HIND)),
    ...legJoints('BR', ELE_HIND),
  },
  bones: [
    { name: 'root', parent: null, at: 'root', seg: ['barrel', 'barrel'], r: 0 },
    { name: 'body', parent: 'root', at: 'barrel', seg: ['pelvis', 'chest'], r: 0.42 },
    { name: 'pelvis', parent: 'body', at: 'pelvis', seg: ['pelvis', 'rump'], r: 0.36 },
    { name: 'chest', parent: 'body', at: 'chest', seg: ['chest', 'neck0'], r: 0.36 },
    { name: 'head', parent: 'chest', at: 'neck0', seg: ['neck0', 'brow'], r: 0.24 },
    { name: 'trunk1', parent: 'head', at: 'trunk0', seg: ['trunk0', 'trunk1'], r: 0.09 },
    { name: 'trunk2', parent: 'trunk1', at: 'trunk1', seg: ['trunk1', 'trunk2'], r: 0.075 },
    { name: 'trunk3', parent: 'trunk2', at: 'trunk2', seg: ['trunk2', 'trunk3'], r: 0.065 },
    { name: 'trunk4', parent: 'trunk3', at: 'trunk3', seg: ['trunk3', 'trunk4'], r: 0.06 },
    { name: 'earL', parent: 'head', at: 'earL0', seg: ['earL0', 'earL1'], r: 0.12 },
    { name: 'earR', parent: 'head', at: 'earR0', seg: ['earR0', 'earR1'], r: 0.12 },
    { name: 'tail', parent: 'pelvis', at: 'tail0', seg: ['tail0', 'tail1'], r: 0.05 },
    { name: 'tail2', parent: 'tail', at: 'tail1', seg: ['tail1', 'tail2'], r: 0.05 },
    ...leg('FL', 'chest', ['FL0', 'FL1', 'FL2', 'FL3'], [0.16, 0.12, 0.12]),
    ...leg('FR', 'chest', ['FR0', 'FR1', 'FR2', 'FR3'], [0.16, 0.12, 0.12]),
    ...leg('BL', 'pelvis', ['BL0', 'BL1', 'BL2', 'BL3'], [0.17, 0.12, 0.12]),
    ...leg('BR', 'pelvis', ['BR0', 'BR1', 'BR2', 'BR3'], [0.17, 0.12, 0.12]),
  ],
  rigid: [
    // rattan pad, blanket, howdah frame and bells ride on the barrel
    { bone: 'body', min: [-0.5, -0.02, -0.6], max: [0.5, 0.75, 0.02] },
  ],
  regions: {
    tack: [],
    hoofY: -0.69,
    legs: { bottom: -0.69, front: -0.5, hind: -0.38 },
    blaze: null,
  },
};

export const QUAD_CALIB: Record<QuadKind, QuadCalib> = { horse: HORSE_CALIB, elephant: ELEPHANT_CALIB };

// ── normalisation ───────────────────────────────────────────────────────────

/**
 * Model → rig transform: head to −Z, lowest vertex on y = 0, the seat over
 * the origin, uniform scale so the seat top (`seatTop`, model units: see
 * measureSeatTop) is `seatHeight` rig units up. `minY` is the model's lowest
 * vertex (the hooves).
 */
export function mountRigMatrix(calib: QuadCalib, minY: number, seatHeight: number, seatTop = calib.seat[1]): THREE.Matrix4 {
  const s = seatHeight / Math.max(1e-6, seatTop - minY);
  const turn = calib.head === 1 ? Math.PI : 0; // head +Z → −Z
  const m = new THREE.Matrix4().makeScale(s, s, s);
  m.multiply(new THREE.Matrix4().makeRotationY(turn));
  m.multiply(new THREE.Matrix4().makeTranslation(-calib.seat[0], -minY, -calib.seat[2]));
  return m;
}

/**
 * Top of the seat measured on the mesh: the highest vertex within 6 cm (model
 * units) of the calibrated seat point horizontally and 0.12 of it vertically
 * (the cantle / pommel / howdah rails around it are higher and further out).
 * Falls back to the calibration.
 */
export function measureSeatTop(pos: ArrayLike<number>, calib: QuadCalib): number {
  const [sx, sy, sz] = calib.seat;
  let top = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    if (Math.abs(y - sy) > 0.12) continue;
    if (Math.hypot(pos[i] - sx, pos[i + 2] - sz) > 0.06) continue;
    top = Math.max(top, y);
  }
  return Number.isFinite(top) ? top : sy;
}

/** Leg column centre (x, z) near the ground, measured from the vertices (model units), or null. */
export function measureLegColumn(pos: ArrayLike<number>, calib: QuadCalib, id: LegId, minY: number): { x: number; z: number } | null {
  const j = calib.joints;
  const top = j[`${id}0`];
  const foot = j[`${id}${calib.kind === 'horse' ? 4 : 3}`];
  const fetlock = j[`${id}${calib.kind === 'horse' ? 3 : 2}`];
  // band: from a little above the ground to the fetlock / ankle
  const y0 = minY + (fetlock[1] - minY) * 0.35;
  const y1 = fetlock[1];
  const sx = Math.sign(top[0]);
  const midZ = calib.joints.barrel[2];
  const front = id[0] === 'F';
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    if (y < y0 || y > y1 || Math.sign(x) !== sx) continue;
    if ((z - midZ) * calib.head > 0 !== front) continue;
    // stay near the calibrated column (the trunk / tail hang in the same quadrants)
    if (Math.hypot(x - foot[0], z - foot[2]) > 0.2) continue;
    cx += x;
    cz += z;
    n++;
  }
  return n >= 6 ? { x: cx / n, z: cz / n } : null;
}

/**
 * Joints in model units with each leg shifted onto its measured column
 * (whole chain translated horizontally, so the calibrated bends stay).
 */
export function refineJoints(pos: ArrayLike<number>, calib: QuadCalib, minY: number): Record<string, THREE.Vector3> {
  const out: Record<string, THREE.Vector3> = { root: new THREE.Vector3(calib.seat[0], minY, calib.seat[2]) };
  for (const [k, v] of Object.entries(calib.joints)) out[k] = new THREE.Vector3(v[0], v[1], v[2]);
  for (const id of LEG_IDS) {
    const m = measureLegColumn(pos, calib, id, minY);
    if (!m) continue;
    const n = calib.kind === 'horse' ? 4 : 3;
    const foot = calib.joints[`${id}${n}`];
    const dx = Math.max(-0.05, Math.min(0.05, m.x - foot[0]));
    const dz = Math.max(-0.08, Math.min(0.08, m.z - foot[2]));
    for (let i = 0; i <= n; i++) {
      // the top joint moves less: it sits in the body
      const k = i === 0 ? 0.5 : 1;
      out[`${id}${i}`].x += dx * k;
      out[`${id}${i}`].z += dz * k;
    }
  }
  return out;
}

// ── skeleton + weights ──────────────────────────────────────────────────────

export interface QuadBone {
  name: string;
  parent: string | null;
  /** pivot, rig space */
  pos: THREE.Vector3;
  /** skin segment, rig space */
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  leg?: LegId;
}

/** Bones in rig space (joints mapped through `m`, radii scaled). */
export function quadBones(calib: QuadCalib, joints: Record<string, THREE.Vector3>, m: THREE.Matrix4): QuadBone[] {
  const s = new THREE.Vector3().setFromMatrixScale(m).x;
  const at = (n: string): THREE.Vector3 => {
    const j = joints[n];
    if (!j) throw new Error(`quadruped: unknown joint ${n}`);
    return j.clone().applyMatrix4(m);
  };
  return calib.bones.map((b) => ({ name: b.name, parent: b.parent, pos: at(b.at), a: at(b.seg[0]), b: at(b.seg[1]), r: b.r * s, leg: b.leg }));
}

/** Distance from p to the segment a–b. */
export function segmentDistance(px: number, py: number, pz: number, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-12 ? ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (a.x + abx * t);
  const dy = py - (a.y + aby * t);
  const dz = pz - (a.z + abz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface QuadWeights {
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

/**
 * Skin weights for rig-space positions `pos` (see the file header). `rigid`
 * boxes are in rig space too.
 */
export function quadSkinWeights(pos: ArrayLike<number>, bones: readonly QuadBone[], rigid: readonly { bone: string; min: THREE.Vector3; max: THREE.Vector3 }[]): QuadWeights {
  const n = pos.length / 3;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const body = bones.map((b, i) => (b.leg || b.r <= 0 ? -1 : i)).filter((i) => i >= 0);
  const legChain = new Map<LegId, number[]>();
  for (const id of LEG_IDS) legChain.set(id, bones.map((b, i) => (b.leg === id ? i : -1)).filter((i) => i >= 0));
  // quadrant split: the barrel's centre (body bone pivot) and the midline
  const bodyBone = bones[index.get('body') ?? 1];
  const cz = bodyBone.pos.z;
  const cand: number[] = [];
  const score = new Float64Array(bones.length);
  const w = new Float64Array(bones.length);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3];
    const y = pos[v * 3 + 1];
    const z = pos[v * 3 + 2];
    const o = v * 4;
    // rigid regions first
    let rigidBone = -1;
    for (const r of rigid) {
      if (x >= r.min.x && x <= r.max.x && y >= r.min.y && y <= r.max.y && z >= r.min.z && z <= r.max.z) {
        rigidBone = index.get(r.bone) ?? -1;
        break;
      }
    }
    if (rigidBone >= 0) {
      skinIndex[o] = rigidBone;
      skinWeight[o] = 1;
      continue;
    }
    // candidates: the body chain + the chain of this quadrant's leg (rig space: head at −Z, right at +X)
    const id: LegId = `${z < cz ? 'F' : 'B'}${x < 0 ? 'L' : 'R'}` as LegId;
    const chain = legChain.get(id)!;
    cand.length = 0;
    for (const i of body) cand.push(i);
    for (const i of chain) cand.push(i);
    let best = -1;
    let bestS = Infinity;
    for (const i of cand) {
      const b = bones[i];
      const s = segmentDistance(x, y, z, b.a, b.b) / b.r;
      score[i] = s;
      if (s < bestS) {
        bestS = s;
        best = i;
      }
    }
    // below the elbow / stifle a vertex belongs either to that leg's chain only
    // (the leg) or to the body chain only (a tail / trunk hanging next to it)
    const low = chain.length > 1 && y < bones[chain[1]].pos.y;
    const onLeg = bones[best].leg !== undefined;
    let sum = 0;
    for (const i of cand) {
      if (low && onLeg !== (bones[i].leg !== undefined)) {
        w[i] = 0;
        continue;
      }
      const s = Math.max(score[i], 0.05);
      const s2 = s * s;
      w[i] = 1 / (s2 * s2);
      sum += w[i];
    }
    // top 4
    for (let k = 0; k < 4; k++) {
      let bi = -1;
      let bw = 0;
      for (const i of cand) {
        if (w[i] > bw) {
          bw = w[i];
          bi = i;
        }
      }
      if (bi < 0) break;
      skinIndex[o + k] = bi;
      skinWeight[o + k] = bw;
      w[bi] = 0;
    }
    sum = skinWeight[o] + skinWeight[o + 1] + skinWeight[o + 2] + skinWeight[o + 3];
    // drop negligible influences (≤ 2 %) and renormalise
    for (let k = 0; k < 4; k++) if (skinWeight[o + k] / sum < 0.02) skinWeight[o + k] = 0;
    sum = skinWeight[o] + skinWeight[o + 1] + skinWeight[o + 2] + skinWeight[o + 3];
    for (let k = 0; k < 4; k++) skinWeight[o + k] /= sum;
  }
  return { skinIndex, skinWeight };
}
