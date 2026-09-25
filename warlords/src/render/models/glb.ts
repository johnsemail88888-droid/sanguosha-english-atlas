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
//   - the loader's MeshPhysicalMaterial (emissive = base colour, metallic 1,
//     KHR_materials_specular) is replaced by a plain lit MeshStandardMaterial.
import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetList, assetListSync } from '../../game/assets';
import { CHARACTER_FOG_MAX } from '../core/materials';

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
