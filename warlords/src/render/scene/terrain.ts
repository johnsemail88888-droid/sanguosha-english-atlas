// Terrain mesh from MapData.heights: chunked for frustum culling, vertex
// coloured by slope / height (grass, dry grass, dirt, rock, sand near water),
// plus an outer "skirt" of hills beyond the playable square so the horizon
// never shows the edge of the world.
//
// AI-art mode (tex/grass, dirt, cliff, paving, mud shipped): the same meshes
// get a per-vertex ground-use splat (terrainSplat.ts) and ONE material that
// blends the two dominant layers of a texture array per fragment (≤ 5 texture
// samples: anti-tiling on each layer, side projections on cliffs), world-
// space UVs, macro variation and height-based transitions. Without the files
// the material stays the procedural vertex-colour one.
import * as THREE from 'three';
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { NATURE } from '../palette';
import { col } from '../core/geo';
import { fbm2, valueNoise2 } from '../core/noise';
import { onWorldArtQuality, requestGroundSet, worldArtQuality, type TexArraySet } from '../core/worldArt';
import { computeGroundSplat, dryness, FLOW_STRIDE, SPLAT_STRIDE, type GroundSplat } from './terrainSplat';
import { applySkyArtFog, skyArtFogKey } from '../core/skyArtFog';

const CHUNKS = 4;

let terrainMat: THREE.MeshStandardMaterial | null = null;

/** Uniforms of the textured variant (shared objects: swapping a value never recompiles). */
const artUniforms = {
  uGroundTex: { value: null as THREE.DataArrayTexture | null },
  uWaterLevel: { value: 0 },
  uGrassAvg: { value: new THREE.Color(0.2, 0.3, 0.08) },
  uCliffAvg: { value: new THREE.Color(0.25, 0.23, 0.2) },
  uGrassTexAvg: { value: new THREE.Color(0.2, 0.3, 0.08) },
  /** the Red Cliffs (赤壁) landmark: rock within (x, z, radius) warms to red sandstone; w = strength */
  uRedRock: { value: new THREE.Vector4(0, 0, 1, 0) },
};

/** Tile size (m) per ground layer: grass, dirt, cliff, paving, mud (cliffs: see CLIFF_*). */
export const GROUND_TILE_M = [5.6, 4.6, 14.0, 3.6, 6.0] as const;
/** Cliff strata sample: metres per image (u along the face, v up) — long, low slabs. */
const CLIFF_STRATA_M = [62.0, 24.0] as const;
/** Cliff fracture sample: metres per image, turn (degrees) and the distance it has faded out by. */
const CLIFF_FRACTURE_M = 13.0;
const CLIFF_FRACTURE_DEG = 32;
const CLIFF_FRACTURE_FAR = 180.0;

const ART_PARS_VERTEX = /* glsl */ `
#ifdef WORLD_TEX
attribute vec4 aSplat;
attribute vec2 aFlow;
varying vec4 vSplat;
varying vec2 vFlow;
varying vec3 vWNrmT;
#endif`;

const ART_VERTEX = /* glsl */ `
#ifdef WORLD_TEX
vSplat = aSplat;
vFlow = aFlow;
vWNrmT = normalize(mat3(modelMatrix) * objectNormal);
#endif`;

