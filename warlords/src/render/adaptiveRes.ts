// Adaptive resolution: lowers the canvas pixel ratio in steps while the frame
// time stays high (phones, weak GPUs, hi-DPI screens) and raises it again once
// frames are comfortably fast — with hysteresis and a back-off so it does not
// oscillate. Pure logic (no DOM / three.js): GameRenderer feeds it the real
// interval between two frames and applies `ratio` when update() says it moved.
//
// Also the automatic graphics tier: what a GPU benchmark (render/bench.ts) says
// this machine can run (pickAutoTune).
import type { Quality } from '../game/settings';

export interface AdaptiveResolutionOptions {
  /** smoothed frame time (ms) above which the ratio is lowered */
  slowMs: number;
  /** …after it stayed above for this long (s) */
  slowHoldS: number;
  /** smoothed frame time (ms) below which the ratio may be raised again (hysteresis: well under slowMs) */
  fastMs: number;
  /** …after it stayed below for this long (s); doubled after every raise that had to be undone */
  fastHoldS: number;
  /** longest wait (s) for a raise once the back-off kicked in */
  maxFastHoldS: number;
  /** a lowering this soon (s) after a raise counts as "the raise did not fit" (back-off) */
  bounceS: number;
  /** pixel-ratio step */
  step: number;
  /** time constant (s) of the frame-time smoothing */
  smoothingS: number;
  /** after a range change / start-up / pause, frames are ignored this long (s) (shader compiles, loading hitches) */
  graceS: number;
  /**
   * A gap between two frames longer than this (s) is a pause (debugger, a
   * suspended device), not a slow frame. Hidden tabs are reported separately
   * (restart()): software-GL / very weak devices really do take ~1 s a frame.
   */
  pauseS: number;
}

export const ADAPTIVE_RES_DEFAULTS: AdaptiveResolutionOptions = {
  slowMs: 33,
  slowHoldS: 3,
  fastMs: 22,
  fastHoldS: 6,
  maxFastHoldS: 60,
  bounceS: 12,
  step: 0.25,
  smoothingS: 0.5,
  graceS: 2,
  pauseS: 5,
};

/** Lowest pixel ratio the controller may pick: 1.0, 0.75 on 'low', 0.5 on 'potato'. */
export function adaptiveFloor(quality: string): number {
  return quality === 'potato' ? 0.5 : quality === 'low' ? 0.75 : 1;
}

const EPS = 1e-6;

export class AdaptiveResolution {
  readonly opts: AdaptiveResolutionOptions;
  /** current pixel ratio to render at */
  ratio = 1;
  /** ceiling (the quality preset's pixel ratio for this device) */
  ceil = 1;
  /** floor (never below this; ≤ ceil) */
  floor = 1;
  /** smoothed frame time (ms) */
  frameMs = 1000 / 60;
  /** number of steps taken down / up so far (diagnostics) */
  downs = 0;
  ups = 0;
  enabled = true;
  private slowFor = 0;
  private fastFor = 0;
  private grace: number;
  private fastHold: number;
  private time = 0;
  private lastUpAt = -Infinity;

  constructor(opts: Partial<AdaptiveResolutionOptions> = {}) {
    this.opts = { ...ADAPTIVE_RES_DEFAULTS, ...opts };
    this.grace = this.opts.graceS;
    this.fastHold = this.opts.fastHoldS;
  }

  /**
   * Set the allowed range. A new ceiling (quality preset or devicePixelRatio
   * changed) restarts at the ceiling; the same ceiling (a plain window resize)
   * keeps the adapted ratio. Returns true when `ratio` changed.
   */
  setRange(ceil: number, floor: number): boolean {
    const c = Math.max(0.25, ceil);
    const f = Math.min(c, Math.max(0.25, floor));
    const before = this.ratio;
    if (Math.abs(c - this.ceil) > EPS) {
      this.ceil = c;
      this.ratio = c;
      this.fastHold = this.opts.fastHoldS;
      this.restart();
    }
    this.floor = f;
    this.ratio = Math.min(this.ceil, Math.max(this.floor, this.ratio));
    return Math.abs(this.ratio - before) > EPS;
  }

