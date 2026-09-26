// Procedural score. A lookahead sequencer schedules notes slightly ahead of
// the audio clock (`pump(until)`); the same code renders offline by pumping
// the whole duration at once.
//
//  menu    72 BPM, 羽 mode on A: 笙-like pad, flowing 古筝 arpeggios with
//          glissandi, 二胡 melody in the second half, soft frame drum.
//  battle  128 BPM, 羽 mode on D: 战鼓 taiko + rims, driving bass, 古筝 16ths,
//          二胡 lead, 唢呐 doubling at high intensity, cymbal/gong accents.
//          Layers follow setIntensity() smoothly.
//  victory / defeat: one-shot stingers.
import {
  bassPattern,
  degreeToMidi,
  layerGain,
  makeMelody,
  MODES,
  rimPattern,
  RHYTHMS_DRIVING,
  RHYTHMS_SLOW,
  taikoPattern,
} from './composition';
import type { MelodyNote } from './composition';
import { drumKey } from './bake';
import type { DrumKind } from './bake';
import type { MixGraph } from './graph';
import { BowedLine, bass, cymbal, glissando, gong, guzheng, pad, phrase, rim, smallDrum, taiko, woodblock } from './recipes/instruments';
import type { BowedTimbre } from './recipes/instruments';
import { bell } from './recipes/common';
import { midiToFreq } from './composition';
import { Voice } from './voice';

export type MusicTrack = 'menu' | 'battle' | 'victory' | 'defeat';

export const MUSIC_TRACKS: readonly MusicTrack[] = ['menu', 'battle', 'victory', 'defeat'];

abstract class Song {
  readonly bus: GainNode;
  protected readonly send: GainNode;
  protected nextTime: number;
  protected stepIdx = 0;
  protected readonly stepDur: number;
  protected intensity = 0;
  protected readonly lines: Voice[] = [];
  ended = false;
  /** absolute end time for one-shot songs */
  endsAt = Infinity;

  constructor(
    protected readonly g: MixGraph,
    readonly track: MusicTrack,
    bpm: number,
    start: number,
    level: number,
  ) {
    const ctx = g.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.gain.setValueAtTime(0, start);
    this.bus.gain.linearRampToValueAtTime(level, start + 0.8);
    this.send = ctx.createGain();
    this.send.gain.value = 0.32;
    this.bus.connect(g.music);
    this.bus.connect(this.send).connect(g.musicSend);
    this.stepDur = 60 / bpm / 4;
    this.nextTime = start;
  }

  protected layer(level: number): GainNode {
    const n = this.g.ctx.createGain();
    n.gain.value = level;
    n.connect(this.bus);
    return n;
  }

  /** Fire-and-forget note voice routed to `dest`. */
  protected note(t: number, dest: AudioNode, write: (v: Voice) => void): void {
    const v = new Voice(this.g.kit, t);
    write(v);
    v.finish(dest);
  }

