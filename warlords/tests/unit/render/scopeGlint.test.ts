// Scope glint (render/vfx/scopeGlint.ts): only a scoped sniper / marksman aimed roughly at you glints.
import { describe, expect, it } from 'vitest';
import { VF_ADS, VF_DOWNED, VF_STEALTH, type ViewEntity } from '../../../src/core/types';
import { glintStrength, scopedForGlint } from '../../../src/render/vfx/scopeGlint';

const ent = (weapon: string, flags: number): Pick<ViewEntity, 'kind' | 'flags' | 'weapon'> => ({ kind: 'hero', flags, weapon });
const unit = (x: number, y: number, z: number): { x: number; y: number; z: number } => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

describe('scope glint', () => {
  it('shows for heroes aiming a scoped weapon only', () => {
    expect(scopedForGlint(ent('qilin', VF_ADS))).toBe(true);
    expect(scopedForGlint(ent('qinggang', VF_ADS))).toBe(true);
    expect(scopedForGlint(ent('qilin', 0))).toBe(false);
    expect(scopedForGlint(ent('carbine', VF_ADS))).toBe(false);
    expect(scopedForGlint(ent('qilin', VF_ADS | VF_DOWNED))).toBe(false);
    expect(scopedForGlint(ent('qilin', VF_ADS | VF_STEALTH))).toBe(false);
    expect(scopedForGlint({ kind: 'troop', flags: VF_ADS, weapon: 'qilin' })).toBe(false);
  });

  it('is brightest dead on the aim line and gone well off it (and up close)', () => {
    const aim = unit(0, 0, -1);
    expect(glintStrength(aim, aim, 60)).toBe(1);
    const off10 = unit(Math.sin((10 * Math.PI) / 180), 0, -Math.cos((10 * Math.PI) / 180));
    const off30 = unit(Math.sin((30 * Math.PI) / 180), 0, -Math.cos((30 * Math.PI) / 180));
    const s10 = glintStrength(aim, off10, 60);
    expect(s10).toBeGreaterThan(0);
    expect(s10).toBeLessThan(1);
    expect(glintStrength(aim, off30, 60)).toBe(0);
    expect(glintStrength(aim, unit(0, 0, 1), 60)).toBe(0);
    expect(glintStrength(aim, aim, 5)).toBe(0);
  });
});
