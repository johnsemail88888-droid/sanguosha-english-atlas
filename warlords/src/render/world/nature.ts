// Instanced vegetation and boulders. Each (type, style) pair is ONE
// InstancedMesh for the whole map; unit geometry (canopy diameter 1, height 1)
// is scaled per instance to the prop's sx/sy/sz.
import * as THREE from 'three';
import type { MapProp } from '../../core/map';
import { GeoBuilder, PRIM, col, mixCol, shade, trs } from '../core/geo';
import { foliageMaterial, worldMaterial } from '../core/materials';
import { hashString, makeRand, valueNoise2 } from '../core/noise';
import { NATURE } from '../palette';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

type Style = { key: string; build: () => THREE.BufferGeometry; foliage: boolean };

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

function rock(kind: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const base = new THREE.IcosahedronGeometry(0.5, 1);
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

const STYLES: Record<string, Style> = {
  tree0: { key: 'tree0', build: () => broadleaf(0), foliage: true },
  tree1: { key: 'tree1', build: () => broadleaf(1), foliage: true },
  tree2: { key: 'tree2', build: () => broadleaf(2), foliage: true },
  pine0: { key: 'pine0', build: () => pine(0), foliage: true },
  pine1: { key: 'pine1', build: () => pine(1), foliage: true },
  bamboo: { key: 'bamboo', build: () => bamboo(), foliage: true },
  rock0: { key: 'rock0', build: () => rock(0), foliage: false },
  rock1: { key: 'rock1', build: () => rock(1), foliage: false },
  rock2: { key: 'rock2', build: () => rock(2), foliage: false },
  rock3: { key: 'rock3', build: () => rock(3), foliage: false },
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
  group: THREE.Group;
  count: number;
  dispose(): void;
}

export function buildNature(props: readonly MapProp[]): NatureMeshes {
  const group = new THREE.Group();
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
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tint = new THREE.Color();
  let count = 0;
  for (const [key, list] of buckets) {
    const style = STYLES[key];
    const geo = style.build();
    geos.push(geo);
    const mesh = new THREE.InstancedMesh(geo, style.foliage ? foliageMaterial() : worldMaterial(), list.length);
    mesh.name = `nature_${key}`;
    list.forEach((p, i) => {
      const h = hashString(`${p.x.toFixed(2)},${p.z.toFixed(2)}`);
      const yawJ = p.type === 'rock' ? 0 : ((h % 628) / 100) * 1;
      e.set(0, p.rot + yawJ, 0);
      q.setFromEuler(e);
      pos.set(p.x, p.y, p.z);
      const sz = p.type === 'tree' || p.type === 'pine' || p.type === 'bamboo' ? p.sx : p.sz;
      scl.set(p.sx, p.sy, sz);
      m4.compose(pos, q, scl);
      mesh.setMatrixAt(i, m4);
      const jitter = 0.88 + ((h >>> 8) % 100) / 400;
      if (p.color) tint.set(p.color).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(jitter);
      else tint.setRGB(jitter, jitter * (0.97 + ((h >>> 16) % 10) / 200), jitter);
      mesh.setColorAt(i, tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    count += list.length;
  }
  return {
    group,
    count,
    dispose(): void {
      for (const g of geos) g.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
    },
  };
}
