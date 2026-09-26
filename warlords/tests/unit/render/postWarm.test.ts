// Bloom warm-up (scene/post.ts): its programs must be the ones the bloom pass
// draws with. The program key includes vertexNormals (a normal attribute), so
// the warm-up mesh carries exactly the attributes of three's FullScreenQuad.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { fullscreenTriangle } from '../../../src/render/scene/post';

describe('bloom warm-up geometry', () => {
  it('has the same attributes as the passes’ full-screen quad', () => {
    const fsq = new FullScreenQuad(new THREE.MeshBasicMaterial());
    const quadGeo = (fsq as unknown as { _mesh: THREE.Mesh })._mesh.geometry;
    const g = fullscreenTriangle();
    expect(Object.keys(g.attributes).sort()).toEqual(Object.keys(quadGeo.attributes).sort());
    expect(g.getAttribute('normal')).toBeUndefined();
    // covers the viewport
    const p = g.getAttribute('position');
    const box = new THREE.Box3().setFromBufferAttribute(p as THREE.BufferAttribute);
    expect(box.min.x).toBeLessThanOrEqual(-1);
    expect(box.min.y).toBeLessThanOrEqual(-1);
    expect(box.max.x).toBeGreaterThanOrEqual(1);
    expect(box.max.y).toBeGreaterThanOrEqual(1);
  });
});
