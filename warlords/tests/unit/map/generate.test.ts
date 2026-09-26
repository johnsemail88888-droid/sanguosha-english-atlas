import { beforeAll, describe, expect, it } from 'vitest';
import type { MapData, MapProp } from '../../../src/core/map';
import { terrainHeight } from '../../../src/core/map';
import { ColliderIndex } from '../../../src/sim/map/colliders';
import { generateMap, generateMapDetailed } from '../../../src/sim/map/generate';
import { findPath, locateNode, NAV_MAIN, NAV_WATER, type NavGrid, isWalkable } from '../../../src/sim/map/nav';
import { propColliders, propLocalToWorld, stairSteps, STAIR_MAX_RISE } from '../../../src/sim/map/props';

const SEED = 20260924;

/** FNV-1a over a canonical JSON dump (heights included). */
function digest(map: MapData): string {
  const json = JSON.stringify({ ...map, heights: Array.from(map.heights) });
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + json.length;
}

/** World AABB of a prop's (rotated) footprint. */
function propAabb(p: MapProp): { x0: number; x1: number; z0: number; z1: number } {
  const pts = [
    propLocalToWorld(p, -p.sx / 2, -p.sz / 2),
    propLocalToWorld(p, p.sx / 2, -p.sz / 2),
    propLocalToWorld(p, p.sx / 2, p.sz / 2),
    propLocalToWorld(p, -p.sx / 2, p.sz / 2),
  ];
  return {
    x0: Math.min(...pts.map((q) => q.x)),
    x1: Math.max(...pts.map((q) => q.x)),
    z0: Math.min(...pts.map((q) => q.z)),
    z1: Math.max(...pts.map((q) => q.z)),
  };
}

let map: MapData;
let nav: NavGrid;
let index: ColliderIndex;

beforeAll(() => {
  const d = generateMapDetailed(SEED);
  map = d.map;
  nav = d.nav;
  index = new ColliderIndex(map.colliders, map.size);
});

describe('generateMap — determinism & budget', () => {
  it('builds an identical MapData for the same seed', () => {
    const a = generateMap(SEED);
    const b = generateMap(SEED);
    expect(digest(a)).toBe(digest(b));
    expect(digest(a)).toBe(digest(map));
  });

  it('builds different details for different seeds', () => {
    const other = generateMap(SEED + 1);
    expect(digest(other)).not.toBe(digest(map));
    // same overall layout: same region set, same camp types
    expect(other.regions.map((r) => r.id)).toEqual(map.regions.map((r) => r.id));
    expect(other.camps.map((c) => c.npcType)).toEqual(map.camps.map((c) => c.npcType));
  });

  it('generates within 300 ms', () => {
    generateMap(7); // warm-up (JIT)
    const times: number[] = [];
    for (const seed of [11, 22, 33]) {
      const t0 = performance.now();
      generateMap(seed);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[1]).toBeLessThan(300);
  });
});

