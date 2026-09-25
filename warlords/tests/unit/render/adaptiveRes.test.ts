// Adaptive resolution controller: synthetic frame times → pixel-ratio steps.
import { describe, expect, it } from 'vitest';
import { AdaptiveResolution, adaptiveFloor } from '../../../src/render/adaptiveRes';
import { QUALITY_PRESETS } from '../../../src/render/quality';

/** Feed `seconds` worth of frames of `ms` each; returns the ratios seen after each change. */
function run(c: AdaptiveResolution, ms: number, seconds: number): number[] {
  const seen: number[] = [];
  const n = Math.round((seconds * 1000) / ms);
  for (let i = 0; i < n; i++) if (c.update(ms / 1000)) seen.push(c.ratio);
  return seen;
}

function controller(ceil: number, floor: number): AdaptiveResolution {
  const c = new AdaptiveResolution();
  c.setRange(ceil, floor);
  run(c, 16.7, 3); // past the start-up grace, settled at 60 fps
  return c;
}

describe('adaptive resolution', () => {
  it('stays at the ceiling while frames are fast', () => {
    const c = controller(2, 1);
    expect(run(c, 16.7, 30)).toEqual([]);
    expect(c.ratio).toBe(2);
  });

  it('steps down only after the smoothed frame time stayed above 33 ms for 3 s', () => {
    const c = controller(2, 1);
    // 2.5 s of 40 ms frames: not yet
    expect(run(c, 40, 2.5)).toEqual([]);
    expect(c.ratio).toBe(2);
    // a little more: first step
    const seen = run(c, 40, 1.5);
    expect(seen).toEqual([1.75]);
  });

  it('keeps stepping down to 1.0 under sustained slow frames, never below', () => {
    const c = controller(2, 1);
    const seen = run(c, 50, 40);
    expect(seen).toEqual([1.75, 1.5, 1.25, 1]);
    expect(c.ratio).toBe(1);
    expect(run(c, 80, 20)).toEqual([]);
    expect(c.ratio).toBe(1);
  });

  it("goes down to 0.75 on 'low'", () => {
    expect(adaptiveFloor('low')).toBe(0.75);
    expect(adaptiveFloor('medium')).toBe(1);
    expect(adaptiveFloor('high')).toBe(1);
    const c = controller(1, adaptiveFloor('low'));
    expect(run(c, 60, 10)).toEqual([0.75]);
    expect(c.ratio).toBe(0.75);
  });

  it('does nothing when the ceiling is already at the floor (desktop at DPR 1)', () => {
    const c = controller(1, 1);
    expect(run(c, 60, 20)).toEqual([]);
    expect(c.ratio).toBe(1);
  });

  it('ignores short hitches (a shader compile, a GC)', () => {
    const c = controller(2, 1);
    for (let k = 0; k < 10; k++) {
      c.update(0.4); // one 400 ms hitch …
      run(c, 16.7, 2); // … then smooth again
    }
    expect(c.ratio).toBe(2);
  });

  it('treats a very long gap (debugger, suspended device) as a pause, not a slow frame', () => {
    const c = controller(2, 1);
    run(c, 40, 2.5);
    expect(c.update(8)).toBe(false);
    // the timers restarted: another full grace + 3 s are needed
    expect(run(c, 40, 3)).toEqual([]);
    expect(c.ratio).toBe(2);
  });

  it('restart() (the tab was hidden) forgets the slow time so far', () => {
    const c = controller(2, 1);
    run(c, 40, 2.5);
    c.restart();
    expect(run(c, 40, 3)).toEqual([]);
    expect(c.ratio).toBe(2);
  });

  it('still adapts on a device that really takes ~1 s per frame (software GL)', () => {
    const c = controller(1.5, 1);
    const seen = run(c, 900, 30);
    expect(seen).toEqual([1.25, 1]);
  });

  it('raises the ratio again with hysteresis (fast frames for a while)', () => {
    const c = controller(1.5, 1);
    run(c, 50, 12);
    expect(c.ratio).toBe(1);
    // between the thresholds (25 ms): no change either way
    expect(run(c, 25, 30)).toEqual([]);
    // clearly fast: back up one step after ~6 s, then the next
    const seen = run(c, 16.7, 20);
    expect(seen).toEqual([1.25, 1.5]);
    expect(c.ratio).toBe(1.5);
  });

  it('backs off when a raise immediately turns slow again (no oscillation)', () => {
    const c = controller(1.5, 1);
    run(c, 50, 6); // → 1.25
    expect(c.ratio).toBe(1.25);
    let changes = 0;
    // a device that is fast at 1.25 but slow at 1.5
    for (let t = 0; t < 240; t += 0.0167) {
      const ms = c.ratio > 1.3 ? 45 : 16.7;
      if (c.update(ms / 1000)) changes++;
    }
    // without the back-off it would flip every ~10 s (≈ 48 changes in 4 min)
    expect(changes).toBeLessThanOrEqual(12);
  });

  it('a new ceiling (quality / DPR change) restarts at the ceiling; a plain resize keeps the adapted ratio', () => {
    const c = controller(2, 1);
    run(c, 50, 8);
    const adapted = c.ratio;
    expect(adapted).toBeLessThan(2);
    expect(c.setRange(2, 1)).toBe(false);
    expect(c.ratio).toBe(adapted);
    expect(c.setRange(1.8, 1)).toBe(true);
    expect(c.ratio).toBe(1.8);
  });

  it('can be switched off', () => {
    const c = controller(2, 1);
    c.enabled = false;
    expect(run(c, 60, 20)).toEqual([]);
    expect(c.ratio).toBe(2);
  });
});

describe("'low' preset (phones / coarse pointers)", () => {
  it('renders at DPR ≤ 1 without MSAA or shadows', () => {
    const low = QUALITY_PRESETS.low;
    expect(low.maxPixelRatio).toBeLessThanOrEqual(1);
    expect(Math.min(low.maxPixelRatio, 3 * low.pixelRatioScale)).toBeLessThanOrEqual(1); // a DPR-3 phone
    expect(low.msaa).toBe(0);
    expect(low.shadows).toBe(false);
  });
});
