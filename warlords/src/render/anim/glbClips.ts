// Shared animation clip library for the GLB character bodies
// (public/assets/anim/<file>.glb: skeleton + one mocap clip each, keyed by the
// shared bone names). Each file is loaded once and normalised once
// (glbRetarget.prepareClip); each model then gets its own thin AnimationClip
// wrappers sharing those rotation tracks plus its own grounded Hips track and
// the gait numbers the locomotion blend needs (modelClip).
//
// Files that are missing are simply unavailable: GlbAnimator falls back along
// a chain (bow_shot → bow_walk, knockdown → death pose, …). Without the three
// REQUIRED_CLIPS no GLB body is used at all (procedural fallback).
import * as THREE from 'three';
import { loadGltf, modelUrl, type CharTemplate } from '../models/glb';
import {
  analyseGait,
  meanClip,
  groundLift,
  layerTracks,
  mirrorClip,
  modelHipsTrack,
  prepareClip,
  sampleLegs,
  type ClipSource,
  type GaitInfo,
  type PreparedClip,
  type RootPolicy,
} from './glbRetarget';

export type ClipId =
  | 'idle'
  | 'aim'
  | 'walkBack'
  | 'run'
  | 'sprint'
  | 'jump'
  | 'roll'
  | 'reload'
  | 'hit'
  | 'death'
  | 'dance'
  | 'meleeHeavy'
  | 'meleeThrust'
  | 'cast'
  | 'sit'
  | 'bow'
  | 'bowShot'
  | 'knockdown'
  | 'crawl'
  | 'runMean';

export interface ClipSpec {
  /** assets/anim/<file>.glb */
  file?: string;
  /**
   * derived by mirroring another clip left ↔ right (unused: the walking strafe
   * walk_gun_left is ≤ 1 m/s while every sideways move in the game is a run, so
   * strafes turn the run's hips instead — see anim/glbAnimator; a run-speed
   * strafe clip would be mirrored here)
   */
  mirrorOf?: ClipId;
  /** derived: the time-averaged pose of another clip (stride shortening) */
  meanOf?: ClipId;
  root: RootPolicy;
  /** calibrate the Hips height so the lowest foot touches the ground */
  ground: boolean;
  loop: boolean;
  /** measure speed / direction / cycles (in-place locomotion) */
  gait?: boolean;
  /** play window within the file (s) */
  from?: number;
  to?: number;
}

export const CLIP_SPECS: Record<ClipId, ClipSpec> = {
  idle: { file: 'idle', root: 'loco', ground: true, loop: true },
  // Walk_Forward_While_Shooting: its upper body is THE aimed-rifle pose
  aim: { file: 'walk_gun_fwd', root: 'loco', ground: true, loop: true },
  walkBack: { file: 'walk_gun_back', root: 'loco', ground: true, loop: true, gait: true },
  run: { file: 'run_gun', root: 'loco', ground: true, loop: true, gait: true },
  sprint: { file: 'sprint', root: 'loco', ground: true, loop: true, gait: true },
  jump: { file: 'jump', root: 'none', ground: false, loop: false },
  // the dive + roll + get-up part (the file starts with a run-up)
  roll: { file: 'roll', root: 'noXZ', ground: false, loop: false, from: 0.42 },
  reload: { file: 'reload', root: 'noXZ', ground: false, loop: true },
  // only the flinch
  hit: { file: 'hit', root: 'noXZ', ground: false, loop: false, to: 0.9 },
  death: { file: 'death', root: 'noXZ', ground: false, loop: false },
  dance: { file: 'dance', root: 'noXZ', ground: true, loop: true },
  meleeHeavy: { file: 'melee_heavy', root: 'noXZ', ground: false, loop: false },
  meleeThrust: { file: 'melee_thrust', root: 'noXZ', ground: false, loop: false },
  cast: { file: 'cast', root: 'noXZ', ground: false, loop: false },
  sit: { file: 'sit', root: 'none', ground: false, loop: true },
  bow: { file: 'bow_walk', root: 'loco', ground: true, loop: true },
  // Archery_Shot is 5 s (quiver, nock, draw, hold, lower): only the release from full draw
  bowShot: { file: 'bow_shot', root: 'noXZ', ground: false, loop: false, from: 2.9, to: 3.6 },
  knockdown: { file: 'knockdown', root: 'noXZ', ground: false, loop: false },
  crawl: { file: 'crawl', root: 'noXZ', ground: false, loop: true, gait: true },
  runMean: { meanOf: 'run', root: 'loco', ground: true, loop: true },
};

export const CLIP_IDS = Object.keys(CLIP_SPECS) as ClipId[];
/** Without these a GLB body cannot animate: the procedural rig is used instead. */
export const REQUIRED_CLIPS: readonly ClipId[] = ['idle', 'aim', 'run'];

export const clipFilePath = (file: string): string => `assets/anim/${file}.glb`;

// ── loading (once per file) ──────────────────────────────────────────────────

const sources = new Map<string, Promise<ClipSource | null>>();
let warned = false;
const prepared = new Map<ClipId, Promise<PreparedClip | null>>();
const preparedSync = new Map<ClipId, PreparedClip | null>();

