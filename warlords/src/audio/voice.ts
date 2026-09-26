// Voice: a tiny node factory used by recipes. It records every scheduled
// source so a voice can be stopped early (voice stealing) and knows when it
// ends (cleanup). All output goes into `voice.out`.
import type { Kit, NoiseColor } from './dsp';

export class Voice {
  readonly out: GainNode;
  /** latest scheduled stop time (ctx seconds) */
  end: number;
  private sources: AudioScheduledSourceNode[] = [];
  private stopped = false;

  constructor(
    readonly kit: Kit,
    /** start time of the voice (ctx seconds) */
    readonly t: number,
  ) {
    this.out = kit.ctx.createGain();
    this.end = t;
  }

  get ctx(): BaseAudioContext {
    return this.kit.ctx;
  }

  private stops = new Map<AudioScheduledSourceNode, number>();

  private track(src: AudioScheduledSourceNode, stop: number): void {
    this.sources.push(src);
    this.stops.set(src, stop);
    if (stop > this.end) this.end = stop;
  }

  osc(type: OscillatorType, freq: number, start: number, stop: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(0.01, freq), start);
    if (detune) o.detune.setValueAtTime(detune, start);
    o.start(start);
    o.stop(stop);
    this.track(o, stop);
    return o;
  }

  /** Looping noise source starting at a random offset. */
  noise(color: NoiseColor, start: number, stop: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    const buf = this.kit.noise(color);
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.setValueAtTime(rate, start);
    s.start(start, Math.random() * Math.max(0, buf.duration - 0.05));
    s.stop(stop);
    this.track(s, stop);
    return s;
  }

  /** One-shot (or looping) buffer playback. */
  buffer(buf: AudioBuffer, start: number, rate = 1, opts?: { loop?: boolean; stop?: number; offset?: number }): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = !!opts?.loop;
    s.playbackRate.setValueAtTime(rate, start);
    const stop = opts?.stop ?? start + buf.duration / Math.max(0.05, rate) + 0.01;
    s.start(start, opts?.offset ?? 0);
    s.stop(stop);
    this.track(s, stop);
    return s;
  }

  /** Constant signal (for modulation offsets). */
  constant(value: number, start: number, stop: number): ConstantSourceNode | null {
    const c = this.ctx as BaseAudioContext & { createConstantSource?: () => ConstantSourceNode };
    if (typeof c.createConstantSource !== 'function') return null;
    const s = c.createConstantSource();
    s.offset.setValueAtTime(value, start);
    s.start(start);
    s.stop(stop);
    this.track(s, stop);
    return s;
  }

  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(this.kit.sr * 0.45, Math.max(10, freq));
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  shaper(curve: Float32Array): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = curve as Float32Array<ArrayBuffer>;
    return w;
  }

  delay(seconds: number, max = 1): DelayNode {
    const d = this.ctx.createDelay(Math.max(max, seconds + 0.01));
    d.delayTime.value = seconds;
    return d;
  }

  /** Connect nodes in series; returns the first node. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[0];
  }

  /** Series chain ending in this voice's output. */
  toOut(...nodes: AudioNode[]): AudioNode {
    return this.chain(...nodes, this.out);
  }

  /**
   * Connect the output to `dest` and disconnect it automatically when the
   * last source ends (fire-and-forget notes that are not pooled).
   */
  finish(dest: AudioNode): void {
    this.out.connect(dest);
    let last: AudioScheduledSourceNode | null = null;
    let lastEnd = -Infinity;
    // sources are tracked in scheduling order; pick the one with the latest stop
    for (const s of this.sources) {
      const e = this.stops.get(s) ?? 0;
      if (e >= lastEnd) {
        lastEnd = e;
        last = s;
      }
    }
    if (last) {
      last.onended = () => {
        try {
          this.out.disconnect();
        } catch {
          /* already disconnected */
        }
      };
    }
  }

  /** Stop every source at `at` (used after a fade when stealing / ending loops). */
  stopAt(at: number): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sources) {
      try {
        s.stop(at);
      } catch {
        /* already stopped */
      }
    }
    if (at < this.end) this.end = at;
  }

  /** Clamp a frequency to the valid range for this context. */
  hz(f: number): number {
    return Math.min(this.kit.sr * 0.45, Math.max(10, f));
  }

  /** Random in [lo, hi). */
  rnd(lo = 0, hi = 1): number {
    return lo + (hi - lo) * Math.random();
  }
}
