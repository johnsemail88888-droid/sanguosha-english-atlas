// Pure keyframe-track processing for the shared GLB animation clips
// (public/assets/anim/*.glb, one clip per file, tracks keyed by bone name).
// Node-safe (unit-tested in tests/unit/render/glbAnim.test.ts).
//
// Every clip file is its own auto-rig export, so two things differ per file
// and are normalised here once, independent of the model that plays it:
//   - the Hips joint's rest frame (arbitrary per rig): the Hips rotation track
//     is re-expressed in the canonical identity frame, and the Hips children's
//     tracks absorb the change (models get the same treatment, models/glb.ts
//     canonicaliseHips) → any clip plays on any model by bone name;
//   - bone lengths: only rotation tracks are shared; translation / scale tracks
//     are dropped except the Hips translation (root motion), which is mapped per
//     model (modelHipsTrack) and grounded with a foot-contact FK pass.
import * as THREE from 'three';

/** Bones driven by the upper-body layer (spine chain and above, arms). */
export const UPPER_BONES: ReadonlySet<string> = new Set([
  'Spine02',
  'Spine01',
  'Spine',
  'neck',
  'Head',
  'head_end',
  'headfront',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
]);

/** Bone name of a track ('LeftArm.quaternion' → 'LeftArm'). */
export const trackBone = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i < 0 ? name : name.slice(0, i);
};
/** Property of a track ('LeftArm.quaternion' → 'quaternion'). */
export const trackProp = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1);
};

/** Left ↔ Right bone name swap (for mirrored clips). */
export function mirrorBoneName(bone: string): string {
  if (bone.startsWith('Left')) return `Right${bone.slice(4)}`;
  if (bone.startsWith('Right')) return `Left${bone.slice(5)}`;
  return bone;
}

/** How a clip's Hips translation (root motion) is kept. */
export type RootPolicy =
  /** in-place locomotion: sway around the clip's mean ground position, vertical bob kept */
  | 'loco'
  /** horizontal drift removed (rolls, falls, lunges play on the spot), vertical kept */
  | 'noXZ'
  /** no root motion at all (poses held at the rest hip position) */
  | 'none';

export interface PreparedClip {
  name: string;
  duration: number;
  /** rotation tracks in the canonical Hips frame (shared by every model) */
  rot: THREE.QuaternionKeyframeTrack[];
  /** Hips translation in the source rig's units, root policy applied (null: none) */
  hips: THREE.VectorKeyframeTrack | null;
  /** the source rig's Hips rest position (same units) */
  hipsRest: THREE.Vector3;
}

export interface ClipSource {
  clip: THREE.AnimationClip;
  /** the source rig's Hips rest rotation (local = armature space) */
  hipsRestQ: THREE.Quaternion;
  hipsRestP: THREE.Vector3;
  /** names of the Hips joint's direct children in the source rig */
  hipsChildren: readonly string[];
}

const _q = new THREE.Quaternion();

