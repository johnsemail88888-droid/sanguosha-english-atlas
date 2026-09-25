// AI-generated character bodies (public/assets/models/**, see src/game/assets.ts):
// one GLB per hero (heroes/<id>.glb), per kingdom troop (troops/<kingdom>.glb) and
// per neutral NPC camp (troops/npc_yellowTurban.glb, troops/npc_barbarian.glb).
// Each is a Meshy auto-rig: ONE SkinnedMesh + ONE textured material, the same
// 24-joint skeleton names in every file, 1.7 m tall at load, feet at y≈0, facing +Z.
//
// Loading: one shared GLTFLoader (+ MeshoptDecoder: the files use
// EXT_meshopt_compression / KHR_mesh_quantization / EXT_texture_webp). Every file
// is fetched and prepared ONCE (CharTemplate, with a meshoptimizer far LOD);
// each character on screen is a SkeletonUtils clone sharing geometry, texture
// and base material (models/glbBody.ts). Templates are reference-counted by
// their bodies; evictUnusedTemplates() frees the unused ones (end of a match,
// gallery turntable closed). The match's files are preloaded on the loading
// screen (models/preload.ts, GameRenderer.warmup).
//
// Availability comes from the asset listing (no 404 probes); registerHeroGlb()
// overrides a hero's file (mods, tests, blob: URLs). The single-file build has
// no listing → no templates → every character stays procedural.
//
// Preparation per file (the rig quirks the animation code relies on):
//   - the Hips joint of each auto-rig has an arbitrary rest orientation (it has
//     three children, so the rigger picks any frame); it is re-oriented to the
//     canonical identity frame (children and the Hips bind matrix compensate, the
//     skinned result is unchanged) so the shared animation clips — retargeted to
//     the same canonical frame in anim/glbClips.ts — drive every model alike;
//   - capes / robes the auto-rigger skinned to the arms and legs are moved to
//     the torso and to two damped thigh followers (remapClothWeights, below);
//   - the loader's MeshPhysicalMaterial (emissive = base colour, metallic 1,
//     KHR_materials_specular) is replaced by a plain lit MeshStandardMaterial.
import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetList, assetListSync } from '../../game/assets';
import { CHARACTER_FOG_MAX } from '../core/materials';
import { useSkyArtFog } from '../core/skyArtFog';

/** Nominal height of every hero (m): the sim's 1.8 m capsule (sim/physics CHAR_HEIGHT). */
export const GLB_HERO_HEIGHT = 1.8;

/** Where each landmark sits on a reference 1.7 m model (fraction of body height): see normalizeScale. */
export const REF_HEAD_JOINT = 0.892;
export const REF_HIPS = 0.544;

/** Every joint name of the shared auto-rig skeleton. */
export const RIG_BONES = [
  'Hips',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'Spine02',
  'Spine01',
  'Spine',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'neck',
  'Head',
  'head_end',
  'headfront',
] as const;
export type RigBone = (typeof RIG_BONES)[number];

/** Rest measurements of a model at load scale (m, feet at 0). */
export interface RigLandmarks {
  /** bounding-box height (includes hats, plumes, weapons baked into the mesh) */
  bboxH: number;
  hipsY: number;
  /** the neck → head joint */
  headY: number;
  /** tip of the head joint chain (top of the hair / helmet) */
  headTopY: number;
}

/**
 * Uniform scale that makes a model `targetH` metres tall. Three estimates —
 * bounding box, head joint and hip height against a reference model — and
 * their median: a tall plume (吕布) or hat inflates the box but not the joints,
 * a rig with a misplaced neck joint moves one joint but not the box.
 */
export function normalizeScale(lm: RigLandmarks, targetH: number): number {
  const est: number[] = [];
  if (lm.bboxH > 0.2) est.push(targetH / lm.bboxH);
  if (lm.headY > 0.2) est.push((targetH * REF_HEAD_JOINT) / lm.headY);
  if (lm.hipsY > 0.1) est.push((targetH * REF_HIPS) / lm.hipsY);
  if (!est.length) return 1;
  est.sort((a, b) => a - b);
  return est.length === 2 ? (est[0] + est[1]) / 2 : est[Math.floor(est.length / 2)];
}

