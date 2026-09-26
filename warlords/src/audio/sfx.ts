// SFX engine: plays catalog recipes through the voice pool with positional
// routing (direction via PannerNode, distance via spatial.ts), and manages
// keep-alive loops that follow entities.
import type { Vec3 } from '../core/math';
import { SFX } from './catalog';
import type { SfxName } from './catalog';
import { bakeKey, bakeModeFor } from './bake';
import type { MixGraph } from './graph';
import { setPannerPos } from './graph';
import { LOOPS } from './recipes/loops';
import type { LoopName } from './recipes/loops';
import type { RecipeOpts } from './recipes/types';
import { flavorLayer } from './recipes/weapons';
import { airCutoff, distance, distanceGain, reverbSend, SPATIAL_PROFILES } from './spatial';
import type { SpatialProfileId } from './spatial';
import { Voice } from './voice';
import { THROTTLE_RULES, VoicePool } from './voices';
import type { VoiceRecord } from './voices';

export interface PlayOpts {
  /** world position; omit for non-positional (local player / UI) */
  pos?: Vec3;
  variant?: string;
  /** extra tonal layer / sub-variant */
  flavor?: string;
  /** linear level multiplier */
  gain?: number;
  pitch?: number;
  size?: number;
  /** stable 0..1 voicing seed */
  seed?: number;
  priority?: number;
  /** seconds from now */
  delay?: number;
  local?: boolean;
  /** override the throttle group */
  group?: string;
  /** move the source along a straight path (aircraft) */
  path?: { from: Vec3; to: Vec3; duration: number };
  /** spatial profile override */
  profile?: SpatialProfileId;
}

export interface LoopOpts {
  pos?: Vec3;
  gain?: number;
  pitch?: number;
  size?: number;
  priority?: number;
  profile?: SpatialProfileId;
  /** seconds without refresh before the loop fades out */
  keepAlive?: number;
}

export interface SfxHandle {
  readonly end: number;
  stop(): void;
}

interface Routing {
  lp: BiquadFilterNode | null;
  panner: PannerNode | null;
  send: GainNode | null;
}

interface LoopState {
  voice: Voice;
  rec: VoiceRecord;
  routing: Routing;
  lastSeen: number;
  keepAlive: number;
  profile: SpatialProfileId;
  level: number;
  positional: boolean;
}

const INAUDIBLE = 0.002;

export class SfxEngine {
  readonly pool: VoicePool;
  private loops = new Map<string, LoopState>();
  private errors = 0;

  constructor(
    readonly graph: MixGraph,
    maxVoices = 32,
    /** gate (e.g. live context running) */
    private readonly canPlay: () => boolean = () => true,
  ) {
    this.pool = new VoicePool(maxVoices, THROTTLE_RULES);
  }

  now(): number {
    return this.graph.ctx.currentTime;
  }

  /** voices sounding right now (scheduled ones, e.g. reload clicks, excluded) */
  get activeVoices(): number {
    return this.pool.sounding(this.now());
  }

  get activeLoops(): number {
    return this.loops.size;
  }

  private route(v: Voice, bus: 'world' | 'ui', pos: Vec3 | undefined, dist: number, profile: SpatialProfileId, wetBase: number): Routing {
    const g = this.graph;
    const ctx = g.ctx;
    if (bus === 'ui') {
      v.out.connect(g.ui);
      return { lp: null, panner: null, send: null };
    }
    let tail: AudioNode = v.out;
    let lp: BiquadFilterNode | null = null;
    let panner: PannerNode | null = null;
    if (pos) {
      const prof = SPATIAL_PROFILES[profile];
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.value = Math.min(ctx.sampleRate * 0.45, airCutoff(dist, prof));
      panner = g.panner(pos);
      v.out.connect(lp).connect(panner);
      tail = panner;
    }
    tail.connect(g.world);
    let send: GainNode | null = null;
    if (g.reverbEnabled) {
      send = ctx.createGain();
      send.gain.value = pos ? reverbSend(dist, SPATIAL_PROFILES[profile]) : wetBase;
      tail.connect(send).connect(g.worldSend);
    }
    return { lp, panner, send };
  }

