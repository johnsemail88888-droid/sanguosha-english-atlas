// Procedural weapons: modern gun bodies fused with ancient ornaments
// (WeaponModelSpec). Local frame: origin = right-hand wrist target (just above
// and behind the pistol grip), barrel along −Z, up = +Y. Unknown ids fall back
// to a spec guessed from the id so new DATA entries always render something.
// The AI-art weapons (models/weaponGlb.ts) register themselves here once
// loaded and are calibrated into the same frame: buildWeapon() returns them
// when available, buildProceduralWeapon() never does.
import * as THREE from 'three';
import type { WeaponDef, WeaponModelSpec } from '../../data/types';
import { WEAPON_BY_ID } from '../../data';
import { GeoBuilder, PRIM, col, mixCol, shade, trs, type ColorLike } from '../core/geo';
import { CHARACTER_FOG_MAX } from '../core/materials';
import { useSkyArtFog } from '../core/skyArtFog';

export type HoldStyle = 'rifle' | 'pistol' | 'akimbo' | 'bow' | 'launcher' | 'hip' | 'pole' | 'sword' | 'none';

export interface WeaponModelInfo {
  hold: HoldStyle;
  /** left-hand wrist target (weapon local), null = one-handed */
  fore: THREE.Vector3 | null;
  /** magazine point (reload hand target) */
  mag: THREE.Vector3 | null;
  /** muzzle (weapon local) */
  muzzle: THREE.Vector3;
  length: number;
  /** visual class used for muzzle flash / tracer styling */
  fxClass: string;
}

export interface WeaponModel {
  mesh: THREE.Mesh;
  info: WeaponModelInfo;
  /**
   * AI-art weapon (models/weaponGlb.ts): its material when held by a GLB body
   * (the textured look + the character fog clamp), shared by every instance.
   * Absent for procedural weapons (heldWeaponMaterial()).
   */
  heldMaterial?: THREE.MeshStandardMaterial;
  /** AI-art weapon: its far LOD (fewer triangles, same vertices) and full geometry, for a far GLB body; absent otherwise */
  lod?: { near: THREE.BufferGeometry; far: THREE.BufferGeometry | null };
}

/** Ids rendered as a pair of guns (one per hand). */
export const AKIMBO_IDS = new Set(['cixiong', 'jinfan']);

let weaponMat: THREE.MeshStandardMaterial | null = null;
export function weaponMaterial(): THREE.MeshStandardMaterial {
  if (!weaponMat) {
    weaponMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.35 });
    weaponMat.name = 'weapon';
  }
  return weaponMat;
}

let heldMat: THREE.MeshStandardMaterial | null = null;
/**
 * Material of a weapon held by a GLB body (a separate mesh on the hand bone):
 * the weapon look with the character fog clamp (FOG_MAX, scene/skyfog.ts), so
 * a far hero's gun never fogs out while the hero stays readable. Shared.
 */
export function heldWeaponMaterial(): THREE.MeshStandardMaterial {
  if (!heldMat) {
    heldMat = cloneKeepingDefines(weaponMaterial());
    heldMat.name = 'weaponHeld';
    heldMat.defines = { ...heldMat.defines, FOG_MAX: CHARACTER_FOG_MAX.toFixed(2) };
    useSkyArtFog(heldMat, 'weaponHeld');
  }
  return heldMat;
}

/**
 * Material.clone() that keeps `defines`: three's MeshStandardMaterial.copy()
 * resets them to { STANDARD: '' }, which would drop custom switches such as the
 * character fog clamp (FOG_MAX).
 */
export function cloneKeepingDefines<M extends THREE.Material & { defines?: Record<string, unknown> }>(m: M): M {
  const c = m.clone() as M;
  if (m.defines) c.defines = { ...m.defines };
  // shader hooks (painted-sky fog, core/skyArtFog.ts useSkyArtFog) are not copied by three either
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  return c;
}

