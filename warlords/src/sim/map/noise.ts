// Deterministic math + seeded gradient noise for map generation.
//
// Every peer (host + clients, possibly different JS engines) must build a
// bit-identical map from the same seed. ECMAScript only guarantees exact
// results for + - * / and Math.sqrt/floor/abs/min/max; Math.sin/cos/atan2/
// exp/pow/hypot are "implementation-approximated" and may differ in the last
// bit between V8, SpiderMonkey and JavaScriptCore. A single differing bit in a
// rejection test would shift the RNG stream and produce a different map, so the
// generator uses only the functions in this file for anything that affects
// decisions or stored values.
import { Rng } from '../../core/rng';

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Deterministic sine (polynomial, |error| < 1e-9 over all finite inputs of sane magnitude). */
export function dsin(x: number): number {
  let r = x - TWO_PI * Math.floor(x / TWO_PI + 0.5); // [-PI, PI]
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r; // [-PI/2, PI/2]
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (-1 / 6 +
          r2 *
            (1 / 120 +
              r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800 - r2 / 1307674368000)))))))
  );
}

/** Deterministic cosine. */
export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hermite smoothstep of t clamped to [0,1]. */
export const smooth01 = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** smoothstep(e0, e1, x) as in GLSL (e0 may be > e1). */
export const smoothstep = (e0: number, e1: number, x: number): number => smooth01((x - e0) / (e1 - e0));

export const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Deterministic 2D length (sqrt is correctly rounded everywhere). */
export const len2 = (x: number, z: number): number => Math.sqrt(x * x + z * z);

// 8 gradient directions (unit-ish, exact constants: no trig).
const GX = [1, -1, 0, 0, 0.7071067811865476, -0.7071067811865476, 0.7071067811865476, -0.7071067811865476];
const GZ = [0, 0, 1, -1, 0.7071067811865476, 0.7071067811865476, -0.7071067811865476, -0.7071067811865476];

/** Seeded 2D Perlin gradient noise. Output roughly in [-1, 1]. */
export class Noise2 {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Rng(seed ^ 0x5bd1e995);
    const p: number[] = [];
    for (let i = 0; i < 256; i++) p.push(i);
    rng.shuffle(p);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(x: number, z: number): number {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const xi = fx & 255;
    const zi = fz & 255;
    const tx = x - fx;
    const tz = z - fz;
    const p = this.perm;
    const aa = p[p[xi] + zi] & 7;
    const ba = p[p[xi + 1] + zi] & 7;
    const ab = p[p[xi] + zi + 1] & 7;
    const bb = p[p[xi + 1] + zi + 1] & 7;
    const n00 = GX[aa] * tx + GZ[aa] * tz;
    const n10 = GX[ba] * (tx - 1) + GZ[ba] * tz;
    const n01 = GX[ab] * tx + GZ[ab] * (tz - 1);
    const n11 = GX[bb] * (tx - 1) + GZ[bb] * (tz - 1);
    const u = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const v = tz * tz * tz * (tz * (tz * 6 - 15) + 10);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return (nx0 + (nx1 - nx0) * v) * 1.41;
  }

  /** Fractal sum, normalised to roughly [-1, 1]. */
  fbm(x: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise(x * freq + o * 17.31, z * freq - o * 9.77) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged fractal in [0, 1] (sharp crests), for mountain rims. */
  ridged(x: number, z: number, octaves: number): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * freq + o * 31.7, z * freq + o * 5.3));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
