// Pure music theory for the procedural score (unit-tested in Node):
// Chinese pentatonic modes, seeded phrase generation and drum patterns.
import { Rng } from '../core/rng';

/** Semitone offsets of the five 五声 modes (宫 商 角 徵 羽) of one pitch set. */
export const MODES = {
  gong: [0, 2, 4, 7, 9],
  shang: [0, 2, 5, 7, 10],
  jue: [0, 3, 5, 8, 10],
  zhi: [0, 2, 5, 7, 9],
  yu: [0, 3, 5, 7, 10],
} as const;

export type ModeName = keyof typeof MODES;

/** MIDI note of pentatonic scale degree `deg` (5 degrees per octave, may be negative). */
export function degreeToMidi(root: number, mode: readonly number[], deg: number): number {
  const n = mode.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return root + oct * 12 + mode[idx];
}

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export interface MelodyNote {
  /** start, in 16th steps from the phrase start */
  step: number;
  /** length in 16th steps */
  len: number;
  /** scale degree */
  deg: number;
  /** velocity 0..1 */
  vel: number;
}

export interface PhraseOptions {
  bars: number;
  /** rhythm templates: 16th-step lengths per bar, each summing to 16 */
  rhythms: readonly (readonly number[])[];
  start: number;
  /** degree the phrase must land on */
  end: number;
  lo: number;
  hi: number;
  leap?: number;
}

/** Steps in a random walk: mostly stepwise, some repeats and leaps. */
const MOVES = [-3, -2, -1, 0, 1, 2, 3];
const MOVE_WEIGHTS = [0.25, 1, 4, 0.8, 4, 1, 0.25];

export function makePhrase(rng: Rng, o: PhraseOptions): MelodyNote[] {
  const notes: MelodyNote[] = [];
  let deg = o.start;
  for (let bar = 0; bar < o.bars; bar++) {
    const rhythm = rng.pick(o.rhythms);
    let step = bar * 16;
    for (let i = 0; i < rhythm.length; i++) {
      const len = rhythm[i];
      const lastOfPhrase = bar === o.bars - 1 && i === rhythm.length - 1;
      const penultimate = bar === o.bars - 1 && i === rhythm.length - 2;
      if (notes.length > 0) {
        if (lastOfPhrase) {
          deg = o.end;
        } else if (penultimate) {
          // approach the cadence note by step
          deg = o.end + (deg >= o.end ? 1 : -1);
        } else {
          const w = MOVE_WEIGHTS.map((x, k) => (Math.abs(MOVES[k]) >= 2 ? x * (o.leap ?? 1) : x));
          deg += rng.weighted(MOVES, w);
          if (deg > o.hi) deg = o.hi - rng.int(0, 1);
          if (deg < o.lo) deg = o.lo + rng.int(0, 1);
        }
      }
      const downbeat = step % 16 === 0;
      const beat = step % 4 === 0;
      const vel = Math.min(1, (downbeat ? 0.95 : beat ? 0.8 : 0.66) + (len >= 8 ? 0.05 : 0) + (rng.next() - 0.5) * 0.08);
      notes.push({ step, len, deg, vel });
      step += len;
    }
  }
  return notes;
}

/** Shift every note of a phrase by `steps` (for concatenation). */
export function shiftPhrase(notes: readonly MelodyNote[], steps: number, degShift = 0): MelodyNote[] {
  return notes.map((n) => ({ ...n, step: n.step + steps, deg: n.deg + degShift }));
}

export interface MelodyForm {
  /** degrees the four phrases start / end on */
  cadences: readonly [number, number, number, number];
  barsPerPhrase: number;
  rhythms: readonly (readonly number[])[];
  lo: number;
  hi: number;
  leap?: number;
}

/**
 * An 8-bar (by default) A A' B A'' melody: A ends on a half cadence, A' repeats
 * A's opening with a new ending, B moves higher, A'' returns home.
 */
