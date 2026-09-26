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
import { applySkyArtFog, skyArtFogKey } from './skyArtFog';

/**
 * Surface ids (integer part of aSurf; the fraction carries the prop yaw).
 * 0 = plain vertex colour. Ids 1..6 index STRUCT_LAYERS + 1; WOOD_V is the
 * planks layer turned 90° (vertical grain: posts, palisades, poles).
 * PROC_DETAIL marks procedural-only detail (painted brick courses) that the
 * textured look replaces: its triangles collapse once the brick texture is in.
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
  procDetail: 8,
} as const;
export type SurfId = (typeof SURF)[keyof typeof SURF];

/**
 * The yaw fraction lives in [SURF_YAW_LO, SURF_YAW_LO + SURF_YAW_SPAN], well
 * inside (0, 1): the interpolated varying can sit a hair below / above the
 * vertex value, and a fraction packed at exactly 0 would wrap to 0.9999 in
 * fract() — a 7° turn of the world-space UVs, i.e. a texel mosaic.
 */
export const SURF_YAW_LO = 0.02;
export const SURF_YAW_SPAN = 0.96;

/** Pack a surface id + yaw (radians) into the aSurf channel value. */
export function packSurf(id: SurfId, yaw = 0): number {
  if (id === SURF.plain) return 0;
  const t = yaw / (Math.PI * 2);
  return id + SURF_YAW_LO + (t - Math.floor(t)) * SURF_YAW_SPAN;
}

/** Inverse of packSurf (tests / tools). Mirrors the shader's decode. */
export function unpackSurf(v: number): { id: number; yaw: number } {
  const id = Math.floor(v);
  return { id, yaw: ((v - id - SURF_YAW_LO) / SURF_YAW_SPAN) * Math.PI * 2 };
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
uniform float uStructHas[${STRUCT_LAYERS.length}];
varying float vSurf;
varying vec3 vSPos;
varying vec3 vSNrm;`;

// procedural-only detail (brick courses): degenerate once the brick texture draws the real mortar
const COLLAPSE_VERTEX = /* glsl */ `
if (aSurf > ${SURF.procDetail.toFixed(1)} && aSurf < ${(SURF.procDetail + 1).toFixed(1)} && uStructHas[0] > 0.5) transformed = vec3(0.0);`;

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
  float sid = floor(vSurf);
  if (sid > 0.5 && sid < ${(SURF.procDetail - 0.5).toFixed(1)}) {
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
      float yaw = (clamp(vSurf - sid, ${SURF_YAW_LO.toFixed(3)}, ${(SURF_YAW_LO + SURF_YAW_SPAN).toFixed(3)}) - ${SURF_YAW_LO.toFixed(3)}) / ${SURF_YAW_SPAN.toFixed(3)} * 6.2831853;
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
let matDouble: THREE.MeshStandardMaterial | null = null;

function makeStructureMaterial(double: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0 });
  m.name = double ? 'structureDouble' : 'structure';
  if (double) m.side = THREE.DoubleSide;
  m.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, m);
    shader.uniforms.uStructTex = uniforms.uStructTex;
    shader.uniforms.uStructAvg = uniforms.uStructAvg;
    shader.uniforms.uStructHas = uniforms.uStructHas;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${COLLAPSE_VERTEX}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${PARS_FRAGMENT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>${FRAGMENT}`);
  };
  m.customProgramCacheKey = () => `structure_v2${double ? '_ds' : ''}${skyArtFogKey()}`;
  return m;
}

/** The textured structure material (same look as worldMaterial() plus surface detail). */
export function structureMaterial(): THREE.MeshStandardMaterial {
  return (mat ??= makeStructureMaterial(false));
}

/**
 * Double-sided variant (same look as worldMaterialDouble() plus surface detail):
 * the merged 'cloth' chunks — thin cloth, sails, and the roof shells, which are
 * double-sided so a camera pulled into an eave never sees a culled / black face
 * (camera/camOccluders.ts). Plain-surface cloth draws exactly as before.
 */
export function structureMaterialDouble(): THREE.MeshStandardMaterial {
  return (matDouble ??= makeStructureMaterial(true));
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
  matDouble?.dispose();
  mat = matDouble = null;
  uniforms.uStructTex.value = null;
}