  /**
   * Percussion hit: a baked sample when available (one buffer source), else
   * live synthesis. Baked takes are recorded at velocity 1, so vel = gain.
   */
  protected drum(t: number, dest: AudioNode, kind: DrumKind, vel: number, pitch: number, synth: (v: Voice) => void): void {
    const buf = this.g.bank?.pick(drumKey(kind, pitch));
    if (!buf) {
      this.note(t, dest, synth);
      return;
    }
    const ctx = this.g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vel;
    src.connect(g).connect(dest);
    src.start(t);
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  /** Long-lived voice (legato line) that must be cut when the song stops. */
  protected longNote(t: number, dest: AudioNode, write: (v: Voice) => void): void {
    const v = new Voice(this.g.kit, t);
    write(v);
    v.finish(dest);
    this.lines.push(v);
    if (this.lines.length > 8) this.lines.shift();
  }

  schedule(until: number): void {
    // after a long stall (background tab), skip missed steps instead of bursting them
    const now = this.g.ctx.currentTime;
    if (this.nextTime < now - 0.05) {
      const skip = Math.ceil((now - this.nextTime) / this.stepDur);
      this.stepIdx += skip;
      this.nextTime += skip * this.stepDur;
    }
    while (!this.ended && this.nextTime < until) {
      this.onStep(this.stepIdx, this.nextTime);
      this.stepIdx++;
      this.nextTime += this.stepDur;
    }
  }

  protected abstract onStep(step: number, t: number): void;

  setIntensity(x: number): void {
    this.intensity = x;
  }

  fadeOut(at: number, time: number): void {
    const p = this.bus.gain;
    p.cancelScheduledValues(at);
    p.setValueAtTime(p.value, at);
    p.linearRampToValueAtTime(0, at + time);
    this.ended = true;
    for (const v of this.lines) v.stopAt(at + time + 0.05);
    this.endsAt = Math.min(this.endsAt, at + time);
  }

  dispose(): void {
    try {
      this.bus.disconnect();
      this.send.disconnect();
    } catch {
      /* ignore */
    }
  }
}

// ── Menu ─────────────────────────────────────────────────────────────────────
const MENU_ROOT = 45; // A2
const MENU_CHORDS: readonly { deg: number; pad: readonly number[] }[] = [
  { deg: 0, pad: [45, 52, 57, 60] },
  { deg: 1, pad: [48, 55, 60, 64] },
  { deg: 2, pad: [50, 57, 62, 64] },
  { deg: 3, pad: [40, 52, 57, 62] },
];
const MENU_ARPS: readonly (readonly number[])[] = [
  [0, 3, 5, 6, 8, 6, 5, 3],
  [0, 3, 5, 7, 5, 3, 2, 3],
  [0, 2, 3, 5, 6, 5, 3, 2],
  [0, 3, 5, 8, 7, 5, 6, 3],
];

class MenuSong extends Song {
  private readonly padL: GainNode;
  private readonly zheng: GainNode;
  private readonly lead: GainNode;
  private readonly perc: GainNode;
  private cycle = 0;
  private melody: MelodyNote[] = [];

  constructor(g: MixGraph, start: number) {
    super(g, 'menu', 72, start, 0.9);
    this.padL = this.layer(0.7);
    this.zheng = this.layer(0.75);
    this.lead = this.layer(0.5);
    this.perc = this.layer(0.7);
  }

