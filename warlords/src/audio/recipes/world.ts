// World sounds: impacts, explosions, lightning, heals, shields, pickups,
// items, ability casts with kingdom stingers, deaths, zone horn, airdrop,
// footsteps and status effects.
import { degreeToMidi, midiToFreq, MODES } from '../composition';
import { perc, sweep } from '../dsp';
import type { Voice } from '../voice';
import { bell, burst, crackles, saturator, tone, whoosh } from './common';
import { cymbal, gong, guqin, guzheng, horn, phrase, rim, smallDrum, taiko, woodblock } from './instruments';
import { clamp } from './types';
import type { Recipe, RecipeOpts } from './types';

// ── Impacts ──────────────────────────────────────────────────────────────────
function impactFlesh(v: Voice, P: number): void {
  tone(v, { freq: 150 * P, to: 62, glide: 0.06, peak: 0.6, decay: 0.12 });
  burst(v, { color: 'pink', type: 'lowpass', freq: 950 * P, peak: 0.55, decay: 0.08 });
  burst(v, { color: 'white', type: 'bandpass', freq: 520 * P, q: 2, peak: 0.3, decay: 0.05 });
}

function impactWood(v: Voice, P: number): void {
  burst(v, { type: 'highpass', freq: 3000, peak: 0.4, decay: 0.01 });
  burst(v, { type: 'bandpass', freq: 1100 * P, q: 1.5, peak: 0.6, decay: 0.07 });
  bell(v, { freq: 380 * P, ratios: [1, 2.16], levels: [0.6, 0.35], decays: [0.09, 0.06], peak: 0.35 });
  crackles(v, { dur: 0.15, peak: 0.12, freq: 2200, rate: 1.4 });
}

function impactStone(v: Voice, P: number): void {
  burst(v, { type: 'highpass', freq: 2500 * P, peak: 0.8, attack: 0.0004, decay: 0.016 });
  burst(v, { type: 'bandpass', freq: 1800 * P, q: 1, peak: 0.4, decay: 0.06 });
  burst(v, { color: 'pink', type: 'lowpass', freq: 600, start: v.t + 0.01, peak: 0.15, attack: 0.02, decay: 0.18 });
  if (Math.random() < 0.28) ricochet(v, P);
}

function ricochet(v: Voice, P: number): void {
  const t = v.t + 0.015;
  const o = v.osc('sine', 4200 * P, t, t + 0.32);
  sweep(o.frequency, t, v.rnd(3600, 4800) * P, v.rnd(1400, 2000) * P, 0.28);
  const fm = v.osc('sine', 38, t, t + 0.32);
  const fmg = v.gain(180);
  fm.connect(fmg).connect(o.frequency);
  const g = v.gain(0);
  perc(g.gain, t, 0.11, 0.005, 0.3);
  v.chain(o, g, v.out);
}

function impactMetal(v: Voice, P: number, level = 1): void {
  burst(v, { type: 'highpass', freq: 3500, peak: 0.6 * level, attack: 0.0004, decay: 0.01 });
  bell(v, {
    freq: v.rnd(750, 1050) * P,
    ratios: [1, 2.4, 3.9, 5.3, 6.8],
    levels: [0.5, 0.35, 0.25, 0.15, 0.1],
    decays: [0.35, 0.25, 0.18, 0.12, 0.09],
    peak: 0.35 * level,
  });
}

function impactDirt(v: Voice, P: number): void {
  burst(v, { color: 'pink', type: 'lowpass', freq: 750 * P, peak: 0.55, decay: 0.09 });
  tone(v, { freq: 95 * P, to: 60, glide: 0.04, peak: 0.35, decay: 0.06 });
  burst(v, { type: 'highpass', freq: 3500, start: v.t + 0.01, peak: 0.08, decay: 0.05 });
}

function impactWater(v: Voice, P: number): void {
  burst(v, { color: 'white', type: 'bandpass', freq: 600 * P, to: 2800 * P, q: 0.8, peak: 0.45, attack: 0.004, decay: 0.22 });
  for (let i = 0; i < 3; i++) {
    const at = v.t + v.rnd(0.02, 0.12);
    tone(v, { freq: v.rnd(420, 700) * P, to: v.rnd(900, 1400) * P, glide: 0.04, start: at, peak: 0.12, attack: 0.002, decay: 0.05 });
  }
}

function impactSoft(v: Voice, P: number): void {
  burst(v, { color: 'pink', type: 'lowpass', freq: 1300 * P, peak: 1, decay: 0.05 });
  burst(v, { type: 'bandpass', freq: 2200, q: 1, peak: 0.2, attack: 0.004, decay: 0.08 });
}

function shieldZap(v: Voice, P: number): void {
  tone(v, { freq: 1900 * P, to: 520, glide: 0.12, peak: 0.35, decay: 0.14 });
  const t = v.t;
  const buzz = v.osc('sawtooth', 92 * P, t, t + 0.16);
  const bp = v.filter('bandpass', 1100, 1.2);
  const g = v.gain(0);
  perc(g.gain, t, 0.35, 0.002, 0.12);
  v.chain(buzz, bp, g, v.out);
  burst(v, { type: 'highpass', freq: 4500, peak: 0.3, decay: 0.03 });
}

function glassChime(v: Voice, P: number, peak = 0.35): void {
  bell(v, { freq: 2350 * P, ratios: [1, 1.5, 2.76], levels: [0.6, 0.35, 0.2], decays: [0.6, 0.4, 0.25], peak });
}

export const impact: Recipe = (v, o) => {
  const P = o.pitch;
  switch (o.variant) {
    case 'flesh':
      return impactFlesh(v, P);
    case 'wood':
      return impactWood(v, P);
    case 'stone':
      return impactStone(v, P);
    case 'metal':
      return impactMetal(v, P);
    case 'water':
      return impactWater(v, P);
    case 'soft':
      return impactSoft(v, P);
    case 'shield':
      return shieldZap(v, P);
    case 'armor':
      impactMetal(v, P * 1.2, 0.7);
      tone(v, { freq: 120, to: 70, glide: 0.05, peak: 0.35, decay: 0.08 });
      return;
    case 'invuln':
      bell(v, { freq: 2600 * P, ratios: [1, 1.5], levels: [0.6, 0.3], decays: [0.45, 0.3], peak: 0.3 });
      return;
    case 'dodge':
      whoosh(v, { lo: 600, hi: 2200, dur: 0.18, peak: 0.4, q: 1.3 });
      return;
    case 'nullify':
      return glassChime(v, P);
    default:
      return impactDirt(v, P);
  }
};

