// One lazily created GLTFLoader (+ meshopt decoder) for the static AI-art
// models (prop models, mounts). The addons are imported on first use, so the
// single-file build / a deploy without art never loads them.
import * as THREE from 'three';

export type GltfLoaderLike = { loadAsync(url: string): Promise<{ scene: THREE.Object3D }> };

let loaderP: Promise<GltfLoaderLike> | null = null;

export function sharedGltfLoader(): Promise<GltfLoaderLike> {
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
export function floatAttribute(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, Ctor: new (n: number) => Float32Array = Float32Array): Float32Array {
  const n = a.count;
  const k = a.itemSize;
  const out = new Ctor(n * k);
  for (let i = 0; i < n; i++) {
    out[i * k] = a.getX(i);
    if (k > 1) out[i * k + 1] = a.getY(i);
    if (k > 2) out[i * k + 2] = a.getZ(i);
    if (k > 3) out[i * k + 3] = a.getW(i);
  }
  return out;
}

/**
 * The model's texture at most `max` texels on a side (GPU memory on lower tiers):
 * a smaller copy replaces the decoded image, the original is released.
 */
export function capTexture(tex: THREE.Texture, max: number): THREE.Texture {
  const img = tex.image as { width?: number; height?: number } | null;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h || Math.max(w, h) <= max || typeof document === 'undefined') return tex;
  const k = max / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const g = canvas.getContext('2d');
  if (!g) return tex;
  g.imageSmoothingQuality = 'high';
  g.drawImage(tex.image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  const out = new THREE.CanvasTexture(canvas);
  // same sampling as the glTF texture (glTF UVs: no flip)
  out.flipY = tex.flipY;
  out.colorSpace = tex.colorSpace;
  out.wrapS = tex.wrapS;
  out.wrapT = tex.wrapT;
  out.minFilter = THREE.LinearMipmapLinearFilter;
  out.generateMipmaps = true;
  (tex.image as { close?: () => void } | null)?.close?.();
  tex.dispose();
  return out;
}

