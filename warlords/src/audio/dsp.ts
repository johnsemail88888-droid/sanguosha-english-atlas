// Low-level synthesis helpers shared by SFX recipes and music instruments.
// `Kit` caches generated buffers (noise, plucked strings, crackle, impulse
// responses) per BaseAudioContext so live and offline contexts both work.

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Small fast seeded PRNG for buffer generation (not gameplay). */
export function mulberry(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizePeak(d: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const k = target / peak;
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

export function fillNoise(d: Float32Array, color: NoiseColor, rnd: () => number): void {
  if (color === 'white') {
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
  } else if (color === 'pink') {
    // Paul Kellet's refined pink filter
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rnd() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last;
    }
  }
  // remove DC then normalise
  let mean = 0;
  for (let i = 0; i < d.length; i++) mean += d[i];
  mean /= d.length || 1;
  for (let i = 0; i < d.length; i++) d[i] -= mean;
  normalizePeak(d, 0.95);
}

export interface PluckOptions {
  /** seconds until -60 dB at the fundamental */
  t60: number;
  /** 0..1 excitation brightness */
  bright: number;
  /** 0..0.5 pluck position along the string (small = nasal / bright) */
  pos: number;
  seed: number;
}

/**
 * Karplus–Strong plucked string with an all-pass fractional delay for exact
 * tuning. Returns mono samples normalised to ~0.8 peak.
 */
export function karplusStrong(sr: number, freq: number, dur: number, o: PluckOptions): Float32Array {
  const n = Math.max(1, Math.floor(sr * dur));
  const out = new Float32Array(n);
  const period = sr / Math.max(20, freq);
  let L = Math.floor(period - 0.5 - 0.1);
  if (L < 2) L = 2;
  const frac = Math.max(0.05, period - 0.5 - L);
  const C = (1 - frac) / (1 + frac);
  const line = new Float32Array(L);
  const rnd = mulberry(o.seed);
  // excitation: low-passed noise burst with a pluck-position comb
  const a = 0.08 + 0.9 * Math.min(1, Math.max(0, o.bright));
  let lp = 0;
  const exc = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    lp += a * (rnd() * 2 - 1 - lp);
    exc[i] = lp;
  }
  const pp = Math.max(1, Math.round(Math.min(0.5, Math.max(0.02, o.pos)) * L));
  let mean = 0;
  for (let i = 0; i < L; i++) {
    line[i] = exc[i] - 0.9 * exc[(i - pp + L) % L];
    mean += line[i];
  }
  mean /= L;
  for (let i = 0; i < L; i++) line[i] -= mean;
  const g = Math.pow(10, -3 / (Math.max(20, freq) * Math.max(0.05, o.t60)));
  let idx = 0;
  let prev = 0;
  let apX1 = 0;
  let apY1 = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[idx];
    out[i] = cur;
    const avg = 0.5 * (cur + prev);
    prev = cur;
    const ap = C * avg + apX1 - C * apY1;
    apX1 = avg;
    apY1 = ap;
    line[idx] = ap * g;
    idx++;
    if (idx >= L) idx = 0;
  }
  normalizePeak(out, 0.8);
  // de-click fade at the end
  const fade = Math.min(n, Math.floor(sr * 0.02));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

/** Sparse crackle (fire / debris): Poisson pops with power-law amplitudes. */
export function crackle(sr: number, dur: number, rate: number, seed: number): Float32Array {
  const n = Math.max(1, Math.floor(sr * dur));
  const d = new Float32Array(n);
  const rnd = mulberry(seed);
  let t = 0;
  while (true) {
    t += -Math.log(1 - rnd() * 0.999) / rate;
    const start = Math.floor(t * sr);
    if (start >= n) break;
    const amp = Math.pow(rnd(), 2.2) * (rnd() < 0.08 ? 1 : 0.45);
    const len = Math.floor(sr * (0.0015 + rnd() * 0.006));
    const tone = 0.3 + rnd() * 0.6;
    let lp = 0;
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp((-5 * i) / len);
      lp += tone * (rnd() * 2 - 1 - lp);
      d[start + i] += lp * amp * env;
    }
  }
  normalizePeak(d, 0.9);
  return d;
}