  protected onStep(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const barInCycle = bar % 16;
    if (barInCycle === 0 && s === 0) {
      this.cycle = Math.floor(bar / 16);
      this.melody = makeMelody(7 + this.cycle * 31, {
        cadences: [3, 0, 3, 0],
        barsPerPhrase: 2,
        rhythms: RHYTHMS_SLOW,
        lo: 3,
        hi: 11,
        leap: 0.8,
      });
    }
    const chord = MENU_CHORDS[Math.floor(barInCycle / 2) % 4];
    if (s === 0 && barInCycle % 2 === 0) {
      this.note(t, this.padL, (v) => pad(v, { midis: chord.pad, dur: this.stepDur * 32, vel: 0.8, bright: 0.35 }));
    }
    // opening flourish of each cycle
    if (barInCycle === 0 && s === 0) {
      const midis: number[] = [];
      for (let d = 5; d <= 16; d++) midis.push(degreeToMidi(MENU_ROOT, MODES.yu, d));
      this.note(t, this.zheng, (v) => glissando(v, { midis, span: 0.55, vel: 0.55 }));
    }
    // arpeggio: 8th notes (softer in the erhu section)
    if (s % 2 === 0 && !(barInCycle === 0 && s < 4)) {
      const pat = MENU_ARPS[(bar + this.cycle) % MENU_ARPS.length];
      const deg = chord.deg + 5 + pat[s / 2];
      const accent = s === 0 ? 1 : s === 8 ? 0.85 : 0.65;
      const section = barInCycle >= 8 ? 0.6 : 0.85;
      this.note(t, this.zheng, (v) => guzheng(v, { midi: degreeToMidi(MENU_ROOT, MODES.yu, deg), vel: accent * section }));
    }
    // melody: guzheng in bars 4-7, erhu in bars 8-15
    if (barInCycle >= 4 && barInCycle < 8) {
      const local = (barInCycle - 4) * 16 + s;
      for (const n of this.melody) {
        if (n.step === local) {
          const midi = degreeToMidi(MENU_ROOT + 12, MODES.yu, n.deg);
          const bend = n.len >= 8 && ((n.step * 7 + this.cycle) % 4 === 0) ? 1.0595 : undefined;
          this.note(t, this.zheng, (v) => guzheng(v, { midi, vel: 0.9 * n.vel, bend }));
        }
      }
    }
    if (barInCycle === 8 && s === 0) this.scheduleErhu(t);
    // soft frame drum + woodblock
    if (s === 0) this.drum(t, this.perc, 'taiko', 0.45, 0.8, (v) => taiko(v, { vel: 0.45, pitch: 0.8 }));
    if (s === 10 && bar % 2 === 1) this.drum(t, this.perc, 'taiko', 0.3, 0.85, (v) => taiko(v, { vel: 0.3, pitch: 0.85 }));
    if (s === 12 && bar % 4 === 3) this.drum(t, this.perc, 'woodblock', 0.3, 0.9, (v) => woodblock(v, { vel: 0.3, pitch: 0.9 }));
    // wind-chime at phrase ends
    if (s === 8 && bar % 4 === 3) {
      this.note(t, this.zheng, (v) => {
        for (let i = 0; i < 3; i++) {
          const m = degreeToMidi(MENU_ROOT + 36, MODES.yu, 2 + i * 2);
          bell(v, { freq: midiToFreq(m), ratios: [1, 2.76], levels: [0.5, 0.1], decays: [1.2, 0.4], start: t + i * 0.09, peak: 0.05 });
        }
      });
    }
  }

  private scheduleErhu(t: number): void {
    const notes = this.melody;
    if (!notes.length) return;
    const sd = this.stepDur;
    const last = notes[notes.length - 1];
    this.longNote(t, this.lead, (v) => {
      const line = new BowedLine(v, 'erhu', t, t + (last.step + last.len) * sd, v.out, 0.9);
      notes.forEach((n, i) => {
        const next = notes[i + 1];
        const legato = !!next && next.step === n.step + n.len && Math.abs(next.deg - n.deg) <= 2;
        const slide = i > 0 && Math.abs(n.deg - notes[i - 1].deg) >= 2;
        line.note(t + n.step * sd, degreeToMidi(MENU_ROOT + 12, MODES.yu, n.deg), n.len * sd, 0.75 + 0.25 * n.vel, legato, slide);
      });
      line.release(t + (last.step + last.len) * sd, 0.4);
    });
  }
}

// ── Battle ───────────────────────────────────────────────────────────────────
const BATTLE_ROOT = 38; // D2
const BATTLE_PROG_A = [0, 0, -1, -2];
const BATTLE_PROG_B = [0, 1, -1, -2];
const ARP16 = [0, 3, 5, 3, 0, 3, 5, 7, 0, 3, 5, 3, 5, 7, 8, 7];

class BattleSong extends Song {
  private readonly drums: GainNode;
  private readonly bassL: GainNode;
  private readonly arps: GainNode;
  private readonly lead: GainNode;
  private readonly lead2: GainNode;
  private readonly padL: GainNode;
  private melody: MelodyNote[] = [];
  private smooth = 0;

  constructor(g: MixGraph, start: number, intensity: number) {
    super(g, 'battle', 128, start, 0.85);
    this.intensity = intensity;
    this.smooth = intensity;
    this.drums = this.layer(0);
    this.bassL = this.layer(0);
    this.arps = this.layer(0);
    this.lead = this.layer(0);
    this.lead2 = this.layer(0);
    this.padL = this.layer(0);
    this.applyLayers(start, 0.01);
  }