export const IMPACT_VARIANTS = ['flesh', 'wood', 'stone', 'metal', 'dirt', 'water', 'soft', 'shield', 'armor', 'invuln', 'dodge', 'nullify'] as const;

// ── Explosions ───────────────────────────────────────────────────────────────
function boom(v: Voice, o: RecipeOpts, level: number): void {
  const t = v.t;
  const s = clamp(o.size, 0.5, 2.2);
  const far = clamp(o.dist / 150, 0, 1);
  const sat = saturator(v, 2.8, 0.6 * level);
  burst(v, { color: 'white', type: 'highpass', freq: 900, peak: 0.8 * (1 - 0.7 * far), attack: 0.0005, decay: 0.06, dest: sat });
  tone(v, { freq: 72 / Math.sqrt(s), to: 27, glide: 0.45, peak: 1, attack: 0.002, decay: 1.1 * s, dest: sat });
  burst(v, { color: 'brown', type: 'lowpass', freq: 3200, to: 180, sweepTime: 1.1 * s, q: 0.7, peak: 1, attack: 0.002, decay: 1.4 * s, dest: sat });
  tone(v, { freq: 44, to: 30, glide: 1, peak: 0.45, attack: 0.012, decay: 1.4 * s });
  // debris raining down + rolling echo
  crackles(v, { start: t + 0.12, dur: 1.6 * s, peak: 0.28 * (1 - 0.5 * far), freq: 1400, debris: true });
  burst(v, { color: 'brown', type: 'lowpass', freq: 420, start: t + 0.08, peak: 0.35 * (1 + far), attack: 0.1, decay: 2.2 * s });
}

function fireBlast(v: Voice, o: RecipeOpts): void {
  const t = v.t;
  const s = clamp(o.size, 0.5, 2.2);
  const n = v.noise('pink', t, t + 1.6 * s);
  const lp = v.filter('lowpass', 300, 0.9);
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + 0.14);
  lp.frequency.exponentialRampToValueAtTime(500, t + 1.2 * s);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.85, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0008, t + 1.5 * s);
  v.chain(n, lp, g, v.out);
  tone(v, { freq: 70, to: 38, glide: 0.3, peak: 0.7, attack: 0.01, decay: 0.7 * s });
  crackles(v, { start: t + 0.05, dur: 1.6 * s, peak: 0.35, freq: 1600 });
}

function iceShatter(v: Voice, o: RecipeOpts): void {
  const t = v.t;
  const s = clamp(o.size, 0.5, 2);
  burst(v, { color: 'white', type: 'highpass', freq: 2500, peak: 0.6, attack: 0.001, decay: 0.25 * s });
  tone(v, { freq: 110, to: 60, glide: 0.1, peak: 0.5, decay: 0.3 });
  for (let i = 0; i < 14; i++) {
    const at = t + Math.pow(Math.random(), 1.6) * 0.45 * s;
    const f = v.rnd(2200, 7500);
    bell(v, { freq: f, ratios: [1, 2.32], levels: [0.6, 0.25], decays: [v.rnd(0.08, 0.3), 0.06], start: at, peak: v.rnd(0.04, 0.12) });
  }
  burst(v, { color: 'white', type: 'bandpass', freq: 6000, to: 1800, q: 1, start: t + 0.05, peak: 0.12, attack: 0.05, decay: 0.8 * s });
}

function holyChord(v: Voice): void {
  const t = v.t;
  const notes = [72, 76, 79, 81, 84];
  notes.forEach((m, i) => {
    bell(v, { freq: midiToFreq(m), ratios: [1, 2, 3.01], levels: [0.6, 0.2, 0.08], decays: [1.6, 0.8, 0.4], start: t + i * 0.035, peak: 0.12, attack: 0.02 });
  });
  whoosh(v, { lo: 500, hi: 4000, dur: 0.6, peak: 0.2 });
}

function gasHiss(v: Voice, o: RecipeOpts): void {
  const s = clamp(o.size, 0.5, 2);
  burst(v, { type: 'bandpass', freq: 3000, q: 0.7, peak: 0.5, attack: 0.02, decay: 1.6 * s });
  tone(v, { freq: 90, to: 50, glide: 0.1, peak: 0.4, decay: 0.2 });
}

export const lightning: Recipe = (v, o) => {
  const t = v.t;
  const s = clamp(o.size, 0.6, 2);
  const far = clamp(o.dist / 150, 0, 1);
  const sat = saturator(v, 2, 0.7);
  // the crack (with a stutter), fading with distance
  burst(v, { color: 'white', type: 'highpass', freq: 700, peak: 1 * (1 - 0.6 * far), attack: 0.0005, decay: 0.09, dest: sat });
  burst(v, { color: 'white', type: 'highpass', freq: 1200, start: t + 0.035, peak: 0.7 * (1 - 0.6 * far), attack: 0.0005, decay: 0.07, dest: sat });
  burst(v, { color: 'white', type: 'bandpass', freq: 3000, start: t + 0.08, peak: 0.4 * (1 - 0.6 * far), decay: 0.12, dest: sat });
  // electric sizzle
  const buzz = v.osc('square', 60, t, t + 0.45);
  const bg = v.gain(0);
  const hp = v.filter('highpass', 3500, 0.7);
  perc(bg.gain, t, 0.12 * (1 - far), 0.003, 0.4);
  const n = v.noise('white', t, t + 0.45);
  const am = v.gain(0);
  buzz.connect(am.gain);
  v.chain(n, hp, am, bg, v.out);
  // rolling rumble: brown noise with slow irregular amplitude
  const r = v.noise('brown', t + 0.05, t + 3.6 * s);
  const rlp = v.filter('lowpass', 190, 0.7);
  const rg = v.gain(0);
  rg.gain.setValueAtTime(0, t + 0.05);
  rg.gain.linearRampToValueAtTime(1.2, t + 0.35);
  rg.gain.setTargetAtTime(0.6, t + 0.6, 0.3);
  rg.gain.linearRampToValueAtTime(0.9, t + 1.1);
  rg.gain.exponentialRampToValueAtTime(0.001, t + 3.5 * s);
  const lfo = v.osc('sine', 1.7, t, t + 3.6 * s);
  const lfo2 = v.osc('sine', 2.9, t, t + 3.6 * s);
  const lg = v.gain(0.35);
  lfo.connect(lg);
  lfo2.connect(lg);
  const mod = v.gain(1);
  lg.connect(mod.gain);
  v.chain(r, rlp, rg, mod, v.out);
  tone(v, { freq: 48, to: 32, glide: 0.6, start: t + 0.03, peak: 0.5, attack: 0.02, decay: 1.2 * s });
};

