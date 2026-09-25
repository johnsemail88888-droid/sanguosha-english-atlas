// AI-art farm fields (tex/farm.webp: six crop rows over dark soil per image,
// rows running along the image's v axis). Every farmField prop becomes a
// terrain-hugging corrugated sheet: the rows follow the field's long axis, each
// crop row a rounded ridge whose crest carries a painted crop stripe (the
// furrows the soil between), and the field fades out over its last metre with a
// ragged, noisy edge — no stepped slabs, no hard rectangle. All fields are ONE
// mesh (one draw, no shadow casting), drawn early in the transparent pass so
// the edge fade blends onto the textured ground.
//
// Absent texture (single-file build, stripped deploy): nothing is fetched and
// the procedural fields stay (world.ts keeps them in a swap mesh until this
// mesh is ready).
import * as THREE from 'three';
import type { MapData, MapProp } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { hashString, valueNoise2 } from '../core/noise';
import { texFile, texSizesFor, worldArtQuality } from '../core/worldArt';
import { applySkyArtFog, skyArtFogKey } from '../core/skyArtFog';
import { capTexture } from './propModels';

export const FARM_TEX = texFile('farm');

/** Crop rows per texture repeat, and the u of the first row's crest (measured on the shipped image). */
export const FARM_ROWS_PER_TILE = 6;
export const FARM_CREST_U = 0.087;
/** Metres per texture repeat (both axes: the painted plants keep their proportions) → 0.75 m rows. */
export const FARM_TILE_M = 4.5;
/** Width (m) of the soft edge: crops shorten and fade out over it. */
export const FARM_EDGE_M = 1.3;
/** Vertex spacing along the rows (m); across the rows every half row (crest / furrow). */
const ALONG_STEP = 0.75;

/** Per-variant look: ridge height (m) and the recolour of the painted crops. */
export interface FarmLook {
  /** crest height above the ground (m) */
  ridge: number;
  /** 0: the painting as is (vegetables), 1: fully ripened to gold (wheat) */
  ripe: number;
  /** 0..1: the soil between the rows turns to paddy water */
  paddy: number;
}

export function farmLook(variant: number): FarmLook {
  if (variant === 1) return { ridge: 0.22, ripe: 0.1, paddy: 1 }; // 稻田 rice paddy
  if (variant === 2) return { ridge: 0.3, ripe: 0, paddy: 0 }; // vegetables
  return { ridge: 0.5, ripe: 0.85, paddy: 0 }; // wheat
}

/**
 * Edge weight of a point `d` metres inside the field's rectangle (d ≤ 0:
 * outside), with the ragged offset `jag` (m): 0 at the ragged border, 1 once
 * FARM_EDGE_M inside it.
 */
export function farmEdgeWeight(d: number, jag: number): number {
  const t = Math.min(1, Math.max(0, (d - jag) / FARM_EDGE_M));
  return t * t * (3 - 2 * t);
}

export interface FarmGeometryStats {
  fields: number;
  vertices: number;
}

/**
 * The corrugated sheets of every farmField prop, merged: position, normal, uv,
 * color (rgb brightness jitter, a = edge fade) and aCrop (ripe, paddy).
 */