  private gains(i: number): Record<'drums' | 'bass' | 'arps' | 'lead' | 'lead2' | 'pad', number> {
    return {
      drums: 0.5 + 0.5 * i,
      bass: 0.15 + 0.65 * layerGain(i, 0.3),
      arps: 0.7 * layerGain(i, 0.4),
      lead: 0.8 * layerGain(i, 0.55),
      lead2: 0.6 * layerGain(i, 0.8),
      pad: 0.55 - 0.25 * i,
    };
  }

  private applyLayers(t: number, tc: number): void {
    const gs = this.gains(this.intensity);
    this.drums.gain.setTargetAtTime(gs.drums, t, tc);
    this.bassL.gain.setTargetAtTime(gs.bass, t, tc);
    this.arps.gain.setTargetAtTime(gs.arps, t, tc);
    this.lead.gain.setTargetAtTime(gs.lead, t, tc);
    this.lead2.gain.setTargetAtTime(gs.lead2, t, tc);
    this.padL.gain.setTargetAtTime(gs.pad, t, tc);
  }

  override setIntensity(x: number): void {
    if (Math.abs(x - this.intensity) < 0.01) return;
    this.intensity = x;
    this.applyLayers(this.g.ctx.currentTime, 1.2);
  }

  protected onStep(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    if (s === 0) this.smooth += (this.intensity - this.smooth) * 0.5;
    const I = this.smooth;
    const gs = this.gains(I);
    const prog = Math.floor(bar / 4) % 2 === 0 ? BATTLE_PROG_A : BATTLE_PROG_B;
    const chordDeg = prog[bar % 4];
    // drums
    const tp = taikoPattern(I, bar);
    if (tp[s] > 0) {
      const pitch = s % 8 === 0 ? 0.92 : 1.05;
      this.drum(t, this.drums, 'taiko', tp[s], pitch, (v) => taiko(v, { vel: tp[s], pitch }));
    }
    const rp = rimPattern(I);
    if (rp[s] > 0) {
      if (s % 4 === 2) this.drum(t, this.drums, 'rim', rp[s], 1, (v) => rim(v, { vel: rp[s] }));
      else this.drum(t, this.drums, 'smallDrum', rp[s] * 0.8, 1, (v) => smallDrum(v, { vel: rp[s] * 0.8 }));
    }
    if (s === 0 && bar % 4 === 0 && I > 0.45) {
      const vel = 0.35 + 0.3 * I;
      this.drum(t, this.drums, 'cymbal', vel, 1, (v) => cymbal(v, { vel, dur: 1.1 }));
    }
    if (s === 0 && bar % 8 === 0 && I > 0.6) this.drum(t, this.drums, 'gong', 0.45, 1, (v) => gong(v, { freq: 110, dur: 2.2, vel: 0.45 }));
    // bass (8ths)
    if (s % 2 === 0) {
      const bp = bassPattern(I);
      const off = bp[s / 2];
      if (off !== null) {
        const midi = degreeToMidi(BATTLE_ROOT, MODES.yu, chordDeg + off);
        const len = I < 0.35 ? this.stepDur * 7 : this.stepDur * 1.7;
        this.note(t, this.bassL, (v) => bass(v, { midi, dur: len, vel: 0.65 + 0.3 * I + (s === 0 ? 0.05 : 0) }));
      }
    }
    // pad glue
    if (s === 0 && gs.pad > 0.05) {
      const root = degreeToMidi(BATTLE_ROOT + 12, MODES.yu, chordDeg);
      this.note(t, this.padL, (v) => pad(v, { midis: [root, root + 7, root + 12], dur: this.stepDur * 15, vel: 0.7, bright: 0.25 }));
    }
    // guzheng arps: 8ths at mid, 16ths at high intensity
    if (gs.arps > 0.02) {
      const dense = I > 0.62;
      if (dense || s % 2 === 0) {
        const deg = chordDeg + 5 + ARP16[s];
        const vel = (s % 4 === 0 ? 0.8 : 0.55) * (dense ? 0.85 : 1);
        this.note(t, this.arps, (v) => guzheng(v, { midi: degreeToMidi(BATTLE_ROOT + 12, MODES.yu, deg), vel }));
      }
    }
    // lead: an 8-bar melody every 8 bars when the lead layer is active
    if (s === 0 && bar % 8 === 0) {
      this.melody = makeMelody(1000 + Math.floor(bar / 8) * 17, {
        cadences: [3, 0, 4, 0],
        barsPerPhrase: 2,
        rhythms: RHYTHMS_DRIVING,
        lo: 2,
        hi: 10,
        leap: 1,
      });
      if (gs.lead > 0.02 || layerGain(this.intensity, 0.55) > 0.02) this.scheduleLead(t, 'erhu', this.lead, BATTLE_ROOT + 24, 1);
      if (gs.lead2 > 0.02 || layerGain(this.intensity, 0.8) > 0.02) this.scheduleLead(t, 'suona', this.lead2, BATTLE_ROOT + 36, 0.9);
    }
  }