describe('generateMap — contract', () => {
  it('fills the MapData contract', () => {
    expect(map.seed).toBe(SEED);
    expect(map.nameZh).toBe('虎牢·赤壁');
    expect(map.size).toBe(320);
    expect(map.res).toBe(160);
    expect(map.heights).toBeInstanceOf(Float32Array);
    expect(map.heights.length).toBe(161 * 161);
    expect(map.heights.every((h) => Number.isFinite(h))).toBe(true);
    expect(map.props.length).toBeGreaterThan(400);
    expect(map.props.length).toBeLessThanOrEqual(2500);
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of map.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(lo).toBeLessThan(map.waterLevel - 0.5); // a river exists
    expect(hi).toBeGreaterThan(40); // the mountain rim
  });

  it('has finite, well-formed props and colliders', () => {
    for (const p of map.props) {
      for (const v of [p.x, p.y, p.z, p.rot, p.sx, p.sy, p.sz, p.variant]) expect(Number.isFinite(v)).toBe(true);
      expect(p.sx).toBeGreaterThan(0);
      expect(p.sy).toBeGreaterThan(0);
      expect(p.sz).toBeGreaterThan(0);
    }
    for (const c of map.colliders) {
      if (c.kind === 'box') {
        for (const v of [c.cx, c.cy, c.cz, c.hx, c.hy, c.hz, c.rot]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.min(c.hx, c.hy, c.hz)).toBeGreaterThan(0);
      } else {
        for (const v of [c.x, c.z, c.r, c.y0, c.y1]) expect(Number.isFinite(v)).toBe(true);
        expect(c.r).toBeGreaterThan(0);
        expect(c.y1).toBeGreaterThan(c.y0);
      }
    }
  });

  it('gives every solid prop colliders that stay within its footprint', () => {
    let total = 0;
    for (const p of map.props) {
      const cs = propColliders(p);
      total += cs.length;
      if (p.type === 'farmField' || (p.type === 'rock' && p.sy < 0.6)) {
        expect(cs.length).toBe(0);
        continue;
      }
      expect(cs.length, `${p.type} at ${p.x},${p.z}`).toBeGreaterThan(0);
      if (p.type === 'tree' || p.type === 'pine' || p.type === 'banner') continue; // trunk/pole only
      const box = propAabb(p);
      const slack = 1.3; // roof overhangs (gate/watchtower/pavilion roofs)
      for (const c of cs) {
        const r = c.kind === 'cyl' ? c.r : 0;
        const cx = c.kind === 'cyl' ? c.x : c.cx;
        const cz = c.kind === 'cyl' ? c.z : c.cz;
        const ex = c.kind === 'cyl' ? 0 : Math.abs(c.hx * Math.cos(c.rot)) + Math.abs(c.hz * Math.sin(c.rot));
        const ez = c.kind === 'cyl' ? 0 : Math.abs(c.hx * Math.sin(c.rot)) + Math.abs(c.hz * Math.cos(c.rot));
        expect(cx - ex - r).toBeGreaterThan(box.x0 - slack);
        expect(cx + ex + r).toBeLessThan(box.x1 + slack);
        expect(cz - ez - r).toBeGreaterThan(box.z0 - slack);
        expect(cz + ez + r).toBeLessThan(box.z1 + slack);
      }
    }
    // MapData.colliders = prop colliders + invisible boundary walls
    expect(map.colliders.length).toBeGreaterThan(total);
    expect(map.colliders.length - total).toBeLessThanOrEqual(8);
  });

  it('contains the named structures of GAME_SPEC §9', () => {
    const count = (t: MapProp['type']): number => map.props.filter((p) => p.type === t).length;
    expect(count('palace')).toBe(1);
    expect(count('gateTower')).toBe(5); // 4 city gates + 虎牢关
    expect(count('watchtower')).toBeGreaterThanOrEqual(6); // 4 city corners + camps
    expect(count('bridge')).toBe(3);
    expect(count('ship')).toBeGreaterThanOrEqual(2);
    expect(count('dock')).toBeGreaterThanOrEqual(1);
    expect(count('house')).toBeGreaterThanOrEqual(18);
    expect(count('pavilion')).toBeGreaterThanOrEqual(2);
    expect(count('tent')).toBeGreaterThanOrEqual(10);
    expect(count('bamboo')).toBeGreaterThanOrEqual(30);
    expect(count('farmField')).toBeGreaterThanOrEqual(4);
    for (const t of ['barricade', 'crateStack', 'banner', 'brazier', 'rock', 'tree', 'pine', 'ruin', 'statue', 'stairs'] as const) {
      expect(count(t), t).toBeGreaterThan(0);
    }
  });
});

