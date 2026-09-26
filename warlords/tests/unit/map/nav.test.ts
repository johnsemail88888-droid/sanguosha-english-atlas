import { beforeAll, describe, expect, it } from 'vitest';
import type { Collider, MapData, MapProp } from '../../../src/core/map';
import { terrainHeight } from '../../../src/core/map';
import type { Vec3 } from '../../../src/core/math';
import { generateMap } from '../../../src/sim/map/generate';
import {
  buildNavGrid,
  findPath,
  isWalkable,
  locateNode,
  NAV_AGENT_RADIUS,
  navCellAt,
  NAV_MAIN,
  NAV_WATER,
  type NavGrid,
  navWalkSegment,
  nearestWalkable,
  randomWalkablePoint,
} from '../../../src/sim/map/nav';
import { propColliders } from '../../../src/sim/map/props';
import { Rng } from '../../../src/core/rng';

const SEED = 20260924;

/** Flat test map: size m square, 2 m heightfield, optional props/colliders. */
function flatMap(opts: { size?: number; props?: MapProp[]; colliders?: Collider[]; height?: (x: number, z: number) => number; lord?: Vec3 }): MapData {
  const size = opts.size ?? 64;
  const res = size / 2;
  const heights = new Float32Array((res + 1) * (res + 1));
  for (let r = 0; r <= res; r++)
    for (let c = 0; c <= res; c++) heights[r * (res + 1) + c] = opts.height ? opts.height(-size / 2 + c * 2, -size / 2 + r * 2) : 0;
  const props = opts.props ?? [];
  return {
    seed: 0,
    nameZh: '测试',
    nameEn: 'Test',
    size,
    res,
    heights,
    waterLevel: -5,
    props,
    colliders: [...props.flatMap(propColliders), ...(opts.colliders ?? [])],
    lordSpawn: opts.lord ?? { x: -size / 2 + 5, y: 0, z: -size / 2 + 5 },
    spawns: [],
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
}

const prop = (p: Partial<MapProp> & Pick<MapProp, 'type'>): MapProp => ({ x: 0, y: 0, z: 0, rot: 0, sx: 1, sy: 1, sz: 1, variant: 0, ...p });

function pathLength(path: Vec3[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return len;
}

describe('nav grid — synthetic maps', () => {
  it('blocks colliders with agent clearance and paths around them', () => {
    const map = flatMap({ colliders: [{ kind: 'box', cx: 0, cy: 2, cz: 0, hx: 3, hy: 2, hz: 8, rot: 0 }] });
    const nav = buildNavGrid(map);
    expect(isWalkable(nav, { x: 1, y: 0, z: 1 })).toBe(false);
    expect(isWalkable(nav, { x: 5, y: 0, z: 1 })).toBe(true);
    const path = findPath(nav, { x: -15, y: 0, z: 1 }, { x: 15, y: 0, z: 1 })!;
    expect(path).not.toBeNull();
    expect(path[0]).toMatchObject({ x: -15, z: 1 });
    expect(path[path.length - 1]).toMatchObject({ x: 15, z: 1 });
    // no segment passes through the box inflated by the agent radius
    for (let i = 1; i < path.length; i++) {
      for (let t = 0; t <= 1; t += 0.02) {
        const x = path[i - 1].x + (path[i].x - path[i - 1].x) * t;
        const z = path[i - 1].z + (path[i].z - path[i - 1].z) * t;
        const inside = Math.abs(x) < 3 + NAV_AGENT_RADIUS - 0.05 && Math.abs(z) < 8 + NAV_AGENT_RADIUS - 0.05;
        expect(inside).toBe(false);
      }
    }
    // string pulling: close to the optimal detour, few waypoints
    expect(path.length).toBeLessThanOrEqual(5);
    expect(pathLength(path)).toBeLessThan(2 * Math.hypot(15, 8) + 3);
  });

  it('climbs stair steps but not walls, and stands on platform tops', () => {
    const platform = prop({ type: 'watchtower', x: 1, z: 1, sx: 6, sy: 4, sz: 6, rot: -Math.PI / 2 });
    // stairs west of the tower, climbing east (towards it)
    const stairs = prop({ type: 'stairs', x: 1 - 3 - 2.5, z: 1, sx: 2, sy: 4, sz: 5, rot: -Math.PI / 2 });
    const top: Vec3 = { x: 1, y: 4, z: 1 };
    const withStairs = buildNavGrid(flatMap({ props: [platform, stairs] }));
    expect(isWalkable(withStairs, top)).toBe(true);
    const path = findPath(withStairs, { x: -20, y: 0, z: 10 }, top);
    expect(path).not.toBeNull();
    expect(path![path!.length - 1].y).toBeCloseTo(4, 3);
    for (let i = 1; i < path!.length; i++) {
      const h = navWalkSegment(withStairs, path![i - 1], path![i]);
      expect(Number.isNaN(h)).toBe(false);
      expect(Math.abs(h - path![i].y)).toBeLessThan(0.35);
    }
    const noStairs = buildNavGrid(flatMap({ props: [platform] }));
    expect(isWalkable(noStairs, top)).toBe(true); // a surface exists…
    const blocked = findPath(noStairs, { x: -20, y: 0, z: 10 }, top)!; // …but is unreachable:
    expect(blocked).not.toBeNull(); // the path ends at the foot of the tower instead
    const end = blocked[blocked.length - 1];
    expect(end.y).toBeLessThan(0.5);
    expect(Math.hypot(end.x - top.x, end.z - top.z)).toBeLessThan(6);
  });

  it('keeps two layers where a walkable deck spans a passage (gate lintel)', () => {
    const gate = prop({ type: 'gateTower', x: 1, z: 1, sx: 14, sy: 6, sz: 5 });
    const nav = buildNavGrid(flatMap({ props: [gate] }));
    const ground = locateNode(nav, { x: 1, y: 0, z: 1 }, 0.3);
    const deck = locateNode(nav, { x: 1, y: 6, z: 1 }, 0.3);
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(deck).toBeGreaterThanOrEqual(0);
    expect(ground).not.toBe(deck);
    // the road through the passage stays at ground level
    const p = findPath(nav, { x: 1, y: 0, z: -15 }, { x: 1, y: 0, z: 15 })!;
    expect(p).not.toBeNull();
    expect(Math.max(...p.map((q) => q.y))).toBeLessThan(0.5);
    expect(pathLength(p)).toBeLessThan(31);
  });

  it('rejects slopes steeper than the walkable limit', () => {
    // a 45° ramp in the middle of the map (x in [-4, 12] rises 16 m)
    const map = flatMap({ height: (x) => (x < -4 ? 0 : x > 12 ? 16 : x + 4), lord: { x: -20, y: 0, z: 0 } });
    const nav = buildNavGrid(map);
    expect(isWalkable(nav, { x: 4, y: 8, z: 0 })).toBe(false);
    // the plateau is out of reach and > 16 m from any reachable node: no path
    expect(findPath(nav, { x: -20, y: 0, z: 0 }, { x: 20, y: 16, z: 0 })).toBeNull();
    // a goal on the cliff face itself: the path stops at the foot of the slope
    const path = findPath(nav, { x: -20, y: 0, z: 0 }, { x: 4, y: 8, z: 0 })!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1].x).toBeLessThan(-3);
    expect(findPath(nav, { x: 20, y: 16, z: 0 }, { x: 25, y: 16, z: 5 })).not.toBeNull(); // plateau-local paths work
    expect(findPath(nav, { x: 20, y: 16, z: 0 }, { x: -20, y: 0, z: 0 })).toBeNull(); // can't walk down a cliff
  });

  it('prefers a dry detour over wading when water is costly', () => {
    // shallow ditch across the map (x in [-2, 2]) except a dry causeway at z > 20
    const map = flatMap({ height: (x, z) => (Math.abs(x) <= 2 && z < 20 ? -0.8 : 0) });
    map.waterLevel = -0.3;
    const nav = buildNavGrid(map);
    const from = { x: -12, y: 0, z: 8 };
    const to = { x: 12, y: 0, z: 8 };
    const path = findPath(nav, from, to)!;
    expect(path).not.toBeNull();
    // wading straight across costs 4x per wet cell; the detour via z > 20 is cheaper
    expect(Math.max(...path.map((p) => p.z))).toBeGreaterThan(19);
  });
});