/**
 * Chain-lightning jump between two targets: a short, bright electric snap
 * (no rumble), so a tesla volley reads as one shot plus crackling arcs.
 */
export const arc: Recipe = (v, o) => {
  const t = v.t;
  const P = o.pitch;
  const far = clamp(o.dist / 80, 0, 1);
  // buzzing discharge: a driven sawtooth/square pair through a resonant band
  const sh = v.shaper(v.kit.drive(3));
  const bp = v.filter('bandpass', 2100 * P, 0.9);
  const g = v.gain(0);
  perc(g.gain, t, 0.5, 0.001, 0.15);
  v.chain(sh, bp, g, v.out);
  v.osc('sawtooth', 118 * P, t, t + 0.2).connect(sh);
  v.osc('square', 181 * P, t, t + 0.2).connect(sh);
  // snap + sparks (air eats them with distance)
  burst(v, { color: 'white', type: 'highpass', freq: 1800, peak: 0.7 * (1 - 0.6 * far), attack: 0.0005, decay: 0.025 });
  for (let i = 0; i < 4; i++) {
    burst(v, { type: 'highpass', freq: v.rnd(2800, 6000), start: t + v.rnd(0.005, 0.12), peak: v.rnd(0.18, 0.35) * (1 - 0.5 * far), decay: v.rnd(0.006, 0.014) });
  }
  tone(v, { freq: 3200 * P, to: 520, glide: 0.1, peak: 0.16, decay: 0.12 });
};

export const explosion: Recipe = (v, o) => {
  switch (o.variant) {
    case 'fire':
      return fireBlast(v, o);
    case 'ice':
      return iceShatter(v, o);
    case 'thunder':
      return lightning(v, o);
    case 'holy':
      return holyChord(v);
    case 'gas':
      return gasHiss(v, o);
    case 'rocket':
      return boom(v, o, 1.05);
    default:
      return boom(v, o, 1);
  }
};

export const EXPLOSION_VARIANTS = ['frag', 'rocket', 'fire', 'ice', 'thunder', 'holy', 'gas'] as const;

// ── Healing / shields / movement ─────────────────────────────────────────────
const PENTA_HI = [76, 79, 81, 84, 86, 88];

export const heal: Recipe = (v, o) => {
  const t = v.t;
  const n = o.size >= 1.5 ? 4 : 3;
  for (let i = 0; i < n; i++) {
    const m = PENTA_HI[i + (o.variant === 'big' ? 1 : 0)];
    bell(v, { freq: midiToFreq(m) * o.pitch, ratios: [1, 2, 3.98], levels: [0.7, 0.2, 0.06], decays: [0.9, 0.45, 0.2], start: t + i * 0.065, peak: 0.2, attack: 0.004 });
  }
  burst(v, { color: 'white', type: 'highpass', freq: 6000, peak: 0.05, attack: 0.08, decay: 0.6 });
};

export const revive: Recipe = (v, o) => {
  heal(v, { ...o, size: 2 });
  const t = v.t;
  const lp = v.filter('lowpass', 2200, 0.7);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.12, t + 0.35);
  g.gain.linearRampToValueAtTime(0, t + 1.6);
  for (const m of [60, 64, 67, 72]) v.osc('triangle', midiToFreq(m), t, t + 1.7).connect(lp);
  lp.connect(g).connect(v.out);
};

export const shieldUp: Recipe = (v, o) => {
  const t = v.t;
  const lp = v.filter('lowpass', 300, 3);
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + 0.22);
  lp.frequency.exponentialRampToValueAtTime(700, t + 0.6);
  const g = v.gain(0);
  perc(g.gain, t, 0.13, 0.05, 0.6);
  for (const f of [110, 165.4, 220.8]) v.osc('sawtooth', f * o.pitch, t, t + 0.7).connect(lp);
  lp.connect(g).connect(v.out);
  const sh = v.osc('sine', 880 * o.pitch, t, t + 0.8);
  const trem = v.osc('sine', 14, t, t + 0.8);
  const tg = v.gain(0.5);
  const sg = v.gain(0);
  perc(sg.gain, t + 0.05, 0.05, 0.1, 0.6);
  trem.connect(tg).connect(sg.gain);
  v.chain(sh, sg, v.out);
};

export const shieldDown: Recipe = (v, o) => {
  tone(v, { type: 'sawtooth', freq: 440 * o.pitch, to: 90, glide: 0.35, peak: 0.12, decay: 0.4 });
  for (let i = 0; i < 6; i++) {
    bell(v, { freq: v.rnd(2500, 6000), ratios: [1], levels: [1], decays: [v.rnd(0.08, 0.2)], start: v.t + v.rnd(0, 0.12), peak: 0.06 });
  }
};

export const dodge: Recipe = (v, o) => {
  whoosh(v, { lo: 550 * o.pitch, hi: 2400 * o.pitch, dur: 0.26, peak: 0.55, q: 1.2 });
  whoosh(v, { lo: 150, hi: 420, dur: 0.24, peak: 0.25, q: 0.8, color: 'brown' });
};

