// AI-art weapons (public/assets/models/weapons/<id>.glb, listed by
// src/game/assets.ts): static textured meshes (one primitive, one 512²
// texture), normalised so the longest axis is 1.0, in whatever orientation the
// image-to-3D reconstruction produced. A per-weapon calibration table
// (WEAPON_GLB_CAL, measured on the dev bench: render-dev.html?mode=models&set=weapons)
// maps each file into the procedural weapon frame (models/weapons.ts):
//   origin = the right-hand wrist target (just behind / above the pistol grip),
//   barrel along −Z, up = +Y, metres —
// so holds, the left-hand IK, reload hand, muzzle flash / tracers and the
// ability VFX work unchanged. The calibrated geometry is baked ONCE per file
// (primitives merged into one indexed mesh = one draw call) and shared by every
// instance with one textured material (+ its held variant with the character
// fog clamp). Loaded weapons register with models/weapons.ts, whose
// buildWeapon() then returns them (synchronously); until then — and in the
// single-file build, which ships no side files — the procedural weapon shows.
// A weapon that arrives late is swapped in by the views that hold one
// (weaponArtEpoch()).
import * as THREE from 'three';
import type { WeaponModel, WeaponModelInfo } from './weapons';
import { buildProceduralWeapon, cloneKeepingDefines, hasWeaponArt, registerWeaponArt } from './weapons';
import { buildLod, loadGltf, modelUrl, modelUrlSync } from './glb';
import { assetList, assetListSync } from '../../game/assets';
import { CHARACTER_FOG_MAX } from '../core/materials';
import { useSkyArtFog } from '../core/skyArtFog';
import { HERO_BY_ID, LOOTABLE_WEAPON_IDS } from '../../data';

export const weaponModelPath = (weaponId: string): string => `assets/models/weapons/${weaponId}.glb`;

export type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/**
 * A point on the weapon in calibrated units: u along the barrel (0 = the rear
 * end of the model, 1 = its front end), v up (fraction of the length, from the
 * model's vertical centre), optional w to the weapon's right (same unit).
 */
export type WeaponPoint = readonly [u: number, v: number, w?: number];

export interface WeaponGlbCal {
  /** model axis the barrel (arrow, staff head) points along */
  fwd: Axis;
  /** model axis that is up when the weapon is held level */
  up: Axis;
  /** extra roll about the barrel after the axis remap (rad; + turns the top toward the weapon's right, +X) */
  roll?: number;
  /** target size (m): the length along the barrel, or the height for fit 'height' (bows) */
  size: number;
  fit?: 'length' | 'height';
  /** the point that sits at the hand's wrist target (the weapon frame origin) */
  grip: WeaponPoint;
  /** left-hand target (foregrip / handguard / staff); null = one-handed */
  fore: WeaponPoint | null;
  /** magazine (reload hand target); null = none */
  mag: WeaponPoint | null;
  /** where shots leave the weapon (bore end — not the tip of a bayonet or blade) */
  muzzle: WeaponPoint;
}

