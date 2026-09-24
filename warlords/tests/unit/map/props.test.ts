import { describe, expect, it } from 'vitest';
import type { Collider, MapProp } from '../../../src/core/map';
import { Rng } from '../../../src/core/rng';
import { ColliderIndex } from '../../../src/sim/map/colliders';
import { dcos, dsin, Noise2 } from '../../../src/sim/map/noise';
import {
  GATE_LINTEL,
  GATE_PIER,
  propColliders,
  propLocalToWorld,
  SHIP_GANG_GAP,
  stairStepCount,
  stairSteps,
  worldToPropLocal,
  WT_GAP,
} from '../../../src/sim/map/props';

const prop = (p: Partial<MapProp> & Pick<MapProp, 'type'>): MapProp => ({ x: 0, y: 0, z: 0, rot: 0, sx: 1, sy: 1, sz: 1, variant: 0, ...p });

/** Is the world point inside any of the colliders? */
function solidAt(cs: Collider[], x: number, y: number, z: number): boolean {
  for (const c of cs) {
    if (c.kind === 'cyl') {
      if (y >= c.y0 && y <= c.y1 && Math.hypot(x - c.x, z - c.z) <= c.r) return true;
    } else {
      const dx = x - c.cx;
      const dz = z - c.cz;
      const lx = dx * Math.cos(c.rot) - dz * Math.sin(c.rot);
      const lz = dx * Math.sin(c.rot) + dz * Math.cos(c.rot);
      if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz && Math.abs(y - c.cy) <= c.hy) return true;
    }
  }
  return false;
}

describe('deterministic math', () => {
  it('dsin/dcos match Math.sin/cos to 1e-9', () => {
    for (let x = -200; x <= 200; x += 0.0137) {
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });

  it('Noise2 is seeded, bounded and smooth', () => {
    const a = new Noise2(42);
    const b = new Noise2(42);
    const c = new Noise2(43);
    let diff = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 0.37;
      const z = i * 0.11 - 20;
      const v = a.fbm(x, z, 4);
      expect(v).toBe(b.fbm(x, z, 4));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.5);
      diff += Math.abs(v - c.fbm(x, z, 4));
      // continuity
      expect(Math.abs(a.noise(x, z) - a.noise(x + 0.001, z))).toBeLessThan(0.02);
    }
    expect(diff).toBeGreaterThan(1);
  });
});

