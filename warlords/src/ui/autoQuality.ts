// Automatic graphics quality (设置 → 画质 → 自动, 自动调节画质). Pure logic; the App
// runs it:
//  - the GPU benchmark (render/bench.ts) runs once per GPU — first launch, and
//    again whenever the WebGL renderer string changes — and on 自动 its pick
//    (render/adaptiveRes.pickAutoTune: tier + render-scale cap) becomes the setting;
//  - in a match, AutoQualityController watches the frame rate: a match that stays
//    slow steps the tier down (after the adaptive resolution has given what it
//    can: resolution first, then tier), and on 自动 a GPU with lots of headroom
//    steps back up — never above what the benchmark allows, and only at a pause,
//    the end of the match or the next one (a switch mid-fight stalls).
import { QUALITIES, type GpuBench, type Quality, type UserSettings } from '../game/settings';
import { pickAutoTune, type AutoTunePick } from '../render/adaptiveRes';

export interface GpuState {
  renderer: string;
  software: boolean;
}

/** Position of a tier on the ladder (0 = 极速 … 4 = 极致). */
export function tierRank(q: Quality): number {
  const i = QUALITIES.indexOf(q);
  return i < 0 ? QUALITIES.indexOf('medium') : i;
}

/** The next tier down (dir -1) or up (+1), within the ladder. */
export function stepTier(q: Quality, dir: -1 | 1): Quality {
  return QUALITIES[Math.max(0, Math.min(QUALITIES.length - 1, tierRank(q) + dir))];
}

/** The stored benchmark, when it ran on this GPU (null: none for it). */
export function benchFor(s: Pick<UserSettings, 'gpuBench'>, gpu: GpuState): GpuBench | null {
  const b = s.gpuBench;
  return b && b.gpu === gpu.renderer ? b : null;
}

/** 自动 wants a (new) benchmark: it never ran on this GPU (first launch, or the GPU changed). */
export function autoTuneNeeded(s: Pick<UserSettings, 'gpuBench' | 'qualityAuto'>, gpu: GpuState): boolean {
  return s.qualityAuto && !!gpu.renderer && !benchFor(s, gpu);
}

/**
 * What 自动 picks on this machine for a `cssPixels` view at `dpr` (null: this GPU
 * has not been benchmarked yet). A software renderer needs no benchmark (极速);
 * a failed one (ms 0) gives `fallback` — the first-run guess.
 */
export function autoPick(s: Pick<UserSettings, 'gpuBench'>, gpu: GpuState, view: { cssPixels: number; dpr: number }, fallback: Quality): AutoTunePick | null {
  const b = benchFor(s, gpu);
  if (!gpu.software && !b) return null;
  return pickAutoTune({ benchMs: b && b.ms > 0 ? b.ms : null, benchSmallMs: b?.msSmall ?? null, software: gpu.software, cssPixels: view.cssPixels, dpr: view.dpr, fallback });
}

// ── in-match controller ──────────────────────────────────────────────────────

export interface AutoAdjustOptions {
  /** a smoothed frame rate below this… */
  downFps: number;
  /** …for this long (s, counted only while the adaptive resolution is at its floor) steps the tier down */
  downHoldS: number;
  /** the first seconds of a match are not judged (loading hitches, shader compiles) */
  warmupS: number;
  /** at most one step down per this many seconds */
  downEveryS: number;
  /** never stepped below this tier (the player / the benchmark may still pick a lower one) */
  floor: Quality;
  /** a frame's own work (max of main thread and GPU) under this share of the display's frame time… */
  upBusyShare: number;
  /** …for this long (s) makes a step up ready */
  upHoldS: number;
}

export const AUTO_ADJUST_DEFAULTS: AutoAdjustOptions = {
  downFps: 28,
  downHoldS: 8,
  warmupS: 15,
  downEveryS: 60,
  floor: 'low',
  upBusyShare: 0.45,
  upHoldS: 30,
};