  private scheduleLead(t: number, timbre: BowedTimbre, dest: GainNode, root: number, level: number): void {
    const notes = this.melody;
    if (!notes.length) return;
    const sd = this.stepDur;
    const last = notes[notes.length - 1];
    this.longNote(t, dest, (v) => {
      const line = new BowedLine(v, timbre, t, t + (last.step + last.len) * sd, v.out, level);
      notes.forEach((n, i) => {
        const next = notes[i + 1];
        const legato = !!next && next.step === n.step + n.len && n.len >= 3;
        const slide = timbre === 'erhu' && i > 0 && Math.abs(n.deg - notes[i - 1].deg) >= 2;
        line.note(t + n.step * sd, degreeToMidi(root, MODES.yu, n.deg), n.len * sd, 0.7 + 0.3 * n.vel, legato, slide);
      });
      line.release(t + (last.step + last.len) * sd, 0.2);
    });
  }
}

// ── Stingers ─────────────────────────────────────────────────────────────────
class StingerSong extends Song {
  private scheduled = false;

  constructor(
    g: MixGraph,
    track: 'victory' | 'defeat',
    private readonly start: number,
  ) {
    super(g, track, 100, start, 1);
    this.endsAt = start + (track === 'victory' ? 7 : 8);
  }

  override schedule(until: number): void {
    if (this.scheduled || until < this.start) return;
    this.scheduled = true;
    const t = this.start;
    const out = this.layer(1);
    if (this.track === 'victory') {
      // drum roll → gong + fanfare
      this.note(t, out, (v) => {
        for (let i = 0; i < 16; i++) smallDrum(v, { start: t + i * 0.075, vel: 0.3 + i * 0.04 });
        taiko(v, { start: t + 1.2, vel: 1 });
        cymbal(v, { start: t + 1.2, vel: 0.7, dur: 2 });
        gong(v, { start: t + 1.2, freq: 110, dur: 4, vel: 0.8 });
        const glis: number[] = [];
        for (let d = 0; d <= 10; d++) glis.push(degreeToMidi(60, MODES.gong, d));
        glissando(v, { start: t + 1.2, midis: glis, span: 0.5, vel: 0.7 });
        pad(v, { start: t + 1.2, midis: [48, 55, 60, 64, 67], dur: 3.5, vel: 0.9, bright: 0.6 });
        taiko(v, { start: t + 3.3, vel: 0.9 });
        taiko(v, { start: t + 3.55, vel: 1 });
        cymbal(v, { start: t + 3.55, vel: 0.6, dur: 2.2 });
      });
      const fan = [
        { at: 1.2, midi: 72, dur: 0.28 },
        { at: 1.5, midi: 74, dur: 0.28 },
        { at: 1.8, midi: 76, dur: 0.28 },
        { at: 2.1, midi: 79, dur: 0.28 },
        { at: 2.4, midi: 81, dur: 0.55 },
        { at: 2.98, midi: 79, dur: 0.3 },
        { at: 3.3, midi: 84, dur: 2.2, slide: true },
      ];
      this.longNote(t, out, (v) => phrase(v, 'suona', fan, v.out, 0.9));
      this.longNote(t, out, (v) => phrase(v, 'erhu', fan.map((n) => ({ ...n, midi: n.midi - 12 })), v.out, 0.6));
    } else {
      this.note(t, out, (v) => {
        gong(v, { start: t, freq: 73, dur: 5, vel: 0.8 });
        taiko(v, { start: t, vel: 0.9, pitch: 0.8 });
        pad(v, { start: t + 0.3, midis: [45, 52, 57, 60], dur: 5, vel: 0.85, bright: 0.15 });
        guzheng(v, { start: t + 2.6, midi: 45, vel: 0.6 });
        guzheng(v, { start: t + 4.2, midi: 40, vel: 0.5, bend: 0.944 });
        taiko(v, { start: t + 3.5, vel: 0.35, pitch: 0.75 });
        taiko(v, { start: t + 3.72, vel: 0.25, pitch: 0.7 });
      });
      this.longNote(t, out, (v) =>
        phrase(v, 'erhu', [
          { at: 0.5, midi: 69, dur: 1 },
          { at: 1.5, midi: 67, dur: 0.5, slide: true },
          { at: 2.0, midi: 64, dur: 0.8, slide: true },
          { at: 2.8, midi: 62, dur: 0.5, slide: true },
          { at: 3.3, midi: 57, dur: 2.4, slide: true },
        ], v.out, 0.9),
      );
    }
  }

