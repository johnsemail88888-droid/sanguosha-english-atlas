// Sample bank: pre-renders ("bakes") the most frequent procedural sounds into
// AudioBuffers with OfflineAudioContexts after unlock, so a big firefight
// costs one buffer source per shot instead of a dozen oscillators/filters.
// Live synthesis stays the fallback until (and unless) a sample is baked.
import type { SfxName } from './catalog';
import { SFX } from './catalog';
import { GUN_SOUNDS } from './classify';
import { kitFor } from './dsp';
import { offlineContextCtor } from './env';
import { cymbal, gong, rim, smallDrum, taiko, woodblock } from './recipes/instruments';
import type { RecipeOpts } from './recipes/types';
import { Voice } from './voice';

/** Distance buckets baked for positional sounds. */
export type BakeMode = 'L' | 'N' | 'F';

/** remote sounds beyond this distance use the "far" bake (tail-heavy, dull) */
export const FAR_DISTANCE = 70;

export const bakeKey = (name: string, variant: string, mode: BakeMode): string => `${name}|${variant}|${mode}`;

export function bakeModeFor(local: boolean, dist: number): BakeMode {
  return local ? 'L' : dist > FAR_DISTANCE ? 'F' : 'N';
}

export type DrumKind = 'taiko' | 'rim' | 'smallDrum' | 'woodblock' | 'cymbal' | 'gong';

export const drumKey = (kind: DrumKind, pitch: number): string => `drum|${kind}|${Math.round(pitch * 100)}`;

interface BakeJob {
  key: string;
  seconds: number;
  /** render sample rate (far / dull sounds bake at a lower rate) */
  rate: number;
  write: (v: Voice) => void;
}

function sfxJob(name: SfxName, variant: string, mode: BakeMode, rate: number, seconds: number): BakeJob {
  const d = SFX[name];
  const o: RecipeOpts = {
    variant,
    pitch: 1,
    size: 1,
    seed: 0.5,
    local: mode === 'L',
    dist: mode === 'F' ? 130 : mode === 'N' ? 12 : 0,
    flavor: '',
  };
  return { key: bakeKey(name, variant, mode), seconds, rate, write: (v) => d.recipe(v, o) };
}

const GUN_SECONDS: Record<string, number> = { sniper: 2.6, shotgun: 1.7, dmr: 1.6, launcher: 1.3, rifle: 1.3, lmg: 1.3 };

/** The default bake plan, most valuable first. `variants` = random takes per key. */
export function defaultBakePlan(sampleRate: number, variants = 3): BakeJob[] {
  const jobs: BakeJob[] = [];
  const hi = sampleRate;
  const lo = Math.min(sampleRate, 24000);
  const guns = GUN_SOUNDS.filter((g) => g !== 'flamer');
  for (let k = 0; k < variants; k++) {
    for (const g of guns) {
      const sec = GUN_SECONDS[g] ?? 1.1;
      jobs.push(sfxJob('gun', g, 'N', hi, sec));
      if (k < 2) jobs.push(sfxJob('gun', g, 'F', lo, sec + 0.4));
      jobs.push(sfxJob('gun', g, 'L', hi, sec));
    }
    for (const m of ['flesh', 'dirt', 'stone', 'wood', 'metal', 'water', 'soft', 'shield', 'armor']) jobs.push(sfxJob('impact', m, 'N', hi, 0.6));
    for (const f of ['dirt', 'stone', 'wood', 'water', 'hoof', 'land']) jobs.push(sfxJob('footstep', f, 'N', lo, 0.3));
    jobs.push(sfxJob('flyby', '', 'N', hi, 0.3));
    jobs.push(sfxJob('casing', '', 'L', hi, 0.5));
    jobs.push(sfxJob('hitmarker', '', 'L', hi, 0.1));
  }
  // music drums: velocity becomes gain, so one take per pitch suffices (two for taiko)
  for (const p of [0.8, 0.85, 0.92, 1.05, 1.1, 1.4, 1.5]) {
    for (let k = 0; k < 2; k++) jobs.push({ key: drumKey('taiko', p), seconds: 0.95, rate: hi, write: (v) => taiko(v, { vel: 1, pitch: p }) });
  }
  jobs.push({ key: drumKey('rim', 1), seconds: 0.12, rate: hi, write: (v) => rim(v, { vel: 1 }) });
  jobs.push({ key: drumKey('smallDrum', 1), seconds: 0.3, rate: hi, write: (v) => smallDrum(v, { vel: 1 }) });
  for (const p of [0.9, 1, 1.12]) jobs.push({ key: drumKey('woodblock', p), seconds: 0.15, rate: hi, write: (v) => woodblock(v, { vel: 1, pitch: p }) });
  jobs.push({ key: drumKey('cymbal', 1), seconds: 1.3, rate: hi, write: (v) => cymbal(v, { vel: 1, dur: 1.1 }) });
  jobs.push({ key: drumKey('gong', 1), seconds: 2.4, rate: hi, write: (v) => gong(v, { freq: 110, dur: 2.2, vel: 1 }) });
  return jobs;
}