// Texture-array terrain: weights for grass / dirt / cliff / paving / mud, the
// two strongest layers sampled (IQ "technique 3" anti-tiling: two offsets per
// layer, textureGrad so layer / offset switches never break mip selection),
// height-blended by texture luminance for crisp organic borders.
const ART_PARS_FRAGMENT = /* glsl */ `
#ifdef WORLD_TEX
uniform highp sampler2DArray uGroundTex;
uniform float uWaterLevel;
uniform vec3 uGrassAvg;
uniform vec3 uCliffAvg;
uniform vec3 uGrassTexAvg;
uniform vec4 uRedRock;
varying vec4 vSplat;
varying vec2 vFlow;
varying vec3 vWNrmT;
const float G_TILE[5] = float[5](${GROUND_TILE_M.map((t) => t.toFixed(2)).join(', ')});

// arithmetic hash (no sin: cheaper on every GPU and in software rasterisers, and
// stable at large world coordinates)
float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// one projection of one layer. On roads the second sample is the texture
// turned 90° and 'orient' picks the one whose streaks follow the road;
// elsewhere the two samples are anti-tiling offsets. lq: single sample.
vec3 gTex(float layer, vec2 uv, vec2 gx, vec2 gy, float orient, float road, bool lq) {
#ifdef GROUND_LQ
  lq = true;
#endif
  if (lq) {
    // one sample: turned to follow the road where one runs, no anti-tiling pair
    bool turn = road * orient > 0.5;
    return textureGrad(uGroundTex, vec3(turn ? uv.yx : uv, layer), turn ? gx.yx : gx, turn ? gy.yx : gy).rgb;
  }
  // offset index changes about once per tile (IQ technique 3)
  float k = gNoise(uv * 0.85 + layer * 7.31);
  float l = k * 8.0; float i = floor(l); float f = l - i;
  vec2 oa = sin(vec2(3.0, 7.0) * i); vec2 ob = sin(vec2(3.0, 7.0) * (i + 1.0));
  vec3 a = textureGrad(uGroundTex, vec3(uv + oa, layer), gx, gy).rgb;
  vec2 uvB = mix(uv + ob, uv.yx + oa.yx, road);
  vec2 gxB = mix(gx, gx.yx, road); vec2 gyB = mix(gy, gy.yx, road);
  vec3 b = textureGrad(uGroundTex, vec3(uvB, layer), gxB, gyB).rgb;
  float t = mix(smoothstep(0.2, 0.8, f - 0.1 * dot(a - b, vec3(1.0))), orient, road);
  return mix(a, b, t);
}
// cliffs: side projections around the face heading (no stretching on steep faces). The
// painted cliff is a stacked-stone pattern (2 × 2 repeats per image), so it is
// never shown as-is over a whole face: the strata sample stretches it into
// long, low beds (${CLIFF_STRATA_M[0]} × ${CLIFF_STRATA_M[1]} m per image, domain-warped so no joint lines
// up), and a finer copy turned ${CLIFF_FRACTURE_DEG}° crosses them as fractures — its value
// only — breaking every course into irregular blocks (axe-cut strokes, 斧劈皴)
// and hiding both repeats. Far away the strata blur into tonal masses with
// soft weathering streaks. ≤ 2 samples per projection; the vertical warp is
// shared by the projections so their beds line up where they blend.
vec3 gCliffProj(vec2 q, vec2 qx, vec2 qy, float warpV, float detW, float blur, float soften, bool lq) {
#ifdef GROUND_LQ
  lq = true;
#endif
  float wu = gNoise(q * vec2(0.019, 0.031) + 5.3) - 0.5;
  vec2 wq = q + vec2(wu * 34.0, warpV);
  const vec2 SM = vec2(${(1 / CLIFF_STRATA_M[0]).toFixed(5)}, ${(1 / CLIFF_STRATA_M[1]).toFixed(5)});
  vec3 c = textureGrad(uGroundTex, vec3(wq * SM + 0.41, 2.0), qx * SM * blur, qy * SM * blur).rgb;
  // soften the painted joints: the regular dark grid is what reads as masonry
  float la = dot(c, vec3(0.333)) / max(dot(uCliffAvg, vec3(0.333)), 0.02);
  c *= mix(1.0, clamp(0.62 / max(la, 0.05), 1.0, 2.2), soften);
  if (!lq && detW > 0.01) {
    const mat2 RT = mat2(${Math.cos((CLIFF_FRACTURE_DEG * Math.PI) / 180).toFixed(4)}, ${Math.sin((CLIFF_FRACTURE_DEG * Math.PI) / 180).toFixed(4)}, ${(-Math.sin((CLIFF_FRACTURE_DEG * Math.PI) / 180)).toFixed(4)}, ${Math.cos((CLIFF_FRACTURE_DEG * Math.PI) / 180).toFixed(4)});
    const float SD = ${(1 / CLIFF_FRACTURE_M).toFixed(5)};
    vec2 dq = RT * (q + vec2(warpV * 0.7, wu * 5.0)) * SD;
    float d = dot(textureGrad(uGroundTex, vec3(dq + vec2(0.17, 0.63), 2.0), RT * qx * SD, RT * qy * SD).rgb, vec3(0.333));
    c *= mix(1.0, clamp(d / max(dot(uCliffAvg, vec3(0.333)), 0.02), 0.45, 1.5), detW);
  }
  // weathering streaks running down the face
  float streak = gNoise(vec2(q.x * 0.085, q.y * 0.014 + wu));
  return c * (0.9 + 0.18 * streak);
}
// one side projection, heading k·45° (k = 0..3): u along the face, v up
vec3 gCliffSide(float k, vec3 p, vec3 dpx, vec3 dpy, float warpV, float detW, float blur, float soften, bool lq) {
  float th = k * 0.78539816;
  vec2 t = vec2(-sin(th), cos(th));
  vec2 q = vec2(dot(p.xz, t) + k * 11.3, p.y);
  return gCliffProj(q, vec2(dot(dpx.xz, t), dpx.y), vec2(dot(dpy.xz, t), dpy.y), warpV, detW, blur, soften, lq);
}
vec3 gCliff(vec3 p, vec3 n, vec3 dpx, vec3 dpy, bool lq) {
  // four side projections every 45°: the two nearest the face's heading,
  // blended only in a narrow band between them — at most 8 % stretch and far
  // less ghosting than two axis projections (whose 45° blend drew an X on the
  // round peaks); still ≤ 2 projections per fragment, mostly 1
  float hl = length(n.xz);
  float f = mod((hl > 1e-4 ? atan(n.z, n.x) : 0.0) / 0.78539816, 4.0);
  float k0 = floor(f);
  float k1 = mod(k0 + 1.0, 4.0);
  float tb = smoothstep(0.34, 0.66, f - k0);
  float dist = length(p - cameraPosition);
  // fracture strength: full up close, a hint at mid range, gone far away
  float detW = 0.8 - 0.45 * smoothstep(10.0, 60.0, dist) - 0.35 * smoothstep(90.0, ${CLIFF_FRACTURE_FAR.toFixed(1)}, dist);
  // far faces: the strata turn into tonal masses (mip bias), never a pattern
  float blur = 1.0 + 2.5 * smoothstep(140.0, 420.0, dist);
  // bed warp along the height, the same for both projections: a broad fold
  // plus a tighter one that pinches and swells the beds (thin / thick courses)
  float hc = p.x * 0.8 + p.z * 0.6;
  float warpV = (gNoise(vec2(hc * 0.017, p.y * 0.045)) - 0.5) * 9.0 + (gNoise(vec2(hc * 0.031 + 3.7, p.y * 0.1)) - 0.5) * 5.5;
  // joint softening: the painted joints give close rock its definition, but a
  // big face far away would show them as a regular grid (or grain on a peak)
  float soften = 0.5 + 0.35 * smoothstep(40.0, 220.0, dist);
  vec3 c;
  if (tb < 0.01) c = gCliffSide(k0, p, dpx, dpy, warpV, detW, blur, soften, lq);
  else if (tb > 0.99) c = gCliffSide(k1, p, dpx, dpy, warpV, detW, blur, soften, lq);
  else c = mix(gCliffSide(k0, p, dpx, dpy, warpV, detW, blur, soften, lq), gCliffSide(k1, p, dpx, dpy, warpV, detW, blur, soften, lq), tb);
  // far faces (the great corner peaks): calmer rock with irregular ledges
  // following the beds, so a tall face reads as terraced stone (not grain)
  float farT = smoothstep(110.0, 320.0, dist);
  if (farT > 0.0) {
    float lb = gNoise(vec2(hc * 0.021 + 1.3, (p.y + warpV) * 0.085));
    float ledge = smoothstep(0.6, 0.74, lb);
    c = mix(c, mix(c, uCliffAvg, 0.5), farT);
    // lit ledges with scrub on them (苔点), shaded bands between
    c *= 1.0 + farT * (0.34 * ledge - 0.1);
    c = mix(c, c * vec3(0.84, 1.06, 0.78), ledge * farT * 0.7);
  }
  // 赤壁: the landmark's cliffs are red sandstone
  float red = uRedRock.w * (1.0 - smoothstep(uRedRock.z * 0.6, uRedRock.z, length(p.xz - uRedRock.xy)));
  c *= mix(vec3(1.0), vec3(1.45, 0.86, 0.66), red);
  // green-and-blue landscape (青绿山水): moss and scrub on the faces that tilt
  // up, cooler and sparser with distance — shaded by the rock under it
  float mn = gNoise(p.xz * 0.045 + p.y * 0.03) * 0.65 + gNoise(p.xz * 0.21 + p.y * 0.13) * 0.35 - 0.5;
  float moss = smoothstep(0.46, 0.53, n.y + mn * 0.55);
  moss *= 0.85 - 0.3 * smoothstep(60.0, 300.0, dist);
  float rock = dot(c, vec3(0.333)) / max(dot(uCliffAvg, vec3(0.333)), 0.02);
  vec3 mossC = uGrassTexAvg * vec3(0.8, 0.88, 0.74) * (0.97 + 0.5 * mn) * clamp(rock, 0.45, 1.3);
  mossC = mix(vec3(dot(mossC, vec3(0.3, 0.59, 0.11))), mossC, 0.75);
  return mix(c, mossC, moss);
}
vec3 gLayer(float layer, vec3 p, vec3 n, vec3 dpx, vec3 dpy, float orient, float road, bool lq) {
  if (layer > 1.5 && layer < 2.5) return gCliff(p, n, dpx, dpy, lq);
  // only dirt and paving follow roads
  float r = (layer > 0.5 && layer < 3.5) ? road : 0.0;
  float s = 1.0 / G_TILE[int(layer)];
  vec3 c = gTex(layer, p.xz * s, dpx.xz * s, dpy.xz * s, orient, r, lq);
  // grass seen from afar: a 3.4x larger copy takes over so its blotches never form a grid
  float farG = layer < 0.5 ? smoothstep(18.0, 80.0, length(p - cameraPosition)) : 0.0;
#ifndef GROUND_LQ
  if (farG > 0.01 && !lq) {
    float sf = s * 0.29;
    vec3 cf = textureGrad(uGroundTex, vec3(p.xz * sf + 0.53, 0.0), dpx.xz * sf, dpy.xz * sf).rgb;
    c = mix(c, cf, farG * 0.75);
  }
#endif
  // painterly grass is very saturated: pull it toward the warm late-afternoon palette
  if (layer < 0.5) c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 0.8) * vec3(1.04, 1.0, 0.9);
  // and the orange painted dirt toward trodden loess
  else if (layer < 1.5) c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 0.72) * vec3(1.0, 0.98, 0.95);
  return c;
}
#endif`;

