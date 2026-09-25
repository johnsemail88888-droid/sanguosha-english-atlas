// AI-art mounts (assets/models/mounts/horse.glb, elephant.glb): static
// textured meshes rigged in code (quadrupedRig.ts) into one shared skinned
// geometry per kind; every mount instance gets its own skeleton and material
// (coat colour, fades) and is posed by the gait in mounts.ts.
//
// Coat variants recolour the painted bay coat per instance in the fragment
// shader: the texel's luminance relative to the painted coat's (so the
// painting's shading, dapples and dark points survive) times the variant's
// coat colour — except on tack: texels that are gold / brass, crimson lacquer
// or grey metal, and the saddle + pad region and the hooves (rest-pose
// position boxes, per fragment). Optional lower-leg colour (爪黄飞电) and a
// forehead blaze (的卢) use rest-pose regions too.
//
// Absent files: nothing is fetched and the procedural mounts stay.
import * as THREE from 'three';
import { assetList, assetListSync } from '../../game/assets';
import { MOUNT_BY_ID } from '../../data';
import { CHARACTER_FOG_MAX } from '../core/materials';
import { applySkyArtFog, skyArtFogKey } from '../core/skyArtFog';
import { capTexture, floatAttribute, sharedGltfLoader, type GltfLoaderLike } from '../core/gltfLoader';
import { texSizesFor, worldArtQuality } from '../core/worldArt';
import { QUAD_CALIB, measureSeatTop, mountRigMatrix, quadBones, quadSkinWeights, refineJoints, type QuadKind } from './quadrupedRig';

export const mountModelPath = (kind: QuadKind): string => `assets/models/mounts/${kind}.glb`;

// ── coat variants (pure) ────────────────────────────────────────────────────

export interface CoatVariant {
  /** coat colour (sRGB hex), or null: the painting as shipped */
  coat: string | null;
  /** lower legs (below knee / hock) */
  legs: string | null;
  /** forehead blaze */
  blaze: string | null;
}

const BAY: CoatVariant = { coat: null, legs: null, blaze: null };

/**
 * Coat of each mount item (MountDef.color → look) and of the innate / troop
 * horses. 大宛 is the painted bay; unknown colours recolour the coat to that
 * colour.
 */
const COATS: Record<string, CoatVariant> = {
  chitu: { coat: '#a8341a', legs: null, blaze: null }, // 赤兔: fiery red chestnut
  dawan: BAY, // 大宛: tall bay
  zixing: { coat: '#583442', legs: null, blaze: null }, // 紫骍: violet-brown
  dilu: { coat: '#e4ded2', legs: null, blaze: '#2e2824' }, // 的卢: white, dark forehead blaze
  jueying: { coat: '#1e1e24', legs: null, blaze: null }, // 绝影: shadow black
  zhuahuang: { coat: '#ece8e0', legs: '#d4a22c', blaze: null }, // 爪黄飞电: white, yellow lower legs
};

/** Coat colours that are not mount items (models/index.ts): bay war horse, 马超's 西凉 grey, troop dark bay. */
const EXTRA: Record<string, CoatVariant> = {
  '#6b4a2e': BAY,
  '#d8d0c2': { coat: '#cbc6bd', legs: null, blaze: null },
  '#5a3f2a': { coat: '#4e3020', legs: null, blaze: null },
};

/** Look of a horse drawn with coat colour `coat` (as passed to CharacterRig.setMount). */
export function mountCoatVariant(coat: string): CoatVariant {
  const c = coat.trim().toLowerCase();
  for (const [id, v] of Object.entries(COATS)) if (MOUNT_BY_ID[id]?.color.toLowerCase() === c) return v;
  const extra = EXTRA[c];
  if (extra) return extra;
  return /^#[0-9a-f]{6}$/.test(c) ? { coat: c, legs: null, blaze: null } : BAY;
}

/** Luminance exponent for a coat colour: light coats lift the painted dark points / mane toward the coat. */
export function coatGamma(linearLum: number): number {
  const t = Math.min(1, Math.max(0, (linearLum - 0.15) / 0.45));
  return 1 - 0.55 * t * t * (3 - 2 * t);
}