export interface CharTemplate {
  readonly url: string;
  /** prepared scene (never added to a scene itself; instances are clones) */
  readonly scene: THREE.Object3D;
  readonly mesh: THREE.SkinnedMesh;
  /** base material shared by every instance's clone (holds the texture) */
  readonly material: THREE.MeshStandardMaterial;
  /** rest local transforms per bone name (armature units, Hips canonicalised) */
  readonly rest: ReadonlyMap<string, { p: THREE.Vector3; q: THREE.Quaternion }>;
  /** armature unit → metres at load scale (the Armature node's scale, 0.01 for centimetre rigs) */
  readonly unit: number;
  readonly landmarks: RigLandmarks;
  /** SkeletonUtils.clone (loaded with the template, so instancing is synchronous) */
  readonly cloneScene: (o: THREE.Object3D) => THREE.Object3D;
  /**
   * Far LOD: the same vertex buffers with a simplified index buffer
   * (meshoptimizer; ~55 % of the triangles — UV seams are kept), for characters
   * far from the camera. Null when simplification is unavailable.
   */
  lod: THREE.BufferGeometry | null;
}

/** Triangle target of the far LOD (fraction of the full mesh; seams usually stop it earlier). */
export const LOD_RATIO = 0.25;

// ── asset paths ──────────────────────────────────────────────────────────────

export const heroModelPath = (heroId: string): string => `assets/models/heroes/${heroId}.glb`;

/**
 * Model file for a troop / NPC: the neutral camps have their own soldiers
 * (黄巾 turbans — also the 黄巾力士 of the Qun roster —, 南蛮 feather crowns and
 * the war-elephant riders), every other unit wears its kingdom's troop model.
 */
export function troopModelPath(opts: { headgear?: string; kingdom?: string; id?: string }): string {
  const id = (opts.id ?? '').toLowerCase();
  if (opts.headgear === 'turban' || id.includes('turban')) return 'assets/models/troops/npc_yellowTurban.glb';
  if (opts.headgear === 'featherCrown' || id.includes('barbarian') || id.includes('nanman') || id.includes('elephant')) return 'assets/models/troops/npc_barbarian.glb';
  const k = opts.kingdom === 'shu' || opts.kingdom === 'wei' || opts.kingdom === 'wu' || opts.kingdom === 'qun' ? opts.kingdom : 'qun';
  return `assets/models/troops/${k}.glb`;
}

const registered = new Map<string, string>();

/** Use this GLB (any URL, incl. blob:) for a hero from now on. Affects models created afterwards. */
export function registerHeroGlb(heroId: string, url: string): void {
  const path = heroModelPath(heroId);
  registered.set(path, url);
  templates.delete(path);
  ready.delete(path);
}

/** URL of a model file, synchronously: a registered override, or the shipped file once the listing is loaded (else null). */
export function modelUrlSync(path: string): string | null {
  const reg = registered.get(path);
  if (reg) return reg;
  const list = assetListSync();
  return list && list.has(path) ? path : null;
}

/** URL of a model file (null when this deploy ships none). */
export async function modelUrl(path: string): Promise<string | null> {
  const reg = registered.get(path);
  if (reg) return reg;
  return (await assetList()).has(path) ? path : null;
}

/** Where the GLB for a hero lives, or null when there is none. */
export function resolveHeroGlbUrl(heroId: string): Promise<string | null> {
  return modelUrl(heroModelPath(heroId));
}

// ── loader ───────────────────────────────────────────────────────────────────

interface SharedGltf {
  loader: GLTFLoader;
  clone: (o: THREE.Object3D) => THREE.Object3D;
}
let loaderP: Promise<SharedGltf> | null = null;