// Target sizes follow the weapon classes (wave-2 spec): pistol ~0.25 m, smg
// ~0.5, rifle / dmr ~0.9, sniper ~1.2, shotgun ~0.9, lmg ~1.1, launcher ~1.0,
// flamer ~0.8, crossbow ~0.8, bow ~1.3 tall, staff ~1.6 — a little longer where
// the model carries a blade, bayonet or dragon head past the muzzle, so the gun
// itself keeps its class size.
export const WEAPON_GLB_CAL: Readonly<Record<string, WeaponGlbCal>> = {
  pistol: { fwd: '-z', up: '+y', size: 0.25, grip: [0.24, 0.12], fore: [0.2, -0.05, -0.1], mag: [0.16, -0.27], muzzle: [1, 0.21] },
  carbine: { fwd: '+z', up: '+y', size: 0.9, grip: [0.36, 0.02], fore: [0.62, 0.0], mag: [0.47, -0.12], muzzle: [1, 0.04] },
  smg: { fwd: '+x', up: '+y', size: 0.5, grip: [0.4, 0.04], fore: [0.62, 0.02], mag: [0.6, -0.12], muzzle: [1, 0.11] },
  zhuge: { fwd: '+z', up: '+y', size: 0.6, grip: [0.2, 0.05], fore: [0.55, 0.0], mag: [0.45, 0.2], muzzle: [1, 0.07] },
  qinggang: { fwd: '+z', up: '+y', size: 1.1, grip: [0.2, 0.0], fore: [0.45, 0.0], mag: [0.3, -0.07], muzzle: [0.62, 0.02] },
  cixiong: { fwd: '+z', up: '+y', size: 0.3, grip: [0.2, 0.08], fore: null, mag: [0.15, -0.1], muzzle: [0.95, 0.12] },
  hanbing: { fwd: '+z', up: '+y', size: 1.0, grip: [0.3, 0.0], fore: [0.55, 0.0], mag: [0.38, -0.08], muzzle: [0.9, 0.04] },
  guding: { fwd: '+z', up: '+y', size: 0.95, grip: [0.2, 0.0], fore: [0.5, 0.0], mag: [0.35, -0.05], muzzle: [0.87, 0.085] },
  qinglong: { fwd: '+z', up: '+y', size: 1.05, grip: [0.3, 0.0], fore: [0.52, 0.0], mag: [0.4, -0.08], muzzle: [0.86, 0.07] },
  zhangba: { fwd: '+z', up: '+y', size: 1.05, grip: [0.2, 0.0], fore: [0.45, 0.0], mag: [0.3, -0.03], muzzle: [0.8, 0.075] },
  guanshi: { fwd: '-z', up: '+y', size: 0.95, grip: [0.15, 0.0], fore: [0.5, 0.0], mag: [0.3, -0.05], muzzle: [0.88, 0.06] },
  zhuque: { fwd: '+z', up: '+y', size: 0.8, grip: [0.35, 0.0], fore: [0.6, 0.0], mag: [0.2, 0.0], muzzle: [1, 0.12] },
  fangtian: { fwd: '+z', up: '+y', roll: Math.PI / 2, size: 1.4, grip: [0.4, 0.0], fore: [0.55, 0.0], mag: [0.5, 0.0], muzzle: [0.9, 0.0] },
  qilin: { fwd: '+z', up: '+y', size: 1.2, grip: [0.22, 0.0], fore: [0.45, 0.0], mag: [0.3, -0.05], muzzle: [0.95, 0.02] },
  longdan: { fwd: '+z', up: '+y', size: 1.0, grip: [0.09, 0.04], fore: [0.45, 0.02], mag: [0.25, -0.04], muzzle: [0.62, 0.06] },
  liegong: { fwd: '-z', up: '+x', size: 1.3, fit: 'height', grip: [0.47, 0.0], fore: [0.3, 0.0], mag: null, muzzle: [0.55, 0.0] },
  jinfan: { fwd: '+z', up: '+y', size: 0.5, grip: [0.3, 0.0], fore: [0.6, 0.0], mag: [0.4, -0.1], muzzle: [1, 0.1] },
  xiaoji: { fwd: '+z', up: '+x', size: 1.12, fit: 'height', grip: [0.61, 0.0], fore: [0.3, 0.0], mag: null, muzzle: [0.72, 0.0] },
  taiping: { fwd: '-x', up: '+y', size: 1.6, grip: [0.4, 0.0], fore: [0.62, 0.0], mag: null, muzzle: [0.98, 0.0] },
  wushuang: { fwd: '+z', up: '+y', size: 1.0, grip: [0.22, 0.02], fore: [0.58, 0.02], mag: [0.35, -0.08], muzzle: [0.98, 0.09] },
  huben: { fwd: '+x', up: '+y', size: 1.1, grip: [0.25, 0.0], fore: [0.63, 0.05], mag: [0.4, -0.1], muzzle: [1, 0.13] },
  qingnang: { fwd: '-z', up: '+y', size: 0.3, grip: [0.2, 0.05], fore: null, mag: [0.15, -0.15], muzzle: [1, 0.1] },
  yitian: { fwd: '-x', up: '+y', size: 1.15, grip: [0.15, 0.0], fore: [0.35, 0.0], mag: [0.25, -0.05], muzzle: [0.55, 0.02] },
  hutou: { fwd: '+z', up: '+y', size: 1.15, grip: [0.2, 0.03], fore: [0.45, 0.0], mag: [0.3, -0.05], muzzle: [0.7, 0.03] },
  jiguan: { fwd: '-x', up: '+y', size: 0.8, grip: [0.25, -0.035], fore: [0.55, 0.0], mag: [0.5, 0.1], muzzle: [0.97, 0.02] },
  manwang: { fwd: '+z', up: '+y', size: 0.95, grip: [0.3, 0.0], fore: [0.55, 0.0], mag: [0.4, -0.05], muzzle: [0.98, 0.07] },
  baiyi: { fwd: '+z', up: '+y', size: 1.1, grip: [0.25, 0.0], fore: [0.5, 0.0], mag: [0.35, -0.06], muzzle: [1, 0.07] },
};

const AXES: Record<Axis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