/** Best-effort model spec for an id the data tables don't know (yet). */
export function guessWeaponSpec(id: string): WeaponModelSpec {
  const s = id.toLowerCase();
  const style: WeaponModelSpec['style'] = s.includes('pistol')
    ? 'pistol'
    : s.includes('smg') || s.includes('turret')
      ? 'smg'
      : s.includes('shotgun')
        ? 'shotgun'
        : s.includes('sniper')
          ? 'sniper'
          : s.includes('crossbow')
            ? 'crossbow'
            : s.includes('bow')
              ? 'bow'
              : s.includes('spear')
                ? 'spear'
                : s.includes('melee') || s.includes('sword') || s.includes('blade')
                  ? 'sword'
                  : s.includes('halberd')
                    ? 'halberd'
                    : s.includes('glaive')
                      ? 'glaive'
                      : s.includes('launch') || s.includes('rocket')
                        ? 'launcher'
                        : s.includes('flame')
                          ? 'flamer'
                          : s.includes('lmg')
                            ? 'lmg'
                            : 'rifle';
  const lengths: Record<WeaponModelSpec['style'], number> = {
    pistol: 0.25,
    smg: 0.6,
    rifle: 0.95,
    shotgun: 0.95,
    sniper: 1.3,
    lmg: 1.1,
    launcher: 1.2,
    flamer: 0.95,
    bow: 1.2,
    crossbow: 0.8,
    glaive: 1.9,
    halberd: 2.0,
    sword: 0.9,
    spear: 2.0,
  };
  return { length: lengths[style], bodyColor: '#2d2d30', accentColor: '#8a7a5a', style, ornament: 'none' };
}

export function weaponSpecOf(id: string): { spec: WeaponModelSpec; def?: WeaponDef } {
  const def = WEAPON_BY_ID[id];
  return def ? { spec: def.model, def } : { spec: guessWeaponSpec(id) };
}

const cache = new Map<string, { geo: THREE.BufferGeometry; info: WeaponModelInfo }>();

/** Dispose and forget the cached weapon geometries (end of a match). */
export function releaseWeaponGeometryCache(): void {
  for (const v of cache.values()) v.geo.dispose();
  cache.clear();
}

// ── AI-art weapons ──────────────────────────────────────────────────────────

/** Loaded AI-art weapons (models/weaponGlb.ts): a factory per weapon id. */
const artFactories = new Map<string, () => WeaponModel>();
let artEpoch = 0;

/** models/weaponGlb.ts: this weapon's art finished loading (or was released: null). */
export function registerWeaponArt(id: string, factory: (() => WeaponModel) | null): void {
  if (factory) artFactories.set(id, factory);
  else if (!artFactories.delete(id)) return;
  artEpoch++;
}

/** Bumped whenever a weapon's art arrives or goes: views holding a procedural stand-in compare it to swap in late art. */
export function weaponArtEpoch(): number {
  return artEpoch;
}

/** True when buildWeapon(id) returns the AI-art model. */
export function hasWeaponArt(id: string): boolean {
  return artFactories.has(id);
}

/**
 * Create a weapon mesh: the AI-art model once it is loaded (models/weaponGlb.ts,
 * textured, calibrated into the procedural frame), else the procedural one.
 * Synchronous; geometry / material shared per id.
 */
export function buildWeapon(id: string): WeaponModel {
  const art = artFactories.get(id);
  return art ? art() : buildProceduralWeapon(id);
}

/** The material a GLB body's hand holds this weapon with (shared; see WeaponModel.heldMaterial). */
export function heldMaterialOf(w: WeaponModel): THREE.MeshStandardMaterial {
  return w.heldMaterial ?? heldWeaponMaterial();
}

/** Create a procedural weapon mesh (geometry cached per id; shared vertex-coloured material). */
export function buildProceduralWeapon(id: string): WeaponModel {
  let hit = cache.get(id);
  if (!hit) {
    const { spec, def } = weaponSpecOf(id);
    const b = new GeoBuilder();
    const info = buildWeaponGeo(b, spec, def);
    hit = { geo: b.build(), info };
    cache.set(id, hit);
  }
  const mesh = new THREE.Mesh(hit.geo, weaponMaterial());
  mesh.castShadow = true;
  mesh.name = `weapon_${id}`;
  mesh.userData.weaponInfo = hit.info;
  return { mesh, info: hit.info };
}