/** The track's interpolant (three assigns createInterpolant at runtime; the typings omit it). */
export function interpolantOf(tr: THREE.KeyframeTrack): THREE.Interpolant {
  return (tr as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
}

/**
 * Normalise one clip file: canonical Hips frame, rotation tracks only (+ the
 * Hips translation per `policy`), optional [from, to] window (seconds).
 */
export function prepareClip(src: ClipSource, policy: RootPolicy, from = 0, to = Infinity): PreparedClip {
  const H = src.hipsRestQ;
  const Hinv = H.clone().invert();
  const children = new Set(src.hipsChildren);
  const rot: THREE.QuaternionKeyframeTrack[] = [];
  let hips: THREE.VectorKeyframeTrack | null = null;
  // the files' keys start one frame in (1/30 s): the loop is [first key, last key]
  let first = Infinity;
  let last = 0;
  for (const tr of src.clip.tracks) {
    if (!tr.times.length) continue;
    first = Math.min(first, tr.times[0]);
    last = Math.max(last, tr.times[tr.times.length - 1]);
  }
  if (!Number.isFinite(first)) first = 0;
  const t0 = Math.max(first, from);
  const t1 = Math.max(t0 + 1e-3, Math.min(last, to));
  for (const tr of src.clip.tracks) {
    const bone = trackBone(tr.name);
    const prop = trackProp(tr.name);
    if (prop === 'quaternion') {
      const v = Float32Array.from(tr.values);
      if (bone === 'Hips' || children.has(bone)) {
        for (let i = 0; i < v.length; i += 4) {
          _q.fromArray(v, i);
          if (bone === 'Hips') _q.multiply(Hinv);
          else _q.premultiply(H);
          _q.toArray(v, i);
        }
      }
      rot.push(windowTrack(new THREE.QuaternionKeyframeTrack(tr.name, Float32Array.from(tr.times), v), t0, t1) as THREE.QuaternionKeyframeTrack);
    } else if (prop === 'position' && bone === 'Hips') {
      hips = windowTrack(new THREE.VectorKeyframeTrack(tr.name, Float32Array.from(tr.times), Float32Array.from(tr.values)), t0, t1) as THREE.VectorKeyframeTrack;
    }
  }
  if (hips) applyRootPolicy(hips, policy, src.hipsRestP);
  const duration = Math.max(1e-3, t1 - t0);
  return { name: src.clip.name, duration, rot, hips, hipsRest: src.hipsRestP.clone() };
}

/** Keep the keys inside [t0, t1] (plus interpolated end keys), shifted to start at 0. */
export function windowTrack(tr: THREE.KeyframeTrack, t0: number, t1: number): THREE.KeyframeTrack {
  const times = tr.times;
  if (t0 <= (times[0] ?? 0) + 1e-6 && t1 >= (times[times.length - 1] ?? 0) - 1e-6) {
    if (t0 !== 0) tr.shift(-t0);
    return tr;
  }
  const n = tr.getValueSize();
  const interp = interpolantOf(tr);
  const outT: number[] = [];
  const outV: number[] = [];
  const push = (t: number): void => {
    const v = interp.evaluate(t);
    outT.push(t - t0);
    for (let k = 0; k < n; k++) outV.push(v[k]);
  };
  push(t0);
  for (let i = 0; i < times.length; i++) if (times[i] > t0 + 1e-6 && times[i] < t1 - 1e-6) push(times[i]);
  push(t1);
  const Ctor = tr.constructor as new (name: string, times: ArrayLike<number>, values: ArrayLike<number>) => THREE.KeyframeTrack;
  return new Ctor(tr.name, Float32Array.from(outT), Float32Array.from(outV));
}

/** Apply a root policy to a Hips translation track in place. */
export function applyRootPolicy(tr: THREE.VectorKeyframeTrack, policy: RootPolicy, rest: THREE.Vector3): void {
  const v = tr.values;
  const n = v.length / 3;
  if (!n) return;
  if (policy === 'none') {
    for (let i = 0; i < n; i++) {
      v[i * 3] = rest.x;
      v[i * 3 + 1] = rest.y;
      v[i * 3 + 2] = rest.z;
    }
    return;
  }
  let mx = 0;
  let mz = 0;
  if (policy === 'loco') {
    for (let i = 0; i < n; i++) {
      mx += v[i * 3];
      mz += v[i * 3 + 2];
    }
    mx /= n;
    mz /= n;
  }
  for (let i = 0; i < n; i++) {
    if (policy === 'loco') {
      v[i * 3] = rest.x + (v[i * 3] - mx);
      v[i * 3 + 2] = rest.z + (v[i * 3 + 2] - mz);
    } else {
      v[i * 3] = rest.x;
      v[i * 3 + 2] = rest.z;
    }
  }
}

/**
 * Mirror a prepared clip left ↔ right (x → −x): bone names swapped, rotations
 * (x, y, z, w) → (x, −y, −z, w), Hips translation x negated. Valid because the
 * rig's left / right bone frames are mirror images and the Hips frame is canonical.
 */
export function mirrorClip(c: PreparedClip, name: string): PreparedClip {
  const rot = c.rot.map((tr) => {
    const v = Float32Array.from(tr.values);
    for (let i = 0; i < v.length; i += 4) {
      v[i + 1] = -v[i + 1];
      v[i + 2] = -v[i + 2];
    }
    const bone = trackBone(tr.name);
    return new THREE.QuaternionKeyframeTrack(`${mirrorBoneName(bone)}.quaternion`, Float32Array.from(tr.times), v);
  });
  let hips: THREE.VectorKeyframeTrack | null = null;
  if (c.hips) {
    const v = Float32Array.from(c.hips.values);
    for (let i = 0; i < v.length; i += 3) v[i] = -v[i];
    hips = new THREE.VectorKeyframeTrack('Hips.position', Float32Array.from(c.hips.times), v);
  }
  return { name, duration: c.duration, rot, hips, hipsRest: new THREE.Vector3(-c.hipsRest.x, c.hipsRest.y, c.hipsRest.z) };
}

/** Rotation tracks of one layer: upper (spine and above) or lower (hips + legs). */
export function layerTracks(rot: readonly THREE.QuaternionKeyframeTrack[], upper: boolean): THREE.QuaternionKeyframeTrack[] {
  return rot.filter((t) => UPPER_BONES.has(trackBone(t.name)) === upper);
}

/**
 * The Hips translation track for one model: the source motion relative to its
 * rest, scaled by the hip-height ratio, around the model's own rest, lifted by
 * `lift` (ground calibration). Null when the clip has no root track.
 */
export function modelHipsTrack(c: PreparedClip, modelRest: THREE.Vector3, lift: number): THREE.VectorKeyframeTrack | null {
  if (!c.hips) return null;
  const k = c.hipsRest.y > 1e-6 ? modelRest.y / c.hipsRest.y : 1;
  const src = c.hips.values;
  const v = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    v[i] = modelRest.x + (src[i] - c.hipsRest.x) * k;
    v[i + 1] = modelRest.y + (src[i + 1] - c.hipsRest.y) * k + lift;
    v[i + 2] = modelRest.z + (src[i + 2] - c.hipsRest.z) * k;
  }
  return new THREE.VectorKeyframeTrack('Hips.position', c.hips.times, v);
}

