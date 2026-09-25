// Shared context + small building blocks for prop builders.
import * as THREE from 'three';
import type { MapData, MapProp } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { GeoBuilder, PRIM, col, mixCol, shade, trs, type ColorLike } from '../core/geo';
import { hashString, makeRand } from '../core/noise';
import type { CamOccluderSink } from '../camera/camOccluders';
import { ARCH } from '../palette';

export interface PropCtx {
  /** opaque builder, already pushed into the prop's local frame (origin at x, y, z; rotated by rot) */
  b: GeoBuilder;
  /** double-sided builder (cloth, sails, paper), same frame */
  cloth: GeoBuilder;
  /** unlit glow builder (lanterns, embers), same frame */
  glow: GeoBuilder;
  p: MapProp;
  map: MapData;
  rand: () => number;
  /** terrain height at a prop-local point, relative to p.y */
  groundAt(lx: number, lz: number): number;
  /** world position of a local point */
  toWorld(lx: number, ly: number, lz: number): THREE.Vector3;
  /** camera-only occluder boxes (roof shells, under dock decks); null when not collected */
  occ: CamOccluderSink | null;
}

/**
 * hipRoof options every building roof should pass: the shell goes into the
 * double-sided builder (a camera that ends up inside it sees a lit ceiling, not
 * a black / see-through face) and its volume is registered as a camera occluder.
 */
export function roofExtras(c: PropCtx): { shell: GeoBuilder; occ: CamOccluderSink | null } {
  return { shell: c.cloth, occ: c.occ };
}

export function makePropCtx(
  b: GeoBuilder,
  cloth: GeoBuilder,
  glow: GeoBuilder,
  p: MapProp,
  map: MapData,
  occ: CamOccluderSink | null = null,
): PropCtx {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const seed = hashString(`${p.type}|${p.x.toFixed(2)}|${p.z.toFixed(2)}`);
  return {
    b,
    cloth,
    glow,
    p,
    map,
    rand: makeRand(seed),
    occ,
    groundAt(lx, lz) {
      const wx = p.x + lx * c + lz * s;
      const wz = p.z - lx * s + lz * c;
      return terrainHeight(map, wx, wz) - p.y;
    },
    toWorld(lx, ly, lz) {
      return new THREE.Vector3(p.x + lx * c + lz * s, p.y + ly, p.z - lx * s + lz * c);
    },
  };
}

export const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Axis-aligned local box given min/max corners. */
export function boxMM(b: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: ColorLike): void {
  b.boxAt((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), color);
}

/** Red lacquered pillar with a stone base and a small bracket (斗拱) cap. */
export function pillar(b: GeoBuilder, x: number, y0: number, z: number, r: number, h: number, color: ColorLike = ARCH.pillarRed): void {
  b.cylAt(x, y0, z, r * 1.45, 0.22, ARCH.stoneLight, 8);
  b.cylAt(x, y0 + 0.2, z, r, h - 0.2, color, 8);
  b.boxAt(x, y0 + h - 0.12, z, r * 2.6, 0.24, r * 2.6, shade(ARCH.wood, 1.1));
  b.boxAt(x, y0 + h - 0.3, z, r * 2.2, 0.14, r * 2.2, '#2f6b5a'); // painted bracket (青绿彩画)
}

/**
 * Lattice window / door panel on a wall plane facing −Z (local), centred at (x, y),
 * front plane at z. Positive `facing` flips it to face +Z.
 */
export function lattice(b: GeoBuilder, x: number, y: number, z: number, w: number, h: number, frame: ColorLike, facing = -1, paper: ColorLike = ARCH.paper): void {
  const zf = z + facing * 0.03;
  b.boxAt(x, y, z + facing * 0.01, w, h, 0.04, paper);
  const t = 0.06;
  b.boxAt(x, y + h / 2, zf, w + t, t, 0.05, frame);
  b.boxAt(x, y - h / 2, zf, w + t, t, 0.05, frame);
  b.boxAt(x - w / 2, y, zf, t, h, 0.05, frame);
  b.boxAt(x + w / 2, y, zf, t, h, 0.05, frame);
  const nx = Math.max(2, Math.round(w / 0.28));
  const ny = Math.max(2, Math.round(h / 0.28));
  for (let i = 1; i < nx; i++) b.boxAt(x - w / 2 + (i * w) / nx, y, zf, 0.025, h, 0.03, frame);
  for (let j = 1; j < ny; j++) b.boxAt(x, y - h / 2 + (j * h) / ny, zf, w, 0.025, 0.03, frame);
}

/** Double door (front plane at z facing −Z) with gold studs; `open` swings the leaves inward (visual). */
export function door(b: GeoBuilder, x: number, y0: number, z: number, w: number, h: number, color: ColorLike, open = false, facing = -1): void {
  const fz = z + facing * 0.02;
  // frame
  b.boxAt(x, y0 + h + 0.12, fz, w + 0.4, 0.24, 0.12, ARCH.woodDark);
  b.boxAt(x - w / 2 - 0.12, y0 + h / 2, fz, 0.24, h, 0.12, ARCH.woodDark);
  b.boxAt(x + w / 2 + 0.12, y0 + h / 2, fz, 0.24, h, 0.12, ARCH.woodDark);
  if (open) {
    b.boxAt(x, y0 + h / 2, z - facing * 0.05, w, h, 0.02, '#1a1410'); // dark opening
    return;
  }
  for (const sgn of [-1, 1]) {
    const lx = x + (sgn * w) / 4;
    b.boxAt(lx, y0 + h / 2, fz, w / 2 - 0.03, h, 0.08, color);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 2; c++)
        b.add(PRIM.sphere(4, 3), trs(lx - w / 8 + (c * w) / 4, y0 + h * (0.25 + r * 0.17), fz + facing * 0.05, 0, 0, 0, 0.035), ARCH.gold);
  }
  b.add(PRIM.torus(0.2, 3, 8), trs(x - 0.12, y0 + h * 0.5, fz + facing * 0.06, 0, 0, 0, 0.07), ARCH.gold);
  b.add(PRIM.torus(0.2, 3, 8), trs(x + 0.12, y0 + h * 0.5, fz + facing * 0.06, 0, 0, 0, 0.07), ARCH.gold);
}

/** Hanging red lantern (glow body into ctx.glow, caps into b). */
export function lantern(c: PropCtx, x: number, y: number, z: number, r = 0.22): void {
  c.glow.add(PRIM.sphere(8, 6), trs(x, y, z, 0, 0, 0, r, r * 1.15, r), '#ff5a2a');
  c.b.cylAt(x, y + r * 0.95, z, r * 0.5, 0.08, ARCH.gold, 6);
  c.b.cylAt(x, y - r * 1.15, z, r * 0.5, 0.08, ARCH.gold, 6);
  c.b.rod(V(x, y + r, z), V(x, y + r + 0.35, z), 0.012, ARCH.woodDark, 3);
  c.b.add(PRIM.cone(5), trs(x, y - r * 1.4, z, Math.PI, 0, 0, 0.05, 0.2, 0.05), '#c8322a');
}

/** Slight per-prop colour jitter. */
export function jitter(c: PropCtx, color: ColorLike, amt = 0.08): THREE.Color {
  return col(color).clone().multiplyScalar(1 - amt + c.rand() * amt * 2);
}

export { mixCol, shade, col, trs, PRIM };
