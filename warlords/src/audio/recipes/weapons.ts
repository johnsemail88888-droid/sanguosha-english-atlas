// Gunshots, reloads, dry fire, casings, bullet flybys.
//
// A gunshot is layered: a bright transient "crack", a pitch-dropping "body"
// thump, a low-passed noise "blast" (all through a saturator for grit) and a
// long dark "tail" that stands in for the outdoor echo. Distance shifts the
// balance from crack to tail, like real distant gunfire.
import { perc, sweep } from '../dsp';
import type { NoiseColor } from '../dsp';
import type { Voice } from '../voice';
import { bell, burst, crackles, pluck, saturator, tone, whoosh } from './common';
import { clamp } from './types';
import type { Recipe, RecipeOpts } from './types';

interface GunProfile {
  crackHz: number;
  crackDecay: number;
  crack: number;
  bodyHz0: number;
  bodyHz1: number;
  bodyDrop: number;
  bodyDecay: number;
  body: number;
  blastLp0: number;
  blastLp1: number;
  blastDecay: number;
  blast: number;
  blastColor: NoiseColor;
  tailDecay: number;
  tail: number;
  tailLp: number;
  drive: number;
  level: number;
  /** local mechanical click frequency (0 = none) */
  mechHz: number;
}

const PROFILES: Record<string, GunProfile> = {
  pistol: {
    crackHz: 2600, crackDecay: 0.03, crack: 0.9,
    bodyHz0: 190, bodyHz1: 75, bodyDrop: 0.05, bodyDecay: 0.12, body: 0.75,
    blastLp0: 6500, blastLp1: 900, blastDecay: 0.15, blast: 0.6, blastColor: 'white',
    tailDecay: 0.55, tail: 0.1, tailLp: 1500, drive: 1.6, level: 0.62, mechHz: 3300,
  },
  smg: {
    crackHz: 3200, crackDecay: 0.022, crack: 0.8,
    bodyHz0: 210, bodyHz1: 95, bodyDrop: 0.035, bodyDecay: 0.085, body: 0.55,
    blastLp0: 7000, blastLp1: 1400, blastDecay: 0.1, blast: 0.55, blastColor: 'white',
    tailDecay: 0.4, tail: 0.07, tailLp: 1700, drive: 1.4, level: 0.5, mechHz: 4000,
  },
  rifle: {
    crackHz: 2400, crackDecay: 0.035, crack: 1,
    bodyHz0: 160, bodyHz1: 58, bodyDrop: 0.06, bodyDecay: 0.17, body: 0.85,
    blastLp0: 8000, blastLp1: 750, blastDecay: 0.2, blast: 0.7, blastColor: 'pink',
    tailDecay: 0.95, tail: 0.13, tailLp: 1250, drive: 2.1, level: 0.6, mechHz: 2900,
  },
  lmg: {
    crackHz: 2200, crackDecay: 0.03, crack: 0.95,
    bodyHz0: 140, bodyHz1: 52, bodyDrop: 0.06, bodyDecay: 0.19, body: 0.95,
    blastLp0: 7000, blastLp1: 650, blastDecay: 0.2, blast: 0.75, blastColor: 'pink',
    tailDecay: 0.9, tail: 0.13, tailLp: 1100, drive: 2.3, level: 0.6, mechHz: 2500,
  },
  dmr: {
    crackHz: 3000, crackDecay: 0.035, crack: 1,
    bodyHz0: 150, bodyHz1: 52, bodyDrop: 0.07, bodyDecay: 0.22, body: 0.85,
    blastLp0: 9000, blastLp1: 800, blastDecay: 0.25, blast: 0.65, blastColor: 'pink',
    tailDecay: 1.3, tail: 0.16, tailLp: 1300, drive: 2.1, level: 0.64, mechHz: 3000,
  },
  sniper: {
    crackHz: 3400, crackDecay: 0.045, crack: 1.1,
    bodyHz0: 115, bodyHz1: 36, bodyDrop: 0.12, bodyDecay: 0.45, body: 1,
    blastLp0: 9000, blastLp1: 480, blastDecay: 0.38, blast: 0.75, blastColor: 'pink',
    tailDecay: 2.2, tail: 0.22, tailLp: 900, drive: 2.6, level: 0.72, mechHz: 2600,
  },
  shotgun: {
    crackHz: 1900, crackDecay: 0.04, crack: 0.9,
    bodyHz0: 120, bodyHz1: 40, bodyDrop: 0.09, bodyDecay: 0.3, body: 1,
    blastLp0: 5200, blastLp1: 480, blastDecay: 0.36, blast: 0.9, blastColor: 'pink',
    tailDecay: 1.2, tail: 0.18, tailLp: 900, drive: 2.6, level: 0.66, mechHz: 0,
  },
};

