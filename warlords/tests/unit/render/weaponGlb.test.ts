// AI-art weapons (models/weaponGlb.ts): the calibration maths and table, the
// load → calibrate → register pipeline (real GLTFLoader on in-memory GLBs),
// buildWeapon's art / procedural choice, late swaps (loot) and the release at
// the end of a match — plus the rigid (unrigged) character override of
// models/glbRigid.ts. No asset files needed except the table check, which
// reads the shipped GLB headers.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEROES, WEAPONS, WEAPON_BY_ID } from '../../../src/data';
import {
  WEAPON_GLB_CAL,
  calibrateWeaponGeometry,
  canonicalRotation,
  loadWeaponArt,
  matchWeaponIds,
  mergeSceneGeometry,
  prepareWeaponArt,
  releaseWeaponArt,
  resetWeaponArtForTests,
  setWeaponArtForTests,
  weaponArtListed,
  weaponArtSync,
  weaponModelPath,
  type Axis,
  type WeaponGlbCal,
} from '../../../src/render/models/weaponGlb';
import { buildProceduralWeapon, buildWeapon, hasWeaponArt, heldMaterialOf, heldWeaponMaterial, weaponArtEpoch } from '../../../src/render/models/weapons';
import { heroModelPath, loadCharTemplate, registerModelGlb, resetGlbCacheForTests, rigidTemplateSync } from '../../../src/render/models/glb';
import { CharacterRig } from '../../../src/render/models/character';
import { createWeaponModel, heroSpec, releaseModelCaches } from '../../../src/render/models';
import { LootView } from '../../../src/render/entities/objects';
import type { EntityCtx } from '../../../src/render/entities/context';
import type { ViewEntity } from '../../../src/core/types';
import { CHARACTER_FOG_MAX } from '../../../src/render/core/materials';
import { assetList, setAssetListForTests } from '../../../src/game/assets';
import { boxGlbUrl } from './glbFixtures';
import { setWorldArtQuality } from '../../../src/render/core/worldArt';
import { QUALITY_PRESETS } from '../../../src/render/quality';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const AXES: Axis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const vec = (a: Axis): THREE.Vector3 => {
  const v = new THREE.Vector3();
  v.setComponent('xyz'.indexOf(a[1]), a[0] === '+' ? 1 : -1);
  return v;
};

/** A loaded-file-like scene: a textured box "gun" along +Z (1.0 long, like most shipped files) + a second primitive. */
function gunScene(): { scene: THREE.Group; map: THREE.Texture; srcMat: THREE.MeshStandardMaterial } {
  const map = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
  const srcMat = new THREE.MeshStandardMaterial({ map });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 1.0), srcMat));
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.1), srcMat);
  sight.position.set(0, 0.17, 0);
  scene.add(sight);
  return { scene, map, srcMat };
}

const ctx = (): EntityCtx =>
  ({ time: 0, dt: 1 / 60, camPos: new THREE.Vector3(0, 2, 5), shadows: false }) as unknown as EntityCtx;

afterEach(() => {
  resetWeaponArtForTests();
  resetGlbCacheForTests();
  setAssetListForTests(null);
});

// ── maths ────────────────────────────────────────────────────────────────────