describe('generateMap — spawns, camps, regions, spots', () => {
  it('places the lord on the palace plaza', () => {
    const L = map.lordSpawn;
    expect(Math.abs(L.x)).toBeLessThan(15);
    expect(L.z).toBeGreaterThan(-8);
    expect(L.z).toBeLessThan(8);
    expect(L.y).toBeCloseTo(terrainHeight(map, L.x, L.z), 3);
    const palace = map.props.find((p) => p.type === 'palace')!;
    expect(palace.z).toBeLessThan(L.z); // palace is north of the plaza
    expect(Math.hypot(palace.x - L.x, palace.z - L.z)).toBeLessThan(20);
    const node = locateNode(nav, L);
    expect(node).toBeGreaterThanOrEqual(0);
    expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
  });

  it('has >= 8 valid hero spawns ~100–120 m out, spread by angle', () => {
    expect(map.spawns.length).toBeGreaterThanOrEqual(8);
    const angles: number[] = [];
    for (const s of map.spawns) {
      const r = Math.hypot(s.x, s.z);
      expect(r).toBeGreaterThanOrEqual(100);
      expect(r).toBeLessThanOrEqual(120);
      // on the ground (terrain, not a deck), dry, walkable, main component
      const ground = terrainHeight(map, s.x, s.z);
      expect(s.y).toBeCloseTo(ground, 3);
      expect(ground).toBeGreaterThan(map.waterLevel + 0.3);
      expect(isWalkable(nav, s)).toBe(true);
      const node = locateNode(nav, s);
      expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
      expect(nav.flags[node] & NAV_WATER).toBeFalsy();
      // not inside / touching colliders: >= 0.5 m (generator uses 1.5 m)
      expect(index.clearance(s.x, s.z, ground - 0.5, ground + 2, 3)).toBeGreaterThanOrEqual(0.5);
      // nothing to stand on under the feet except terrain
      expect(index.surfaceBelow(s.x, s.z, ground + 3, ground)).toBeCloseTo(ground, 5);
      angles.push(Math.atan2(s.x, -s.z));
    }
    angles.sort((a, b) => a - b);
    let maxGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
    for (let i = 1; i < angles.length; i++) {
      const gap = angles[i] - angles[i - 1];
      expect(gap).toBeGreaterThan((15 * Math.PI) / 180);
      maxGap = Math.max(maxGap, gap);
    }
    expect(maxGap).toBeLessThan((80 * Math.PI) / 180);
  });

  it('defines the NPC camps', () => {
    const yt = map.camps.filter((c) => c.npcType === 'yellowTurban');
    expect(yt.length).toBe(2);
    for (const c of yt) {
      expect(c.count).toBe(5);
      expect(c.crateTier).toBe(2);
    }
    const bar = map.camps.filter((c) => c.npcType === 'barbarian');
    expect(bar.length).toBe(1);
    expect(bar[0].count).toBe(4);
    expect(bar[0].pos.x).toBeLessThan(-40); // south-west
    expect(bar[0].pos.z).toBeGreaterThan(40);
    for (const c of map.camps) {
      const node = locateNode(nav, c.pos);
      expect(node).toBeGreaterThanOrEqual(0);
      expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
      // no hero spawn inside a camp's aggro range
      for (const s of map.spawns) expect(Math.hypot(s.x - c.pos.x, s.z - c.pos.z)).toBeGreaterThan(30);
    }
  });

  it('names the regions (zh/en)', () => {
    const ids = map.regions.map((r) => r.id);
    for (const id of ['luoyang', 'hulao', 'chibi', 'guandu', 'changban']) expect(ids).toContain(id);
    expect(map.regions.length).toBeGreaterThanOrEqual(7);
    for (const r of map.regions) {
      expect(r.nameZh.length).toBeGreaterThan(0);
      expect(r.nameEn.length).toBeGreaterThan(0);
      expect(r.radius).toBeGreaterThan(10);
    }
    expect(map.regions.find((r) => r.id === 'luoyang')!.nameZh).toBe('洛阳宫城');
  });

  it('provides ~60 loot spots and ~40 + ~12 crates, all dry and on the walkable network', () => {
    expect(map.lootSpots.length).toBeGreaterThanOrEqual(50);
    expect(map.lootSpots.length).toBeLessThanOrEqual(70);
    const t1 = map.crateSpots.filter((c) => c.tier === 1).length;
    const t2 = map.crateSpots.filter((c) => c.tier === 2).length;
    expect(t1).toBeGreaterThanOrEqual(35);
    expect(t1).toBeLessThanOrEqual(45);
    expect(t2).toBeGreaterThanOrEqual(10);
    expect(t2).toBeLessThanOrEqual(14);
    for (const p of [...map.lootSpots, ...map.crateSpots.map((c) => c.pos)]) {
      const node = locateNode(nav, p, 0.3);
      expect(node).toBeGreaterThanOrEqual(0);
      expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
      expect(nav.flags[node] & NAV_WATER).toBeFalsy();
    }
    // some crates/loot are elevated (tower platforms, wall walks, decks)
    const elevated = [...map.lootSpots, ...map.crateSpots.map((c) => c.pos)].filter((p) => p.y > terrainHeight(map, p.x, p.z) + 1);
    expect(elevated.length).toBeGreaterThanOrEqual(8);
  });
});

