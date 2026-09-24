// Fairness: bots only use what a human in their seat would know.
//  - static scan: no AI module except knowledge.ts reads hidden roles;
//  - public role-table arithmetic;
//  - spy test: swapping OTHER heroes' hidden roles leaves a bot's decisions
//    bit-identical (until something public differs).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputFrame, MatchSettings, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { aliveCrowns, realLordFor, roleKnownTo, tableKnowledge } from '../../../src/sim/ai/knowledge';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from '../sim/helpers';

const AI_DIR = join(__dirname, '../../../src/sim/ai');

describe('knowledge gate', () => {
  it('no AI module except knowledge.ts reads hidden roles or someone else’s bounty target', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(AI_DIR)) {
      if (!f.endsWith('.ts') || f === 'knowledge.ts') continue;
      const src = readFileSync(join(AI_DIR, f), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\broleOf\s*\(/.test(code) || /hero[!?]?\.role\b/.test(code) || /\.bountyTargetId\b/.test(code) || /roleRevealed/.test(code)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('crowns: the lord knows his 影武者, everyone else sees two lords', () => {
    const w = makeWorld(['lord', 'double', 'rebel', 'rebel', 'traitor'], { settings: { mode: 'chaos' } });
    const lord = hero(w, 0);
    const dbl = hero(w, 1);
    const rebel = hero(w, 2);
    expect(roleKnownTo(w, lord, dbl)).toBe('double');
    expect(roleKnownTo(w, rebel, dbl)).toBe('lord');
    expect(roleKnownTo(w, rebel, lord)).toBe('lord');
    expect(roleKnownTo(w, rebel, hero(w, 4))).toBeUndefined();
    expect(roleKnownTo(w, dbl, dbl)).toBe('double');
    expect(realLordFor(w, rebel)).toBeUndefined(); // two crowns: can't tell
    expect(realLordFor(w, dbl)).toBe(lord); // the decoy knows the other crown is real
    expect(aliveCrowns(w, rebel).length).toBe(2);
  });

  it('role table: counts of hidden roles among the unknown heroes follow the public table and the dead', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const w = makeWorld(roles);
    const viewer = hero(w, 1); // a loyalist
    let tk = tableKnowledge(w, viewer);
    expect(tk.unknownIds.length).toBe(6);
    expect(tk.unknown.rebel).toBeCloseTo(4);
    expect(tk.unknown.loyalist).toBeCloseTo(1);
    expect(tk.unknown.traitor).toBeCloseTo(1);
    // a rebel dies (role revealed): one fewer unknown rebel
    w.killHero(hero(w, 5), undefined);
    tk = tableKnowledge(w, viewer);
    expect(tk.unknownIds.length).toBe(5);
    expect(tk.unknown.rebel).toBeCloseTo(3);
    expect(tk.rebelsAlive).toBeCloseTo(3);
    // a rebel's view: the other rebels are just as hidden
    const tkR = tableKnowledge(w, hero(w, 3));
    expect(tkR.unknown.rebel).toBeCloseTo(2);
    expect(tkR.unknown.loyalist).toBeCloseTo(2);
  });

  it('乱世 with two possible deals averages over the consistent variants', () => {
    // 7p chaos: [lord, loyalist, double, rebel, rebel, bounty, traitor] or [lord, loyalist, double, rebel×3, traitor]
    const roles: RoleId[] = ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'bounty', 'traitor'];
    const w = makeWorld(roles, { settings: { mode: 'chaos' } });
    const tk = tableKnowledge(w, hero(w, 1));
    expect(tk.unknownIds.length).toBe(4);
    expect(tk.unknown.rebel).toBeCloseTo(2.5);
    expect(tk.unknown.bounty).toBeCloseTo(0.5);
    expect(tk.unknown.traitor).toBeCloseTo(1);
    // the bounty hunter knows its own card: only the first deal is possible
    const tkB = tableKnowledge(w, hero(w, 5));
    expect(tkB.unknown.rebel).toBeCloseTo(2);
    expect(tkB.unknown.bounty).toBeCloseTo(0);
  });
});

// ── spy test ────────────────────────────────────────────────────────────────
const SPY = 1;
const ROLES: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
const HEROES = ['caocao', 'guanyu', 'zhaoyun', 'lubu', 'machao', 'xuchu', 'ganning', 'huangzhong'];

function spyRun(roles: RoleId[], spySeat: number, ticks: number, settings: Partial<MatchSettings> = {}): { frames: string[]; bot: HeroBot; w: World } {
  let bot: HeroBot | undefined;
  const frames: string[] = [];
  const humans = roles.map((_, i) => i).filter((i) => i !== spySeat);
  const w = makeWorld(roles, {
    heroes: HEROES,
    humans,
    settings,
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      if (seat === spySeat) bot = b;
      return {
        think(sim, self, dt): InputFrame {
          const f = b.think(sim, self, dt);
          if (seat === spySeat) frames.push(JSON.stringify(f));
          return f;
        },
      };
    },
  });
  // everyone within sight of the spy
  roles.forEach((_, i) => {
    const a = (i / roles.length) * Math.PI * 2;
    place(w, hero(w, i), Math.cos(a) * 18, 30 + Math.sin(a) * 18);
  });
  const id = (seat: number): number => hero(w, seat).id;
  let seq = 1000;
  for (let t = 0; t < ticks; t++) {
    const time = t / 30;
    // scripted humans: walk in circles, claim, shoot, heal (identical in every run)
    for (const i of humans) {
      w.setInput(`p${i}`, { ...emptyInput(seq++), moveZ: 0.6, moveX: 0.3, yaw: time * 0.7 + i, actions: [] });
    }
    if (t === 60) w.setInput('p3', { ...emptyInput(seq++), actions: [{ a: 'claim', role: 'loyalist' }] });
    if (t === 75) w.setInput('p6', { ...emptyInput(seq++), actions: [{ a: 'claim', role: 'rebel' }] });
    if (t >= 90 && t < 180 && t % 15 === 0) w.dealDamage({ targetId: id(0), sourceId: id(4), amount: 6, type: 'normal', weaponId: 'pistol' });
    if (t === 200) w.heal(id(0), 20, id(7));
    if (t >= 240 && t < 300 && t % 20 === 0) w.dealDamage({ targetId: id(4), sourceId: id(2), amount: 5, type: 'normal', weaponId: 'pistol' });
    w.step();
    w.drainEvents();
  }
  return { frames, bot: bot!, w };
}