  protected onStep(): void {
    /* stingers are scheduled all at once */
  }
}

// ── Player ───────────────────────────────────────────────────────────────────
export class MusicPlayer {
  private current: Song | null = null;
  private fading: Song[] = [];
  private intensity = 0;

  constructor(private readonly g: MixGraph) {}

  get track(): MusicTrack | null {
    return this.current && !this.current.ended ? this.current.track : null;
  }

  play(track: MusicTrack | null, fade = 1.2): void {
    const now = this.g.ctx.currentTime;
    if (track && this.current && !this.current.ended && this.current.track === track) return;
    if (this.current) {
      this.current.fadeOut(now, track === 'victory' || track === 'defeat' ? 0.4 : fade);
      this.fading.push(this.current);
      this.current = null;
    }
    if (!track) return;
    const start = now + 0.08;
    switch (track) {
      case 'menu':
        this.current = new MenuSong(this.g, start);
        break;
      case 'battle':
        this.current = new BattleSong(this.g, start, this.intensity);
        break;
      default:
        this.current = new StingerSong(this.g, track, start);
    }
    this.current.setIntensity(this.intensity);
  }

  setIntensity(x: number): void {
    const v = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    this.intensity = v;
    this.current?.setIntensity(v);
  }

  /** Schedule everything up to ctx time `until`. */
  pump(until: number): void {
    const now = this.g.ctx.currentTime;
    if (this.current) {
      this.current.schedule(until);
      if (this.current.endsAt < now - 3) {
        this.current.dispose();
        this.current = null;
      }
    }
    if (this.fading.length) {
      this.fading = this.fading.filter((s) => {
        if (s.endsAt + 3 < now) {
          s.dispose();
          return false;
        }
        return true;
      });
    }
  }

  stop(fade = 0.5): void {
    this.play(null, fade);
  }

  dispose(): void {
    this.current?.dispose();
    for (const s of this.fading) s.dispose();
    this.current = null;
    this.fading = [];
  }
}