export const footstep: Recipe = (v, o) => {
  const P = o.pitch;
  const s = clamp(o.size, 0.4, 2);
  switch (o.variant) {
    case 'stone':
      burst(v, { type: 'highpass', freq: 1700 * P, peak: 0.35 * s, decay: 0.03 });
      burst(v, { color: 'pink', type: 'lowpass', freq: 900, peak: 0.3 * s, decay: 0.04 });
      return;
    case 'wood':
      bell(v, { freq: 290 * P, ratios: [1, 2.4], levels: [0.6, 0.3], decays: [0.08, 0.05], peak: 0.4 * s });
      burst(v, { type: 'bandpass', freq: 1300 * P, q: 1.3, peak: 0.2 * s, decay: 0.03 });
      return;
    case 'water':
      burst(v, { color: 'white', type: 'bandpass', freq: 900 * P, to: 2400, q: 0.9, peak: 0.35 * s, attack: 0.006, decay: 0.14 });
      tone(v, { freq: v.rnd(500, 750), to: 1100, glide: 0.04, start: v.t + 0.03, peak: 0.06 * s, decay: 0.04 });
      return;
    case 'hoof':
      tone(v, { freq: 420 * P, to: 210, glide: 0.035, peak: 0.45 * s, decay: 0.045 });
      burst(v, { type: 'bandpass', freq: 2000 * P, q: 1.5, peak: 0.3 * s, decay: 0.02 });
      burst(v, { color: 'pink', type: 'lowpass', freq: 500, peak: 0.25 * s, decay: 0.06 });
      return;
    case 'stomp':
      tone(v, { freq: 58 * P, to: 34, glide: 0.2, peak: 0.9 * s, attack: 0.004, decay: 0.45 });
      burst(v, { color: 'brown', type: 'lowpass', freq: 350, peak: 0.6 * s, attack: 0.005, decay: 0.5 });
      crackles(v, { dur: 0.3, peak: 0.08, freq: 1500, debris: true });
      return;
    case 'land':
      burst(v, { color: 'pink', type: 'lowpass', freq: 800, peak: 0.6 * s, decay: 0.1 });
      tone(v, { freq: 90, to: 55, glide: 0.05, peak: 0.5 * s, decay: 0.09 });
      burst(v, { type: 'highpass', freq: 2500, start: v.t + 0.01, peak: 0.1 * s, decay: 0.05 });
      return;
    case 'jump':
      whoosh(v, { lo: 400, hi: 1200, dur: 0.16, peak: 0.25 * s, q: 1 });
      return;
    case 'crawl':
      burst(v, { color: 'pink', type: 'bandpass', freq: 700, q: 0.8, peak: 0.2 * s, attack: 0.05, decay: 0.2 });
      return;
    default:
      // dirt / grass
      burst(v, { color: 'pink', type: 'lowpass', freq: 1100 * P, peak: 0.4 * s, attack: 0.002, decay: 0.06 });
      tone(v, { freq: 75 * P, to: 55, glide: 0.03, peak: 0.25 * s, decay: 0.04 });
      burst(v, { type: 'bandpass', freq: 3200 * P, q: 1, start: v.t + 0.01, peak: 0.05 * s, decay: 0.03 });
  }
};

export const FOOTSTEP_VARIANTS = ['dirt', 'stone', 'wood', 'water', 'hoof', 'stomp', 'land', 'jump', 'crawl'] as const;

// ── Loot ─────────────────────────────────────────────────────────────────────
function sparkle(v: Voice, start: number, peak: number, count = 3, base = 84): void {
  for (let i = 0; i < count; i++) {
    const m = degreeToMidi(base, MODES.gong, i * 2);
    bell(v, { freq: midiToFreq(m), ratios: [1, 2.76], levels: [0.6, 0.15], decays: [0.5, 0.2], start: start + i * 0.05, peak, attack: 0.003 });
  }
}

export const crateOpen: Recipe = (v, o) => {
  const t = v.t;
  const tier = o.variant === '3' ? 3 : o.variant === '2' ? 2 : 1;
  // latch
  burst(v, { type: 'bandpass', freq: 2400, q: 2.5, peak: 0.5, decay: 0.025 });
  if (tier === 1) {
    // wooden lid creak
    const n = v.noise('white', t + 0.03, t + 0.45);
    const f = v.filter('bandpass', 500, 10);
    f.frequency.setValueAtTime(420, t + 0.03);
    f.frequency.linearRampToValueAtTime(780, t + 0.2);
    f.frequency.linearRampToValueAtTime(560, t + 0.4);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t + 0.03);
    g.gain.linearRampToValueAtTime(0.4, t + 0.12);
    g.gain.linearRampToValueAtTime(0, t + 0.42);
    v.chain(n, f, g, v.out);
    tone(v, { freq: 160, to: 110, glide: 0.05, start: t + 0.4, peak: 0.45, decay: 0.1 });
    burst(v, { type: 'bandpass', freq: 900, q: 1, start: t + 0.4, peak: 0.3, decay: 0.05 });
  } else {
    bell(v, { freq: tier === 3 ? 820 : 600, ratios: [1, 2.41, 3.6], levels: [0.6, 0.4, 0.2], decays: [0.9, 0.6, 0.35], start: t + 0.05, peak: 0.22 });
    tone(v, { freq: 130, to: 90, glide: 0.06, start: t + 0.05, peak: 0.5, decay: 0.15 });
  }
  sparkle(v, t + 0.42, tier === 3 ? 0.16 : 0.1, tier + 2, tier === 3 ? 86 : 84);
};

export const pickup: Recipe = (v, o) => {
  const t = v.t;
  switch (o.variant) {
    case 'weapon':
      burst(v, { type: 'bandpass', freq: 1500, q: 1.5, peak: 0.6, decay: 0.05 });
      bell(v, { freq: 950, ratios: [1, 2.3, 3.7], levels: [0.5, 0.3, 0.15], decays: [0.25, 0.15, 0.1], peak: 0.2 });
      burst(v, { type: 'bandpass', freq: 2200, q: 2, start: t + 0.12, peak: 0.45, decay: 0.03 });
      return;
    case 'armor':
      impactMetal(v, 0.7, 0.6);
      burst(v, { color: 'pink', type: 'bandpass', freq: 700, q: 0.8, peak: 0.25, attack: 0.02, decay: 0.2 });
      return;
    case 'mount':
      // snort + hoof stamp
      burst(v, { color: 'pink', type: 'bandpass', freq: 800, to: 500, q: 2, peak: 0.45, attack: 0.02, decay: 0.3 });
      burst(v, { color: 'white', type: 'bandpass', freq: 1600, to: 900, q: 3, start: t + 0.05, peak: 0.2, attack: 0.02, decay: 0.25 });
      footstep(v, { ...o, variant: 'hoof', size: 1 });
      return;
    case 'ammo':
      for (let i = 0; i < 5; i++) {
        bell(v, { freq: v.rnd(2600, 4200), ratios: [1, 1.6], levels: [0.5, 0.25], decays: [0.06, 0.04], start: t + v.rnd(0, 0.12), peak: 0.12 });
      }
      burst(v, { type: 'bandpass', freq: 1400, q: 1.2, peak: 0.35, decay: 0.05 });
      return;
    default:
      // 锦囊 card: paper swish + soft chime
      burst(v, { color: 'white', type: 'bandpass', freq: 1500, to: 4200, q: 1.2, peak: 0.3, attack: 0.02, decay: 0.12 });
      sparkle(v, t + 0.06, 0.08, 2, 88);
  }
};

