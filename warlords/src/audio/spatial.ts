// Distance behaviour for positional sounds. Pure math (unit-tested in Node).
//
// PannerNodes are used only for direction (HRTF / equal-power) with their
// built-in distance attenuation disabled; loudness, air absorption and reverb
// send are computed here per sound category so gameplay-critical sounds
// (gunfire, explosions) stay audible far away while small sounds fade fast.
import type { Vec3 } from '../core/math';

export interface SpatialProfile {
  /** distance (m) within which the sound plays at full level */
  ref: number;
  /** inverse-distance rolloff factor (higher = fades faster) */
  rolloff: number;
  /** hard audibility limit (m); the sound fades to silence over the last 25 % */
  range: number;
  /** air absorption e-folding distance (m) for the low-pass cutoff */
  absorb: number;
  /** reverb send at point-blank; grows with distance */
  wet: number;
}

export type SpatialProfileId = 'gun' | 'loud' | 'medium' | 'impact' | 'steps' | 'quiet' | 'ambient' | 'aircraft';

export const SPATIAL_PROFILES: Record<SpatialProfileId, SpatialProfile> = {
  gun: { ref: 3, rolloff: 0.5, range: 260, absorb: 60, wet: 0.14 },
  loud: { ref: 8, rolloff: 0.55, range: 340, absorb: 95, wet: 0.18 },
  medium: { ref: 3, rolloff: 1, range: 70, absorb: 45, wet: 0.1 },
  impact: { ref: 4, rolloff: 0.8, range: 90, absorb: 45, wet: 0.1 },
  steps: { ref: 2, rolloff: 0.9, range: 34, absorb: 35, wet: 0.06 },
  quiet: { ref: 1.5, rolloff: 1.2, range: 30, absorb: 30, wet: 0.08 },
  ambient: { ref: 3, rolloff: 1, range: 45, absorb: 40, wet: 0.12 },
  aircraft: { ref: 40, rolloff: 0.6, range: 900, absorb: 220, wet: 0.2 },
};

const smoothstep = (a: number, b: number, x: number): number => {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};

/** Linear gain (0..1) for a source `d` metres from the listener. */
export function distanceGain(d: number, p: SpatialProfile): number {
  if (!Number.isFinite(d) || d >= p.range) return 0;
  const dd = Math.max(d, p.ref);
  const inv = p.ref / (p.ref + p.rolloff * (dd - p.ref));
  return inv * (1 - smoothstep(p.range * 0.75, p.range, d));
}

/** Low-pass cutoff (Hz) simulating high-frequency air absorption. */
export function airCutoff(d: number, p: SpatialProfile): number {
  if (!Number.isFinite(d)) return 700;
  const fc = 19000 * Math.exp(-Math.max(0, d - p.ref) / p.absorb);
  return Math.max(700, Math.min(19000, fc));
}

/** Reverb send level: distant sounds are wetter (more "room", less direct). */
export function reverbSend(d: number, p: SpatialProfile): number {
  if (!Number.isFinite(d)) return p.wet;
  return Math.min(0.6, p.wet + (Math.max(0, d - p.ref) / p.range) * 0.45);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Closest point on segment [a, b] to p. */
export function closestOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t };
}

/** Perceptual volume curve for 0..1 sliders. */
export function volumeCurve(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.pow(Math.min(1, v), 1.5);
}
