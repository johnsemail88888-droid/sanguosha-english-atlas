// Scope glint (render/vfx/scopeGlint.ts): only a real scope (the sniper's, 烈弓's) aimed roughly at
// you glints — a DMR's near sight does not — beyond 20 m, brighter the stronger the zoom (spec C5).
import { describe, expect, it } from 'vitest';
import { VF_ADS, VF_DOWNED, VF_STEALTH, VF_ZOOM2, type ViewEntity } from '../../../src/core/types';
import { glintBrightness } from '../../../src/data/weaponFeel';
import { GLINT_MIN_DIST, glintStrength, glintZoom, scopedForGlint } from '../../../src/render/vfx/scopeGlint';

const ent = (weapon: string, flags: number): Pick<ViewEntity, 'kind' | 'flags' | 'weapon'> => ({ kind: 'hero', flags, weapon });
const unit = (x: number, y: number, z: number): { x: number; y: number; z: number } => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

describe('scope glint', () => {
  it('shows for heroes aiming a real scope only (sniper, 烈弓 — not a DMR near sight)', () => {
    expect(scopedForGlint(ent('qilin', VF_ADS))).toBe(true);
    expect(scopedForGlint(ent('liegong', VF_ADS))).toBe(true);
    expect(scopedForGlint(ent('qinggang', VF_ADS))).toBe(false);
    expect(scopedForGlint(ent('yitian', VF_ADS))).toBe(false);
    expect(scopedForGlint(ent('qilin', 0))).toBe(false);
    expect(scopedForGlint(ent('carbine', VF_ADS))).toBe(false);
    expect(scopedForGlint(ent('qilin', VF_ADS | VF_DOWNED))).toBe(false);
    expect(scopedForGlint(ent('qilin', VF_ADS | VF_STEALTH))).toBe(false);
    expect(scopedForGlint({ kind: 'troop', flags: VF_ADS, weapon: 'qilin' })).toBe(false);
  });

  it('is brightest dead on the aim line and gone well off it (and inside 20 m)', () => {
    const aim = unit(0, 0, -1);
    expect(glintStrength(aim, aim, 60)).toBe(1);
    const off10 = unit(Math.sin((10 * Math.PI) / 180), 0, -Math.cos((10 * Math.PI) / 180));
    const off30 = unit(Math.sin((30 * Math.PI) / 180), 0, -Math.cos((30 * Math.PI) / 180));
    const s10 = glintStrength(aim, off10, 60);
    expect(s10).toBeGreaterThan(0);
    expect(s10).toBeLessThan(1);
    expect(glintStrength(aim, off30, 60)).toBe(0);
    expect(glintStrength(aim, unit(0, 0, 1), 60)).toBe(0);
    expect(GLINT_MIN_DIST).toBe(20);
    expect(glintStrength(aim, aim, 15)).toBe(0);
    expect(glintStrength(aim, aim, 21)).toBe(1);
  });

  it('brightness follows the zoom the shooter looks through (his second step: VF_ZOOM2)', () => {
    expect(glintBrightness(2.5)).toBeCloseTo(0.4, 9);
    expect(glintBrightness(4)).toBeCloseTo(0.6, 9);
    expect(glintBrightness(5)).toBeCloseTo(0.7, 9);
    expect(glintBrightness(8)).toBeCloseTo(1, 9);
    expect(glintZoom(ent('qilin', VF_ADS))).toBe(4);
    expect(glintZoom(ent('qilin', VF_ADS | VF_ZOOM2))).toBe(8);
    expect(glintZoom(ent('liegong', VF_ADS))).toBe(2.5);
    expect(glintZoom(ent('liegong', VF_ADS | VF_ZOOM2))).toBe(5);
    // a qilin at 8× flashes brighter than 烈弓 at 2.5×
    expect(glintBrightness(glintZoom(ent('qilin', VF_ADS | VF_ZOOM2)))).toBeGreaterThan(glintBrightness(glintZoom(ent('liegong', VF_ADS))) * 2);
  });
});
