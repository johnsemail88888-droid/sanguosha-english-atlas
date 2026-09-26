// Uniform-grid broadphases on the XZ plane.
//  - StaticGrid: built once per map, stores indices of static colliders in
//    every cell their AABB overlaps (with per-query de-duplication stamps).
//  - EntityGrid: rebuilt every tick from the dynamic entity list using an
//    allocation-free linked-list layout.
import type { Entity } from '../core/types';

export class StaticGrid {
  readonly cell: number;
  readonly min: number;
  readonly dim: number;
  readonly cells: number[][];
  private stamps: Uint32Array;
  private stamp = 1;

  /** Grid covering [-size/2, size/2]² with square cells of `cell` meters. */
  constructor(size: number, cell: number, capacity: number) {
    this.cell = cell;
    this.min = -size / 2;
    this.dim = Math.max(1, Math.ceil(size / cell));
    this.cells = Array.from({ length: this.dim * this.dim }, () => [] as number[]);
    this.stamps = new Uint32Array(Math.max(1, capacity));
  }

  cellCoord(v: number): number {
    const c = Math.floor((v - this.min) / this.cell);
    return c < 0 ? 0 : c >= this.dim ? this.dim - 1 : c;
  }

  insert(index: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    if (index >= this.stamps.length) {
      const next = new Uint32Array(Math.max(index + 1, this.stamps.length * 2));
      next.set(this.stamps);
      this.stamps = next;
    }
    const x0 = this.cellCoord(minX);
    const x1 = this.cellCoord(maxX);
    const z0 = this.cellCoord(minZ);
    const z1 = this.cellCoord(maxZ);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells[z * this.dim + x].push(index);
  }

  /** Start a de-duplicated query; use `visit(index)` to test-and-mark. */
  beginQuery(): void {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.stamps.fill(0);
      this.stamp = 1;
    }
  }

  /** true the first time `index` is seen in the current query. */
  visit(index: number): boolean {
    if (this.stamps[index] === this.stamp) return false;
    this.stamps[index] = this.stamp;
    return true;
  }

  /** Call fn for every (de-duplicated) index whose cells overlap the rectangle. */
  forEachInRect(minX: number, minZ: number, maxX: number, maxZ: number, fn: (index: number) => void): void {
    this.beginQuery();
    const x0 = this.cellCoord(minX);
    const x1 = this.cellCoord(maxX);
    const z0 = this.cellCoord(minZ);
    const z1 = this.cellCoord(maxZ);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const list = this.cells[z * this.dim + x];
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (this.visit(idx)) fn(idx);
        }
      }
    }
  }

  /** Collect de-duplicated indices overlapping the rectangle into `out` (cleared first). */
  collectRect(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    this.beginQuery();
    const x0 = this.cellCoord(minX);
    const x1 = this.cellCoord(maxX);
    const z0 = this.cellCoord(minZ);
    const z1 = this.cellCoord(maxZ);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const list = this.cells[z * this.dim + x];
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (this.visit(idx)) out.push(idx);
        }
      }
    }
    return out;
  }
}

/** Dynamic entity grid, rebuilt from scratch (cheaply) whenever positions change a lot. */
export class EntityGrid {
  readonly cell: number;
  readonly min: number;
  readonly dim: number;
  private head: Int32Array;
  private next: Int32Array;
  private items: Entity[] = [];
  /** extra search margin (m) to tolerate movement since the last rebuild */
  margin = 1.5;

  constructor(size: number, cell = 8) {
    this.cell = cell;
    this.min = -size / 2;
    this.dim = Math.max(1, Math.ceil(size / cell));
    this.head = new Int32Array(this.dim * this.dim).fill(-1);
    this.next = new Int32Array(256);
  }

  private cellCoord(v: number): number {
    const c = Math.floor((v - this.min) / this.cell);
    return c < 0 ? 0 : c >= this.dim ? this.dim - 1 : c;
  }

  rebuild(entities: Iterable<Entity>): void {
    this.head.fill(-1);
    this.items.length = 0;
    for (const e of entities) {
      const i = this.items.length;
      this.items.push(e);
      if (i >= this.next.length) {
        const n = new Int32Array(this.next.length * 2);
        n.set(this.next);
        this.next = n;
      }
      const c = this.cellCoord(e.pos.z) * this.dim + this.cellCoord(e.pos.x);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  /** Visit every entity whose cell overlaps the circle (x, z, r) + margin. No exact test. */
  forEachNear(x: number, z: number, r: number, fn: (e: Entity) => void): void {
    const rr = r + this.margin;
    const x0 = this.cellCoord(x - rr);
    const x1 = this.cellCoord(x + rr);
    const z0 = this.cellCoord(z - rr);
    const z1 = this.cellCoord(z + rr);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let i = this.head[cz * this.dim + cx]; i !== -1; i = this.next[i]) fn(this.items[i]);
      }
    }
  }

  get size(): number {
    return this.items.length;
  }
}