describe('generateMap — walkable structures', () => {
  it('stair flights rise <= 0.45 m per step and meet the ground/landing at both ends', () => {
    const stairs = map.props.filter((p) => p.type === 'stairs');
    expect(stairs.length).toBeGreaterThanOrEqual(12);
    for (const p of stairs) {
      const steps = stairSteps(p);
      let prev = 0;
      for (const st of steps) {
        expect(st.top - prev).toBeLessThanOrEqual(STAIR_MAX_RISE + 1e-9);
        expect(st.top - prev).toBeLessThanOrEqual(0.45);
        prev = st.top;
      }
      expect(prev).toBeCloseTo(p.sy, 9);
      // bottom: just outside the bottom edge there is a surface within one step of the base
      const bot = propLocalToWorld(p, 0, p.sz / 2 + 0.3);
      const gb = terrainHeight(map, bot.x, bot.z);
      const sBot = index.surfaceBelow(bot.x, bot.z, p.y + 0.45, gb);
      expect(Math.abs(sBot - p.y), `stairs bottom at ${p.x},${p.z}`).toBeLessThanOrEqual(0.45);
      // top: a landing flush (±1 step) with the last step, either beyond the top
      // edge (towers, gangplanks) or beside the top step (马道 ramps running
      // along the inner face of a wall, stepped off sideways)
      const lastRun = p.sz / steps.length;
      const probes = [
        propLocalToWorld(p, 0, -p.sz / 2 - 0.3),
        propLocalToWorld(p, -p.sx / 2 - 0.3, -p.sz / 2 + lastRun / 2),
        propLocalToWorld(p, p.sx / 2 + 0.3, -p.sz / 2 + lastRun / 2),
      ];
      const landing = probes.some((q) => {
        const s = index.surfaceBelow(q.x, q.z, p.y + p.sy + 0.45, terrainHeight(map, q.x, q.z));
        return Math.abs(s - (p.y + p.sy)) <= 0.45;
      });
      expect(landing, `stairs top at ${p.x},${p.z}`).toBe(true);
    }
  });

  it('bridges span the river and connect both banks', () => {
    const bridges = map.props.filter((p) => p.type === 'bridge');
    expect(bridges.length).toBe(3);
    for (const br of bridges) {
      const mid = propLocalToWorld(br, 0, 0);
      expect(terrainHeight(map, mid.x, mid.z)).toBeLessThan(map.waterLevel - 0.5); // water under the middle
      const a = propLocalToWorld(br, -br.sx / 2 + 0.6, 0);
      const b = propLocalToWorld(br, br.sx / 2 - 0.6, 0);
      for (const end of [a, b]) {
        const g = terrainHeight(map, end.x, end.z);
        expect(g).toBeGreaterThan(map.waterLevel + 0.3); // lands on dry ground
        expect(br.y - g).toBeGreaterThanOrEqual(-0.05);
        expect(br.y - g).toBeLessThanOrEqual(0.45); // step onto the deck
      }
      // AI walks across on the deck, never wading
      const off = 4;
      const from = propLocalToWorld(br, -br.sx / 2 - off, 0);
      const to = propLocalToWorld(br, br.sx / 2 + off, 0);
      const path = findPath(nav, { x: from.x, y: terrainHeight(map, from.x, from.z), z: from.z }, { x: to.x, y: terrainHeight(map, to.x, to.z), z: to.z });
      expect(path).not.toBeNull();
      let len = 0;
      for (let i = 1; i < path!.length; i++) len += Math.hypot(path![i].x - path![i - 1].x, path![i].z - path![i - 1].z);
      expect(len).toBeLessThan(br.sx + 2 * off + 6);
      for (let i = 1; i < path!.length; i++) {
        const p0 = path![i - 1];
        const p1 = path![i];
        const n = Math.ceil(Math.hypot(p1.x - p0.x, p1.z - p0.z));
        for (let k = 0; k <= n; k++) {
          const t = k / Math.max(1, n);
          const x = p0.x + (p1.x - p0.x) * t;
          const z = p0.z + (p1.z - p0.z) * t;
          const node = locateNode(nav, { x, y: p0.y + (p1.y - p0.y) * t, z }, 1.5);
          if (node >= 0) expect(nav.flags[node] & NAV_WATER).toBeFalsy();
        }
      }
    }
  });

  it('warship decks are boardable from the docks', () => {
    const ships = map.props.filter((p) => p.type === 'ship');
    for (const s of ships) {
      const node = locateNode(nav, { x: s.x - 0.25 * s.sx * Math.cos(s.rot), y: s.y, z: s.z }, 0.5);
      expect(node, `ship at ${s.x},${s.z}`).toBeGreaterThanOrEqual(0);
      expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
    }
  });

  it('city walls, gate towers and corner watchtowers are climbable', () => {
    const towers = map.props.filter((p) => p.type === 'watchtower');
    for (const t of towers) {
      const node = locateNode(nav, { x: t.x, y: t.y + t.sy, z: t.z }, 0.3);
      expect(node, `tower at ${t.x},${t.z}`).toBeGreaterThanOrEqual(0);
      expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
    }
    const gates = map.props.filter((p) => p.type === 'gateTower');
    for (const g of gates) {
      // road through the passage (ground) and the wall walk on the lintel above it
      const ground = locateNode(nav, { x: g.x, y: g.y, z: g.z }, 0.5);
      const top = locateNode(nav, { x: g.x + 1, y: g.y + g.sy, z: g.z + 1 }, 0.5);
      expect(ground).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(nav.flags[ground] & NAV_MAIN).toBeTruthy();
      expect(nav.flags[top] & NAV_MAIN).toBeTruthy();
    }
  });
});
