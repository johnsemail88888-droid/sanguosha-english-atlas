// 自动 quality: when the GPU benchmark runs, what its stored result picks, and the
// in-match controller (自动调节画质) fed a fake frame stream on a fake clock.
import { describe, expect, it } from 'vitest';
import type { GpuBench, Quality } from '../../../src/game/settings';
import { AutoQualityController, autoPick, autoTuneNeeded, benchFor, stepTier, tierRank, type AutoAdjustSample, type AutoAdjustStep } from '../../../src/ui/autoQuality';

const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const UHD = 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFT = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const hw = (renderer: string) => ({ renderer, software: false });
const bench = (gpu: string, ms: number, msSmall = ms * 0.8): GpuBench => ({ gpu, ms, msSmall, at: 1 });
const VIEW = { cssPixels: 1920 * 1000, dpr: 1 };

describe('the tier ladder', () => {
  it('steps within 极速 … 极致', () => {
    expect(tierRank('potato')).toBe(0);
    expect(tierRank('ultra')).toBe(4);
    expect(stepTier('high', -1)).toBe('medium');
    expect(stepTier('medium', 1)).toBe('high');
    expect(stepTier('potato', -1)).toBe('potato');
    expect(stepTier('ultra', 1)).toBe('ultra');
  });
});

describe('when 自动 benchmarks, and what it picks', () => {
  it('first launch and a changed GPU need a benchmark; the same GPU does not; a picked tier never does', () => {
    expect(autoTuneNeeded({ qualityAuto: true, gpuBench: null }, hw(RTX))).toBe(true);
    expect(autoTuneNeeded({ qualityAuto: true, gpuBench: bench(RTX, 2) }, hw(RTX))).toBe(false);
    expect(autoTuneNeeded({ qualityAuto: true, gpuBench: bench(UHD, 20) }, hw(RTX))).toBe(true);
    expect(autoTuneNeeded({ qualityAuto: false, gpuBench: null }, hw(RTX))).toBe(false);
    // unknown GPU string (no WebGL): nothing to key it on
    expect(autoTuneNeeded({ qualityAuto: true, gpuBench: null }, hw(''))).toBe(false);
    expect(benchFor({ gpuBench: bench(UHD, 20) }, hw(RTX))).toBeNull();
  });

  it('the stored result of this GPU picks the tier; a software renderer needs none; a failed run gives the first-run guess', () => {
    expect(autoPick({ gpuBench: null }, hw(RTX), VIEW, 'medium')).toBeNull();
    expect(autoPick({ gpuBench: bench(RTX, 2, 1.9) }, hw(RTX), VIEW, 'medium')?.quality).toBe('ultra');
    expect(autoPick({ gpuBench: bench(UHD, 20, 7) }, hw(UHD), { cssPixels: 1280 * 720, dpr: 1 }, 'low')?.quality).toBe('low');
    expect(autoPick({ gpuBench: null }, { renderer: SWIFT, software: true }, VIEW, 'low')).toMatchObject({ quality: 'potato', maxPixelRatio: 1 });
    expect(autoPick({ gpuBench: bench(RTX, 0, 0) }, hw(RTX), VIEW, 'low')).toMatchObject({ quality: 'low', fps: null });
    // another GPU's result is not this one's
    expect(autoPick({ gpuBench: bench(UHD, 20) }, hw(RTX), VIEW, 'medium')).toBeNull();
  });
});

/** A fake frame stream on a fake clock: `seconds` of samples every 0.5 s. */
function feed(c: AutoQualityController, seconds: number, s: Partial<AutoAdjustSample>): AutoAdjustStep[] {
  const steps: AutoAdjustStep[] = [];
  for (let t = 0; t < seconds; t += 0.5) {
    const step = c.update({ dt: 0.5, fps: 60, frameMs: 16.7, jsMs: 6, gpuMs: -1, active: true, resAtFloor: true, ...s });
    if (step) steps.push(step);
  }
  return steps;
}
const slow = { fps: 20, frameMs: 50 };