/** Soft clipper curve: identity below `knee`, tanh-saturating to `ceiling`. Input range ±`inRange`. */
export function softClipCurve(n = 4096, knee = 0.7, ceiling = 0.98, inRange = 2): Float32Array {
  const c = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * inRange;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Symmetric tanh drive curve normalised to ±1. */
export function driveCurve(amount: number, n = 2048): Float32Array {
  const c = new Float32Array(n);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

export interface ImpulseOptions {
  seconds: number;
  /** seconds to -60 dB */
  t60: number;
  predelay: number;
  /** high-frequency damping 0..1 (1 = dark tail) */
  damping: number;
  /** discrete early reflections (outdoor slap) */
  early: number;
  /** late discrete echoes (valley / city walls) */
  echoes?: number;
  seed: number;
}

/** Stereo reverb impulse response, energy-normalised (unity power gain). */
export function impulseResponse(sr: number, o: ImpulseOptions): Float32Array[] {
  const n = Math.max(1, Math.floor(sr * o.seconds));
  const chans: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(n);
    const rnd = mulberry(o.seed + ch * 7919);
    const pre = Math.floor(o.predelay * sr);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9 * t) / o.t60);
      // damping increases over time → darker tail
      const a = Math.max(0.03, 1 - o.damping * Math.min(1, t / (o.t60 * 0.6)));
      lp += a * (rnd() * 2 - 1 - lp);
      d[i] = lp * env;
    }
    // discrete reflections: early slap (8–80 ms) and distant valley echoes, each
    // a short smeared burst so they read as echoes rather than clicks
    const taps = o.early + (o.echoes ?? 0);
    for (let k = 0; k < taps; k++) {
      const late = k >= o.early;
      const time = late ? 0.16 + rnd() * 0.45 : 0.008 + rnd() * 0.07;
      const at = pre + Math.floor(time * sr);
      const amp = (rnd() < 0.5 ? -1 : 1) * (late ? 2.5 + rnd() * 3 : 2 + rnd() * 3.5);
      const len = Math.floor(sr * (late ? 0.006 : 0.002));
      for (let i = 0; i < len && at + i < n; i++) d[at + i] += amp * Math.exp((-4 * i) / len) * (rnd() * 0.6 + 0.4);
    }
    // fade-in over 3 ms to avoid a hard onset
    const fin = Math.min(n - pre, Math.floor(sr * 0.003));
    for (let i = 0; i < fin; i++) d[pre + i] *= i / fin;
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const k = e > 1e-12 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < n; i++) d[i] *= k;
    chans.push(d);
  }
  return chans;
}

// ── Kit: per-context buffer cache ────────────────────────────────────────────
// Generated sample data is cached per sample rate at module level, so the many
// short-lived OfflineAudioContexts used for baking share one copy.
const rawCache = new Map<string, Float32Array>();

function raw(key: string, make: () => Float32Array): Float32Array {
  let d = rawCache.get(key);
  if (!d) {
    d = make();
    rawCache.set(key, d);
  }
  return d;
}

const PLUCK_CACHE = 64;
/**
 * Byte budgets of the pluck caches (they fill as the music plays new notes and
 * would otherwise keep ~40 MB of samples for the whole session): the live
 * context's AudioBuffers, and the module-level sample data shared with the
 * short-lived baking contexts (a second copy — kept small).
 */
const PLUCK_BYTES = 10 * 1024 * 1024;
const PLUCK_DATA_BYTES = 4 * 1024 * 1024;
const pluckData = new Map<string, { data: Float32Array; sr: number }>();
let pluckDataBytes = 0;

/** Bytes held by the module-level pluck sample cache (diagnostics / tests). */
export const pluckDataCacheBytes = (): number => pluckDataBytes;

export class Kit {
  readonly sr: number;
  /** cheaper synthesis (low quality setting) */
  lite = false;
  private noises = new Map<NoiseColor, AudioBuffer>();
  private plucks = new Map<string, AudioBuffer>();
  private pluckBytes = 0;
  private curves = new Map<string, Float32Array>();
  private crackles: AudioBuffer | null = null;
  private debrisBuf: AudioBuffer | null = null;

  constructor(readonly ctx: BaseAudioContext) {
    this.sr = ctx.sampleRate;
  }

  private mono(data: Float32Array, sr = this.sr): AudioBuffer {
    const b = this.ctx.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    return b;
  }

  noise(color: NoiseColor): AudioBuffer {
    let b = this.noises.get(color);
    if (!b) {
      const sr = this.sr;
      const d = raw(`noise:${color}:${sr}`, () => {
        const a = new Float32Array(Math.floor(sr * 2));
        fillNoise(a, color, mulberry(color === 'white' ? 11 : color === 'pink' ? 23 : 37));
        return a;
      });
      b = this.mono(d);
      this.noises.set(color, b);
    }
    return b;
  }

