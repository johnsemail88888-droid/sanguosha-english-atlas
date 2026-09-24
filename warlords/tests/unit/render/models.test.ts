import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, TROOPS, WEAPONS } from '../../../src/data';
import { createHeroModel, createTroopModel, createWeaponModel, disposeModel, heroSpec } from '../../../src/render/models';
import { CharacterRig } from '../../../src/render/models/character';
import { GeoBuilder, PRIM, trs } from '../../../src/render/core/geo';
import type { Headgear, HeroExtra } from '../../../src/data/types';
import { shotClass } from '../../../src/render/vfx/eventVfx';
import { hazardStyle } from '../../../src/render/entities/hazards';

const vertexCount = (o: THREE.Object3D): number => {
  let n = 0;
  o.traverse((c) => {
    const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g && c.visible) n += g.getAttribute('position').count;
  });
  return n;
};

describe('GeoBuilder', () => {
  it('merges primitives with colours and rigid skin indices', () => {
    const b = new GeoBuilder({ skinned: true });
    b.bone = 3;
    b.box(trs(0, 0, 0), '#ff0000');
    b.bone = 5;
    b.add(PRIM.sphere(6, 4), trs(1, 0, 0, 0, 0, 0, 0.5), '#00ff00');
    const g = b.build();
    const n = g.getAttribute('position').count;
    expect(n).toBe(36 + PRIM.sphere(6, 4).getAttribute('position').count);
    const si = g.getAttribute('skinIndex');
    expect(si.getX(0)).toBe(3);
    expect(si.getX(n - 1)).toBe(5);
    expect(g.getAttribute('skinWeight').getX(0)).toBe(1);
  });

  it('keeps outward normals under mirrored transforms', () => {
    const b = new GeoBuilder();
    b.add(PRIM.box(), trs(0, 0, 0, 0, 0, 0, -1, 1, 1), '#ffffff');
    const g = b.build();
    const p = g.getAttribute('position');
    // every triangle's geometric normal must point away from the box centre
    for (let i = 0; i < p.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, i);
      const c1 = new THREE.Vector3().fromBufferAttribute(p, i + 1);
      const c2 = new THREE.Vector3().fromBufferAttribute(p, i + 2);
      const n = c1.clone().sub(a).cross(c2.clone().sub(a));
      const centre = a.clone().add(c1).add(c2).divideScalar(3);
      expect(n.dot(centre)).toBeGreaterThan(0);
    }
  });
});

describe('model factories', () => {
  it('builds every hero (with signature weapon) within the vertex budget', () => {
    expect(HEROES.length).toBeGreaterThan(0);
    for (const h of HEROES) {
      const m = createHeroModel(h.id);
      const n = vertexCount(m);
      expect(n, h.id).toBeGreaterThan(500);
      expect(n, h.id).toBeLessThan(14000);
      disposeModel(m);
    }
  });

  it('builds every troop / NPC type (mounts included)', () => {
    for (const t of TROOPS) {
      const m = createTroopModel(t.id);
      expect(vertexCount(m), t.id).toBeGreaterThan(300);
      disposeModel(m);
    }
  });

  it('builds every weapon and falls back for unknown ids', () => {
    for (const w of WEAPONS) expect(vertexCount(createWeaponModel(w.id)), w.id).toBeGreaterThan(20);
    for (const id of ['mystery_sniper', 'troop_crossbow', 'foo']) expect(vertexCount(createWeaponModel(id))).toBeGreaterThan(20);
  });

  it('unknown hero / troop ids never throw', () => {
    disposeModel(createHeroModel('no_such_hero'));
    disposeModel(createTroopModel('no_such_troop_elephant'));
  });

  it('every headgear, beard, body and extra combination builds', () => {
    const headgears: Headgear[] = ['none', 'crown', 'helmet', 'plumeHelmet', 'scholarHat', 'headband', 'hood', 'hairBun', 'longHair', 'turban', 'featherCrown', 'bandana', 'tacticalHelmet', 'beret'];
    const extras: HeroExtra[] = ['fan', 'eyepatch', 'shoulderPads', 'backFlags', 'cape', 'scarf', 'goggles', 'mask', 'bareChest', 'bells', 'whiteRobe', 'medicBag', 'ribbons', 'backpack', 'quiver', 'staff'];
    const bodies = ['slim', 'normal', 'heavy', 'huge'] as const;
    const beards = ['none', 'short', 'long', 'wild'] as const;
    headgears.forEach((hg, i) => {
      const spec = { ...heroSpec('guanyu'), headgear: hg, extras: [extras[i % extras.length], extras[(i + 5) % extras.length]], body: bodies[i % 4], beard: beards[i % 4], female: i % 3 === 0 };
      const rig = new CharacterRig(spec);
      rig.setWeapon(WEAPONS[i % WEAPONS.length].id);
      rig.update(1 / 30, 0, { speed: 3, moveX: 0, moveZ: 1, pitch: 0, flags: 0 });
      expect(rig.mesh.geometry.getAttribute('position').count).toBeGreaterThan(800);
      rig.dispose();
    });
  });

  it('weapon changes swap the merged geometry and are cached', () => {
    const rig = new CharacterRig(heroSpec('guanyu'));
    rig.setWeapon('pistol');
    const g1 = rig.mesh.geometry;
    rig.setWeapon(null);
    const g0 = rig.mesh.geometry;
    rig.setWeapon('pistol');
    expect(rig.mesh.geometry).toBe(g1);
    expect(g0.getAttribute('position').count).toBeLessThan(g1.getAttribute('position').count);
    rig.dispose();
  });
});

describe('visual classification', () => {
  it('maps weapons to shot classes', () => {
    expect(shotClass('pistol')).toBe('pistol');
    expect(shotClass('unknown_shotgun')).toBe('shotgun');
    expect(shotClass(undefined)).toBe('rifle');
  });

  it('maps hazard kinds to styles', () => {
    expect(hazardStyle('fire')).toBe('fire');
    expect(hazardStyle('napalm')).toBe('fire');
    expect(hazardStyle('lightningCloud')).toBe('cloud');
    expect(hazardStyle('trapDance')).toBe('trapDance');
    expect(hazardStyle('trapRoot')).toBe('trapRoot');
    expect(hazardStyle('healZone')).toBe('heal');
    expect(hazardStyle('arrowRain')).toBe('arrows');
    expect(hazardStyle('smoke')).toBe('smoke');
    expect(hazardStyle('whatever')).toBe('generic');
  });
});
