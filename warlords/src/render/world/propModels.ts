// AI-art prop models (assets/models/props/<type>.glb): textured static meshes
// drawn instead of the procedural props when the deploy ships them. One
// InstancedMesh per (model, 64 m cell) — vegetation and rocks number in the
// hundreds and per-cell meshes keep frustum / shadow-camera culling useful.
//
// Each model is normalised once (dequantised, node transform baked, pivot at
// the base: trunk foot for vegetation, footprint centre otherwise) and every
// instance is fitted to its MapProp footprint (sx / sy / sz, rot) with capped
// distortion, so the visual stays inside / around the sim collider (a tree's
// trunk stands on its collider). Variants add a little scale / yaw jitter;
// kingdom-coloured tents and the red Chibi rocks keep their tints through a
// selective instance tint (canvas / leaves / whole model).
//
// Absent files: nothing is fetched and the procedural props stay.
import * as THREE from 'three';
import type { MapProp, PropType } from '../../core/map';
import { sharedUniforms } from '../core/materials';
import { hashString } from '../core/noise';

export const GLB_PROP_TYPES = ['tent', 'crateStack', 'barricade', 'rock', 'tree', 'pine', 'bamboo', 'brazier', 'statue'] as const;
export type GlbPropType = (typeof GLB_PROP_TYPES)[number];

export const propModelPath = (t: GlbPropType): string => `assets/models/props/${t}.glb`;

/**
 * The model that replaces a prop, or null when its variant has a different
 * silhouette than the shipped model (Nanman cone tents, sandbag / plank
 * barricades, the non-lion statues keep their procedural shapes).
 */
export function glbPropKind(p: MapProp): GlbPropType | null {
  switch (p.type) {
    case 'tent':
      return p.variant === 2 ? null : 'tent';
    case 'barricade':
      return p.variant === 1 ? 'barricade' : null;
    case 'statue':
      return p.variant === 1 ? 'statue' : null;
    case 'crateStack':
    case 'rock':
    case 'tree':
    case 'pine':
    case 'bamboo':
    case 'brazier':
      return p.type;
    default:
      return null;
  }
}

/** How a model is fitted to a prop footprint. */
interface FitRule {
  /** pivot at the trunk foot (centroid of the lowest vertices) instead of the bbox centre */
  trunkPivot: boolean;
  /** target width / depth / height as a fraction of the prop's sx / sz / sy */
  w: number;
  d: number;
  h: number;
  /** uniform scale only (statues) */
  uniform: boolean;
  /** max vertical stretch relative to the model's own proportions (0 = free) */
  maxStretch: number;
  /** fraction of the target height sunk below the base (hides gaps on slopes) */
  sink: number;
  /** extra yaw of the model (radians) so its front matches the procedural prop's front (local −Z) */
  yaw: number;
  /** per-instance random yaw (vegetation / rocks) */
  randomYaw: boolean;
  /** use the prop width for depth too (round plants) */
  round: boolean;
  /** tint mask: 0 whole model, 1 leaves (green texels), 2 canvas (bright unsaturated texels) */
  mask: 0 | 1 | 2;
  wind: number;
  /** double-sided (thin leaves / cloth in the model) */
  doubleSided: boolean;
}

const FIT: Record<GlbPropType, FitRule> = {
  tree: { trunkPivot: true, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 1.35, sink: 0.03, yaw: 0, randomYaw: true, round: true, mask: 1, wind: 0.05, doubleSided: true },
  pine: { trunkPivot: true, w: 1.3, d: 1.3, h: 0.95, uniform: false, maxStretch: 1.6, sink: 0.03, yaw: 0, randomYaw: true, round: true, mask: 1, wind: 0.04, doubleSided: true },
  bamboo: { trunkPivot: true, w: 1.05, d: 1.05, h: 1.0, uniform: false, maxStretch: 2.2, sink: 0.02, yaw: 0, randomYaw: true, round: true, mask: 1, wind: 0.07, doubleSided: true },
  rock: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.2, uniform: false, maxStretch: 0, sink: 0.2, yaw: 0, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  tent: { trunkPivot: false, w: 1.12, d: 1.12, h: 0.85, uniform: false, maxStretch: 0, sink: 0.01, yaw: Math.PI, randomYaw: false, round: false, mask: 2, wind: 0, doubleSided: true },
  crateStack: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0.01, yaw: 0, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  barricade: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0.03, yaw: 0, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  brazier: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0, yaw: 0, randomYaw: false, round: true, mask: 0, wind: 0, doubleSided: false },
  statue: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: true, maxStretch: 0, sink: 0.01, yaw: Math.PI, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
};

