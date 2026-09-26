// Loot light-beams fade near the camera (COMBAT-11): a beam 1–2 m from the lens
// must never draw as an additive slab across the screen / HUD.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ViewEntity } from '../../../src/core/types';
import { assetList, setAssetListForTests } from '../../../src/game/assets';
import { LOOT_BEAM_FULL, LOOT_BEAM_HIDE, LootView, lootBeamNearFade } from '../../../src/render/entities/objects';

describe('loot beam near-camera fade', () => {
  it('is gone up close, full from a few metres, smooth in between', () => {
    expect(lootBeamNearFade(0)).toBe(0);
    expect(lootBeamNearFade(1.2)).toBe(0);
    expect(lootBeamNearFade(LOOT_BEAM_HIDE)).toBe(0);
    expect(lootBeamNearFade(2)).toBeLessThan(0.1);
    expect(lootBeamNearFade(LOOT_BEAM_FULL)).toBe(1);
    expect(lootBeamNearFade(40)).toBe(1);
    let prev = 0;
    for (let d = 0; d <= 6; d += 0.1) {
      const f = lootBeamNearFade(d);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(LOOT_BEAM_FULL).toBeLessThanOrEqual(6); // the beam still marks loot from a short walk away
  });

  it('the beam shader fades each fragment by its distance to the camera', async () => {
    setAssetListForTests([]);
    await assetList();
    const e = { id: 3, kind: 'loot', sub: 'smg', x: 0, y: 0, z: 0 } as unknown as ViewEntity;
    const v = new LootView(e);
    const beam = v.root.children.find((c) => (c as THREE.Mesh).isMesh && c.renderOrder === 17) as THREE.Mesh;
    expect(beam).toBeDefined();
    const mat = beam.material as THREE.MeshBasicMaterial;
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vBeamView = mvPosition.xyz;');
    expect(shader.fragmentShader).toMatch(/diffuseColor\.a \*= smoothstep\(1\.60, 5\.00, length\(vBeamView\)\);\s*#include <opaque_fragment>/);
    // its own program (not shared with plain basic materials)
    expect(mat.customProgramCacheKey()).toBe('lootBeamNearFade');
    setAssetListForTests(null);
  });
});
