// Synthesised traditional instruments shared by the music sequencer and SFX:
// 战鼓 taiko, rim "ka", 小堂鼓, 木鱼 woodblock, 锣 gong, 钹 cymbal, 古筝 guzheng
// (Karplus–Strong), bass, 笙-like pad, 号角 war horn, and legato bowed/blown
// lines (二胡 erhu, 唢呐 suona, 笛子 dizi) with delayed vibrato and portamento.
import { midiToFreq } from '../composition';
import { ahr, sweep } from '../dsp';
import type { Voice } from '../voice';
import { bell, burst, pluck, tone } from './common';

interface Hit {
  start?: number;
  vel?: number;
  pitch?: number;
  dest?: AudioNode;
}

export function taiko(v: Voice, o: Hit = {}): void {
  const vel = o.vel ?? 1;
  const p = o.pitch ?? 1;
  const t = o.start ?? v.t;
  tone(v, { freq: 118 * p, to: 52 * p, glide: 0.1, start: t, peak: 0.5 * vel, attack: 0.002, decay: 0.75, dest: o.dest });
  tone(v, { freq: 192 * p, to: 96 * p, glide: 0.07, start: t, peak: 0.12 * vel, attack: 0.001, decay: 0.24, dest: o.dest });
  burst(v, { color: 'pink', type: 'lowpass', freq: 1500, start: t, peak: 0.22 * vel, decay: 0.06, dest: o.dest });
  burst(v, { color: 'brown', type: 'lowpass', freq: 260, start: t, peak: 0.18 * vel, attack: 0.004, decay: 0.32, dest: o.dest });
}

export function rim(v: Voice, o: Hit = {}): void {
  const vel = o.vel ?? 1;
  const t = o.start ?? v.t;
  burst(v, { type: 'bandpass', freq: 2100 * (o.pitch ?? 1), q: 2.5, start: t, peak: 0.55 * vel, decay: 0.03, dest: o.dest });
  tone(v, { freq: 900 * (o.pitch ?? 1), to: 780, glide: 0.03, start: t, peak: 0.22 * vel, decay: 0.035, dest: o.dest });
}

export function smallDrum(v: Voice, o: Hit = {}): void {
  const vel = o.vel ?? 1;
  const p = o.pitch ?? 1;
  const t = o.start ?? v.t;
  tone(v, { freq: 250 * p, to: 172 * p, glide: 0.05, start: t, peak: 0.55 * vel, decay: 0.2, dest: o.dest });
  burst(v, { type: 'highpass', freq: 1800, start: t, peak: 0.28 * vel, decay: 0.03, dest: o.dest });
}

export function woodblock(v: Voice, o: Hit = {}): void {
  const vel = o.vel ?? 1;
  const p = o.pitch ?? 1;
  const t = o.start ?? v.t;
  tone(v, { freq: 1150 * p, to: 1080 * p, glide: 0.05, start: t, peak: 0.5 * vel, decay: 0.085, dest: o.dest });
  tone(v, { freq: 2680 * p, start: t, peak: 0.12 * vel, decay: 0.03, dest: o.dest });
  burst(v, { type: 'bandpass', freq: 2500 * p, q: 3, start: t, peak: 0.25 * vel, decay: 0.01, dest: o.dest });
}

const GONG_RATIOS = [1, 1.47, 1.98, 2.49, 2.95, 3.53, 4.1, 4.9, 5.8, 7.1];
const GONG_LEVELS = [1, 0.7, 0.55, 0.5, 0.4, 0.3, 0.26, 0.2, 0.14, 0.1];
const GONG_DECAY = [1, 0.85, 0.75, 0.65, 0.55, 0.45, 0.4, 0.35, 0.3, 0.25];

/** 锣: inharmonic partials, downward pitch sag (大锣) or upward (小锣 when glide > 1). */
export function gong(v: Voice, o: Hit & { freq?: number; dur?: number; glide?: number } = {}): void {
  const vel = o.vel ?? 1;
  const t = o.start ?? v.t;
  const f = (o.freq ?? 90) * (o.pitch ?? 1);
  const dur = o.dur ?? 4;
  bell(v, {
    freq: f,
    ratios: GONG_RATIOS,
    levels: GONG_LEVELS,
    decays: GONG_DECAY.map((d) => d * dur),
    start: t,
    peak: 0.13 * vel,
    attack: 0.004,
    glide: o.glide ?? 0.94,
    dest: o.dest,
  });
  // tam-tam bloom: high band swells after the strike
  burst(v, { color: 'pink', type: 'bandpass', freq: f * 18, q: 0.8, start: t, peak: 0.07 * vel, attack: 0.25, decay: dur * 0.45, dest: o.dest });
  // mallet strike
  burst(v, { color: 'white', type: 'bandpass', freq: f * 6, q: 0.8, start: t, peak: 0.4 * vel, decay: 0.12, dest: o.dest });
  tone(v, { freq: f * 0.5, start: t, peak: 0.25 * vel, attack: 0.004, decay: dur * 0.35, dest: o.dest });
}