/** Model extents after normalisation (pivot at the origin, base at y = 0). */
export interface ModelBounds {
  /** full width (x), height (y), depth (z) */
  w: number;
  h: number;
  d: number;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Instance transform fitting a normalised model into a prop footprint. Pure
 * (deterministic per prop position); writes into `out` and returns it.
 */
export function fitPropMatrix(kind: GlbPropType, p: MapProp, b: ModelBounds, out: THREE.Matrix4): THREE.Matrix4 {
  const f = FIT[kind];
  const h32 = hashString(`${kind}|${p.x.toFixed(2)}|${p.z.toFixed(2)}`);
  const j1 = ((h32 & 0xff) / 255) * 2 - 1; // -1..1
  const j2 = (((h32 >>> 8) & 0xff) / 255) * 2 - 1;
  const yawJ = f.randomYaw ? ((h32 >>> 16) / 65536) * Math.PI * 2 : j2 * 0.06; // small jitter on man-made props
  // footprint: turn the model 90° when that fits the prop's proportions better (tents / crates)
  let turn = 0;
  let pw = p.sx;
  let pd = f.round ? p.sx : p.sz;
  if (!f.round && !f.uniform && b.w > 1e-6 && b.d > 1e-6) {
    const straight = Math.abs(Math.log(p.sx / p.sz / (b.w / b.d)));
    const turned = Math.abs(Math.log(p.sz / p.sx / (b.w / b.d)));
    if (turned + 0.05 < straight) {
      turn = Math.PI / 2;
      pw = p.sz;
      pd = p.sx;
    }
  }
  const W = pw * f.w;
  const D = pd * f.d;
  let H = p.sy * f.h;
  let sx = W / Math.max(1e-6, b.w);
  let sz = D / Math.max(1e-6, b.d);
  let sy = H / Math.max(1e-6, b.h);
  if (f.uniform) {
    const s = Math.min(sx, sy, sz);
    sx = sy = sz = s;
    H = s * b.h;
  } else if (f.maxStretch > 0) {
    // keep the model's own proportions within maxStretch (a stretched bonsai looks wrong)
    const horiz = Math.sqrt(sx * sz);
    const k = Math.min(f.maxStretch, Math.max(1 / f.maxStretch, sy / horiz));
    sy = horiz * k;
    H = sy * b.h;
  }
  // variant / position jitter: ±6 % size
  const js = 1 + j1 * 0.06;
  sx *= js;
  sy *= js;
  sz *= js;
  _e.set(0, p.rot + f.yaw + turn + yawJ, 0, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(p.x, p.y - H * f.sink, p.z);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

// ── model loading / normalisation ───────────────────────────────────────────

export interface PropModel {
  kind: GlbPropType;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  bounds: ModelBounds;
  dispose(): void;
}

type GltfLoaderLike = { loadAsync(url: string): Promise<{ scene: THREE.Object3D }> };
let loaderP: Promise<GltfLoaderLike> | null = null;

function loader(): Promise<GltfLoaderLike> {
  if (!loaderP) {
    loaderP = Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]).then(
      ([{ GLTFLoader }, { MeshoptDecoder }]) => {
        const l = new GLTFLoader();
        l.setMeshoptDecoder(MeshoptDecoder);
        return l;
      },
    );
  }
  return loaderP;
}

/** Float copy of a (possibly quantised / normalised / interleaved) attribute. */
function floatAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = a.count;
  const k = a.itemSize;
  const out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    out[i * k] = a.getX(i);
    if (k > 1) out[i * k + 1] = a.getY(i);
    if (k > 2) out[i * k + 2] = a.getZ(i);
    if (k > 3) out[i * k + 3] = a.getW(i);
  }
  return new THREE.BufferAttribute(out, k);
}

/**
 * Bake a loaded mesh into a plain float geometry with its pivot at the base:
 * the trunk foot (centroid of the lowest 4 % of vertices) or the bbox centre.
 */
