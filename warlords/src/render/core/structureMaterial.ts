// Textured variant of the static-structure material (AI-art mode): the merged
// world chunks carry a per-vertex surface id ('aSurf', written by the prop
// builders through GeoBuilder.extra) and the fragment shader projects one
// layer of the structure texture array onto each flat-shaded face in world
// space — no mesh UVs needed:
//   vertical faces   u along the face's horizontal tangent, v up (brick courses,
//                    plank strakes and plaster stay level at any wall rotation)
//   sloped faces     u along the eave, v down the slope (roof tiles run down-slope;
//                    continuous across the facets of a curved roof side)
//   horizontal faces u/v in the prop's own frame (decks, stairs, paving follow the prop)
// The texture is normalised by its mean colour and multiplied onto the vertex
// colour, so palette colours (lacquer red walls, glazed gold roofs, kingdom
// tints) survive and the image only adds material detail.
import * as THREE from 'three';
import { STRUCT_LAYERS, type TexArraySet } from './worldArt';

/**
 * Surface ids (integer part of aSurf; the fraction carries the prop yaw).
 * 0 = plain vertex colour. Ids 1..6 index STRUCT_LAYERS + 1; WOOD_V is the
 * planks layer turned 90° (vertical grain: posts, palisades, poles).
 */
export const SURF = {
  plain: 0,
  brick: 1,
  plaster: 2,
  roof: 3,
  planks: 4,
  paving: 5,
  stone: 6,
  woodV: 7,
} as const;
export type SurfId = (typeof SURF)[keyof typeof SURF];

/** Pack a surface id + yaw (radians) into the aSurf channel value. */
export function packSurf(id: SurfId, yaw = 0): number {
  if (id === SURF.plain) return 0;
  const t = yaw / (Math.PI * 2);
  return id + (t - Math.floor(t)) * 0.98;
}

/** Inverse of packSurf (tests / tools). */
export function unpackSurf(v: number): { id: number; yaw: number } {
  const id = Math.floor(v + 1e-4);
  return { id, yaw: ((v - id) / 0.98) * Math.PI * 2 };
}

/** Metres per texture repeat, per STRUCT_LAYERS entry. */
export const STRUCT_TILE_M = [2.3, 2.8, 1.9, 2.2, 3.0, 3.4] as const;
/** How strongly each layer's detail modulates the vertex colour. */
const STRUCT_CONTRAST = [0.95, 0.75, 1.0, 0.9, 0.85, 0.85] as const;

const uniforms = {
  uStructTex: { value: null as THREE.DataArrayTexture | null },
  uStructAvg: { value: STRUCT_LAYERS.map(() => new THREE.Color(0.5, 0.5, 0.5)) },
  uStructHas: { value: STRUCT_LAYERS.map(() => 0) },
};

const PARS_VERTEX = /* glsl */ `
attribute float aSurf;
varying float vSurf;
varying vec3 vSPos;
varying vec3 vSNrm;`;

const VERTEX = /* glsl */ `
vSurf = aSurf;
vSPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSNrm = normalize(mat3(modelMatrix) * objectNormal);`;

const PARS_FRAGMENT = /* glsl */ `
uniform highp sampler2DArray uStructTex;
uniform vec3 uStructAvg[${STRUCT_LAYERS.length}];
uniform float uStructHas[${STRUCT_LAYERS.length}];
varying float vSurf;
varying vec3 vSPos;
varying vec3 vSNrm;
const float S_TILE[${STRUCT_LAYERS.length}] = float[${STRUCT_LAYERS.length}](${STRUCT_TILE_M.map((t) => t.toFixed(2)).join(', ')});
const float S_CONTRAST[${STRUCT_LAYERS.length}] = float[${STRUCT_LAYERS.length}](${STRUCT_CONTRAST.map((t) => t.toFixed(2)).join(', ')});`;

const FRAGMENT = /* glsl */ `
{
  // derivatives in uniform control flow (the surface branch below is per-fragment)
  vec3 sp = vSPos;
  vec3 sdx = dFdx(sp);
  vec3 sdy = dFdy(sp);
  float sid = floor(vSurf + 0.0001);
  if (sid > 0.5) {
    vec3 n = normalize(vSNrm);
    bool roof = sid > 2.5 && sid < 3.5;
    bool vgrain = sid > 6.5;
    int layer = vgrain ? 3 : int(sid) - 1;
    vec2 uv; vec2 gx; vec2 gy;
    float flatness = abs(n.y);
    vec2 hn = n.xz;
    float hl = length(hn);
    if ((roof && hl < 0.08) || (!roof && flatness > 0.8)) {
      // horizontal: the prop's own frame
      float yaw = fract(vSurf) / 0.98 * 6.2831853;
      float c = cos(yaw); float s = sin(yaw);
      mat2 R = mat2(c, s, -s, c);
      uv = R * sp.xz; gx = R * sdx.xz; gy = R * sdy.xz;
    } else {
      // vertical / sloped: u along the horizontal tangent, v up / down the slope
      vec2 h = hn / max(hl, 1e-4);
      vec2 t = vec2(-h.y, h.x);
      uv = vec2(dot(sp.xz, t), sp.y - dot(sp.xz, h));
      gx = vec2(dot(sdx.xz, t), sdx.y - dot(sdx.xz, h));
      gy = vec2(dot(sdy.xz, t), sdy.y - dot(sdy.xz, h));
    }
    if (vgrain) { uv = uv.yx; gx = gx.yx; gy = gy.yx; }
    float inv = 1.0 / S_TILE[layer];
    vec3 tex = textureGrad(uStructTex, vec3(uv * inv, float(layer)), gx * inv, gy * inv).rgb;
    vec3 detail = tex / max(uStructAvg[layer], vec3(0.004));
    diffuseColor.rgb *= mix(vec3(1.0), detail, S_CONTRAST[layer] * uStructHas[layer]);
  }
}`;

let mat: THREE.MeshStandardMaterial | null = null;

/** The textured structure material (same look as worldMaterial() plus surface detail). */
export function structureMaterial(): THREE.MeshStandardMaterial {
  if (mat) return mat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0 });
  m.name = 'structure';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uStructTex = uniforms.uStructTex;
    shader.uniforms.uStructAvg = uniforms.uStructAvg;
    shader.uniforms.uStructHas = uniforms.uStructHas;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${PARS_VERTEX}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${PARS_FRAGMENT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>${FRAGMENT}`);
  };
  m.customProgramCacheKey = () => 'structure_v1';
  mat = m;
  return m;
}

/** Point the material at a structure texture set (placeholder now, decoded array once ready). */
export function bindStructureSet(set: TexArraySet): void {
  const sync = (): void => {
    uniforms.uStructTex.value = set.uniform.value;
    set.avg.forEach((c, i) => uniforms.uStructAvg.value[i].copy(c));
    set.has.forEach((h, i) => (uniforms.uStructHas.value[i] = h ? 1 : 0));
  };
  sync();
  // until decoded the placeholder is flat: no detail at all
  uniforms.uStructHas.value.fill(0);
  void set.ready.then(sync);
}

export function disposeStructureMaterial(): void {
  mat?.dispose();
  mat = null;
  uniforms.uStructTex.value = null;
}
