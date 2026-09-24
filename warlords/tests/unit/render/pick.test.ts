import { describe, expect, it } from 'vitest';
import type { Collider, MapData } from '../../../src/core/map';
import type { ViewEntity } from '../../../src/core/types';
import { VF_DEAD, VF_DOWNED } from '../../../src/core/types';
import { PickWorld, colliderAabb, entityShape, rayCollider } from '../../../src/render/camera/pick';

function flatMap(colliders: Collider[], opts: { height?: number; water?: number; bump?: boolean } = {}): MapData {
  const res = 32;
  const n = res + 1;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let h = opts.height ?? 0;
      if (opts.bump && Math.abs(i - 16) < 3 && Math.abs(j - 16) < 3) h += 10;
      heights[j * n + i] = h;
    }
  return {
    seed: 1,
    nameZh: '',
    nameEn: '',
    size: 128,
    res,
    heights,
    waterLevel: opts.water ?? -5,
    props: [],
    colliders,
    lordSpawn: { x: 0, y: 0, z: 0 },
    spawns: [],
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
}

const ent = (id: number, x: number, z: number, flags = 0, kind: ViewEntity['kind'] = 'hero'): ViewEntity => ({
  id,
  kind,
  sub: 'guanyu',
  x,
  y: 0,
  z,
  yaw: 0,
  pitch: 0,
  speed: 0,
  hp: 100,
  maxHp: 100,
  shield: 0,
  flags,
});

/** Brute-force point-in-oriented-box test (three.js Y rotation convention). */
function inBox(c: Extract<Collider, { kind: 'box' }>, x: number, y: number, z: number): boolean {
  const dx = x - c.cx;
  const dz = z - c.cz;
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  const lx = dx * cs - dz * sn;
  const lz = dx * sn + dz * cs;
  return Math.abs(lx) <= c.hx && Math.abs(y - c.cy) <= c.hy && Math.abs(lz) <= c.hz;
}

describe('PickWorld', () => {
  it('hits terrain from above at the right height', () => {
    const w = new PickWorld(flatMap([], { height: 2 }));
    const hit = w.raycast({ x: 0, y: 20, z: 0 }, { x: 0, y: -1, z: 0 }, 100);
    expect(hit?.what).toBe('terrain');
    expect(hit!.point.y).toBeCloseTo(2, 2);
    expect(hit!.dist).toBeCloseTo(18, 2);
  });

  it('finds the nearest of several colliders along the ray', () => {
    const cols: Collider[] = [
      { kind: 'box', cx: 0, cy: 2, cz: -30, hx: 2, hy: 2, hz: 0.5, rot: 0 },
      { kind: 'box', cx: 0, cy: 2, cz: -10, hx: 2, hy: 2, hz: 0.5, rot: 0 },
      { kind: 'cyl', x: 0, z: -20, r: 1, y0: 0, y1: 4 },
    ];
    const w = new PickWorld(flatMap(cols));
    const hit = w.raycast({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 100);
    expect(hit?.what).toBe('collider');
    expect(hit!.dist).toBeCloseTo(9.5, 3);
    expect(hit!.normal.z).toBeCloseTo(1, 5);
  });

  it('hits a vertical cylinder at its surface', () => {
    const w = new PickWorld(flatMap([{ kind: 'cyl', x: 5, z: 0, r: 1, y0: 0, y1: 3 }]));
    const hit = w.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50);
    expect(hit!.dist).toBeCloseTo(4, 4);
    expect(hit!.normal.x).toBeCloseTo(-1, 4);
    // passes over the top
    expect(w.raycast({ x: 0, y: 3.5, z: 0 }, { x: 1, y: 0, z: 0 }, 50)).toBeNull();
  });

  it('agrees with brute-force marching for rotated boxes', () => {
    const box: Extract<Collider, { kind: 'box' }> = { kind: 'box', cx: 3, cy: 1, cz: -4, hx: 3, hy: 1, hz: 0.6, rot: 0.7 };
    let checked = 0;
    for (let k = 0; k < 200; k++) {
      const a = (k / 200) * Math.PI * 2;
      const o = { x: 3 + Math.cos(a) * 10, y: 1 + Math.sin(k) * 0.5, z: -4 + Math.sin(a) * 10 };
      const d = { x: -Math.cos(a), y: 0, z: -Math.sin(a) };
      const hit = rayCollider(o, d, box);
      // brute force
      let tb: number | null = null;
      for (let t = 0; t < 20; t += 0.002) {
        if (inBox(box, o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)) {
          tb = t;
          break;
        }
      }
      if (tb === null) expect(hit).toBeNull();
      else {
        expect(hit).not.toBeNull();
        expect(Math.abs(hit!.t - tb)).toBeLessThan(0.01);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('colliderAabb bounds a rotated box', () => {
    const box: Collider = { kind: 'box', cx: 0, cy: 0, cz: 0, hx: 2, hy: 1, hz: 1, rot: Math.PI / 4 };
    const [x0, z0, x1, z1] = colliderAabb(box);
    expect(x1 - x0).toBeCloseTo(2 * (2 + 1) * Math.SQRT1_2, 5);
    expect(z1 - z0).toBeCloseTo(x1 - x0, 5);
  });

  it('hits entities, honours ignore and minDist, skips the dead', () => {
    const w = new PickWorld(flatMap([]));
    const ents = [ent(1, 0, -10), ent(2, 0, -20), ent(3, 0, -5, VF_DEAD)];
    const o = { x: 0, y: 1, z: 0 };
    const d = { x: 0, y: 0, z: -1 };
    expect(w.raycast(o, d, 100, { entities: ents })?.entityId).toBe(1);
    expect(w.raycast(o, d, 100, { entities: ents, ignore: 1 })?.entityId).toBe(2);
    expect(w.raycast(o, d, 100, { entities: ents, minDist: 12 })?.entityId).toBe(2);
    expect(w.raycast(o, d, 100, { entities: ents, ignore: new Set([1, 2]) })?.entityId).toBeUndefined();
  });

  it('downed heroes are low targets', () => {
    expect(entityShape(ent(1, 0, 0, VF_DOWNED))!.h).toBeLessThan(1);
    expect(entityShape(ent(1, 0, 0, 0, 'loot'))).toBeNull();
  });

  it('hits the water surface only where the terrain is below it', () => {
    const w = new PickWorld(flatMap([], { height: -2, water: 0 }));
    const hit = w.raycast({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 100);
    expect(hit?.what).toBe('water');
    expect(hit!.point.y).toBeCloseTo(0, 5);
  });

  it('segmentBlocked sees walls and hills but not open ground', () => {
    const w = new PickWorld(flatMap([{ kind: 'box', cx: 0, cy: 2, cz: -10, hx: 3, hy: 2, hz: 0.5, rot: 0 }], { bump: true }));
    expect(w.segmentBlocked({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -20 })).toBe(true);
    expect(w.segmentBlocked({ x: 20, y: 1, z: 0 }, { x: 20, y: 1, z: -20 })).toBe(false);
    // the 10 m bump in the middle of the map blocks a low ray across it
    expect(w.segmentBlocked({ x: -20, y: 1, z: 0 }, { x: 20, y: 1, z: 0 })).toBe(true);
    expect(w.staticDistance({ x: 20, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 5)).toBe(Infinity);
    // starting inside the hill reports an immediate hit
    expect(w.staticDistance({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 5)).toBe(0);
  });
});