const ss = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Tack weight of a painted texel (display-space rgb ≈ sqrt of linear): gold /
 * brass fittings, crimson lacquer, grey metal. CPU twin of the shader.
 */
export function tackTexel(sr: number, sg: number, sb: number): number {
  const mx = Math.max(sr, sg, sb);
  const mn = Math.min(sr, sg, sb);
  const sat = (mx - mn) / Math.max(mx, 1e-3);
  const hue = (sg - sb) / Math.max(mx - mn, 1e-3);
  const rmax = sr >= mx - 1e-4 ? 1 : 0;
  const gold = rmax * ss(0.52, 0.64, hue) * ss(0.45, 0.6, sat) * ss(0.4, 0.55, mx);
  const crimson = rmax * (1 - ss(-0.02, 0.1, hue)) * ss(0.5, 0.65, sat) * ss(0.25, 0.35, mx);
  const metal = (1 - ss(0.1, 0.2, sat)) * ss(0.4, 0.55, mx);
  return Math.min(1, gold + crimson + metal);
}

/**
 * CPU twin of the coat recolour for one linear texel `c` of free coat (no tack
 * region): `coatRef` is the painted coat's linear luminance.
 */
export function recolourCoat(c: THREE.Color, coat: THREE.Color, coatRef: number, out: THREE.Color): THREE.Color {
  const tack = tackTexel(Math.sqrt(c.r), Math.sqrt(c.g), Math.sqrt(c.b));
  const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const tl = coat.r * 0.2126 + coat.g * 0.7152 + coat.b * 0.0722;
  const k = Math.min(1.5, Math.max(0.12, Math.pow(Math.max(lum / coatRef, 1e-3), coatGamma(tl))));
  out.setRGB(c.r + (coat.r * k - c.r) * (1 - tack), c.g + (coat.g * k - c.g) * (1 - tack), c.b + (coat.b * k - c.b) * (1 - tack));
  return out;
}

/**
 * Linear luminance of the painted coat: a high percentile of the warm,
 * saturated, non-tack texels of an sRGB RGBA image (the coat's lit value).
 */
export function measureCoatRef(px: ArrayLike<number>, fallback = 0.08): number {
  const Ls: number[] = [];
  const lin = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  for (let i = 0; i + 3 < px.length; i += 4) {
    const r = lin(px[i]);
    const g = lin(px[i + 1]);
    const b = lin(px[i + 2]);
    const sr = Math.sqrt(r);
    const sg = Math.sqrt(g);
    const sb = Math.sqrt(b);
    const mx = Math.max(sr, sg, sb);
    const mn = Math.min(sr, sg, sb);
    const sat = (mx - mn) / Math.max(mx, 1e-3);
    const hue = (sg - sb) / Math.max(mx - mn, 1e-3);
    if (sr < mx || tackTexel(sr, sg, sb) > 0.5 || hue < 0.15 || hue > 0.6 || sat < 0.3 || mx < 0.3) continue;
    Ls.push(r * 0.2126 + g * 0.7152 + b * 0.0722);
  }
  if (Ls.length < 20) return fallback;
  Ls.sort((a, b) => a - b);
  return Ls[Math.floor(Ls.length * 0.6)];
}

// ── template (shared per kind) ──────────────────────────────────────────────

/** Recolour regions in rig space (rest pose). */
export interface MountRegions {
  tackMin: THREE.Vector3;
  tackMax: THREE.Vector3;
  hoofY: number;
  /** lower-leg band: bottom, front top, hind top; legs with z < splitZ are front legs */
  legs: THREE.Vector3;
  splitZ: number;
  blazeC: THREE.Vector3;
  blazeR: THREE.Vector3;
  /** rig units per model unit (transition widths) */
  unit: number;
}

export interface MountTemplate {
  kind: QuadKind;
  /** skinned geometry in rig space (head −Z, hooves on y = 0, seat over the origin) */
  geometry: THREE.BufferGeometry;
  bones: { name: string; parent: string | null; pos: THREE.Vector3 }[];
  texture: THREE.Texture | null;
  /** linear luminance of the painted coat */
  coatRef: number;
  regions: MountRegions;
  dispose(): void;
}