export const PICKUP_VARIANTS = ['item', 'weapon', 'armor', 'mount', 'ammo'] as const;

export const itemUse: Recipe = (v, o) => {
  const t = v.t;
  switch (o.variant) {
    case 'peach':
      burst(v, { color: 'pink', type: 'bandpass', freq: 1800, q: 1, peak: 0.25, decay: 0.05 });
      heal(v, { ...o, variant: '' });
      return;
    case 'wine':
      for (let i = 0; i < 3; i++) {
        const at = t + i * 0.13;
        tone(v, { freq: 260 + i * 30, to: 520 + i * 40, glide: 0.06, start: at, peak: 0.25, attack: 0.005, decay: 0.08 });
        burst(v, { color: 'pink', type: 'lowpass', freq: 600, start: at, peak: 0.3, decay: 0.08 });
      }
      tone(v, { type: 'triangle', freq: 220, to: 330, glide: 0.4, start: t + 0.42, peak: 0.12, attack: 0.1, decay: 0.5 });
      return;
    case 'ammo':
      return pickup(v, { ...o, variant: 'ammo' });
    case 'dodge':
      dodge(v, o);
      glassChime(v, 1.2, 0.15);
      return;
    case 'fire':
      burst(v, { color: 'white', type: 'bandpass', freq: 1500, to: 4000, q: 1, peak: 0.25, decay: 0.1 });
      fireBlast(v, { ...o, size: 0.6 });
      return;
    case 'thunder':
      tone(v, { freq: 110, to: 116, glide: 0.8, peak: 0.15, attack: 0.3, decay: 0.8 });
      lightning(v, { ...o, size: 0.6, dist: 110 });
      return;
    case 'summon':
      horn(v, { midi: 43, dur: 0.6, vel: 0.5 });
      taiko(v, { start: t + 0.05, vel: 0.8 });
      taiko(v, { start: t + 0.35, vel: 0.9 });
      return;
    case 'recruit':
      smallDrum(v, { vel: 0.9 });
      smallDrum(v, { start: t + 0.12, vel: 0.7 });
      horn(v, { start: t + 0.2, midi: 50, dur: 0.35, vel: 0.4 });
      return;
    case 'arrows':
      for (let i = 0; i < 8; i++) {
        whoosh(v, { start: t + v.rnd(0, 0.5), lo: v.rnd(1400, 2200), hi: v.rnd(3000, 4500), dur: v.rnd(0.3, 0.5), peak: 0.12, q: 3, color: 'white' });
      }
      return;
    case 'bigHeal':
      heal(v, { ...o, size: 2, variant: 'big' });
      guzheng(v, { start: t + 0.25, midi: 69, vel: 0.6, bend: 1.06 });
      return;
    case 'draw':
      for (let i = 0; i < 3; i++) burst(v, { color: 'white', type: 'bandpass', freq: 2000, to: 5000, q: 1.2, start: t + i * 0.09, peak: 0.25, decay: 0.08 });
      sparkle(v, t + 0.2, 0.1, 4, 84);
      return;
    case 'trap':
      tone(v, { freq: 400, to: 160, glide: 0.1, peak: 0.3, decay: 0.12 });
      burst(v, { type: 'bandpass', freq: 1300, q: 1.5, peak: 0.4, decay: 0.05 });
      tone(v, { freq: 110, start: t + 0.1, peak: 0.18, attack: 0.1, decay: 0.8 });
      tone(v, { freq: 116.5, start: t + 0.1, peak: 0.18, attack: 0.1, decay: 0.8 });
      return;
    case 'steal':
      whoosh(v, { lo: 700, hi: 3000, dur: 0.2, peak: 0.4, q: 1.5 });
      pickup(v, { ...o, variant: 'item' });
      return;
    case 'emp':
      tone(v, { type: 'square', freq: 1200, to: 80, glide: 0.35, peak: 0.12, decay: 0.4 });
      shieldZap(v, 0.8);
      return;
    case 'duel':
      bell(v, { freq: 1400, ratios: [1, 2.9], levels: [0.6, 0.2], decays: [0.6, 0.3], peak: 0.25 });
      bell(v, { freq: 1400 * 1.06, ratios: [1, 2.9], levels: [0.6, 0.2], decays: [0.6, 0.3], start: t + 0.1, peak: 0.25 });
      taiko(v, { start: t + 0.05, vel: 0.6 });
      return;
    case 'chain':
      for (let i = 0; i < 6; i++) {
        bell(v, { freq: v.rnd(1500, 2600), ratios: [1, 2.2], levels: [0.6, 0.3], decays: [0.08, 0.05], start: t + i * 0.045 + v.rnd(0, 0.02), peak: 0.14 });
      }
      return;
    case 'nullify':
      glassChime(v, 1, 0.3);
      glassChime(v, 1.5, 0.15);
      return;
    case 'trick':
      burst(v, { color: 'white', type: 'bandpass', freq: 1200, to: 4200, q: 1, peak: 0.3, attack: 0.03, decay: 0.2 });
      sparkle(v, t + 0.1, 0.1, 4, 81);
      tone(v, { freq: 110, to: 90, glide: 0.3, peak: 0.25, attack: 0.02, decay: 0.35 });
      return;
    default:
      burst(v, { color: 'white', type: 'bandpass', freq: 1800, to: 3500, q: 1.2, peak: 0.25, decay: 0.08 });
      sparkle(v, t + 0.05, 0.07, 2, 81);
  }
};

