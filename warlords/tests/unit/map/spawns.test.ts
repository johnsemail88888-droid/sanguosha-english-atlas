// APP-8: heroes must not start next to each other. The ring spawns keep 55 m
// between them (36 m only as a fallback), and the world hands the 7 non-lord
// seats the spawns farthest from the palace and from each other.
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES } from '../../../src/data';
import { generateMap } from '../../../src/sim/map/generate';
import { SPAWN_SEPARATION, SPAWN_SEPARATION_MIN } from '../../../src/sim/map/spots';
import { createWorld } from '../../../src/sim/world';

const ROLES8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
const map = generateMap(defaultSettings().mapSeed);

function minPair(ps: { x: number; z: number }[]): number {
  let m = Infinity;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.min(m, Math.hypot(ps[i].x - ps[j].x, ps[i].z - ps[j].z));
  return m;
}

describe('hero spawn spacing (APP-8)', () => {
  it('ring spawns are ≥ 55 m apart (never closer than the 36 m fallback)', () => {
    expect(map.spawns.length).toBeGreaterThanOrEqual(8);
    expect(minPair(map.spawns)).toBeGreaterThanOrEqual(SPAWN_SEPARATION_MIN);
    // the fallback is rare: at most one pair of the ring is under 55 m
    let close = 0;
    for (let i = 0; i < map.spawns.length; i++) for (let j = i + 1; j < map.spawns.length; j++) if (Math.hypot(map.spawns[i].x - map.spawns[j].x, map.spawns[i].z - map.spawns[j].z) < SPAWN_SEPARATION) close++;
    expect(close).toBeLessThanOrEqual(1);
  });

  it('seeds 1..20, 8 seats: the minimum pairwise hero spawn distance is ≥ 55 m', () => {
    const settings = { ...defaultSettings(), playerCount: 8 as const };
    const ids = HEROES.map((h) => h.id);
    let worst = Infinity;
    for (let seed = 1; seed <= 20; seed++) {
      const w = createWorld(
        {
          settings,
          seed,
          seats: ROLES8.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `B${i}`, isBot: true, role, heroId: ids[(seed * 3 + i) % ids.length] })),
        },
        { map, ambient: false, zone: false, airdrops: false, squads: false, nav: false, onWarn: () => {} },
      );
      const d = minPair(w.heroList().map((h) => h.pos));
      worst = Math.min(worst, d);
      expect(d, `seed ${seed}`).toBeGreaterThanOrEqual(55);
    }
    process.stdout.write(`[spawns] min pairwise hero spawn distance over seeds 1..20: ${worst.toFixed(1)} m\n`);
  });
});