/** Rotation taking the model's `fwd` axis to −Z and its `up` axis to +Y, then rolled about the barrel. */
export function canonicalRotation(fwd: Axis, up: Axis, roll = 0): THREE.Matrix4 {
  const f = AXES[fwd];
  const u = AXES[up];
  if (Math.abs(f.dot(u)) > 1e-6) throw new Error(`weapon calibration: fwd ${fwd} and up ${up} are not perpendicular`);
  // model-space vectors that become the weapon's +X, +Y, +Z
  const zm = f.clone().negate();
  const xm = new THREE.Vector3().crossVectors(u, zm);
  const toModel = new THREE.Matrix4().makeBasis(xm, u, zm);
  const m = toModel.transpose(); // orthonormal: inverse = transpose
  if (roll) m.premultiply(new THREE.Matrix4().makeRotationZ(-roll));
  return m;
}

export interface CalibratedWeapon {
  /** geometry in the weapon frame (metres), indexed, position + normal (the file's, else smooth) + uv */
  geo: THREE.BufferGeometry;
  /** where the calibration points landed (weapon frame, m) */
  points: { muzzle: THREE.Vector3; fore: THREE.Vector3 | null; mag: THREE.Vector3 | null };
  /** length along the barrel (m) */
  length: number;
  /** height (m) */
  height: number;
}

/**
 * Bake a calibration into a (merged) model geometry: rotate into the weapon
 * frame, scale to the target size, put the grip point at the origin. Pure
 * (unit-tested); the input geometry is left untouched.
 */
export function calibrateWeaponGeometry(src: THREE.BufferGeometry, cal: WeaponGlbCal): CalibratedWeapon {
  const pos = src.getAttribute('position');
  const R = canonicalRotation(cal.fwd, cal.up, cal.roll);
  const n = pos.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(R);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
    box.expandByPoint(v);
  }
  // calibrated units: 1 = the length along the barrel
  const E = Math.max(1e-6, box.max.z - box.min.z);
  const H = Math.max(1e-6, box.max.y - box.min.y);
  const yc = (box.min.y + box.max.y) / 2;
  const xc = (box.min.x + box.max.x) / 2;
  const length = cal.fit === 'height' ? (cal.size * E) / H : cal.size;
  const s = length / E;
  // model point (rotated frame) of a calibration point
  const at = (p: WeaponPoint): THREE.Vector3 => new THREE.Vector3(xc + (p[2] ?? 0) * E, yc + p[1] * E, box.max.z - p[0] * E);
  const g = at(cal.grip);
  for (let i = 0; i < n; i++) {
    out[i * 3] = (out[i * 3] - g.x) * s;
    out[i * 3 + 1] = (out[i * 3 + 1] - g.y) * s;
    out[i * 3 + 2] = (out[i * 3 + 2] - g.z) * s;
  }
  const local = (p: WeaponPoint): THREE.Vector3 => at(p).sub(g).multiplyScalar(s);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  const uv = src.getAttribute('uv');
  if (uv) geo.setAttribute('uv', uv);
  const index = src.getIndex();
  if (index) geo.setIndex(index);
  const nrm = src.getAttribute('normal');
  if (nrm) {
    // the file's own normals (rotated; the scale is uniform)
    const nr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(nrm, i).applyMatrix4(R).normalize();
      nr[i * 3] = v.x;
      nr[i * 3 + 1] = v.y;
      nr[i * 3 + 2] = v.z;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
  } else geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return {
    geo,
    points: { muzzle: local(cal.muzzle), fore: cal.fore ? local(cal.fore) : null, mag: cal.mag ? local(cal.mag) : null },
    length,
    height: H * s,
  };
}

/**
 * WeaponModelInfo of a calibrated weapon. The hold style and fx class are the
 * procedural weapon's (same id): the art never changes how a weapon is held,
 * so a body can swap between the two looks mid-match.
 */
export function calibratedInfo(id: string, c: CalibratedWeapon): WeaponModelInfo {
  const proc = buildProceduralWeapon(id).info;
  const hold = proc.hold;
  return {
    hold,
    // bows: the right hand draws the string behind the grip (same as the procedural bow)
    fore: hold === 'bow' ? proc.fore : c.points.fore,
    mag: c.points.mag,
    muzzle: c.points.muzzle,
    length: c.length,
    fxClass: proc.fxClass,
  };
}

