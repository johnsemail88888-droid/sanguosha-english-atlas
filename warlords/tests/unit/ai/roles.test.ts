// Role scenario tests (身份局 strategies), quick-chat / claims, reactions to
// human quick-chat, and camp NPCs (guard, chase briefly, leash home).
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, InputAction, MatchSettings, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const DOUBLE5: RoleId[] = ['lord', 'double', 'rebel', 'rebel', 'traitor'];

function setTime(w: World, seconds: number): void {
  w.tick = Math.round(seconds * 30);
  w.time = w.tick / 30;
}

/** A quiet test-map world where `bots` are HeroBots and everyone else is a (scripted) human. */
function world(
  roles: RoleId[],
  bots: number[],
  heroes: string[],
  opts: { settings?: Partial<MatchSettings>; ambient?: boolean } = {},
): { w: World; bot: (seat: number) => HeroBot } {
  const made = new Map<number, HeroBot>();
  const w = makeWorld(roles, {
    heroes,
    humans: roles.map((_, i) => i).filter((i) => !bots.includes(i)),
    settings: opts.settings,
    ambient: opts.ambient ?? false,
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      made.set(seat, b);
      return b;
    },
  });
  return { w, bot: (seat) => made.get(seat)! };
}

/** Make a hero effectively unkillable (no role reveal can happen by accident). */
function tough(e: Entity): void {
  e.maxHp = 1e4;
  e.hp = 1e4;
}

let seq = 10_000;
function act(w: World, seat: number, actions: InputAction[], extra: Partial<ReturnType<typeof emptyInput>> = {}): void {
  w.setInput(`p${seat}`, { ...emptyInput(seq++), ...extra, actions });
}

/** Step and collect events. */
function run(w: World, ticks: number, each?: (t: number) => void): GameEvent[] {
  const out: GameEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    each?.(t);
    w.step();
    out.push(...w.drainEvents());
  }
  return out;
}

const chats = (evs: GameEvent[], who: number, id: string): number => evs.filter((e) => e.t === 'quickchat' && e.who === who && e.id === id).length;