describe('prop geometry conventions', () => {
  it('maps local axes like three.js rotation.y', () => {
    const p = prop({ type: 'wall', x: 10, z: 5, rot: Math.PI / 2 });
    // local +X -> world (cos, -sin) = (0, -1); local +Z -> world (sin, cos) = (1, 0)
    const ax = propLocalToWorld(p, 1, 0);
    expect(ax.x).toBeCloseTo(10, 9);
    expect(ax.z).toBeCloseTo(4, 9);
    const az = propLocalToWorld(p, 0, 1);
    expect(az.x).toBeCloseTo(11, 9);
    expect(az.z).toBeCloseTo(5, 9);
    const back = worldToPropLocal(p, ax.x, ax.z);
    expect(back.lx).toBeCloseTo(1, 9);
    expect(back.lz).toBeCloseTo(0, 9);
  });

  it('stairs: ceil(rise / 0.4) solid steps climbing towards local -Z, top flush with sy', () => {
    expect(stairStepCount(6)).toBe(15);
    expect(stairStepCount(6.8)).toBe(17);
    expect(stairStepCount(1.2)).toBe(3);
    expect(stairStepCount(0.8)).toBe(2);
    expect(stairStepCount(0.3)).toBe(1);
    const p = prop({ type: 'stairs', sx: 2, sy: 3, sz: 4, y: 1 });
    const steps = stairSteps(p);
    expect(steps.length).toBe(8);
    expect(steps[0].z1).toBeCloseTo(2, 9); // bottom edge at local +Z
    expect(steps[7].z0).toBeCloseTo(-2, 9); // top edge at local -Z
    expect(steps[7].top).toBeCloseTo(3, 9);
    const cs = propColliders(p);
    expect(cs.length).toBe(8);
    for (const c of cs) {
      expect(c.kind).toBe('box');
      if (c.kind === 'box') expect(c.cy - c.hy).toBeCloseTo(1, 9); // solid down to the base
    }
    expect(solidAt(cs, 0, 1.2, 1.9)).toBe(true); // first step
    expect(solidAt(cs, 0, 1.5, 1.9)).toBe(false); // above the first step
    expect(solidAt(cs, 0, 3.9, -1.9)).toBe(true); // last step reaches y + sy
  });

  it('gateTower: open passage under a walkable lintel, solid piers', () => {
    const p = prop({ type: 'gateTower', sx: 14, sy: 6, sz: 5 });
    const cs = propColliders(p);
    const half = (p.sx - 2 * GATE_PIER) / 2;
    expect(solidAt(cs, 0, 1, 0)).toBe(false); // passage
    expect(solidAt(cs, half - 0.1, 4.5, 0)).toBe(false); // passage headroom
    expect(solidAt(cs, 0, 6 - GATE_LINTEL / 2, 0)).toBe(true); // lintel
    expect(solidAt(cs, half + 0.5, 1, 0)).toBe(true); // pier
    expect(solidAt(cs, 0, 7, 0)).toBe(false); // walkway on top is open…
    expect(solidAt(cs, 0, 6.5, -2.4)).toBe(true); // …with a breastwork on the front (-Z)
    expect(solidAt(cs, 0, 6 + 3.4 + 0.5, 0)).toBe(true); // roof slab
  });

  it('watchtower: solid base, parapets with a gap at the back (+Z) for the stairs', () => {
    const p = prop({ type: 'watchtower', sx: 6, sy: 6.8, sz: 6 });
    const cs = propColliders(p);
    expect(solidAt(cs, 0, 3, 0)).toBe(true);
    expect(solidAt(cs, 0, 7.5, 0)).toBe(false); // standing room on the platform
    expect(solidAt(cs, 0, 7.3, -2.9)).toBe(true); // front parapet
    expect(solidAt(cs, 0, 7.3, 2.9)).toBe(false); // back gap
    expect(solidAt(cs, WT_GAP / 2 + 0.3, 7.3, 2.9)).toBe(true); // back parapet beside the gap
  });

  it('ship: deck top at y, boarding gap in the front bulwark, cabin at the stern', () => {
    const p = prop({ type: 'ship', y: 4, sx: 20, sy: 3.2, sz: 7 });
    const cs = propColliders(p);
    expect(solidAt(cs, -5, 3.9, 0)).toBe(true); // hull
    expect(solidAt(cs, -5, 4.5, 0)).toBe(false); // deck walk
    expect(solidAt(cs, 0, 4.5, -3.4)).toBe(false); // gangway gap (front)
    expect(solidAt(cs, SHIP_GANG_GAP / 2 + 1, 4.5, -3.4)).toBe(true); // bulwark
    expect(solidAt(cs, 0, 4.5, 3.4)).toBe(true); // back bulwark
    expect(solidAt(cs, 0.31 * 20, 5, 0)).toBe(true); // stern cabin (+X)
  });

  it('bridge: deck top at y with rails and piers', () => {
    const p = prop({ type: 'bridge', y: 4, sx: 36, sy: 5, sz: 6.4 });
    const cs = propColliders(p);
    expect(solidAt(cs, 5, 3.8, 0)).toBe(true);
    expect(solidAt(cs, 5, 4.3, 0)).toBe(false);
    expect(solidAt(cs, 5, 4.5, 3.1)).toBe(true); // rail
    expect(solidAt(cs, 0, 1, 0)).toBe(true); // pier at local x = 0
  });

  it('rock: collider follows the elliptical boulder (long axis covered, box corners and tip open)', () => {
    const p = prop({ type: 'rock', x: 3, z: -2, rot: 0.7, sx: 4, sy: 2.5, sz: 3, variant: 0 });
    const cs = propColliders(p);
    const at = (lx: number, lz: number, h: number): boolean => {
      const w = propLocalToWorld(p, lx, lz);
      return solidAt(cs, w.x, p.y + h, w.z);
    };
    // body: semi-axes 0.47·sx = 1.88 (local X) and 0.47·sz = 1.41 (local Z)
    expect(at(1.7, 0, 1)).toBe(true);
    expect(at(-1.7, 0, 1)).toBe(true);
    expect(at(0, 1.3, 1)).toBe(true);
    expect(at(1.2, 0.9, 1)).toBe(true); // inside the ellipse
    expect(at(1.8, 1.35, 1)).toBe(false); // bounding-box corner: outside the boulder
    expect(at(2.1, 0, 1)).toBe(false);
    // cap: solid at the centre up to 0.9·sy, open at the shoulders and above
    expect(at(0, 0, 0.85 * 2.5)).toBe(true);
    expect(at(1.6, 0, 0.85 * 2.5)).toBe(false);
    expect(at(0, 0, 0.95 * 2.5)).toBe(false);
    // flat-topped slab (v1) stays wide to the top
    const slab = propColliders({ ...p, variant: 1 });
    const w = propLocalToWorld(p, 1.5, 0);
    expect(solidAt(slab, w.x, p.y + 0.9 * 2.5, w.z)).toBe(true);
  });

  it('house: walls + stepped hip roof up to the ridge, open above the roof slopes', () => {
    const p = prop({ type: 'house', sx: 9, sy: 5, sz: 5.5, variant: 0 });
    const cs = propColliders(p);
    const wallH = 0.58 * 5;
    expect(solidAt(cs, 4.4, 1, 2.7)).toBe(true); // wall corner
    expect(solidAt(cs, 0, wallH + 0.1, 2.7)).toBe(true); // roof right above the front wall
    expect(solidAt(cs, 0, 4.9, 0)).toBe(true); // just under the ridge
    expect(solidAt(cs, 1.5, 4.9, 0)).toBe(true); // the ridge runs along local X
    expect(solidAt(cs, 0, 4.9, 1.2)).toBe(false); // above the upper roof slope
    expect(solidAt(cs, 0, wallH + 0.9, 2.6)).toBe(false); // above the eave slope near the front edge
    expect(solidAt(cs, 0, 5.2, 0)).toBe(false); // above the ridge
    // two-storey hall: upper floor inset to 90%
    const hall = propColliders({ ...p, variant: 2, sy: 8 });
    expect(solidAt(hall, 4.4, 1, 0)).toBe(true);
    expect(solidAt(hall, 4.4, 0.58 * 8 - 0.2, 0)).toBe(false);
    expect(solidAt(hall, 4.0, 0.58 * 8 - 0.2, 0)).toBe(true);
  });

  it('non-solid and trunk-only props', () => {
    expect(propColliders(prop({ type: 'farmField', sx: 10, sz: 10 }))).toEqual([]);
    expect(propColliders(prop({ type: 'rock', sx: 0.5, sy: 0.3, sz: 0.5 }))).toEqual([]);
    const tree = propColliders(prop({ type: 'tree', sx: 5, sy: 8, sz: 5 }));
    expect(tree.length).toBe(1);
    expect(tree[0].kind).toBe('cyl');
  });
});

