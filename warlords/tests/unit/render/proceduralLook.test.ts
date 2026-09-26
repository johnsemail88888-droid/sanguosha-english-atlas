// Procedural bodies (troops on 流畅, everyone in the single-file build): painted
// shading baked into the vertex colours + an ink edge in the material, so they
// no longer read as flat toy soldiers next to the AI-art bodies (PLATFORM-11).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BODY_DESATURATE, BODY_SHADE_FEET, paintBodyShading } from '../../../src/render/models/humanoid';
import { CHARACTER_INK_EDGE, characterMaterial } from '../../../src/render/core/materials';
import { activateSkyArtFog, disposeSkyArtFog } from '../../../src/render/core/skyArtFog';

/** Vertices at the given heights / normals, all one colour. */
function geo(ys: number[], ny: number[], c: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(ys.flatMap((y) => [0.1, y, 0.05]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(ny.flatMap((n) => [Math.sqrt(1 - n * n), n, 0]), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(ys.flatMap(() => c), 3));
  return g;
}
const rgb = (g: THREE.BufferGeometry, i: number): number[] => {
  const C = g.getAttribute('color');
  return [C.getX(i), C.getY(i), C.getZ(i)];
};
const sum = (v: number[]): number => v[0] + v[1] + v[2];

describe('procedural body look', () => {
  it('shades dark to light from the feet up, darker undersides, a little less saturated', () => {
    const g = geo([0, 0.7, 1.45, 1.7, 1.45], [0, 0, 0, 0, -1], [0.8, 0.6, 0.1]);
    paintBodyShading(g, 1.45);
    const [feet, knee, shoulder, head, under] = [0, 1, 2, 3, 4].map((i) => rgb(g, i));
    expect(sum(feet)).toBeLessThan(sum(knee));
    expect(sum(knee)).toBeLessThan(sum(shoulder));
    // feet ≈ BODY_SHADE_FEET of the shoulders (± the brush mottling)
    expect(sum(feet) / sum(shoulder)).toBeGreaterThan(BODY_SHADE_FEET - 0.08);
    expect(sum(feet) / sum(shoulder)).toBeLessThan(BODY_SHADE_FEET + 0.08);
    expect(Math.abs(sum(head) - sum(shoulder)) / sum(shoulder)).toBeLessThan(0.1);
    expect(sum(under)).toBeLessThan(sum(shoulder) * 0.85);
    // saturation (max − min over max) drops by about BODY_DESATURATE
    const sat = (c: number[]): number => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    expect(sat(shoulder)).toBeLessThan(sat([0.8, 0.6, 0.1]) - BODY_DESATURATE * 0.5);
    expect(sat(shoulder)).toBeGreaterThan(0.6); // still clearly the troop's colour
  });

  it('the material draws an ink edge and takes the painted-sky fog (own program key)', () => {
    const m = characterMaterial();
    const compile = (): { fragmentShader: string; uniforms: Record<string, THREE.IUniform> } => {
      const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
      return shader;
    };
    const plain = compile();
    expect(plain.fragmentShader).toContain(`outgoingLight *= 1.0 - ${CHARACTER_INK_EDGE.toFixed(2)} * pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition)))`);
    expect(plain.fragmentShader).not.toContain('SKY_ART_FOG');
    const k0 = m.customProgramCacheKey();
    activateSkyArtFog(new THREE.Vector3(-0.72, 0.5, 0.42));
    try {
      const art = compile();
      expect(art.fragmentShader.startsWith('#define SKY_ART_FOG')).toBe(true);
      expect(m.customProgramCacheKey()).not.toBe(k0);
    } finally {
      disposeSkyArtFog();
    }
    expect(m.defines?.FOG_MAX).toBeDefined();
  });
});
