// Instanced vegetation and boulders. Each (type, style) pair is one batch for
// the whole map; unit geometry (canopy diameter 1, height 1) is scaled per
// instance to the prop's sx/sy/sz. Like the AI-art prop models, the batches are
// culled per instance every frame (view frustum ∪ sun shadow frustum, within
// the draw distance: world/propModels.ts PropCuller) — one whole-map mesh per
// style used to run the vertex shader for every tree on the map, twice with
// shadows (the procedural forests are ~230k triangles).
import * as THREE from 'three';
import type { MapProp } from '../../core/map';
import { GeoBuilder, PRIM, col, mixCol, shade, trs } from '../core/geo';
import { foliageMaterial, fullTwin, liteTwin, worldMaterial } from '../core/materials';
import { hashString, makeRand, valueNoise2 } from '../core/noise';
import { NATURE } from '../palette';
import { InstanceBatch, PropCuller, type InstanceArrays } from './propModels';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** `lo`: the far LOD (a fraction of the triangles, same silhouette), drawn beyond NATURE_LOD_DIST. */
type Style = { key: string; build: () => THREE.BufferGeometry; lo: () => THREE.BufferGeometry; foliage: boolean };

/**
 * Vegetation / rocks switch to their far LOD beyond this distance (m; scaled
 * by the tier's lodScale). The full models are 100–2 500 triangles (a bamboo
 * clump); the far ones 20–150.
 */
export const NATURE_LOD_DIST = 40;

// ── unit geometries ─────────────────────────────────────────────────────────
function broadleaf(kind: 0 | 1 | 2): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const rand = makeRand(17 + kind);
  const trunk = col(NATURE.trunk);
  b.rod(V(0, -0.05, 0), V(0.02, 0.58, 0), 0.045, trunk, 6, 0.6);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    b.rod(V(0.01, 0.45, 0), V(Math.cos(a) * 0.22, 0.72, Math.sin(a) * 0.22), 0.018, trunk, 4, 0.6);
  }
  const leaf = kind === 2 ? NATURE.leafBlossom : NATURE.leaf;
  const leafAlt = kind === 2 ? '#f0c4c8' : kind === 1 ? '#5f8a3a' : '#4a7030';
  if (kind === 1) {
    // layered umbrella canopy (槐)
    for (let t = 0; t < 3; t++) {
      const y = 0.62 + t * 0.14;
      const r = 0.5 - t * 0.12;
      b.add(PRIM.sphere(9, 5), trs(0, y, 0, 0, t, 0, r, 0.1, r), mixCol(leaf, leafAlt, t / 2));
    }
  } else {
    const blobs = 7;
    for (let i = 0; i < blobs; i++) {
      const a = (i / blobs) * Math.PI * 2 + rand() * 0.5;
      const rr = i === 0 ? 0 : 0.2 + rand() * 0.1;
      const y = i === 0 ? 0.82 : 0.66 + rand() * 0.18;
      const s = i === 0 ? 0.3 : 0.2 + rand() * 0.08;
      b.add(PRIM.ico(1), trs(Math.cos(a) * rr, y, Math.sin(a) * rr, rand(), rand(), rand(), s, s * 0.85, s), mixCol(leaf, leafAlt, rand()));
    }
  }
  return b.build();
}

function pine(kind: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const trunk = shade(NATURE.trunk, 0.9);
  if (kind === 0) {
    b.rod(V(0, -0.05, 0), V(0, 0.9, 0), 0.04, trunk, 6, 0.5);
    for (let t = 0; t < 4; t++) {
      const y = 0.28 + t * 0.19;
      const r = 0.5 - t * 0.1;
      b.add(PRIM.cone(8), trs(0, y + 0.13, 0, 0, t * 0.7, 0, r, 0.34, r), mixCol(NATURE.pine, '#3f7048', t / 4));
    }
  } else {
    // windswept 迎客松: crooked trunk with flat foliage pads
    const pts = [V(0, -0.05, 0), V(0.05, 0.35, 0), V(-0.04, 0.6, 0.02), V(0.06, 0.85, -0.02)];
    for (let i = 0; i < pts.length - 1; i++) b.rod(pts[i], pts[i + 1], 0.045 - i * 0.008, trunk, 6);
    const pads = [
      [0.25, 0.55, 0.05, 0.3],
      [-0.28, 0.68, -0.05, 0.28],
      [0.2, 0.8, 0.1, 0.26],
      [0.02, 0.93, 0, 0.22],
      [-0.15, 0.45, 0.15, 0.22],
    ];
    for (const [x, y, z, r] of pads) {
      b.rod(V(0, y - 0.05, 0), V(x * 0.8, y, z * 0.8), 0.015, trunk, 4);
      b.add(PRIM.sphere(8, 4), trs(x, y, z, 0, 0, 0, r, 0.07, r), mixCol(NATURE.pine, '#4a7a50', Math.abs(x)));
    }
  }
  return b.build();
}

