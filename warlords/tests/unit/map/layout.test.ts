// Layout sanity across several seeds: props never interpenetrate (except the
// intended joints), bridges and their landings stay clear, box-shaped props sit
// on the ground instead of being half buried, and every city house door opens
// onto the walkable network.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Collider, MapData, MapProp } from '../../../src/core/map';
import { terrainHeight } from '../../../src/core/map';
import { generateMapDetailed } from '../../../src/sim/map/generate';
import { NAV_MAIN, type NavGrid, nearestNode, navNodePos } from '../../../src/sim/map/nav';
import { propColliders, propLocalToWorld } from '../../../src/sim/map/props';
import { colliderPenetration, propOverlaps } from './overlap';

const SEEDS = [1, 2, 5, 11, 42, 20260924];

/** Props that legitimately touch or join: wall corners / parapets on walls, stairs against what they serve. */
const JOINED = new Set(['wall', 'gateTower', 'watchtower', 'dock', 'ship', 'bridge', 'palace']);
function intendedJoint(a: MapProp, b: MapProp): boolean {
  if (a.type === 'wall' && (b.type === 'wall' || b.type === 'gateTower')) return true;
  if (b.type === 'wall' && a.type === 'gateTower') return true;
  if (a.type === 'stairs' && JOINED.has(b.type)) return true;
  if (b.type === 'stairs' && JOINED.has(a.type)) return true;
  return false;
}

const maps: { map: MapData; nav: NavGrid }[] = [];

beforeAll(() => {
  for (const seed of SEEDS) {
    const d = generateMapDetailed(seed);
    maps.push({ map: d.map, nav: d.nav });
  }
});

describe('layout — no clipping', () => {
  it('no two solid props interpenetrate (beyond intended wall/stair joints)', () => {
    for (const { map } of maps) {
      const bad = propOverlaps(map.props, 0.05, intendedJoint).map(
        (o) => `seed ${map.seed}: ${o.a.type}@(${o.a.x.toFixed(1)},${o.a.z.toFixed(1)}) x ${o.b.type}@(${o.b.x.toFixed(1)},${o.b.z.toFixed(1)}) by ${o.depth.toFixed(2)} m`,
      );
      expect(bad).toEqual([]);
    }
  });

  it('keeps bridge decks and their 4 m landings free of other colliders', () => {
    for (const { map } of maps) {
      const bridges = map.props.filter((p) => p.type === 'bridge');
      expect(bridges.length).toBe(3);
      for (const br of bridges) {
        // deck footprint extended 4 m beyond both ends, from just below the deck
        // top to head height above it
        const zone: Collider = { kind: 'box', cx: br.x, cy: br.y + 1, cz: br.z, hx: br.sx / 2 + 4, hy: 1.2, hz: br.sz / 2, rot: br.rot };
        for (const p of map.props) {
          if (p === br) continue;
          for (const c of propColliders(p)) {
            expect(colliderPenetration(zone, c), `seed ${map.seed}: ${p.type}@(${p.x.toFixed(1)},${p.z.toFixed(1)}) on the bridge at x=${br.x.toFixed(0)}`).toBeLessThanOrEqual(0.01);
          }
        }
      }
    }
  });

  it('sits flat-based props on the ground (uphill end buried by <= 40% of their height)', () => {
    // (walls are exempt: the 虎牢关 fortress wall deliberately runs into the ridges)
    const BOXY = new Set<MapProp['type']>(['ruin', 'barricade', 'crateStack', 'tent', 'house', 'statue', 'watchtower', 'brazier']);
    for (const { map } of maps) {
      for (const p of map.props) {
        if (!BOXY.has(p.type)) continue;
        let hi = -Infinity;
        const nx = Math.max(1, Math.ceil(p.sx / 2));
        const nz = Math.max(1, Math.ceil(p.sz / 2));
        for (let j = 0; j <= nz; j++)
          for (let i = 0; i <= nx; i++) {
            const q = propLocalToWorld(p, -p.sx / 2 + (p.sx * i) / nx, -p.sz / 2 + (p.sz * j) / nz);
            hi = Math.max(hi, terrainHeight(map, q.x, q.z));
          }
        expect(hi - p.y, `seed ${map.seed}: ${p.type}@(${p.x.toFixed(1)},${p.z.toFixed(1)}) sy ${p.sy.toFixed(2)}`).toBeLessThanOrEqual(0.4 * p.sy + 0.06);
      }
    }
  });
});