// ── Abilities: cast whoosh + kingdom stinger + flavor ────────────────────────
function stinger(v: Voice, kingdom: string, lord: boolean): void {
  const t = v.t + 0.05;
  switch (kingdom) {
    case 'shu': {
      // heroic: rising guzheng arpeggio in 宫 (major pentatonic) + drum
      const root = 62;
      [0, 2, 3, 5].forEach((d, i) => guzheng(v, { start: t + i * 0.06, midi: degreeToMidi(root, MODES.gong, d + 3), vel: 0.55 + i * 0.06 }));
      smallDrum(v, { start: t, vel: 0.55 });
      break;
    }
    case 'wei': {
      // imperial: dark brass power chord + metallic ring
      const lp = v.filter('lowpass', 200, 2);
      lp.frequency.setValueAtTime(200, t);
      lp.frequency.exponentialRampToValueAtTime(1500, t + 0.12);
      lp.frequency.exponentialRampToValueAtTime(420, t + 0.8);
      const g = v.gain(0);
      perc(g.gain, t, 0.17, 0.03, 0.85);
      for (const m of [36, 43, 48, 51]) v.osc('sawtooth', midiToFreq(m), t, t + 0.95, (Math.random() - 0.5) * 12).connect(lp);
      lp.connect(g).connect(v.out);
      gong(v, { start: t, freq: 330, dur: 0.9, vel: 0.25, glide: 1 });
      break;
    }
    case 'wu': {
      // flowing: dizi glide up a fourth + water shimmer
      phrase(v, 'dizi', [
        { at: 0.05, midi: 81, dur: 0.16 },
        { at: 0.21, midi: 86, dur: 0.38, slide: true },
      ], undefined, 1);
      for (let i = 0; i < 4; i++) bell(v, { freq: v.rnd(3000, 5200), ratios: [1], levels: [1], decays: [0.3], start: t + 0.1 + i * 0.07, peak: 0.06 });
      break;
    }
    case 'qun': {
      // mystic/chaotic: tremolo gong + beating low drone
      gong(v, { start: t, freq: 210, dur: 1.1, vel: 0.35, glide: 1.03 });
      for (const f of [55, 58.3]) tone(v, { type: 'triangle', freq: f, start: t, peak: 0.25, attack: 0.08, decay: 0.9 });
      break;
    }
    default: {
      [72, 79, 84, 88].forEach((m, i) =>
        bell(v, { freq: midiToFreq(m), ratios: [1, 2], levels: [0.6, 0.2], decays: [1.2, 0.5], start: t + i * 0.04, peak: 0.17 }),
      );
    }
  }
  if (lord) {
    gong(v, { start: t + 0.02, freq: 98, dur: 2.5, vel: 0.7 });
    taiko(v, { start: t, vel: 1 });
  }
}

function abilityFlavor(v: Voice, flavor: string): void {
  const t = v.t;
  switch (flavor) {
    case 'thunder':
      burst(v, { color: 'white', type: 'highpass', freq: 2500, start: t + 0.05, peak: 0.25, decay: 0.08 });
      tone(v, { type: 'sawtooth', freq: 70, start: t, peak: 0.1, attack: 0.05, decay: 0.4 });
      return;
    case 'fire':
      burst(v, { color: 'pink', type: 'lowpass', freq: 400, to: 2500, q: 1, peak: 0.4, attack: 0.05, decay: 0.45 });
      crackles(v, { dur: 0.5, peak: 0.2, freq: 1800 });
      return;
    case 'ice':
      for (let i = 0; i < 5; i++) bell(v, { freq: v.rnd(2500, 6000), ratios: [1], levels: [1], decays: [0.25], start: t + i * 0.05, peak: 0.07 });
      return;
    case 'heal':
      heal(v, { variant: '', pitch: 1, size: 1, seed: 0, local: false, dist: 0, flavor: '' });
      return;
    case 'summon':
      horn(v, { start: t, midi: 43, dur: 0.7, vel: 0.7 });
      return;
    case 'guqin':
      guqin(v, { start: t, midi: 43, vel: 0.9 });
      guqin(v, { start: t + 0.18, midi: 50, vel: 0.6 });
      return;
    case 'dash':
      whoosh(v, { lo: 300, hi: 2600, dur: 0.35, peak: 0.45, q: 1 });
      return;
    case 'shout': {
      // war cry: formant noise roar + drum
      for (const [f, q, pk] of [
        [650, 5, 0.35],
        [1150, 6, 0.25],
        [2500, 7, 0.1],
      ] as const) {
        burst(v, { color: 'pink', type: 'bandpass', freq: f, q, peak: pk, attack: 0.04, decay: 0.55 });
      }
      tone(v, { type: 'sawtooth', freq: 130, to: 110, glide: 0.5, peak: 0.06, attack: 0.04, decay: 0.5 });
      taiko(v, { vel: 0.8 });
      return;
    }
    case 'shield':
      shieldUp(v, { variant: '', pitch: 1, size: 1, seed: 0, local: false, dist: 0, flavor: '' });
      return;
    case 'stealth':
      stealthSound(v);
      return;
  }
}

export const abilityCast: Recipe = (v, o) => {
  whoosh(v, { lo: 300, hi: 3200, dur: 0.32, peak: 0.35, q: 0.9 });
  tone(v, { freq: 90, to: 140, glide: 0.25, peak: 0.2, attack: 0.08, decay: 0.3 });
  stinger(v, o.variant, o.size > 1.2);
  abilityFlavor(v, o.flavor);
};

export const KINGDOM_VARIANTS = ['shu', 'wei', 'wu', 'qun', 'god'] as const;

// ── Life & death ─────────────────────────────────────────────────────────────
export const downed: Recipe = (v) => {
  const t = v.t;
  tone(v, { freq: 95, to: 45, glide: 0.2, peak: 0.8, attack: 0.002, decay: 0.28 });
  burst(v, { color: 'pink', type: 'lowpass', freq: 550, peak: 0.6, attack: 0.003, decay: 0.3 });
  burst(v, { color: 'white', type: 'bandpass', freq: 1500, q: 0.8, start: t + 0.04, peak: 0.15, decay: 0.12 });
  phrase(v, 'erhu', [
    { at: 0.1, midi: 69, dur: 0.35 },
    { at: 0.45, midi: 64, dur: 0.7, slide: true },
  ], undefined, 0.6);
};