const ART_FRAGMENT = /* glsl */ `
#ifdef WORLD_TEX
{
  vec3 p = vWorldPosT;
  vec3 dpx = dFdx(p);
  vec3 dpy = dFdy(p);
  vec3 n = normalize(vWNrmT);
  // organic edge breakup for the painted zones
  float e1 = gNoise(p.xz * 0.23);
  float e2 = gNoise(p.xz * 0.9 + 11.0);
  float edge = (e1 * 0.7 + e2 * 0.3 - 0.5);
  float dirtS = clamp(vSplat.x * 1.15 + edge * 0.55, 0.0, 1.0);
  float paveS = clamp(vSplat.y * 1.2 + edge * 0.35, 0.0, 1.0);
  float mudS = clamp(vSplat.z + edge * 0.45, 0.0, 1.0);
  // slope → cliff (normal.y 0.76 ≈ 40°, 0.56 ≈ 56°), high peaks rockier
  float cliffS = smoothstep(0.76, 0.56, n.y + edge * 0.08);
  cliffS = max(cliffS, smoothstep(34.0, 60.0, p.y) * smoothstep(0.93, 0.8, n.y));
  // priority: cliff > paving > dirt > mud > grass
  float rest = 1.0;
  float wc = cliffS; rest -= wc;
  float wp = paveS * rest; rest -= wp;
  float wd = dirtS * rest; rest -= wd;
  float wm = mudS * rest; rest -= wm;
  float wg = max(rest, 0.0);
  float w[5] = float[5](wg, wd, wc, wp, wm);
  // two strongest layers
  float iA = 0.0; float wA = w[0];
  for (int i = 1; i < 5; i++) if (w[i] > wA) { wA = w[i]; iA = float(i); }
  float iB = iA < 0.5 ? 1.0 : 0.0; float wB = -1.0;
  for (int i = 0; i < 5; i++) if (float(i) != iA && w[i] > wB) { wB = w[i]; iB = float(i); }
  wB = max(wB, 0.0);
  float roadW = clamp(length(vFlow) * 1.6, 0.0, 1.0);
  float orient = smoothstep(-0.3, 0.3, abs(vFlow.x) - abs(vFlow.y));
  // sample budget ≤ 5: the weaker layer drops to one sample next to a cliff,
  // and is skipped entirely where it has no weight
  bool cliffPair = iA > 1.5 && iA < 2.5 || iB > 1.5 && iB < 2.5;
  vec3 cA = gLayer(iA, p, n, dpx, dpy, orient, roadW, false);
  vec3 cB = cA;
  if (wB > 0.015) cB = gLayer(iB, p, n, dpx, dpy, orient, roadW, cliffPair);
  // height blend (luminance as a height proxy): the higher surface wins the border
  float hA = dot(cA, vec3(0.333)) + wA;
  float hB = dot(cB, vec3(0.333)) + wB;
  float ma = max(hA, hB) - 0.14;
  float bA = max(hA - ma, 0.0);
  float bB = max(hB - ma, 0.0);
  vec3 c = (cA * bA + cB * bB) / max(bA + bB, 1e-4);
  // macro variation: lush / dry grass patches (the vertex-colour noise) and broad brightness
  float grassShare = (iA < 0.5 ? bA : 0.0) + (iB < 0.5 ? bB : 0.0);
  grassShare /= max(bA + bB, 1e-4);
  float dry = vSplat.w;
  vec3 dryTint = mix(vec3(0.86, 1.0, 0.82), vec3(1.16, 1.04, 0.66), dry);
  c *= mix(vec3(1.0), dryTint, grassShare * 0.85);
  // (height term: on steep faces the variation runs both ways, not in vertical bands)
  float macro = gNoise(p.xz * 0.011 + p.y * 0.013 + 5.0) * 0.65 + gNoise(p.xz * 0.037 - p.y * 0.041) * 0.35;
  c *= 0.86 + 0.26 * macro;
  // the old vertex colours' brightness as a faint tint keeps shores / high ground readable
  const vec3 LUMA = vec3(0.3, 0.59, 0.11);
  c *= mix(1.0, dot(vColor.rgb, LUMA) / max(dot(uGrassAvg, LUMA), 0.02), 0.15);
  // wet banks darker, river bed tinted by the water above it
  float wet = smoothstep(uWaterLevel + 0.9, uWaterLevel + 0.1, p.y);
  c *= mix(vec3(1.0), vec3(0.72, 0.7, 0.66), wet);
  c *= mix(vec3(1.0), vec3(0.62, 0.72, 0.7), smoothstep(uWaterLevel - 0.2, uWaterLevel - 1.6, p.y));
  // aerial perspective: far ground loses saturation before the fog takes it
  c = mix(c, vec3(dot(c, LUMA)), 0.35 * smoothstep(110.0, 480.0, length(p - cameraPosition)));
  diffuseColor.rgb = c;
}
#endif`;

