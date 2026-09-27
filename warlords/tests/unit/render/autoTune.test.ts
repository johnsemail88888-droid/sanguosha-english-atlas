// Automatic graphics tier: what the GPU benchmark (render/bench.ts, two sizes)
// says this machine can run — tier and render scale — for the player's view.
import { describe, expect, it } from 'vitest';
import { QUALITIES } from '../../../src/game/settings';
import { AUTO_MID_MS, AUTO_STRONG_MS, BENCH_PIXELS, BENCH_SMALL_PIXELS, estimateFps, estimateFrameMs, frameCost, pickAutoTune } from '../../../src/render/adaptiveRes';

const P720 = 1280 * 720;
const P1080 = 1920 * 1080;

describe('benchmark → frame cost', () => {
  it('two sizes split the frame into a fixed part and a per-pixel part', () => {
    // 10 ms at 1280×720, 4 ms at 640×360: 8.7 ms per megapixel, 2 ms fixed
    const c = frameCost(10, 4);
    expect(c.perMpx).toBeCloseTo(6 / ((BENCH_PIXELS - BENCH_SMALL_PIXELS) / 1e6), 6);
    expect(c.fixedMs).toBeCloseTo(2, 6);
    // the model reproduces both measurements on 'medium'
    expect(estimateFrameMs(c, 'medium', BENCH_PIXELS)).toBeCloseTo(10, 6);
    expect(estimateFrameMs(c, 'medium', BENCH_SMALL_PIXELS)).toBeCloseTo(4, 6);
  });

  it('a CPU-bound machine (both sizes alike) is all fixed cost: more pixels cost ~nothing', () => {
    const c = frameCost(2, 2);
    expect(c.perMpx).toBe(0);
    expect(estimateFrameMs(c, 'medium', 4 * P1080)).toBeCloseTo(2, 6);
  });

  it('one size only, or a noisy pair (small slower than big): 60 % scales with the pixels', () => {
    for (const c of [frameCost(10), frameCost(10, 14)]) {
      expect(c.fixedMs).toBeCloseTo(4, 6);
      expect(estimateFrameMs(c, 'medium', BENCH_PIXELS)).toBeCloseTo(10, 6);
    }
  });

  it('richer tiers cost more', () => {
    const c = frameCost(8, 3);
    const ms = QUALITIES.map((q) => estimateFrameMs(c, q, P1080));
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]);
  });
});

describe('automatic tier + render scale', () => {
  const pick = (ms: number | null, small: number | null, css = P1080, dpr = 1, software = false) => pickAutoTune({ benchMs: ms, benchSmallMs: small, software, cssPixels: css, dpr });

  it('a software renderer → 极速 at 1×, whatever it measured', () => {
    expect(pick(null, null, P1080, 2, true)).toEqual({ quality: 'potato', maxPixelRatio: 1, fps: null });
    expect(pick(600, 500, P1080, 1, true)).toMatchObject({ quality: 'potato', maxPixelRatio: 1 });
  });

  it('no benchmark (it failed) → the first-run guess (均衡 by default), render scale ≤ 1.25', () => {
    expect(pick(null, null, P1080, 2)).toEqual({ quality: 'medium', maxPixelRatio: 1.25, fps: null });
    expect(pick(0, 0, P1080, 1)).toEqual({ quality: 'medium', maxPixelRatio: 1, fps: null });
    expect(pickAutoTune({ benchMs: 0, software: false, cssPixels: P1080, dpr: 1, fallback: 'low' }).quality).toBe('low');
  });

  it('on the reference view: ≤ 6 ms strong → 高清 / 极致, ≤ 12 ms mid → 均衡, ≤ 24 ms weak → 流畅, slower → 极速', () => {
    expect(pick(2.5, 2.2, P720).quality).toBe('ultra');
    expect(pick(6, 2.5, P720).quality).toBe('high');
    expect(pick(6.5, 2.7, P720).quality).toBe('medium');
    expect(pick(12, 4.5, P720).quality).toBe('medium');
    expect(pick(13, 5, P720).quality).toBe('low');
    expect(pick(24, 9, P720).quality).toBe('low');
    expect(pick(26, 10, P720).quality).toBe('potato');
  });

  it('a bigger view costs more where the GPU is pixel-bound, not where the frame is CPU-bound', () => {
    // RTX-class: the frame is draw submission (CPU): 1080p changes nothing
    expect(pick(1.5, 1.2).quality).toBe('ultra');
    expect(pick(2.5, 2.3).quality).toBe('ultra');
    // pixel-bound mid GPU: 均衡 at 720p, 流畅 at 1080p (2.25× the pixels)
    expect(pick(10, 3.5, P720).quality).toBe('medium');
    expect(pick(10, 3.5).quality).toBe('low');
    // 6 ms at 720p, pixel-bound: 均衡 at 1080p
    expect(pick(6, 2.5).quality).toBe('medium');
  });

  it('the render scale: min(dpr, 2) for strong, ≤ 1.5 for mid, 1 below — lowered while the frame leaves its class', () => {
    // a CPU-bound fast GPU on a 4K / DPR-2 laptop: full 2×
    expect(pick(1.5, 1.4, 1920 * 1080, 2)).toMatchObject({ quality: 'ultra', maxPixelRatio: 2 });
    // a DPR-3 phone-like screen: capped at 2
    expect(pick(1.5, 1.4, 800 * 400, 3).maxPixelRatio).toBe(2);
    // DPR 1: 1
    expect(pick(1.5, 1.4, P1080, 1).maxPixelRatio).toBe(1);
    // mid GPU on a DPR-2 screen: ≤ 1.5
    const mid = pick(8, 7, P720, 2);
    expect(mid.quality).toBe('medium');
    expect(mid.maxPixelRatio).toBe(1.5);
    // pixel-bound strong GPU on a Retina screen: 高清 at 1×, not at 2×
    const p = pick(4, 1.6, 1440 * 900, 2);
    expect(p.quality).toBe('high');
    expect(p.maxPixelRatio).toBeGreaterThanOrEqual(1);
    expect(p.maxPixelRatio).toBeLessThan(2);
    expect(p.maxPixelRatio * 4).toBe(Math.round(p.maxPixelRatio * 4)); // 0.25 steps
    // 流畅 / 极速 never render above 1×
    expect(pick(18, 6, P1080, 2).maxPixelRatio).toBe(1);
    expect(pick(48, 21.6, P1080, 2).maxPixelRatio).toBe(1);
  });

  it('every pick above 1× keeps the frame in its class; its fps is the estimate', () => {
    for (const [ms, small] of [[1, 0.9], [3, 1.2], [6, 2.5], [9, 3], [12, 4], [20, 8], [30, 12]] as const) {
      for (const [css, dpr] of [[P720, 1], [P1080, 1], [P1080, 1.5], [1440 * 900, 2]] as const) {
        const p = pick(ms, small, css, dpr);
        const c = frameCost(ms, small);
        const limit = p.quality === 'medium' ? AUTO_MID_MS : AUTO_STRONG_MS;
        if (p.maxPixelRatio > 1) expect(estimateFrameMs(c, 'medium', css * p.maxPixelRatio ** 2)).toBeLessThanOrEqual(limit + 1e-9);
        expect(p.maxPixelRatio).toBeLessThanOrEqual(Math.min(dpr, p.quality === 'medium' ? 1.5 : 2));
        expect(p.fps).toBe(estimateFps(ms, small, p.quality, css, p.maxPixelRatio));
      }
    }
  });
});
