// Reusable synthesis gestures for recipes.
import { perc, sweep } from '../dsp';
import type { NoiseColor } from '../dsp';
import type { Voice } from '../voice';

/** Filtered noise burst with a percussive envelope. Returns the envelope gain node. */
export function burst(
  v: Voice,
  o: {
    color?: NoiseColor;
    type?: BiquadFilterType;
    freq: number;
    q?: number;
    /** end frequency for a filter sweep */
    to?: number;
    sweepTime?: number;
    start?: number;
    peak: number;
    attack?: number;
    decay: number;
    rate?: number;
    dest?: AudioNode;
  },
): GainNode {
  const t = o.start ?? v.t;
  const attack = o.attack ?? 0.001;
  const n = v.noise(o.color ?? 'white', t, t + attack + o.decay + 0.03, o.rate ?? 1);
  const f = v.filter(o.type ?? 'bandpass', o.freq, o.q ?? 0.9);
  if (o.to !== undefined) sweep(f.frequency, t, v.hz(o.freq), v.hz(o.to), o.sweepTime ?? o.decay);
  const g = v.gain(0);
  perc(g.gain, t, o.peak, attack, o.decay);
  v.chain(n, f, g, o.dest ?? v.out);
  return g;
}

/** Oscillator with optional exponential pitch glide and percussive envelope. */
export function tone(
  v: Voice,
  o: {
    type?: OscillatorType;
    freq: number;
    to?: number;
    glide?: number;
    start?: number;
    peak: number;
    attack?: number;
    decay: number;
    detune?: number;
    dest?: AudioNode;
  },
): OscillatorNode {
  const t = o.start ?? v.t;
  const attack = o.attack ?? 0.001;
  const osc = v.osc(o.type ?? 'sine', o.freq, t, t + attack + o.decay + 0.03, o.detune ?? 0);
  if (o.to !== undefined) sweep(osc.frequency, t, o.freq, o.to, o.glide ?? o.decay);
  const g = v.gain(0);
  perc(g.gain, t, o.peak, attack, o.decay);
  v.chain(osc, g, o.dest ?? v.out);
  return osc;
}

/** Inharmonic bell / metal: partial ratios with individual decays. */
export function bell(
  v: Voice,
  o: {
    freq: number;
    ratios: readonly number[];
    levels: readonly number[];
    decays: readonly number[];
    start?: number;
    peak: number;
    attack?: number;
    dest?: AudioNode;
    glide?: number;
  },
): void {
  const t = o.start ?? v.t;
  for (let i = 0; i < o.ratios.length; i++) {
    const f = o.freq * o.ratios[i];
    if (f > v.kit.sr * 0.45) continue;
    const osc = tone(v, {
      freq: f,
      start: t,
      peak: o.peak * (o.levels[i] ?? 0.2),
      attack: o.attack ?? 0.001,
      decay: o.decays[i] ?? o.decays[o.decays.length - 1],
      dest: o.dest,
    });
    if (o.glide) sweep(osc.frequency, t, f, f * o.glide, (o.decays[i] ?? 1) * 0.8);
  }
}

/** Plucked string (Karplus–Strong buffer) with optional pitch bend. */
export function pluck(
  v: Voice,
  o: {
    freq: number;
    start?: number;
    peak: number;
    t60: number;
    bright?: number;
    pos?: number;
    /** pitch bend ratio (guzheng 按音) applied at `bendAt` */
    bend?: number;
    bendAt?: number;
    /** initial pitch ratio settling to 1 over 80 ms (bow string) */
    sag?: number;
    dest?: AudioNode;
  },
): AudioBufferSourceNode {
  const t = o.start ?? v.t;
  const buf = v.kit.pluck(o.freq, o.t60, o.bright ?? 0.6, o.pos ?? 0.18);
  // buffers are quantised to 1/4 semitone: correct the residual with playbackRate
  const q = Math.round(48 * Math.log2(o.freq / 440));
  const rate = o.freq / (440 * Math.pow(2, q / 48));
  const s = v.buffer(buf, t, rate);
  if (o.sag && o.sag !== 1) {
    s.playbackRate.setValueAtTime(rate * o.sag, t);
    s.playbackRate.exponentialRampToValueAtTime(rate, t + 0.08);
  }
  if (o.bend && o.bend !== 1) {
    const at = t + (o.bendAt ?? 0.12);
    s.playbackRate.setValueAtTime(rate, at);
    s.playbackRate.exponentialRampToValueAtTime(rate * o.bend, at + 0.14);
  }
  const g = v.gain(o.peak);
  v.chain(s, g, o.dest ?? v.out);
  return s;
}

/** Sparse crackle layer (fire / debris / electricity). */
export function crackles(
  v: Voice,
  o: { start?: number; dur: number; peak: number; freq?: number; debris?: boolean; attack?: number; dest?: AudioNode; rate?: number },
): void {
  const t = o.start ?? v.t;
  const buf = o.debris ? v.kit.debris() : v.kit.crackle();
  const s = v.buffer(buf, t, o.rate ?? 1, {
    loop: !o.debris,
    offset: o.debris ? 0 : Math.random() * Math.max(0, buf.duration - 0.1),
    stop: t + o.dur + 0.02,
  });
  const f = v.filter('highpass', o.freq ?? 1500, 0.6);
  const g = v.gain(0);
  const a = o.attack ?? 0.01;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.peak, t + a);
  g.gain.setValueAtTime(o.peak, t + Math.max(a, o.dur * 0.5));
  g.gain.linearRampToValueAtTime(0, t + o.dur);
  v.chain(s, f, g, o.dest ?? v.out);
}

/** Air whoosh: band-passed noise sweeping up then down. */
export function whoosh(
  v: Voice,
  o: { start?: number; lo: number; hi: number; dur: number; peak: number; q?: number; color?: NoiseColor; dest?: AudioNode },
): void {
  const t = o.start ?? v.t;
  const n = v.noise(o.color ?? 'pink', t, t + o.dur + 0.05);
  const f = v.filter('bandpass', o.lo, o.q ?? 1.2);
  const mid = t + o.dur * 0.4;
  f.frequency.setValueAtTime(v.hz(o.lo), t);
  f.frequency.exponentialRampToValueAtTime(v.hz(o.hi), mid);
  f.frequency.exponentialRampToValueAtTime(v.hz(o.lo * 1.2), t + o.dur);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.peak, mid);
  g.gain.exponentialRampToValueAtTime(o.peak * 1e-3, t + o.dur);
  g.gain.setValueAtTime(0, t + o.dur + 0.001);
  v.chain(n, f, g, o.dest ?? v.out);
}

/** A saturation stage feeding the voice output at `level`. */
export function saturator(v: Voice, drive: number, level: number, dest?: AudioNode): AudioNode {
  const sh = v.shaper(v.kit.drive(drive));
  const g = v.gain(level);
  sh.connect(g).connect(dest ?? v.out);
  return sh;
}
