// Offline rendering helpers: render any sound / music track / scenario
// through the real mixing chain into an OfflineAudioContext and measure it.
// Used by the dev page and the Playwright test (peak < 1, finite, audible).
import type { Vec3 } from '../core/math';
import type { GameEvent } from '../core/types';
import type { Quality } from '../game/settings';
import type { ViewSource } from '../render/view';
import { defaultBakePlan, SampleBank } from './bake';
import type { SfxName } from './catalog';
import { offlineContextCtor } from './env';
import { MixGraph } from './graph';
import { MusicPlayer } from './music';
import type { MusicTrack } from './music';
import type { LoopName } from './recipes/loops';
import { EventRouter } from './router';
import type { SoundSink } from './router';
import { SfxEngine } from './sfx';
import type { LoopOpts, PlayOpts } from './sfx';
import { renderWithStallRetry } from './stall';

export interface RenderStats {
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  finite: boolean;
  silent: boolean;
  seconds: number;
  sampleRate: number;
}

export function analyze(buf: AudioBuffer): RenderStats {
  let peak = 0;
  let sum = 0;
  let n = 0;
  let finite = true;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (!Number.isFinite(x)) {
        finite = false;
        continue;
      }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      sum += x * x;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return {
    peak,
    peakDb: db(peak),
    rms,
    rmsDb: db(rms),
    finite,
    silent: peak < 1e-4,
    seconds: buf.duration,
    sampleRate: buf.sampleRate,
  };
}

export interface OfflineSession {
  ctx: OfflineAudioContext;
  graph: MixGraph;
  sfx: SfxEngine;
  music: MusicPlayer;
  /** schedule `fn` to run when rendering reaches `time` (seconds) */
  at(time: number, fn: () => void): void;
}

export interface RenderOptions {
  sampleRate?: number;
  quality?: Quality;
  /** master, music, sfx (0..1); default all 1 = worst case for clipping */
  volumes?: [number, number, number];
  listener?: { pos: Vec3; yaw: number; pitch: number };
  /** play baked samples from this bank where available */
  bank?: SampleBank | null;
  /** a render whose clock has not moved for this long is redone on a fresh context (ms, default RENDER_STALL_MS) */
  stallMs?: number;
}

let sharedBank: SampleBank | null = null;
let sharedBankReady: Promise<SampleBank> | null = null;

/** Bake (once) and return a bank at `sampleRate` for offline renders / dev checks. */
export function bakedBank(sampleRate = 48000, variants = 1): Promise<SampleBank> {
  if (!sharedBankReady) {
    sharedBank = new SampleBank();
    const bank = sharedBank;
    sharedBankReady = bank.bake(defaultBakePlan(sampleRate, variants)).then(() => bank);
  }
  return sharedBankReady;
}

/**
 * Render `seconds` of audio: `build` wires the session (sounds, music, a
 * timeline of `at` callbacks — the render suspends at each and resumes after).
 * Chromium sometimes freezes a render right after such a resume (stall.ts):
 * a render whose clock stops moving is abandoned and redone once on a fresh
 * context, so `build` may run twice — it must only touch the session it gets.
 */
export async function renderOffline(
  seconds: number,
  build: (s: OfflineSession) => void,
  o: RenderOptions = {},
): Promise<{ buffer: AudioBuffer; stats: RenderStats }> {
  const Ctor = offlineContextCtor();
  if (!Ctor) throw new Error('OfflineAudioContext unavailable');
  const sr = o.sampleRate ?? 48000;
  const buffer = await renderWithStallRetry(
    () => {
      const ctx = new Ctor(2, Math.max(1, Math.ceil(seconds * sr)), sr);
      return { clock: ctx, done: renderOn(ctx, seconds, build, o) };
    },
    {
      stallMs: o.stallMs,
      onStall: (attempt, at) =>
        console.warn(`[audio] offline render stalled at ${at.toFixed(4)} s (attempt ${attempt + 1})${attempt === 0 ? ', retrying on a fresh context' : ''}`),
    },
  );
  return { buffer, stats: analyze(buffer) };
}

