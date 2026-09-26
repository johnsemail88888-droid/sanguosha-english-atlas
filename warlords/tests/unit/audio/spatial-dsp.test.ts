import { describe, expect, it } from 'vitest';
import { crackle, driveCurve, impulseResponse, karplusStrong, softClipCurve } from '../../../src/audio/dsp';
import { makeupCompensation } from '../../../src/audio/graph';
import { airCutoff, closestOnSegment, distanceGain, reverbSend, SPATIAL_PROFILES, volumeCurve } from '../../../src/audio/spatial';

describe('spatial math', () => {
  it('distance gain is 1 inside ref, monotonic, and 0 beyond range', () => {
    for (const p of Object.values(SPATIAL_PROFILES)) {
      expect(distanceGain(0, p)).toBeCloseTo(1, 6);
      expect(distanceGain(p.ref, p)).toBeCloseTo(1, 6);
      let prev = 1;
      for (let d = 0; d <= p.range * 1.1; d += p.range / 50) {
        const g = distanceGain(d, p);
        expect(g).toBeLessThanOrEqual(prev + 1e-9);
        expect(g).toBeGreaterThanOrEqual(0);
        prev = g;
      }
      expect(distanceGain(p.range, p)).toBe(0);
      expect(distanceGain(Number.NaN, p)).toBe(0);
    }
  });

  it('gunfire stays audible at 150 m but clearly quieter', () => {
    const g = distanceGain(150, SPATIAL_PROFILES.gun);
    expect(g).toBeGreaterThan(0.02);
    expect(g).toBeLessThan(0.2);
  });

  it('air absorption darkens and reverb send grows with distance', () => {
    const p = SPATIAL_PROFILES.gun;
    expect(airCutoff(0, p)).toBeGreaterThan(airCutoff(50, p));
    expect(airCutoff(50, p)).toBeGreaterThan(airCutoff(200, p));
    expect(airCutoff(10000, p)).toBeGreaterThanOrEqual(700);
    expect(reverbSend(100, p)).toBeGreaterThan(reverbSend(5, p));
    expect(reverbSend(1e6, p)).toBeLessThanOrEqual(0.6);
  });

  it('closestOnSegment clamps to the segment', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 10, y: 0, z: 0 };
    expect(closestOnSegment(a, b, { x: 5, y: 3, z: 0 })).toEqual({ x: 5, y: 0, z: 0 });
    expect(closestOnSegment(a, b, { x: -5, y: 0, z: 0 })).toEqual(a);
    expect(closestOnSegment(a, a, { x: 1, y: 1, z: 1 })).toEqual(a);
  });

  it('volume curve is perceptual and bounded', () => {
    expect(volumeCurve(0)).toBe(0);
    expect(volumeCurve(1)).toBe(1);
    expect(volumeCurve(0.5)).toBeLessThan(0.5);
    expect(volumeCurve(2)).toBe(1);
    expect(volumeCurve(Number.NaN)).toBe(0);
  });
});

describe('dsp', () => {
  it('soft clipper is transparent below the knee and bounded below 1', () => {
    const c = softClipCurve(4097, 0.7, 0.98, 2);
    let max = 0;
    for (const v of c) max = Math.max(max, Math.abs(v));
    expect(max).toBeLessThan(0.99);
    // input 0.5 (index for x=0.5 with inRange 2 → u=0.25)
    const idx = Math.round(((0.25 + 1) / 2) * 4096);
    expect(c[idx]).toBeCloseTo(0.5, 2);
  });

  it('drive curve is odd and normalised', () => {
    const c = driveCurve(3, 1025);
    expect(c[0]).toBeCloseTo(-1, 6);
    expect(c[1024]).toBeCloseTo(1, 6);
    expect(c[512]).toBeCloseTo(0, 6);
  });

  it('makeup compensation cancels the compressor auto makeup gain', () => {
    // threshold -6 dB, ratio 12: full-range gain -5.5 dB → makeup +3.3 dB
    const k = makeupCompensation(-6, 12);
    expect(20 * Math.log10(k)).toBeCloseTo(-3.3, 1);
  });

  it('Karplus–Strong string is finite, normalised and in tune', () => {
    const sr = 48000;
    const f = 220;
    const d = karplusStrong(sr, f, 1, { t60: 2, bright: 0.6, pos: 0.15, seed: 3 });
    let peak = 0;
    for (const x of d) {
      expect(Number.isFinite(x)).toBe(true);
      peak = Math.max(peak, Math.abs(x));
    }
    expect(peak).toBeCloseTo(0.8, 2);
    // autocorrelation pitch estimate over a steady segment
    const start = Math.floor(sr * 0.2);
    const n = 4096;
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = Math.floor(sr / 300); lag < Math.floor(sr / 150); lag++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += d[start + i] * d[start + i + lag];
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    const est = sr / bestLag;
    expect(Math.abs(1200 * Math.log2(est / f))).toBeLessThan(15);
  });

  it('impulse responses are energy-normalised stereo', () => {
    const ir = impulseResponse(16000, { seconds: 0.5, t60: 0.4, predelay: 0.01, damping: 0.5, early: 3, echoes: 2, seed: 1 });
    expect(ir).toHaveLength(2);
    for (const ch of ir) {
      let e = 0;
      for (const x of ch) e += x * x;
      expect(e).toBeCloseTo(1, 3);
    }
  });

  it('crackle is sparse and bounded', () => {
    const c = crackle(8000, 1, 30, 9);
    let nonZero = 0;
    let peak = 0;
    for (const x of c) {
      if (Math.abs(x) > 1e-6) nonZero++;
      peak = Math.max(peak, Math.abs(x));
    }
    expect(peak).toBeCloseTo(0.9, 3);
    expect(nonZero / c.length).toBeLessThan(0.6);
  });
});