function bamboo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const rand = makeRand(99);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.4;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 0.7 + rand() * 0.3;
    const lean = V(x * 0.3 + (rand() - 0.5) * 0.08, 0, z * 0.3 + (rand() - 0.5) * 0.08);
    const top = V(x + lean.x, h, z + lean.z);
    const green = mixCol(NATURE.bamboo, '#a8b85a', rand() * 0.5);
    b.rod(V(x, -0.02, z), top, 0.018, green, 5);
    for (let k = 1; k < 6; k++) {
      const p = V(x, 0, z).lerp(top, k / 6);
      b.add(PRIM.cyl(5), trs(p.x, p.y, p.z, 0, 0, 0, 0.022, 0.012, 0.022), shade(green, 0.75));
    }
    for (let k = 0; k < 3; k++) {
      const p = V(x, 0, z).lerp(top, 0.62 + k * 0.14);
      b.add(PRIM.sphere(6, 3), trs(p.x + (rand() - 0.5) * 0.12, p.y, p.z + (rand() - 0.5) * 0.12, rand(), rand() * 3, rand(), 0.12, 0.03, 0.05), mixCol(NATURE.bambooLeaf, '#8ab050', rand()));
    }
  }
  return b.build();
}

function rock(kind: number, detail = 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const base = new THREE.IcosahedronGeometry(0.5, detail);
  const pos = base.getAttribute('position') as THREE.BufferAttribute;
  const seed = kind * 13.7;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = valueNoise2(x * 3 + seed, z * 3 + y * 2 + seed) * 0.35 + 0.8;
    let ny = y * n;
    if (kind === 1) ny = Math.min(ny, 0.18); // flat-topped slab
    if (kind === 2) ny *= 1.25; // tall stone
    pos.setXYZ(i, x * n, ny + 0.3, z * n * (kind === 3 ? 0.7 : 1));
  }
  const ng = base.index ? base.toNonIndexed() : base;
  if (ng !== base) base.dispose();
  ng.computeVertexNormals();
  // normalise to unit box: x,z in [-0.5, 0.5], y from ~-0.2 to 1
  ng.computeBoundingBox();
  const bb = ng.boundingBox!;
  const sx = 1 / (bb.max.x - bb.min.x);
  const sy = 1.2 / (bb.max.y - bb.min.y);
  const sz = 1 / (bb.max.z - bb.min.z);
  ng.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);
  ng.scale(sx, sy, sz);
  ng.translate(0, -0.2, 0);
  b.addWith(ng, new THREE.Matrix4(), (_x, y) => {
    const t = Math.min(1, Math.max(0, y));
    return mixCol(NATURE.rockDark, NATURE.rock, 0.4 + t * 0.6);
  });
  ng.dispose();
  // moss cap
  return b.build();
}


// ── far LODs: the same masses with a handful of faces ───────────────────────
function broadleafLo(kind: 0 | 1 | 2): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const rand = makeRand(17 + kind);
  b.rod(V(0, -0.05, 0), V(0.02, 0.62, 0), 0.05, col(NATURE.trunk), 4, 0.6);
  const leaf = kind === 2 ? NATURE.leafBlossom : NATURE.leaf;
  const leafAlt = kind === 2 ? '#f0c4c8' : kind === 1 ? '#5f8a3a' : '#4a7030';
  if (kind === 1) {
    for (let t = 0; t < 3; t++) {
      const r = 0.5 - t * 0.12;
      b.add(PRIM.sphere(6, 3), trs(0, 0.62 + t * 0.14, 0, 0, t, 0, r, 0.1, r), mixCol(leaf, leafAlt, t / 2));
    }
  } else {
    // three blobs covering the seven of the full canopy
    b.add(PRIM.ico(0), trs(0, 0.8, 0, rand(), rand(), rand(), 0.36, 0.3, 0.36), leaf);
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI + 0.6;
      b.add(PRIM.ico(0), trs(Math.cos(a) * 0.2, 0.7, Math.sin(a) * 0.2, rand(), rand(), rand(), 0.28, 0.24, 0.28), mixCol(leaf, leafAlt, 0.4 + i * 0.3));
    }
  }
  return b.build();
}

