// UX-12: every 军旗 on the generated map shows a glyph that fits where it stands — 虎牢关 flies
// 董卓's 「董」, never the nearest-colour 「蛮」 of the dark cloth.
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/core/types';
import { generateMap } from '../../../src/sim/map/generate';
import { BANNER_GLYPHS, FORTRESS, bannerVariant } from '../../../src/sim/map/regions';
import { BANNER_ATLAS, bannerCell } from '../../../src/render/world/banners';

describe('banner glyphs', () => {
  it('every explicit glyph exists in the render atlas', () => {
    for (const g of BANNER_GLYPHS) expect(BANNER_ATLAS[bannerCell(undefined, bannerVariant(g))].glyph).toBe(g);
  });

  it('variant 0 keeps the nearest-colour choice', () => {
    expect(BANNER_ATLAS[bannerCell('#2e5fa8')].glyph).toBe('魏');
    expect(BANNER_ATLAS[bannerCell('#c9a227')].glyph).toBe('黄');
  });

  it('虎牢关 wall banners read 董, and no banner on the map reads 蛮 outside the 南蛮 camp', () => {
    const map = generateMap(defaultSettings().mapSeed);
    const banners = map.props.filter((p) => p.type === 'banner');
    const hulao = banners.filter((p) => Math.abs(p.z - FORTRESS.z) < 8 && Math.abs(p.x - FORTRESS.x) < 40);
    expect(hulao.length).toBeGreaterThanOrEqual(4);
    for (const p of hulao) expect(BANNER_ATLAS[bannerCell(p.color, p.variant)].glyph).toBe('董');
    const man = banners.filter((p) => BANNER_ATLAS[bannerCell(p.color, p.variant)].glyph === '蛮');
    for (const p of man) expect(Math.hypot(p.x + 92, p.z - 122)).toBeLessThan(40);
  });
});