// ── foot-contact FK (ground calibration + gait analysis) ────────────────────

/** Rest local transforms (model units) keyed by bone name. */
export type RestPose = ReadonlyMap<string, { p: THREE.Vector3; q: THREE.Quaternion }>;

const LEG_CHAIN = ['UpLeg', 'Leg', 'Foot', 'ToeBase'] as const;
const IDENTITY = new THREE.Quaternion();

export interface LegSample {
  t: number;
  hips: THREE.Vector3;
  /** foot (ankle) / toe world positions (armature space, model units) */
  footL: THREE.Vector3;
  toeL: THREE.Vector3;
  footR: THREE.Vector3;
  toeR: THREE.Vector3;
}

/**
 * Evaluate the leg chains of a clip at `n + 1` evenly spaced times (FK in
 * armature space). Bones without a track keep their rest rotation, so
 * `sampleLegs([], null, rest, 0, 0)[0]` is the rest pose.
 */
export function sampleLegs(rot: readonly THREE.QuaternionKeyframeTrack[], hipsTrack: THREE.VectorKeyframeTrack | null, rest: RestPose, duration: number, n: number): LegSample[] {
  const byBone = new Map<string, THREE.Interpolant>();
  for (const tr of rot) byBone.set(trackBone(tr.name), interpolantOf(tr));
  const hipsI = hipsTrack ? interpolantOf(hipsTrack) : null;
  const hipsRest = rest.get('Hips')?.p ?? new THREE.Vector3();
  const out: LegSample[] = [];
  const q = new THREE.Quaternion();
  const lq = new THREE.Quaternion();
  const off = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const t = n > 0 ? (i / n) * duration : 0;
    const hips = new THREE.Vector3().copy(hipsRest);
    if (hipsI) hips.fromArray(hipsI.evaluate(t) as unknown as number[]);
    const s: LegSample = { t, hips, footL: new THREE.Vector3(), toeL: new THREE.Vector3(), footR: new THREE.Vector3(), toeR: new THREE.Vector3() };
    for (const side of ['Left', 'Right'] as const) {
      const hq = byBone.get('Hips');
      q.copy(rest.get('Hips')?.q ?? IDENTITY);
      if (hq) q.fromArray(hq.evaluate(t) as unknown as number[]);
      const p = hips.clone();
      for (const seg of LEG_CHAIN) {
        const name = `${side}${seg}`;
        const r = rest.get(name);
        if (!r) break;
        off.copy(r.p).applyQuaternion(q);
        p.add(off);
        if (seg === 'Foot') (side === 'Left' ? s.footL : s.footR).copy(p);
        if (seg === 'ToeBase') (side === 'Left' ? s.toeL : s.toeR).copy(p);
        const it = byBone.get(name);
        lq.copy(r.q);
        if (it) lq.fromArray(it.evaluate(t) as unknown as number[]);
        q.multiply(lq);
      }
    }
    out.push(s);
  }
  return out;
}

/** Contact height of one foot: how far its lowest point (ankle or toe) is above its rest height. */
export function footContact(foot: THREE.Vector3, toe: THREE.Vector3, footRestY: number, toeRestY: number): number {
  return Math.min(foot.y - footRestY, toe.y - toeRestY);
}