export function buildFarmGeometry(map: MapData, props: readonly MapProp[] = map.props): THREE.BufferGeometry | null {
  const fields = props.filter((p) => p.type === 'farmField');
  if (!fields.length) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const colr: number[] = [];
  const crop: number[] = [];
  const index: number[] = [];
  // metres per crop row; one crest (texture u = FARM_CREST_U) sits at w0
  const period = FARM_TILE_M / FARM_ROWS_PER_TILE;
  const w0 = FARM_CREST_U * FARM_TILE_M;
  for (const p of fields) {
    const look = farmLook(p.variant);
    const c = Math.cos(p.rot);
    const s = Math.sin(p.rot);
    // rows along the long axis: `a` runs along the rows, `w` across them (prop-local)
    const alongX = p.sx >= p.sz;
    const L = alongX ? p.sx : p.sz;
    const W = alongX ? p.sz : p.sx;
    const seed = hashString(`farm|${p.x.toFixed(1)}|${p.z.toFixed(1)}`);
    const sOff = ((seed >>> 8) % 1000) / 1000; // texture offset along the rows (no two fields alike)
    const bright = 0.94 + ((seed >>> 4) % 13) / 100;
    // across-row sample positions: every crest and furrow inside the field, plus both borders
    const ws: number[] = [-W / 2];
    for (let k = Math.ceil((-W / 2 - w0) / (period / 2)); w0 + (k * period) / 2 < W / 2; k++) {
      const w = w0 + (k * period) / 2;
      if (w > -W / 2 + 0.05 && w < W / 2 - 0.05) ws.push(w);
    }
    ws.push(W / 2);
    const na = Math.max(2, Math.ceil(L / ALONG_STEP) + 1);
    const base = pos.length / 3;
    for (let i = 0; i < na; i++) {
      const a = -L / 2 + (i * L) / (na - 1);
      for (let k = 0; k < ws.length; k++) {
        const w = ws[k];
        const lx = alongX ? a : w;
        const lz = alongX ? w : a;
        const wx = p.x + lx * c + lz * s;
        const wz = p.z - lx * s + lz * c;
        // distance inside the rectangle, and a ragged border (two octaves of noise)
        const d = Math.min(L / 2 - Math.abs(a), W / 2 - Math.abs(w));
        const jag = (valueNoise2(wx * 0.45 + seed * 1e-4, wz * 0.45) - 0.5) * 1.1 + (valueNoise2(wx * 1.7, wz * 1.7 + 3.1) - 0.5) * 0.35;
        const e = farmEdgeWeight(d, jag);
        // crest / furrow: cos over the row period, crests on the painted crop stripes
        const ridge = 0.5 + 0.5 * Math.cos(((w - w0) / period) * Math.PI * 2);
        // plants vary a little in height along the row
        const tall = 0.85 + 0.3 * valueNoise2(wx * 0.6, wz * 0.6 + 7.7);
        const y = terrainHeight(map, wx, wz) + 0.05 + ridge * look.ridge * tall * (0.25 + 0.75 * e);
        pos.push(wx, y, wz);
        uv.push(w / FARM_TILE_M, (a + L / 2) / FARM_TILE_M + sOff);
        colr.push(bright, bright, bright * 0.98, e);
        crop.push(look.ripe, look.paddy);
      }
    }
    const nw = ws.length;
    for (let i = 0; i < na - 1; i++)
      for (let k = 0; k < nw - 1; k++) {
        const v0 = base + i * nw + k;
        const v1 = v0 + 1;
        const v2 = v0 + nw;
        const v3 = v2 + 1;
        index.push(v0, v1, v2, v1, v3, v2); // wound upwards by fixWinding()
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 4));
  g.setAttribute('aCrop', new THREE.Float32BufferAttribute(crop, 2));
  g.setIndex(index);
  fixWinding(g);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Flip triangles whose face normal points down (the sheet is seen from above). */
function fixWinding(g: THREE.BufferGeometry): void {
  const idx = g.getIndex()!;
  const p = g.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(p, idx.getX(t));
    b.fromBufferAttribute(p, idx.getX(t + 1));
    c.fromBufferAttribute(p, idx.getX(t + 2));
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (ny < 0) {
      const i1 = idx.getX(t + 1);
      idx.setX(t + 1, idx.getX(t + 2));
      idx.setX(t + 2, i1);
    }
  }
}

/** Field material: the painted crops, ripened / flooded per variant, with the soft edge. */
export function farmMaterial(map: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, transparent: true, roughness: 0.92, metalness: 0 });
  m.name = 'farmField';
  // lifted off the ground in depth (the furrows sit 5 cm over it)
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  m.onBeforeCompile = (shader) => {
    applySkyArtFog(shader, m);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aCrop;\nvarying vec2 vCrop;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCrop = aCrop;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vCrop;`).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
{
  vec3 c = diffuseColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soil (dark, unsaturated) vs plants
  float plant = smoothstep(0.035, 0.09, c.g - 0.5 * (c.r + c.b) + l * 0.4);
  // ripe wheat: the green blades turn to straw gold, shaded by the painting
  vec3 gold = vec3(1.0, 0.72, 0.28) * (l * 2.1 + 0.02);
  c = mix(c, gold, vCrop.x * plant);
  // paddy: flooded furrows (sky-tinted water), lusher rice
  vec3 water = vec3(0.16, 0.24, 0.24) * (0.6 + 2.0 * l);
  c = mix(c, water, vCrop.y * (1.0 - plant) * 0.85);
  c = mix(c, c * vec3(0.85, 1.05, 0.9), vCrop.y * plant);
  diffuseColor.rgb = c;
}`,
    );
  };
  m.customProgramCacheKey = () => `farmField_v1${skyArtFogKey()}`;
  return m;
}

export interface FarmArt {
  mesh: THREE.Mesh;
  stats: FarmGeometryStats;
  dispose(): void;
}

/** The fields' mesh with `tex` (null: an untextured stand-in, used by tests). */
export function buildFarmArt(map: MapData, tex: THREE.Texture | null): FarmArt | null {
  const geo = buildFarmGeometry(map);
  if (!geo) return null;
  const mat = farmMaterial(tex);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'farmFields';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // first in the transparent pass: particles, auras and nameplates over it blend on top
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;
  return {
    mesh,
    stats: { fields: map.props.filter((p) => p.type === 'farmField').length, vertices: geo.getAttribute('position').count },
    dispose(): void {
      geo.dispose();
      mat.dispose();
      tex?.dispose();
    },
  };
}

/** Decode tex/farm.webp (sized for the quality tier), or null when it fails. */
export async function loadFarmTexture(): Promise<THREE.Texture | null> {
  try {
    const tex = await new THREE.TextureLoader().loadAsync(FARM_TEX);
    tex.colorSpace = THREE.SRGBColorSpace;
    const q = worldArtQuality();
    const out = capTexture(tex, texSizesFor(q).ground);
    out.wrapS = THREE.RepeatWrapping;
    out.wrapT = THREE.RepeatWrapping;
    out.colorSpace = THREE.SRGBColorSpace;
    out.minFilter = THREE.LinearMipmapLinearFilter;
    out.generateMipmaps = true;
    // seen at grazing angles like the ground
    out.anisotropy = q === 'low' ? 2 : 8;
    out.needsUpdate = true;
    return out;
  } catch (err) {
    console.warn('[render] farm texture failed', err);
    return null;
  }
}
