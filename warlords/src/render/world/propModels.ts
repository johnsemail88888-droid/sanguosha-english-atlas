// AI-art prop models (assets/models/props/<type>.glb): textured static meshes
// drawn instead of the procedural props when the deploy ships them. ONE
// InstancedMesh per model (+ one for its simplified far LOD) for the whole map:
// vegetation and rocks number in the hundreds, and each frame the visible
// instances (camera frustum ∪ sun shadow frustum) are packed into those meshes
// on the CPU (PropCuller) — two draws per kind and pass instead of one per
// 64 m cell, with the same culling.
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
import { texSizesFor, worldArtQuality } from '../core/worldArt';
import { applySkyArtFog, skyArtFogKey } from '../core/skyArtFog';
import { capTexture, sharedGltfLoader, type GltfLoaderLike } from '../core/gltfLoader';

export const GLB_PROP_TYPES = ['tent', 'crateStack', 'barricade', 'rock', 'tree', 'pine', 'bamboo', 'brazier', 'statue', 'sandbags', 'nanmanTent'] as const;
export type GlbPropType = (typeof GLB_PROP_TYPES)[number];

export const propModelPath = (t: GlbPropType): string => `assets/models/props/${t}.glb`;

/**
 * The model that replaces a prop, or null when its variant has a different
 * silhouette than every shipped model. Barricades: v0 sandbag wall → sandbags,
 * v1 拒马 → barricade; the v2 plank palisade keeps its procedural (textured)
 * stakes. Tents: v2 南蛮 hut → nanmanTent. Only the lion statue has a model.
 */
export function glbPropKind(p: MapProp): GlbPropType | null {
  switch (p.type) {
    case 'tent':
      return p.variant === 2 ? 'nanmanTent' : 'tent';
    case 'barricade':
      return p.variant === 1 ? 'barricade' : p.variant === 0 ? 'sandbags' : null;
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
  /** half the instances turned 180° (a curved sandbag wall bows either way) */
  flip?: boolean;
  /** use the prop width for depth too (round plants) */
  round: boolean;
  /** tint mask: 0 whole model, 1 leaves (green texels), 2 cloth recolour (canvas → tint, crimson frame → dark tint) */
  mask: 0 | 1 | 2;
  wind: number;
  /** double-sided (thin leaves / cloth in the model) */
  doubleSided: boolean;
}

const FIT: Record<GlbPropType, FitRule> = {
  tree: { trunkPivot: true, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 1.35, sink: 0.03, yaw: 0, randomYaw: true, round: true, mask: 1, wind: 0.05, doubleSided: true },
  pine: { trunkPivot: true, w: 1.3, d: 1.3, h: 0.95, uniform: false, maxStretch: 1.6, sink: 0.03, yaw: 0, randomYaw: true, round: true, mask: 1, wind: 0.04, doubleSided: true },
  bamboo: { trunkPivot: true, w: 1.05, d: 1.05, h: 1.0, uniform: false, maxStretch: 2.2, sink: 0.08, yaw: 0, randomYaw: true, round: true, mask: 1, wind: 0.07, doubleSided: true },
  rock: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.2, uniform: false, maxStretch: 0, sink: 0.2, yaw: 0, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  // the marquee's roof keeps most of its pitch (its bbox includes the guy ropes: body ≈ 0.75 of the width)
  tent: { trunkPivot: false, w: 1.2, d: 1.2, h: 1.0, uniform: false, maxStretch: 0, sink: 0.01, yaw: Math.PI, randomYaw: false, round: false, mask: 2, wind: 0, doubleSided: true },
  crateStack: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0.01, yaw: 0, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  barricade: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0.03, yaw: 0, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  brazier: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0, yaw: 0, randomYaw: false, round: true, mask: 0, wind: 0, doubleSided: false },
  statue: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: true, maxStretch: 0, sink: 0.01, yaw: Math.PI, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: false },
  // a bowed wall of three bag courses (1 × 0.24 × 0.4): the arc fills the collider's depth,
  // the courses its height (bags ≈ 0.6 × 0.37 m at the usual 3.2 × 1.1 m footprint)
  sandbags: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0.04, yaw: 0, randomYaw: false, flip: true, round: false, mask: 0, wind: 0, doubleSided: false },
  // bamboo hut on a raft floor, door on the model's +Z (the procedural cone tent's door is at −Z);
  // the thatch eaves (≈ 1.4 m up) reach the collider's sides, the walls stand ~0.5 m inside
  nanmanTent: { trunkPivot: false, w: 1.0, d: 1.0, h: 1.0, uniform: false, maxStretch: 0, sink: 0.03, yaw: Math.PI, randomYaw: false, round: false, mask: 0, wind: 0, doubleSided: true },
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
  let yawJ = f.randomYaw ? ((h32 >>> 16) / 65536) * Math.PI * 2 : j2 * 0.06; // small jitter on man-made props
  if (f.flip && (h32 >>> 16) & 1) yawJ += Math.PI;
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
  /** simplified far geometry (shares the vertex attributes), or null */
  lod: THREE.BufferGeometry | null;
  /** camera distance (m) beyond which an instance switches to `lod` */
  lodDistance: number;
  material: THREE.MeshStandardMaterial;
  bounds: ModelBounds;
  dispose(): void;
}

