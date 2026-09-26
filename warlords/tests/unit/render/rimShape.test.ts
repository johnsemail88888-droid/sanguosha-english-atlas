// Display shape of the mountain rim (UX-18): the corner peaks beyond the walls
// read as mountains (≈ 100–150 m, sloped) instead of 500–600 m pillars, while
// everything reachable keeps the simulation's heights exactly.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateMap } from '../../../src/sim/map/generate';
import { terrainHeight } from '../../../src/core/map';
import { BOUNDARY, rimDistance } from '../../../src/sim/map/terrain';
import { beyondWalls, displayMap, rimBoundary, rimDisplayHeights, softCap } from '../../../src/render/scene/rimShape';
import { buildTerrain } from '../../../src/render/scene/terrain';

const maps = [generateMap(20260924), generateMap(7102)];

describe('rim display shape', () => {
  it('measures the distance beyond the walls on the generator’s rounded square', () => {
    const b = rimBoundary(maps[0]);
    expect(b).toBe(BOUNDARY);
    expect(beyondWalls(0, 0, b)).toBeLessThan(0);
    expect(beyondWalls(b, 0, b)).toBeCloseTo(0, 6);
    expect(beyondWalls(b + 5, 20, b)).toBeCloseTo(5, 6);
    // on the cut corners the walls run along |x| + |z| = b / 0.62
    const s = b / 0.62 / 2;
    expect(beyondWalls(s, s, b)).toBeCloseTo(0, 6);
    expect(rimDistance(s, s)).toBeCloseTo(b, 6);
    expect(beyondWalls(s + 10, s + 10, b)).toBeCloseTo(10 * Math.SQRT2, 6);
  });

  it('soft cap: identity well under the cap, eases toward it, never above', () => {
    expect(softCap(10, 50, 8)).toBe(10);
    expect(softCap(42, 50, 8)).toBe(42);
    expect(softCap(45, 50, 8)).toBeLessThan(45);
    expect(softCap(45, 50, 8)).toBeGreaterThan(42);
    expect(softCap(900, 50, 8)).toBeLessThanOrEqual(50);
    expect(softCap(900, 50, 8)).toBeGreaterThan(49.9);
  });

  for (const map of maps) {
    const disp = rimDisplayHeights(map);
    const n = map.res + 1;
    const cell = map.size / map.res;
    const half = map.size / 2;

    it(`keeps every reachable height and never raises the rim (seed ${map.seed})`, () => {
      let changed = 0;
      for (let iz = 0; iz < n; iz++)
        for (let ix = 0; ix < n; ix++) {
          const x = -half + ix * cell;
          const z = -half + iz * cell;
          const k = iz * n + ix;
          expect(disp[k]).toBeLessThanOrEqual(map.heights[k]);
          if (beyondWalls(x, z, BOUNDARY) <= 0) expect(disp[k]).toBe(map.heights[k]);
          if (disp[k] !== map.heights[k]) changed++;
        }
      expect(changed).toBeGreaterThan(100);
    });

    it('turns the corner pillars into sloped mountains', () => {
      let simMax = 0;
      for (const h of map.heights) simMax = Math.max(simMax, h);
      let dispMax = 0;
      for (const h of disp) dispMax = Math.max(dispMax, h);
      expect(simMax).toBeGreaterThan(400); // the generator's corners
      expect(dispMax).toBeLessThan(170);
      expect(dispMax).toBeGreaterThan(90); // still a mountain range, not flattened
      // along each corner diagonal: rises all the way out (no pit, no wall on top of a wall),
      // and past the steep foot the flank is a slope (≤ ~50°), not a column
      const dm = displayMap(map);
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        let prev = -Infinity;
        for (let s = 124; s <= 160; s += 2) {
          const h = terrainHeight(dm, sx * s, sz * s);
          expect(h).toBeGreaterThan(prev - 3);
          prev = h;
        }
        const run = (160 - 138) * Math.SQRT2;
        const rise = terrainHeight(dm, sx * 160, sz * 160) - terrainHeight(dm, sx * 138, sz * 138);
        expect(rise / run).toBeLessThan(1.2);
      }
    });

    it('leaves the ground under the rim’s pines and rocks where the sim put it', () => {
      const dm = displayMap(map);
      const beyond = map.props.filter((p) => beyondWalls(p.x, p.z, BOUNDARY) > 0);
      expect(beyond.length).toBeGreaterThan(5);
      for (const p of beyond) expect(Math.abs(terrainHeight(dm, p.x, p.z) - terrainHeight(map, p.x, p.z))).toBeLessThan(0.3);
    });
  }

  it('the terrain mesh and skirt draw the display shape (no vertex near the old peaks)', () => {
    const t = buildTerrain(maps[0]);
    let maxY = 0;
    const p = new THREE.Vector3();
    t.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, p.fromBufferAttribute(pos, i).y);
    });
    expect(maxY).toBeLessThan(170);
    t.dispose();
  });
});
