// Optional GLB override for hero bodies: `assets/heroes/<id>.glb` (the file
// lives in public/assets/heroes/) replaces the procedural body — for future
// AI-generated / modded assets. Resolution, per hero id, once per session:
//   1. registerHeroGlb(id, url)       explicit override (mods, tests)
//   2. dev server                     import.meta.glob over public/assets/heroes
//                                     (no 404 probes, updates when files change)
//   3. production over http(s)        the build's manifest assets/heroes/index.json
//                                     ({ heroes: [ids] }, written by vite.config.ts
//                                     from public/assets/heroes) is fetched once and
//                                     is authoritative — no per-hero 404 probes (and
//                                     no red console errors) on Pages / the relay
//                                     server / Electron. To drop a GLB into an
//                                     already-built game, also add its id there.
//                                     Without a manifest (older / hand-made deploys):
//                                     one HEAD probe of assets/heroes/<id>.glb
// The single-file build (file://) cannot fetch side files, so it only honours
// registerHeroGlb. Loading / parsing failures are swallowed: the procedural
// hero stays. The model is scaled to 1.8 m (the sim's hero capsule).
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** Dev only: files present in public/assets/heroes at transform time (never bundled into builds). */
const DEV_GLBS: Record<string, () => Promise<unknown>> = import.meta.env.DEV
  ? import.meta.glob('../../../public/assets/heroes/*.glb', { query: '?url', import: 'default' })
  : {};

const devById = new Map<string, () => Promise<unknown>>();
for (const [path, loader] of Object.entries(DEV_GLBS)) {
  const m = /([^/]+)\.glb$/.exec(path);
  if (m) devById.set(m[1], loader);
}

export interface HeroGlb {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** uniform scale applied so the model is ~1.8 m tall */
  scale: number;
}

/** Height every GLB hero is normalised to (m). */
export const GLB_HERO_HEIGHT = 1.8;

const registered = new Map<string, string>();
const urlCache = new Map<string, Promise<string | null>>();
const cache = new Map<string, Promise<HeroGlb | null>>();

/** Use this GLB (any URL, incl. blob:) for a hero from now on. Affects models created afterwards. */
export function registerHeroGlb(heroId: string, url: string): void {
  registered.set(heroId, url);
  urlCache.delete(heroId);
  cache.delete(heroId);
}

let manifest: Promise<ReadonlySet<string> | null> | null = null;

/** The build's GLB manifest (null when the host serves none). Fetched once per page. */
function heroManifest(): Promise<ReadonlySet<string> | null> {
  if (!manifest) {
    manifest = (async () => {
      try {
        const r = await fetch('assets/heroes/index.json', { cache: 'no-cache' });
        if (!r.ok || /text\/html/i.test(r.headers.get('content-type') ?? '')) return null;
        const j = (await r.json()) as { heroes?: unknown };
        return Array.isArray(j.heroes) ? new Set(j.heroes.filter((x): x is string => typeof x === 'string')) : null;
      } catch {
        return null;
      }
    })();
  }
  return manifest;
}

/** Where the GLB for a hero lives, or null when there is none (cached per id). */
export function resolveHeroGlbUrl(heroId: string): Promise<string | null> {
  let p = urlCache.get(heroId);
  if (!p) {
    p = resolveNow(heroId);
    urlCache.set(heroId, p);
  }
  return p;
}

async function resolveNow(heroId: string): Promise<string | null> {
  const reg = registered.get(heroId);
  if (reg) return reg;
  const dev = devById.get(heroId);
  if (dev) {
    try {
      return (await dev()) as string;
    } catch {
      return null;
    }
  }
  if (import.meta.env.DEV) return null; // the dev glob is authoritative: no 404 noise while developing
  if (!/^[\w-]+$/.test(heroId)) return null;
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return null;
  const url = `assets/heroes/${heroId}.glb`;
  const listed = await heroManifest();
  if (listed) return listed.has(heroId) ? url : null;
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
    // SPA-style servers answer unknown paths with index.html (200 text/html)
    const type = r.headers.get('content-type') ?? '';
    return r.ok && !/text\/html/i.test(type) ? url : null;
  } catch {
    return null;
  }
}

/** Load and normalise a hero GLB from a URL (null when it cannot be loaded). */
export async function loadGlbFromUrl(url: string): Promise<HeroGlb | null> {
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf: GLTF = await new GLTFLoader().loadAsync(url);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const h = box.max.y - box.min.y;
    if (!(h > 1e-3) || !Number.isFinite(h)) return null;
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    // feet on the ground
    gltf.scene.position.y -= box.min.y;
    const root = new THREE.Group();
    root.add(gltf.scene);
    return { scene: root, animations: gltf.animations, scale: GLB_HERO_HEIGHT / h };
  } catch {
    return null;
  }
}

/** Load (once) the GLB for a hero; resolves null when absent or broken. Returns a fresh clone per call. */
export async function loadHeroGlb(heroId: string): Promise<HeroGlb | null> {
  let p = cache.get(heroId);
  if (!p) {
    p = resolveHeroGlbUrl(heroId).then((url) => (url ? loadGlbFromUrl(url) : null));
    cache.set(heroId, p);
  }
  const base = await p;
  if (!base) return null;
  const { clone } = await import('three/addons/utils/SkeletonUtils.js');
  return { scene: clone(base.scene), animations: base.animations, scale: base.scale };
}