/** 钹 cymbal crash. */
export function cymbal(v: Voice, o: Hit & { dur?: number } = {}): void {
  const vel = o.vel ?? 1;
  const t = o.start ?? v.t;
  const dur = o.dur ?? 1.4;
  burst(v, { color: 'white', type: 'highpass', freq: 4200, start: t, peak: 0.3 * vel, attack: 0.001, decay: dur, dest: o.dest });
  burst(v, { color: 'white', type: 'bandpass', freq: 7200, q: 1.5, start: t, peak: 0.18 * vel, decay: dur * 0.6, dest: o.dest });
  bell(v, {
    freq: 430 * (o.pitch ?? 1),
    ratios: [1, 2.72, 4.13, 5.4, 7.3, 9.1],
    levels: [0.5, 0.5, 0.45, 0.4, 0.35, 0.3],
    decays: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map((d) => d * dur),
    start: t,
    peak: 0.045 * vel,
    dest: o.dest,
  });
}

/** 古筝 pluck. `bend` > 1 bends the note up (按音) after the attack. */
export function guzheng(v: Voice, o: { start?: number; midi: number; vel?: number; bend?: number; dest?: AudioNode }): void {
  const vel = o.vel ?? 0.8;
  const t = o.start ?? v.t;
  const f = midiToFreq(o.midi);
  const t60 = Math.max(0.9, Math.min(4, 4.2 - (o.midi - 48) * 0.085));
  pluck(v, { freq: f, start: t, peak: 0.55 * vel, t60, bright: 0.5 + 0.35 * vel, pos: 0.13, bend: o.bend, bendAt: 0.2, dest: o.dest });
  // octave shimmer of the neighbouring string (skipped in lite mode)
  if (!v.kit.lite) pluck(v, { freq: f * 2.003, start: t, peak: 0.06 * vel, t60: t60 * 0.4, bright: 0.8, pos: 0.25, dest: o.dest });
}

/** 古琴-ish low pluck (warm, long). */
export function guqin(v: Voice, o: { start?: number; midi: number; vel?: number; dest?: AudioNode }): void {
  const vel = o.vel ?? 0.8;
  const t = o.start ?? v.t;
  const f = midiToFreq(o.midi);
  pluck(v, { freq: f, start: t, peak: 0.6 * vel, t60: 3.2, bright: 0.3, pos: 0.09, bend: 0.985, bendAt: 0.5, dest: o.dest });
  pluck(v, { freq: f * 4, start: t, peak: 0.08 * vel, t60: 1.2, bright: 0.4, pos: 0.5, dest: o.dest });
}

/** Rapid pentatonic glissando (刮奏), the unmistakable guzheng flourish. */
export function glissando(v: Voice, o: { start?: number; midis: readonly number[]; span: number; vel?: number; dest?: AudioNode }): void {
  const t = o.start ?? v.t;
  const n = o.midis.length;
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 0;
    guzheng(v, { start: t + o.span * Math.pow(k, 1.15), midi: o.midis[i], vel: (o.vel ?? 0.7) * (0.55 + 0.45 * k), dest: o.dest });
  }
}

export function bass(v: Voice, o: { start?: number; midi: number; dur: number; vel?: number; dest?: AudioNode }): void {
  const vel = o.vel ?? 0.8;
  const t = o.start ?? v.t;
  const f = midiToFreq(o.midi);
  const end = t + o.dur + 0.12;
  const saw = v.osc('sawtooth', f, t, end, 4);
  const sub = v.osc('sine', f, t, end);
  const lp = v.filter('lowpass', 900, 5);
  sweep(lp.frequency, t, 380 + 900 * vel, 170, 0.2);
  const subG = v.gain(0.6);
  const g = v.gain(0);
  ahr(g.gain, t, 0.32 * vel, 0.004, Math.max(0.01, o.dur * 0.75), 0.09);
  saw.connect(lp).connect(g);
  sub.connect(subG).connect(g);
  g.connect(o.dest ?? v.out);
}