describe('自动调节画质: down', () => {
  it('nothing in the first 15 s of a match, then one step after 8 s under 28 fps', () => {
    const c = new AutoQualityController('high', null);
    expect(feed(c, 15, slow)).toEqual([]);
    expect(feed(c, 7.5, slow)).toEqual([]);
    expect(feed(c, 1, slow)).toEqual([{ dir: 'down', to: 'medium' }]);
    expect(c.tier).toBe('medium');
  });

  it('a slow stretch that recovers before 8 s is not a step', () => {
    const c = new AutoQualityController('high', null);
    feed(c, 15, {});
    expect(feed(c, 6, slow)).toEqual([]);
    expect(feed(c, 2, {})).toEqual([]);
    expect(feed(c, 6, slow)).toEqual([]);
  });

  it('resolution first: no tier step while the adaptive resolution can still go lower', () => {
    const c = new AutoQualityController('high', null);
    feed(c, 15, {});
    expect(feed(c, 30, { ...slow, resAtFloor: false })).toEqual([]);
    // at its floor now: 8 s more
    expect(feed(c, 7.5, slow)).toEqual([]);
    expect(feed(c, 1, slow)).toEqual([{ dir: 'down', to: 'medium' }]);
  });

  it('paused, loading, applying or hidden: not counted (and the hold starts again)', () => {
    const c = new AutoQualityController('high', null);
    feed(c, 15, {});
    feed(c, 6, slow);
    expect(feed(c, 30, { ...slow, active: false })).toEqual([]);
    expect(feed(c, 6, slow)).toEqual([]);
    expect(feed(c, 2.5, slow)).toEqual([{ dir: 'down', to: 'medium' }]);
  });

  it('at most one step per 60 s, never below 流畅 (a lower tier the player picked stays)', () => {
    const c = new AutoQualityController('ultra', null);
    const steps = feed(c, 15 + 300, slow);
    expect(steps.map((s) => s.to)).toEqual(['high', 'medium', 'low']);
    // 8 s, then 60 s apart
    expect(c.tier).toBe('low');
    const p = new AutoQualityController('potato', null);
    expect(feed(p, 200, slow)).toEqual([]);
  });

  it('the warm-up counts match time on screen only', () => {
    const c = new AutoQualityController('medium', null);
    feed(c, 60, { ...slow, active: false });
    expect(feed(c, 14.5, slow)).toEqual([]);
    expect(feed(c, 9, slow)).toEqual([{ dir: 'down', to: 'low' }]);
  });
});

describe('自动调节画质: up (自动 only)', () => {
  const fast = { fps: 60, frameMs: 16.7, jsMs: 4, gpuMs: 3 };

  it('a frame far under the display’s time (45 %) for 30 s makes one step ready — not applied by update()', () => {
    const c = new AutoQualityController('medium', 'ultra');
    feed(c, 15, fast);
    expect(feed(c, 29.5, fast)).toEqual([]);
    expect(c.pendingUp).toBeNull();
    feed(c, 1, fast);
    expect(c.pendingUp).toBe('high');
    expect(c.tier).toBe('medium');
    // one at a time: nothing more until it is taken
    feed(c, 60, fast);
    expect(c.pendingUp).toBe('high');
    expect(c.takeUp()).toBe('high');
    expect(c.tier).toBe('high');
    expect(c.pendingUp).toBeNull();
  });

  it('never above the benchmark’s pick; never on a tier the player picked (no ceiling)', () => {
    const c = new AutoQualityController('high', 'high');
    feed(c, 120, fast);
    expect(c.pendingUp).toBeNull();
    const m = new AutoQualityController('medium', null);
    feed(m, 120, fast);
    expect(m.pendingUp).toBeNull();
  });

  it('no GPU time (the browser cannot measure it): nothing proves the headroom — no step up', () => {
    const c = new AutoQualityController('medium', 'ultra');
    feed(c, 120, { ...fast, gpuMs: -1 });
    expect(c.pendingUp).toBeNull();
  });

  it('busy near the display’s frame time (GPU or main thread) is no headroom; a 144 Hz display asks for more', () => {
    const c = new AutoQualityController('medium', 'ultra');
    feed(c, 120, { ...fast, gpuMs: 9 });
    expect(c.pendingUp).toBeNull();
    feed(c, 120, { ...fast, jsMs: 9 });
    expect(c.pendingUp).toBeNull();
    // 144 Hz: 6.9 ms a frame — 4 ms of GPU is not under 45 % of it
    const hz144 = new AutoQualityController('medium', 'ultra');
    feed(hz144, 120, { ...fast, frameMs: 6.9, gpuMs: 4 });
    expect(hz144.pendingUp).toBeNull();
    feed(hz144, 31, { ...fast, frameMs: 6.9, gpuMs: 2.5, jsMs: 2.5 });
    expect(hz144.pendingUp).toBe('high');
  });

  it('a tier that proved too slow this match is not stepped back up to', () => {
    const c = new AutoQualityController('high', 'high');
    feed(c, 15, fast);
    expect(feed(c, 9, slow)).toEqual([{ dir: 'down', to: 'medium' }]);
    feed(c, 120, fast);
    expect(c.pendingUp).toBeNull();
  });

  it('setTier (the player / a switch changed it): judged afresh, a ready step up is dropped', () => {
    const c = new AutoQualityController('medium', 'ultra');
    feed(c, 50, { fps: 60, frameMs: 16.7, jsMs: 4, gpuMs: 3 });
    expect(c.pendingUp).toBe('high');
    c.setTier('low' as Quality, null);
    expect(c.pendingUp).toBeNull();
    feed(c, 60, { fps: 60, frameMs: 16.7, jsMs: 4, gpuMs: 3 });
    expect(c.pendingUp).toBeNull();
  });
});
