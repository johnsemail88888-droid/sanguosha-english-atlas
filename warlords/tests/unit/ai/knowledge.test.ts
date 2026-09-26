// Fairness: bots only use what a human in their seat would know.
//  - static scan: no AI module except knowledge.ts reads hidden roles;
//  - public role-table arithmetic;
//  - spy test: swapping OTHER heroes' hidden roles leaves a bot's decisions
//    bit-identical (until something public differs);
//  - sight spy test: a hero the bot cannot see (stealthed, or beyond its vision)
//    moving around and fighting someone else leaves its decisions bit-identical,
//    and nothing about that fight reaches its evidence.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entity, InputFrame, MatchSettings, RoleId } from '../../../src/core/types';
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
    // 8p chaos: [lord, loyalist, double, rebel×3, bounty, traitor] or [lord, loyalist, double, rebel×3, opportunist, traitor]
    const roles: RoleId[] = ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'rebel', 'bounty', 'traitor'];
    const w = makeWorld(roles, { settings: { mode: 'chaos' } });
    const tk = tableKnowledge(w, hero(w, 1));
    expect(tk.unknownIds.length).toBe(5);
    expect(tk.unknown.rebel).toBeCloseTo(3);
    expect(tk.unknown.bounty).toBeCloseTo(0.5);
    expect(tk.unknown.opportunist).toBeCloseTo(0.5);
    expect(tk.unknown.traitor).toBeCloseTo(1);
    // the bounty hunter knows its own card: only the first deal is possible
    const tkB = tableKnowledge(w, hero(w, 6));
    expect(tkB.unknown.rebel).toBeCloseTo(3);
    expect(tkB.unknown.bounty).toBeCloseTo(0);
    expect(tkB.unknown.opportunist).toBeCloseTo(0);
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
  // everyone within sight of the spy; nobody can die (a death would reveal a role)
  roles.forEach((_, i) => {
    const a = (i / roles.length) * Math.PI * 2;
    const h = hero(w, i);
    place(w, h, Math.cos(a) * 18, 30 + Math.sin(a) * 18);
    h.maxHp = 1e5;
    h.hp = 1e5;
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
    expect(base.bot.beliefs.evidence(hero(base.w, 4).id).anti).toBeGreaterThan(0.3);
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

// ── sight spy test ──────────────────────────────────────────────────────────
// The spy is a bot 主公 camping at the palace (0, 30); everyone else is a
// scripted human. U (a rebel) fights V (the traitor, far away) — U either
// hidden by stealth ~30 m from the lord, or beyond the lord's vision. Whether U
// stands still or walks around must not change a single frame of the spy.
const SIGHT_ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const U = 2;
const V = 4;

interface SightRun {
  frames: string[];
  bot: HeroBot;
  w: World;
}

function sightRun(opts: { stealth: boolean; uAt: [number, number]; uWalks: boolean }): SightRun {
  let bot: HeroBot | undefined;
  const frames: string[] = [];
  const humans = [1, 2, 3, 4];
  const w = makeWorld(SIGHT_ROLES, {
    heroes: ['caocao', 'guanyu', 'machao', 'lubu', 'huangzhong'],
    humans,
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      if (seat === 0) bot = b;
      return {
        think(sim, self, dt): InputFrame {
          const f = b.think(sim, self, dt);
          if (seat === 0) frames.push(JSON.stringify(f));
          return f;
        },
      };
    },
  });
  const h = (s: number): Entity => hero(w, s);
  for (let i = 0; i < SIGHT_ROLES.length; i++) {
    h(i).maxHp = 1e5;
    h(i).hp = 1e5;
  }
  place(w, h(0), 0, 30);
  place(w, h(1), -48, 52); // a far loyalist, standing still
  place(w, h(3), 52, 55); // a far rebel, standing still
  place(w, h(V), 48, -50); // the victim: far from the lord, out of his sight
  place(w, h(U), opts.uAt[0], opts.uAt[1]);
  if (opts.stealth) w.applyStatus(h(U).id, 'stealth', 999, { params: { keep: 1 } });
  let seq = 5000;
  for (let t = 0; t < 360; t++) {
    const time = t / 30;
    for (const i of humans) {
      const walk = i === U && opts.uWalks;
      w.setInput(`p${i}`, { ...emptyInput(seq++), moveZ: walk ? 0.8 : 0, moveX: 0, yaw: walk ? time * 1.5 : 0, actions: [] });
    }
    // U shoots V (identical damage in every run: no dodge, no weapon specials, no RNG)
    if (t >= 60 && t % 12 === 0) w.dealDamage({ targetId: h(V).id, sourceId: h(U).id, amount: 9, type: 'normal', canDodge: false });
    w.step();
    w.drainEvents();
  }
  return { frames, bot: bot!, w };
}

function firstDiff(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe('sight spy test: bots never use positions or fights they cannot see', () => {
  it('a stealthed hero moving and fighting ~30 m away leaves the bot’s frames identical', () => {
    const still = sightRun({ stealth: true, uAt: [-26, 8], uWalks: false });
    const walks = sightRun({ stealth: true, uAt: [-26, 8], uWalks: true });
    expect(still.frames.length).toBe(360);
    expect(new Set(still.frames).size).toBeGreaterThan(30); // the lord is doing things
    // U really moved in the second run, and really hurt V in both
    expect(Math.hypot(hero(walks.w, U).pos.x + 26, hero(walks.w, U).pos.z - 8)).toBeGreaterThan(1);
    expect(hero(still.w, V).hp).toBeLessThan(1e5);
    expect(firstDiff(still.frames, walks.frames), 'the stealthed hero leaked into the spy').toBe(-1);
    // nothing about the fight reached the lord
    const u = hero(still.w, U).id;
    const v = hero(still.w, V).id;
    expect(still.bot.obs.sinceAttack(still.w, u, v)).toBe(Infinity);
    expect(still.bot.beliefs.evidenceMagnitude(u)).toBe(0);
    expect(still.bot.sight.get(u)).toBeUndefined();
  }, 60_000);

  it('a hero beyond vision range moving and fighting leaves the bot’s frames identical', () => {
    const still = sightRun({ stealth: false, uAt: [52, -40], uWalks: false });
    const walks = sightRun({ stealth: false, uAt: [52, -40], uWalks: true });
    expect(firstDiff(still.frames, walks.frames), 'a far hero leaked into the spy').toBe(-1);
    const u = hero(still.w, U).id;
    expect(still.bot.obs.sinceAttack(still.w, u, hero(still.w, V).id)).toBe(Infinity);
    expect(still.bot.sight.get(u)).toBeUndefined();
  }, 60_000);

  it('control: the same fight in plain sight is perceived (the test is sensitive)', () => {
    const seen = sightRun({ stealth: false, uAt: [-26, 8], uWalks: false });
    const u = hero(seen.w, U).id;
    expect(seen.bot.sight.seenWithin(u, 1)).toBe(true);
    expect(seen.bot.obs.sinceAttack(seen.w, u, hero(seen.w, V).id)).toBeLessThan(2);
    const walks = sightRun({ stealth: false, uAt: [-26, 8], uWalks: true });
    expect(firstDiff(seen.frames, walks.frames)).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
