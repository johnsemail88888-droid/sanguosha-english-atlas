// Terrain mesh from MapData.heights: chunked for frustum culling, vertex
// coloured by slope / height (grass, dry grass, dirt, rock, sand near water),
// plus an outer "skirt" of hills beyond the playable square so the horizon
// never shows the edge of the world.
import * as THREE from 'three';
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { NATURE } from '../palette';
import { col } from '../core/geo';
import { fbm2, valueNoise2 } from '../core/noise';

const CHUNKS = 4;

let terrainMat: THREE.MeshStandardMaterial | null = null;

/** Terrain material: vertex colours + cheap world-space detail noise in the fragment shader. */
export function terrainMaterial(): THREE.MeshStandardMaterial {
  if (terrainMat) return terrainMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  m.name = 'terrain';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosT;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorldPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;',
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
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 wp = vWorldPosT.xz;
  float n1 = tNoise(wp * 0.35);
  float n2 = tNoise(wp * 2.3);
  float n3 = tNoise(wp * 0.06);
  diffuseColor.rgb *= 0.86 + 0.12 * n1 + 0.08 * n2 + 0.08 * n3;
}`,
      );
  };
  m.customProgramCacheKey = () => 'terrain_v1';
  terrainMat = m;
  return m;
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
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = `terrain_${cx}_${cz}`;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  group.add(buildSkirt(map));
  return {
    group,
    dispose(): void {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    },
  };
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