function pineLo(kind: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const trunk = shade(NATURE.trunk, 0.9);
  if (kind === 0) {
    b.rod(V(0, -0.05, 0), V(0, 0.9, 0), 0.045, trunk, 4, 0.5);
    for (let t = 0; t < 2; t++) {
      const r = 0.48 - t * 0.2;
      b.add(PRIM.cone(6), trs(0, 0.28 + t * 0.38 + 0.2, 0, 0, t, 0, r, 0.6, r), mixCol(NATURE.pine, '#3f7048', t / 2));
    }
  } else {
    b.rod(V(0, -0.05, 0), V(0.06, 0.85, -0.02), 0.045, trunk, 4);
    const pads = [
      [0.22, 0.58, 0.05, 0.34],
      [-0.24, 0.7, -0.02, 0.32],
      [0.04, 0.9, 0.04, 0.26],
    ];
    for (const [x, y, z, r] of pads) b.add(PRIM.sphere(5, 3), trs(x, y, z, 0, 0, 0, r, 0.08, r), mixCol(NATURE.pine, '#4a7a50', Math.abs(x)));
  }
  return b.build();
}

function bambooLo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const rand = makeRand(99);
  // every other stalk of the full clump (same random sequence), no node rings, one leaf tuft each
  for (let i = 0; i < 11; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.4;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 0.7 + rand() * 0.3;
    const lean = V(x * 0.3 + (rand() - 0.5) * 0.08, 0, z * 0.3 + (rand() - 0.5) * 0.08);
    const top = V(x + lean.x, h, z + lean.z);
    const green = mixCol(NATURE.bamboo, '#a8b85a', rand() * 0.5);
    // (the full clump's three leaf tufts draw six numbers each: keep the sequence in step)
    for (let k = 0; k < 18; k++) rand();
    if (i % 2) continue;
    b.rod(V(x, -0.02, z), top, 0.024, green, 3);
    const p = V(x, 0, z).lerp(top, 0.78);
    b.add(PRIM.ico(0), trs(p.x, p.y, p.z, 0, i, 0, 0.16, 0.1, 0.1), mixCol(NATURE.bambooLeaf, '#8ab050', 0.5));
  }
  return b.build();
}

const STYLES: Record<string, Style> = {
  tree0: { key: 'tree0', build: () => broadleaf(0), lo: () => broadleafLo(0), foliage: true },
  tree1: { key: 'tree1', build: () => broadleaf(1), lo: () => broadleafLo(1), foliage: true },
  tree2: { key: 'tree2', build: () => broadleaf(2), lo: () => broadleafLo(2), foliage: true },
  pine0: { key: 'pine0', build: () => pine(0), lo: () => pineLo(0), foliage: true },
  pine1: { key: 'pine1', build: () => pine(1), lo: () => pineLo(1), foliage: true },
  bamboo: { key: 'bamboo', build: () => bamboo(), lo: () => bambooLo(), foliage: true },
  rock0: { key: 'rock0', build: () => rock(0), lo: () => rock(0, 0), foliage: false },
  rock1: { key: 'rock1', build: () => rock(1), lo: () => rock(1, 0), foliage: false },
  rock2: { key: 'rock2', build: () => rock(2), lo: () => rock(2, 0), foliage: false },
  rock3: { key: 'rock3', build: () => rock(3), lo: () => rock(3, 0), foliage: false },
};