function gunshot(v: Voice, o: RecipeOpts, pr: GunProfile): void {
  const t = v.t;
  const P = o.pitch * (0.94 + o.seed * 0.12);
  const far = clamp(o.dist / 120, 0, 1);
  const heavy = o.flavor === 'heavy' ? 1.2 : 1;
  const light = o.flavor === 'light' ? 0.75 : 1;
  const sat = saturator(v, pr.drive, pr.level * light);

  // 1) transient crack — fades with distance (air eats the highs, the tail remains)
  burst(v, { color: 'white', type: 'highpass', freq: pr.crackHz * P, q: 0.7, peak: pr.crack * (1 - 0.65 * far), attack: 0.0006, decay: pr.crackDecay, dest: sat });
  if (!v.kit.lite) {
    burst(v, { color: 'white', type: 'bandpass', freq: pr.crackHz * 1.7 * P, q: 1.4, peak: pr.crack * 0.5 * (1 - 0.8 * far), attack: 0.0004, decay: pr.crackDecay * 0.6, dest: sat });
  }
  // 2) body thump
  tone(v, { freq: pr.bodyHz0 * P, to: pr.bodyHz1 * P, glide: pr.bodyDrop, peak: pr.body * heavy, attack: 0.001, decay: pr.bodyDecay * heavy, dest: sat });
  if (!v.kit.lite) {
    tone(v, { type: 'triangle', freq: pr.bodyHz0 * 2.1 * P, to: pr.bodyHz1 * 2 * P, glide: pr.bodyDrop, peak: pr.body * 0.25, attack: 0.001, decay: pr.bodyDecay * 0.5, dest: sat });
  }
  // 3) blast
  burst(v, {
    color: pr.blastColor,
    type: 'lowpass',
    freq: pr.blastLp0 * P,
    to: pr.blastLp1 * P,
    sweepTime: pr.blastDecay * 0.7,
    q: 0.8,
    peak: pr.blast,
    attack: 0.0008,
    decay: pr.blastDecay,
    dest: sat,
  });
  // 4) outdoor tail (clean, not saturated) — more prominent at distance
  const tailPeak = pr.tail * (1 + far * 1.6) * heavy * light;
  burst(v, { color: 'brown', type: 'lowpass', freq: pr.tailLp * (1 - 0.4 * far), q: 0.5, start: t + 0.008, peak: tailPeak * 2.2, attack: 0.03, decay: pr.tailDecay });

  if (o.local) {
    // sub punch + action click: sells "this is MY gun"
    tone(v, { freq: 58, to: 42, glide: 0.08, peak: 0.32, attack: 0.001, decay: 0.1 });
    if (pr.mechHz > 0) {
      burst(v, { type: 'bandpass', freq: pr.mechHz, q: 3, start: t + 0.018, peak: 0.12, decay: 0.022 });
      bell(v, { freq: pr.mechHz * 0.8, ratios: [1, 1.53], levels: [0.5, 0.3], decays: [0.05, 0.035], start: t + 0.02, peak: 0.05 });
    }
  }
  flavorLayer(v, o);
}

/** Tonal extras for weapon specials (cryo shimmer, fire hiss); also layered over baked shots. */
export function flavorLayer(v: Voice, o: RecipeOpts): void {
  const t = v.t;
  if (o.flavor === 'ice') {
    for (let i = 0; i < 3; i++) {
      tone(v, { freq: v.rnd(3200, 6400), start: t + v.rnd(0.005, 0.06), peak: 0.05, attack: 0.002, decay: v.rnd(0.18, 0.35) });
    }
    burst(v, { type: 'highpass', freq: 5000, to: 2500, peak: 0.08, attack: 0.01, decay: 0.25 });
  } else if (o.flavor === 'fire') {
    burst(v, { color: 'pink', type: 'bandpass', freq: 1800, q: 0.7, peak: 0.12, attack: 0.02, decay: 0.3 });
  }
}