/** The shared GLTFLoader (meshopt-enabled) + SkeletonUtils.clone, imported on first use. */
export function sharedGltf(): Promise<SharedGltf> {
  if (!loaderP) {
    const p = (async (): Promise<SharedGltf> => {
      const [{ GLTFLoader }, { MeshoptDecoder }, skel] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
        import('three/addons/utils/SkeletonUtils.js'),
      ]);
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      return { loader, clone: skel.clone };
    })();
    loaderP = p;
    // a failed import (offline chunk) must not poison later attempts
    p.catch(() => {
      if (loaderP === p) loaderP = null;
    });
  }
  return loaderP;
}

/** Load a GLB into memory (rejects on failure). */
export async function loadGltf(url: string): Promise<GLTF> {
  const { loader } = await sharedGltf();
  return loader.loadAsync(url);
}

// ── templates ────────────────────────────────────────────────────────────────

const templates = new Map<string, Promise<CharTemplate | null>>();
const ready = new Map<string, CharTemplate | null>();
let warnedOnce = false;

/**
 * Re-orient the Hips joint to the identity frame without changing the skinned
 * result: its children and its bind (inverse) matrix absorb the old rotation.
 */
export function canonicaliseHips(mesh: THREE.SkinnedMesh): void {
  const bones = mesh.skeleton.bones;
  const i = bones.findIndex((b) => b.name === 'Hips');
  if (i < 0) return;
  const hips = bones[i];
  const H = hips.quaternion.clone();
  if (Math.abs(H.w) > 0.999999) return;
  for (const c of hips.children) {
    c.position.applyQuaternion(H);
    c.quaternion.premultiply(H);
  }
  hips.quaternion.identity();
  // new bind matrix = old · H⁻¹ (a rotation about the Hips pivot) → its inverse = H · old⁻¹
  mesh.skeleton.boneInverses[i] = mesh.skeleton.boneInverses[i].clone().premultiply(new THREE.Matrix4().makeRotationFromQuaternion(H));
  hips.updateMatrixWorld(true);
}

// ── cloth ────────────────────────────────────────────────────────────────────
//
// The auto-rigger skins long capes, robes and skirts to whichever limb is
// nearest in its heat map: 赵云's and 周瑜's capes hang from the UPPER ARMS
// (they swing up into a sail whenever the rifle is raised) and every robe hem
// follows the thighs and shins at full amplitude (a run or a roll stretches it
// into big sheets). remapClothWeights() moves those weights, per vertex and
// once per model, to where cloth belongs:
//   - a limb weight on a vertex far from that limb's bone chain (a cape behind
//     the back, a robe hem well outside the leg) is cloth;
//   - arm cloth goes to the torso joint at its height (above the pelvis) or
//     to the thigh followers (below it);
//   - leg cloth goes to its side's thigh follower: an extra joint (CLOTH_BONES)
//     beside the thigh that anim/glbAnimator turns by a damped fraction of the
//     thigh's rotation (CLOTH_FOLLOW), with a little lag.
// Sleeves (near the forearm, not behind the back), trousers and armour plates
// close to the leg keep their weights. The rest pose is unchanged (every bone
// is at its bind transform there), only the motion of the moved vertices is.

/** Visual A/B switch (tests, QA harness): models loaded while false keep the auto-rig weights. */
export const clothRemapOptions = { enabled: true };
/** Thigh followers added to a model whose cloth was remapped (animated by anim/glbAnimator). */
export const CLOTH_BONES = { Left: 'LeftCloth', Right: 'RightCloth' } as const;
/** [start, full] distance (m on a 1.7 m model) from the leg chain beyond which a leg weight is cloth. */
export const CLOTH_LEG_R: readonly [number, number] = [0.11, 0.2];
/** Same for the shoulder / upper-arm weights. */
export const CLOTH_ARM_R: readonly [number, number] = [0.22, 0.32];
/** Same for an upper-arm weight on a vertex behind the back (a cape draped over the arm, not the arm). */
export const CLOTH_ARM_BACK_R: readonly [number, number] = [0.07, 0.14];
/** Same for the forearm / hand weights, which are cloth only behind the back (sleeves hang beside the arm). */
export const CLOTH_FOREARM_R: readonly [number, number] = [0.25, 0.35];
/** [start, full] depth (m) behind the spine line from which a vertex counts as behind the back. */
export const CLOTH_BEHIND: readonly [number, number] = [0.06, 0.12];

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Distance from `p` to a polyline. */
export function distToChain(p: THREE.Vector3, pts: readonly THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const l2 = abx * abx + aby * aby + abz * abz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2)) : 0;
    const dx = p.x - (a.x + abx * t);
    const dy = p.y - (a.y + aby * t);
    const dz = p.z - (a.z + abz * t);
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return best;
}

