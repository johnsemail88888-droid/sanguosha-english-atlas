// Optional GLB override for hero bodies: if public/assets/heroes/<id>.glb exists
// it replaces the procedural body (future AI-generated assets). Existence is
// resolved at BUILD time through import.meta.glob, so missing files never cause
// 404 requests / console errors; loading failures are swallowed (checked once).
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

const GLB_URLS: Record<string, () => Promise<unknown>> = (() => {
  try {
    return import.meta.glob('../../../public/assets/heroes/*.glb', { query: '?url', import: 'default' });
  } catch {
    return {};
  }
})();

const byId = new Map<string, () => Promise<unknown>>();
for (const [path, loader] of Object.entries(GLB_URLS)) {
  const m = /([^/]+)\.glb$/.exec(path);
  if (m) byId.set(m[1], loader);
}

export interface HeroGlb {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** uniform scale applied so the model is ~1.8 m tall */
  scale: number;
}

const cache = new Map<string, Promise<HeroGlb | null>>();

export function hasHeroGlb(heroId: string): boolean {
  return byId.has(heroId);
}

/** Load (once) the GLB for a hero; resolves null when absent or broken. Returns a fresh clone per call. */
export async function loadHeroGlb(heroId: string): Promise<HeroGlb | null> {
  const loader = byId.get(heroId);
  if (!loader) return null;
  let p = cache.get(heroId);
  if (!p) {
    p = (async (): Promise<HeroGlb | null> => {
      try {
        const url = (await loader()) as string;
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const gltf: GLTF = await new GLTFLoader().loadAsync(url);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const h = box.max.y - box.min.y;
        const scale = h > 1e-3 ? 1.8 / h : 1;
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = false;
          }
        });
        return { scene: gltf.scene, animations: gltf.animations, scale };
      } catch {
        return null;
      }
    })();
    cache.set(heroId, p);
  }
  const base = await p;
  if (!base) return null;
  const { clone } = await import('three/addons/utils/SkeletonUtils.js');
  return { scene: clone(base.scene), animations: base.animations, scale: base.scale };
}
