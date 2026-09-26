// Continuous sounds that follow an entity (flamethrower, fire fields, storm
// clouds, the zone wall, rockets in flight). A loop runs until the SFX engine
// stops it; sources are scheduled far into the future and cut on stop.
import type { Voice } from '../voice';
import type { RecipeOpts } from './types';

/** Upper bound for a loop's lifetime; the engine always stops loops earlier. */
export const LOOP_MAX = 900;

export type LoopRecipe = (v: Voice, o: RecipeOpts) => void;

function fadeIn(v: Voice, node: GainNode, peak: number, time: number): void {
  node.gain.setValueAtTime(0, v.t);
  node.gain.linearRampToValueAtTime(peak, v.t + time);
}

function crackleLayer(v: Voice, peak: number, hp: number, rate = 1): void {
  const t = v.t;
  const s = v.buffer(v.kit.crackle(), t, rate, { loop: true, stop: t + LOOP_MAX, offset: Math.random() * 3.5 });
  const f = v.filter('highpass', hp, 0.6);
  const g = v.gain(0);
  fadeIn(v, g, peak, 0.2);
  v.chain(s, f, g, v.out);
}

const flamer: LoopRecipe = (v, o) => {
  const t = v.t;
  const end = t + LOOP_MAX;
  const roar = v.noise('pink', t, end, o.pitch);
  const bp = v.filter('bandpass', 650 * o.pitch, 0.55);
  const lp = v.filter('lowpass', 2800, 0.7);
  const drive = v.shaper(v.kit.drive(1.8));
  const g = v.gain(0);
  fadeIn(v, g, 0.34, 0.07);
  // flutter
  const lfo = v.osc('sine', 7.5, t, end);
  const lg = v.gain(0.08);
  lfo.connect(lg).connect(g.gain);
  v.chain(roar, bp, lp, drive, g, v.out);
  const hiss = v.noise('white', t, end);
  const hp = v.filter('highpass', 3200, 0.7);
  const hg = v.gain(0);
  fadeIn(v, hg, 0.05, 0.05);
  v.chain(hiss, hp, hg, v.out);
  crackleLayer(v, 0.12, 1600);
};

const fire: LoopRecipe = (v, o) => {
  const t = v.t;
  const end = t + LOOP_MAX;
  const size = Math.max(0.5, Math.min(2, o.size));
  const rum = v.noise('brown', t, end);
  const lp = v.filter('lowpass', 480, 0.7);
  const g = v.gain(0);
  fadeIn(v, g, 0.2 * size, 0.4);
  const lfo = v.osc('sine', 0.35 + Math.random() * 0.3, t, end);
  const lg = v.gain(0.07 * size);
  lfo.connect(lg).connect(g.gain);
  v.chain(rum, lp, g, v.out);
  const mid = v.noise('pink', t, end);
  const bp = v.filter('bandpass', 900, 0.6);
  const mg = v.gain(0);
  fadeIn(v, mg, 0.07 * size, 0.4);
  v.chain(mid, bp, mg, v.out);
  crackleLayer(v, 0.22 * size, 1200, 0.9 + Math.random() * 0.2);
};

const zone: LoopRecipe = (v) => {
  const t = v.t;
  const end = t + LOOP_MAX;
  const lp = v.filter('lowpass', 320, 1.5);
  const g = v.gain(0);
  fadeIn(v, g, 0.09, 1);
  for (const [f, det] of [
    [55, 0],
    [55.6, 0],
    [82.5, 4],
  ] as const) {
    v.osc('sawtooth', f, t, end, det).connect(lp);
  }
  const trem = v.osc('sine', 0.6, t, end);
  const tg = v.gain(0.03);
  trem.connect(tg).connect(g.gain);
  v.chain(lp, g, v.out);
  const n = v.noise('brown', t, end);
  const nl = v.filter('lowpass', 260, 0.7);
  const ng = v.gain(0);
  fadeIn(v, ng, 0.12, 1);
  v.chain(n, nl, ng, v.out);
  crackleLayer(v, 0.04, 2500, 1.3);
};