describe('canonicalRotation', () => {
  it('turns every perpendicular fwd / up pair into barrel −Z, up +Y (a proper rotation)', () => {
    let n = 0;
    for (const f of AXES)
      for (const u of AXES) {
        if (f[1] === u[1]) continue;
        const R = canonicalRotation(f, u);
        expect(vec(f).applyMatrix4(R).distanceTo(new THREE.Vector3(0, 0, -1)), `${f} ${u}`).toBeLessThan(1e-9);
        expect(vec(u).applyMatrix4(R).distanceTo(new THREE.Vector3(0, 1, 0)), `${f} ${u}`).toBeLessThan(1e-9);
        expect(R.determinant()).toBeCloseTo(1, 9);
        n++;
      }
    expect(n).toBe(24);
    expect(() => canonicalRotation('+z', '-z')).toThrow();
  });

  it('roll turns the top toward the weapon right (+X), about the barrel', () => {
    const R = canonicalRotation('+z', '+y', Math.PI / 2);
    expect(new THREE.Vector3(0, 1, 0).applyMatrix4(R).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(new THREE.Vector3(0, 0, 1).applyMatrix4(R).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });
});

describe('calibrateWeaponGeometry', () => {
  it('scales to the target length, puts the grip at the origin and maps the calibration points', () => {
    // a 1.0 long, 0.4 tall "gun" along +X with its muzzle at +X (like smg.glb)
    const src = new THREE.BoxGeometry(1, 0.4, 0.1);
    const x0 = src.getAttribute('position').getX(0);
    const cal: WeaponGlbCal = { fwd: '+x', up: '+y', size: 0.5, grip: [0.3, 0.1], fore: [0.6, 0], mag: [0.4, -0.15], muzzle: [1, 0.1] };
    const c = calibrateWeaponGeometry(src, cal);
    const b = c.geo.boundingBox!;
    expect(c.length).toBeCloseTo(0.5, 9);
    expect(b.max.z - b.min.z).toBeCloseTo(0.5, 6);
    expect(b.max.y - b.min.y).toBeCloseTo(0.2, 6); // uniform scale
    expect(c.height).toBeCloseTo(0.2, 6);
    // grip 30 % from the rear: 0.15 m of stock behind the hand, 0.35 m in front
    expect(b.max.z).toBeCloseTo(0.15, 6);
    expect(b.min.z).toBeCloseTo(-0.35, 6);
    // grip 0.1 length above the centre line: the centre sits 5 cm below the hand
    expect((b.max.y + b.min.y) / 2).toBeCloseTo(-0.05, 6);
    expect((b.max.x + b.min.x) / 2).toBeCloseTo(0, 6);
    expect(c.points.muzzle.toArray().map((v) => +v.toFixed(6))).toEqual([0, 0, -0.35]);
    expect(c.points.fore!.toArray().map((v) => +v.toFixed(6))).toEqual([0, -0.05, -0.15]);
    expect(c.points.mag!.toArray().map((v) => +v.toFixed(6))).toEqual([0, -0.125, -0.05]);
    // normals follow the rotation; the source is untouched
    expect(c.geo.getAttribute('normal')).toBeTruthy();
    expect(src.getAttribute('position').getX(0)).toBe(x0);
  });

  it("fit 'height' sizes a bow by its height (limbs along the model's up axis)", () => {
    // bow lying flat: limbs along X (0.7), arrow along −Z (1.0)
    const src = new THREE.BoxGeometry(0.7, 0.1, 1.0);
    const c = calibrateWeaponGeometry(src, { fwd: '-z', up: '+x', size: 1.3, fit: 'height', grip: [0.5, 0], fore: null, mag: null, muzzle: [0.55, 0] });
    const b = c.geo.boundingBox!;
    expect(b.max.y - b.min.y).toBeCloseTo(1.3, 6);
    expect(b.max.z - b.min.z).toBeCloseTo(1.3 / 0.7, 6);
    expect(c.length).toBeCloseTo(1.3 / 0.7, 6);
  });

  it('moves an over-long nocked arrow back: everything ahead of `from` shifts along the barrel, the rest stays', () => {
    // bow lying flat: limbs along X (0.7), arrow along −Z (1.0); a thin "arrow" box pokes 0.5 past the bow's front
    const bow = new THREE.BoxGeometry(0.7, 0.1, 0.5).translate(0, 0, 0.25).toNonIndexed();
    const arrow = new THREE.BoxGeometry(0.02, 0.02, 0.5).translate(0, 0, -0.25).toNonIndexed();
    const src = new THREE.BufferGeometry();
    src.setAttribute('position', new THREE.Float32BufferAttribute([...bow.getAttribute('position').array, ...arrow.getAttribute('position').array], 3));
    const base = { fwd: '-z', up: '+x', size: 1.3, fit: 'height', grip: [0.4, 0], fore: [0.1, 0], mag: null, muzzle: [0.6, 0] } as const satisfies WeaponGlbCal;
    const plain = calibrateWeaponGeometry(src, base);
    const trimmed = calibrateWeaponGeometry(src, { ...base, arrow: { from: 0.55, shift: 0.3 } });
    const pb = plain.geo.boundingBox!;
    const tb = trimmed.geo.boundingBox!;
    const L = plain.length;
    // the tip comes back by shift × length; the rear (string / nock) stays; the points keep their places
    expect(tb.min.z - pb.min.z).toBeCloseTo(0.3 * L, 5);
    expect(tb.max.z).toBeCloseTo(pb.max.z, 6);
    expect(trimmed.length).toBeCloseTo(L, 9);
    expect(trimmed.points.fore!.distanceTo(plain.points.fore!)).toBeLessThan(1e-9);
    expect(trimmed.points.muzzle.distanceTo(plain.points.muzzle)).toBeLessThan(1e-9);
  });

  it('merges every primitive into one indexed geometry, keeping normals only when all have them', () => {
    const { scene } = gunScene();
    const m = mergeSceneGeometry(scene)!;
    expect(m.geo.getAttribute('position').count).toBe(48);
    expect(m.geo.getIndex()!.count).toBe(72);
    expect(m.geo.getAttribute('normal')).toBeTruthy();
    expect(m.map).toBeTruthy();
    (scene.children[1] as THREE.Mesh).geometry.deleteAttribute('normal');
    expect(mergeSceneGeometry(scene)!.geo.getAttribute('normal')).toBeUndefined();
    expect(mergeSceneGeometry(new THREE.Group())).toBeNull();
  });
});

// ── the table ────────────────────────────────────────────────────────────────

/** Class sizes of the wave-2 spec (m): length, or height for bows. */
const CLASS_SIZE: Record<string, number> = { pistol: 0.25, smg: 0.5, rifle: 0.9, dmr: 0.9, sniper: 1.2, shotgun: 0.9, lmg: 1.1, launcher: 1.0, bow: 1.3, flamer: 0.8, crossbow: 0.8 };

/** Bounds of a shipped file's (single) primitive in model space. */
function fileBounds(path: string): THREE.Vector3 {
  const b = readFileSync(path);
  const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()) as {
    nodes: { mesh?: number; scale?: number[] }[];
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: { min: number[]; max: number[]; normalized?: boolean }[];
  };
  const size = new THREE.Vector3();
  for (const n of j.nodes) {
    if (n.mesh === undefined) continue;
    for (const p of j.meshes[n.mesh].primitives) {
      const a = j.accessors[p.attributes.POSITION];
      const s = (n.scale?.[0] ?? 1) / (a.normalized ? 32767 : 1);
      size.max(new THREE.Vector3((a.max[0] - a.min[0]) * s, (a.max[1] - a.min[1]) * s, (a.max[2] - a.min[2]) * s));
    }
  }
  return size;
}

describe('WEAPON_GLB_CAL', () => {
  const artIds = WEAPONS.filter((w) => w.lootable || HEROES.some((h) => h.signatureWeapon === w.id)).map((w) => w.id);

  it('calibrates every hero / loot weapon (the 27 shipped GLBs) with points in order', () => {
    expect(artIds.length).toBe(27);
    expect(Object.keys(WEAPON_GLB_CAL).sort()).toEqual([...artIds].sort());
    for (const [id, c] of Object.entries(WEAPON_GLB_CAL)) {
      expect(c.fwd[1], id).not.toBe(c.up[1]);
      for (const p of [c.grip, c.muzzle, c.fore, c.mag]) {
        if (!p) continue;
        expect(p[0], id).toBeGreaterThanOrEqual(0);
        expect(p[0], id).toBeLessThanOrEqual(1);
        expect(Math.abs(p[1]), id).toBeLessThan(0.35);
      }
      // shots leave in front of the hand
      expect(c.muzzle[0], id).toBeGreaterThan(c.grip[0]);
      const hold = buildProceduralWeapon(id).info.hold;
      // two-handed guns put the left hand in front of the right (a pistol's support hand cups the grip)
      if (c.fore && hold !== 'bow' && hold !== 'pistol') expect(c.fore[0], id).toBeGreaterThan(c.grip[0]);
      if (hold === 'bow') expect(c.fit, id).toBe('height');
      // bows: the fore point is the nock, where the drawing hand holds the string, well behind the grip
      if (hold === 'bow') expect(c.grip[0] - c.fore![0], id).toBeGreaterThan(0.2);
    }
  });

  it('sizes follow the weapon classes (staves ~1.6 m; blades / bayonets / dragon heads may add up to ~30 %)', () => {
    for (const [id, c] of Object.entries(WEAPON_GLB_CAL)) {
      const def = WEAPON_BY_ID[id];
      const target = def.model.style === 'spear' && id === 'taiping' ? 1.6 : CLASS_SIZE[def.class];
      expect(target, id).toBeGreaterThan(0);
      if (def.class === 'bow') {
        expect(c.size, id).toBeGreaterThan(1.0);
        expect(c.size, id).toBeLessThanOrEqual(1.3);
      } else {
        expect(c.size / target, id).toBeGreaterThanOrEqual(0.9);
        expect(c.size / target, id).toBeLessThan(1.45);
      }
    }
  });

  it('matches the shipped files: the barrel runs along the longest model axis (bows: the limbs or the arrow)', () => {
    for (const [id, c] of Object.entries(WEAPON_GLB_CAL)) {
      const file = resolve(ROOT, 'public', weaponModelPath(id));
      expect(existsSync(file), file).toBe(true);
      const size = fileBounds(file);
      const along = (a: Axis): number => size.getComponent('xyz'.indexOf(a[1]));
      const longest = Math.max(size.x, size.y, size.z);
      if (c.fit === 'height') expect(Math.max(along(c.fwd), along(c.up)), id).toBeCloseTo(longest, 3);
      else expect(along(c.fwd), id).toBeCloseTo(longest, 3);
      if (c.fit === 'height') {
        // a bow's nocked arrow ends a little past the grip (a drawn arrow), not ~1 m out (烈弓's model arrow is moved back)
        const length = (c.size * along(c.fwd)) / along(c.up);
        expect((1 - c.grip[0] - (c.arrow?.shift ?? 0)) * length, id).toBeLessThan(0.5);
      }
    }
  });

  it('a match preloads the heroes’ signature weapons and every lootable one', () => {
    const ids = matchWeaponIds(['guanyu', 'nobody']);
    expect(ids).toContain('qinglong');
    for (const w of WEAPONS.filter((x) => x.lootable)) if (WEAPON_GLB_CAL[w.id]) expect(ids).toContain(w.id);
    expect(ids.some((id) => id.startsWith('troop_'))).toBe(false);
  });
});

// ── art pipeline ─────────────────────────────────────────────────────────────

describe('weapon art', () => {
  it('prepares one mesh with the procedural hold / IK semantics, a textured material and its fog-clamped held variant', () => {
    const { scene, map, srcMat } = gunScene();
    let srcDisposed = false;
    srcMat.addEventListener('dispose', () => (srcDisposed = true));
    const art = prepareWeaponArt('carbine', WEAPON_GLB_CAL.carbine, scene)!;
    expect(srcDisposed).toBe(true); // the loader's material is replaced (the texture lives on)
    expect(art.material.map).toBe(map);
    expect(art.held.map).toBe(map);
    expect(art.held.defines?.FOG_MAX).toBe(CHARACTER_FOG_MAX.toFixed(2));
    expect(art.material.defines?.FOG_MAX).toBeUndefined();
    const proc = buildProceduralWeapon('carbine').info;
    expect(art.info.hold).toBe(proc.hold);
    expect(art.info.fxClass).toBe(proc.fxClass);
    expect(art.info.length).toBeCloseTo(WEAPON_GLB_CAL.carbine.size, 6);
    // muzzle ahead (−Z), foregrip ahead of the hand, magazine below
    expect(art.info.muzzle.z).toBeLessThan(-0.4);
    expect(art.info.fore!.z).toBeLessThan(-0.1);
    expect(art.info.mag!.y).toBeLessThan(0);
  });

  it('sizes the texture for the quality tier (phones: 256², others: as shipped)', () => {
    // a minimal canvas for capTexture (node has no DOM)
    const g = globalThis as { document?: unknown };
    const hadDoc = 'document' in g;
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => undefined, imageSmoothingQuality: 'low' }) }) };
    try {
      const shipped = (): { scene: THREE.Group; map: THREE.Texture } => {
        const { scene, map } = gunScene();
        map.image = { width: 512, height: 512, data: new Uint8Array(4) } as unknown as typeof map.image;
        return { scene, map };
      };
      setWorldArtQuality('low');
      const low = shipped();
      let disposed = false;
      low.map.addEventListener('dispose', () => (disposed = true));
      const a = prepareWeaponArt('carbine', WEAPON_GLB_CAL.carbine, low.scene)!;
      expect(a.material.map).not.toBe(low.map);
      expect((a.material.map!.image as { width: number }).width).toBe(QUALITY_PRESETS.low.weaponTexture);
      expect(a.held.map).toBe(a.material.map);
      expect(a.material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
      expect(disposed).toBe(true); // the full-size copy is released
      setWorldArtQuality('high');
      const high = shipped();
      expect(prepareWeaponArt('carbine', WEAPON_GLB_CAL.carbine, high.scene)!.material.map).toBe(high.map);
      expect(QUALITY_PRESETS.low.charTexture).toBe(512);
      expect(QUALITY_PRESETS.high.charTexture).toBe(1024);
    } finally {
      setWorldArtQuality('medium');
      if (!hadDoc) delete g.document;
    }
  });

  it('buildWeapon returns the art once registered (procedural before and after), buildProceduralWeapon never does', () => {
    const before = buildWeapon('carbine');
    expect(before.mesh.userData.weaponArt).toBeUndefined();
    expect(heldMaterialOf(before)).toBe(heldWeaponMaterial());
    const epoch = weaponArtEpoch();
    const art = prepareWeaponArt('carbine', WEAPON_GLB_CAL.carbine, gunScene().scene)!;
    setWeaponArtForTests(art);
    expect(weaponArtEpoch()).toBeGreaterThan(epoch);
    expect(hasWeaponArt('carbine')).toBe(true);
    const a = buildWeapon('carbine');
    const b = buildWeapon('carbine');
    expect(a.mesh.userData.weaponArt).toBe(true);
    expect(a.mesh).not.toBe(b.mesh);
    expect(a.mesh.geometry).toBe(b.mesh.geometry); // shared, one draw per weapon
    expect(a.mesh.material).toBe(art.material);
    expect(heldMaterialOf(a)).toBe(art.held);
    expect(a.lod?.near).toBe(art.geo);
    expect(createWeaponModel('carbine').userData.weaponArt).toBe(true);
    expect(buildProceduralWeapon('carbine').mesh.userData.weaponArt).toBeUndefined();
    expect(buildWeapon('smg').mesh.userData.weaponArt).toBeUndefined();
    resetWeaponArtForTests();
    expect(buildWeapon('carbine').mesh.userData.weaponArt).toBeUndefined();
  });

  it('releaseModelCaches frees the art (geometry, texture, materials) and falls back to procedural', () => {
    const { scene, map } = gunScene();
    const art = prepareWeaponArt('carbine', WEAPON_GLB_CAL.carbine, scene)!;
    setWeaponArtForTests(art);
    let n = 0;
    for (const r of [art.geo, map, art.material, art.held] as THREE.EventDispatcher<{ dispose: object }>[]) r.addEventListener('dispose', () => void n++);
    releaseModelCaches();
    expect(n).toBe(4);
    expect(hasWeaponArt('carbine')).toBe(false);
    expect(weaponArtSync('carbine')).toBeUndefined();
    expect(buildWeapon('carbine').mesh.userData.weaponArt).toBeUndefined();
  });

  it('loads a listed file through the shared GLTFLoader, calibrates and registers it; unlisted / uncalibrated ids stay procedural', async () => {
    setAssetListForTests([]);
    expect(weaponArtListed('carbine')).toBe(false);
    expect(await loadWeaponArt('foo')).toBeNull();
    registerModelGlb(weaponModelPath('carbine'), boxGlbUrl(0.1, 0.35, 1.0));
    expect(weaponArtListed('carbine')).toBe(true);
    const art = await loadWeaponArt('carbine');
    expect(art).not.toBeNull();
    expect(loadWeaponArt('carbine')).toBe(loadWeaponArt('carbine')); // once per id
    expect(hasWeaponArt('carbine')).toBe(true);
    art!.geo.computeBoundingBox();
    const b = art!.geo.boundingBox!;
    expect(b.max.z - b.min.z).toBeCloseTo(WEAPON_GLB_CAL.carbine.size, 4);
  });

  it('a pickup shows the art, and swaps it in when it arrives late', async () => {
    const e = { id: 7, kind: 'loot', sub: 'carbine', x: 0, y: 0, z: 0 } as unknown as ViewEntity;
    const mesh = (v: LootView): THREE.Mesh => v.root.children[0].children[0] as THREE.Mesh;
    setAssetListForTests([]);
    await assetList();
    // not shipped: procedural, nothing to wait for
    const plainEnt = { ...e, sub: 'smg' } as ViewEntity;
    const plain = new LootView(plainEnt);
    expect(mesh(plain).userData.weaponArt).toBeUndefined();
    // shipped, still loading: procedural now, the art right after it lands
    registerModelGlb(weaponModelPath('carbine'), boxGlbUrl(0.1, 0.35, 1.0));
    const late = new LootView(e);
    expect(mesh(late).userData.weaponArt).toBeUndefined();
    await loadWeaponArt('carbine');
    late.update(e, ctx());
    expect(mesh(late).userData.weaponArt).toBe(true);
    expect(late.root.children[0].children.length).toBe(1);
    // centred on the spinning holder
    const c = new THREE.Box3().setFromObject(late.root.children[0]).getCenter(new THREE.Vector3());
    expect(Math.hypot(c.x, c.z)).toBeLessThan(0.02);
    expect(mesh(new LootView(e)).userData.weaponArt).toBe(true);
    plain.update(plainEnt, ctx()); // not shipped: keeps its procedural weapon
    expect(mesh(plain).userData.weaponArt).toBeUndefined();
  });

  it('procedural bodies keep the merged procedural weapon (one draw) even with art loaded', () => {
    setWeaponArtForTests(prepareWeaponArt('qinglong', WEAPON_GLB_CAL.qinglong, gunScene().scene)!);
    const rig = new CharacterRig(heroSpec('guanyu'));
    rig.setWeapon('qinglong');
    rig.update(1 / 30, 0, { speed: 0, moveX: 0, moveZ: 0, pitch: 0, flags: 0 });
    expect(rig.mesh.geometry.getAttribute('color')).toBeTruthy();
    let meshes = 0;
    rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) meshes++;
    });
    expect(meshes).toBe(1);
    rig.dispose();
  });
});