/** Soft sustained chord (笙-like), slow attack and release. */
export function pad(v: Voice, o: { start?: number; midis: readonly number[]; dur: number; vel?: number; bright?: number; dest?: AudioNode }): void {
  const vel = o.vel ?? 0.6;
  const t = o.start ?? v.t;
  const attack = Math.min(1.2, o.dur * 0.35);
  const release = 1.4;
  const end = t + o.dur + release + 0.05;
  const lp = v.filter('lowpass', 900 + 1400 * (o.bright ?? 0.5), 0.6);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.16 * vel, t + attack);
  g.gain.setValueAtTime(0.16 * vel, t + Math.max(attack, o.dur));
  g.gain.linearRampToValueAtTime(0, t + o.dur + release);
  for (const m of o.midis) {
    const f = midiToFreq(m);
    v.osc('triangle', f, t, end).connect(lp);
    const s = v.osc('sine', f * 2, t, end, 5);
    const sg = v.gain(0.25);
    s.connect(sg).connect(lp);
  }
  lp.connect(g).connect(o.dest ?? v.out);
}

/** 号角 war horn: detuned saws, pitch scoop, opening filter, breath. */
export function horn(v: Voice, o: { start?: number; midi: number; dur: number; vel?: number; dest?: AudioNode }): void {
  const vel = o.vel ?? 0.9;
  const t = o.start ?? v.t;
  const f = midiToFreq(o.midi);
  const end = t + o.dur + 0.9;
  const lp = v.filter('lowpass', 300, 1.2);
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.linearRampToValueAtTime(1700, t + 0.35);
  lp.frequency.linearRampToValueAtTime(1150, t + 0.9);
  lp.frequency.setValueAtTime(1150, t + o.dur);
  lp.frequency.linearRampToValueAtTime(350, t + o.dur + 0.7);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.3 * vel, t + 0.28);
  g.gain.setValueAtTime(0.3 * vel, t + o.dur);
  g.gain.linearRampToValueAtTime(0, t + o.dur + 0.75);
  const oscs: [OscillatorType, number, number][] = [
    ['sawtooth', 1, 0],
    ['sawtooth', 1, 9],
    ['sawtooth', 1.5, -6],
    ['square', 0.5, 0],
  ];
  for (const [type, mul, det] of oscs) {
    const os = v.osc(type, f * mul * 0.89, t, end, det);
    os.frequency.setValueAtTime(f * mul * 0.89, t);
    os.frequency.exponentialRampToValueAtTime(f * mul, t + 0.25);
    const og = v.gain(type === 'square' ? 0.35 : 0.5);
    os.connect(og).connect(lp);
  }
  const drive = v.shaper(v.kit.drive(1.6));
  lp.connect(drive).connect(g).connect(o.dest ?? v.out);
  burst(v, { color: 'pink', type: 'bandpass', freq: 850, q: 0.9, start: t, peak: 0.05 * vel, attack: 0.2, decay: o.dur + 0.4, dest: o.dest });
}

export type BowedTimbre = 'erhu' | 'suona' | 'dizi';

/**
 * A monophonic legato line (one oscillator for the whole phrase) so notes can
 * slide into each other like a real bowed/blown instrument.
 */
export class BowedLine {
  private readonly osc: OscillatorNode;
  private readonly osc2: OscillatorNode | null;
  private readonly amp: GainNode;
  private readonly vibDepth: GainNode;
  private readonly peak: number;
  private readonly vibCents: number;
  private started = false;

