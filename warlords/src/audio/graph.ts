// Master mixing graph (works on live AudioContext and OfflineAudioContext):
//
//   world ─► worldMuffle ─► sfxVol ──┐
//   worldSend ─► reverb ─► ret ─┘    │
//   ui ─► uiVol ─────────────────────┤
//   music ─► musicMuffle ─► duck ─► musicVol ─┤
//   musicSend ─► reverb ─► ret ─┘             │
//                                             ▼
//            sum ─► limiter ─► makeup-comp ─► soft clipper ─► masterVol ─► out
//
// The limiter is a hard DynamicsCompressor; its automatic makeup gain is
// cancelled analytically so levels below the threshold pass at unity, and the
// soft clipper guarantees |out| < 1 even for transients the limiter misses.
import type { Vec3 } from '../core/math';
import { dirFromYawPitch, rightFromYaw, vcross } from '../core/math';
import type { Quality } from '../game/settings';
import { kitFor, softClipCurve } from './dsp';
import type { Kit } from './dsp';
import type { SampleBank } from './bake';
import { volumeCurve } from './spatial';

const LIMIT_THRESHOLD = -6;
const LIMIT_RATIO = 12;

/** Inverse of the WebAudio compressor's automatic makeup gain (spec formula, hard-knee approx). */
export function makeupCompensation(thresholdDb: number, ratio: number): number {
  const fullRangeDb = thresholdDb + (0 - thresholdDb) / ratio;
  const makeupDb = -fullRangeDb * 0.6;
  return Math.pow(10, -makeupDb / 20);
}

export class MixGraph {
  readonly kit: Kit;
  readonly world: GainNode;
  readonly worldSend: GainNode;
  readonly ui: GainNode;
  readonly music: GainNode;
  readonly musicSend: GainNode;
  readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  listenerYaw = 0;
  listenerPitch = 0;
  panningModel: PanningModelType = 'equalpower';
  quality: Quality = 'medium';
  /** pre-rendered samples (live engine only); null = always synthesise */
  bank: SampleBank | null = null;

  private readonly worldMuffle: BiquadFilterNode;
  private readonly musicMuffle: BiquadFilterNode;
  private readonly musicDuck: GainNode;
  private readonly sfxVol: GainNode;
  private readonly uiVol: GainNode;
  private readonly musicVol: GainNode;
  private readonly masterVol: GainNode;
  private readonly sum: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly worldRet: GainNode;
  private readonly musicRet: GainNode;
  private worldVerb: ConvolverNode | null = null;
  private musicVerb: ConvolverNode | null = null;
  private muffle = 0;
  private duckDb = 0;
  private disposed = false;

  constructor(
    readonly ctx: BaseAudioContext,
    quality: Quality = 'medium',
    readonly realtime = true,
  ) {
    this.kit = kitFor(ctx);
    const g = (v = 1): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.world = g();
    this.worldSend = g();
    this.ui = g();
    this.music = g();
    this.musicSend = g();
    this.sfxVol = g(0.85);
    this.uiVol = g(0.85);
    this.musicVol = g(0.35);
    this.masterVol = g(0.7);
    this.sum = g();
    this.musicDuck = g();
    this.worldRet = g(0.9);
    this.musicRet = g(0.8);

    this.worldMuffle = ctx.createBiquadFilter();
    this.worldMuffle.type = 'lowpass';
    this.worldMuffle.frequency.value = this.maxHz();
    this.worldMuffle.Q.value = 0.5;
    this.musicMuffle = ctx.createBiquadFilter();
    this.musicMuffle.type = 'lowpass';
    this.musicMuffle.frequency.value = this.maxHz();
    this.musicMuffle.Q.value = 0.5;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMIT_THRESHOLD;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = LIMIT_RATIO;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.16;
    const comp = g(makeupCompensation(LIMIT_THRESHOLD, LIMIT_RATIO));
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve() as Float32Array<ArrayBuffer>;
    clip.oversample = 'none';
    // input to the clipper is pre-scaled by 1/2 (curve spans ±2)
    const preClip = g(0.5);

    this.world.connect(this.worldMuffle).connect(this.sfxVol).connect(this.sum);
    this.worldRet.connect(this.worldMuffle);
    this.ui.connect(this.uiVol).connect(this.sum);
    this.music.connect(this.musicMuffle).connect(this.musicDuck).connect(this.musicVol).connect(this.sum);
    this.musicRet.connect(this.musicMuffle);
    this.sum.connect(this.limiter).connect(comp).connect(preClip).connect(clip).connect(this.masterVol).connect(ctx.destination);

    this.setQuality(quality);
  }