export function isAkimbo(id: string): boolean {
  const { spec } = weaponSpecOf(id);
  return spec.akimbo ?? AKIMBO_IDS.has(id);
}

// ── builders ────────────────────────────────────────────────────────────────
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

function buildWeaponGeo(b: GeoBuilder, spec: WeaponModelSpec, def?: WeaponDef): WeaponModelInfo {
  const L = Math.max(0.18, spec.length);
  const body = col(spec.bodyColor);
  const acc = col(spec.accentColor);
  const dark = shade(spec.bodyColor, 0.55);
  const wood = mixCol('#6b4a2e', spec.bodyColor, 0.2);
  let info: WeaponModelInfo;
  switch (spec.style) {
    case 'pistol':
      info = pistol(b, L, body, acc, dark);
      break;
    case 'smg':
      info = smg(b, L, body, acc, dark);
      break;
    case 'shotgun':
      info = shotgun(b, L, body, acc, dark, wood);
      break;
    case 'sniper':
      info = sniper(b, L, body, acc, dark, wood);
      break;
    case 'lmg':
      info = lmg(b, L, body, acc, dark);
      break;
    case 'launcher':
      info = launcher(b, L, body, acc, dark, def?.special === 'multiTarget' ? 3 : 1);
      break;
    case 'flamer':
      info = flamer(b, L, body, acc, dark);
      break;
    case 'bow':
      info = bow(b, L, body, acc);
      break;
    case 'crossbow':
      info = crossbow(b, L, body, acc, dark, wood);
      break;
    case 'glaive':
    case 'halberd':
    case 'spear':
      info = pole(b, L, spec.style, body, acc);
      break;
    case 'sword':
      info = sword(b, L, body, acc);
      break;
    case 'rifle':
    default:
      info = rifle(b, L, body, acc, dark, wood);
      break;
  }
  if (spec.ornament && spec.ornament !== 'none') ornament(b, spec.ornament, info, acc, body);
  if (def && (def.special === 'chainLightning' || def.dtype === 'thunder')) {
    // tesla coils along the barrel
    for (let i = 0; i < 3; i++) {
      const z = info.muzzle.z * (0.45 + i * 0.15);
      b.add(PRIM.torus(0.25, 4, 10), trs(0, info.muzzle.y, z, 0, 0, 0, 0.045, 0.045, 0.045), '#8fd0ff');
    }
  }
  return info;
}

function gripAndTrigger(b: GeoBuilder, body: ColorLike, dark: ColorLike): void {
  b.add(PRIM.box(), trs(0, -0.045, 0.02, 0.28, 0, 0, 0.032, 0.1, 0.045), dark);
  b.add(PRIM.torus(0.18, 3, 8, Math.PI), trs(0, -0.005, -0.035, 0, Math.PI / 2, Math.PI, 0.025, 0.025, 0.025), body);
}

function pistol(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.035, -L / 2 + 0.05, 0.034, 0.042, L, body);
  b.boxAt(0, 0.0, -L / 2 + 0.06, 0.03, 0.03, L * 0.8, dark);
  b.boxAt(0, 0.06, -L + 0.07, 0.008, 0.012, 0.01, acc);
  gripAndTrigger(b, body, dark);
  return { hold: 'pistol', fore: v(-0.03, -0.03, 0.02), mag: v(0, -0.1, 0.02), muzzle: v(0, 0.035, -L + 0.04), length: L, fxClass: 'pistol' };
}