// ── 内奸 ────────────────────────────────────────────────────────────────────
describe('traitor (内奸)', () => {
  it('saves a lord on his knees from the rebel hitting him (rebels must not win yet)', () => {
    const { w, bot } = world(STD5, [4], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const rebel = hero(w, 2);
    const me = hero(w, 4);
    tough(lord);
    tough(rebel);
    lord.hp = lord.maxHp * 0.3;
    place(w, lord, 0, 30);
    place(w, rebel, 0, 14);
    place(w, me, 14, 36);
    place(w, hero(w, 1), -50, -52);
    place(w, hero(w, 3), -40, -52);
    setTime(w, 150);
    run(w, 30 * 8, (t) => {
      if (t % 10 === 0) w.dealDamage({ targetId: lord.id, sourceId: rebel.id, amount: 8, type: 'normal', canDodge: false });
    });
    expect(bot(4).target?.id).toBe(rebel.id);
    expect(rebel.hp).toBeLessThan(rebel.maxHp);
    expect(lord.hp).toBeGreaterThan(0);
  });

  it('duels the lord once only the crown is left, from full health', () => {
    const { w, bot } = world(STD5, [4], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    tough(lord);
    place(w, lord, 0, 30);
    place(w, hero(w, 4), 0, 50);
    setTime(w, 200);
    for (const s of [1, 2, 3]) w.killHero(hero(w, s), undefined);
    run(w, 30 * 10);
    expect(bot(4).target?.id).toBe(lord.id);
    expect(lord.hp).toBeLessThan(lord.maxHp);
  });

  it('two crowns in the endgame: the 影武者 dies first — the lord gave himself away with a lord skill', () => {
    const { w, bot } = world(DOUBLE5, [4], ['caocao', 'zhaoyun', 'guanyu', 'guanyu', 'machao'], { settings: { mode: 'chaos' } });
    const lord = hero(w, 0);
    const dbl = hero(w, 1);
    tough(lord);
    tough(dbl);
    place(w, lord, 0, 30);
    place(w, dbl, 14, 30);
    place(w, hero(w, 4), 6, 52);
    setTime(w, 200);
    for (const s of [2, 3]) w.killHero(hero(w, s), undefined);
    run(w, 30 * 10, (t) => {
      if (t === 5) act(w, 0, [{ a: 'ability', slot: 'lord' }]);
    });
    const b = bot(4);
    expect(b.beliefs.crownLordTell(lord.id)).toBeGreaterThan(0);
    expect(b.hostility(dbl)).toBeGreaterThan(b.hostility(lord));
    expect(b.target?.id).toBe(dbl.id);
    expect(dbl.hp).toBeLessThan(dbl.maxHp);
  });
});

// ── neutrals ────────────────────────────────────────────────────────────────
describe('opportunist (墙头草) and bounty hunter (赏金猎人)', () => {
  const OPP5: RoleId[] = ['lord', 'loyalist', 'rebel', 'opportunist', 'traitor'];

  it('the opportunist stays out of other people’s fights', () => {
    const { w } = world(OPP5, [3], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], { settings: { mode: 'chaos' } });
    const me = hero(w, 3);
    const a = hero(w, 2);
    const b = hero(w, 4);
    tough(a);
    tough(b);
    place(w, me, 0, 30);
    place(w, a, -8, 16);
    place(w, b, 8, 16);
    place(w, hero(w, 0), -50, -52);
    place(w, hero(w, 1), -40, -52);
    setTime(w, 200);
    const d0 = Math.hypot(me.pos.x, me.pos.z - 16);
    run(w, 30 * 10, (t) => {
      if (t % 8 === 0) {
        w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 10, type: 'normal', canDodge: false });
        w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'normal', canDodge: false });
      }
    });
    expect(me.hero!.stats.damage).toBe(0);
    expect(Math.hypot(me.pos.x, me.pos.z - 16)).toBeGreaterThan(d0);
  });

  it('the opportunist finishes a downed hero when nobody is around to punish it', () => {
    const { w } = world(OPP5, [3], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], { settings: { mode: 'chaos' } });
    const me = hero(w, 3);
    const prey = hero(w, 2);
    place(w, me, 0, 30);
    place(w, prey, 0, 18);
    place(w, hero(w, 0), -50, -52);
    place(w, hero(w, 1), -40, -52);
    place(w, hero(w, 4), -30, -52);
    setTime(w, 200);
    w.step();
    w.dealDamage({ targetId: prey.id, amount: 1e4, type: 'true' });
    expect(prey.hero!.downed).toBe(true);
    run(w, 30 * 10);
    expect(prey.hero!.dead).toBe(true);
    expect(prey.hero!.killerId).toBe(me.id);
  });

  it('the bounty hunter only hunts a target it has seen — never walks to where it cannot know it is', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'bounty', 'traitor'];
    const { w, bot } = world(roles, [4], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], { settings: { mode: 'chaos' } });
    const me = hero(w, 4);
    const tid = me.hero!.bountyTargetId!;
    expect(tid).toBeDefined();
    const target = w.get(tid)!;
    tough(target);
    // everyone far and out of sight; the target in the opposite corner
    place(w, me, -50, -50);
    const others = roles.map((_, i) => i).filter((i) => i !== 4 && hero(w, i).id !== tid);
    others.forEach((s, i) => place(w, hero(w, s), -52 + i * 3, 56));
    place(w, target, 52, 52);
    setTime(w, 200);
    const modes = new Set<string>();
    run(w, 30 * 12, () => modes.add(bot(4).mode));
    expect(modes.has('hunt')).toBe(false);
    expect(bot(4).sight.get(tid)).toBeUndefined();
    // now it walks into plain sight, alone: the hunt is on
    place(w, target, me.pos.x + 26, me.pos.z + 4);
    const hunted = new Set<string>();
    run(w, 30 * 6, () => hunted.add(bot(4).mode));
    expect(bot(4).target?.id === tid || hunted.has('hunt')).toBe(true);
  });
});

// ── 影武者 and crowns in 乱世 ─────────────────────────────────────────────────
describe('乱世 crowns', () => {
  it('the 影武者 escorts the real lord', () => {
    const { w } = world(DOUBLE5, [1], ['caocao', 'zhaoyun', 'guanyu', 'guanyu', 'guanyu'], { settings: { mode: 'chaos' } });
    const lord = hero(w, 0);
    const me = hero(w, 1);
    place(w, lord, 0, 30);
    place(w, me, -40, -40);
    [2, 3, 4].forEach((s, i) => place(w, hero(w, s), 40 + i * 4, -50));
    setTime(w, 150);
    run(w, 30 * 25);
    expect(Math.hypot(me.pos.x - lord.pos.x, me.pos.z - lord.pos.z)).toBeLessThan(22);
  }, 30_000);

  it('pushing rebels focus the crown they saw cast a lord skill, not the decoy', () => {
    const { w, bot } = world(DOUBLE5, [2, 3], ['caocao', 'zhaoyun', 'guanyu', 'machao', 'huangzhong'], { settings: { mode: 'chaos' } });
    const lord = hero(w, 0);
    const dbl = hero(w, 1);
    tough(lord);
    tough(dbl);
    place(w, lord, 0, 30);
    place(w, dbl, 14, 30);
    place(w, hero(w, 2), -6, 54);
    place(w, hero(w, 3), 10, 54);
    place(w, hero(w, 4), -50, -52);
    setTime(w, 320);
    let onLord = 0;
    let onDouble = 0;
    const evs = run(w, 30 * 12, (t) => {
      if (t === 3) act(w, 0, [{ a: 'ability', slot: 'lord' }]);
    });
    for (const e of evs) {
      if (e.t !== 'hit' || e.amount <= 0 || (e.src !== hero(w, 2).id && e.src !== hero(w, 3).id)) continue;
      if (e.target === lord.id) onLord += e.amount;
      if (e.target === dbl.id) onDouble += e.amount;
    }
    expect(bot(2).beliefs.crownLordTell(lord.id)).toBeGreaterThan(0);
    expect(bot(2).target?.id).toBe(lord.id);
    expect(bot(3).target?.id).toBe(lord.id);
    expect(onLord).toBeGreaterThan(onDouble);
  }, 30_000);
});