/** Terrain material: vertex colours + cheap world-space detail noise in the fragment shader. */
export function terrainMaterial(): THREE.MeshStandardMaterial {
  if (terrainMat) return terrainMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  m.name = 'terrain';
  m.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, m);
    const art = m.defines?.WORLD_TEX !== undefined;
    if (art) {
      shader.uniforms.uGroundTex = artUniforms.uGroundTex;
      shader.uniforms.uWaterLevel = artUniforms.uWaterLevel;
      shader.uniforms.uGrassAvg = artUniforms.uGrassAvg;
      shader.uniforms.uCliffAvg = artUniforms.uCliffAvg;
      shader.uniforms.uGrassTexAvg = artUniforms.uGrassTexAvg;
      shader.uniforms.uRedRock = artUniforms.uRedRock;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPosT;${ART_PARS_VERTEX}`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\nvWorldPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;${ART_VERTEX}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosT;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x), f.y);
}${ART_PARS_FRAGMENT}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifndef WORLD_TEX
{
  vec2 wp = vWorldPosT.xz;
  float n1 = tNoise(wp * 0.35);
  float n2 = tNoise(wp * 2.3);
  float n3 = tNoise(wp * 0.06);
  diffuseColor.rgb *= 0.86 + 0.12 * n1 + 0.08 * n2 + 0.08 * n3;
}
#endif${ART_FRAGMENT}`,
      );
  };
  m.customProgramCacheKey = () => `terrain_v3${skyArtFogKey()}`;
  terrainMat = m;
  return m;
}