function smg(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.04, -L * 0.22, 0.05, 0.08, L * 0.55, body);
  b.add(PRIM.cyl(6), trs(0, 0.05, -L * 0.62, Math.PI / 2, 0, 0, 0.016, L * 0.3, 0.016), dark);
  b.add(PRIM.box(), trs(0, -0.06, -0.12, -0.15, 0, 0, 0.03, 0.15, 0.045), dark);
  b.boxAt(0, 0.09, -L * 0.2, 0.012, 0.02, 0.05, acc);
  b.boxAt(0, 0.03, 0.12, 0.02, 0.03, 0.2, dark); // folding stock
  b.boxAt(0, 0.0, 0.23, 0.02, 0.07, 0.02, dark);
  gripAndTrigger(b, body, dark);
  return { hold: 'rifle', fore: v(-0.02, -0.01, -L * 0.42), mag: v(0, -0.12, -0.12), muzzle: v(0, 0.05, -L * 0.78), length: L, fxClass: 'smg' };
}

function rifle(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color, wood: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.045, -0.1, 0.055, 0.09, 0.38, body); // receiver
  b.boxAt(0, 0.05, -0.43, 0.052, 0.068, 0.3, shade(body, 0.9)); // handguard
  b.add(PRIM.cyl(6), trs(0, 0.055, -L * 0.72, Math.PI / 2, 0, 0, 0.015, L * 0.35, 0.015), dark);
  b.add(PRIM.box(), trs(0, -0.07, -0.19, -0.25, 0, 0, 0.032, 0.16, 0.06), dark); // curved mag
  b.add(PRIM.box(), trs(0, 0.02, 0.17, -0.06, 0, 0, 0.046, 0.1, 0.26), wood); // stock
  b.boxAt(0, 0.1, -0.1, 0.03, 0.02, 0.12, dark); // sight rail
  b.boxAt(0, 0.12, -0.08, 0.02, 0.03, 0.05, acc);
  gripAndTrigger(b, body, dark);
  return { hold: 'rifle', fore: v(-0.02, -0.01, -0.42), mag: v(0, -0.14, -0.2), muzzle: v(0, 0.055, -L * 0.9), length: L, fxClass: 'rifle' };
}

function shotgun(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color, wood: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.045, -0.08, 0.056, 0.085, 0.3, body);
  b.add(PRIM.cyl(8), trs(0, 0.06, -L * 0.52, Math.PI / 2, 0, 0, 0.024, L * 0.7, 0.024), dark);
  b.add(PRIM.cyl(8), trs(0, 0.015, -L * 0.45, Math.PI / 2, 0, 0, 0.02, L * 0.55, 0.02), shade(body, 0.8));
  b.add(PRIM.cyl(8), trs(0, 0.015, -0.4, Math.PI / 2, 0, 0, 0.034, 0.18, 0.034), wood); // pump
  b.add(PRIM.box(), trs(0, 0.0, 0.17, -0.12, 0, 0, 0.05, 0.11, 0.28), wood);
  b.boxAt(0, 0.09, -L * 0.8, 0.01, 0.02, 0.01, acc);
  gripAndTrigger(b, body, dark);
  return { hold: 'rifle', fore: v(-0.02, -0.02, -0.4), mag: v(0, -0.02, -0.25), muzzle: v(0, 0.06, -L * 0.87), length: L, fxClass: 'shotgun' };
}