  private recordFor(
    v: Voice,
    group: string,
    priority: number,
    level: number,
    r: Routing,
    fade: number,
    loop: boolean,
    onKill?: () => void,
  ): VoiceRecord {
    let disposed = false;
    return {
      id: this.pool.allocId(),
      group,
      priority,
      start: v.t,
      end: loop ? Infinity : v.end,
      kill: (at: number) => {
        onKill?.();
        const p = v.out.gain;
        p.cancelScheduledValues(at);
        p.setValueAtTime(p.value > 0 ? p.value : level, at);
        p.linearRampToValueAtTime(0, at + fade);
        v.stopAt(at + fade + 0.02);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const n of [v.out, r.lp, r.panner, r.send]) {
          try {
            n?.disconnect();
          } catch {
            /* ignore */
          }
        }
      },
    };
  }

  play(name: SfxName, o: PlayOpts = {}): SfxHandle | null {
    const d = SFX[name];
    if (!d || !this.canPlay()) return null;
    const now = this.now();
    const start = now + 0.004 + Math.max(0, o.delay ?? 0);
    const profile = o.profile ?? d.profile;
    const prof = SPATIAL_PROFILES[profile];
    const pos = d.bus === 'world' ? (o.path ? o.path.from : o.pos) : undefined;
    let dist = 0;
    let distGain = 1;
    if (pos && !o.path) {
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
      dist = distance(pos, this.graph.listenerPos);
      distGain = distanceGain(dist, prof);
      if (distGain < INAUDIBLE) return null;
    }
    const variant = o.variant ?? '';
    const group = o.group ?? (d.groupByVariant ? `${d.group}:${variant}` : d.group);
    const priority = o.priority ?? d.priority;
    const adm = this.pool.admit(group, priority, start, now);
    if (!adm.ok) return null;
    // stolen voices keep sounding until the newcomer actually starts
    for (const s of adm.steal) this.pool.stop(s, start);

    const v = new Voice(this.graph.kit, start);
    const ro: RecipeOpts = {
      variant,
      pitch: Math.max(0.25, (o.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * d.pitchJitter)),
      size: o.size ?? 1,
      seed: o.seed ?? 0.5,
      local: !!o.local,
      dist,
      flavor: o.flavor ?? '',
    };
    let flavorGain = 1;
    try {
      const baked = this.graph.bank?.pick(bakeKey(name, variant, bakeModeFor(ro.local, dist))) ?? null;
      if (baked) {
        // baked take: pitch/voicing via playback rate, flavors layered live
        const rate = name === 'gun' ? ro.pitch * (0.94 + ro.seed * 0.12) : ro.pitch;
        v.buffer(baked, start, rate).connect(v.out);
        if (ro.flavor === 'ice' || ro.flavor === 'fire') flavorLayer(v, ro);
        else if (ro.flavor === 'heavy') flavorGain = 1.12;
        else if (ro.flavor === 'light') flavorGain = 0.78;
      } else {
        d.recipe(v, ro);
      }
    } catch (err) {
      v.stopAt(now);
      if (this.errors++ < 3) console.warn(`[audio] recipe ${name}/${variant} failed`, err);
      return null;
    }
    const level = Math.max(0, d.gain * flavorGain * (o.gain ?? 1) * adm.gainComp * distGain);
    v.out.gain.value = level;
    const routing = this.route(v, d.bus, pos, dist, profile, prof.wet);
    if (o.path && routing.panner && routing.lp) this.automatePath(v, routing, o.path, prof, d.gain * (o.gain ?? 1));
    const rec = this.recordFor(v, group, priority, level, routing, 0.03, false);
    this.pool.add(rec);
    return {
      end: v.end,
      stop: () => this.pool.stop(rec, this.now()),
    };
  }

  private automatePath(v: Voice, r: Routing, path: NonNullable<PlayOpts['path']>, prof: (typeof SPATIAL_PROFILES)[SpatialProfileId], level: number): void {
    const K = 16;
    const t0 = v.t;
    const dur = Math.max(0.5, path.duration);
    const lis = this.graph.listenerPos;
    const pan = r.panner as PannerNode;
    const lp = r.lp as BiquadFilterNode;
    setPannerPos(pan, path.from, t0);
    v.out.gain.setValueAtTime(0, t0);
    for (let i = 0; i <= K; i++) {
      const k = i / K;
      const p = {
        x: path.from.x + (path.to.x - path.from.x) * k,
        y: path.from.y + (path.to.y - path.from.y) * k,
        z: path.from.z + (path.to.z - path.from.z) * k,
      };
      const t = t0 + dur * k;
      const d = distance(p, lis);
      if (i > 0) {
        setPannerPos(pan, p, t0 + dur * ((i - 1) / K), dur / K);
      }
      v.out.gain.linearRampToValueAtTime(level * distanceGain(d, prof), t);
      lp.frequency.linearRampToValueAtTime(Math.min(this.graph.ctx.sampleRate * 0.45, airCutoff(d, prof)), t);
    }
  }

  /** Start or refresh a keep-alive loop. Call every frame while it should sound. */
  loop(key: string, name: LoopName, o: LoopOpts = {}): void {
    const now = this.now();
    const profile = o.profile ?? 'ambient';
    const prof = SPATIAL_PROFILES[profile];
    const pos = o.pos;
    let dist = 0;
    let distGain = 1;
    if (pos) {
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
      dist = distance(pos, this.graph.listenerPos);
      distGain = distanceGain(dist, prof);
    }
    const level = Math.max(0, (o.gain ?? 1) * distGain);
    const st = this.loops.get(key);
    if (st) {
      st.lastSeen = now;
      st.keepAlive = o.keepAlive ?? st.keepAlive;
      if (distGain < INAUDIBLE) {
        this.endLoop(key);
        return;
      }
      st.level = level;
      st.voice.out.gain.setTargetAtTime(level, now, 0.08);
      if (pos && st.routing.panner) {
        setPannerPos(st.routing.panner, pos, now, 0.05);
        st.routing.lp?.frequency.setTargetAtTime(Math.min(this.graph.ctx.sampleRate * 0.45, airCutoff(dist, prof)), now, 0.1);
        st.routing.send?.gain.setTargetAtTime(reverbSend(dist, prof), now, 0.1);
      }
      return;
    }
    if (distGain < INAUDIBLE || !this.canPlay()) return;
    const recipe = LOOPS[name];
    if (!recipe) return;
    const priority = o.priority ?? 2;
    const adm = this.pool.admit('loop', priority, now, now);
    if (!adm.ok) return;
    for (const s of adm.steal) this.pool.stop(s, now);
    const v = new Voice(this.graph.kit, now + 0.004);
    try {
      recipe(v, { variant: '', pitch: o.pitch ?? 1, size: o.size ?? 1, seed: 0.5, local: !pos, dist, flavor: '' });
    } catch (err) {
      v.stopAt(now);
      if (this.errors++ < 3) console.warn(`[audio] loop ${name} failed`, err);
      return;
    }
    v.out.gain.value = 0;
    v.out.gain.setTargetAtTime(level, now, 0.05);
    const routing = this.route(v, 'world', pos, dist, profile, prof.wet);
    // if the pool steals this loop's voice, forget it so the next refresh restarts it
    const rec = this.recordFor(v, 'loop', priority, level, routing, 0.25, true, () => {
      if (this.loops.get(key)?.rec === rec) this.loops.delete(key);
    });
    this.pool.add(rec);
    this.loops.set(key, { voice: v, rec, routing, lastSeen: now, keepAlive: o.keepAlive ?? 0.3, profile, level, positional: !!pos });
  }

  hasLoop(key: string): boolean {
    return this.loops.has(key);
  }

  endLoop(key: string): void {
    const st = this.loops.get(key);
    if (!st) return;
    this.loops.delete(key);
    this.pool.stop(st.rec, this.now());
  }

  /** Housekeeping: expire loops that were not refreshed, dispose finished voices. */
  update(): void {
    const now = this.now();
    for (const [key, st] of this.loops) {
      if (now - st.lastSeen > st.keepAlive) this.endLoop(key);
    }
    this.pool.sweep(now);
  }

  stopAll(): void {
    for (const key of [...this.loops.keys()]) this.endLoop(key);
    this.pool.stopAll(this.now());
  }

  dispose(): void {
    this.loops.clear();
    this.pool.clear();
  }
}