  /** Forget the timers (and ignore the next `graceS` of frames). */
  restart(): void {
    this.slowFor = 0;
    this.fastFor = 0;
    this.grace = this.opts.graceS;
  }

  /**
   * Feed the real time (s) since the previous frame. Returns true when `ratio`
   * changed (the owner re-applies the pixel ratio).
   */
  update(frameS: number): boolean {
    if (!(frameS > 0)) return false;
    const o = this.opts;
    if (frameS > o.pauseS) {
      // a pause (hidden tab, breakpoint, alt-tab): not a performance signal
      this.restart();
      return false;
    }
    this.time += frameS;
    const ms = frameS * 1000;
    const k = 1 - Math.exp(-frameS / o.smoothingS);
    this.frameMs += (ms - this.frameMs) * k;
    if (this.grace > 0) {
      this.grace -= frameS;
      return false;
    }
    if (!this.enabled || this.ceil - this.floor < EPS) {
      this.slowFor = 0;
      this.fastFor = 0;
      return false;
    }
    if (this.frameMs > o.slowMs) {
      this.slowFor += frameS;
      this.fastFor = 0;
    } else if (this.frameMs < o.fastMs) {
      this.fastFor += frameS;
      this.slowFor = 0;
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
    if (this.slowFor >= o.slowHoldS && this.ratio > this.floor + EPS) {
      if (this.time - this.lastUpAt < o.bounceS) this.fastHold = Math.min(o.maxFastHoldS, this.fastHold * 2);
      this.ratio = Math.max(this.floor, snap(this.ratio - o.step));
      this.downs++;
      this.slowFor = 0;
      this.fastFor = 0;
      // the smoothing still remembers the slow frames: give the new size a moment
      this.grace = Math.min(o.graceS, 1);
      return true;
    }
    if (this.fastFor >= this.fastHold && this.ratio < this.ceil - EPS) {
      this.ratio = Math.min(this.ceil, snap(this.ratio + o.step));
      this.ups++;
      this.lastUpAt = this.time;
      this.slowFor = 0;
      this.fastFor = 0;
      this.grace = Math.min(o.graceS, 1);
      return true;
    }
    return false;
  }
}

/** Round to 1/100 so repeated steps do not drift (0.75 + 0.25 === 1). */
function snap(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── automatic tier / render scale from the GPU benchmark ─────────────────────

/**
 * The benchmark's reference frame (render/bench.ts): a 'medium'-like scene drawn
 * at 1280×720, and at a quarter of the pixels (640×360) to tell the fixed cost of
 * a frame (draw submission, vertices, shadows) from the per-pixel one.
 */
export const BENCH_PIXELS = 1280 * 720;
export const BENCH_SMALL_PIXELS = 640 * 360;

/**
 * Frame cost of each tier relative to 'medium' (the benchmark scene): only for
 * the estimated frame rate 性能体检 shows.
 */
export const TIER_COST: Record<Quality, number> = { potato: 0.3, low: 0.5, medium: 1, high: 1.5, ultra: 2.1 };

/**
 * The automatic tier's classes: the benchmark's 'medium' frame, estimated on the
 * player's own view at render scale 1 (frameCost → estimateFrameMs), within
 * AUTO_STRONG_MS → 高清 (极致 within AUTO_ULTRA_MS), render scale up to
 * min(dpr, 2); within AUTO_MID_MS → 均衡, up to min(dpr, 1.5); within
 * AUTO_WEAK_MS → 流畅 at 1×; slower → 极速.
 */
export const AUTO_ULTRA_MS = 3;
export const AUTO_STRONG_MS = 6;
export const AUTO_MID_MS = 12;
export const AUTO_WEAK_MS = 24;

/** A 'medium' frame on this machine: fixedMs + perMpx × megapixels rendered. */
export interface FrameCost {
  fixedMs: number;
  perMpx: number;
}

/**
 * The benchmark's two sizes → fixed and per-pixel cost. With one size only (or a
 * noisy pair) 60 % of the frame is taken to scale with the pixels.
 */
export function frameCost(ms: number, msSmall?: number | null): FrameCost {
  const big = BENCH_PIXELS / 1e6;
  const small = BENCH_SMALL_PIXELS / 1e6;
  if (msSmall && msSmall > 0 && msSmall <= ms * 1.05) {
    const perMpx = Math.max(0, (ms - msSmall) / (big - small));
    return { fixedMs: Math.max(0, ms - perMpx * big), perMpx };
  }
  return { fixedMs: ms * 0.4, perMpx: (ms * 0.6) / big };
}

/** Estimated frame time (ms) on `tier` rendering `pixels` device pixels. */
export function estimateFrameMs(cost: FrameCost, tier: Quality, pixels: number): number {
  return TIER_COST[tier] * (cost.fixedMs + (cost.perMpx * Math.max(0, pixels)) / 1e6);
}

/** Estimated frame rate on `tier` at pixel ratio `r` for a `cssPixels` view (see estimateFrameMs). */
export function estimateFps(benchMs: number, benchSmallMs: number | null | undefined, tier: Quality, cssPixels: number, r = 1): number {
  return Math.round(1000 / Math.max(0.1, estimateFrameMs(frameCost(benchMs, benchSmallMs), tier, cssPixels * r * r)));
}

export interface AutoTuneInput {
  /** the benchmark's median frame ms at 1280×720 and 640×360 (null / 0: none — a software renderer needs none, or it failed) */
  benchMs: number | null;
  benchSmallMs?: number | null;
  /** WebGL runs on a software renderer (hardware acceleration off) */
  software: boolean;
  /** the game view's size in CSS px (width × height) */
  cssPixels: number;
  /** window.devicePixelRatio */
  dpr: number;
  /** the tier when there is no benchmark result on hardware (default 'medium'; the app passes its first-run guess) */
  fallback?: Quality;
}

export interface AutoTunePick {
  quality: Quality;
  /** highest pixel ratio this tier may render at (the adaptive resolution's ceiling) */
  maxPixelRatio: number;
  /** estimated frame rate of the pick (null: no benchmark) */
  fps: number | null;
}

const snapQ = (v: number): number => Math.floor(v * 4 + 1e-6) / 4;

/**
 * What this machine can run (see AUTO_*_MS): the tier, and the highest render
 * scale — in 0.25 steps, never below 1 — at which the estimated 'medium' frame
 * still stays in the tier's class. A software renderer → 极速 at 1× whatever it
 * measured; no benchmark → the fallback tier at ≤ 1.25×.
 */
export function pickAutoTune(i: AutoTuneInput): AutoTunePick {
  const dpr = Math.max(1, i.dpr || 1);
  const css = Math.max(1, i.cssPixels);
  const cost = i.benchMs && i.benchMs > 0 ? frameCost(i.benchMs, i.benchSmallMs) : null;
  const fpsAt = (tier: Quality, r: number): number | null => (cost ? Math.round(1000 / Math.max(0.1, estimateFrameMs(cost, tier, css * r * r))) : null);
  if (i.software) return { quality: 'potato', maxPixelRatio: 1, fps: fpsAt('potato', 1) };
  if (!cost) return { quality: i.fallback ?? 'medium', maxPixelRatio: Math.min(dpr, 1.25), fps: null };
  const mediumAt = (r: number): number => estimateFrameMs(cost, 'medium', css * r * r);
  // the largest scale ≤ min(dpr, cap) whose 'medium' frame stays within `limitMs`
  const scale = (cap: number, limitMs: number): number => {
    let r = snapQ(Math.min(dpr, cap));
    while (r > 1 && mediumAt(r) > limitMs) r -= 0.25;
    return Math.max(1, r);
  };
  const m = mediumAt(1);
  let quality: Quality;
  let r = 1;
  if (m <= AUTO_STRONG_MS) {
    quality = m <= AUTO_ULTRA_MS ? 'ultra' : 'high';
    r = scale(2, AUTO_STRONG_MS);
  } else if (m <= AUTO_MID_MS) {
    quality = 'medium';
    r = scale(1.5, AUTO_MID_MS);
  } else quality = m <= AUTO_WEAK_MS ? 'low' : 'potato';
  return { quality, maxPixelRatio: r, fps: fpsAt(quality, r) };
}