export interface AutoAdjustSample {
  /** real seconds since the previous sample */
  dt: number;
  /** smoothed frame rate */
  fps: number;
  /** smoothed time between two frames (ms): its minimum over the match is the display's refresh */
  frameMs: number;
  /** main-thread ms of a frame */
  jsMs: number;
  /** GPU ms of a frame (-1: unknown — then nothing proves headroom and no step up is ever made) */
  gpuMs: number;
  /**
   * The sample counts: the match is on screen and running — not paused, loading,
   * applying a quality switch, or in a hidden tab.
   */
  active: boolean;
  /** the adaptive resolution is at its floor (it has nothing left to give: the tier is next) */
  resAtFloor: boolean;
}

export type AutoAdjustStep = { dir: 'down' | 'up'; to: Quality };

/**
 * One match's automatic tier steps. update() → a step down to apply now, or null;
 * a step up is only made ready (`pendingUp`) — the App applies it at a safe moment
 * (takeUp()). `ceiling` is the richest tier a step up may reach (what the
 * benchmark picked; null: never step up — a tier the player chose).
 */
export class AutoQualityController {
  readonly opts: AutoAdjustOptions;
  /** the tier in use */
  tier: Quality;
  /** a step up is ready (applied by the App at a pause / after the match) */
  pendingUp: Quality | null = null;
  private ceiling: Quality | null;
  /** active seconds so far */
  private time = 0;
  private slowFor = 0;
  private fastFor = 0;
  private lastDownAt = -Infinity;
  /** the display's frame time (ms): the fastest the frames have come */
  private displayMs = Infinity;

  constructor(tier: Quality, ceiling: Quality | null, opts: Partial<AutoAdjustOptions> = {}) {
    this.opts = { ...AUTO_ADJUST_DEFAULTS, ...opts };
    this.tier = tier;
    this.ceiling = ceiling;
  }

  /** The tier changed from elsewhere (the player picked one, a switch applied): judge it afresh. */
  setTier(q: Quality, ceiling?: Quality | null): void {
    if (ceiling !== undefined) this.ceiling = ceiling;
    if (q === this.tier) return;
    this.tier = q;
    this.pendingUp = null;
    this.slowFor = 0;
    this.fastFor = 0;
  }

  /** The step up that is ready (and forget it: the caller applies it). */
  takeUp(): Quality | null {
    const up = this.pendingUp;
    this.pendingUp = null;
    if (up) this.tier = up;
    return up;
  }

  update(s: AutoAdjustSample): AutoAdjustStep | null {
    const o = this.opts;
    if (!(s.dt > 0) || !s.active) {
      // not a performance signal: start the holds again
      this.slowFor = 0;
      this.fastFor = 0;
      return null;
    }
    this.time += s.dt;
    if (s.frameMs > 0) this.displayMs = Math.min(this.displayMs, s.frameMs);
    if (this.time <= o.warmupS) return null;

    // down: slow at the lowest resolution the adaptive resolution allows
    if (s.fps > 0 && s.fps < o.downFps && s.resAtFloor) this.slowFor += s.dt;
    else this.slowFor = 0;
    if (this.slowFor >= o.downHoldS && tierRank(this.tier) > tierRank(o.floor) && this.time - this.lastDownAt >= o.downEveryS) {
      const from = this.tier;
      this.tier = stepTier(from, -1);
      this.lastDownAt = this.time;
      this.slowFor = 0;
      this.fastFor = 0;
      this.pendingUp = null;
      // the tier that proved too slow is out of reach for the rest of this match
      if (this.ceiling !== null && tierRank(this.ceiling) >= tierRank(from)) this.ceiling = this.tier;
      return { dir: 'down', to: this.tier };
    }

    // up (自动 only, below the ceiling): the frame's own work far under the display's frame time
    if (this.ceiling === null || this.pendingUp || tierRank(this.tier) >= tierRank(this.ceiling) || s.gpuMs < 0) {
      this.fastFor = 0;
      return null;
    }
    // (a 30 fps cap or a slow display never makes the budget bigger than 60 Hz's)
    const budget = Math.min(1000 / 60, Number.isFinite(this.displayMs) ? this.displayMs : 1000 / 60);
    if (Math.max(s.jsMs, s.gpuMs) < o.upBusyShare * budget) this.fastFor += s.dt;
    else this.fastFor = 0;
    if (this.fastFor >= o.upHoldS) {
      this.fastFor = 0;
      this.pendingUp = stepTier(this.tier, 1);
    }
    return null;
  }
}