/**
 * Keep the four largest influences, normalised; for normalised integer weight
 * arrays the quantised weights sum exactly to 1 (largest remainder), so no
 * vertex drifts from rounding.
 */
export function topInfluences(idx: number[], w: number[], normalizedMax: number): { idx: number[]; w: number[] } {
  const order = idx.map((_, i) => i).sort((a, b) => w[b] - w[a]);
  const keep = order.slice(0, 4).filter((i) => w[i] > 0);
  const sum = keep.reduce((s, i) => s + w[i], 0) || 1;
  const outIdx = [0, 0, 0, 0];
  const outW = [0, 0, 0, 0];
  keep.forEach((i, k) => {
    outIdx[k] = idx[i];
    outW[k] = w[i] / sum;
  });
  if (normalizedMax > 0) {
    const raw = outW.map((x) => x * normalizedMax);
    const q = raw.map(Math.floor);
    let left = normalizedMax - q.reduce((s, x) => s + x, 0);
    const byRem = [0, 1, 2, 3].sort((a, b) => raw[b] - q[b] - (raw[a] - q[a]));
    for (const k of byRem) {
      if (left <= 0) break;
      if (k < keep.length) {
        q[k]++;
        left--;
      }
    }
    for (let k = 0; k < 4; k++) outW[k] = q[k] / normalizedMax;
  }
  return { idx: outIdx, w: outW };
}

/**
 * Average per-vertex fields over the vertices within `radius` (linear falloff):
 * a cape is a thin shell, and its inner and outer layers (a few cm apart) must
 * get the same share or they separate when the limb moves. `need` (bit f =
 * field f) limits the work to the vertices and fields that are used.
 */
export function blurFields(px: Float32Array, fields: Float32Array[], radius: number, need?: Uint8Array): void {
  const n = px.length / 3;
  if (!n || !(radius > 0)) return;
  const inv = 1 / radius;
  // dense grid of radius-sized cells (counting sort: cellStart[c] .. cellStart[c + 1] in `order`)
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = px[i * 3];
    const y = px[i * 3 + 1];
    const z = px[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const nx = Math.floor((maxX - minX) * inv) + 1;
  const ny = Math.floor((maxY - minY) * inv) + 1;
  const nz = Math.floor((maxZ - minZ) * inv) + 1;
  if (nx * ny * nz > 4e6) return; // degenerate scale: leave the fields as they are
  const cell = new Int32Array(n);
  const cellStart = new Int32Array(nx * ny * nz + 1);
  for (let i = 0; i < n; i++) {
    const c = (Math.floor((px[i * 3] - minX) * inv) * ny + Math.floor((px[i * 3 + 1] - minY) * inv)) * nz + Math.floor((px[i * 3 + 2] - minZ) * inv);
    cell[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < nx * ny * nz; c++) cellStart[c + 1] += cellStart[c];
  const fill = cellStart.slice(0, nx * ny * nz);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[cell[i]]++] = i;
  const src = fields.map((f) => f.slice());
  const nf = fields.length;
  const acc = new Float64Array(nf);
  const r2 = radius * radius;
  for (let i = 0; i < n; i++) {
    const mask = need ? need[i] : 0xff;
    if (!mask) continue;
    acc.fill(0);
    let wsum = 0;
    const x = px[i * 3];
    const y = px[i * 3 + 1];
    const z = px[i * 3 + 2];
    const cx = Math.floor((x - minX) * inv);
    const cy = Math.floor((y - minY) * inv);
    const cz = Math.floor((z - minZ) * inv);
    for (let ix = Math.max(0, cx - 1); ix <= Math.min(nx - 1, cx + 1); ix++)
      for (let iy = Math.max(0, cy - 1); iy <= Math.min(ny - 1, cy + 1); iy++) {
        const row = (ix * ny + iy) * nz;
        const from = cellStart[row + Math.max(0, cz - 1)];
        const to = cellStart[row + Math.min(nz - 1, cz + 1) + 1];
        for (let o = from; o < to; o++) {
          const j = order[o];
          const ex = px[j * 3] - x;
          const ey = px[j * 3 + 1] - y;
          const ez = px[j * 3 + 2] - z;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 > r2) continue;
          const w = 1 - Math.sqrt(d2) * inv;
          wsum += w;
          for (let f = 0; f < nf; f++) if (mask & (1 << f)) acc[f] += src[f][j] * w;
        }
      }
    if (wsum > 0) for (let f = 0; f < nf; f++) if (mask & (1 << f)) fields[f][i] = acc[f] / wsum;
  }
}