/**
 * Far-LOD plan for a model kind with `tris` triangles: the index ratio to aim
 * for and the switch distance, or null (a kind with few instances, or a model
 * that is already cheap). Vegetation and rocks stand in the hundreds.
 */
export function propLodPlan(kind: GlbPropType, tris: number): { ratio: number; distance: number } | null {
  const dense = kind === 'tree' || kind === 'pine' || kind === 'bamboo' || kind === 'rock' || kind === 'nanmanTent';
  if (!dense) return null;
  const target = kind === 'rock' ? 260 : kind === 'nanmanTent' ? 1500 : 800;
  if (tris < target * 2) return null;
  return { ratio: Math.max(0.04, target / tris), distance: kind === 'rock' ? 38 : kind === 'nanmanTent' ? 45 : 52 };
}

/**
 * Simplification of the NEAR model itself, for a model far denser than it is
 * ever seen (the Nanman hut ships with ~57k triangles of thatch): the index
 * ratio and error bound, or null. Seams are kept (no 'Permissive').
 */
export function propBasePlan(kind: GlbPropType, tris: number): { ratio: number; error: number } | null {
  const cap = kind === 'nanmanTent' ? 9000 : 0;
  if (!cap || tris < cap * 1.5) return null;
  return { ratio: cap / tris, error: 0.02 };
}

type Simplifier = (typeof import('three/addons/libs/meshopt_simplifier.module.js'))['MeshoptSimplifier'];
let simplifierP: Promise<Simplifier | null> | null = null;

function simplifier(): Promise<Simplifier | null> {
  if (!simplifierP) {
    simplifierP = import('three/addons/libs/meshopt_simplifier.module.js')
      .then(async ({ MeshoptSimplifier }) => {
        await MeshoptSimplifier.ready;
        return MeshoptSimplifier.supported === false ? null : MeshoptSimplifier;
      })
      .catch(() => null);
  }
  return simplifierP;
}

/**
 * Simplified index buffer over the same vertices (null when it would not save
 * much). 'Permissive' lets collapses cross UV seams (auto-unwrapped meshes are
 * all seams); 'Prune' drops specks of foliage that vanish at a distance.
 * `keepSeams`: neither (a near model must keep its texture seams).
 */
async function buildPropLod(geo: THREE.BufferGeometry, ratio: number, error = 0.05, keepSeams = false): Promise<THREE.BufferGeometry | null> {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  if (!index || !pos) return null;
  const s = await simplifier();
  if (!s) return null;
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);
  }
  const indices = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
  const target = Math.max(3, Math.floor((index.count * ratio) / 3) * 3);
  let out: Uint32Array | null = null;
  for (const flags of keepSeams ? [[]] : [['Permissive', 'Prune'], ['Prune'], []]) {
    try {
      out = s.simplify(indices, positions, 3, target, error, flags)[0];
      break;
    } catch {
      /* flag not supported by this simplifier build: try the next set */
    }
  }
  if (!out || out.length < 3 || out.length > index.count * 0.7) return null;
  const lod = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) lod.setAttribute(name, geo.getAttribute(name));
  lod.setIndex(new THREE.BufferAttribute(pos.count < 65536 ? Uint16Array.from(out) : out, 1));
  lod.boundingBox = geo.boundingBox;
  lod.boundingSphere = geo.boundingSphere;
  return lod;
}

export type { GltfLoaderLike } from '../core/gltfLoader';
let testLoader: GltfLoaderLike | null = null;