function sniper(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color, wood: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.045, -0.12, 0.058, 0.09, 0.42, body);
  b.add(PRIM.cyl(8), trs(0, 0.055, -L * 0.62, Math.PI / 2, 0, 0, 0.02, L * 0.7, 0.02), dark);
  b.add(PRIM.cyl(8), trs(0, 0.055, -L * 0.96, Math.PI / 2, 0, 0, 0.032, 0.08, 0.032), dark); // muzzle brake
  // scope
  b.add(PRIM.cyl(10), trs(0, 0.135, -0.12, Math.PI / 2, 0, 0, 0.03, 0.34, 0.03), dark);
  b.add(PRIM.cyl(10), trs(0, 0.135, -0.3, Math.PI / 2, 0, 0, 0.042, 0.08, 0.042), dark);
  b.add(PRIM.cyl(10), trs(0, 0.135, 0.06, Math.PI / 2, 0, 0, 0.036, 0.05, 0.036), dark);
  b.boxAt(0, 0.1, -0.12, 0.02, 0.04, 0.03, acc);
  b.add(PRIM.box(), trs(0, 0.015, 0.2, -0.05, 0, 0, 0.05, 0.12, 0.3), wood);
  b.boxAt(0, 0.08, 0.16, 0.04, 0.03, 0.14, wood); // cheek rest
  b.boxAt(0, -0.06, -0.15, 0.03, 0.09, 0.08, dark);
  // folded bipod
  b.add(PRIM.cyl(4), trs(0.02, 0.02, -L * 0.52, Math.PI / 2, 0, 0, 0.008, 0.3, 0.008), dark);
  b.add(PRIM.cyl(4), trs(-0.02, 0.02, -L * 0.52, Math.PI / 2, 0, 0, 0.008, 0.3, 0.008), dark);
  gripAndTrigger(b, body, dark);
  return { hold: 'rifle', fore: v(-0.02, -0.01, -0.4), mag: v(0, -0.12, -0.15), muzzle: v(0, 0.055, -L * 1.0), length: L, fxClass: 'sniper' };
}

function lmg(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.05, -0.12, 0.07, 0.11, 0.45, body);
  b.add(PRIM.cyl(10), trs(0, 0.06, -L * 0.62, Math.PI / 2, 0, 0, 0.035, L * 0.5, 0.035), shade(body, 0.8)); // jacket
  b.add(PRIM.cyl(6), trs(0, 0.06, -L * 0.9, Math.PI / 2, 0, 0, 0.018, L * 0.18, 0.018), dark);
  b.add(PRIM.cyl(12), trs(0, -0.08, -0.15, 0, 0, Math.PI / 2, 0.11, 0.07, 0.11), dark); // drum
  b.boxAt(0, 0.14, -0.2, 0.02, 0.05, 0.12, acc); // carry handle
  b.boxAt(0, 0.03, 0.18, 0.06, 0.12, 0.26, dark);
  b.add(PRIM.cyl(4), trs(0.03, -0.05, -L * 0.72, 0.4, 0, 0, 0.01, 0.28, 0.01), dark);
  b.add(PRIM.cyl(4), trs(-0.03, -0.05, -L * 0.72, 0.4, 0, 0, 0.01, 0.28, 0.01), dark);
  gripAndTrigger(b, body, dark);
  return { hold: 'hip', fore: v(-0.03, 0.0, -0.45), mag: v(0, -0.2, -0.15), muzzle: v(0, 0.06, -L * 0.98), length: L, fxClass: 'lmg' };
}

function launcher(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color, tubes: number): WeaponModelInfo {
  const offs = tubes === 3 ? [v(0, 0.14, 0), v(-0.055, 0.06, 0), v(0.055, 0.06, 0)] : [v(0, 0.1, 0)];
  for (const o of offs) {
    b.add(PRIM.cyl(10), trs(o.x, o.y, -L * 0.35, Math.PI / 2, 0, 0, 0.065, L, 0.065), body);
    b.add(PRIM.cyl(10, 1.3), trs(o.x, o.y, -L * 0.87, Math.PI / 2, 0, 0, 0.068, 0.06, 0.068), acc);
  }
  b.boxAt(0, 0.02, -0.25, 0.05, 0.06, 0.2, dark);
  b.boxAt(-0.08, 0.18, -0.3, 0.05, 0.06, 0.1, dark); // sight box
  gripAndTrigger(b, body, dark);
  b.add(PRIM.box(), trs(0, -0.04, -0.42, 0.2, 0, 0, 0.03, 0.09, 0.04), dark);
  return { hold: 'launcher', fore: v(-0.02, -0.03, -0.42), mag: v(0, 0.1, 0.1), muzzle: v(0, offs[0].y, -L * 0.87), length: L, fxClass: 'launcher' };
}