let testLoader: GltfLoaderLike | null = null;

/** Tests: load mounts through `l` instead of GLTFLoader (null: the real loader). */
export function setMountLoaderForTests(l: GltfLoaderLike | null): void {
  testLoader = l;
}

/**
 * Rig a loaded mount mesh: rig-space geometry with skin weights, bones and
 * recolour regions. `seatHeight` (rig units) is where the seat top lands.
 */
export function rigMountMesh(kind: QuadKind, mesh: THREE.Mesh, seatHeight: number): Omit<MountTemplate, 'texture' | 'coatRef' | 'dispose'> {
  const calib = QUAD_CALIB[kind];
  mesh.updateWorldMatrix(true, false);
  const src = mesh.geometry;
  const pos = floatAttribute(src.getAttribute('position'));
  const world = mesh.matrixWorld;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(world);
    pos[i] = v.x;
    pos[i + 1] = v.y;
    pos[i + 2] = v.z;
  }
  let minY = Infinity;
  for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]);
  const joints = refineJoints(pos, calib, minY);
  // the rider's hips go right over the seat top as measured on this mesh
  const m = mountRigMatrix(calib, minY, seatHeight, measureSeatTop(pos, calib));
  const unit = new THREE.Vector3().setFromMatrixScale(m).x;
  const geometry = new THREE.BufferGeometry();
  const P = new THREE.BufferAttribute(pos, 3);
  geometry.setAttribute('position', P);
  const nrm = src.getAttribute('normal');
  if (nrm) geometry.setAttribute('normal', new THREE.BufferAttribute(floatAttribute(nrm), 3));
  const uv = src.getAttribute('uv');
  if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(floatAttribute(uv), 2));
  if (src.index) geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array as ArrayLike<number>), 1));
  // normals follow the node transform (applyMatrix4 does both), then into rig space
  if (nrm) {
    const nm = new THREE.Matrix3().getNormalMatrix(world);
    const N = geometry.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < N.count; i++) {
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      N.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geometry.applyMatrix4(m);
  if (!nrm) geometry.computeVertexNormals();
  const bones = quadBones(calib, joints, m);
  const box = (b: { min: readonly number[]; max: readonly number[] }): { min: THREE.Vector3; max: THREE.Vector3 } => {
    const bb = new THREE.Box3().setFromPoints([new THREE.Vector3(b.min[0], b.min[1], b.min[2]).applyMatrix4(m), new THREE.Vector3(b.max[0], b.max[1], b.max[2]).applyMatrix4(m)]);
    return { min: bb.min, max: bb.max };
  };
  const rigid = calib.rigid.map((r) => ({ bone: r.bone, ...box(r) }));
  const w = quadSkinWeights(P.array as Float32Array, bones, rigid);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(w.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w.skinWeight, 4));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const r = calib.regions;
  const tack = r.tack.length ? box(r.tack[0]) : { min: new THREE.Vector3(1, 1, 1), max: new THREE.Vector3(-1, -1, -1) };
  const yOf = (y: number): number => (y - minY) * unit;
  const regions: MountRegions = {
    tackMin: tack.min,
    tackMax: tack.max,
    hoofY: yOf(r.hoofY),
    legs: new THREE.Vector3(yOf(r.legs.bottom), yOf(r.legs.front), yOf(r.legs.hind)),
    splitZ: bones.find((b) => b.name === 'body')?.pos.z ?? 0,
    blazeC: r.blaze ? new THREE.Vector3(...r.blaze.c).applyMatrix4(m) : new THREE.Vector3(0, -100, 0),
    blazeR: r.blaze ? new THREE.Vector3(...r.blaze.r).multiplyScalar(unit) : new THREE.Vector3(1, 1, 1),
    unit,
  };
  return { kind, geometry, bones: bones.map((b) => ({ name: b.name, parent: b.parent, pos: b.pos })), regions };
}

function coatRefOf(tex: THREE.Texture | null): number {
  const img = tex?.image as CanvasImageSource | undefined;
  if (!img || typeof document === 'undefined') return 0.08;
  try {
    const S = 96;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return 0.08;
    g.drawImage(img, 0, 0, S, S);
    return measureCoatRef(g.getImageData(0, 0, S, S).data);
  } catch {
    return 0.08;
  }
}