/** Height (m on a 1.7 m model) below the Hips joint over which arm cloth fades from the pelvis into the thigh followers. */
export const CLOTH_HIPS_BLEND = 0.14;
/** Radius (m on a 1.7 m model) over which the cloth shares are smoothed (see blurFields). */
export const CLOTH_BLUR = 0.04;

/**
 * Move cloth weights off the limbs (see above). `refScale` converts load
 * metres to a 1.7 m reference body. Adds the CLOTH_BONES (children of the
 * Hips, at the thighs' rest transforms) when anything moved. Returns the
 * number of vertices changed.
 */
export function remapClothWeights(mesh: THREE.SkinnedMesh, refScale = 1): number {
  const skel = mesh.skeleton;
  const bones = skel.bones;
  const index = new Map(bones.map((b, i) => [b.name, i]));
  if (index.has(CLOTH_BONES.Left)) return 0;
  const sides = ['Left', 'Right'] as const;
  const joints = ['Hips', 'Spine02', 'Spine01', 'Spine'];
  for (const s of sides) for (const j of ['UpLeg', 'Leg', 'Foot', 'Shoulder', 'Arm', 'ForeArm', 'Hand']) joints.push(s + j);
  for (const j of joints) if (!index.has(j)) return 0;
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  if (!pos || !si || !sw) return 0;
  let top: THREE.Object3D = mesh;
  while (top.parent) top = top.parent;
  top.updateMatrixWorld(true);
  const at = (n: string): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(bones[index.get(n)!].matrixWorld);
  const legChain: THREE.Vector3[][] = [];
  const armChain: THREE.Vector3[][] = [];
  for (const s of sides) {
    legChain.push(['UpLeg', 'Leg', 'Foot', ...(index.has(`${s}ToeBase`) ? ['ToeBase'] : [])].map((j) => at(s + j)));
    const arm = ['Shoulder', 'Arm', 'ForeArm', 'Hand'].map((j) => at(s + j));
    // the hand itself reaches past its joint
    arm.push(arm[3].clone().sub(arm[2]).multiplyScalar(0.45).add(arm[3]));
    armChain.push(arm);
  }
  const hips = at('Hips');
  const torso = (['Spine02', 'Spine01', 'Spine'] as const).map((n) => ({ i: index.get(n)!, p: at(n) }));
  // what each limb joint is: 0 none, 1 leg, 2 shoulder / upper arm, 3 forearm / hand; side 0 left, 1 right
  const kind = new Int8Array(bones.length);
  const side = new Int8Array(bones.length);
  bones.forEach((b, i) => {
    const sd = b.name.startsWith('Left') ? 0 : b.name.startsWith('Right') ? 1 : -1;
    if (sd < 0) return;
    const j = b.name.slice(sd === 0 ? 4 : 5);
    kind[i] = j === 'UpLeg' || j === 'Leg' || j === 'Foot' || j === 'ToeBase' ? 1 : j === 'Shoulder' || j === 'Arm' ? 2 : j === 'ForeArm' || j === 'Hand' ? 3 : 0;
    side[i] = sd;
  });

  // 1. rest positions (load metres) and the geometric cloth shares, per limb kind and side
  const n = pos.count;
  const px = new Float32Array(n * 3);
  // fields: [leg L, leg R, upper arm L, upper arm R, forearm L, forearm R]
  const fields = Array.from({ length: 6 }, () => new Float32Array(n));
  const need = new Uint8Array(n);
  // rest skinning matrices, once per bone (mesh.applyBoneTransform rebuilds them per influence)
  const toWorld = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
  const boneMats = bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(toWorld, new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skel.boneInverses[i])).multiply(mesh.bindMatrix));
  const v = new THREE.Vector3();
  const base = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    base.fromBufferAttribute(pos, i);
    v.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const wk = sw.getComponent(i, k);
      if (wk <= 0) continue;
      const b = si.getComponent(i, k);
      v.addScaledVector(tmp.copy(base).applyMatrix4(boneMats[b]), wk);
      if (kind[b]) need[i] |= 1 << ((kind[b] - 1) * 2 + side[b]);
    }
    px[i * 3] = v.x;
    px[i * 3 + 1] = v.y;
    px[i * 3 + 2] = v.z;
    // the spine line at this height, for "behind the back"
    let spineZ = hips.z;
    for (const t of torso) if (v.y >= t.p.y) spineZ = t.p.z;
    const behind = smoothstep(CLOTH_BEHIND[0], CLOTH_BEHIND[1], (spineZ - v.z) * refScale);
    for (let sd = 0; sd < 2; sd++) {
      fields[sd][i] = smoothstep(CLOTH_LEG_R[0], CLOTH_LEG_R[1], distToChain(v, legChain[sd]) * refScale);
      const d = distToChain(v, armChain[sd]) * refScale;
      // far from the upper arm, or a cape lying over its back (it hangs from the shoulders)
      fields[2 + sd][i] = Math.max(smoothstep(CLOTH_ARM_R[0], CLOTH_ARM_R[1], d), behind * smoothstep(CLOTH_ARM_BACK_R[0], CLOTH_ARM_BACK_R[1], d));
      // forearm / hand: only behind the back (sleeves hang beside the arm)
      fields[4 + sd][i] = smoothstep(CLOTH_FOREARM_R[0], CLOTH_FOREARM_R[1], d) * behind;
    }
  }
  blurFields(px, fields, CLOTH_BLUR / refScale, need);

  // 2. move the weights
  const clothIdx = [bones.length, bones.length + 1];
  const iHips = index.get('Hips')!;
  const normMax = sw.normalized ? (sw.array instanceof Uint8Array ? 255 : sw.array instanceof Uint16Array ? 65535 : 0) : 0;
  const idx: number[] = [];
  const w: number[] = [];
  const add = (b: number, x: number): void => {
    if (x <= 0) return;
    const k = idx.indexOf(b);
    if (k >= 0) w[k] += x;
    else {
      idx.push(b);
      w.push(x);
    }
  };
  // arm cloth hangs from the torso, blended linearly between the joints at its height (a
  // step from one joint to the next would crease the cape where the spine twists); below
  // the pelvis it fades into the thigh followers, by side (the back centre follows both)
  const chainY = [hips.y, ...torso.map((t) => t.p.y)];
  const chainI = [iHips, ...torso.map((t) => t.i)];
  const hipsBlend = CLOTH_HIPS_BLEND / refScale;
  const hang = (x: number, y: number, c: number): void => {
    if (y < hips.y) {
      const t = Math.min(1, (hips.y - y) / hipsBlend);
      const l = smoothstep(-0.08, 0.08, (x - hips.x) * refScale);
      add(clothIdx[0], c * t * l);
      add(clothIdx[1], c * t * (1 - l));
      add(iHips, c * (1 - t));
      return;
    }
    for (let k = 0; k + 1 < chainY.length; k++) {
      if (y < chainY[k + 1]) {
        const t = (y - chainY[k]) / Math.max(1e-6, chainY[k + 1] - chainY[k]);
        add(chainI[k], c * (1 - t));
        add(chainI[k + 1], c * t);
        return;
      }
    }
    add(chainI[chainI.length - 1], c);
  };
  let moved = 0;
  for (let i = 0; i < n; i++) {
    idx.length = 0;
    w.length = 0;
    let changed = false;
    const y = px[i * 3 + 1];
    for (let k = 0; k < 4; k++) {
      const b = si.getComponent(i, k);
      const wk = sw.getComponent(i, k);
      if (wk <= 0) continue;
      const kd = kind[b];
      const f = kd ? fields[(kd - 1) * 2 + side[b]][i] : 0;
      if (f < 0.01) {
        add(b, wk);
        continue;
      }
      changed = true;
      add(b, wk * (1 - f));
      const c = wk * f;
      if (kd === 1) add(clothIdx[side[b]], c);
      else hang(px[i * 3], y, c);
    }
    if (!changed) continue;
    const r = topInfluences(idx, w, normMax);
    for (let k = 0; k < 4; k++) {
      si.setComponent(i, k, r.idx[k]);
      sw.setComponent(i, k, r.w[k]);
    }
    moved++;
  }
  if (!moved) return 0;
  si.needsUpdate = true;
  sw.needsUpdate = true;
  const hipsBone = bones[iHips];
  const extra: THREE.Bone[] = [];
  const extraInv: THREE.Matrix4[] = [];
  for (const s of sides) {
    const thigh = bones[index.get(`${s}UpLeg`)!];
    const c = new THREE.Bone();
    c.name = CLOTH_BONES[s];
    c.position.copy(thigh.position);
    c.quaternion.copy(thigh.quaternion);
    c.scale.copy(thigh.scale);
    hipsBone.add(c);
    extra.push(c);
    // same rest transform as the thigh → same bind inverse
    extraInv.push(skel.boneInverses[index.get(`${s}UpLeg`)!].clone());
  }
  top.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([...bones, ...extra], [...skel.boneInverses, ...extraInv]), mesh.bindMatrix);
  skel.dispose();
  return moved;
}