/** Tests: load prop models through `l` instead of GLTFLoader (null: the real loader). */
export function setPropModelLoaderForTests(l: GltfLoaderLike | null): void {
  testLoader = l;
}

function loader(): Promise<GltfLoaderLike> {
  return testLoader ? Promise.resolve(testLoader) : sharedGltfLoader();
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

/**
 * Tent cloth recolour (shader mask 2), shared by the GLSL and its CPU twin
 * clothRecolour(): thresholds work on display-space (≈ sqrt of linear) values
 * of the painted texture — cream canvas, crimson lacquered frame, brown wood.
 */
export const CLOTH = {
  /** display luma window of the canvas */
  canvasLuma: [0.3, 0.5],
  /** display saturation (max − min) / max above which a texel is not canvas */
  canvasSat: [0.18, 0.34],
  /** display saturation window of the frame */
  frameSat: [0.3, 0.5],
  /** red-max hue offset (g − b) / (max − min): the crimson / rose frame sits at ≤ 0, wood at ≈ +0.5 */
  frameHue: [0.08, 0.25],
  /** linear luminance of the painted canvas / frame (shading references) */
  canvasLum: 0.6,
  frameLum: 0.05,
  /** the frame takes this shade of a light cloth colour, a lighter one of a dark cloth */
  frameShade: [0.38, 2.4],
} as const;

const smoothstepJs = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Recolour weights of a painted tent texel (display-space rgb): canvas and frame. */
export function clothMasks(sr: number, sg: number, sb: number): { canvas: number; frame: number } {
  const mx = Math.max(sr, sg, sb);
  const mn = Math.min(sr, sg, sb);
  const sat = (mx - mn) / Math.max(mx, 1e-3);
  const luma = sr * 0.299 + sg * 0.587 + sb * 0.114;
  const canvas = smoothstepJs(CLOTH.canvasLuma[0], CLOTH.canvasLuma[1], luma) * (1 - smoothstepJs(CLOTH.canvasSat[0], CLOTH.canvasSat[1], sat));
  const hue = (sg - sb) / Math.max(mx - mn, 1e-3);
  const frame = (sr >= mx ? 1 : 0) * (1 - smoothstepJs(CLOTH.frameHue[0], CLOTH.frameHue[1], hue)) * smoothstepJs(CLOTH.frameSat[0], CLOTH.frameSat[1], sat);
  return { canvas, frame };
}

/**
 * CPU twin of the tent shader's recolour: the painted texel `c` (linear) with
 * the instance cloth colour `tint` (linear; white = keep the painting), into `out`.
 */
export function clothRecolour(c: THREE.Color, tint: THREE.Color, out: THREE.Color): THREE.Color {
  out.copy(c);
  if (Math.abs(tint.r - 1) + Math.abs(tint.g - 1) + Math.abs(tint.b - 1) < 0.003) return out;
  const { canvas, frame } = clothMasks(Math.sqrt(Math.max(0, c.r)), Math.sqrt(Math.max(0, c.g)), Math.sqrt(Math.max(0, c.b)));
  const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const tl = tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722;
  const kc = Math.min(1.25, Math.max(0.35, lum / CLOTH.canvasLum));
  const shade = CLOTH.frameShade[1] + (CLOTH.frameShade[0] - CLOTH.frameShade[1]) * smoothstepJs(0.03, 0.12, tl);
  const kf = shade * Math.min(1.4, Math.max(0.5, lum / CLOTH.frameLum));
  out.r += (tint.r * kc - out.r) * canvas;
  out.g += (tint.g * kc - out.g) * canvas;
  out.b += (tint.b * kc - out.b) * canvas;
  out.r += (tint.r * kf - out.r) * frame;
  out.g += (tint.g * kf - out.g) * frame;
  out.b += (tint.b * kf - out.b) * frame;
  return out;
}

const f3 = (v: number): string => v.toFixed(3);

/** Prop material: the model's texture, selective instance tint, wind sway for plants. */
function propMaterial(kind: GlbPropType, map: THREE.Texture | null): THREE.MeshStandardMaterial {
  const f = FIT[kind];
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.86, metalness: 0, side: f.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  m.name = `prop_${kind}`;
  m.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, m);
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
#if ${f.mask} == 2
  // cloth recolour. Classified in display space (the painting's values): the
  // canvas is light and unsaturated, the lacquered frame crimson. With a camp
  // colour (vTint ≠ white) the canvas becomes that colour, shaded by the
  // painted folds, and the frame a dark shade of it; white keeps the painting.
  vec3 sc = sqrt(max(c, vec3(0.0)));
  float smx = max(sc.r, max(sc.g, sc.b));
  float smn = min(sc.r, min(sc.g, sc.b));
  float sat = (smx - smn) / max(smx, 1e-3);
  float luma = dot(sc, vec3(0.299, 0.587, 0.114));
  float canvas = smoothstep(${f3(CLOTH.canvasLuma[0])}, ${f3(CLOTH.canvasLuma[1])}, luma) * (1.0 - smoothstep(${f3(CLOTH.canvasSat[0])}, ${f3(CLOTH.canvasSat[1])}, sat));
  float hue = (sc.g - sc.b) / max(smx - smn, 1e-3);
  float frame = step(smx, sc.r) * (1.0 - smoothstep(${f3(CLOTH.frameHue[0])}, ${f3(CLOTH.frameHue[1])}, hue)) * smoothstep(${f3(CLOTH.frameSat[0])}, ${f3(CLOTH.frameSat[1])}, sat);
  float on = step(0.003, dot(abs(vTint - 1.0), vec3(1.0)));
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float tl = dot(vTint, vec3(0.2126, 0.7152, 0.0722));
  vec3 clothC = vTint * clamp(lum / ${f3(CLOTH.canvasLum)}, 0.35, 1.25);
  float fShade = mix(${f3(CLOTH.frameShade[1])}, ${f3(CLOTH.frameShade[0])}, smoothstep(0.03, 0.12, tl));
  vec3 frameC = vTint * fShade * clamp(lum / ${f3(CLOTH.frameLum)}, 0.5, 1.4);
  c = mix(c, clothC, canvas * on);
  diffuseColor.rgb = mix(c, frameC, frame * on);
#else
#if ${f.mask} == 1
  float mask = smoothstep(0.004, 0.03, c.g - max(c.r, c.b));
#else
  float mask = 1.0;
#endif
  diffuseColor.rgb = mix(c, c * vTint, mask);
#endif
}`,
      );
  };
  m.customProgramCacheKey = () => `prop_${kind}_v2${skyArtFogKey()}`;
  return m;
}

export { capTexture } from '../core/gltfLoader';

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
    const tex = srcMat.map ? capTexture(srcMat.map, texSizesFor(worldArtQuality()).props) : null;
    if (tex) tex.anisotropy = 4;
    const material = propMaterial(kind, tex);
    // the loader's own geometry / material are no longer needed
    found.geometry.dispose();
    srcMat.dispose();
    let tris = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
    const base = propBasePlan(kind, tris);
    if (base) {
      const simple = await buildPropLod(geometry, base.ratio, base.error, true).catch(() => null);
      if (simple?.index) {
        geometry.setIndex(simple.index);
        tris = simple.index.count / 3;
      }
    }
    const plan = propLodPlan(kind, tris);
    const lod = plan ? await buildPropLod(geometry, plan.ratio).catch(() => null) : null;
    return {
      kind,
      geometry,
      lod,
      lodDistance: plan?.distance ?? Infinity,
      material,
      bounds,
      dispose(): void {
        lod?.dispose();
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
    // the camp colour replaces the painted canvas (shader mask 2); white keeps the painting
    const cloth = p.color ?? (p.variant === 3 ? '#b89a50' : null);
    if (cloth) out.set(cloth).multiplyScalar(0.95 + ((h >>> 8) % 100) / 1000);
    else out.setRGB(1, 1, 1);
    return out;
  }
  if (kind === 'rock' && p.color) return out.set(p.color).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(jitter * 1.5);
  if (kind === 'tree' && p.variant % 6 === 5) return out.setRGB(3.4, 1.25, 3.2).multiplyScalar(jitter); // blossom accent: green leaves → pink
  if (kind === 'tree' || kind === 'pine' || kind === 'bamboo') return out.setRGB(jitter * (0.94 + ((h >>> 16) % 13) / 100), jitter, jitter * 0.95);
  // the crate / barricade textures are painted very dark: lift them to the procedural props' value
  const lift = kind === 'crateStack' ? 1.9 : kind === 'barricade' ? 1.25 : 1;
  return out.setRGB(jitter * lift, jitter * lift, jitter * lift);
}

export interface PropModelSet {
  group: THREE.Object3D;
  /** which prop kinds are now drawn by models */
  kinds: Set<GlbPropType>;
  triangles: number;
  instances: number;
  /** instances drawn with the full / the far model after the last cull (dev overlay / perf reports) */
  lodStats(): { near: number; far: number; nearTris: number; farTris: number };
  dispose(): void;
}

const _sphere = new THREE.Sphere();
const _mat = new THREE.Matrix4();

/** True when the sphere (cx, cy, cz, r) is not entirely outside one of the frustum's planes. */
function sphereInFrustum(f: THREE.Frustum, cx: number, cy: number, cz: number, r: number): boolean {
  const planes = f.planes;
  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    if (p.normal.x * cx + p.normal.y * cy + p.normal.z * cz + p.constant < -r) return false;
  }
  return true;
}

/**
 * One InstancedMesh drawing a packed subset of a batch's instances. The
 * buffers are re-uploaded (the used prefix only) when the subset changes.
 */
class PackedMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly ids: Int32Array;
  n = 0;
  private uploaded = -1;
  private dirty = true;

  constructor(geo: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string, shadow: boolean) {
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.name = name;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // culled per instance by the batch: the whole-map mesh is never culled as one object
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = !shadow;
    mesh.count = 0;
    mesh.visible = false;
    this.mesh = mesh;
    this.ids = new Int32Array(capacity);
  }

  /** Start a new subset. */
  reset(): void {
    this.dirty = false;
    this.n = 0;
  }

  push(i: number): void {
    if (this.n >= this.uploaded || this.ids[this.n] !== i) this.dirty = true;
    this.ids[this.n++] = i;
  }

  /** Upload the subset if it changed; true when drawn. */
  commit(mats: Float32Array, cols: Float32Array): boolean {
    const n = this.n;
    if (this.dirty || n !== this.uploaded) {
      this.uploaded = n;
      const mesh = this.mesh;
      const m = mesh.instanceMatrix.array as Float32Array;
      const c = mesh.instanceColor!.array as Float32Array;
      for (let k = 0; k < n; k++) {
        const i = this.ids[k];
        for (let j = 0; j < 16; j++) m[k * 16 + j] = mats[i * 16 + j];
        c[k * 3] = cols[i * 3];
        c[k * 3 + 1] = cols[i * 3 + 1];
        c[k * 3 + 2] = cols[i * 3 + 2];
      }
      mesh.count = n;
      if (n) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, n * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    }
    return n > 0;
  }
}

/**
 * Every instance of one prop kind on the map: the full model near the camera,
 * the simplified one (if any) beyond its LOD distance — each as a colour-pass
 * mesh (instances in the view frustum) and a shadow-pass mesh (instances in
 * the sun's shadow frustum), so neither pass draws the other's instances. No
 * allocation after construction.
 */
export class PropBatch {
  readonly kind: GlbPropType;
  readonly count: number;
  /** colour pass: full / far model */
  readonly near: THREE.InstancedMesh;
  readonly far: THREE.InstancedMesh | null;
  /** shadow pass (drawn only into the shadow map, see PropCuller) */
  readonly nearShadow: THREE.InstancedMesh;
  readonly farShadow: THREE.InstancedMesh | null;
  private readonly packs: PackedMesh[];
  private readonly mats: Float32Array;
  private readonly cols: Float32Array;
  /** world bounding sphere per instance: x, y, z, r */
  private readonly spheres: Float32Array;
  private readonly dist2: number;
  private shadowOn = false;

  constructor(model: PropModel, list: readonly MapProp[]) {
    this.kind = model.kind;
    const n = list.length;
    this.count = n;
    this.mats = new Float32Array(n * 16);
    this.cols = new Float32Array(n * 3);
    this.spheres = new Float32Array(n * 4);
    if (!model.geometry.boundingSphere) model.geometry.computeBoundingSphere();
    const bs = model.geometry.boundingSphere!;
    const tint = new THREE.Color();
    list.forEach((p, i) => {
      fitPropMatrix(model.kind, p, model.bounds, _mat).toArray(this.mats, i * 16);
      propTint(model.kind, p, tint).toArray(this.cols, i * 3);
      _sphere.copy(bs).applyMatrix4(_mat);
      this.spheres[i * 4] = _sphere.center.x;
      this.spheres[i * 4 + 1] = _sphere.center.y;
      this.spheres[i * 4 + 2] = _sphere.center.z;
      this.spheres[i * 4 + 3] = _sphere.radius;
    });
    this.dist2 = model.lod ? model.lodDistance * model.lodDistance : Infinity;
    const k = model.kind;
    const lod = model.lod;
    this.packs = [
      new PackedMesh(model.geometry, model.material, n, `prop_${k}`, false),
      new PackedMesh(lod ?? model.geometry, model.material, lod ? n : 0, `prop_${k}_far`, false),
      new PackedMesh(model.geometry, model.material, n, `prop_${k}_shadow`, true),
      new PackedMesh(lod ?? model.geometry, model.material, lod ? n : 0, `prop_${k}_far_shadow`, true),
    ];
    this.near = this.packs[0].mesh;
    this.far = lod ? this.packs[1].mesh : null;
    this.nearShadow = this.packs[2].mesh;
    this.farShadow = lod ? this.packs[3].mesh : null;
  }

  /** The meshes to add to the scene (colour pass first, then shadow pass). */
  meshes(): THREE.InstancedMesh[] {
    return [this.near, this.far, this.nearShadow, this.farShadow].filter((m): m is THREE.InstancedMesh => m !== null);
  }

  /**
   * Pack the instances in `view` into the colour-pass meshes and those in
   * `shadow` (null: no shadows) into the shadow-pass ones; (cx, cz) is the
   * camera position for the LOD split. Leaves the shadow meshes hidden: see
   * showShadows().
   */
  cull(view: THREE.Frustum, shadow: THREE.Frustum | null, cx: number, cz: number): void {
    const s = this.spheres;
    const [vn, vf, sn, sf] = this.packs;
    for (const p of this.packs) p.reset();
    for (let i = 0; i < this.count; i++) {
      const x = s[i * 4];
      const y = s[i * 4 + 1];
      const z = s[i * 4 + 2];
      const r = s[i * 4 + 3];
      const inView = sphereInFrustum(view, x, y, z, r);
      const inShadow = shadow !== null && sphereInFrustum(shadow, x, y, z, r);
      if (!inView && !inShadow) continue;
      const dx = x - cx;
      const dz = z - cz;
      const near = dx * dx + dz * dz < this.dist2;
      if (inView) (near ? vn : vf).push(i);
      if (inShadow) (near ? sn : sf).push(i);
    }
    this.near.visible = vn.commit(this.mats, this.cols);
    if (this.far) this.far.visible = vf.commit(this.mats, this.cols);
    this.shadowOn = shadow !== null;
    sn.commit(this.mats, this.cols);
    if (this.farShadow) sf.commit(this.mats, this.cols);
    this.nearShadow.visible = false;
    if (this.farShadow) this.farShadow.visible = false;
  }

  /** Called once the colour pass has been projected: the shadow meshes draw into the shadow map only. */
  showShadows(): void {
    this.nearShadow.visible = this.shadowOn && this.nearShadow.count > 0;
    if (this.farShadow) this.farShadow.visible = this.shadowOn && this.farShadow.count > 0;
  }

  /** Draw every instance with the full model in both passes (tests / tools). */
  showAll(): void {
    const [vn, vf, sn, sf] = this.packs;
    for (const p of this.packs) p.reset();
    for (let i = 0; i < this.count; i++) {
      vn.push(i);
      sn.push(i);
    }
    this.near.visible = vn.commit(this.mats, this.cols);
    if (this.far) this.far.visible = vf.commit(this.mats, this.cols);
    this.nearShadow.visible = sn.commit(this.mats, this.cols);
    if (this.farShadow) this.farShadow.visible = sf.commit(this.mats, this.cols);
  }

  dispose(): void {
    for (const m of this.meshes()) m.dispose();
  }
}

const _view = new THREE.Frustum();

/**
 * Last child of the PropCuller: projected after the colour-pass meshes (which
 * the renderer has listed by then) and before the shadow pass, it reveals the
 * shadow-pass meshes — so they are drawn into the shadow map only.
 */
class ShadowGate extends THREE.LOD {
  constructor(private readonly culler: PropCuller) {
    super();
    this.autoUpdate = true;
    this.name = 'propShadowGate';
  }

  override update(): this {
    for (const b of this.culler.batches) b.showShadows();
    return this;
  }
}

/**
 * The prop-model group: a THREE.LOD only so the renderer calls update(camera)
 * while projecting the scene (before its own culling and before the shadow
 * pass), where every batch is culled against the camera and the sun's shadow
 * frustum (the scene's shadow-casting directional light, found once).
 */
export class PropCuller extends THREE.LOD {
  readonly batches: PropBatch[] = [];
  private readonly gate = new ShadowGate(this);
  private sun: THREE.DirectionalLight | null = null;
  private sunLooked = false;

  constructor() {
    super();
    this.autoUpdate = true;
    this.add(this.gate);
  }

  addBatch(b: PropBatch): void {
    this.batches.push(b);
    for (const m of b.meshes()) this.add(m);
    // keep the gate last in the traversal order
    this.remove(this.gate);
    this.add(this.gate);
  }

  private shadowLight(): THREE.DirectionalLight | null {
    if (this.sunLooked) return this.sun;
    let root: THREE.Object3D = this;
    while (root.parent) root = root.parent;
    if (!(root as THREE.Scene).isScene) return null; // not in a scene yet: look again next time
    this.sunLooked = true;
    for (const o of root.children) {
      if ((o as THREE.DirectionalLight).isDirectionalLight) {
        this.sun = o as THREE.DirectionalLight;
        break;
      }
    }
    return this.sun;
  }

  override update(camera: THREE.Camera): this {
    _mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _view.setFromProjectionMatrix(_mat);
    const sun = this.shadowLight();
    let shadow: THREE.Frustum | null = null;
    if (sun && sun.castShadow) {
      // the shadow pass computes the same matrices right after this projection
      sun.shadow.updateMatrices(sun);
      shadow = sun.shadow.getFrustum();
    }
    const e = camera.matrixWorld.elements;
    for (const b of this.batches) b.cull(_view, shadow, e[12], e[14]);
    return this;
  }

  override dispose(): void {
    for (const b of this.batches) b.dispose();
  }
}

/**
 * Load the listed models and instance every replaceable prop. Resolves with the
 * built set (kinds whose file failed are simply absent → procedural stays).
 */
export async function buildPropModels(props: readonly MapProp[], _mapSize: number, files: ReadonlySet<string>, isDisposed: () => boolean): Promise<PropModelSet | null> {
  const wanted = new Set<GlbPropType>();
  for (const p of props) {
    const k = glbPropKind(p);
    if (k && files.has(propModelPath(k))) wanted.add(k);
  }
  if (!wanted.size) return null;
  const models = await Promise.all([...wanted].map((k) => loadModel(k)));
  if (isDisposed() || models.every((m) => !m)) {
    for (const m of models) m?.dispose();
    return null;
  }
  const culler = new PropCuller();
  culler.name = 'propModels';
  const kinds = new Set<GlbPropType>();
  let triangles = 0;
  let instances = 0;
  const live: PropModel[] = [];
  const tris = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  for (const model of models) {
    if (!model) continue;
    live.push(model);
    kinds.add(model.kind);
    const list = props.filter((p) => glbPropKind(p) === model.kind);
    if (!list.length) continue;
    culler.addBatch(new PropBatch(model, list));
    triangles += tris(model.geometry) * list.length;
    instances += list.length;
  }
  return {
    group: culler,
    kinds,
    triangles,
    instances,
    dispose(): void {
      culler.dispose();
      for (const m of live) m.dispose();
    },
    lodStats(): { near: number; far: number; nearTris: number; farTris: number } {
      const st = { near: 0, far: 0, nearTris: 0, farTris: 0 };
      for (const b of culler.batches) {
        st.near += b.near.count;
        st.nearTris += b.near.count * tris(b.near.geometry);
        if (b.far) {
          st.far += b.far.count;
          st.farTris += b.far.count * tris(b.far.geometry);
        }
      }
      return st;
    },
  };
}

/** Prop types a set of kinds covers entirely (every variant of the type uses a model). */
export function fullyReplacedTypes(kinds: ReadonlySet<GlbPropType>): Set<PropType> {
  const out = new Set<PropType>();
  for (const k of kinds) if (k === 'tree' || k === 'pine' || k === 'bamboo' || k === 'rock' || k === 'crateStack' || k === 'brazier') out.add(k);
  return out;
}