  /**
   * Cached plucked-string buffer (quantised to 1/4 semitone). Rendered at
   * <= 32 kHz and cut at ~-45 dB to keep the cache small (LRU).
   */
  pluck(freq: number, t60: number, bright: number, pos: number, variant = 0): AudioBuffer {
    const q = Math.round(12 * 4 * Math.log2(freq / 440));
    const key = `${q}|${Math.round(t60 * 10)}|${Math.round(bright * 10)}|${Math.round(pos * 50)}|${variant}`;
    let b = this.plucks.get(key);
    if (b) {
      this.plucks.delete(key);
      this.plucks.set(key, b);
      return b;
    }
    const sr = Math.min(this.sr, 32000);
    const dataKey = `${key}|${sr}`;
    let entry = pluckData.get(dataKey);
    if (entry) {
      pluckData.delete(dataKey); // re-inserted below as the newest
    } else {
      const f = 440 * Math.pow(2, q / 48);
      const dur = Math.min(3, Math.max(0.25, t60 * 0.75));
      entry = { data: karplusStrong(sr, f, dur, { t60, bright, pos, seed: 101 + q * 13 + variant * 977 }), sr };
      pluckDataBytes += entry.data.byteLength;
    }
    pluckData.set(dataKey, entry);
    // LRU by count and bytes (the newest entry always stays)
    while (pluckData.size > 1 && (pluckData.size > PLUCK_CACHE * 2 || pluckDataBytes > PLUCK_DATA_BYTES)) {
      const oldest = pluckData.keys().next().value as string;
      pluckDataBytes -= pluckData.get(oldest)?.data.byteLength ?? 0;
      pluckData.delete(oldest);
    }
    b = this.mono(entry.data, entry.sr);
    this.plucks.set(key, b);
    this.pluckBytes += b.length * 4;
    while (this.plucks.size > 1 && (this.plucks.size > PLUCK_CACHE || this.pluckBytes > PLUCK_BYTES)) {
      const oldest = this.plucks.keys().next().value as string;
      this.pluckBytes -= (this.plucks.get(oldest)?.length ?? 0) * 4;
      this.plucks.delete(oldest);
    }
    return b;
  }

  crackle(): AudioBuffer {
    if (!this.crackles) {
      const sr = this.sr;
      this.crackles = this.mono(raw(`crackle:${sr}`, () => crackle(sr, 4, 34, 4242)));
    }
    return this.crackles;
  }

  debris(): AudioBuffer {
    if (!this.debrisBuf) {
      const sr = this.sr;
      this.debrisBuf = this.mono(
        raw(`debris:${sr}`, () => {
          const d = crackle(sr, 2.5, 22, 777);
          for (let i = 0; i < d.length; i++) d[i] *= Math.exp((-2.2 * i) / sr);
          return d;
        }),
      );
    }
    return this.debrisBuf;
  }

  curve(name: string, make: () => Float32Array): Float32Array {
    let c = this.curves.get(name);
    if (!c) {
      c = raw(`curve:${name}`, make);
      this.curves.set(name, c);
    }
    return c;
  }

  drive(amount: number): Float32Array {
    const k = Math.round(amount * 10) / 10;
    return this.curve(`drive:${k}`, () => driveCurve(k));
  }

  impulse(o: ImpulseOptions): AudioBuffer {
    const data = impulseResponse(this.sr, o);
    const b = this.ctx.createBuffer(2, data[0].length, this.sr);
    b.getChannelData(0).set(data[0]);
    b.getChannelData(1).set(data[1]);
    return b;
  }
}

const kits = new WeakMap<BaseAudioContext, Kit>();

export function kitFor(ctx: BaseAudioContext): Kit {
  let k = kits.get(ctx);
  if (!k) {
    k = new Kit(ctx);
    kits.set(ctx, k);
  }
  return k;
}

// ── Envelope helpers ─────────────────────────────────────────────────────────
const FLOOR = 1e-5;

/** Percussive envelope: linear attack to `peak`, exponential decay to -60 dB. Returns end time. */
export function perc(p: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  const a = Math.max(0.0005, attack);
  const end = t + a + Math.max(0.005, decay);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(Math.max(FLOOR, Math.abs(peak) * 1e-3), end);
  p.setValueAtTime(0, end + 0.001);
  return end;
}

/** Attack / hold / release envelope. Returns end time. */
export function ahr(p: AudioParam, t: number, peak: number, attack: number, hold: number, release: number): number {
  const a = Math.max(0.001, attack);
  const end = t + a + hold + Math.max(0.01, release);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setValueAtTime(peak, t + a + hold);
  p.exponentialRampToValueAtTime(Math.max(FLOOR, Math.abs(peak) * 1e-3), end);
  p.setValueAtTime(0, end + 0.001);
  return end;
}

/** Exponential sweep of a positive-valued param. */
export function sweep(p: AudioParam, t: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(Math.max(FLOOR, from), t);
  p.exponentialRampToValueAtTime(Math.max(FLOOR, to), t + Math.max(0.001, dur));
}