function flamer(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.04, -0.1, 0.06, 0.09, 0.3, body);
  b.add(PRIM.cyl(8), trs(0, 0.05, -L * 0.55, Math.PI / 2, 0, 0, 0.03, L * 0.5, 0.03), dark);
  b.add(PRIM.cyl(8, 1.8), trs(0, 0.05, -L * 0.83, Math.PI / 2, 0, 0, 0.035, 0.08, 0.035), acc); // flared nozzle
  b.add(PRIM.cyl(10), trs(0.05, -0.06, -0.12, Math.PI / 2, 0, 0, 0.05, 0.3, 0.05), '#b8322a'); // fuel tank
  b.add(PRIM.cyl(10), trs(-0.05, -0.06, -0.12, Math.PI / 2, 0, 0, 0.05, 0.3, 0.05), '#b8322a');
  b.add(PRIM.sphere(6, 4), trs(0, 0.02, -L * 0.8, 0, 0, 0, 0.018, 0.018, 0.018), '#ffb040'); // pilot light
  gripAndTrigger(b, body, dark);
  return { hold: 'hip', fore: v(-0.03, 0.0, -0.4), mag: v(0, -0.08, -0.12), muzzle: v(0, 0.05, -L * 0.88), length: L, fxClass: 'flamer' };
}

/** Recurve bow held vertically. Origin = the LEFT hand grip (hold 'bow'). */
function bow(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color): WeaponModelInfo {
  const half = L / 2;
  const N = 6;
  let prev = v(0, 0, 0);
  for (const sgn of [1, -1]) {
    prev = v(0, 0, 0);
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const p = v(0, sgn * half * t, 0.1 * Math.sin(t * Math.PI * 0.9) - (t > 0.85 ? (t - 0.85) * 0.6 : 0));
      b.rod(prev, p, 0.018 * (1 - t * 0.5), i < 2 ? acc : body, 5);
      prev = p;
    }
    b.add(PRIM.sphere(6, 4), trs(prev.x, prev.y, prev.z, 0, 0, 0, 0.02, 0.02, 0.02), acc);
  }
  const top = v(0, half, 0.1 * Math.sin(Math.PI * 0.9) - 0.09);
  const bot = v(0, -half, top.z);
  b.rod(top, v(0, 0, 0.3), 0.003, '#efe6cc', 3);
  b.rod(bot, v(0, 0, 0.3), 0.003, '#efe6cc', 3);
  b.boxAt(0, 0, 0, 0.035, 0.12, 0.04, '#5a3f28');
  return { hold: 'bow', fore: v(0, 0, 0.3), mag: null, muzzle: v(0, 0.02, -0.08), length: L, fxClass: 'bow' };
}

function crossbow(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color, dark: THREE.Color, wood: THREE.Color): WeaponModelInfo {
  b.boxAt(0, 0.04, -L * 0.3, 0.05, 0.06, L * 0.8, wood);
  b.add(PRIM.box(), trs(0, 0.0, 0.14, -0.1, 0, 0, 0.045, 0.1, 0.22), wood);
  const pz = -L * 0.65;
  for (const sx of [-1, 1]) {
    b.rod(v(0, 0.06, pz), v(sx * 0.28, 0.06, pz + 0.1), 0.014, body, 5);
    b.rod(v(sx * 0.28, 0.06, pz + 0.1), v(0, 0.07, -0.05), 0.003, '#efe6cc', 3);
  }
  b.boxAt(0, 0.08, -L * 0.4, 0.01, 0.01, L * 0.5, acc); // bolt
  b.add(PRIM.cone(4), trs(0, 0.08, -L * 0.67, -Math.PI / 2, 0, 0, 0.015, 0.05, 0.015), '#cfcfcf');
  gripAndTrigger(b, body, dark);
  return { hold: 'rifle', fore: v(-0.02, 0.0, -L * 0.45), mag: v(0, 0.12, -0.2), muzzle: v(0, 0.08, -L * 0.7), length: L, fxClass: 'crossbow' };
}

