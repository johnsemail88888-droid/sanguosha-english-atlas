// Public audio API: procedural WebAudio SFX + music (GAME_SPEC §13).
//
// Usage (render/UI/integration):
//   await audio.unlock();                       // from a user gesture
//   audio.music('menu');
//   // every render frame:
//   audio.setListener(camPos, camYaw, camPitch);
//   audio.handleEvents(events, view);           // events drained by the caller
//   audio.localFire(weaponId);                  // instant local gunshot
//
// Every method is a safe no-op when WebAudio is unavailable (Node, tests) or
// before unlock(); nothing here ever throws into the caller.
import type { Vec3 } from '../core/math';
import type { GameEvent } from '../core/types';
import { settings } from '../game/settings';
import type { UserSettings } from '../game/settings';
import type { ViewSource } from '../render/view';
import { defaultBakePlan, SampleBank } from './bake';
import type { SfxName } from './catalog';
import { audioContextCtor, hasWebAudio } from './env';
import { MixGraph } from './graph';
import { MusicPlayer } from './music';
import type { MusicTrack } from './music';
import type { UiSound } from './recipes/ui';
import { EventRouter } from './router';
import type { SoundSink } from './router';
import type { LoopName } from './recipes/loops';
import { SfxEngine } from './sfx';
import type { LoopOpts, PlayOpts, SfxHandle } from './sfx';

export type { MusicTrack } from './music';
export type { UiSound } from './recipes/ui';
export type { SfxName } from './catalog';
export type { LoopOpts, PlayOpts, SfxHandle } from './sfx';
export type { LoopName } from './recipes/loops';
export { SFX_NAMES } from './catalog';
export { hasWebAudio } from './env';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