/**
 * Vertical lift (model units) that puts the lowest foot contact of a standing
 * clip on the ground: −min over time of the lower foot's contact height.
 */
export function groundLift(samples: readonly LegSample[], rest: LegSample): number {
  let lo = Infinity;
  for (const s of samples) {
    lo = Math.min(lo, footContact(s.footL, s.toeL, rest.footL.y, rest.toeL.y), footContact(s.footR, s.toeR, rest.footR.y, rest.toeR.y));
  }
  return Number.isFinite(lo) ? -lo : 0;
}

export interface GaitInfo {
  /** ground speed the clip is authored for (model units / s) */
  speed: number;
  /** travel direction in armature space (x, z), unit (+z = the model's forward) */
  dirX: number;
  dirZ: number;
  /** gait cycles (left-foot plants) in the clip, ≥ 1 */
  cycles: number;
  /** clip time of the first left-foot plant */
  phase0: number;
}

/**
 * Natural speed / direction / cycle count of an in-place locomotion clip from
 * its (already grounded) foot samples: a planted foot slides backwards under the
 * hips at exactly the ground speed. `contactTol` = height (model units) below
 * which a foot counts as planted.
 */
export function analyseGait(samples: readonly LegSample[], rest: LegSample, contactTol: number): GaitInfo | null {
  if (samples.length < 4) return null;
  let sx = 0;
  let sz = 0;
  let dist = 0;
  let time = 0;
  let plantsL = 0;
  let phase0 = -1;
  for (const side of ['L', 'R'] as const) {
    const foot = side === 'L' ? 'footL' : 'footR';
    const toe = side === 'L' ? 'toeL' : 'toeR';
    const planted = samples.map((s) => footContact(s[foot], s[toe], rest[foot].y, rest[toe].y) < contactTol);
    for (let i = 1; i < samples.length; i++) {
      if (!planted[i] || !planted[i - 1]) continue;
      const a = samples[i - 1];
      const b = samples[i];
      // planted foot motion relative to the (in-place) hips
      const dx = b[toe].x - b.hips.x - (a[toe].x - a.hips.x);
      const dz = b[toe].z - b.hips.z - (a[toe].z - a.hips.z);
      sx -= dx;
      sz -= dz;
      dist += Math.hypot(dx, dz);
      time += b.t - a.t;
    }
    if (side === 'L') {
      // plant onsets on the loop (the last sample equals the first)
      for (let i = 0; i < samples.length - 1; i++) {
        const prev = planted[(i - 1 + samples.length - 1) % (samples.length - 1)];
        if (planted[i] && !prev) {
          plantsL++;
          if (phase0 < 0) phase0 = samples[i].t;
        }
      }
    }
  }
  if (time <= 0) return null;
  const len = Math.hypot(sx, sz) || 1;
  return { speed: dist / time, dirX: sx / len, dirZ: sz / len, cycles: Math.max(1, plantsL), phase0: Math.max(0, phase0) };
}

/**
 * The time-averaged pose of a clip as a constant 2-key clip (sign-aligned
 * quaternion mean per bone, mean Hips translation). Blending a gait with its
 * own mean shortens the stride symmetrically (slower movement at a natural
 * cadence) instead of pulling the legs toward an unrelated standing pose.
 */
export function meanClip(c: PreparedClip, name: string): PreparedClip {
  const q = new THREE.Quaternion();
  const ref = new THREE.Quaternion();
  const rot = c.rot.map((tr) => {
    const v = tr.values;
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    ref.fromArray(v, 0);
    for (let i = 0; i < v.length; i += 4) {
      q.fromArray(v, i);
      const sgn = q.dot(ref) < 0 ? -1 : 1;
      x += q.x * sgn;
      y += q.y * sgn;
      z += q.z * sgn;
      w += q.w * sgn;
    }
    q.set(x, y, z, w).normalize();
    return new THREE.QuaternionKeyframeTrack(tr.name, [0, 1], [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]);
  });
  let hips: THREE.VectorKeyframeTrack | null = null;
  if (c.hips) {
    const v = c.hips.values;
    const n = v.length / 3;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < v.length; i += 3) {
      x += v[i];
      y += v[i + 1];
      z += v[i + 2];
    }
    hips = new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [x / n, y / n, z / n, x / n, y / n, z / n]);
  }
  return { name, duration: 1, rot, hips, hipsRest: c.hipsRest.clone() };
}