describe('spy test: bots never use hidden information', () => {
  it('swapping other heroes’ hidden roles leaves the bot’s decisions identical', () => {
    const TICKS = 480;
    const base = spyRun(ROLES, SPY, TICKS);
    // the scenario is not trivial: the spy perceived evidence and acted on it
    expect(base.frames.length).toBe(TICKS);
    expect(base.bot.beliefs.evidence(hero(base.w, 4).id).anti).toBeGreaterThan(0.5);
    expect(new Set(base.frames).size).toBeGreaterThan(50);
    expect(base.w.heroList().every((h) => !h.hero!.dead)).toBe(true); // no reveal happened
    // swap a rebel with the traitor, and the other loyalist with a rebel
    const swaps: [number, number][] = [
      [5, 7],
      [2, 3],
      [6, 4],
    ];
    for (const [a, b] of swaps) {
      const roles = [...ROLES];
      [roles[a], roles[b]] = [roles[b], roles[a]];
      const other = spyRun(roles, SPY, TICKS);
      expect(other.w.heroList().every((h) => !h.hero!.dead)).toBe(true);
      let firstDiff = -1;
      for (let i = 0; i < TICKS; i++) {
        if (other.frames[i] !== base.frames[i]) {
          firstDiff = i;
          break;
        }
      }
      expect(firstDiff, `swap ${a}<->${b} changed the spy's frame at tick ${firstDiff}`).toBe(-1);
    }
  }, 60_000);

  it('the lord may use his knowledge of the 影武者, but nothing more', () => {
    const roles: RoleId[] = ['lord', 'double', 'loyalist', 'rebel', 'rebel', 'bounty', 'traitor', 'opportunist'];
    const TICKS = 300;
    const base = spyRun(roles, 0, TICKS, { mode: 'chaos' });
    const swapped = [...roles];
    [swapped[3], swapped[6]] = [swapped[6], swapped[3]];
    [swapped[2], swapped[7]] = [swapped[7], swapped[2]];
    const other = spyRun(swapped, 0, TICKS, { mode: 'chaos' });
    expect(other.frames).toEqual(base.frames);
  }, 60_000);
});