/** Which instanced style a prop uses (null = not a nature prop). */
export function natureStyle(p: MapProp): string | null {
  switch (p.type) {
    case 'tree':
      // blossom trees (style 2) are an accent: roughly one in six
      return `tree${p.variant % 6 === 5 ? 2 : p.variant % 2}`;
    case 'pine':
      return `pine${p.variant % 2}`;
    case 'bamboo':
      return 'bamboo';
    case 'rock':
      return `rock${p.variant % 4}`;
    default:
      return null;
  }
}

export interface NatureMeshes {
  /** a PropCuller: set its maxDistance to the draw distance */
  group: PropCuller;
  count: number;
  /** Hide (and free) every instanced style of these prop types — prop models took them over. */
  removeTypes(types: ReadonlySet<string>): void;
  /** Diffuse-only materials (the 极速 tier), swapped in place. */
  setLite(on: boolean): void;
  dispose(): void;
}

export function buildNature(props: readonly MapProp[]): NatureMeshes {
  const group = new PropCuller();
  group.name = 'nature';
  const buckets = new Map<string, MapProp[]>();
  for (const p of props) {
    const s = natureStyle(p);
    if (!s) continue;
    let arr = buckets.get(s);
    if (!arr) buckets.set(s, (arr = []));
    arr.push(p);
  }
  const geos: THREE.BufferGeometry[] = [];
  const byType = new Map<string, { batch: InstanceBatch; geo: THREE.BufferGeometry; lo: THREE.BufferGeometry }[]>();
  const m4 = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tint = new THREE.Color();
  let count = 0;
  for (const [key, list] of buckets) {
    const style = STYLES[key];
    const geo = style.build();
    const lo = style.lo();
    geos.push(geo, lo);
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const n = list.length;
    const inst: InstanceArrays = { mats: new Float32Array(n * 16), cols: new Float32Array(n * 3), spheres: new Float32Array(n * 4) };
    list.forEach((p, i) => {
      const h = hashString(`${p.x.toFixed(2)},${p.z.toFixed(2)}`);
      const yawJ = p.type === 'rock' ? 0 : ((h % 628) / 100) * 1;
      e.set(0, p.rot + yawJ, 0);
      q.setFromEuler(e);
      pos.set(p.x, p.y, p.z);
      const sz = p.type === 'tree' || p.type === 'pine' || p.type === 'bamboo' ? p.sx : p.sz;
      scl.set(p.sx, p.sy, sz);
      m4.compose(pos, q, scl);
      m4.toArray(inst.mats, i * 16);
      const jitter = 0.88 + ((h >>> 8) % 100) / 400;
      if (p.color) tint.set(p.color).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(jitter);
      else tint.setRGB(jitter, jitter * (0.97 + ((h >>> 16) % 10) / 200), jitter);
      tint.toArray(inst.cols, i * 3);
      sphere.copy(geo.boundingSphere!).applyMatrix4(m4);
      inst.spheres[i * 4] = sphere.center.x;
      inst.spheres[i * 4 + 1] = sphere.center.y;
      inst.spheres[i * 4 + 2] = sphere.center.z;
      inst.spheres[i * 4 + 3] = sphere.radius;
    });
    const batch = new InstanceBatch({ name: `nature_${key}`, geometry: geo, lod: lo, lodDistance: NATURE_LOD_DIST, material: style.foliage ? foliageMaterial() : worldMaterial() }, inst);
    group.addBatch(batch);
    count += n;
    const t = list[0].type;
    let arr = byType.get(t);
    if (!arr) byType.set(t, (arr = []));
    arr.push({ batch, geo, lo });
  }
  return {
    group,
    count,
    removeTypes(types: ReadonlySet<string>): void {
      for (const t of types) {
        for (const { batch, geo, lo } of byType.get(t) ?? []) {
          group.removeBatch(batch);
          batch.dispose();
          for (const g of [geo, lo]) {
            g.dispose();
            const i = geos.indexOf(g);
            if (i >= 0) geos.splice(i, 1);
          }
          count -= batch.count;
        }
        byType.delete(t);
      }
    },
    setLite(on: boolean): void {
      for (const b of group.batches) for (const m of b.meshes()) m.material = on ? liteTwin(m.material as THREE.Material) : fullTwin(m.material as THREE.Material);
    },
    dispose(): void {
      for (const g of geos) g.dispose();
      group.dispose();
    },
  };
}