function prepare(url: string, gltf: GLTF, clone: (o: THREE.Object3D) => THREE.Object3D): CharTemplate | null {
  const scene = gltf.scene;
  let found: THREE.SkinnedMesh | null = null;
  scene.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  const m = found as THREE.SkinnedMesh | null;
  if (!m) return null;
  const names = new Set(m.skeleton.bones.map((b) => b.name));
  for (const b of ['Hips', 'Spine', 'Head', 'RightHand', 'LeftHand', 'LeftFoot', 'RightFoot']) if (!names.has(b)) return null;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const bboxH = box.max.y - box.min.y;
  if (!(bboxH > 1e-3) || !Number.isFinite(bboxH)) return null;
  const yOf = (name: string): number => {
    const b = m.skeleton.bones.find((x) => x.name === name);
    return b ? new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).y - box.min.y : 0;
  };
  const landmarks: RigLandmarks = { bboxH, hipsY: yOf('Hips'), headY: yOf('Head'), headTopY: yOf('head_end') || bboxH };
  // feet on the ground at load
  scene.position.y -= box.min.y;
  canonicaliseHips(m);
  if (clothRemapOptions.enabled) remapClothWeights(m, 1.7 / bboxH);
  const hips = m.skeleton.bones.find((b) => b.name === 'Hips')!;
  const armature = hips.parent;
  const unit = armature ? new THREE.Vector3().setFromMatrixScale(armature.matrixWorld).y : 1;
  const rest = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
  for (const b of m.skeleton.bones) rest.set(b.name, { p: b.position.clone(), q: b.quaternion.clone() });
  // plain lit material: the loader's is emissive = base colour (a flat, unlit look) and fully metallic
  const src = m.material as THREE.MeshStandardMaterial;
  const map = src.map ?? null;
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.78, metalness: 0.04 });
  material.name = 'glbCharacter';
  // fog never hides a character completely (same as the procedural characters)
  material.defines = { FOG_MAX: CHARACTER_FOG_MAX.toFixed(2) };
  // painted-sky fog colour like the world around it (instances clone the hook)
  useSkyArtFog(material, 'glbCharacter');
  src.dispose();
  m.material = material;
  m.castShadow = true;
  m.receiveShadow = false;
  // the clip baked into every file ('Armature|clip0|baselayer', 0.3 s) is unused
  gltf.animations.length = 0;
  return { url, scene, mesh: m, material, rest, unit, landmarks, cloneScene: clone, lod: null };
}