export function makeMelody(seed: number, f: MelodyForm): MelodyNote[] {
  const rng = new Rng(seed);
  const bp = f.barsPerPhrase;
  const len = bp * 16;
  const [c1, c2, c3, c4] = f.cadences;
  const a = makePhrase(rng, { bars: bp, rhythms: f.rhythms, start: c4 + 2, end: c1, lo: f.lo, hi: f.hi, leap: f.leap });
  // A': same opening bar(s), fresh ending
  const aHead = a.filter((n) => n.step < len / 2);
  const aTail = makePhrase(rng, {
    bars: Math.max(1, bp / 2),
    rhythms: f.rhythms,
    start: aHead.length ? aHead[aHead.length - 1].deg : c1,
    end: c2,
    lo: f.lo,
    hi: f.hi,
    leap: f.leap,
  });
  const a2 = [...aHead, ...shiftPhrase(aTail, len / 2)];
  const b = makePhrase(rng, {
    bars: bp,
    rhythms: f.rhythms,
    start: Math.min(f.hi, c1 + 3),
    end: c3,
    lo: Math.min(f.hi - 2, f.lo + 2),
    hi: f.hi,
    leap: f.leap,
  });
  const aEnd = makePhrase(rng, {
    bars: Math.max(1, bp / 2),
    rhythms: f.rhythms,
    start: aHead.length ? aHead[aHead.length - 1].deg : c3,
    end: c4,
    lo: f.lo,
    hi: f.hi,
    leap: f.leap,
  });
  const a3 = [...aHead, ...shiftPhrase(aEnd, len / 2)];
  // let phrase endings breathe: final note of each phrase slightly softer
  return [...a, ...shiftPhrase(a2, len), ...shiftPhrase(b, len * 2), ...shiftPhrase(a3, len * 3)];
}

// ── Rhythm libraries (16th steps per bar, each sums to 16) ──────────────────
export const RHYTHMS_SLOW: readonly (readonly number[])[] = [
  [8, 4, 4],
  [6, 2, 8],
  [4, 4, 8],
  [12, 4],
  [4, 2, 2, 8],
  [6, 2, 4, 4],
  [16],
];

export const RHYTHMS_DRIVING: readonly (readonly number[])[] = [
  [4, 2, 2, 4, 4],
  [2, 2, 4, 2, 2, 4],
  [3, 3, 2, 4, 4],
  [4, 4, 2, 2, 4],
  [6, 2, 4, 2, 2],
  [2, 2, 2, 2, 8],
];

/** Taiko pattern for one 16-step bar: per-step velocity (0 = rest). */
export function taikoPattern(intensity: number, bar: number): number[] {
  const p = new Array<number>(16).fill(0);
  p[0] = 1;
  p[8] = 0.85;
  if (intensity > 0.3) {
    p[6] = 0.6;
    p[11] = 0.55;
  }
  if (intensity > 0.55) {
    p[3] = 0.5;
    p[10] = 0.7;
    p[14] = 0.6;
  }
  if (intensity > 0.8) {
    p[4] = 0.55;
    p[12] = 0.8;
  }
  // fill at the end of every 4th bar
  if (bar % 4 === 3 && intensity > 0.4) {
    for (let s = 12; s < 16; s++) p[s] = 0.55 + (s - 12) * 0.12;
    if (intensity > 0.75) for (let s = 8; s < 12; s++) p[s] = Math.max(p[s], 0.45 + (s - 8) * 0.05);
  }
  return p;
}

/** Rim / small-drum "ka" pattern (off-beats), per-step velocity. */
export function rimPattern(intensity: number): number[] {
  const p = new Array<number>(16).fill(0);
  if (intensity < 0.15) return p;
  p[4] = 0.5;
  p[12] = 0.5;
  if (intensity > 0.45) {
    p[2] = 0.3;
    p[7] = 0.35;
    p[10] = 0.3;
    p[15] = 0.35;
  }
  if (intensity > 0.7) for (let s = 1; s < 16; s += 2) p[s] = Math.max(p[s], 0.22);
  return p;
}

/** Driving bass: scale-degree offsets from the chord root per 8th note (null = rest). */
export function bassPattern(intensity: number): (number | null)[] {
  if (intensity < 0.35) return [0, null, null, null, 3, null, null, null];
  if (intensity < 0.6) return [0, null, 0, 0, 3, null, 0, 5];
  return [0, 0, 5, 0, 0, 3, 0, -1];
}

/** Layer gain for a layer that enters at `threshold` intensity. */
export function layerGain(intensity: number, threshold: number, width = 0.12): number {
  if (threshold <= 0) return 1;
  const t = (intensity - (threshold - width)) / (2 * width);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