describe('nav grid — 虎牢·赤壁', () => {
  let map: MapData;
  let nav: NavGrid;

  beforeAll(() => {
    map = generateMap(SEED);
    nav = buildNavGrid(map);
  });

  it('is cached per map', () => {
    expect(buildNavGrid(map)).toBe(nav);
  });

  it('reaches every crate and loot spot from the lord spawn', () => {
    const spots = [...map.crateSpots.map((c) => c.pos), ...map.lootSpots];
    expect(spots.length).toBeGreaterThan(100);
    for (const s of spots) {
      const path = findPath(nav, map.lordSpawn, s);
      expect(path, `spot ${s.x},${s.y},${s.z}`).not.toBeNull();
      const end = path![path!.length - 1];
      expect(Math.hypot(end.x - s.x, end.z - s.z)).toBeLessThan(1.5);
      expect(Math.abs(end.y - s.y)).toBeLessThan(0.5);
    }
  });

  it('reaches every spawn and returns walkable segments', () => {
    for (const s of map.spawns) {
      const path = findPath(nav, s, map.lordSpawn)!;
      expect(path).not.toBeNull();
      for (let i = 1; i < path.length; i++) {
        const h = navWalkSegment(nav, path[i - 1], path[i]);
        expect(Number.isNaN(h)).toBe(false);
        expect(Math.abs(h - path[i].y)).toBeLessThan(0.35);
      }
    }
  });

  it('finds cross-map paths in < 5 ms (typical)', () => {
    const pairs: [Vec3, Vec3][] = [];
    const n = map.spawns.length;
    for (let i = 0; i < n; i++) pairs.push([map.spawns[i], map.spawns[(i + Math.floor(n / 2)) % n]]);
    findPath(nav, pairs[0][0], pairs[0][1]); // warm-up
    const times: number[] = [];
    for (const [a, b] of pairs) {
      const t0 = performance.now();
      const p = findPath(nav, a, b);
      times.push(performance.now() - t0);
      expect(p).not.toBeNull();
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(150);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(5);
  });

  it('answers walkability and snaps points to the walkable network', () => {
    const house = map.props.find((p) => p.type === 'house' && Math.abs(p.x) < 35 && p.z > 5)!;
    const inside = { x: house.x, y: house.y, z: house.z };
    expect(isWalkable(nav, inside)).toBe(false);
    const snapped = nearestWalkable(nav, inside)!;
    expect(snapped).not.toBeNull();
    expect(isWalkable(nav, snapped)).toBe(true);
    expect(Math.hypot(snapped.x - house.x, snapped.z - house.z)).toBeGreaterThan(Math.min(house.sx, house.sz) / 2);
    expect(isWalkable(nav, map.lordSpawn)).toBe(true);
    // on the city wall walk vs. under it
    const wallTop = { x: 21, y: map.lordSpawn.y + 6, z: -39 };
    expect(isWalkable(nav, wallTop)).toBe(true);
    expect(isWalkable(nav, { x: 21, y: map.lordSpawn.y, z: -39 })).toBe(false);
    // point on open ground is kept as is (y snapped to the surface)
    const s0 = map.spawns[0];
    const k = nearestWalkable(nav, { x: s0.x + 0.3, y: s0.y + 0.5, z: s0.z - 0.2 })!;
    expect(k.x).toBeCloseTo(s0.x + 0.3, 6);
    expect(k.y).toBeCloseTo(terrainHeight(map, k.x, k.z), 1);
  });

  it('leads up the stairs onto the corner watchtower', () => {
    const tower = map.props.find((p) => p.type === 'watchtower' && p.x > 0 && p.z < 0 && Math.abs(p.x) < 40)!;
    const top = { x: tower.x, y: tower.y + tower.sy, z: tower.z };
    const path = findPath(nav, map.lordSpawn, top)!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1].y).toBeCloseTo(top.y, 1);
  });

  it('crosses the river on a bridge rather than wading', () => {
    const br = map.props.find((p) => p.type === 'bridge' && Math.abs(p.x) < 10)!;
    const from = { x: br.x + 12, y: NaN, z: br.z - br.sx / 2 - 6 };
    const to = { x: br.x - 12, y: NaN, z: br.z + br.sx / 2 + 6 };
    from.y = terrainHeight(map, from.x, from.z);
    to.y = terrainHeight(map, to.x, to.z);
    const path = findPath(nav, from, to)!;
    expect(path).not.toBeNull();
    for (let i = 1; i < path.length; i++) {
      for (let t = 0; t <= 1; t += 0.05) {
        const x = path[i - 1].x + (path[i].x - path[i - 1].x) * t;
        const z = path[i - 1].z + (path[i].z - path[i - 1].z) * t;
        const y = path[i - 1].y + (path[i].y - path[i - 1].y) * t;
        const node = locateNode(nav, { x, y, z }, 1.5);
        if (node >= 0) expect(nav.flags[node] & NAV_WATER).toBeFalsy();
      }
    }
  });

  it('returns a partial path toward the goal when the search budget runs out', () => {
    const n = map.spawns.length;
    const a = map.spawns[0];
    const b = map.spawns[Math.floor(n / 2)];
    const dist = (p: Vec3, q: Vec3): number => Math.hypot(p.x - q.x, p.z - q.z);
    const full = findPath(nav, a, b)!;
    expect(full).not.toBeNull();
    expect(dist(full[full.length - 1], b)).toBeLessThan(1.5);
    const part = findPath(nav, a, b, 400)!;
    expect(part).not.toBeNull();
    const end = part[part.length - 1];
    expect(dist(end, b)).toBeGreaterThan(1.5); // not there yet…
    expect(dist(end, b)).toBeLessThan(dist(a, b) - 15); // …but well on the way
    for (let i = 1; i < part.length; i++) {
      const h = navWalkSegment(nav, part[i - 1], part[i]);
      expect(Number.isNaN(h)).toBe(false);
      expect(Math.abs(h - part[i].y)).toBeLessThan(0.35);
    }
    // no progress possible at all -> null
    expect(findPath(nav, a, b, 1)).toBeNull();
  });

  it('completes random map-wide queries within a 20000-expansion budget, fast', () => {
    const rng = new Rng(77);
    const pts: Vec3[] = [];
    while (pts.length < 120) {
      const p = randomWalkablePoint(nav, () => rng.next(), { x: 0, y: 0, z: 0 }, 150);
      if (p) pts.push(p);
    }
    const times: number[] = [];
    let partial = 0;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const t0 = performance.now();
      const path = findPath(nav, pts[i], pts[i + 1], 20000);
      times.push(performance.now() - t0);
      expect(path).not.toBeNull();
      const end = path![path!.length - 1];
      if (Math.hypot(end.x - pts[i + 1].x, end.z - pts[i + 1].z) > 1.5) partial++;
    }
    expect(partial).toBe(0);
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(5);
  });

  it('rejects non-finite positions', () => {
    const bad = { x: NaN, y: NaN, z: NaN };
    expect(navCellAt(nav, NaN, 0)).toBe(-1);
    expect(navCellAt(nav, 0, Infinity)).toBe(-1);
    expect(locateNode(nav, bad)).toBe(-1);
    expect(isWalkable(nav, bad)).toBe(false);
    expect(nearestWalkable(nav, bad)).toBeNull();
    expect(findPath(nav, bad, map.lordSpawn)).toBeNull();
    expect(findPath(nav, map.lordSpawn, bad)).toBeNull();
  });

  it('samples random walkable points in the main component', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 20; i++) {
      const p = randomWalkablePoint(nav, () => rng.next(), map.lordSpawn, 60);
      expect(p).not.toBeNull();
      const node = locateNode(nav, p!);
      expect(nav.flags[node] & NAV_MAIN).toBeTruthy();
    }
  });
});