export function normaliseGeometry(src: THREE.BufferGeometry, world: THREE.Matrix4, trunkPivot: boolean): { geometry: THREE.BufferGeometry; bounds: ModelBounds } {
  const g = new THREE.BufferGeometry();
  const pos = floatAttr(src.getAttribute('position'));
  g.setAttribute('position', pos);
  const nrm = src.getAttribute('normal');
  if (nrm) g.setAttribute('normal', floatAttr(nrm));
  const uv = src.getAttribute('uv');
  if (uv) g.setAttribute('uv', floatAttr(uv));
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array as ArrayLike<number>), 1));
  g.applyMatrix4(world);
  if (!nrm) g.computeVertexNormals();
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  let px = (bb.min.x + bb.max.x) / 2;
  let pz = (bb.min.z + bb.max.z) / 2;
  if (trunkPivot) {
    const cut = bb.min.y + (bb.max.y - bb.min.y) * 0.04;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > cut) continue;
      sx += pos.getX(i);
      sz += pos.getZ(i);
      n++;
    }
    if (n) {
      px = sx / n;
      pz = sz / n;
    }
  }
  g.translate(-px, -bb.min.y, -pz);
  // unit height: the wind sway and the fitting work in the same space as the procedural plants
  const hh = bb.max.y - bb.min.y;
  if (hh > 1e-6) g.scale(1 / hh, 1 / hh, 1 / hh);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const b2 = g.boundingBox!;
  // extents measured around the pivot (a tree leaning to one side is as wide as its farthest leaf)
  const w = 2 * Math.max(Math.abs(b2.min.x), Math.abs(b2.max.x));
  const d = 2 * Math.max(Math.abs(b2.min.z), Math.abs(b2.max.z));
  return { geometry: g, bounds: { w: trunkPivot ? w : b2.max.x - b2.min.x, h: b2.max.y, d: trunkPivot ? d : b2.max.z - b2.min.z } };
}

