// The aim math the HUD draws with (data/weaponFeel.ts, weapons spec C4 / C6): holdover angles to
// the pixel (the spec's 1080p tables at vertical FOV 75), mil-dot scale, the relative ADS
// sensitivity setting's migration from the old absolute 0.6.
import { describe, expect, it } from 'vitest';
import { ballisticHold, holdPx, pxPerMil } from '../../../src/data/weaponFeel';
import { DEFAULT_SETTINGS, defaultFov, loadSettingsForTest, migrateAdsSensitivity } from '../../../src/game/settings';

const H = 1080;
const FOV = 75;
const px = (v: number, g: number, d: number, zoom: number): number => Math.round(holdPx(ballisticHold(v, g, d), FOV, zoom, H));

describe('ballisticHold: the holdover ladders to the pixel (1080p, FOV 75)', () => {
  it('guanshi (v60, g9.8, 1.3×): 20 / 40 / 60 m → 27 / 54 / 81 px', () => {
    expect([20, 40, 60].map((d) => px(60, 9.8, d, 1.3))).toEqual([27, 54, 81]);
    // the angles (1.56° / 3.13° / 4.70°)
    expect((ballisticHold(60, 9.8, 20) * 180) / Math.PI).toBeCloseTo(1.56, 2);
    expect((ballisticHold(60, 9.8, 60) * 180) / Math.PI).toBeCloseTo(4.7, 1);
  });

  it('烈弓 (v150, g5): 2.5× 7 / 11 / 17 / 22 px, 5× 14 / 23 / 34 / 46 px at 30 / 50 / 75 / 100 m', () => {
    expect([30, 50, 75, 100].map((d) => px(150, 5, d, 2.5))).toEqual([7, 11, 17, 22]);
    expect([30, 50, 75, 100].map((d) => px(150, 5, d, 5))).toEqual([14, 23, 34, 46]);
  });

  it('烈弓 hip snap (v82.5) 10 / 20 / 30 m → 3 / 5 / 8 px; xiaoji (v120, g5, 1.8×) 20 / 40 / 60 m → 5 / 10 / 15 px', () => {
    expect([10, 20, 30].map((d) => px(82.5, 5, d, 1))).toEqual([3, 5, 8]);
    expect([20, 40, 60].map((d) => px(120, 5, d, 1.8))).toEqual([5, 10, 15]);
  });

  it('is the flat solution (sin 2θ = g·d / v²), 0 without gravity or range, NaN out of reach', () => {
    const th = ballisticHold(60, 9.8, 40);
    expect(Math.sin(2 * th)).toBeCloseTo((9.8 * 40) / 3600, 9);
    expect(ballisticHold(60, 0, 40)).toBe(0);
    expect(ballisticHold(60, 9.8, 0)).toBe(0);
    expect(ballisticHold(20, 9.8, 100)).toBeNaN();
  });
});

describe('mil-dots to true scale', () => {
  it('3.27 px / mil at 4×, 6.59 at 8× (a hero is 18 mil tall at 100 m)', () => {
    expect(pxPerMil(FOV, 4, H)).toBeCloseTo(3.27, 2);
    expect(pxPerMil(FOV, 8, H)).toBeCloseTo(6.59, 1);
    // 1.8 m at 100 m ≈ 18 mil
    expect(Math.atan(1.8 / 100) * 1000).toBeCloseTo(18, 0);
  });
});

describe('ADS sensitivity setting (relative since the zoom-matched rule)', () => {
  it('migrates the old absolute value once: 0.6 (the old default) → 1.0, v → v / 0.6 within 0.5…1.5', () => {
    expect(migrateAdsSensitivity(0.6)).toBe(1);
    expect(migrateAdsSensitivity(0.45)).toBe(0.75);
    expect(migrateAdsSensitivity(0.9)).toBe(1.5);
    expect(migrateAdsSensitivity(1.5)).toBe(1.5);
    expect(migrateAdsSensitivity(0.2)).toBe(0.5);
    expect(migrateAdsSensitivity(undefined)).toBe(DEFAULT_SETTINGS.adsSensitivity);
    expect(DEFAULT_SETTINGS.adsSensitivity).toBe(1);
    expect(DEFAULT_SETTINGS.adsSensRelative).toBe(true);
  });

  it('a stored profile from before is migrated on load; a migrated one is kept as is', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      store.set('sgwl.settings.v1', JSON.stringify({ adsSensitivity: 0.6, mouseSensitivity: 1.3 }));
      let s = loadSettingsForTest();
      expect(s.adsSensitivity).toBe(1);
      expect(s.adsSensRelative).toBe(true);
      expect(s.mouseSensitivity).toBe(1.3);
      store.set('sgwl.settings.v1', JSON.stringify({ adsSensitivity: 0.3 }));
      expect(loadSettingsForTest().adsSensitivity).toBe(0.5);
      store.set('sgwl.settings.v1', JSON.stringify({ adsSensitivity: 0.6, adsSensRelative: true }));
      s = loadSettingsForTest();
      expect(s.adsSensitivity).toBe(0.6);
    } finally {
      g.localStorage = prev;
    }
  });

  it('first run on a finger starts at FOV 62', () => {
    expect(defaultFov({ coarse: true, minSide: 390 })).toBe(62);
    expect(defaultFov({ coarse: false, minSide: 1080 })).toBe(DEFAULT_SETTINGS.fov);
  });
});
