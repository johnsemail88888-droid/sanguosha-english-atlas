// Builds the top-down map preview SVG. Only with MAP_PREVIEW=1 does it write
// docs/map-preview.svg and render docs/map-preview.png through headless
// Chromium (Playwright), so ordinary test runs never touch tracked files:
//   MAP_PREVIEW=1 npx vitest run tests/unit/map/preview.test.ts
// (MAP_PREVIEW_PNG=1 is accepted as an alias.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { terrainHeight } from '../../../src/core/map';
import { generateMapDetailed } from '../../../src/sim/map/generate';
import { segmentClear } from '../../../src/sim/map/colliders';
import { NAV_MAIN, NAV_WATER, navNodePos } from '../../../src/sim/map/nav';
import { Rng } from '../../../src/core/rng';
import { mapSvg } from './preview';

const SEED = 20260924;
const DOCS = fileURLToPath(new URL('../../../docs/', import.meta.url));

describe('map preview', () => {
  it('renders the map preview (written to docs/ with MAP_PREVIEW=1)', async () => {
    const { map } = generateMapDetailed(SEED);
    const svg = mapSvg(map, { px: 960 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('洛阳宫城');
    if (process.env.MAP_PREVIEW || process.env.MAP_PREVIEW_PNG) {
      mkdirSync(DOCS, { recursive: true });
      writeFileSync(DOCS + 'map-preview.svg', svg);
      const { chromium } = await import('@playwright/test');
      const browser = await chromium.launch({
        executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium',
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      });
      try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1152 } });
        await page.setContent(`<html><body style="margin:0;background:#1c1a17">${readFileSync(DOCS + 'map-preview.svg', 'utf8')}</body></html>`);
        await page.screenshot({ path: DOCS + 'map-preview.png' });
      } finally {
        await browser.close();
      }
    }
  }, 60_000);

  it('offers cover within ~15 m almost everywhere, yet long sightlines exist', () => {
    const { map, nav } = generateMapDetailed(SEED);
    const rng = new Rng(5);
    const cover: number[] = [];
    let long = 0;
    let rays = 0;
    for (let k = 0; k < 300; ) {
      const node = rng.int(0, nav.height.length - 1);
      if (Number.isNaN(nav.height[node]) || !(nav.flags[node] & NAV_MAIN) || nav.flags[node] & NAV_WATER) continue;
      const p = navNodePos(nav, node);
      if (Math.abs(terrainHeight(map, p.x, p.z) - p.y) > 0.01) continue; // ground points only
      k++;
      // chest-height cover (anything overlapping 0.9–1.3 m above the feet)
      cover.push(nav.colliders.clearance(p.x, p.z, p.y + 0.9, p.y + 1.3, 40));
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const qx = p.x + Math.cos(ang) * 40;
        const qz = p.z + Math.sin(ang) * 40;
        rays++;
        if (segmentClear(map, nav.colliders, p.x, p.y + 1.6, p.z, qx, terrainHeight(map, qx, qz) + 1.6, qz, 2)) long++;
      }
    }
    cover.sort((a, b) => a - b);
    expect(cover[Math.floor(cover.length * 0.9)]).toBeLessThan(15);
    // at least a fifth of all eye-level rays see 40 m or more
    expect(long / rays).toBeGreaterThan(0.2);
  });
});