/** One offline render of `build`'s session on `ctx`. */
function renderOn(ctx: OfflineAudioContext, seconds: number, build: (s: OfflineSession) => void, o: RenderOptions): Promise<AudioBuffer> {
  const sr = ctx.sampleRate;
  const graph = new MixGraph(ctx, o.quality ?? 'high', false);
  graph.bank = o.bank ?? null;
  const [mv, muv, sv] = o.volumes ?? [1, 1, 1];
  graph.setVolumes(mv, muv, sv);
  const l = o.listener ?? { pos: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0 };
  graph.setListener(l.pos, l.yaw, l.pitch);
  const sfx = new SfxEngine(graph, o.quality === 'low' ? 20 : 32);
  const music = new MusicPlayer(graph);
  const timeline = new Map<number, (() => void)[]>();
  const quantum = 128 / sr;
  const session: OfflineSession = {
    ctx,
    graph,
    sfx,
    music,
    at: (time, fn) => {
      const q = Math.max(1, Math.round(time / quantum)) * quantum;
      const list = timeline.get(q);
      if (list) list.push(fn);
      else timeline.set(q, [fn]);
    },
  };
  build(session);
  let failures = 0;
  for (const [t, fns] of timeline) {
    if (t >= seconds) continue;
    ctx
      .suspend(t)
      .then(() => {
        // never leave the render suspended, even if a callback throws
        try {
          for (const fn of fns) fn();
          sfx.update();
        } catch (err) {
          if (failures++ < 3) console.warn('[audio] offline timeline callback failed', err);
        }
        return ctx.resume();
      })
      .catch((err: unknown) => console.warn('[audio] offline suspend failed', err));
  }
  return ctx.startRendering();
}

export interface SfxRenderRequest extends PlayOpts {
  /** seconds to render (default: 3) */
  seconds?: number;
  /** repeat the sound `count` times `every` seconds apart */
  count?: number;
  every?: number;
}

/** Render one catalog sound (optionally repeated) through the full chain. */
export async function renderSfx(name: SfxName, req: SfxRenderRequest = {}, o: RenderOptions = {}): Promise<RenderStats> {
  const seconds = req.seconds ?? 3;
  const { stats } = await renderOffline(
    seconds,
    (s) => {
      const count = Math.max(1, req.count ?? 1);
      for (let i = 0; i < count; i++) {
        s.at(0.02 + i * (req.every ?? 0.1), () => s.sfx.play(name, req));
      }
    },
    o,
  );
  return stats;
}

/** Render a loop for `seconds`. */
export async function renderLoop(name: LoopName, opts: LoopOpts = {}, seconds = 2, o: RenderOptions = {}): Promise<RenderStats> {
  const { stats } = await renderOffline(
    seconds,
    (s) => {
      for (let t = 0.02; t < seconds - 0.4; t += 0.1) s.at(t, () => s.sfx.loop('dev', name, { ...opts, keepAlive: 0.5 }));
    },
    o,
  );
  return stats;
}