export const deathGong: Recipe = (v, o) => {
  gong(v, { freq: 82 * o.pitch, dur: 4.5, vel: 0.95 });
  if (o.local) {
    taiko(v, { vel: 1, pitch: 0.8 });
    phrase(v, 'erhu', [
      { at: 0.4, midi: 64, dur: 0.6 },
      { at: 1.0, midi: 62, dur: 0.4, slide: true },
      { at: 1.4, midi: 57, dur: 1.4, slide: true },
    ], undefined, 0.8);
  }
};

export const unitDeath: Recipe = (v, o) => {
  const t = v.t;
  tone(v, { freq: 110 * o.pitch, to: 55, glide: 0.1, peak: 0.55, decay: 0.2 });
  burst(v, { color: 'pink', type: 'lowpass', freq: 700, peak: 0.45, decay: 0.18 });
  for (let i = 0; i < 3; i++) {
    bell(v, { freq: v.rnd(1400, 2400), ratios: [1, 2.3], levels: [0.5, 0.2], decays: [0.08, 0.05], start: t + 0.05 + v.rnd(0, 0.15), peak: 0.07 });
  }
};

export const killConfirm: Recipe = (v, o) => {
  const t = v.t;
  woodblock(v, { vel: 0.7, pitch: 0.8 });
  bell(v, { freq: midiToFreq(76) * o.pitch, ratios: [1, 2, 3.01], levels: [0.6, 0.25, 0.1], decays: [0.7, 0.4, 0.2], start: t + 0.02, peak: 0.25 });
  bell(v, { freq: midiToFreq(83) * o.pitch, ratios: [1, 2], levels: [0.6, 0.2], decays: [0.8, 0.4], start: t + 0.09, peak: 0.22 });
};

export const zoneHorn: Recipe = (v) => {
  const t = v.t;
  horn(v, { start: t, midi: 43, dur: 0.55, vel: 0.85 });
  horn(v, { start: t + 0.95, midi: 43, dur: 2, vel: 1 });
  taiko(v, { start: t + 0.95, vel: 0.8, pitch: 0.85 });
};

export const plane: Recipe = (v, o) => {
  // propeller drone; the engine moves the panner along a path
  const t = v.t;
  const dur = Math.max(4, o.size * 9);
  const lp = v.filter('lowpass', 900, 0.8);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.4, t + dur * 0.35);
  g.gain.setValueAtTime(0.4, t + dur * 0.55);
  g.gain.linearRampToValueAtTime(0, t + dur);
  for (const [f, det] of [
    [82, 0],
    [82, 8],
    [164, -5],
    [123, 3],
  ] as const) {
    v.osc('sawtooth', f, t, t + dur + 0.05, det).connect(lp);
  }
  // propeller chop
  const chop = v.osc('sine', 26, t, t + dur + 0.05);
  const cg = v.gain(0.25);
  const am = v.gain(0.75);
  chop.connect(cg).connect(am.gain);
  lp.connect(am).connect(g).connect(v.out);
  burst(v, { color: 'brown', type: 'lowpass', freq: 400, peak: 0.3, attack: dur * 0.4, decay: dur * 0.6 });
};

export const airdropThud: Recipe = (v) => {
  const t = v.t;
  tone(v, { freq: 62, to: 34, glide: 0.25, peak: 0.95, attack: 0.002, decay: 0.55 });
  burst(v, { color: 'brown', type: 'lowpass', freq: 800, peak: 0.8, attack: 0.002, decay: 0.45 });
  impactWood(v, 0.7);
  impactMetal(v, 0.6, 0.5);
  burst(v, { color: 'pink', type: 'bandpass', freq: 1200, q: 0.6, start: t + 0.05, peak: 0.12, attack: 0.1, decay: 0.8 });
};

// ── Status effects ───────────────────────────────────────────────────────────
function stealthSound(v: Voice): void {
  const t = v.t;
  const n = v.noise('pink', t, t + 0.5);
  const f = v.filter('bandpass', 2600, 1);
  sweep(f.frequency, t, 2600, 500, 0.45);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.3);
  g.gain.linearRampToValueAtTime(0, t + 0.45);
  v.chain(n, f, g, v.out);
  tone(v, { freq: 660, to: 330, glide: 0.4, peak: 0.06, attack: 0.1, decay: 0.4 });
}

export const status: Recipe = (v, o) => {
  const t = v.t;
  switch (o.variant) {
    case 'stun':
      for (let i = 0; i < 3; i++) tone(v, { freq: 2400 + i * 300, to: 3200 + i * 200, glide: 0.06, start: t + i * 0.11, peak: 0.12, decay: 0.08 });
      tone(v, { freq: 1800, start: t, peak: 0.08, attack: 0.02, decay: 0.8 });
      taiko(v, { vel: 0.4, pitch: 1.4 });
      return;
    case 'freeze':
      iceShatter(v, { ...o, size: 0.5 });
      return;
    case 'burn':
      burst(v, { color: 'pink', type: 'bandpass', freq: 500, to: 2500, q: 0.8, peak: 0.45, attack: 0.04, decay: 0.4 });
      crackles(v, { dur: 0.6, peak: 0.25, freq: 1600 });
      return;
    case 'charm': {
      const os = v.osc('sine', 1320, t, t + 0.9);
      const fm = v.osc('sine', 7, t, t + 0.9);
      const fg = v.gain(60);
      fm.connect(fg).connect(os.frequency);
      sweep(os.frequency, t, 1320, 1760, 0.6);
      const g = v.gain(0);
      perc(g.gain, t, 0.15, 0.1, 0.75);
      v.chain(os, g, v.out);
      bell(v, { freq: midiToFreq(88), ratios: [1, 2], levels: [0.6, 0.2], decays: [0.6, 0.3], start: t + 0.1, peak: 0.1 });
      return;
    }
    case 'dance': {
      const notes = [76, 79, 81, 79, 84];
      notes.forEach((m, i) => guzheng(v, { start: t + i * 0.1, midi: m, vel: 0.6 }));
      woodblock(v, { start: t, vel: 0.5 });
      woodblock(v, { start: t + 0.2, vel: 0.4, pitch: 1.2 });
      return;
    }
    case 'silence':
      burst(v, { color: 'white', type: 'lowpass', freq: 3500, to: 250, q: 0.7, peak: 0.35, attack: 0.02, decay: 0.45 });
      return;
    case 'stealth':
      return stealthSound(v);
    case 'reveal': {
      for (let i = 0; i < 3; i++) tone(v, { freq: 1320, start: t + i * 0.22, peak: 0.18 / (i + 1), attack: 0.003, decay: 0.5 });
      return;
    }
    case 'root':
    case 'chain':
      return itemUse(v, { ...o, variant: 'chain' });
    case 'shield':
      return shieldUp(v, o);
    case 'invuln':
      guqin(v, { midi: 55, vel: 0.8 });
      glassChime(v, 1, 0.15);
      return;
    case 'haste':
      whoosh(v, { lo: 400, hi: 3200, dur: 0.4, peak: 0.35, q: 0.8 });
      return;
    case 'nullify':
      return glassChime(v, 1.2, 0.3);
    default: {
      // generic buff: rising filtered saw + chime
      const lp = v.filter('lowpass', 200, 4);
      sweep(lp.frequency, t, 200, 3200, 0.35);
      const g = v.gain(0);
      perc(g.gain, t, 0.15, 0.05, 0.4);
      v.osc('sawtooth', 220, t, t + 0.5).connect(lp);
      lp.connect(g).connect(v.out);
      bell(v, { freq: midiToFreq(84), ratios: [1, 2], levels: [0.6, 0.2], decays: [0.5, 0.2], start: t + 0.2, peak: 0.1 });
    }
  }
};