let warnings = 0;
function warnOnce(msg: string, err?: unknown): void {
  if (warnings++ < 5) console.warn(`[audio] ${msg}`, err ?? '');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: MixGraph | null = null;
  private sfx: SfxEngine | null = null;
  private player: MusicPlayer | null = null;
  private bank: SampleBank | null = null;
  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly router: EventRouter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private wanted: MusicTrack | null = null;
  private intensity = 0;
  private lastEffective = -1;
  private downed = false;
  private urgency = 0;
  private nextBeat = 0;
  private lastSpeak = -Infinity;
  private unlocking: Promise<void> | null = null;

  constructor() {
    const sink: SoundSink = {
      now: () => this.ctx?.currentTime ?? 0,
      listener: () => this.graph?.listenerPos ?? ORIGIN,
      play: (name, o) => this.sfx?.play(name, o) ?? null,
      loop: (key, name, o) => this.sfx?.loop(key, name, o),
      music: (track) => this.music(track),
      dipMusic: (db, hold) => this.graph?.dipMusic(db, hold),
      autoDowned: (on) => this.setDowned(on),
      downedUrgency: (x) => {
        this.urgency = Math.max(0, Math.min(1, x));
      },
    };
    this.router = new EventRouter(sink);
  }

  /** true once a running AudioContext exists */
  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Call from a user gesture; safe to call repeatedly. */
  unlock(): Promise<void> {
    if (!hasWebAudio()) return Promise.resolve();
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.doUnlock().finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }

  private async doUnlock(): Promise<void> {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      if (!this.ctx) {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.build(this.ctx);
      }
      const ctx = this.ctx;
      if (ctx.state !== 'running') {
        await Promise.race([ctx.resume().catch(() => undefined), sleep(1500)]);
      }
      this.primeVoices();
    } catch (err) {
      warnOnce('unlock failed', err);
    }
  }

  private build(ctx: AudioContext): void {
    const s = settings.get();
    this.graph = new MixGraph(ctx, s.quality, true);
    this.sfx = new SfxEngine(this.graph, s.quality === 'low' ? 20 : 32, () => ctx.state === 'running');
    this.player = new MusicPlayer(this.graph);
    this.applySettings(s);
    this.unsubscribe = settings.subscribe((next) => this.applySettings(next));
    this.timer = setInterval(() => this.tick(), 40);
    if (this.wanted) this.player.play(this.wanted);
    this.player.setIntensity(this.intensity);
    // pre-render frequent sounds in the background (live synthesis meanwhile)
    const bank = new SampleBank();
    this.bank = bank;
    this.graph.bank = bank;
    this.bakeTimer = setTimeout(() => {
      this.bakeTimer = null;
      void bank.bake(defaultBakePlan(ctx.sampleRate)).catch((err: unknown) => warnOnce('bake failed', err));
    }, 250);
  }

  private applySettings(s: UserSettings): void {
    const g = this.graph;
    if (!g) return;
    try {
      g.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume);
      if (g.quality !== s.quality) {
        g.setQuality(s.quality);
        this.sfx?.pool.setCapacity(s.quality === 'low' ? 20 : 32);
      }
    } catch (err) {
      warnOnce('settings apply failed', err);
    }
  }

  private tick(): void {
    const ctx = this.ctx;
    const sfx = this.sfx;
    const player = this.player;
    if (!ctx || !sfx || !player) return;
    try {
      const now = ctx.currentTime;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const ahead = hidden ? 1.2 : 0.25;
      const eff = this.effectiveIntensity(now);
      if (Math.abs(eff - this.lastEffective) > 0.02) {
        this.lastEffective = eff;
        player.setIntensity(eff);
      }
      player.pump(now + ahead);
      if (this.downed && ctx.state === 'running') {
        if (this.nextBeat < now) this.nextBeat = now + 0.02;
        while (this.nextBeat < now + ahead) {
          sfx.play('heartbeat', { delay: this.nextBeat - now, pitch: 1 + this.urgency * 0.5 });
          this.nextBeat += 60 / (66 + 64 * this.urgency);
        }
      }
      sfx.update();
    } catch (err) {
      warnOnce('tick failed', err);
    }
  }

  /**
   * Music intensity actually applied: the caller's value or the zone phase
   * (whichever is higher, so it works without integration wiring) plus
   * short-term combat heat.
   */
  private effectiveIntensity(now: number): number {
    const base = Math.max(this.intensity, this.router.zoneLevel(now));
    return Math.max(0, Math.min(1, base + this.router.heat * 0.35));
  }

  /** Per render frame: listener pose (camera). */
  setListener(pos: Vec3, yaw: number, pitch: number): void {
    if (!this.graph || !pos) return;
    try {
      this.graph.setListener(pos, yaw, pitch);
    } catch (err) {
      warnOnce('setListener failed', err);
    }
  }

  /**
   * World sounds for sim events (positional). Call once per render frame with
   * the events the caller drained this frame (an empty array is fine: looping
   * sounds, footsteps and reload clicks are driven from the view state).
   */
  handleEvents(events: readonly GameEvent[], view: ViewSource): void {
    if (!this.sfx || !view) return;
    try {
      this.router.handle(events ?? [], view);
    } catch (err) {
      warnOnce('handleEvents failed', err);
    }
  }

  /**
   * Instant local feedback when the local player fires (before host
   * confirmation). The matching host 'shot' event is skipped automatically.
   * With an empty magazine (per the last view) this plays a dry-fire click.
   */
  localFire(weaponId: string): void {
    if (!this.sfx) return;
    try {
      this.router.localFire(weaponId);
    } catch (err) {
      warnOnce('localFire failed', err);
    }
  }

  /** Explicit dry-fire click (trigger pulled on an empty magazine). */
  dryFire(): void {
    if (!this.sfx) return;
    try {
      this.router.dryFire();
    } catch (err) {
      warnOnce('dryFire failed', err);
    }
  }

  ui(name: UiSound): void {
    if (!this.sfx) return;
    try {
      this.sfx.play('ui', { variant: name });
    } catch (err) {
      warnOnce('ui failed', err);
    }
  }

  /** Play any catalog sound directly (dev tools, special UI moments). */
  play(name: SfxName, opts?: PlayOpts): SfxHandle | null {
    if (!this.sfx) return null;
    try {
      return this.sfx.play(name, opts);
    } catch (err) {
      warnOnce(`play ${name} failed`, err);
      return null;
    }
  }

  /**
   * Start or keep alive a looping sound under `key` (fades ~keepAlive seconds
   * after the last call). For custom ambience; world loops are automatic.
   */
  loop(key: string, name: LoopName, opts?: LoopOpts): void {
    if (!this.sfx) return;
    try {
      this.sfx.loop(key, name, opts);
    } catch (err) {
      warnOnce(`loop ${name} failed`, err);
    }
  }

  music(track: MusicTrack | null): void {
    const stinger = track === 'victory' || track === 'defeat';
    // stingers only make sense right now; loops are remembered until unlock
    this.wanted = stinger && !this.player ? null : track;
    if (!this.player) return;
    try {
      this.player.play(track);
    } catch (err) {
      warnOnce('music failed', err);
    }
  }

  /**
   * 0..1 (zone phase / combat). The engine already follows the zone phase and
   * nearby combat by itself; this sets a floor (e.g. 1 for a final duel).
   */
  setIntensity(x: number): void {
    this.intensity = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  }

  /** Heartbeat + muffled low-pass while the local hero is downed. */
  setDowned(on: boolean): void {
    const v = !!on;
    if (v === this.downed) return;
    this.downed = v;
    if (!this.graph || !this.ctx) return;
    try {
      this.graph.setMuffle(v ? 1 : 0, v ? 0.4 : 0.9);
      this.nextBeat = this.ctx.currentTime + 0.12;
      if (!v) this.urgency = 0;
    } catch (err) {
      warnOnce('setDowned failed', err);
    }
  }

  /** Hero quote via speechSynthesis (zh-CN) if settings.voiceLines and a voice is available. */
  speak(textZh: string): void {
    try {
      if (!textZh || !settings.get().voiceLines) return;
      const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
      const Utter = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
      if (!synth || !Utter) return;
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (nowMs - this.lastSpeak < 1500) return;
      const voices = synth.getVoices();
      const zh =
        voices.find((v) => /^zh[-_]CN/i.test(v.lang) && v.localService) ??
        voices.find((v) => /^zh[-_]CN/i.test(v.lang)) ??
        voices.find((v) => /^zh/i.test(v.lang)) ??
        voices.find((v) => /^cmn/i.test(v.lang));
      // voices list loaded but no Chinese voice: an English voice would mangle the line
      if (voices.length && !zh) return;
      this.lastSpeak = nowMs;
      const s = settings.get();
      const u = new Utter(textZh.slice(0, 80));
      u.lang = zh?.lang ?? 'zh-CN';
      if (zh) u.voice = zh;
      u.rate = 1.05;
      u.pitch = 1;
      u.volume = Math.max(0, Math.min(1, s.masterVolume * s.sfxVolume));
      u.onstart = () => this.graph?.setMusicDuck(-5);
      u.onend = () => this.graph?.setMusicDuck(0);
      u.onerror = () => this.graph?.setMusicDuck(0);
      if (synth.speaking || synth.pending) synth.cancel();
      synth.speak(u);
    } catch (err) {
      warnOnce('speak failed', err);
    }
  }

  private primeVoices(): void {
    try {
      (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.getVoices();
    } catch {
      /* ignore */
    }
  }

  /** Stop everything and release the AudioContext. unlock() may be called again later. */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.bakeTimer !== null) clearTimeout(this.bakeTimer);
    this.bakeTimer = null;
    this.bank?.clear();
    this.bank = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.player?.dispose();
      this.sfx?.dispose();
      this.graph?.dispose();
      void this.ctx?.close().catch(() => undefined);
    } catch {
      /* ignore */
    }
    try {
      (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    this.player = null;
    this.sfx = null;
    this.graph = null;
    this.ctx = null;
    this.wanted = null;
    this.downed = false;
    this.urgency = 0;
    this.lastEffective = -1;
    this.router.reset();
  }

  /** Debug snapshot (dev page / tests). */
  stats(): { state: string; voices: number; loops: number; music: MusicTrack | null; heat: number; intensity: number; baked: number; bakedMB: number } {
    return {
      state: this.ctx?.state ?? 'unavailable',
      voices: this.sfx?.activeVoices ?? 0,
      loops: this.sfx?.activeLoops ?? 0,
      music: this.player?.track ?? null,
      heat: this.router.heat,
      intensity: this.ctx ? this.effectiveIntensity(this.ctx.currentTime) : this.intensity,
      baked: this.bank?.count ?? 0,
      bakedMB: ((this.bank?.frames ?? 0) * 4) / 1048576,
    };
  }
}

/** Singleton used by the game. */
export const audio: AudioEngine = new AudioEngine();

// Vite HMR: release the old AudioContext so edits don't stack engines.
import.meta.hot?.dispose(() => audio.dispose());
