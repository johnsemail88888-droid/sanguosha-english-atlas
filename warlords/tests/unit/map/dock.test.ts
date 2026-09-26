// 赤壁渡口: the dock planks run out to the moored warships' hulls. There used to be
// a 1.6 m slot of water between the north dock (z 74–78) and the hull (z 79.6):
// walking +z from (35, 76) dropped a hero onto the river bed 2.4 m below the deck,
// hull in front, nothing to climb — stuck for good (G4-7).
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { defaultSettings, emptyInput } from '../../../src/core/types';
import { generateMap } from '../../../src/sim/map/generate';
import { isInWater } from '../../../src/sim/physics';
import { createWorld } from '../../../src/sim/world';
import type { World } from '../../../src/sim/world';

const map = generateMap(defaultSettings().mapSeed);
const ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function walker(): { w: World; walk: (x: number, z: number, yaw: number, seconds: number) => { y: number; z: number; water: number; waterRun: number; maxWaterRun: number } } {
  const w = createWorld(
    { settings: { ...defaultSettings(), playerCount: 5 }, seed: 1, seats: ROLES.map((role, i) => ({ seat: i, playerId: `p${i}`, name: `P${i}`, isBot: false, role, heroId: 'dummy' })) },
    { map, ambient: false, zone: false, airdrops: false, squads: false, nav: false, onWarn: () => {} },
  );
  const e = w.heroList()[2];
  let seq = 1;
  return {
    w,
    walk(x, z, yaw, seconds) {
      e.pos.x = x;
      e.pos.z = z;
      e.pos.y = w.groundHeight(x, z);
      e.vel.x = e.vel.y = e.vel.z = 0;
      for (let i = 0; i < 6; i++) {
        w.setInput('p2', { ...emptyInput(seq++), yaw, moveZ: 0 });
        w.step();
      }
      let water = 0;
      let run = 0;
      let maxRun = 0;
      let wz = 0;
      for (let i = 0; i < seconds * 30; i++) {
        w.setInput('p2', { ...emptyInput(seq++), yaw, moveZ: 1 });
        w.step();
        if (isInWater(w.cw, e.pos)) {
          water++;
          if (run === 0) wz = e.pos.z;
          run++;
          // distance covered since entering the water
          maxRun = Math.max(maxRun, Math.abs(e.pos.z - wz));
        } else run = 0;
      }
      return { y: e.pos.y, z: e.pos.z, water, waterRun: run, maxWaterRun: maxRun };
    },
  };
}

describe('赤壁渡口 dock ↔ warship gap', () => {
  const docks = map.props.filter((p) => p.type === 'dock');
  const ships = map.props.filter((p) => p.type === 'ship');

  it('every moored ship lies flush against its dock (no water slot between planks and hull)', () => {
    expect(docks.length).toBe(2);
    expect(ships.length).toBe(3);
    for (const s of ships) {
      const d = docks.reduce((a, b) => (Math.abs(b.z - s.z) < Math.abs(a.z - s.z) ? b : a));
      const gap = Math.abs(s.z - d.z) - s.sz / 2 - d.sz / 2;
      expect(gap, `ship at x ${s.x}`).toBeLessThan(0.05);
      expect(gap).toBeGreaterThan(-0.05); // touching, not overlapping the hull
      // the ship's length lies along the dock
      expect(s.x - s.sx / 2).toBeGreaterThanOrEqual(d.x - d.sx / 2 - 0.01);
      expect(s.x + s.sx / 2).toBeLessThanOrEqual(d.x + d.sx / 2 + 0.01);
    }
  });

  it('walking +z from (35, 76) never ends in the water: it stops at the hull on the planks', () => {
    const { walk } = walker();
    const r = walk(35, 76, Math.PI, 6);
    expect(r.water).toBe(0);
    expect(r.y).toBeCloseTo(map.waterLevel + 1.25, 1); // still on the dock deck
  });

  it('all along both docks: walking toward the ship stays dry, and the gangplanks reach the decks', () => {
    const { walk } = walker();
    for (const s of ships) {
      const d = docks.reduce((a, b) => (Math.abs(b.z - s.z) < Math.abs(a.z - s.z) ? b : a));
      const toShip = s.z > d.z ? Math.PI : 0; // yaw: π walks +z, 0 walks -z
      const startZ = d.z + (s.z > d.z ? -1 : 1);
      for (let x = s.x - s.sx / 2 + 0.8; x <= s.x + s.sx / 2 - 0.8; x += 1.7) {
        const r = walk(x, startZ, toShip, 4);
        // in the water at most briefly (a hero pushed off an end) and never stuck there
        expect(r.waterRun, `x ${x.toFixed(1)}`).toBe(0);
        expect(r.maxWaterRun).toBeLessThanOrEqual(3);
      }
      // the gangplank at the ship's middle: up onto the deck
      const g = walk(s.x, startZ, toShip, 4);
      expect(g.y, `gangplank of the ship at x ${s.x}`).toBeCloseTo(s.y, 1);
      expect(g.water).toBe(0);
    }
  });
});
