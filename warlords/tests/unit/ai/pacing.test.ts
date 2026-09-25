// G4 pacing behaviours in isolation (the full-match numbers live in matches.test.ts and the
// opt-in sample.test.ts): the rebels share one push time per table, late in the match; the 主公
// braces (closes in on his escort, calls 救我) when strangers gather around him; a rebel does
// not finish a hero it has no strong loyal read on before its push.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, RoleId } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { DIFFICULTY_PROFILES } from '../../../src/sim/ai/difficulty';
import { teamPushAt } from '../../../src/sim/ai/strategy';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from '../sim/helpers';

const STD8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function setTime(w: World, seconds: number): void {
  w.tick = Math.round(seconds * 30);
  w.time = w.tick / 30;
}

function world(roles: RoleId[], bots: number[], heroes: string[]): { w: World; bot: (seat: number) => HeroBot } {
  const made = new Map<number, HeroBot>();
  const w = makeWorld(roles, {
    heroes,
    humans: roles.map((_, i) => i).filter((i) => !bots.includes(i)),
    ambient: false,
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      made.set(seat, b);
      return b;
    },
  });
  return { w, bot: (seat) => made.get(seat)! };
}

function run(w: World, ticks: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    w.step();
    out.push(...w.drainEvents());
  }
  return out;
}

type Strat = { strategy: { pushAt: number } };
const pushAt = (b: HeroBot): number => (b as unknown as Strat).strategy.pushAt;

describe('rebel push timing', () => {
  it('all rebels of a table plan the same late push (lootPhase + 285..395 s, + a few seconds each)', () => {
    const heroes = ['caocao', 'guanyu', 'zhangfei', 'lubu', 'machao', 'zhaoyun', 'huangzhong', 'xuchu'];
    const { w, bot } = world(STD8, [3, 4, 5, 6], heroes);
    STD8.forEach((_, i) => place(w, hero(w, i), i * 12 - 50, 60));
    w.step();
    const n = DIFFICULTY_PROFILES.normal;
    const team = teamPushAt(w, n);
    expect(team).toBeGreaterThanOrEqual(n.lootPhase + 285);
    expect(team).toBeLessThanOrEqual(n.lootPhase + 395);
    const times = [3, 4, 5, 6].map((s) => pushAt(bot(s)));
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(team);
      expect(t).toBeLessThanOrEqual(team + 20);
    }
    // the decisive push is in the second half of an 8–12 minute match (≥ 6:40 on normal)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(400);
  });

  it('the shared time differs from table to table (seeded by seats and heroes)', () => {
    const n = DIFFICULTY_PROFILES.normal;
    const seen = new Set<number>();
    const pool = ['caocao', 'guanyu', 'zhangfei', 'lubu', 'machao', 'zhaoyun', 'huangzhong', 'xuchu', 'diaochan', 'zhenji'];
    for (let k = 0; k < 6; k++) {
      const heroes = STD5.map((_, i) => pool[(i + k) % pool.length]);
      const w = makeWorld(STD5, { heroes, ambient: false });
      seen.add(Math.round(teamPushAt(w, n)));
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('lord brace', () => {
  it('two strangers loitering around him: he closes in on his loyalist and calls 救我', () => {
    const { w, bot } = world(STD5, [0], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    lord.maxHp = lord.hp = 1e4;
    place(w, lord, 0, 30, 0);
    place(w, loyal, 26, 30);
    // two strangers 45 m out, standing still (the rebels' staging ring)
    place(w, hero(w, 2), -44, 30);
    place(w, hero(w, 3), -40, 38);
    place(w, hero(w, 4), 60, -60);
    setTime(w, 250); // after the camp phase
    const d0 = Math.hypot(lord.pos.x - loyal.pos.x, lord.pos.z - loyal.pos.z);
    const evs = run(w, 30 * 6);
    expect(bot(0).mode).toBe('guard');
    const d1 = Math.hypot(lord.pos.x - loyal.pos.x, lord.pos.z - loyal.pos.z);
    expect(d1).toBeLessThan(d0 - 8);
    expect(evs.some((e) => e.t === 'quickchat' && e.who === lord.id && e.id === 'help')).toBe(true);
  }, 30_000);
});

describe('rebel mercy', () => {
  function duel(ls: 'unknown' | 'loyal'): { w: World; me: Entity; x: Entity; bot: HeroBot } {
    const { w, bot } = world(STD8, [3], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const me = hero(w, 3);
    const x = hero(w, ls === 'loyal' ? 1 : 4);
    place(w, me, 0, 30, 0);
    place(w, x, 0, 18);
    STD8.forEach((_, i) => {
      if (i !== 3 && hero(w, i) !== x) place(w, hero(w, i), -60 + i * 4, -60);
    });
    setTime(w, 200);
    w.step();
    return { w, me, x, bot: bot(3) };
  }

  it('mid-game, a hero on its knees that it has no strong loyal read on is left alone', () => {
    const { w, x, bot } = duel('unknown');
    x.hp = x.maxHp * 0.2;
    // it shot first, so the rebel fights back — but does not execute
    expect(bot.beliefs.lordSideness(w, bot.self, x)).toBeLessThan(0.6);
    expect((bot as unknown as { mercy(t: Entity): boolean }).mercy(x)).toBe(true);
    x.hp = x.maxHp * 0.9;
    expect((bot as unknown as { mercy(t: Entity): boolean }).mercy(x)).toBe(false);
  });
});