describe('layout — city streets', () => {
  it('varies house orientation: some shops face the lanes (E/W), rows face N/S', () => {
    let lane = 0;
    let row = 0;
    for (const { map } of maps) {
      for (const p of map.props) {
        if (p.type !== 'house' || Math.abs(p.x) > 32 || p.z < 5 || p.z > 32) continue;
        if (Math.abs(Math.sin(p.rot)) > 0.5) lane++;
        else row++;
      }
    }
    expect(lane).toBeGreaterThan(SEEDS.length); // on average > 1 per map
    expect(row).toBeGreaterThan(SEEDS.length * 4);
  });

  it('separates the house rows of each block by >= 3.4 m alleys with a nav line through them', () => {
    let alleys = 0;
    for (const { map, nav } of maps) {
      const city = map.props.filter((p) => p.type === 'house' && Math.abs(p.x) > 5.5 && Math.abs(p.x) < 32 && p.z > 5 && p.z < 32);
      // blocks: sign of x × (inner block |x| < 18.5 | outer block)
      const blocks = new Map<string, MapProp[]>();
      for (const p of city) {
        const key = `${Math.sign(p.x)}:${Math.abs(p.x) < 18.5 ? 'in' : 'out'}`;
        blocks.set(key, [...(blocks.get(key) ?? []), p]);
      }
      for (const houses of blocks.values()) {
        // rows = houses sharing a centre z (back-to-back shops); world z extent of each
        const rows = new Map<number, { z0: number; z1: number; x0: number; x1: number }>();
        for (const h of houses) {
          const ez = Math.abs(Math.sin(h.rot)) > 0.5 ? h.sx / 2 : h.sz / 2;
          const ex = Math.abs(Math.sin(h.rot)) > 0.5 ? h.sz / 2 : h.sx / 2;
          const k = Math.round(h.z * 100);
          const r = rows.get(k) ?? { z0: Infinity, z1: -Infinity, x0: Infinity, x1: -Infinity };
          rows.set(k, { z0: Math.min(r.z0, h.z - ez), z1: Math.max(r.z1, h.z + ez), x0: Math.min(r.x0, h.x - ex), x1: Math.max(r.x1, h.x + ex) });
        }
        const sorted = [...rows.values()].sort((a, b) => a.z0 - b.z0);
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1];
          const b = sorted[i];
          const gap = b.z0 - a.z1;
          expect(gap, `seed ${map.seed}: alley at z=${a.z1.toFixed(1)}`).toBeGreaterThanOrEqual(3.4 - 1e-9);
          if (gap > 6) continue; // a row was dropped (reserved ground): open yard, not an alley
          alleys++;
          // walk the alley's centre line: nav nodes all along it
          const zc = (a.z1 + b.z0) / 2;
          const x0 = Math.max(a.x0, b.x0);
          const x1 = Math.min(a.x1, b.x1);
          for (let x = x0 + 1; x <= x1 - 1; x += 1) {
            const node = nearestNode(nav, { x, y: map.lordSpawn.y, z: zc }, 1.5, true);
            expect(node, `seed ${map.seed}: alley (${x.toFixed(1)}, ${zc.toFixed(1)})`).toBeGreaterThanOrEqual(0);
            expect(Math.abs(navNodePos(nav, node).z - zc)).toBeLessThan(1.5);
          }
        }
      }
    }
    expect(alleys).toBeGreaterThan(SEEDS.length * 4);
  });

  it('opens every city house door onto the walkable network (alleys are navigable)', () => {
    for (const { map, nav } of maps) {
      for (const p of map.props) {
        if (p.type !== 'house' || Math.abs(p.x) > 36 || Math.abs(p.z) > 36) continue;
        // 1.7 m in front of the door: the middle of a >= 3.4 m alley, or the
        // lane; nav nodes sit on a 2 m lattice, and street cover (crates,
        // barricades) may stand before a shop, hence the 2.5 m search radius
        const q = propLocalToWorld(p, 0, -p.sz / 2 - 1.7);
        const node = nearestNode(nav, { x: q.x, y: p.y, z: q.z }, 2.5, true);
        expect(node, `seed ${map.seed}: house door at (${q.x.toFixed(1)},${q.z.toFixed(1)})`).toBeGreaterThanOrEqual(0);
        expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
        expect(Math.abs(navNodePos(nav, node).y - p.y)).toBeLessThan(0.5);
      }
    }
  });
});