async function buildTemplate(kind: QuadKind, seatHeight: number): Promise<MountTemplate | null> {
  // no DOM (unit tests): GLTFLoader cannot fetch or decode here
  if (!testLoader && typeof document === 'undefined') return null;
  try {
    const gltf = await (testLoader ?? (await sharedGltfLoader())).loadAsync(mountModelPath(kind));
    gltf.scene.updateMatrixWorld(true);
    let found: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
    });
    const mesh = found as THREE.Mesh | null;
    if (!mesh) return null;
    const rigged = rigMountMesh(kind, mesh, seatHeight);
    const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const q = worldArtQuality();
    const texture = srcMat.map ? capTexture(srcMat.map, q === 'low' ? 512 : Math.max(1024, texSizesFor(q).props)) : null;
    if (texture) texture.anisotropy = 4;
    const coatRef = coatRefOf(texture);
    mesh.geometry.dispose();
    srcMat.dispose();
    return {
      ...rigged,
      texture,
      coatRef,
      dispose(): void {
        rigged.geometry.dispose();
        texture?.dispose();
      },
    };
  } catch (err) {
    console.warn('[render] mount model failed', kind, err);
    return null;
  }
}

const templates = new Map<QuadKind, Promise<MountTemplate | null>>();
const ready = new Map<QuadKind, MountTemplate>();

/** Load (once) and rig the mount model of `kind`; null when not shipped or broken. */
export function loadMountTemplate(kind: QuadKind, seatHeight: number): Promise<MountTemplate | null> {
  let p = templates.get(kind);
  if (!p) {
    p = assetList()
      .then((files) => (files.has(mountModelPath(kind)) ? buildTemplate(kind, seatHeight) : null))
      .then((t) => {
        if (t) ready.set(kind, t);
        return t;
      });
    templates.set(kind, p);
  }
  return p;
}

/** The rigged template if already loaded. */
export function mountTemplateSync(kind: QuadKind): MountTemplate | null {
  return ready.get(kind) ?? null;
}

/** True when the deploy ships the model (false while the listing is unknown). */
export function mountArtListed(kind: QuadKind): boolean {
  return assetListSync()?.has(mountModelPath(kind)) ?? false;
}

/** Free the rigged templates (end of a match / tests); they reload on demand. */
export function releaseMountTemplates(): void {
  for (const t of ready.values()) t.dispose();
  ready.clear();
  templates.clear();
}

// ── material ────────────────────────────────────────────────────────────────

export interface MountMaterialUniforms {
  uCoat: { value: THREE.Color };
  uCoatOn: { value: number };
  uCoatGamma: { value: number };
  uCoatRef: { value: number };
  uLegCol: { value: THREE.Color };
  uLegOn: { value: number };
  uBlazeCol: { value: THREE.Color };
  uBlazeOn: { value: number };
  uTackMin: { value: THREE.Vector3 };
  uTackMax: { value: THREE.Vector3 };
  uHoofY: { value: number };
  uLegBand: { value: THREE.Vector3 };
  uSplitZ: { value: number };
  uBlazeC: { value: THREE.Vector3 };
  uBlazeR: { value: THREE.Vector3 };
  uUnit: { value: number };
}

const PARS_VERTEX = /* glsl */ `
varying vec3 vRest;`;

const PARS_FRAGMENT = /* glsl */ `
uniform vec3 uCoat;
uniform float uCoatOn;
uniform float uCoatGamma;
uniform float uCoatRef;
uniform vec3 uLegCol;
uniform float uLegOn;
uniform vec3 uBlazeCol;
uniform float uBlazeOn;
uniform vec3 uTackMin;
uniform vec3 uTackMax;
uniform float uHoofY;
uniform vec3 uLegBand;
uniform float uSplitZ;
uniform vec3 uBlazeC;
uniform vec3 uBlazeR;
uniform float uUnit;
varying vec3 vRest;`;

