// Terrain mesh from MapData.heights: chunked for frustum culling, vertex
// coloured by slope / height (grass, dry grass, dirt, rock, sand near water),
// plus an outer "skirt" of hills beyond the playable square so the horizon
// never shows the edge of the world.
//
// AI-art mode (tex/grass, dirt, cliff, paving, mud shipped): the same meshes
// get a per-vertex ground-use splat (terrainSplat.ts) and ONE material that
// blends the two dominant layers of a texture array per fragment (≤ 4 texture
// samples: anti-tiling on each layer, biplanar projection on cliffs), world-
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

const CHUNKS = 4;

let terrainMat: THREE.MeshStandardMaterial | null = null;

/** Uniforms of the textured variant (shared objects: swapping a value never recompiles). */
const artUniforms = {
  uGroundTex: { value: null as THREE.DataArrayTexture | null },
  uWaterLevel: { value: 0 },
  uGrassAvg: { value: new THREE.Color(0.2, 0.3, 0.08) },
  uCliffAvg: { value: new THREE.Color(0.25, 0.23, 0.2) },
};

/** Tile size (m) per ground layer: grass, dirt, cliff, paving, mud. */
export const GROUND_TILE_M = [5.6, 4.6, 14.0, 3.6, 6.0] as const;
/** Large-scale cliff tile (m): far / big rock faces read as strata, not masonry. */
const CLIFF_FAR_M = 46.0;

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
varying vec4 vSplat;
varying vec2 vFlow;
varying vec3 vWNrmT;
const float G_TILE[5] = float[5](${GROUND_TILE_M.map((t) => t.toFixed(2)).join(', ')});

float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
  if (lq) return textureGrad(uGroundTex, vec3(uv, layer), gx, gy).rgb;
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
// cliffs: biplanar side projections (strata stay horizontal, no stretching on
// steep faces); a projection with negligible weight is skipped (2 samples on
// most cliff pixels, 4 only where the face turns through 45°)
vec3 gCliffProj(vec2 q, vec2 qx, vec2 qy, float farW, bool lq) {
  float s = 1.0 / G_TILE[2];
  vec3 near = textureGrad(uGroundTex, vec3(q * s, 2.0), qx * s, qy * s).rgb;
  vec3 c = near;
#ifdef GROUND_LQ
  lq = true;
#endif
  if (!lq) {
    // big rock faces: the same strata at ~3x scale, faded in with distance
    float sf = 1.0 / ${CLIFF_FAR_M.toFixed(1)};
    vec3 far = textureGrad(uGroundTex, vec3(q * sf + 0.41, 2.0), qx * sf, qy * sf).rgb;
    c = mix(near, far, farW);
  }
  // ink-wash rock: the blocky detail recedes with distance and vertical
  // weathering streaks (皴 strokes) take over, so a 600 m face never reads as masonry
  float streak = gNoise(vec2(q.x * 0.11, q.y * 0.012)) * 0.6 + gNoise(vec2(q.x * 0.37, q.y * 0.03) + 9.0) * 0.4;
  c = mix(uCliffAvg, c, mix(1.0, 0.42, farW)) * (0.72 + 0.56 * streak);
  return c;
}
vec3 gCliff(vec3 p, vec3 n, vec3 dpx, vec3 dpy, bool lq) {
  vec2 w = pow(abs(n.xz) + 0.001, vec2(6.0)); w /= (w.x + w.y);
  float dist = length(p - cameraPosition);
  float farW = 0.25 + 0.75 * smoothstep(20.0, 160.0, dist);
  vec3 c = vec3(0.0); float ws = 0.0;
  if (w.x > 0.03) { c += w.x * gCliffProj(p.zy, dpx.zy, dpy.zy, farW, lq); ws += w.x; }
  if (w.y > 0.03) { c += w.y * gCliffProj(p.xy + 0.37, dpx.xy, dpy.xy, farW, lq); ws += w.y; }
  return c / max(ws, 1e-4);
}
vec3 gLayer(float layer, vec3 p, vec3 n, vec3 dpx, vec3 dpy, float orient, float road, bool lq) {
  if (layer > 1.5 && layer < 2.5) return gCliff(p, n, dpx, dpy, lq);
  // only dirt and paving follow roads
  float r = (layer > 0.5 && layer < 3.5) ? road : 0.0;
  float s = 1.0 / G_TILE[int(layer)];
  vec3 c = gTex(layer, p.xz * s, dpx.xz * s, dpy.xz * s, orient, r, lq);
#ifndef GROUND_LQ
  if (layer < 0.5 && !lq) {
    // grass seen from afar: a 3.4x larger copy takes over so its blotches never form a grid
    float farW = smoothstep(18.0, 80.0, length(p - cameraPosition));
    if (farW > 0.01) {
      float sf = s * 0.29;
      vec3 cf = textureGrad(uGroundTex, vec3(p.xz * sf + 0.53, 0.0), dpx.xz * sf, dpy.xz * sf).rgb;
      c = mix(c, cf, farW * 0.75);
    }
  }
#endif
  // painterly grass is very saturated: pull it toward the warm late-afternoon palette
  if (layer < 0.5) c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 0.8) * vec3(1.04, 1.0, 0.9);
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
  float macro = gNoise(p.xz * 0.011 + 5.0) * 0.65 + gNoise(p.xz * 0.037) * 0.35;
  c *= 0.86 + 0.26 * macro;
  // the old vertex colours' brightness as a faint tint keeps shores / high ground readable
  const vec3 LUMA = vec3(0.3, 0.59, 0.11);
  c *= mix(1.0, dot(vColor.rgb, LUMA) / max(dot(uGrassAvg, LUMA), 0.02), 0.15);
  // wet banks darker, river bed tinted by the water above it
  float wet = smoothstep(uWaterLevel + 0.9, uWaterLevel + 0.1, p.y);
  c *= mix(vec3(1.0), vec3(0.72, 0.7, 0.66), wet);
  c *= mix(vec3(1.0), vec3(0.62, 0.72, 0.7), smoothstep(uWaterLevel - 0.2, uWaterLevel - 1.6, p.y));
  diffuseColor.rgb = c;
}
#endif`;

/** Terrain material: vertex colours + cheap world-space detail noise in the fragment shader. */
export function terrainMaterial(): THREE.MeshStandardMaterial {
  if (terrainMat) return terrainMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  m.name = 'terrain';
  m.onBeforeCompile = (shader) => {
    const art = m.defines?.WORLD_TEX !== undefined;
    if (art) {
      shader.uniforms.uGroundTex = artUniforms.uGroundTex;
      shader.uniforms.uWaterLevel = artUniforms.uWaterLevel;
      shader.uniforms.uGrassAvg = artUniforms.uGrassAvg;
      shader.uniforms.uCliffAvg = artUniforms.uCliffAvg;
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
  m.customProgramCacheKey = () => 'terrain_v2';
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
    activeSet = set;
    applyArtDefines(mat, set);
    groundArt = { splat, grassAvg: set.avg[0] };
    for (const cb of groundArtSubs) cb();
    artUniforms.uCliffAvg.value.copy(set.avg[2]);
    void set.ready.then(() => {
      if (disposed) return;
      artUniforms.uGroundTex.value = set.uniform.value;
      artUniforms.uCliffAvg.value.copy(set.avg[2]);
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