export async function renderMusic(track: MusicTrack, seconds: number, intensity = 0.5, o: RenderOptions = {}): Promise<RenderStats> {
  const { stats } = await renderOffline(
    seconds,
    (s) => {
      s.music.setIntensity(intensity);
      s.music.play(track);
      s.music.pump(seconds);
    },
    o,
  );
  return stats;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
export type Scenario = 'shotguns8' | 'firefight' | 'explosions' | 'fullMix';

export const SCENARIOS: readonly Scenario[] = ['shotguns8', 'firefight', 'explosions', 'fullMix'];

function ring(i: number, n: number, r: number): Vec3 {
  const a = (i / n) * Math.PI * 2;
  return { x: Math.cos(a) * r, y: 1.4, z: Math.sin(a) * r };
}

/** Minimal ViewSource for driving the event router offline / on the dev page. */
export function fakeView(entities: ViewSource['entities'] extends () => infer R ? R : never, localId: number | null = null): ViewSource {
  const byId = new Map(entities.map((e) => [e.id, e]));
  return {
    map: { seed: 0, nameZh: '', nameEn: '', size: 320, res: 1, heights: new Float32Array(4), waterLevel: -100, props: [], colliders: [], lordSpawn: { x: 0, y: 0, z: 0 }, spawns: [], lootSpots: [], crateSpots: [], camps: [], regions: [] },
    update: () => undefined,
    entities: () => entities,
    get: (id) => byId.get(id),
    localId: () => localId,
    local: () => null,
    zone: () => ({ phase: 0, center: { x: 0, y: 0, z: 0 }, radius: 230, targetCenter: { x: 0, y: 0, z: 0 }, targetRadius: 230, shrinkStart: 0, shrinkEnd: 0, dps: 0 }),
    players: () => [],
    drainEvents: () => [],
    viewTick: () => 0,
    elapsed: () => 0,
    result: () => null,
    pushInput: () => undefined,
  };
}

function offlineSink(s: OfflineSession): SoundSink {
  return {
    now: () => s.ctx.currentTime,
    listener: () => s.graph.listenerPos,
    play: (name, o) => s.sfx.play(name, o),
    loop: (key, name, o) => s.sfx.loop(key, name, o),
    music: (track) => s.music.play(track),
    dipMusic: (db, hold) => s.graph.dipMusic(db, hold),
    autoDowned: () => undefined,
    downedUrgency: () => undefined,
  };
}

export async function renderScenario(name: Scenario, seconds = 4, o: RenderOptions = {}): Promise<RenderStats> {
  const { stats } = await renderOffline(
    seconds,
    (s) => {
      if (name === 'shotguns8') {
        // eight shotguns firing on the same frame, three volleys
        for (let v = 0; v < 3; v++) {
          s.at(0.05 + v * 0.8, () => {
            for (let i = 0; i < 8; i++) s.sfx.play('gun', { variant: 'shotgun', pos: ring(i, 8, 6), priority: 2 });
            s.sfx.play('gun', { variant: 'shotgun', local: true, group: 'gun:local', priority: 4 });
          });
        }
      } else if (name === 'explosions') {
        for (let i = 0; i < 6; i++) {
          s.at(0.05 + i * 0.12, () => s.sfx.play('explosion', { pos: ring(i, 6, 4 + i * 3), variant: i % 3 === 0 ? 'fire' : 'frag', size: 2 }));
        }
        s.at(0.3, () => s.sfx.play('lightning', { pos: { x: 3, y: 2, z: -5 }, size: 2 }));
      } else {
        // a firefight driven through the real event router
        const shooters = Array.from({ length: 8 }, (_, i) => {
          const p = ring(i, 8, 10 + i * 6);
          return {
            id: i + 1,
            kind: 'hero' as const,
            sub: 'guanyu',
            x: p.x,
            y: 0,
            z: p.z,
            yaw: 0,
            pitch: 0,
            speed: i % 2 ? 4 : 0,
            hp: 400,
            maxHp: 400,
            shield: 0,
            flags: 0,
            weapon: ['qinglong', 'pistol', 'smg', 'zhangba', 'qilin', 'fangtian', 'huben', 'liegong'][i],
          };
        });
        // 张角 with the chain-lightning staff: a primary shot plus two arcs per volley
        const tesla = { ...shooters[0], id: 20, sub: 'zhangjiao', x: -14, z: -9, speed: 0, weapon: 'taiping' };
        const view = fakeView([...shooters, tesla], 99);
        const router = new EventRouter(offlineSink(s));
        const weapons = ['qinglong', 'pistol', 'smg', 'zhangba', 'qilin', 'fangtian', 'huben', 'liegong'];
        for (let f = 0; f < Math.floor((seconds - 0.5) * 30); f++) {
          const t = 0.05 + f / 30;
          s.at(t, () => {
            const events: GameEvent[] = [];
            for (let i = 0; i < shooters.length; i++) {
              const rate = [9, 4, 12, 1.2, 0.6, 0.8, 11, 1][i];
              if (Math.random() < rate / 30) {
                const e = shooters[i];
                events.push({ t: 'shot', src: e.id, weapon: weapons[i], from: { x: e.x, y: 1.4, z: e.z }, to: { x: Math.random() * 4 - 2, y: 1, z: Math.random() * 4 - 2 } });
              }
            }
            if (f % 20 === 0) events.push({ t: 'hit', target: 99, src: 1, amount: 30, dtype: 'normal', pos: { x: 0, y: 1.4, z: 0 } });
            if (f % 45 === 10) events.push({ t: 'explosion', pos: { x: 8, y: 0, z: -6 }, radius: 6, kind: 'rocket' });
            if (name === 'fullMix' && f % 30 === 5) events.push({ t: 'ability', src: 1 + (f % 8), ability: 'zhangjiao_leiji' });
            if (name === 'fullMix' && f % 24 === 12) {
              const a = shooters[f % 8];
              const b = shooters[(f + 3) % 8];
              events.push(
                { t: 'shot', src: tesla.id, weapon: 'taiping', from: { x: tesla.x, y: 1.6, z: tesla.z }, to: { x: a.x, y: 1.2, z: a.z }, hit: a.id },
                { t: 'shot', src: tesla.id, weapon: 'taiping', from: { x: a.x, y: 0.9, z: a.z }, to: { x: b.x, y: 0.9, z: b.z }, hit: b.id },
                { t: 'shot', src: tesla.id, weapon: 'taiping', from: { x: b.x, y: 0.9, z: b.z }, to: { x: 1, y: 0.9, z: -2 }, hit: 99 },
              );
            }
            router.handle(events, view);
            if (name === 'fullMix' && f % 4 === 0) router.localFire('qinglong');
          });
        }
        if (name === 'fullMix') {
          s.music.setIntensity(1);
          s.music.play('battle');
          s.music.pump(seconds);
        }
      }
    },
    o,
  );
  return stats;
}

/** Render a -20 dBFS sine through the world bus to verify unity gain below the limiter threshold. */
export async function renderCalibration(o: RenderOptions = {}): Promise<RenderStats> {
  const { stats } = await renderOffline(
    1,
    (s) => {
      const osc = s.ctx.createOscillator();
      osc.frequency.value = 1000;
      const g = s.ctx.createGain();
      g.gain.value = 0.1;
      osc.connect(g).connect(s.graph.ui);
      osc.start(0);
      osc.stop(1);
    },
    { ...o, quality: 'low' },
  );
  return stats;
}
