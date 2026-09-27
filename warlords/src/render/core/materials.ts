// Shared materials. Static world geometry uses ONE vertex-coloured standard
// material (so merged chunks batch well); vegetation adds a cheap wind sway.
import * as THREE from 'three';
import { disposeWorldArt } from './worldArt';
import { disposeStructureMaterial } from './structureMaterial';
import { applySkyArtFog, skyArtFogKey } from './skyArtFog';

/** Uniforms shared by every animated shader (updated once per frame by the renderer). */
export const sharedUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(0.8, 0.35) },
};

let worldMat: THREE.MeshStandardMaterial | null = null;
let worldMatDouble: THREE.MeshStandardMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;
let foliageMat: THREE.MeshStandardMaterial | null = null;
// Lambert twins of the three (the 极速 tier's 'basic' shading): diffuse only,
// no PBR specular / multi-scattering — a fraction of the per-pixel cost on a
// software rasteriser; the systems that use them swap in place (setLite)
let worldLite: THREE.MeshLambertMaterial | null = null;
let worldLiteDouble: THREE.MeshLambertMaterial | null = null;
let foliageLite: THREE.MeshLambertMaterial | null = null;

/** Opaque, vertex-coloured, flat-shaded world material (props, buildings). */
export function worldMaterial(): THREE.MeshStandardMaterial {
  if (!worldMat) {
    worldMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.86,
      metalness: 0.0,
    });
    worldMat.name = 'world';
    withSkyArtFog(worldMat, 'world');
  }
  return worldMat;
}

/** Same as worldMaterial but double sided (thin cloth / sails / paper). */
export function worldMaterialDouble(): THREE.MeshStandardMaterial {
  if (!worldMatDouble) {
    worldMatDouble = worldMaterial().clone();
    worldMatDouble.side = THREE.DoubleSide;
    worldMatDouble.name = 'worldDouble';
    withSkyArtFog(worldMatDouble, 'worldDouble');
  }
  return worldMatDouble;
}

/** Diffuse-only twin of worldMaterial (the 极速 tier). */
export function worldMaterialLite(): THREE.MeshLambertMaterial {
  if (!worldLite) {
    worldLite = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    worldLite.name = 'worldLite';
    withSkyArtFog(worldLite, 'worldLite');
  }
  return worldLite;
}

/** Diffuse-only twin of worldMaterialDouble (the 极速 tier). */
export function worldMaterialLiteDouble(): THREE.MeshLambertMaterial {
  if (!worldLiteDouble) {
    worldLiteDouble = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    worldLiteDouble.name = 'worldLiteDouble';
    withSkyArtFog(worldLiteDouble, 'worldLiteDouble');
  }
  return worldLiteDouble;
}

/** Diffuse-only twin of foliageMaterial (the 极速 tier). */
export function foliageMaterialLite(): THREE.MeshLambertMaterial {
  if (!foliageLite) {
    foliageLite = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    foliageLite.name = 'foliageLite';
    addWindSway(foliageLite, 0.05, 0.22);
  }
  return foliageLite;
}

/** The lite twin of a shared world material (itself when it has none). */
export function liteTwin(m: THREE.Material): THREE.Material {
  if (m === worldMat) return worldMaterialLite();
  if (m === worldMatDouble) return worldMaterialLiteDouble();
  if (m === foliageMat) return foliageMaterialLite();
  return m;
}

/** The full material of a lite twin (itself when it is none). */
export function fullTwin(m: THREE.Material): THREE.Material {
  if (m === worldLite) return worldMaterial();
  if (m === worldLiteDouble) return worldMaterialDouble();
  if (m === foliageLite) return foliageMaterial();
  return m;
}

/** Painted-sky fog for a material without other shader changes (core/skyArtFog.ts). */
function withSkyArtFog(mat: THREE.Material, key: string): void {
  mat.onBeforeCompile = (shader) => applySkyArtFog(shader, mat);
  mat.customProgramCacheKey = () => `${key}${skyArtFogKey()}`;
}

/** Unlit vertex-coloured material for emissive details (lanterns, embers, gold glints). */
export function glowMaterial(): THREE.MeshBasicMaterial {
  if (!glowMat) {
    glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    glowMat.name = 'glow';
  }
  return glowMat;
}

/**
 * Inject a wind sway into a standard material's vertex shader. The sway amount
 * grows with local height (`position.y`) and is phase-shifted per instance.
 */
export function addWindSway(mat: THREE.Material, strength = 0.06, heightScale = 0.25): void {
  mat.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, mat);
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWind = sharedUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec2 uWind;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 basePos = vec3(0.0);
  #ifdef USE_INSTANCING
    basePos = instanceMatrix[3].xyz;
  #endif
  float h = max(position.y, 0.0) * ${heightScale.toFixed(3)};
  float ph = basePos.x * 0.21 + basePos.z * 0.17;
  float sway = sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.4;
  transformed.xz += uWind * sway * h * h * ${strength.toFixed(3)} * 10.0;
}`,
      );
  };
  mat.customProgramCacheKey = () => `wind_${strength}_${heightScale}${skyArtFogKey()}`;
}

/** Foliage material: vertex coloured, flat, with wind sway. */
export function foliageMaterial(): THREE.MeshStandardMaterial {
  if (!foliageMat) {
    foliageMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.9,
      metalness: 0,
    });
    foliageMat.name = 'foliage';
    addWindSway(foliageMat, 0.05, 0.22);
  }
  return foliageMat;
}

/** A per-character material (tintable: freeze, glow, stealth) sharing the same shader program. */
/** Maximum fog factor applied to characters (0 = no fog, 1 = full fog). */
export const CHARACTER_FOG_MAX = 0.45;

/**
 * Ink edge of the procedural characters: facets turning away from the camera
 * darken by up to this much, so the flat-shaded low-poly bodies (troops on
 * 流畅, everyone in the single-file build) read with soft painted contours
 * next to the AI-art bodies instead of as flat toy colours.
 */
export const CHARACTER_INK_EDGE = 0.3;

export function characterMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.72,
    metalness: 0.05,
  });
  m.name = 'character';
  // fog never hides a character completely (scene/skyfog.ts): heroes beyond the
  // preset's fog range must stay readable silhouettes
  m.defines = { FOG_MAX: CHARACTER_FOG_MAX.toFixed(2) };
  // painted-sky fog colour like the AI-art bodies and the world around them, plus the ink edge
  m.onBeforeCompile = function (this: THREE.Material, shader) {
    applySkyArtFog(shader, this);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `outgoingLight *= 1.0 - ${CHARACTER_INK_EDGE.toFixed(2)} * pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.5);\n#include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `characterInk${skyArtFogKey()}`;
  return m;
}

/** Dispose shared materials (renderer teardown). */
export function disposeSharedMaterials(): void {
  worldMat?.dispose();
  worldMatDouble?.dispose();
  glowMat?.dispose();
  foliageMat?.dispose();
  worldLite?.dispose();
  worldLiteDouble?.dispose();
  foliageLite?.dispose();
  worldMat = worldMatDouble = foliageMat = null;
  worldLite = worldLiteDouble = foliageLite = null;
  glowMat = null;
  disposeStructureMaterial();
  disposeWorldArt();
}