  private maxHz(): number {
    return Math.min(20000, this.ctx.sampleRate * 0.45);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  setVolumes(master: number, music: number, sfx: number): void {
    const t = this.ctx.currentTime;
    this.masterVol.gain.setTargetAtTime(volumeCurve(master), t, 0.05);
    this.musicVol.gain.setTargetAtTime(volumeCurve(music), t, 0.05);
    this.sfxVol.gain.setTargetAtTime(volumeCurve(sfx), t, 0.05);
    this.uiVol.gain.setTargetAtTime(volumeCurve(sfx) * 0.9, t, 0.05);
  }

  /** Quality drives panning model and reverb. Safe to call repeatedly. */
  setQuality(q: Quality): void {
    this.quality = q;
    this.panningModel = q === 'high' ? 'HRTF' : 'equalpower';
    this.kit.lite = q === 'low';
    const t = this.ctx.currentTime;
    if (q === 'low') {
      this.worldRet.gain.setTargetAtTime(0, t, 0.05);
      this.musicRet.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    if (!this.worldVerb) {
      this.worldVerb = this.ctx.createConvolver();
      this.worldVerb.normalize = false;
      // open valley: short slap, a couple of distant echoes, darkening tail
      this.worldVerb.buffer = this.kit.impulse({ seconds: 1.8, t60: 1.5, predelay: 0.012, damping: 0.85, early: 5, echoes: 3, seed: 97 });
      this.worldSend.connect(this.worldVerb).connect(this.worldRet);
    }
    if (!this.musicVerb) {
      this.musicVerb = this.ctx.createConvolver();
      this.musicVerb.normalize = false;
      // warm hall for guzheng / erhu
      this.musicVerb.buffer = this.kit.impulse({ seconds: 2.6, t60: 2.3, predelay: 0.022, damping: 0.6, early: 6, seed: 131 });
      this.musicSend.connect(this.musicVerb).connect(this.musicRet);
    }
    this.worldRet.gain.setTargetAtTime(0.9, t, 0.05);
    this.musicRet.gain.setTargetAtTime(0.8, t, 0.05);
  }

  get reverbEnabled(): boolean {
    return this.quality !== 'low';
  }

  /** 0 = clear, 1 = fully muffled (downed). */
  setMuffle(amount: number, time = 0.35): void {
    const a = Math.max(0, Math.min(1, amount));
    if (Math.abs(a - this.muffle) < 1e-3) return;
    this.muffle = a;
    const t = this.ctx.currentTime;
    const top = this.maxHz();
    const worldHz = top * Math.pow(650 / top, a);
    const musicHz = top * Math.pow(900 / top, a);
    this.worldMuffle.frequency.setTargetAtTime(worldHz, t, time / 3);
    this.musicMuffle.frequency.setTargetAtTime(musicHz, t, time / 3);
    this.applyDuck(time);
  }

  /** Persistent music duck in dB (speech, downed). */
  setMusicDuck(db: number, time = 0.3): void {
    this.duckDb = db;
    this.applyDuck(time);
  }

  private applyDuck(time: number): void {
    const db = this.duckDb - this.muffle * 5;
    this.musicDuck.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, time / 3);
  }

  /** Momentary music dip for big nearby events (explosions). */
  dipMusic(db: number, hold: number): void {
    const t = this.ctx.currentTime;
    const base = Math.pow(10, (this.duckDb - this.muffle * 5) / 20);
    const p = this.musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(base * Math.pow(10, -Math.abs(db) / 20), t, 0.02);
    p.setTargetAtTime(base, t + hold, 0.5);
  }

  setListener(pos: Vec3, yaw: number, pitch: number): void {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    this.listenerYaw = Number.isFinite(yaw) ? yaw : 0;
    this.listenerPitch = Number.isFinite(pitch) ? pitch : 0;
    const f = dirFromYawPitch(this.listenerYaw, this.listenerPitch);
    const up = vcross(rightFromYaw(this.listenerYaw), f);
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(f.x, t);
      l.forwardY.setValueAtTime(f.y, t);
      l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    } else {
      const legacy = l as AudioListener & {
        setPosition?: (x: number, y: number, z: number) => void;
        setOrientation?: (x: number, y: number, z: number, ux: number, uy: number, uz: number) => void;
      };
      legacy.setPosition?.(pos.x, pos.y, pos.z);
      legacy.setOrientation?.(f.x, f.y, f.z, up.x, up.y, up.z);
    }
  }

  /** Create a direction-only panner at `pos` (distance handled by spatial.ts). */
  panner(pos: Vec3): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = this.panningModel;
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    p.refDistance = 1;
    p.maxDistance = 100000;
    setPannerPos(p, pos, this.ctx.currentTime);
    return p;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.masterVol.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export function setPannerPos(p: PannerNode, pos: Vec3, t: number, ramp = 0): void {
  if (p.positionX) {
    if (ramp > 0) {
      p.positionX.linearRampToValueAtTime(pos.x, t + ramp);
      p.positionY.linearRampToValueAtTime(pos.y, t + ramp);
      p.positionZ.linearRampToValueAtTime(pos.z, t + ramp);
    } else {
      p.positionX.setValueAtTime(pos.x, t);
      p.positionY.setValueAtTime(pos.y, t);
      p.positionZ.setValueAtTime(pos.z, t);
    }
  } else {
    (p as PannerNode & { setPosition?: (x: number, y: number, z: number) => void }).setPosition?.(pos.x, pos.y, pos.z);
  }
}