// ── the lord ────────────────────────────────────────────────────────────────
describe('lord (主公)', () => {
  it('never stands still for long next to his escort', () => {
    const { w } = world(STD5, [0], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    place(w, lord, 0, 30);
    place(w, loyal, 6, 34);
    [2, 3, 4].forEach((s, i) => place(w, hero(w, s), -50 + i * 5, -52));
    setTime(w, 250);
    // the loyalist earns trust in plain sight: claims 忠 and heals the lord
    act(w, 1, [{ a: 'claim', role: 'loyalist' }]);
    lord.hp = lord.maxHp * 0.7;
    let anchor = { x: lord.pos.x, z: lord.pos.z, t: w.time };
    let longest = 0;
    run(w, 30 * 45, (t) => {
      if (t < 200 && t % 40 === 0) w.heal(lord.id, 25, loyal.id);
      if (Math.hypot(lord.pos.x - anchor.x, lord.pos.z - anchor.z) > 1.5) anchor = { x: lord.pos.x, z: lord.pos.z, t: w.time };
      else longest = Math.max(longest, w.time - anchor.t);
    });
    expect(longest).toBeLessThan(10);
  }, 30_000);
});

// ── claims & quick-chat ─────────────────────────────────────────────────────
describe('claims and quick-chat', () => {
  it('a downed bot calls for a peach (需要桃)', () => {
    const { w } = world(STD5, [1], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const me = hero(w, 1);
    place(w, me, 0, 40);
    w.step();
    w.dealDamage({ targetId: me.id, amount: 1e4, type: 'true' });
    const evs = run(w, 30 * 2);
    expect(chats(evs, me.id, 'needPeach')).toBeGreaterThan(0);
  });

  it('the lord points at whoever shoots him (集火此人)', () => {
    const { w } = world(STD5, [0], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const rebel = hero(w, 2);
    tough(lord);
    tough(rebel);
    place(w, lord, 0, 30);
    place(w, rebel, 0, 12);
    [1, 3, 4].forEach((s, i) => place(w, hero(w, s), -50 + i * 5, -52));
    setTime(w, 200);
    const evs = run(w, 30 * 6, (t) => {
      if (t % 10 === 0) w.dealDamage({ targetId: lord.id, sourceId: rebel.id, amount: 12, type: 'normal', canDodge: false });
    });
    expect(chats(evs, lord.id, 'focus')).toBeGreaterThan(0);
  });

  it('a loyalist next to the lord claims 忠', () => {
    const { w } = world(STD5, [1], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    place(w, hero(w, 0), 0, 30);
    place(w, hero(w, 1), 6, 34);
    [2, 3, 4].forEach((s, i) => place(w, hero(w, s), -50 + i * 5, -52));
    setTime(w, 120);
    const evs = run(w, 30 * 100);
    expect(evs.some((e) => e.t === 'claim' && e.who === hero(w, 1).id && e.role === 'loyalist')).toBe(true);
  }, 30_000);

  it('the first rebel to reach its push time calls 跟我来; a rebel who hears a call joins that push', () => {
    const { w, bot } = world(STD5, [2, 3], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    [0, 1, 4].forEach((s, i) => place(w, hero(w, s), -50 + i * 5, -52));
    place(w, hero(w, 2), 40, 40);
    place(w, hero(w, 3), -40, 40);
    w.step();
    type Strat = { strategy: { pushAt: number } };
    const s2 = (bot(2) as unknown as Strat).strategy;
    const s3 = (bot(3) as unknown as Strat).strategy;
    // bot 2 is the early one: its staging (push − 22 s) starts right now
    s2.pushAt = 200;
    s3.pushAt = 400;
    setTime(w, 178.5);
    const evs = run(w, 30 * 4);
    expect(chats(evs, hero(w, 2).id, 'followMe')).toBe(1);
    expect(chats(evs, hero(w, 3).id, 'followMe')).toBe(0);
    expect(s3.pushAt).toBeLessThan(205);
  });
});

// ── human quick-chat ────────────────────────────────────────────────────────
describe('bots listen to human quick-chat', () => {
  it('集火此人 from the lord: the loyalist turns on the hero the lord points at', () => {
    const { w, bot } = world(STD5, [1], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const x = hero(w, 2);
    tough(x);
    place(w, lord, 0, 30, 0); // facing −z, toward x
    place(w, x, 0, 8);
    place(w, hero(w, 1), 10, 34);
    [3, 4].forEach((s, i) => place(w, hero(w, s), -50 + i * 5, -52));
    setTime(w, 150);
    run(w, 30 * 2, () => act(w, 0, [], { yaw: 0, pitch: -0.02 }));
    const before = bot(1).hostility(x);
    expect(before).toBeLessThan(0.84);
    run(w, 30 * 4, (t) => act(w, 0, t === 0 ? [{ a: 'quickchat', id: 'focus' }] : [], { yaw: 0, pitch: -0.02 }));
    expect(bot(1).hostility(x)).toBeGreaterThan(before);
    expect(bot(1).target?.id).toBe(x.id);
  });

  it('需要桃 from a downed lord 45 m away sends a loyalist with a peach at once (silence: only once it is close)', () => {
    const scenario = (call: boolean): { reviveAt: number; revived: boolean } => {
      const { w, bot } = world(STD5, [1], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
      const lord = hero(w, 0);
      place(w, lord, 0, 30);
      place(w, hero(w, 1), 0, -16);
      [2, 3, 4].forEach((s, i) => place(w, hero(w, s), 40 + i * 5, 52));
      setTime(w, 150);
      w.step();
      w.dealDamage({ targetId: lord.id, amount: 1e4, type: 'true' });
      let reviveAt = -1;
      run(w, 30 * 11, (t) => {
        if (call && t === 2) act(w, 0, [{ a: 'quickchat', id: 'needPeach' }]);
        if (reviveAt < 0 && bot(1).mode === 'revive') reviveAt = t / 30;
      });
      return { reviveAt, revived: !lord.hero!.downed && !lord.hero!.dead };
    };
    const called = scenario(true);
    const silent = scenario(false);
    expect(called.revived).toBe(true);
    expect(called.reviveAt).toBeGreaterThanOrEqual(0);
    expect(called.reviveAt).toBeLessThan(1);
    // without the call the lord is out of its revive range at first: it only turns to him later
    expect(silent.reviveAt < 0 || silent.reviveAt > called.reviveAt + 1).toBe(true);
  }, 30_000);
});

// ── camp NPCs ───────────────────────────────────────────────────────────────
describe('camp NPCs', () => {
  it('guard their camp: aggro on a hero that comes close, chase briefly, leash back home and heal', () => {
    const { w } = world(STD5, [], ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const npc = w.spawnNpc('yellowTurban', { x: -30, y: 0, z: -30 });
    const home = { ...npc.npc!.home };
    const h = hero(w, 2);
    tough(h);
    [0, 1, 3, 4].forEach((s, i) => place(w, hero(w, s), 40 + i * 4, 50));
    place(w, h, -30, -14);
    run(w, 30 * 3);
    expect(npc.npc!.targetId).toBe(h.id);
    // hurt it, then run far beyond its leash
    w.dealDamage({ targetId: npc.id, sourceId: h.id, amount: npc.maxHp * 0.5, type: 'normal', canDodge: false });
    place(w, h, 30, 40);
    let maxAway = 0;
    let back = -1;
    run(w, 30 * 25, (t) => {
      const d = Math.hypot(npc.pos.x - home.x, npc.pos.z - home.z);
      maxAway = Math.max(maxAway, d);
      if (back < 0 && t > 30 && d < 3) back = t / 30;
    });
    expect(npc.alive).toBe(true);
    expect(maxAway).toBeGreaterThan(2); // it gave chase
    expect(maxAway).toBeLessThan(40); // …but not far beyond its leash
    expect(back).toBeGreaterThan(0);
    expect(npc.npc!.targetId).toBeUndefined();
    expect(npc.hp).toBe(npc.maxHp);
  }, 30_000);
});