/** Polearms: shaft along −Z, blade at the far end. Origin = right hand (a third of the way from the butt). */
function pole(b: GeoBuilder, L: number, style: 'glaive' | 'halberd' | 'spear', body: THREE.Color, acc: THREE.Color): WeaponModelInfo {
  const butt = L * 0.3;
  const tipZ = -(L - butt);
  b.rod(v(0, 0, butt), v(0, 0, tipZ), 0.02, style === 'spear' ? '#6b4a2e' : body, 6);
  b.add(PRIM.cone(6), trs(0, 0, butt + 0.04, Math.PI / 2, 0, 0, 0.025, 0.08, 0.025), acc);
  b.add(PRIM.cyl(6), trs(0, 0, tipZ + 0.06, Math.PI / 2, 0, 0, 0.03, 0.08, 0.03), acc);
  if (style === 'glaive') {
    // 偃月刀: broad curved blade + dragon-mouth collar
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.quadraticCurveTo(0.18, -0.2, 0.12, -0.62);
    s.quadraticCurveTo(0.02, -0.4, -0.05, -0.1);
    s.lineTo(0, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: false });
    g.translate(0, 0, -0.006);
    g.computeVertexNormals();
    b.add(g, trs(0, 0.02, tipZ + 0.04, Math.PI / 2, 0, Math.PI / 2, 1, 1, 1), '#d8dde2');
    g.dispose();
    b.add(PRIM.cone(5), trs(0, -0.06, tipZ + 0.12, 0, 0, 0, 0.03, 0.08, 0.03), '#c8322a');
  } else if (style === 'halberd') {
    b.add(PRIM.cone(4), trs(0, 0, tipZ - 0.2, -Math.PI / 2, 0, 0, 0.03, 0.38, 0.012), '#d8dde2');
    for (const sx of [-1, 1]) {
      b.add(PRIM.torus(0.12, 3, 10, Math.PI), trs(sx * 0.1, 0, tipZ + 0.05, Math.PI / 2, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2, 0.11, 0.11, 0.2), '#d8dde2');
    }
  } else {
    b.add(PRIM.octa(), trs(0, 0, tipZ - 0.14, 0, 0, 0, 0.04, 0.02, 0.17), '#d8dde2');
    b.add(PRIM.cone(6), trs(0, -0.05, tipZ + 0.1, Math.PI, 0, 0, 0.05, 0.12, 0.05), '#c8322a'); // tassel
  }
  return { hold: 'pole', fore: v(-0.02, 0, -0.45), mag: null, muzzle: v(0, 0, tipZ - 0.2), length: L, fxClass: 'melee' };
}

function sword(b: GeoBuilder, L: number, body: THREE.Color, acc: THREE.Color): WeaponModelInfo {
  b.rod(v(0, 0, 0.12), v(0, 0, -0.04), 0.018, '#3a2a1a', 6);
  b.boxAt(0, 0, -0.06, 0.16, 0.03, 0.035, acc);
  b.add(PRIM.box(), trs(0, 0, -0.06 - (L - 0.2) / 2, 0, 0, 0, 0.045, 0.01, L - 0.2), '#d8dde2');
  b.add(PRIM.cone(4), trs(0, 0, -L + 0.1, -Math.PI / 2, Math.PI / 4, 0, 0.032, 0.08, 0.008), '#d8dde2');
  b.add(PRIM.sphere(6, 4), trs(0, 0, 0.13, 0, 0, 0, 0.025, 0.025, 0.025), acc);
  // the blade uses polished steel; the body colour tints the grip wrap
  b.rod(v(0, 0, 0.1), v(0, 0, -0.02), 0.021, shade(body, 0.8), 6);
  return { hold: 'sword', fore: null, mag: null, muzzle: v(0, 0, -L + 0.05), length: L, fxClass: 'melee' };
}