// ── rigid (unrigged) character override ─────────────────────────────────────

describe('rigid GLB override (models/glbRigid.ts)', () => {
  it('an unrigged hero file replaces the body as a rigid model normalised to 1.8 m, feet on the ground, holding the weapon', async () => {
    setAssetListForTests([]);
    const path = heroModelPath('guanyu');
    registerModelGlb(path, boxGlbUrl(0.5, 3.6, 0.5, 1, false));
    expect(await loadCharTemplate(path)).toBeNull(); // not an auto-rig…
    expect(rigidTemplateSync(path)?.height).toBeCloseTo(3.6, 5); // …but a rigid model
    const rig = new CharacterRig(heroSpec('guanyu'));
    rig.setWeapon('qinglong');
    rig.useGlb(path);
    expect(rig.usesGlb).toBe(true);
    expect(rig.mesh.visible).toBe(false);
    const obj = rig.glbObject!;
    expect(obj.scale.x).toBeCloseTo(0.5, 6); // 3.6 m box → 1.8 m hero
    expect(obj.children[0].position.y).toBeCloseTo(-1, 6); // feet moved onto the ground
    for (let i = 0; i < 10; i++) rig.update(1 / 30, i / 30, { speed: 0, moveX: 0, moveZ: 0, pitch: 0.2, flags: 0 });
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    expect(box.min.y).toBeCloseTo(0, 2);
    expect(box.max.y).toBeCloseTo(1.8, 2);
    expect(rig.headHeight()).toBeCloseTo(1.8, 6);
    // the weapon rides the (hidden) procedural rig's weapon bone and shoots from its muzzle
    const muzzle = new THREE.Vector3();
    expect(rig.muzzleWorld(muzzle)).toBe(true);
    expect(muzzle.z).toBeLessThan(-0.3);
    expect(muzzle.y).toBeGreaterThan(1);
    let weapons = 0;
    rig.root.traverse((o) => {
      if (o.name === 'weapon_qinglong') weapons++;
    });
    expect(weapons).toBe(1);
    rig.setStealth(true);
    rig.setStealth(false);
    rig.useGlb(null);
    expect(rig.usesGlb).toBe(false);
    expect(rig.mesh.visible).toBe(true);
    rig.dispose();
  });
});
