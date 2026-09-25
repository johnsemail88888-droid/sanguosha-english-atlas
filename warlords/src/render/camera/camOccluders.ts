// Camera-only occluders: volumes the third-person camera boom must not enter
// although nothing collides with them in the simulation — the roof shells of
// houses / halls / towers / cabins (their overhanging eaves and thatch have no
// collider; standing in or under them is legal, looking out of them is not) and
// the low space under dock decks (between the water and the planks). Registered
// by the prop builders while the world is built (world/roof.ts hipRoof,
// world/structures.ts buildDock) and tested by resolveCameraCollision through
// PickWorld.cameraDistance. A box that contains the ray origin (the hero's
// shoulder is inside / on top of a roof) is ignored: only entering hits count.
// Pure math apart from reading the builder's frame matrix: unit-tested in node.
import type * as THREE from 'three';
import type { Collider } from '../../core/map';
import type { Vec3 } from '../../core/math';
import { colliderAabb, rayCollider } from './pick';

export type BoxCollider = Extract<Collider, { kind: 'box' }>;

/** Collects occluder boxes (world space) while the world is built. */
export class CamOccluderSink {
  readonly boxes: BoxCollider[] = [];

  /**
   * Add a box given in the local frame `m` (centre + half extents). A yaw-only
   * rigid frame (every prop frame) keeps the box oriented; anything else is
   * registered as its world axis-aligned bounds.
   */
  addLocalBox(m: THREE.Matrix4, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    if (!(hx > 0 && hy > 0 && hz > 0)) return;
    const e = m.elements;
    const wx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
    const wy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
    const wz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
    const yawOnly =
      Math.abs(e[1]) < 1e-5 && Math.abs(e[4]) < 1e-5 && Math.abs(e[6]) < 1e-5 && Math.abs(e[9]) < 1e-5 && Math.abs(e[5] - 1) < 1e-5 && Math.abs(Math.hypot(e[0], e[2]) - 1) < 1e-5;
    if (yawOnly) {
      this.boxes.push({ kind: 'box', cx: wx, cy: wy, cz: wz, hx, hy, hz, rot: Math.atan2(e[8], e[0]) });
      return;
    }
    // general frame: world AABB of the transformed box
    const ax = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
    const ay = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
    const az = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
    this.boxes.push({ kind: 'box', cx: wx, cy: wy, cz: wz, hx: ax, hy: ay, hz: az, rot: 0 });
  }
}

const CELL = 8;

/** Uniform-grid lookup of camera occluder boxes. */
export class CameraOccluders {
  private readonly boxes: BoxCollider[];
  private readonly origin: number;
  private readonly gridN: number;
  private readonly cells: Int32Array[];
  private readonly stamp: Uint32Array;
  private stampId = 1;

  constructor(boxes: readonly BoxCollider[], mapSize: number) {
    this.boxes = boxes.slice();
    this.origin = -mapSize / 2 - CELL * 2;
    this.gridN = Math.ceil((mapSize + CELL * 4) / CELL);
    const lists: number[][] = Array.from({ length: this.gridN * this.gridN }, () => []);
    this.boxes.forEach((b, i) => {
      const [x0, z0, x1, z1] = colliderAabb(b);
      for (let j = this.cell(z0); j <= this.cell(z1); j++) for (let k = this.cell(x0); k <= this.cell(x1); k++) lists[j * this.gridN + k].push(i);
    });
    this.cells = lists.map((l) => Int32Array.from(l));
    this.stamp = new Uint32Array(this.boxes.length);
  }

  get count(): number {
    return this.boxes.length;
  }

  private cell(v: number): number {
    return Math.max(0, Math.min(this.gridN - 1, Math.floor((v - this.origin) / CELL)));
  }

  /**
   * Distance along origin + dir·t (dir normalised, t ∈ (0, maxDist]) at which
   * the ray ENTERS an occluder; boxes containing the origin are ignored.
   * Infinity when nothing is hit. Meant for short rays (the camera boom).
   */
  rayEntry(o: Vec3, d: Vec3, maxDist: number): number {
    if (this.boxes.length === 0 || !(maxDist > 0)) return Infinity;
    this.stampId = (this.stampId + 1) >>> 0;
    if (this.stampId === 0) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const ex = o.x + d.x * maxDist;
    const ez = o.z + d.z * maxDist;
    const i0 = this.cell(Math.min(o.x, ex));
    const i1 = this.cell(Math.max(o.x, ex));
    const j0 = this.cell(Math.min(o.z, ez));
    const j1 = this.cell(Math.max(o.z, ez));
    let best = Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells[j * this.gridN + i];
        for (let k = 0; k < list.length; k++) {
          const bi = list[k];
          if (this.stamp[bi] === this.stampId) continue;
          this.stamp[bi] = this.stampId;
          const hit = rayCollider(o, d, this.boxes[bi]);
          // t = 0: the origin is inside this box (standing on / under a roof) → ignore it
          if (hit && hit.t > 1e-4 && hit.t <= maxDist && hit.t < best) best = hit.t;
        }
      }
    }
    return best;
  }

  /** Is the point inside any occluder? (tests / debugging) */
  contains(p: Vec3): boolean {
    const list = this.cells[this.cell(p.z) * this.gridN + this.cell(p.x)];
    for (let k = 0; k < list.length; k++) {
      const b = this.boxes[list[k]];
      const dx = p.x - b.cx;
      const dz = p.z - b.cz;
      const cs = Math.cos(b.rot);
      const sn = Math.sin(b.rot);
      const lx = dx * cs - dz * sn;
      const lz = dx * sn + dz * cs;
      if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz && Math.abs(p.y - b.cy) <= b.hy) return true;
    }
    return false;
  }
}