type Simplifier = (typeof import('three/addons/libs/meshopt_simplifier.module.js'))['MeshoptSimplifier'];
let simplifierP: Promise<Simplifier | null> | null = null;

function simplifier(): Promise<Simplifier | null> {
  if (!simplifierP) {
    simplifierP = import('three/addons/libs/meshopt_simplifier.module.js')
      .then(async ({ MeshoptSimplifier }) => {
        await MeshoptSimplifier.ready;
        return MeshoptSimplifier;
      })
      .catch(() => null);
  }
  return simplifierP;
}

/** Far-LOD geometry: shared vertex attributes, simplified index buffer (null when it cannot be built). */
export async function buildLod(geo: THREE.BufferGeometry, ratio = LOD_RATIO): Promise<THREE.BufferGeometry | null> {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  if (!index || !pos || index.count < 300) return null;
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
  // UV seams stay borders (collapsing across them scrambles the texture), which bounds the
  // reduction to roughly half of the triangles on these auto-unwrapped meshes
  const [out] = s.simplify(indices, positions, 3, target, 0.08);
  if (!out.length || out.length >= index.count * 0.85) return null;
  const lod = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) lod.setAttribute(name, geo.getAttribute(name));
  lod.setIndex(new THREE.BufferAttribute(pos.count < 65536 ? Uint16Array.from(out) : out, 1));
  lod.boundingBox = geo.boundingBox;
  lod.boundingSphere = geo.boundingSphere;
  lod.name = `${geo.name}_lod`;
  return lod;
}