function loadSource(file: string): Promise<ClipSource | null> {
  let p = sources.get(file);
  if (!p) {
    p = (async (): Promise<ClipSource | null> => {
      const url = await modelUrl(clipFilePath(file));
      if (!url) return null;
      try {
        const gltf = await loadGltf(url);
        const clip = gltf.animations[0];
        let hips: THREE.Object3D | null = null;
        gltf.scene.traverse((o) => {
          if (!hips && o.name === 'Hips') hips = o;
        });
        const h = hips as THREE.Object3D | null;
        if (!clip || !h) return null;
        return { clip, hipsRestQ: h.quaternion.clone(), hipsRestP: h.position.clone(), hipsChildren: h.children.map((c) => c.name) };
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn('[render] animation clip could not be loaded:', url, err);
        }
        return null;
      }
    })();
    sources.set(file, p);
  }
  return p;
}

/** Load + normalise one clip (cached; null when the file is absent or broken). */
export function loadClip(id: ClipId): Promise<PreparedClip | null> {
  let p = prepared.get(id);
  if (!p) {
    const spec = CLIP_SPECS[id];
    p = (async (): Promise<PreparedClip | null> => {
      if (spec.mirrorOf) {
        const base = await loadClip(spec.mirrorOf);
        return base ? mirrorClip(base, id) : null;
      }
      if (spec.meanOf) {
        const base = await loadClip(spec.meanOf);
        return base ? meanClip(base, id) : null;
      }
      if (!spec.file) return null;
      const src = await loadSource(spec.file);
      return src ? prepareClip(src, spec.root, spec.from, spec.to) : null;
    })();
    prepared.set(id, p);
    void p.then((c) => preparedSync.set(id, c));
  }
  return p;
}

/** Load every clip (resolves when all settled). */
export async function loadAllClips(onEach?: () => void): Promise<void> {
  await Promise.all(
    CLIP_IDS.map((id) =>
      loadClip(id).then(
        () => onEach?.(),
        () => onEach?.(),
      ),
    ),
  );
}

/** True once every required clip has loaded successfully. */
export function clipsReady(): boolean {
  return REQUIRED_CLIPS.every((id) => !!preparedSync.get(id));
}

/** A clip if it has finished loading (null: absent; undefined: not loaded yet). */
export function clipSync(id: ClipId): PreparedClip | null | undefined {
  return preparedSync.get(id);
}

/** Tests: inject prepared clips / forget everything. */
export function setClipsForTests(clips: Partial<Record<ClipId, PreparedClip | null>> | null): void {
  sources.clear();
  prepared.clear();
  preparedSync.clear();
  if (!clips) return;
  for (const id of CLIP_IDS) {
    const c = clips[id] ?? null;
    preparedSync.set(id, c);
    prepared.set(id, Promise.resolve(c));
  }
}

// ── per model ────────────────────────────────────────────────────────────────

export interface ModelClip {
  id: ClipId;
  duration: number;
  loop: boolean;
  /** every track */
  full: THREE.AnimationClip;
  /** spine chain and above */
  upper: THREE.AnimationClip;
  /** hips (incl. translation) and legs */
  lower: THREE.AnimationClip;
  /** locomotion clips: authored speed (m at load scale per s), direction and cycles */
  gait: GaitInfo | null;
  /** Hips height of the (grounded) clip at time 0, model units */
  hipsY0: number;
}

const perModel = new WeakMap<CharTemplate, Map<ClipId, ModelClip | null>>();

/** Build (once) the model's wrapper for a loaded clip; null when the clip is not available. */
export function modelClip(t: CharTemplate, id: ClipId): ModelClip | null {
  let m = perModel.get(t);
  if (!m) {
    m = new Map();
    perModel.set(t, m);
  }
  const hit = m.get(id);
  if (hit !== undefined) return hit;
  const c = preparedSync.get(id);
  if (c === undefined) return null; // still loading: try again later
  const mc = c ? buildModelClip(t, id, c) : null;
  m.set(id, mc);
  return mc;
}

function buildModelClip(t: CharTemplate, id: ClipId, c: PreparedClip): ModelClip {
  const spec = CLIP_SPECS[id];
  const hipsRest = t.rest.get('Hips')?.p ?? new THREE.Vector3();
  let lift = 0;
  let gait: GaitInfo | null = null;
  const unit = t.unit || 0.01;
  if (spec.ground || spec.gait) {
    const raw = modelHipsTrack(c, hipsRest, 0);
    const n = Math.max(8, Math.min(240, Math.round(c.duration * 60)));
    const restS = sampleLegs([], null, t.rest, 0, 0)[0];
    const samples = sampleLegs(c.rot, raw, t.rest, c.duration, n);
    if (spec.ground) {
      lift = groundLift(samples, restS);
      for (const s of samples) {
        s.hips.y += lift;
        s.footL.y += lift;
        s.toeL.y += lift;
        s.footR.y += lift;
        s.toeR.y += lift;
      }
    }
    if (spec.gait) {
      const g = analyseGait(samples, restS, 0.03 / unit);
      if (g) gait = { ...g, speed: g.speed * unit };
    }
  }
  const hips = modelHipsTrack(c, hipsRest, lift);
  const lower: THREE.KeyframeTrack[] = layerTracks(c.rot, false);
  if (hips) lower.push(hips);
  const upper = layerTracks(c.rot, true);
  const full = [...upper, ...lower];
  return {
    id,
    duration: c.duration,
    loop: spec.loop,
    full: new THREE.AnimationClip(`${id}`, c.duration, full),
    upper: new THREE.AnimationClip(`${id}:upper`, c.duration, upper),
    lower: new THREE.AnimationClip(`${id}:lower`, c.duration, lower),
    gait,
    hipsY0: hips ? hips.values[1] : hipsRest.y,
  };
}
