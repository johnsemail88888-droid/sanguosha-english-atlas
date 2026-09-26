// Geometry helpers for layout tests: how deep two colliders (or two props'
// collider sets) interpenetrate. Not a test file itself (no .test suffix).
import type { Collider, MapProp } from '../../../src/core/map';
import { propColliders } from '../../../src/sim/map/props';

interface Obb2 {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  /** local +X / +Z axes in world XZ */
  ax: [number, number];
  az: [number, number];
}

function obbOf(c: Extract<Collider, { kind: 'box' }>): Obb2 {
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  // local -> world: x = lx*c + lz*s, z = -lx*s + lz*c  (three.js rotation.y)
  return { cx: c.cx, cz: c.cz, hx: c.hx, hz: c.hz, ax: [cs, -sn], az: [sn, cs] };
}

function yRange(c: Collider): [number, number] {
  return c.kind === 'box' ? [c.cy - c.hy, c.cy + c.hy] : [c.y0, c.y1];
}

function projRadius(o: Obb2, nx: number, nz: number): number {
  return o.hx * Math.abs(o.ax[0] * nx + o.ax[1] * nz) + o.hz * Math.abs(o.az[0] * nx + o.az[1] * nz);
}

/** Horizontal (XZ) penetration depth of two footprints; <= 0 when separated. */
export function footprintPenetration(a: Collider, b: Collider): number {
  if (a.kind === 'cyl' && b.kind === 'cyl') return a.r + b.r - Math.hypot(a.x - b.x, a.z - b.z);
  if (a.kind === 'cyl' || b.kind === 'cyl') {
    const cyl = (a.kind === 'cyl' ? a : b) as Extract<Collider, { kind: 'cyl' }>;
    const box = obbOf((a.kind === 'box' ? a : b) as Extract<Collider, { kind: 'box' }>);
    const dx = cyl.x - box.cx;
    const dz = cyl.z - box.cz;
    const lx = dx * box.ax[0] + dz * box.ax[1];
    const lz = dx * box.az[0] + dz * box.az[1];
    const ox = Math.abs(lx) - box.hx;
    const oz = Math.abs(lz) - box.hz;
    if (ox <= 0 && oz <= 0) return cyl.r + Math.min(-ox, -oz); // centre inside the box
    return cyl.r - Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
  }
  const A = obbOf(a as Extract<Collider, { kind: 'box' }>);
  const B = obbOf(b as Extract<Collider, { kind: 'box' }>);
  const dx = B.cx - A.cx;
  const dz = B.cz - A.cz;
  let pen = Infinity;
  for (const [nx, nz] of [A.ax, A.az, B.ax, B.az]) {
    const d = Math.abs(dx * nx + dz * nz);
    const p = projRadius(A, nx, nz) + projRadius(B, nx, nz) - d;
    if (p < pen) pen = p;
  }
  return pen;
}

/** Penetration depth of two colliders in 3D (min of XZ and Y overlap); <= 0 when apart. */
export function colliderPenetration(a: Collider, b: Collider): number {
  const [a0, a1] = yRange(a);
  const [b0, b1] = yRange(b);
  const py = Math.min(a1, b1) - Math.max(a0, b0);
  if (py <= 0) return py;
  return Math.min(py, footprintPenetration(a, b));
}

/** World AABB (XZ) of a collider. */
export function colliderAabb(c: Collider): { x0: number; x1: number; z0: number; z1: number } {
  if (c.kind === 'cyl') return { x0: c.x - c.r, x1: c.x + c.r, z0: c.z - c.r, z1: c.z + c.r };
  const ex = Math.abs(c.hx * Math.cos(c.rot)) + Math.abs(c.hz * Math.sin(c.rot));
  const ez = Math.abs(c.hx * Math.sin(c.rot)) + Math.abs(c.hz * Math.cos(c.rot));
  return { x0: c.cx - ex, x1: c.cx + ex, z0: c.cz - ez, z1: c.cz + ez };
}

export interface PropOverlap {
  a: MapProp;
  b: MapProp;
  depth: number;
}

/**
 * Pairs of props whose colliders interpenetrate by more than `tol` metres.
 * `ignore(a, b)` filters intentional contacts (e.g. a parapet sitting on its wall).
 */
export function propOverlaps(props: readonly MapProp[], tol: number, ignore: (a: MapProp, b: MapProp) => boolean): PropOverlap[] {
  const sets = props.map((p) => {
    const cs = propColliders(p);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const c of cs) {
      const r = colliderAabb(c);
      x0 = Math.min(x0, r.x0);
      x1 = Math.max(x1, r.x1);
      z0 = Math.min(z0, r.z0);
      z1 = Math.max(z1, r.z1);
    }
    return { cs, x0, x1, z0, z1 };
  });
  // uniform hash on AABBs (8 m buckets)
  const B = 8;
  const grid = new Map<string, number[]>();
  sets.forEach((s, i) => {
    if (s.cs.length === 0) return;
    for (let bx = Math.floor(s.x0 / B); bx <= Math.floor(s.x1 / B); bx++)
      for (let bz = Math.floor(s.z0 / B); bz <= Math.floor(s.z1 / B); bz++) {
        const k = `${bx},${bz}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(i);
      }
  });
  const seen = new Set<number>();
  const out: PropOverlap[] = [];
  const n = props.length;
  for (const list of grid.values()) {
    for (let u = 0; u < list.length; u++)
      for (let v = u + 1; v < list.length; v++) {
        const i = Math.min(list[u], list[v]);
        const j = Math.max(list[u], list[v]);
        const key = i * n + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = sets[i];
        const Bs = sets[j];
        if (A.x1 <= Bs.x0 || Bs.x1 <= A.x0 || A.z1 <= Bs.z0 || Bs.z1 <= A.z0) continue;
        if (ignore(props[i], props[j])) continue;
        let depth = 0;
        for (const ca of A.cs) for (const cb of Bs.cs) depth = Math.max(depth, colliderPenetration(ca, cb));
        if (depth > tol) out.push({ a: props[i], b: props[j], depth });
      }
  }
  return out;
}