const gunPistol: Recipe = (v, o) => gunshot(v, o, PROFILES.pistol);
const gunSmg: Recipe = (v, o) => gunshot(v, o, PROFILES.smg);
const gunRifle: Recipe = (v, o) => gunshot(v, o, PROFILES.rifle);
const gunLmg: Recipe = (v, o) => gunshot(v, o, PROFILES.lmg);
const gunDmr: Recipe = (v, o) => gunshot(v, o, PROFILES.dmr);
const gunSniper: Recipe = (v, o) => gunshot(v, o, PROFILES.sniper);
const gunShotgun: Recipe = (v, o) => gunshot(v, o, PROFILES.shotgun);

const gunLauncher: Recipe = (v, o) => {
  const t = v.t;
  const P = o.pitch;
  const sat = saturator(v, 1.8, 0.62);
  tone(v, { freq: 115 * P, to: 44 * P, glide: 0.16, peak: 0.95, attack: 0.002, decay: 0.38, dest: sat });
  burst(v, { color: 'brown', type: 'lowpass', freq: 1900, to: 280, sweepTime: 0.35, q: 0.7, peak: 1, attack: 0.004, decay: 0.45, dest: sat });
  burst(v, { type: 'highpass', freq: 1500, peak: 0.35, decay: 0.03, dest: sat });
  // rocket motor hiss moving away
  const n = v.noise('pink', t + 0.02, t + 1);
  const f = v.filter('bandpass', 900, 0.8);
  sweep(f.frequency, t + 0.02, 900, 2600, 0.5);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t + 0.02);
  g.gain.linearRampToValueAtTime(0.32, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.95);
  v.chain(n, f, g, v.out);
  burst(v, { color: 'brown', type: 'lowpass', freq: 800, start: t + 0.01, peak: 0.2 * (1 + clamp(o.dist / 100, 0, 1)), attack: 0.03, decay: 1 });
};

const gunBow: Recipe = (v, o) => {
  const t = v.t;
  const P = o.pitch * (0.95 + o.seed * 0.1);
  // string twang (slight pitch sag as the string settles)
  pluck(v, { freq: 98 * P, peak: 0.55, t60: 0.4, bright: 0.55, pos: 0.32, sag: 1.03 });
  pluck(v, { freq: 196 * P * 1.004, peak: 0.18, t60: 0.25, bright: 0.8, pos: 0.2 });
  // release "thwip" + limb thump
  burst(v, { color: 'pink', type: 'bandpass', freq: 2200, to: 700, q: 1.3, peak: 0.45, attack: 0.002, decay: 0.12 });
  tone(v, { freq: 150 * P, to: 85, glide: 0.06, peak: 0.45, decay: 0.08 });
  // arrow leaving
  whoosh(v, { start: t + 0.01, lo: 900, hi: 2600, dur: 0.32, peak: 0.12, q: 1.5 });
};

const gunCrossbow: Recipe = (v, o) => {
  const t = v.t;
  const P = o.pitch * (0.95 + o.seed * 0.1);
  pluck(v, { freq: 155 * P, peak: 0.45, t60: 0.22, bright: 0.8, pos: 0.25 });
  // trigger + prod clack
  burst(v, { type: 'bandpass', freq: 1500, q: 2, peak: 0.85, decay: 0.035 });
  tone(v, { freq: 620 * P, to: 420, glide: 0.03, peak: 0.3, decay: 0.035 });
  tone(v, { freq: 130, to: 80, glide: 0.05, peak: 0.4, decay: 0.07 });
  whoosh(v, { start: t + 0.01, lo: 1100, hi: 3000, dur: 0.25, peak: 0.1, q: 1.6 });
};

const gunMelee: Recipe = (v, o) => {
  const t = v.t;
  const P = o.pitch;
  whoosh(v, { lo: 320 * P, hi: 1900 * P, dur: 0.3, peak: 0.75, q: 1.4 });
  whoosh(v, { lo: 160 * P, hi: 520 * P, dur: 0.28, peak: 0.35, q: 0.8, color: 'brown' });
  if (o.flavor !== 'light') {
    // faint blade ring
    bell(v, { freq: 2100 * P, ratios: [1, 1.48, 2.3], levels: [0.5, 0.35, 0.2], decays: [0.35, 0.25, 0.15], start: t + 0.05, peak: 0.05, attack: 0.02 });
  }
};