async function renderJob(job: BakeJob): Promise<AudioBuffer | null> {
  const Ctor = offlineContextCtor();
  if (!Ctor) return null;
  const len = Math.max(1, Math.ceil(job.seconds * job.rate));
  const ctx = new Ctor(1, len, job.rate);
  const v = new Voice(kitFor(ctx), 0);
  job.write(v);
  v.out.connect(ctx.destination);
  const buf = await ctx.startRendering();
  // trim trailing near-silence
  const d = buf.getChannelData(0);
  let last = d.length - 1;
  while (last > 0 && Math.abs(d[last]) < 1e-4) last--;
  let peak = 0;
  for (let i = 0; i <= last; i++) {
    const a = Math.abs(d[i]);
    if (!Number.isFinite(a)) return null;
    if (a > peak) peak = a;
  }
  if (peak < 1e-5) return null;
  const keep = Math.min(d.length, last + Math.ceil(job.rate * 0.005));
  if (keep >= d.length - 64 || typeof AudioBuffer === 'undefined') return buf;
  try {
    const out = new AudioBuffer({ length: keep, sampleRate: job.rate, numberOfChannels: 1 });
    out.copyToChannel(d.subarray(0, keep), 0);
    return out;
  } catch {
    return buf;
  }
}

export class SampleBank {
  private bank = new Map<string, AudioBuffer[]>();
  private cancelled = false;
  private baking: Promise<void> | null = null;
  /** number of baked buffers */
  count = 0;
  /** total baked sample frames (memory estimate: × 4 bytes) */
  frames = 0;

  get ready(): boolean {
    return this.count > 0 && !this.baking;
  }

  has(key: string): boolean {
    return (this.bank.get(key)?.length ?? 0) > 0;
  }

  /** A random take for `key`, or null when not baked (yet). */
  pick(key: string): AudioBuffer | null {
    const list = this.bank.get(key);
    if (!list || !list.length) return null;
    return list[(Math.random() * list.length) | 0];
  }

  add(key: string, buf: AudioBuffer): void {
    let list = this.bank.get(key);
    if (!list) this.bank.set(key, (list = []));
    list.push(buf);
    this.count++;
    this.frames += buf.length;
  }

  /** Bake a plan sequentially, yielding between jobs. Resolves when done or cancelled. */
  bake(jobs: readonly BakeJob[]): Promise<void> {
    if (this.baking) return this.baking;
    this.cancelled = false;
    this.baking = (async () => {
      for (const job of jobs) {
        if (this.cancelled) break;
        try {
          const buf = await renderJob(job);
          if (buf && !this.cancelled) this.add(job.key, buf);
        } catch {
          /* a failed bake just keeps live synthesis for that key */
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    })().finally(() => {
      this.baking = null;
    });
    return this.baking;
  }

  cancel(): void {
    this.cancelled = true;
  }

  clear(): void {
    this.cancel();
    this.bank.clear();
    this.count = 0;
    this.frames = 0;
  }
}
