import { describe, expect, it } from 'vitest';
import type { MapProp, PropType } from '../../../src/core/map';
import { generateMap } from '../../../src/sim/map/generate';
import { buildPropGeometry, buildWorld } from '../../../src/render/world/world';
import { buildTerrain } from '../../../src/render/scene/terrain';
import { buildWater } from '../../../src/render/scene/water';
import { buildShowcaseMap } from '../../../src/render/dev/showcase';
import * as THREE from 'three';

const TYPES: PropType[] = ['wall', 'gateTower', 'palace', 'house', 'pavilion', 'watchtower', 'tent', 'barricade', 'crateStack', 'bridge', 'dock', 'ship', 'statue', 'banner', 'brazier', 'ruin', 'farmField', 'stairs'];

describe('world props', () => {
  const map = buildShowcaseMap();

  it('every prop type and variant builds geometry', () => {
    for (const type of TYPES) {
      for (let variant = 0; variant < 5; variant++) {
        const p: MapProp = { type, x: 0, y: 4, z: 0, rot: 0.3, sx: type === 'banner' ? 1.4 : 8, sy: type === 'farmField' ? 0 : 5, sz: 6, variant };
        const g = buildPropGeometry(p, map);
        expect(g, `${type}/${variant}`).not.toBeNull();
        const tris = g!.opaque.getAttribute('position').count / 3;
        if (type !== 'farmField') expect(tris, `${type}/${variant}`).toBeGreaterThan(4);
        expect(tris, `${type}/${variant}`).toBeLessThan(30000);
      }
    }
  });

  it('builds the showcase map without failures', () => {
    const w = buildWorld(map);
    expect(w.stats.failed).toBe(0);
    expect(w.stats.props).toBeGreaterThan(20);
    expect(w.stats.instanced).toBeGreaterThan(10);
    w.dispose();
  });

  it('builds the real generated map within budget', () => {
    const real = generateMap(20260924);
    const w = buildWorld(real);
    expect(w.stats.failed).toBe(0);
    // merged chunks: a few dozen meshes, triangles well under a million
    let meshes = 0;
    w.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBeLessThan(120);
    expect(w.stats.triangles).toBeLessThan(900_000);
    w.dispose();
    const t = buildTerrain(real);
    expect(t.group.children.length).toBeGreaterThan(4);
    t.dispose();
    const water = buildWater(real, new THREE.Vector3(0, 1, 0));
    expect(water.mesh).not.toBeNull();
    water.dispose();
  });
});