/** Load and prepare a character model once (null when absent / broken). */
export function loadCharTemplate(path: string): Promise<CharTemplate | null> {
  let p = templates.get(path);
  if (!p) {
    p = (async (): Promise<CharTemplate | null> => {
      const url = await modelUrl(path);
      if (!url) return null;
      try {
        const [{ clone }, gltf] = await Promise.all([sharedGltf(), loadGltf(url)]);
        const t = prepare(url, gltf, clone);
        if (t) t.lod = await buildLod(t.mesh.geometry).catch(() => null);
        return t;
      } catch (err) {
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn('[render] character model could not be loaded, keeping the procedural body:', url, err);
        }
        return null;
      }
    })();
    templates.set(path, p);
    const mine = p;
    void p.then((t) => {
      if (templates.get(path) === mine) ready.set(path, t);
    });
  }
  return p;
}

/** The prepared template if it has finished loading (undefined: not requested / still loading; null: absent or broken). */
export function charTemplateSync(path: string): CharTemplate | null | undefined {
  return ready.get(path);
}

// ── lifetime ─────────────────────────────────────────────────────────────────

const refs = new Map<CharTemplate, number>();

/** A body instance started using the template (models/glbBody.ts). */
export function retainTemplate(t: CharTemplate): void {
  refs.set(t, (refs.get(t) ?? 0) + 1);
}

/** A body instance was disposed. */
export function releaseTemplate(t: CharTemplate): void {
  const n = (refs.get(t) ?? 0) - 1;
  if (n > 0) refs.set(t, n);
  else refs.delete(t);
}

/**
 * Free the GPU resources (geometry, far LOD, texture, base material) of every
 * loaded template no body uses any more, and forget it (a later request loads
 * it again, from the HTTP cache). Called when a match or the gallery turntable
 * ends: a hero texture is ~5 MB of GPU memory.
 */
export function evictUnusedTemplates(): number {
  let n = 0;
  for (const [path, t] of ready) {
    if (!t || refs.has(t)) continue;
    t.lod?.dispose();
    t.mesh.geometry.dispose();
    t.material.map?.dispose();
    t.material.dispose();
    ready.delete(path);
    templates.delete(path);
    n++;
  }
  return n;
}

/** Tests: forget every loaded template and override. */
export function resetGlbCacheForTests(): void {
  templates.clear();
  ready.clear();
  registered.clear();
  refs.clear();
}