export const STATUS_VARIANTS = ['stun', 'freeze', 'burn', 'charm', 'dance', 'silence', 'stealth', 'reveal', 'root', 'shield', 'invuln', 'haste', 'nullify', 'buff'] as const;

export const reward: Recipe = (v, o) => {
  const t = v.t;
  if (o.variant === 'penalty') {
    [69, 65, 62].forEach((m, i) => tone(v, { type: 'triangle', freq: midiToFreq(m - 12), start: t + i * 0.18, peak: 0.25, attack: 0.01, decay: 0.35 }));
    taiko(v, { start: t + 0.5, vel: 0.7, pitch: 0.8 });
    return;
  }
  for (let i = 0; i < 7; i++) {
    const at = t + i * 0.055 + v.rnd(0, 0.02);
    bell(v, { freq: v.rnd(3000, 5200), ratios: [1, 1.34], levels: [0.6, 0.4], decays: [0.18, 0.12], start: at, peak: 0.1 });
  }
  sparkle(v, t + 0.2, 0.13, 4, 84);
};

export const claim: Recipe = (v) => {
  // 印章 seal stamp: woody thock + paper
  tone(v, { freq: 185, to: 120, glide: 0.05, peak: 0.6, decay: 0.09 });
  burst(v, { type: 'bandpass', freq: 900, q: 1.2, peak: 0.45, decay: 0.05 });
  burst(v, { color: 'white', type: 'highpass', freq: 3500, peak: 0.1, decay: 0.04 });
};

export const hurt: Recipe = (v, o) => {
  const s = clamp(o.size, 0.5, 1.6);
  const sat = saturator(v, 2.2, 0.65);
  tone(v, { freq: 85, to: 48, glide: 0.08, peak: 0.9 * s, attack: 0.002, decay: 0.16, dest: sat });
  burst(v, { color: 'pink', type: 'lowpass', freq: 450, peak: 0.7 * s, decay: 0.12, dest: sat });
  burst(v, { color: 'white', type: 'bandpass', freq: 1300, q: 1.5, peak: 0.15, decay: 0.05 });
};

export const heartbeat: Recipe = (v, o) => {
  const t = v.t;
  const lp = v.filter('lowpass', 180, 0.8);
  lp.connect(v.out);
  tone(v, { freq: 72, to: 48, glide: 0.08, start: t, peak: 1, attack: 0.004, decay: 0.16, dest: lp });
  tone(v, { freq: 62, to: 44, glide: 0.08, start: t + 0.19 / Math.max(0.6, o.pitch), peak: 0.7, attack: 0.004, decay: 0.14, dest: lp });
};

export const tinnitus: Recipe = (v) => {
  tone(v, { freq: 3700, start: v.t, peak: 0.05, attack: 0.03, decay: 3 });
};

export const zoneTick: Recipe = (v) => {
  burst(v, { color: 'white', type: 'bandpass', freq: 2200, q: 1.5, peak: 0.3, attack: 0.005, decay: 0.15 });
  crackles(v, { dur: 0.25, peak: 0.25, freq: 2000 });
};

export const splash: Recipe = (v, o) => impactWater(v, o.pitch);
export const clang: Recipe = (v, o) => impactMetal(v, o.pitch);
export const drum: Recipe = (v, o) => taiko(v, { vel: clamp(o.size, 0.3, 1.2) });
export const gongHit: Recipe = (v, o) => gong(v, { freq: 110 * o.pitch, dur: 3, vel: 0.8 });
export const bigCymbal: Recipe = (v) => cymbal(v, { vel: 0.8 });
export const rimHit: Recipe = (v) => rim(v, { vel: 0.8 });

/** Local-player squad order drum signals. */
export const command: Recipe = (v, o) => {
  const t = v.t;
  switch (o.variant) {
    case 'hold':
      taiko(v, { vel: 0.8 });
      return;
    case 'attack':
      for (let i = 0; i < 3; i++) smallDrum(v, { start: t + i * 0.09, vel: 0.6 + i * 0.1 });
      return;
    case 'charge':
      horn(v, { start: t, midi: 50, dur: 0.35, vel: 0.7 });
      taiko(v, { start: t, vel: 0.8 });
      return;
    case 'mark':
      woodblock(v, { vel: 0.7, pitch: 1.3 });
      tone(v, { freq: 1760, start: t + 0.05, peak: 0.12, decay: 0.25 });
      return;
    default:
      smallDrum(v, { vel: 0.6 });
      smallDrum(v, { start: t + 0.14, vel: 0.7 });
  }
};

export const COMMAND_VARIANTS = ['follow', 'hold', 'attack', 'charge', 'mark'] as const;