describe('ColliderIndex', () => {
  const rng = new Rng(99);
  const colliders: Collider[] = [];
  for (let i = 0; i < 300; i++) {
    if (rng.chance(0.6)) {
      colliders.push({ kind: 'box', cx: rng.range(-70, 70), cy: rng.range(0, 3), cz: rng.range(-70, 70), hx: rng.range(0.2, 4), hy: rng.range(0.2, 3), hz: rng.range(0.2, 4), rot: rng.range(-3, 3) });
    } else {
      const y0 = rng.range(-1, 2);
      colliders.push({ kind: 'cyl', x: rng.range(-70, 70), z: rng.range(-70, 70), r: rng.range(0.1, 2), y0, y1: y0 + rng.range(0.5, 5) });
    }
  }
  const index = new ColliderIndex(colliders, 160);

  it('raycast matches a brute-force march', () => {
    for (let i = 0; i < 60; i++) {
      const o = { x: rng.range(-60, 60), y: rng.range(0, 4), z: rng.range(-60, 60) };
      const d = { x: rng.range(-1, 1), y: rng.range(-0.1, 0.1), z: rng.range(-1, 1) };
      const t = index.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 40);
      // march in small steps
      let tb = Infinity;
      for (let s = 0; s <= 40; s += 0.01) {
        if (solidAt(colliders, o.x + d.x * s, o.y + d.y * s, o.z + d.z * s)) {
          tb = s;
          break;
        }
      }
      if (tb === Infinity) expect(t === Infinity || t > 39.9).toBe(true);
      else expect(Math.abs(t - tb)).toBeLessThan(0.02);
    }
  }, 20_000);

  it('gatherSegment finds every collider near a segment', () => {
    const out = new Int32Array(512);
    for (let i = 0; i < 100; i++) {
      const ax = rng.range(-60, 60);
      const az = rng.range(-60, 60);
      const bx = ax + rng.range(-6, 6);
      const bz = az + rng.range(-6, 6);
      const n = index.gatherSegment(ax, az, bx, bz, 0.45, out);
      const got = new Set(Array.from(out.subarray(0, n)));
      for (let c = 0; c < colliders.length; c++) {
        // brute-force distance: sample the segment finely
        let dmin = Infinity;
        for (let t = 0; t <= 1; t += 0.002) dmin = Math.min(dmin, index.footprintDist(c, ax + (bx - ax) * t, az + (bz - az) * t));
        if (dmin < 0.44) expect(got.has(c)).toBe(true);
        if (got.has(c)) expect(dmin).toBeLessThan(0.46);
      }
    }
  });

  it('surfaceBelow picks the highest box top under the point within reach', () => {
    const cs: Collider[] = [
      { kind: 'box', cx: 0, cy: 0.5, cz: 0, hx: 2, hy: 0.5, hz: 2, rot: 0 },
      { kind: 'box', cx: 0, cy: 3, cz: 0, hx: 1, hy: 0.2, hz: 1, rot: 0.3 },
    ];
    const idx = new ColliderIndex(cs, 20);
    expect(idx.surfaceBelow(0, 0, 1.4, 0)).toBeCloseTo(1, 9);
    expect(idx.surfaceBelow(0, 0, 5, 0)).toBeCloseTo(3.2, 9);
    expect(idx.surfaceBelow(1.8, 1.8, 5, 0)).toBeCloseTo(1, 9);
    expect(idx.surfaceBelow(3, 3, 5, 0.2)).toBeCloseTo(0.2, 9);
    expect(idx.surfaceBelow(3, 3, 0.1, 0.2)).toBe(-Infinity);
    expect(idx.clearance(3, 0, 0, 2, 10)).toBeCloseTo(1, 9);
    expect(idx.blocked(2.3, 0, 0.5, 1.5, 0.45)).toBe(true);
    expect(idx.blocked(2.5, 0, 0.5, 1.5, 0.45)).toBe(false);
  });
});