const gunTesla: Recipe = (v, o) => {
  const t = v.t;
  const P = o.pitch;
  const sh = v.shaper(v.kit.drive(4));
  const bp = v.filter('bandpass', 1400, 0.7);
  const g = v.gain(0);
  perc(g.gain, t, 0.38, 0.002, 0.26);
  v.chain(sh, bp, g, v.out);
  v.osc('sawtooth', 72 * P, t, t + 0.3).connect(sh);
  v.osc('square', 147 * P, t, t + 0.3).connect(sh);
  for (let i = 0; i < 7; i++) {
    burst(v, { type: 'highpass', freq: 2500 + Math.random() * 3000, start: t + Math.random() * 0.2, peak: 0.18 + Math.random() * 0.2, decay: 0.01 + Math.random() * 0.015 });
  }
  tone(v, { freq: 2600 * P, to: 280, glide: 0.18, peak: 0.25, decay: 0.2 });
  crackles(v, { dur: 0.3, peak: 0.35, freq: 3000, rate: 1.6 });
};

const gunFlamer: Recipe = (v, o) => {
  // one-shot burst (the continuous loop lives in loops.ts)
  burst(v, { color: 'pink', type: 'bandpass', freq: 650 * o.pitch, q: 0.6, peak: 0.8, attack: 0.03, decay: 0.35 });
  burst(v, { color: 'white', type: 'highpass', freq: 3000, peak: 0.15, attack: 0.02, decay: 0.2 });
  crackles(v, { dur: 0.35, peak: 0.25, freq: 1800 });
};

export const GUN_RECIPES: Record<string, Recipe> = {
  pistol: gunPistol,
  smg: gunSmg,
  rifle: gunRifle,
  lmg: gunLmg,
  dmr: gunDmr,
  sniper: gunSniper,
  shotgun: gunShotgun,
  launcher: gunLauncher,
  bow: gunBow,
  crossbow: gunCrossbow,
  melee: gunMelee,
  tesla: gunTesla,
  flamer: gunFlamer,
};

export const gun: Recipe = (v, o) => (GUN_RECIPES[o.variant] ?? gunRifle)(v, o);

// ── Reload parts ─────────────────────────────────────────────────────────────
function magOut(v: Voice, P: number): void {
  burst(v, { type: 'bandpass', freq: 2600 * P, q: 2.5, peak: 1.1, decay: 0.025 });
  burst(v, { type: 'bandpass', freq: 1200 * P, q: 1.2, start: v.t + 0.01, peak: 0.45, attack: 0.02, decay: 0.08 });
  bell(v, { freq: 1750 * P, ratios: [1, 2.3], levels: [0.5, 0.3], decays: [0.06, 0.04], peak: 0.22 });
}

function magIn(v: Voice, P: number): void {
  burst(v, { type: 'bandpass', freq: 1600 * P, q: 1.6, peak: 0.75, decay: 0.045 });
  tone(v, { freq: 230 * P, to: 140, glide: 0.04, peak: 0.45, decay: 0.06 });
  burst(v, { type: 'highpass', freq: 3200, start: v.t + 0.012, peak: 0.4, decay: 0.015 });
}

function rack(v: Voice, P: number): void {
  for (const [dt, pk] of [
    [0, 0.6],
    [0.075, 0.75],
  ] as const) {
    burst(v, { type: 'bandpass', freq: 2200 * P, q: 2, start: v.t + dt, peak: pk, decay: 0.03 });
    bell(v, { freq: 1300 * P, ratios: [1, 2.23], levels: [0.5, 0.3], decays: [0.08, 0.05], start: v.t + dt, peak: 0.1 });
  }
  burst(v, { type: 'bandpass', freq: 900, q: 1, start: v.t + 0.01, peak: 0.15, attack: 0.03, decay: 0.05 });
}

function shell(v: Voice, P: number): void {
  burst(v, { type: 'bandpass', freq: 1900 * P, q: 2, peak: 0.75, decay: 0.03 });
  tone(v, { freq: 320 * P, to: 200, glide: 0.03, peak: 0.4, decay: 0.05 });
}

function pump(v: Voice, P: number): void {
  whoosh(v, { lo: 700, hi: 1600, dur: 0.1, peak: 0.25, q: 1.5, color: 'white' });
  burst(v, { type: 'bandpass', freq: 1400 * P, q: 1.8, start: v.t + 0.07, peak: 0.8, decay: 0.04 });
  whoosh(v, { start: v.t + 0.14, lo: 800, hi: 1800, dur: 0.1, peak: 0.25, q: 1.5, color: 'white' });
  burst(v, { type: 'bandpass', freq: 1700 * P, q: 1.8, start: v.t + 0.22, peak: 0.9, decay: 0.045 });
  tone(v, { freq: 180, to: 120, glide: 0.04, start: v.t + 0.22, peak: 0.3, decay: 0.05 });
}

