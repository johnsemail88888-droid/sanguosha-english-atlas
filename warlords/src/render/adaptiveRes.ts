// Adaptive resolution: lowers the canvas pixel ratio in steps while the frame
// time stays high (phones, weak GPUs, hi-DPI screens) and raises it again once
// frames are comfortably fast — with hysteresis and a back-off so it does not
// oscillate. Pure logic (no DOM / three.js): GameRenderer feeds it the real
// interval between two frames and applies `ratio` when update() says it moved.

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

/** Lowest pixel ratio the controller may pick: 1.0, or 0.75 on the 'low' preset. */
export function adaptiveFloor(quality: string): number {
  return quality === 'low' ? 0.75 : 1;
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
