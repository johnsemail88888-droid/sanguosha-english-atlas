// Hand-made test map + match helpers so sim tests don't depend on the real
// generated map.
import type { Collider, MapData } from '../../../src/core/map';
import type { Entity, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import type { MatchInit } from '../../../src/sim/host';
import type { CreateMatchOptions, World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';

export const TEST_SIZE = 120;
export const TEST_RES = 60; // 2 m cells

/** Water pit: terrain dips to -2 inside x∈[30,44], z∈[-10,10]; water level -0.5. */
export const WATER_LEVEL = -0.5;

export interface TestMapOptions {
  /** add a steep hill (60°) along x∈[-40,-30] rising toward -x */
  hill?: boolean;
}

export const STAIRS = { x: 0, z0: -10, stepRun: 0.6, stepRise: 0.4, steps: 4 };

/** Colliders used by the movement/raycast tests. */
export function testColliders(): Collider[] {
  const cols: Collider[] = [];
  // wall along z at x = 10 (thickness 1, height 3, length 10)
  cols.push({ kind: 'box', cx: 10, cy: 1.5, cz: 0, hx: 0.5, hy: 1.5, hz: 5, rot: 0 });
  // platform: top at 1.0 (too high to step, jumpable)
  cols.push({ kind: 'box', cx: -10, cy: 0.5, cz: 10, hx: 2, hy: 0.5, hz: 2, rot: 0 });
  // stairs: stack of steps rising toward -z starting at z0, each 0.4 high, then a landing
  for (let i = 0; i < STAIRS.steps; i++) {
    const top = STAIRS.stepRise * (i + 1);
    const zc = STAIRS.z0 - STAIRS.stepRun * (i + 0.5);
    cols.push({ kind: 'box', cx: STAIRS.x, cy: top / 2, cz: zc, hx: 1.5, hy: top / 2, hz: STAIRS.stepRun / 2, rot: 0 });
  }
  const landingTop = STAIRS.stepRise * STAIRS.steps;
  const landingZ = STAIRS.z0 - STAIRS.stepRun * STAIRS.steps - 2;
  cols.push({ kind: 'box', cx: STAIRS.x, cy: landingTop / 2, cz: landingZ, hx: 1.5, hy: landingTop / 2, hz: 2, rot: 0 });
  // pillar
  cols.push({ kind: 'cyl', x: -5, z: -5, r: 0.5, y0: 0, y1: 3 });
  // rotated box (45°) at (20, 20)
  cols.push({ kind: 'box', cx: 20, cy: 1, cz: 20, hx: 2, hy: 1, hz: 0.5, rot: Math.PI / 4 });
  // roof slab (ceiling) at (-20, 2.5..2.9, -20)
  cols.push({ kind: 'box', cx: -20, cy: 2.7, cz: -20, hx: 3, hy: 0.2, hz: 3, rot: 0 });
  return cols;
}

export function makeTestMap(opts: TestMapOptions = {}): MapData {
  const n = TEST_RES + 1;
  const heights = new Float32Array(n * n);
  const half = TEST_SIZE / 2;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = -half + (col / TEST_RES) * TEST_SIZE;
      const z = -half + (row / TEST_RES) * TEST_SIZE;
      let h = 0;
      if (x >= 30 && x <= 44 && z >= -10 && z <= 10) h = -2;
      if (opts.hill && x <= -30 && x >= -44) h = (-30 - x) * Math.tan((60 * Math.PI) / 180);
      if (opts.hill && x < -44) h = 14 * Math.tan((60 * Math.PI) / 180);
      heights[row * n + col] = h;
    }
  }
  const spawns = Array.from({ length: 8 }, (_, i) => ({
    x: Math.cos((i / 8) * Math.PI * 2) * 25,
    y: 0,
    z: Math.sin((i / 8) * Math.PI * 2) * 25 + 30,
  }));
  return {
    seed: 1,
    nameZh: '测试场',
    nameEn: 'Test Range',
    size: TEST_SIZE,
    res: TEST_RES,
    heights,
    waterLevel: WATER_LEVEL,
    props: [],
    colliders: testColliders(),
    lordSpawn: { x: 0, y: 0, z: 30 },
    spawns,
    lootSpots: [{ x: 5, y: 0, z: 40 }],
    crateSpots: [{ pos: { x: -5, y: 0, z: 40 }, tier: 1 }],
    camps: [{ pos: { x: -40, y: 0, z: -40 }, npcType: 'yellowTurban', count: 3, crateTier: 2 }],
    regions: [],
  };
}

export function makeInit(roles: RoleId[], heroes: string[] = [], patch: Partial<MatchSettings> = {}, humans: number[] = []): MatchInit {
  const settings: MatchSettings = { ...defaultSettings(), ...patch, playerCount: Math.min(8, Math.max(5, roles.length)) as 5 | 6 | 7 | 8 };
  return {
    settings,
    seed: 12345,
    seats: roles.map((role, i) => ({
      seat: i,
      playerId: humans.includes(i) ? `p${i}` : `bot-${i}`,
      name: `P${i}`,
      isBot: !humans.includes(i),
      role,
      heroId: heroes[i] ?? 'dummy',
    })),
  };
}

/** A hero-less-ability placeholder id: resolves to the generic fallback hero (no passives). */
export const DUMMY = 'dummy';

/** A quiet world on the test map: no ambient spawns, zone, airdrops, squads or nav unless asked. */
export function makeWorld(
  roles: RoleId[],
  opts: CreateMatchOptions & { heroes?: string[]; humans?: number[]; settings?: Partial<MatchSettings>; mapOpts?: TestMapOptions } = {},
): World {
  const { heroes, humans, settings, mapOpts, ...rest } = opts;
  return createWorld(makeInit(roles, heroes, settings, humans ?? roles.map((_, i) => i)), {
    map: makeTestMap(mapOpts),
    ambient: false,
    zone: false,
    airdrops: false,
    squads: false,
    nav: false,
    onWarn: () => {},
    ...rest,
  });
}

export function stepN(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

export function hero(w: World, seat: number): Entity {
  const e = w.heroList().find((h) => h.hero!.seat === seat);
  if (!e) throw new Error(`no hero at seat ${seat}`);
  return e;
}

/** Place an entity exactly (feet on the ground), zero velocity. */
export function place(w: World, e: Entity, x: number, z: number, yaw = 0): void {
  e.pos.x = x;
  e.pos.z = z;
  e.pos.y = w.groundHeight(x, z);
  e.vel.x = 0;
  e.vel.y = 0;
  e.vel.z = 0;
  e.yaw = yaw;
  e.onGround = true;
  e.forced = undefined;
  w.markGridDirty();
}
