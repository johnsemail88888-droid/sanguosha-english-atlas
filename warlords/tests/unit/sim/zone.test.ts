import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { HARD_CAP_TIME } from '../../../src/sim/rules';
import { ZONE_CLOSED_AT, ZONE_PHASES, Zone, zonePhaseStart } from '../../../src/sim/zone';
import { hero, makeWorld, place } from './helpers';

describe('烽火圈 zone schedule', () => {
  it('follows the phase table (wait → shrink → next radius, dps per phase)', () => {
    const z = new Zone(new Rng(1), 900);
    const at = (t: number) => {
      z.update(t);
      return { r: z.radius, dps: z.dps, phase: z.phase };
    };
    expect(at(0)).toEqual({ r: 230, dps: 0, phase: 0 });
    expect(at(149)).toEqual({ r: 230, dps: 0, phase: 0 });
    expect(at(150).phase).toBe(1);
    expect(at(187.5).r).toBeCloseTo(195, 5); // halfway 230 → 160
    expect(at(187.5).dps).toBe(4);
    const p2 = at(225);
    expect(p2.phase).toBe(2);
    expect(p2.r).toBeCloseTo(160, 5);
    expect(at(299).r).toBeCloseTo(160, 5); // 75 s wait
    expect(at(360).r).toBeCloseTo(100, 5);
    expect(at(360).dps).toBe(15); // phase 3 begins at 360
    expect(at(465).r).toBeCloseTo(55, 5);
    expect(at(550).r).toBeCloseTo(25, 5);
    expect(at(595).r).toBeCloseTo(25, 5); // last wait
    expect(at(617.5).r).toBeCloseTo(12.5, 5);
    expect(at(640).r).toBeCloseTo(0, 5);
    expect(at(800)).toMatchObject({ r: 0, dps: 60, phase: 5 });
  });

  it('shrink timing matches the table exactly: the circle closes at 10:40, well before the 15:00 cap', () => {
    let t = 0;
    const starts: number[] = [];
    for (const p of ZONE_PHASES) {
      starts.push(t);
      t += p.wait + p.shrink;
    }
    expect(starts).toEqual([0, 150, 225, 360, 465, 550]);
    expect(t).toBe(640);
    expect(ZONE_CLOSED_AT).toBe(640);
    expect(zonePhaseStart(3)).toBe(360);
    // 8–12 minute matches: closed between 10:30 and 11:00, the hard cap (15:00) is only a backstop
    expect(ZONE_CLOSED_AT).toBeGreaterThanOrEqual(630);
    expect(ZONE_CLOSED_AT).toBeLessThanOrEqual(660);
    expect(ZONE_CLOSED_AT).toBeLessThan(HARD_CAP_TIME);
  });

  it('every next circle lies inside the current one (many seeds)', () => {
    for (let seed = 1; seed < 200; seed++) {
      const z = new Zone(new Rng(seed), 900);
      let prevC = { ...z.targetCenter };
      let prevR = z.targetRadius;
      for (let t = 0; t <= 660; t += 5) {
        z.update(t);
        if (z.targetRadius !== prevR) {
          const d = Math.hypot(z.targetCenter.x - prevC.x, z.targetCenter.z - prevC.z);
          expect(d + z.targetRadius).toBeLessThanOrEqual(prevR + 1e-6);
          prevC = { ...z.targetCenter };
          prevR = z.targetRadius;
        }
      }
    }
  });

  it('centers are biased toward the map center', () => {
    let sum = 0;
    const n = 300;
    for (let seed = 1; seed <= n; seed++) {
      const z = new Zone(new Rng(seed * 7), 900);
      z.update(300);
      sum += Math.hypot(z.targetCenter.x, z.targetCenter.z);
    }
    // unbiased uniform sampling would average well above this
    expect(sum / n).toBeLessThan(60);
  });

  it('15:00 hard cap collapses the zone to 0 and escalates damage', () => {
    const z = new Zone(new Rng(3), 900);
    z.update(899);
    const ch = z.update(900);
    expect(ch).not.toBeNull();
    expect(z.capped).toBe(true);
    z.update(910);
    expect(z.radius).toBeCloseTo(0, 5);
    const d1 = z.dps;
    z.update(930);
    expect(z.dps).toBeGreaterThan(d1);
  });

  it('damages units outside once per second with type zone', () => {
    const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor'], { zone: true });
    const e = hero(w, 2);
    // fast-forward into phase 3 (dps 15) and stand far outside
    while (w.time < zonePhaseStart(3) + 10) w.step();
    const z = w.zoneView();
    const dx = z.center.x > 0 ? -1 : 1;
    place(w, e, dx * 58, z.center.z > 0 ? -58 : 58);
    for (const i of [0, 1, 3, 4]) place(w, hero(w, i), z.center.x, z.center.z + i);
    expect(Math.hypot(e.pos.x - z.center.x, e.pos.z - z.center.z)).toBeGreaterThan(z.radius);
    e.hp = e.maxHp;
    w.drainEvents();
    for (let i = 0; i < 60; i++) w.step();
    const hits = w.drainEvents().filter((ev) => ev.t === 'hit' && ev.target === e.id);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.t === 'hit' && h.dtype === 'zone' && h.amount === w.zoneView().dps)).toBe(true);
    expect(e.maxHp - e.hp).toBeCloseTo(2 * w.zoneView().dps, 5);
    // the others inside are untouched
    expect(hero(w, 0).hp).toBe(hero(w, 0).maxHp);
  });
});
