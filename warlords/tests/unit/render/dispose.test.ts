// End of a match: the shared geometry caches the match filled (bodies,
// body+weapon merges, weapons, loot) are released with the renderer, so the
// title screen does not keep the last match's vertex arrays (G3-4).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, WEAPONS } from '../../../src/data';
import { createHeroModel, createWeaponModel, disposeModel, releaseModelCaches } from '../../../src/render/models';
import { characterGeometryCacheSize } from '../../../src/render/models/humanoid';

describe('releaseModelCaches', () => {
  it('empties the body / weapon geometry caches and disposes their geometries', () => {
    const hero = createHeroModel(HEROES[0].id);
    const weapon = createWeaponModel(WEAPONS[0].id);
    expect(characterGeometryCacheSize()).toBeGreaterThan(0);
    const geos = new Set<THREE.BufferGeometry>();
    for (const o of [hero, weapon]) o.traverse((c) => {
      const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g) geos.add(g);
    });
    let disposed = 0;
    for (const g of geos) g.addEventListener('dispose', () => void disposed++);
    disposeModel(hero);
    disposeModel(weapon);
    releaseModelCaches();
    expect(characterGeometryCacheSize()).toBe(0);
    expect(disposed).toBeGreaterThan(0);
    // the next match rebuilds what it needs
    const again = createHeroModel(HEROES[0].id);
    expect(characterGeometryCacheSize()).toBeGreaterThan(0);
    disposeModel(again);
    releaseModelCaches();
  });
});