/** Merge every mesh of a loaded scene into one geometry (world transforms baked; position + uv (+ normal when every part has one), float). */
export function mergeSceneGeometry(scene: THREE.Object3D): { geo: THREE.BufferGeometry; map: THREE.Texture | null } | null {
  scene.updateMatrixWorld(true);
  const parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
  let map: THREE.Texture | null = null;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    parts.push({ geo: mesh.geometry, m: mesh.matrixWorld });
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of mats) if (!map && (mt as THREE.MeshStandardMaterial).map) map = (mt as THREE.MeshStandardMaterial).map;
  });
  if (!parts.length) return null;
  let count = 0;
  let icount = 0;
  for (const p of parts) {
    count += p.geo.getAttribute('position').count;
    icount += p.geo.getIndex()?.count ?? p.geo.getAttribute('position').count;
  }
  const withNormals = parts.every((p) => !!p.geo.getAttribute('normal'));
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const nrm = withNormals ? new Float32Array(count * 3) : null;
  const nm = new THREE.Matrix3();
  const idx = count < 65536 ? new Uint16Array(icount) : new Uint32Array(icount);
  const v = new THREE.Vector3();
  let o = 0;
  let io = 0;
  for (const p of parts) {
    const P = p.geo.getAttribute('position');
    const U = p.geo.getAttribute('uv');
    const N = p.geo.getAttribute('normal');
    nm.getNormalMatrix(p.m);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(p.m);
      pos[(o + i) * 3] = v.x;
      pos[(o + i) * 3 + 1] = v.y;
      pos[(o + i) * 3 + 2] = v.z;
      if (nrm && N) {
        v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        nrm[(o + i) * 3] = v.x;
        nrm[(o + i) * 3 + 1] = v.y;
        nrm[(o + i) * 3 + 2] = v.z;
      }
      if (U) {
        uv[(o + i) * 2] = U.getX(i);
        uv[(o + i) * 2 + 1] = U.getY(i);
      }
    }
    const I = p.geo.getIndex();
    const flip = p.m.determinant() < 0;
    const tri = I ? I.count : P.count;
    for (let t = 0; t < tri; t += 3) {
      const a = I ? I.getX(t) : t;
      const b = I ? I.getX(t + 1) : t + 1;
      const c = I ? I.getX(t + 2) : t + 2;
      idx[io++] = o + a;
      idx[io++] = o + (flip ? c : b);
      idx[io++] = o + (flip ? b : c);
    }
    o += P.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (nrm) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return { geo, map };
}

// ── templates ────────────────────────────────────────────────────────────────

export interface WeaponArt {
  readonly id: string;
  readonly geo: THREE.BufferGeometry;
  /** far LOD (models/glb.ts buildLod: simplified index, shared vertices) for far GLB bodies; null when it cannot be built */
  lod: THREE.BufferGeometry | null;
  /** pickups / racks / previews */
  readonly material: THREE.MeshStandardMaterial;
  /** in a GLB body's hand: + the character fog clamp and the painted-sky fog colour */
  readonly held: THREE.MeshStandardMaterial;
  readonly info: WeaponModelInfo;
}

const loading = new Map<string, Promise<WeaponArt | null>>();
const loaded = new Map<string, WeaponArt>();
/** ids whose load settled without art (not shipped, broken): nothing to wait for */
const absent = new Set<string>();
let warnedOnce = false;

/** Triangle target of a weapon's far LOD (a far hero's gun is a few pixels; UV seams usually stop it earlier). */
export const WEAPON_LOD_RATIO = 0.3;

/** Material look of the AI-art weapons (the textures carry most of the shading). */
export const WEAPON_ROUGHNESS = 0.55;
export const WEAPON_METALNESS = 0.25;

/** A loaded file's scene → the weapon's art (calibrated, merged, materials made; the scene's own resources freed). */
export function prepareWeaponArt(id: string, cal: WeaponGlbCal, scene: THREE.Object3D): WeaponArt | null {
  const merged = mergeSceneGeometry(scene);
  if (!merged) return null;
  const c = calibrateWeaponGeometry(merged.geo, cal);
  merged.geo.dispose();
  const map = merged.map;
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map, roughness: WEAPON_ROUGHNESS, metalness: WEAPON_METALNESS });
  material.name = 'weaponArt';
  const held = cloneKeepingDefines(material);
  held.name = 'weaponArtHeld';
  held.defines = { ...held.defines, FOG_MAX: CHARACTER_FOG_MAX.toFixed(2) };
  useSkyArtFog(held, 'weaponArtHeld');
  // the loader's own materials are dropped (the texture lives on in ours)
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mt of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mt.dispose();
    mesh.geometry.dispose();
  });
  c.geo.name = `weaponArt_${id}`;
  return { id, geo: c.geo, lod: null, material, held, info: calibratedInfo(id, c) };
}