const storm: LoopRecipe = (v) => {
  const t = v.t;
  const end = t + LOOP_MAX;
  const n = v.noise('brown', t, end);
  const lp = v.filter('lowpass', 220, 0.7);
  const g = v.gain(0);
  fadeIn(v, g, 0.35, 0.8);
  const l1 = v.osc('sine', 0.23, t, end);
  const l2 = v.osc('sine', 0.61, t, end);
  const lg = v.gain(0.14);
  l1.connect(lg);
  l2.connect(lg);
  lg.connect(g.gain);
  v.chain(n, lp, g, v.out);
  crackleLayer(v, 0.1, 3500, 1.6);
};

const arrows: LoopRecipe = (v) => {
  const t = v.t;
  const end = t + LOOP_MAX;
  const n = v.noise('white', t, end);
  const bp = v.filter('bandpass', 2600, 3);
  const lfo = v.osc('sine', 3.3, t, end);
  const lg = v.gain(900);
  lfo.connect(lg).connect(bp.frequency);
  const g = v.gain(0);
  fadeIn(v, g, 0.3, 0.3);
  v.chain(n, bp, g, v.out);
  crackleLayer(v, 0.3, 1800, 0.7);
};

const rocket: LoopRecipe = (v) => {
  const t = v.t;
  const end = t + LOOP_MAX;
  const n = v.noise('pink', t, end);
  const bp = v.filter('bandpass', 1900, 0.8);
  const g = v.gain(0);
  fadeIn(v, g, 0.5, 0.05);
  v.chain(n, bp, g, v.out);
  const r = v.noise('brown', t, end);
  const lp = v.filter('lowpass', 300, 0.7);
  const rg = v.gain(0);
  fadeIn(v, rg, 0.35, 0.05);
  v.chain(r, lp, rg, v.out);
};

const heal: LoopRecipe = (v) => {
  // gentle shimmering drone for heal zones / banners
  const t = v.t;
  const end = t + LOOP_MAX;
  const g = v.gain(0);
  fadeIn(v, g, 0.025, 0.6);
  for (const f of [523.25, 659.25, 783.99]) {
    const o = v.osc('sine', f, t, end, (Math.random() - 0.5) * 8);
    o.connect(g);
  }
  const trem = v.osc('sine', 3.2, t, end);
  const tg = v.gain(0.01);
  trem.connect(tg).connect(g.gain);
  g.connect(v.out);
};

const shield: LoopRecipe = (v, o) => {
  // barrier hum while a unit is shielded: soft detuned drone + slow shimmer
  const t = v.t;
  const end = t + LOOP_MAX;
  const P = o.pitch;
  const lp = v.filter('lowpass', 900, 0.7);
  const g = v.gain(0);
  fadeIn(v, g, 0.022, 0.35);
  for (const [f, det] of [
    [110, -4],
    [110, 5],
    [165, 0],
  ] as const) {
    v.osc('triangle', f * P, t, end, det).connect(lp);
  }
  const wob = v.osc('sine', 0.9, t, end);
  const wg = v.gain(0.007);
  wob.connect(wg).connect(g.gain);
  v.chain(lp, g, v.out);
  const shim = v.osc('sine', 1320 * P, t, end, 3);
  const sg = v.gain(0);
  fadeIn(v, sg, 0.006, 0.5);
  const trem = v.osc('sine', 6.5, t, end);
  const tg = v.gain(0.005);
  trem.connect(tg).connect(sg.gain);
  v.chain(shim, sg, v.out);
};

export const LOOPS = { flamer, fire, zone, storm, arrows, rocket, heal, shield } as const;

export type LoopName = keyof typeof LOOPS;

export const LOOP_NAMES = Object.keys(LOOPS) as LoopName[];