function bolt(v: Voice, P: number): void {
  const steps: [number, number, number][] = [
    [0, 2400, 0.4],
    [0.09, 1500, 0.55],
    [0.2, 1700, 0.6],
    [0.3, 2600, 0.45],
  ];
  for (const [dt, f, pk] of steps) {
    burst(v, { type: 'bandpass', freq: f * P, q: 2.2, start: v.t + dt, peak: pk, decay: 0.035 });
    bell(v, { freq: f * 0.7 * P, ratios: [1, 1.9], levels: [0.4, 0.25], decays: [0.06, 0.04], start: v.t + dt, peak: 0.08 });
  }
}

function bowDraw(v: Voice, P: number): void {
  // wood creak: narrow band-pass noise with a wobbling centre frequency
  const t = v.t;
  const n = v.noise('white', t, t + 0.55);
  const f = v.filter('bandpass', 500 * P, 9);
  f.frequency.setValueAtTime(420 * P, t);
  for (let i = 1; i <= 6; i++) f.frequency.linearRampToValueAtTime((420 + (i % 2) * 260 + i * 30) * P, t + i * 0.08);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.9, t + 0.15);
  g.gain.linearRampToValueAtTime(0.0, t + 0.52);
  v.chain(n, f, g, v.out);
  burst(v, { type: 'bandpass', freq: 1800, q: 2, start: t + 0.5, peak: 0.25, decay: 0.03 });
}

function crank(v: Voice, P: number): void {
  for (let i = 0; i < 5; i++) burst(v, { type: 'bandpass', freq: 2800 * P, q: 3, start: v.t + i * 0.07, peak: 0.6, decay: 0.018 });
}

function tank(v: Voice, P: number): void {
  burst(v, { color: 'white', type: 'highpass', freq: 3500, peak: 0.25, attack: 0.02, decay: 0.3 });
  magIn(v, P * 0.7);
}

export const reload: Recipe = (v, o) => {
  const P = o.pitch;
  switch (o.variant) {
    case 'out':
      return magOut(v, P);
    case 'in':
      return magIn(v, P);
    case 'rack':
      return rack(v, P);
    case 'shell':
      return shell(v, P);
    case 'pump':
      return pump(v, P);
    case 'bolt':
      return bolt(v, P);
    case 'draw':
      return bowDraw(v, P);
    case 'crank':
      return crank(v, P);
    case 'tank':
      return tank(v, P);
    default:
      return magIn(v, P);
  }
};

export const RELOAD_PARTS = ['out', 'in', 'rack', 'shell', 'pump', 'bolt', 'draw', 'crank', 'tank'] as const;

export const dryFire: Recipe = (v) => {
  burst(v, { type: 'bandpass', freq: 3600, q: 2, peak: 0.7, decay: 0.012 });
  tone(v, { freq: 1800, to: 1500, glide: 0.02, peak: 0.25, decay: 0.022 });
  burst(v, { type: 'bandpass', freq: 2400, q: 2, start: v.t + 0.035, peak: 0.25, decay: 0.012 });
};

export const casing: Recipe = (v) => {
  const t = v.t;
  const bounces = 2 + Math.floor(Math.random() * 2);
  let at = t;
  for (let i = 0; i < bounces; i++) {
    const pk = 0.2 / (i + 1);
    bell(v, { freq: v.rnd(3600, 4600), ratios: [1, 1.52, 2.4], levels: [0.6, 0.35, 0.2], decays: [0.09, 0.06, 0.04], start: at, peak: pk });
    burst(v, { type: 'highpass', freq: 5000, start: at, peak: pk * 0.8, decay: 0.006 });
    at += v.rnd(0.06, 0.13) / (i + 1);
  }
};

export const flyby: Recipe = (v, o) => {
  const t = v.t;
  burst(v, { type: 'highpass', freq: 2500, peak: 0.8, attack: 0.0004, decay: 0.008 });
  const n = v.noise('white', t, t + 0.2);
  const f = v.filter('bandpass', 3800 * o.pitch, 4);
  sweep(f.frequency, t, 3800 * o.pitch, 1300 * o.pitch, 0.16);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.7, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0007, t + 0.17);
  v.chain(n, f, g, v.out);
};