  constructor(
    v: Voice,
    readonly timbre: BowedTimbre,
    start: number,
    end: number,
    dest: AudioNode,
    level = 1,
  ) {
    const stop = end + 0.6;
    const first = 440;
    this.amp = v.gain(0);
    this.amp.gain.setValueAtTime(0, start);
    this.vibDepth = v.gain(0);
    const lfo = v.osc('sine', timbre === 'suona' ? 6.3 : timbre === 'dizi' ? 5.1 : 5.6, start, stop);
    lfo.connect(this.vibDepth);
    let head: AudioNode;
    if (timbre === 'erhu') {
      this.osc = v.osc('sawtooth', first, start, stop);
      this.osc2 = null;
      const hp = v.filter('highpass', 230, 0.7);
      const f1 = v.filter('peaking', 1000, 1.4, 8);
      const f2 = v.filter('peaking', 2700, 2, 5);
      const lp = v.filter('lowpass', 5200, 0.7);
      v.chain(hp, f1, f2, lp, this.amp);
      head = hp;
      // bow hair noise, follows the amplitude envelope
      const bow = v.noise('white', start, stop);
      const bf = v.filter('bandpass', 2900, 1);
      const bg = v.gain(0.045);
      v.chain(bow, bf, bg, hp);
      this.peak = 0.3 * level;
      this.vibCents = 22;
    } else if (timbre === 'suona') {
      this.osc = v.osc('sawtooth', first, start, stop);
      this.osc2 = v.osc('square', first, start, stop);
      const mix = v.gain(1);
      const sq = v.gain(0.35);
      this.osc2.connect(sq).connect(mix);
      const drive = v.shaper(v.kit.drive(2));
      const hp = v.filter('highpass', 380, 0.7);
      const f1 = v.filter('peaking', 1500, 1, 9);
      const f2 = v.filter('peaking', 3200, 1.5, 6);
      const lp = v.filter('lowpass', 6500, 0.7);
      v.chain(mix, drive, hp, f1, f2, lp, this.amp);
      head = mix;
      this.peak = 0.16 * level;
      this.vibCents = 12;
    } else {
      this.osc = v.osc('sine', first, start, stop);
      this.osc2 = v.osc('triangle', first * 2, start, stop);
      const g2 = v.gain(0.12);
      this.osc2.connect(g2).connect(this.amp);
      const breath = v.noise('white', start, stop);
      const bf = v.filter('bandpass', 2400, 2.5);
      const bg = v.gain(0.05);
      v.chain(breath, bf, bg, this.amp);
      head = this.amp;
      this.peak = 0.28 * level;
      this.vibCents = 16;
    }
    this.osc.connect(head);
    this.vibDepth.connect(this.osc.detune);
    if (this.osc2) this.vibDepth.connect(this.osc2.detune);
    this.amp.connect(dest);
  }

  /** Schedule a note. `legato` keeps the bow moving into the next note. */
  note(t: number, midi: number, dur: number, vel: number, legato: boolean, slide: boolean): void {
    const f = midiToFreq(midi);
    const fp = this.osc.frequency;
    const f2 = this.osc2?.frequency;
    const mul2 = this.timbre === 'dizi' ? 2 : 1;
    if (!this.started) {
      this.started = true;
      fp.setValueAtTime(f, t);
      f2?.setValueAtTime(f * mul2, t);
    } else if (slide) {
      fp.setTargetAtTime(f, t, 0.045);
      f2?.setTargetAtTime(f * mul2, t, 0.045);
    } else {
      fp.setTargetAtTime(f, t, 0.006);
      f2?.setTargetAtTime(f * mul2, t, 0.006);
    }
    if (this.timbre === 'suona') {
      // lip scoop into the note
      this.osc.detune.setValueAtTime(-70, t);
      this.osc.detune.linearRampToValueAtTime(0, t + 0.06);
    }
    const a = this.amp.gain;
    const pk = this.peak * vel;
    const attackTc = this.timbre === 'suona' ? 0.012 : this.timbre === 'dizi' ? 0.03 : 0.05;
    a.setTargetAtTime(pk, t, attackTc);
    // bowed swell: slight dip then bloom on long notes
    if (dur > 0.5) {
      a.setTargetAtTime(pk * 0.82, t + 0.12, 0.15);
      a.setTargetAtTime(pk, t + dur * 0.55, dur * 0.2);
    }
    const rel = Math.min(0.12, dur * 0.25);
    a.setTargetAtTime(legato ? pk * 0.55 : 0, t + dur - rel, rel / 2.5);
    // delayed vibrato
    const d = this.vibDepth.gain;
    d.setTargetAtTime(0, t, 0.02);
    d.setTargetAtTime(this.vibCents * (dur > 0.4 ? 1 : 0.4), t + Math.min(0.28, dur * 0.45), 0.12);
  }

  /** Fade the line out at `t`. */
  release(t: number, time = 0.25): void {
    this.amp.gain.setTargetAtTime(0, t, time / 3);
  }
}

/** One-shot bowed/blown phrase helper for SFX stingers. */
export function phrase(
  v: Voice,
  timbre: BowedTimbre,
  notes: readonly { at: number; midi: number; dur: number; vel?: number; slide?: boolean }[],
  dest?: AudioNode,
  level = 1,
): void {
  if (!notes.length) return;
  const last = notes[notes.length - 1];
  const line = new BowedLine(v, timbre, v.t + notes[0].at, v.t + last.at + last.dur, dest ?? v.out, level);
  notes.forEach((n, i) => {
    const next = notes[i + 1];
    const legato = !!next && Math.abs(next.at - (n.at + n.dur)) < 0.02;
    line.note(v.t + n.at, n.midi, n.dur, n.vel ?? 0.9, legato, !!n.slide);
  });
  line.release(v.t + last.at + last.dur, 0.3);
}