const FRAGMENT = /* glsl */ `
if (uCoatOn + uLegOn + uBlazeOn > 0.5) {
  vec3 c = diffuseColor.rgb;
  // tack texels (display space): gold / brass, crimson lacquer, grey metal
  vec3 sc = sqrt(max(c, vec3(0.0)));
  float mx = max(sc.r, max(sc.g, sc.b));
  float mn = min(sc.r, min(sc.g, sc.b));
  float sat = (mx - mn) / max(mx, 1e-3);
  float hue = (sc.g - sc.b) / max(mx - mn, 1e-3);
  float rmax = step(mx - 1e-4, sc.r);
  float gold = rmax * smoothstep(0.52, 0.64, hue) * smoothstep(0.45, 0.6, sat) * smoothstep(0.4, 0.55, mx);
  float crimson = rmax * (1.0 - smoothstep(-0.02, 0.1, hue)) * smoothstep(0.5, 0.65, sat) * smoothstep(0.25, 0.35, mx);
  float metal = (1.0 - smoothstep(0.1, 0.2, sat)) * smoothstep(0.4, 0.55, mx);
  float tack = min(1.0, gold + crimson + metal);
  // rest-pose regions: saddle + pad box, hooves
  vec3 p = vRest;
  vec3 inside = step(uTackMin, p) * step(p, uTackMax);
  float box = inside.x * inside.y * inside.z;
  float hoof = 1.0 - smoothstep(uHoofY - 0.01 * uUnit, uHoofY + 0.02 * uUnit, p.y);
  float free = (1.0 - tack) * (1.0 - max(box, hoof));
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float ratio = max(lum / uCoatRef, 1e-3);
  float k = clamp(pow(ratio, uCoatGamma), 0.12, 1.5);
  c = mix(c, uCoat * k, free * uCoatOn);
  float legTop = p.z < uSplitZ ? uLegBand.y : uLegBand.z;
  float legs = (1.0 - smoothstep(legTop - 0.035 * uUnit, legTop + 0.03 * uUnit, p.y)) * smoothstep(uLegBand.x, uLegBand.x + 0.02 * uUnit, p.y);
  c = mix(c, uLegCol * k, legs * free * uLegOn);
  float e = length((p - uBlazeC) / uBlazeR);
  c = mix(c, uBlazeCol * clamp(pow(ratio, 0.5), 0.5, 1.3), (1.0 - smoothstep(0.55, 1.0, e)) * free * uBlazeOn);
  diffuseColor.rgb = c;
}`;

/** Per-instance material of a GLB mount (coat variant, character fog clamp, fades). */
export function mountMaterial(tpl: MountTemplate, variant: CoatVariant): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: tpl.texture, roughness: 0.78, metalness: 0 });
  m.name = 'mountGlb';
  // fog never hides a rider's mount completely (same clamp as the character bodies)
  m.defines = { FOG_MAX: CHARACTER_FOG_MAX.toFixed(2) };
  const lin = (hex: string | null): THREE.Color => (hex ? new THREE.Color(hex) : new THREE.Color(1, 1, 1));
  const coat = lin(variant.coat);
  const r = tpl.regions;
  const u: MountMaterialUniforms = {
    uCoat: { value: coat },
    uCoatOn: { value: variant.coat ? 1 : 0 },
    uCoatGamma: { value: coatGamma(coat.r * 0.2126 + coat.g * 0.7152 + coat.b * 0.0722) },
    uCoatRef: { value: tpl.coatRef },
    uLegCol: { value: lin(variant.legs) },
    uLegOn: { value: variant.legs ? 1 : 0 },
    uBlazeCol: { value: lin(variant.blaze) },
    uBlazeOn: { value: variant.blaze ? 1 : 0 },
    uTackMin: { value: r.tackMin },
    uTackMax: { value: r.tackMax },
    uHoofY: { value: r.hoofY },
    uLegBand: { value: r.legs },
    uSplitZ: { value: r.splitZ },
    uBlazeC: { value: r.blazeC },
    uBlazeR: { value: r.blazeR },
    uUnit: { value: r.unit },
  };
  m.userData.mountUniforms = u;
  m.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, m);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvRest = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${PARS_FRAGMENT}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT}`);
  };
  m.customProgramCacheKey = () => `mountGlb_v1${skyArtFogKey()}`;
  return m;
}