function ornament(b: GeoBuilder, kind: NonNullable<WeaponModelSpec['ornament']>, info: WeaponModelInfo, acc: THREE.Color, body: THREE.Color): void {
  const m = info.muzzle;
  const steel = '#d6dbe0';
  switch (kind) {
    case 'dragonHead': {
      // gold dragon head swallowing the muzzle
      const z = m.z + 0.08;
      b.add(PRIM.box(), trs(0, m.y + 0.01, z, 0, 0, 0, 0.07, 0.06, 0.12), acc);
      b.add(PRIM.box(), trs(0, m.y - 0.03, z - 0.02, 0.2, 0, 0, 0.06, 0.02, 0.1), shade(acc, 0.8));
      for (const sx of [-1, 1]) {
        b.add(PRIM.cone(4), trs(sx * 0.025, m.y + 0.06, z + 0.05, 0.9, 0, sx * 0.3, 0.012, 0.09, 0.012), acc);
        b.add(PRIM.sphere(5, 4), trs(sx * 0.036, m.y + 0.025, z - 0.02, 0, 0, 0, 0.01, 0.01, 0.01), '#c8322a');
        b.add(PRIM.box(), trs(sx * 0.03, m.y - 0.01, z + 0.07, 0, sx * 0.4, 0, 0.012, 0.012, 0.07), shade(acc, 0.9)); // whiskers
      }
      break;
    }
    case 'blade':
      b.add(PRIM.box(), trs(0, m.y - 0.07, m.z * 0.7, 0, 0, 0, 0.008, 0.05, Math.abs(m.z) * 0.45), steel);
      break;
    case 'bayonet':
      b.add(PRIM.box(), trs(0, m.y - 0.03, m.z - 0.1, 0, 0, 0, 0.008, 0.025, 0.22), steel);
      b.add(PRIM.cone(4), trs(0, m.y - 0.03, m.z - 0.23, -Math.PI / 2, 0, 0, 0.014, 0.05, 0.005), steel);
      break;
    case 'tassel':
      b.add(PRIM.sphere(5, 4), trs(0, m.y - 0.04, m.z + 0.1, 0, 0, 0, 0.015, 0.015, 0.015), acc);
      b.add(PRIM.cone(6), trs(0, m.y - 0.12, m.z + 0.1, Math.PI, 0, 0, 0.035, 0.13, 0.035), '#c8322a');
      break;
    case 'phoenixFeathers': {
      const cols = ['#c8322a', '#e07a2a', '#e0b02a', '#e07a2a', '#c8322a'];
      cols.forEach((c, i) => {
        const a = (i - 2) * 0.35;
        b.add(PRIM.sphere(6, 4), trs(Math.sin(a) * 0.12, 0.1 + Math.cos(a) * 0.12, 0.05, 0, 0, -a, 0.025, 0.12, 0.006), c);
      });
      break;
    }
    case 'axeHead': {
      const z = m.z + 0.12;
      b.add(PRIM.cyl(10, 1, false), trs(0, m.y - 0.09, z, 0, 0, Math.PI / 2, 0.09, 0.012, 0.09), steel);
      b.boxAt(0, m.y - 0.02, z, 0.02, 0.06, 0.04, acc);
      break;
    }
    case 'serpentBlade': {
      // 蛇矛: wavy blade extending past the muzzle
      let z = m.z;
      for (let i = 0; i < 6; i++) {
        const nz = z - 0.05;
        b.add(PRIM.box(), trs((i % 2 ? 1 : -1) * 0.008, m.y - 0.02, (z + nz) / 2, 0, (i % 2 ? 1 : -1) * 0.35, 0, 0.008, 0.03 - i * 0.003, 0.06), steel);
        z = nz;
      }
      break;
    }
    case 'crescent': {
      // 偃月: crescent blade along the front underside
      const z = m.z + 0.14;
      b.add(PRIM.torus(0.18, 3, 12, Math.PI * 0.9), trs(0, m.y - 0.02, z, 0, Math.PI / 2, Math.PI * 1.05, 0.13, 0.08, 0.1), steel);
      b.add(PRIM.box(), trs(0, m.y - 0.03, z + 0.1, 0, 0, 0, 0.02, 0.05, 0.03), acc);
      break;
    }
    default:
      break;
  }
}