/** A new mesh of a loaded weapon (shared geometry / material). */
export function weaponArtModel(art: WeaponArt): WeaponModel {
  const mesh = new THREE.Mesh(art.geo, art.material);
  mesh.castShadow = true;
  mesh.name = `weapon_${art.id}`;
  mesh.userData.weaponInfo = art.info;
  mesh.userData.weaponArt = true;
  return { mesh, info: art.info, heldMaterial: art.held, lod: { near: art.geo, far: art.lod } };
}

/** True when this deploy ships (or a test registered) a calibrated model for the weapon. */
export function weaponArtListed(id: string): boolean {
  return !!WEAPON_GLB_CAL[id] && modelUrlSync(weaponModelPath(id)) !== null;
}

/**
 * Load (once) and register a weapon's art; resolves null when the deploy has
 * none for it, it has no calibration, or it failed to load (procedural stays).
 * Never rejects. Cheap to call again (views call it when they equip a weapon).
 */
export function loadWeaponArt(id: string): Promise<WeaponArt | null> {
  let p = loading.get(id);
  if (!p) {
    p = (async (): Promise<WeaponArt | null> => {
      const cal = WEAPON_GLB_CAL[id];
      if (!cal) return null;
      const url = await modelUrl(weaponModelPath(id));
      if (!url) return null;
      try {
        const gltf = await loadGltf(url);
        const art = prepareWeaponArt(id, cal, gltf.scene);
        if (art) art.lod = await buildLod(art.geo, WEAPON_LOD_RATIO).catch(() => null);
        return art;
      } catch (err) {
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn('[render] weapon model could not be loaded, keeping the procedural weapon:', url, err);
        }
        return null;
      }
    })();
    loading.set(id, p);
    const mine = p;
    void p.then((art) => {
      if (loading.get(id) !== mine) return;
      if (!art) {
        absent.add(id);
        return;
      }
      loaded.set(id, art);
      registerWeaponArt(id, () => weaponArtModel(art));
    });
  }
  return p;
}

/**
 * A view is about to show this weapon: false when its art is already
 * registered (buildWeapon returns it) or can never come (no calibration, not
 * shipped, failed); else its load is started (once) and true = show the
 * procedural stand-in and swap when weaponArtEpoch() moves. Safe before the
 * asset listing has loaded (the load waits for it).
 */
export function requestWeaponArt(id: string): boolean {
  if (hasWeaponArt(id) || !WEAPON_GLB_CAL[id] || absent.has(id)) return false;
  if (assetListSync() && !modelUrlSync(weaponModelPath(id))) return false;
  void loadWeaponArt(id);
  return true;
}

/** The loaded art of a weapon, if any (synchronous). */
export function weaponArtSync(id: string): WeaponArt | undefined {
  return loaded.get(id);
}

/** Weapons a match can show: the heroes' signature weapons and everything lootable. */
export function matchWeaponIds(heroIds: Iterable<string>): string[] {
  const ids = new Set<string>(LOOTABLE_WEAPON_IDS);
  for (const h of heroIds) {
    const w = HERO_BY_ID[h]?.signatureWeapon;
    if (w) ids.add(w);
  }
  return [...ids].filter((id) => !!WEAPON_GLB_CAL[id]);
}

/**
 * Load the weapons a match can show (models/preload.ts, on the loading
 * screen). Resolves (never rejects) when every listed one settled.
 */
export async function preloadWeaponArt(heroIds: Iterable<string>): Promise<void> {
  const ids = matchWeaponIds(heroIds);
  await assetList();
  await Promise.all(ids.filter(weaponArtListed).map(loadWeaponArt));
}

/**
 * End of a match: free every loaded weapon's GPU resources and forget them
 * (the next match / gallery loads them again, from the HTTP cache). Meshes
 * still holding one keep working (three re-uploads on the next draw).
 */
export function releaseWeaponArt(): number {
  let n = 0;
  for (const [id, art] of loaded) {
    art.lod?.dispose();
    art.geo.dispose();
    art.material.map?.dispose();
    art.material.dispose();
    art.held.dispose();
    registerWeaponArt(id, null);
    n++;
  }
  loaded.clear();
  loading.clear();
  absent.clear();
  return n;
}

/** Tests: use this art for its weapon, as if it had just loaded. */
export function setWeaponArtForTests(art: WeaponArt): void {
  loading.set(art.id, Promise.resolve(art));
  loaded.set(art.id, art);
  registerWeaponArt(art.id, () => weaponArtModel(art));
}

/** Tests: forget everything without touching GPU resources. */
export function resetWeaponArtForTests(): void {
  for (const id of loaded.keys()) registerWeaponArt(id, null);
  loaded.clear();
  loading.clear();
  absent.clear();
}