/** Switch the (shared) terrain material to its textured variant / sample count. */
function applyArtDefines(m: THREE.MeshStandardMaterial, set: TexArraySet | null): void {
  const d = (m.defines ??= {});
  const before = `${d.WORLD_TEX !== undefined}${d.GROUND_LQ !== undefined}`;
  if (set) d.WORLD_TEX = '';
  else delete d.WORLD_TEX;
  if (set && worldArtQuality() === 'low') d.GROUND_LQ = '';
  else delete d.GROUND_LQ;
  if (`${d.WORLD_TEX !== undefined}${d.GROUND_LQ !== undefined}` !== before) m.needsUpdate = true;
}

/** Colour for a terrain sample (linear rgb written into out). */
export function terrainColor(h: number, slope: number, x: number, z: number, water: number, out: THREE.Color): THREE.Color {
  const n = fbm2(x * 0.02, z * 0.02, 3);
  const n2 = valueNoise2(x * 0.11 + 17, z * 0.11 - 5);
  out.copy(col(NATURE.grass));
  // lush vs dry patches
  out.lerp(col(NATURE.grassLush), smooth(0.35, 0.6, n));
  out.lerp(col(NATURE.grassDry), smooth(0.55, 0.8, n) * 0.8);
  // higher ground gets drier
  out.lerp(col(NATURE.grassDry), smooth(10, 22, h) * 0.55);
  // dirt on medium slopes / worn patches
  out.lerp(col(NATURE.dirt), Math.max(smooth(0.22, 0.4, slope), smooth(0.72, 0.85, n2) * 0.6));
  // rock on steep slopes and high peaks
  out.lerp(col(NATURE.rock), Math.max(smooth(0.4, 0.6, slope), smooth(26, 38, h)));
  out.lerp(col(NATURE.rockDark), smooth(0.6, 0.85, slope) * 0.6);
  // shores and river bed
  if (water > -50) {
    out.lerp(col(NATURE.sand), smooth(water + 1.4, water + 0.2, h));
    out.lerp(col(NATURE.riverbed), smooth(water - 0.2, water - 1.5, h));
  }
  return out;
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface TerrainMeshes {
  group: THREE.Group;
  dispose(): void;
}

/** Ground-use data of the textured terrain for other systems (grass tufts), or null in procedural mode. */
export interface GroundArt {
  splat: GroundSplat;
  /** linear average colour of the grass texture */
  grassAvg: THREE.Color;
}

let groundArt: GroundArt | null = null;
const groundArtSubs = new Set<() => void>();

/** The active textured-ground data (null: procedural terrain). */
export function currentGroundArt(): GroundArt | null {
  return groundArt;
}

/** Called when the terrain switches to / refines its textured mode (grass tufts re-scatter). */
export function onGroundArt(cb: () => void): () => void {
  groundArtSubs.add(cb);
  return () => groundArtSubs.delete(cb);
}

interface ChunkInfo {
  geo: THREE.BufferGeometry;
  x0: number;
  z0: number;
  w: number;
  d: number;
}

/** Build chunked terrain + outer skirt. */
export function buildTerrain(map: MapData): TerrainMeshes {
  const group = new THREE.Group();
  group.name = 'terrain';
  const mat = terrainMaterial();
  const n = map.res + 1;
  const cell = map.size / map.res;
  const half = map.size / 2;
  const H = map.heights;
  const hAt = (ix: number, iz: number): number =>
    H[Math.min(map.res, Math.max(0, iz)) * n + Math.min(map.res, Math.max(0, ix))];
  const tmpC = new THREE.Color();
  const per = Math.ceil(map.res / CHUNKS);
  const chunks: ChunkInfo[] = [];
  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      const x0 = cx * per;
      const z0 = cz * per;
      const x1 = Math.min(map.res, x0 + per);
      const z1 = Math.min(map.res, z0 + per);
      if (x1 <= x0 || z1 <= z0) continue;
      const w = x1 - x0 + 1;
      const d = z1 - z0 + 1;
      const pos = new Float32Array(w * d * 3);
      const nrm = new Float32Array(w * d * 3);
      const clr = new Float32Array(w * d * 3);
      for (let j = 0; j < d; j++) {
        for (let i = 0; i < w; i++) {
          const ix = x0 + i;
          const iz = z0 + j;
          const k = (j * w + i) * 3;
          const x = -half + ix * cell;
          const z = -half + iz * cell;
          const y = hAt(ix, iz);
          pos[k] = x;
          pos[k + 1] = y;
          pos[k + 2] = z;
          const dx = (hAt(ix + 1, iz) - hAt(ix - 1, iz)) / (2 * cell);
          const dz = (hAt(ix, iz + 1) - hAt(ix, iz - 1)) / (2 * cell);
          const len = Math.hypot(dx, 1, dz);
          nrm[k] = -dx / len;
          nrm[k + 1] = 1 / len;
          nrm[k + 2] = -dz / len;
          const slope = 1 - 1 / len;
          terrainColor(y, slope * 2.2, x, z, map.waterLevel, tmpC);
          clr[k] = tmpC.r;
          clr[k + 1] = tmpC.g;
          clr[k + 2] = tmpC.b;
        }
      }
      const idx: number[] = [];
      for (let j = 0; j < d - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          const b = a + 1;
          const c = a + w;
          const e = c + 1;
          // alternate diagonal to reduce directional artefacts
          if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, e);
          else idx.push(a, c, e, a, e, b);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('color', new THREE.BufferAttribute(clr, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      chunks.push({ geo: g, x0, z0, w, d });
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = `terrain_${cx}_${cz}`;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  const skirt = buildSkirt(map);
  group.add(skirt);

  // AI-art ground: splat attributes + textured program (as soon as the listing is known)
  let disposed = false;
  let activeSet: TexArraySet | null = null;
  const unsubQ = onWorldArtQuality(() => {
    if (activeSet) applyArtDefines(mat, activeSet);
  });
  requestGroundSet((set) => {
    if (disposed) return;
    const splat = computeGroundSplat(map);
    for (const ch of chunks) addSplatAttributes(ch, splat, map.res);
    addSkirtSplat(skirt.geometry);
    artUniforms.uGroundTex.value = set.uniform.value;
    artUniforms.uWaterLevel.value = map.waterLevel;
    artUniforms.uGrassAvg.value.copy(col(NATURE.grass));
    const rc = map.regions.find((r) => r.id === 'redcliffs');
    if (rc) artUniforms.uRedRock.value.set(rc.center.x, rc.center.z, Math.max(40, rc.radius * 2.6), 1);
    else artUniforms.uRedRock.value.set(0, 0, 1, 0);
    activeSet = set;
    applyArtDefines(mat, set);
    groundArt = { splat, grassAvg: set.avg[0] };
    for (const cb of groundArtSubs) cb();
    artUniforms.uCliffAvg.value.copy(set.avg[2]);
    artUniforms.uGrassTexAvg.value.copy(set.avg[0]);
    void set.ready.then(() => {
      if (disposed) return;
      artUniforms.uGroundTex.value = set.uniform.value;
      artUniforms.uCliffAvg.value.copy(set.avg[2]);
      artUniforms.uGrassTexAvg.value.copy(set.avg[0]);
      groundArt = { splat, grassAvg: set.avg[0] };
      for (const cb of groundArtSubs) cb();
    });
  });
  return {
    group,
    dispose(): void {
      disposed = true;
      unsubQ();
      if (activeSet) {
        groundArt = null;
        applyArtDefines(mat, null);
        artUniforms.uGroundTex.value = null;
      }
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    },
  };
}

function addSplatAttributes(ch: ChunkInfo, g: GroundSplat, res: number): void {
  const n = res + 1;
  const count = ch.w * ch.d;
  const splat = new Float32Array(count * 4);
  const flow = new Float32Array(count * 2);
  for (let j = 0; j < ch.d; j++) {
    for (let i = 0; i < ch.w; i++) {
      const src = (ch.z0 + j) * n + (ch.x0 + i);
      const dst = j * ch.w + i;
      for (let c = 0; c < 4; c++) splat[dst * 4 + c] = g.splat[src * SPLAT_STRIDE + c];
      flow[dst * 2] = g.flow[src * FLOW_STRIDE];
      flow[dst * 2 + 1] = g.flow[src * FLOW_STRIDE + 1];
    }
  }
  ch.geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
  ch.geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
}

/** Skirt: no structures out there — only the macro dryness. */
function addSkirtSplat(geo: THREE.BufferGeometry): void {
  const P = geo.getAttribute('position') as THREE.BufferAttribute;
  const splat = new Float32Array(P.count * 4);
  for (let i = 0; i < P.count; i++) splat[i * 4 + 3] = dryness(P.getX(i), P.getZ(i), P.getY(i));
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
  geo.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(P.count * 2), 2));
}

/** Coarse hills around the playable square, fading from the edge heights into rolling ridges. */
function buildSkirt(map: MapData): THREE.Mesh {
  const half = map.size / 2;
  const cell = 20;
  const cellsIn = Math.ceil(half / cell);
  const inner = cellsIn * cell;
  const ext = 1400;
  const count = Math.ceil((ext - inner) / cell);
  const N = (cellsIn + count) * 2;
  const origin = -(cellsIn + count) * cell;
  const verts = N + 1;
  const pos = new Float32Array(verts * verts * 3);
  const clr = new Float32Array(verts * verts * 3);
  const tmpC = new THREE.Color();
  const edgeClampH = (x: number, z: number): number => {
    const cx = Math.max(-half, Math.min(half, x));
    const cz = Math.max(-half, Math.min(half, z));
    return terrainHeight(map, cx, cz);
  };
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = origin + i * cell;
      const z = origin + j * cell;
      const k = (j * verts + i) * 3;
      const out = Math.max(Math.abs(x), Math.abs(z)) - half; // distance beyond the edge
      let y: number;
      if (out <= 0) y = terrainHeight(map, x, z) - 0.6;
      else {
        const edgeH = edgeClampH(x, z);
        const hills = 18 + fbm2(x * 0.004, z * 0.004, 4) * 90 * smooth(0, 500, out);
        const t = smooth(0, 160, out);
        y = edgeH * (1 - t) + hills * t;
      }
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = z;
      terrainColor(y, out > 0 ? 0.15 : 0.05, x, z, map.waterLevel, tmpC);
      clr[k] = tmpC.r;
      clr[k + 1] = tmpC.g;
      clr[k + 2] = tmpC.b;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x0 = origin + i * cell;
      const z0 = origin + j * cell;
      // skip cells fully inside the playable square (shrunk by one cell)
      if (x0 >= -half + cell && x0 + cell <= half - cell && z0 >= -half + cell && z0 + cell <= half - cell) continue;
      const a = j * verts + i;
      const b = a + 1;
      const c = a + verts;
      const e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(clr, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, terrainMaterial());
  mesh.receiveShadow = false;
  mesh.name = 'terrain_skirt';
  mesh.matrixAutoUpdate = false;
  return mesh;
}