/** Prop material: the model's texture, selective instance tint, wind sway for plants. */
function propMaterial(kind: GlbPropType, map: THREE.Texture | null): THREE.MeshStandardMaterial {
  const f = FIT[kind];
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.86, metalness: 0, side: f.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  m.name = `prop_${kind}`;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWind = sharedUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec2 uWind;
varying vec3 vTint;`,
      )
      // the instance colour is a selective tint (fragment), not a plain multiply
      .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor.rgb;
  vColor = vColor * 0.0 + 1.0; // (vec3 or vec4 depending on the three build)
#else
  vTint = vec3(1.0);
#endif`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#if ${f.wind > 0 ? 1 : 0}
{
  vec3 basePos = vec3(0.0);
  #ifdef USE_INSTANCING
    basePos = instanceMatrix[3].xyz;
  #endif
  float h = max(position.y, 0.0) * 0.22;
  float ph = basePos.x * 0.21 + basePos.z * 0.17;
  float sway = sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.4;
  transformed.xz += uWind * sway * h * h * ${(f.wind * 10).toFixed(3)};
}
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTint;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  vec3 c = diffuseColor.rgb;
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
#if ${f.mask} == 1
  float mask = smoothstep(0.004, 0.03, c.g - max(c.r, c.b));
#elif ${f.mask} == 2
  float mask = smoothstep(0.25, 0.55, mx) * (1.0 - smoothstep(0.12, 0.3, (mx - mn) / max(mx, 1e-3)));
#else
  float mask = 1.0;
#endif
  diffuseColor.rgb = mix(c, c * vTint, mask);
}`,
      );
  };
  m.customProgramCacheKey = () => `prop_${kind}_v1`;
  return m;
}

async function loadModel(kind: GlbPropType): Promise<PropModel | null> {
  try {
    const gltf = await (await loader()).loadAsync(propModelPath(kind));
    gltf.scene.updateMatrixWorld(true);
    let mesh: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    const found = mesh as THREE.Mesh | null;
    if (!found) return null;
    const { geometry, bounds } = normaliseGeometry(found.geometry, found.matrixWorld, FIT[kind].trunkPivot);
    const srcMat = (Array.isArray(found.material) ? found.material[0] : found.material) as THREE.MeshStandardMaterial;
    const tex = srcMat.map ?? null;
    if (tex) tex.anisotropy = 4;
    const material = propMaterial(kind, tex);
    // the loader's own geometry / material are no longer needed
    found.geometry.dispose();
    srcMat.dispose();
    return {
      kind,
      geometry,
      material,
      bounds,
      dispose(): void {
        geometry.dispose();
        material.dispose();
        tex?.dispose();
      },
    };
  } catch (err) {
    console.warn('[render] prop model failed', kind, err);
    return null;
  }
}

/** Instance tint for a prop (kingdom cloth, red Chibi rocks, blossom trees, brightness jitter). */
export function propTint(kind: GlbPropType, p: MapProp, out: THREE.Color): THREE.Color {
  const h = hashString(`${p.x.toFixed(2)},${p.z.toFixed(2)}`);
  const jitter = 0.9 + ((h >>> 8) % 100) / 500;
  if (kind === 'tent') {
    const cloth = p.color ?? (p.variant === 3 ? '#b89a50' : null);
    if (cloth) out.set(cloth).lerp(new THREE.Color(1, 1, 1), 0.25).multiplyScalar(1.25);
    else out.setRGB(1, 1, 1);
    return out;
  }
  if (kind === 'rock' && p.color) return out.set(p.color).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(jitter * 1.5);
  if (kind === 'tree' && p.variant % 6 === 5) return out.setRGB(3.4, 1.25, 3.2).multiplyScalar(jitter); // blossom accent: green leaves → pink
  if (kind === 'tree' || kind === 'pine' || kind === 'bamboo') return out.setRGB(jitter * (0.94 + ((h >>> 16) % 13) / 100), jitter, jitter * 0.95);
  return out.setRGB(jitter, jitter, jitter);
}

export interface PropModelSet {
  group: THREE.Group;
  /** which prop kinds are now drawn by models */
  kinds: Set<GlbPropType>;
  triangles: number;
  instances: number;
  dispose(): void;
}

const CELL = 64;

/**
 * Load the listed models and instance every replaceable prop. Resolves with the
 * built set (kinds whose file failed are simply absent → procedural stays).
 */
export async function buildPropModels(props: readonly MapProp[], mapSize: number, files: ReadonlySet<string>, isDisposed: () => boolean): Promise<PropModelSet | null> {
  const wanted = new Set<GlbPropType>();
  for (const p of props) {
    const k = glbPropKind(p);
    if (k && files.has(propModelPath(k))) wanted.add(k);
  }
  if (!wanted.size) return null;
  const models = await Promise.all([...wanted].map((k) => loadModel(k)));
  if (isDisposed()) {
    for (const m of models) m?.dispose();
    return null;
  }
  const group = new THREE.Group();
  group.name = 'propModels';
  const half = mapSize / 2;
  const kinds = new Set<GlbPropType>();
  let triangles = 0;
  let instances = 0;
  const m4 = new THREE.Matrix4();
  const tint = new THREE.Color();
  const live: PropModel[] = [];
  for (const model of models) {
    if (!model) continue;
    live.push(model);
    kinds.add(model.kind);
    // bucket this kind's props into cells
    const cells = new Map<string, MapProp[]>();
    for (const p of props) {
      if (glbPropKind(p) !== model.kind) continue;
      const key = `${Math.floor((p.x + half) / CELL)},${Math.floor((p.z + half) / CELL)}`;
      let arr = cells.get(key);
      if (!arr) cells.set(key, (arr = []));
      arr.push(p);
    }
    const tris = (model.geometry.index ? model.geometry.index.count : model.geometry.getAttribute('position').count) / 3;
    for (const [key, list] of cells) {
      const mesh = new THREE.InstancedMesh(model.geometry, model.material, list.length);
      mesh.name = `prop_${model.kind}_${key}`;
      list.forEach((p, i) => {
        mesh.setMatrixAt(i, fitPropMatrix(model.kind, p, model.bounds, m4));
        mesh.setColorAt(i, propTint(model.kind, p, tint));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      triangles += tris * list.length;
      instances += list.length;
    }
  }
  return {
    group,
    kinds,
    triangles,
    instances,
    dispose(): void {
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
      for (const m of live) m.dispose();
    },
  };
}

/** Prop types a set of kinds covers entirely (every variant of the type uses a model). */
export function fullyReplacedTypes(kinds: ReadonlySet<GlbPropType>): Set<PropType> {
  const out = new Set<PropType>();
  for (const k of kinds) if (k === 'tree' || k === 'pine' || k === 'bamboo' || k === 'rock' || k === 'crateStack' || k === 'brazier') out.add(k);
  return out;
}
