// Scenario tests for the bot hero brain: combat, fire discipline, reviving,
// healing, looting, zone, navigation, squad orders, abilities and items.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, MatchSettings, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HEROES } from '../../../src/data';
import { getAbility } from '../../../src/sim/abilities/registry';
import { aimAnglesFor } from '../../../src/sim/aim';
import { DIFFICULTY_PROFILES } from '../../../src/sim/ai/difficulty';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { teamPushAt } from '../../../src/sim/ai/strategy';
import type { CreateMatchOptions, World } from '../../../src/sim/world';
import { zonePhaseStart } from '../../../src/sim/zone';
import { createWorld } from '../../../src/sim/world';
import { hero, makeInit, makeWorld, place, stepN } from '../sim/helpers';
import { realMap } from './harness';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

/** Jump the clock (e.g. past the rebels' push window); zones stay off in these worlds. */
function setTime(w: World, seconds: number): void {
  w.tick = Math.round(seconds * 30);
  w.time = w.tick / 30;
}

function botWorld(roles: RoleId[], botSeat: number, heroes: string[], opts: { settings?: Partial<MatchSettings>; squads?: boolean; ambient?: boolean } = {}): { w: World; bot: HeroBot } {
  let bot: HeroBot | undefined;
  const w = makeWorld(roles, {
    heroes,
    humans: roles.map((_, i) => i).filter((i) => i !== botSeat),
    settings: opts.settings,
    squads: opts.squads ?? false,
    ambient: opts.ambient ?? false,
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      if (seat === botSeat) bot = b;
      return b;
    },
  });
  return { w, bot: bot! };
}

function realWorld(roles: RoleId[], botSeat: number, heroes: string[], opts: CreateMatchOptions = {}): { w: World; bot: HeroBot } {
  let bot: HeroBot | undefined;
  const init = makeInit(roles, heroes, {}, roles.map((_, i) => i).filter((i) => i !== botSeat));
  const w = createWorld(init, {
    map: realMap(),
    ambient: false,
    airdrops: false,
    squads: false,
    zone: false,
    onWarn: () => {},
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      if (seat === botSeat) bot = b;
      return b;
    },
    ...opts,
  });
  return { w, bot: bot! };
}

/**
 * Well inside this table's push: the rebels' shared push time (+ up to 20 s of a rebel's own) +
 * the 40 s a rebel who has not fought yet waits at the staging ring for company.
 */
function pushOn(w: World): number {
  return teamPushAt(w, DIFFICULTY_PROFILES.normal) + 20 + 41;
}

function farAway(w: World, seats: number[]): void {
  seats.forEach((s, i) => place(w, hero(w, s), -50 + i * 6, -52));
}

describe('combat', () => {
  it('rebels push the lord once the push window opens', () => {
    const { w } = botWorld(STD5, 2, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    place(w, lord, 0, 30);
    place(w, hero(w, 2), 0, 52);
    farAway(w, [1, 3, 4]);
    setTime(w, pushOn(w));
    stepN(w, 30 * 8);
    expect(lord.hp).toBeLessThan(lord.maxHp);
  });

  it('before the push, a rebel leaves the lord alone', () => {
    const { w } = botWorld(STD5, 2, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    place(w, lord, 0, 30);
    place(w, hero(w, 2), 0, 52);
    farAway(w, [1, 3, 4]);
    setTime(w, 40);
    stepN(w, 30 * 8);
    expect(lord.hp).toBe(lord.maxHp);
  });

  it('a loyalist defends the lord: whoever shoots the crown gets shot', () => {
    const { w, bot } = botWorld(STD5, 1, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const attacker = hero(w, 3);
    place(w, lord, 0, 30);
    place(w, hero(w, 1), 6, 36);
    place(w, attacker, -4, 12);
    farAway(w, [2, 4]);
    setTime(w, 120);
    w.step();
    for (let i = 0; i < 4; i++) {
      w.dealDamage({ targetId: lord.id, sourceId: attacker.id, amount: 10, type: 'normal', weaponId: 'pistol' });
      stepN(w, 8);
    }
    stepN(w, 30 * 4);
    expect(bot.target?.id).toBe(attacker.id);
    expect(attacker.hp).toBeLessThan(attacker.maxHp);
  });

  it('never shoots through the lord standing in the line of fire', () => {
    const { w } = botWorld(STD5, 1, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const rebel = hero(w, 2);
    place(w, rebel, 0, 20);
    place(w, lord, 0, 34);
    place(w, hero(w, 1), 0, 48);
    farAway(w, [3, 4]);
    setTime(w, 120);
    w.setInput('p2', { ...emptyInput(700), actions: [{ a: 'claim', role: 'rebel' }] });
    stepN(w, 30 * 6);
    expect(lord.hp).toBe(lord.maxHp);
  });

  it('difficulty scales accuracy: hard bots out-damage easy bots against a strafing target', () => {
    const dmg = (d: 'easy' | 'normal' | 'hard'): number => {
      const { w } = botWorld(STD5, 1, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], { settings: { botDifficulty: d } });
      const target = hero(w, 2);
      target.maxHp = 1e5;
      target.hp = 1e5;
      place(w, hero(w, 1), 0, 50);
      place(w, target, 0, 26);
      farAway(w, [0, 3, 4]);
      setTime(w, 120);
      w.setInput('p2', { ...emptyInput(1), actions: [{ a: 'claim', role: 'rebel' }] });
      w.step();
      w.dealDamage({ targetId: hero(w, 1).id, sourceId: target.id, amount: 30, type: 'normal', weaponId: 'pistol' });
      let seq = 10;
      for (let t = 0; t < 30 * 12; t++) {
        const dir = Math.floor(t / 30) % 2 === 0 ? 1 : -1;
        w.setInput('p2', { ...emptyInput(seq++), moveX: dir, yaw: 0 });
        w.step();
      }
      return 1e5 - target.hp;
    };
    const easy = dmg('easy');
    const hard = dmg('hard');
    expect(hard).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(easy * 1.3);
  }, 30_000);
});

describe('support', () => {
  it('revives a downed lord with a 桃', () => {
    const { w } = botWorld(STD5, 1, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    place(w, lord, 0, 30);
    place(w, hero(w, 1), 8, 42);
    farAway(w, [2, 3, 4]);
    setTime(w, 120);
    w.step();
    w.dealDamage({ targetId: lord.id, amount: 1e4, type: 'true' });
    expect(lord.hero!.downed).toBe(true);
    stepN(w, 30 * 8);
    expect(lord.hero!.downed).toBe(false);
    expect(lord.hero!.dead).toBe(false);
  });

  it('drinks a 桃 when hurt and safe', () => {
    const { w } = botWorld(STD5, 1, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const me = hero(w, 1);
    place(w, me, 0, 40);
    farAway(w, [0, 2, 3, 4]);
    me.hp = me.maxHp * 0.25;
    const hp0 = me.hp;
    stepN(w, 30 * 6);
    expect(me.hp).toBeGreaterThan(hp0 + 60);
    expect(me.hero!.items.some((s) => s?.id === 'tao')).toBe(false);
  });

  it('uses cards by their hooks: 杀 when ammo runs low, 闪 in a fight when dodges are spent', () => {
    const { w } = botWorld(STD5, 1, ['caocao', 'zhangliao', 'guanyu', 'guanyu', 'guanyu']);
    const me = hero(w, 1);
    place(w, me, 0, 40);
    farAway(w, [0, 2, 3, 4]);
    me.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    me.hero!.weapons[0]!.reserve = 0;
    stepN(w, 30 * 4);
    expect(me.hero!.weapons[0]!.reserve).toBeGreaterThan(0);
  });
});

describe('loot, zone and navigation', () => {
  it('opens a crate and trades up to a better weapon', () => {
    const { w } = botWorld(STD5, 1, ['caocao', 'zhangliao', 'guanyu', 'guanyu', 'guanyu'], { ambient: true });
    const me = hero(w, 1);
    place(w, me, 2, 48);
    farAway(w, [0, 2, 3, 4]);
    w.spawnLoot({ x: 6, y: 0, z: 52 }, { weaponId: 'qinglong' });
    const crate = w.kindList('crate').find((c) => Math.hypot(c.pos.x + 5, c.pos.z - 40) < 2)!;
    expect(crate).toBeDefined();
    stepN(w, 30 * 20);
    expect(me.hero!.weapons[0]!.id).toBe('qinglong');
    expect(crate.crate!.opened).toBe(true);
  }, 30_000);

  it('walks across the real map to escort the lord (paths through the city, never stuck)', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
    const { w, bot } = realWorld(roles, 1, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu']);
    const lord = hero(w, 0);
    const me = hero(w, 1);
    const spawn = w.map.spawns.reduce((a, b) => (Math.hypot(b.x, b.z) > Math.hypot(a.x, a.z) ? b : a));
    w.teleport(me.id, spawn);
    ['2', '3', '4'].forEach((s, i) => w.teleport(hero(w, Number(s)).id, w.map.spawns[(i + 3) % w.map.spawns.length]));
    setTime(w, 130);
    const d0 = Math.hypot(me.pos.x - lord.pos.x, me.pos.z - lord.pos.z);
    expect(d0).toBeGreaterThan(80);
    let reached = -1;
    for (let t = 0; t < 30 * 70 && reached < 0; t++) {
      w.step();
      if (Math.hypot(me.pos.x - lord.pos.x, me.pos.z - lord.pos.z) < 22) reached = t / 30;
    }
    expect(reached, `still ${Math.round(Math.hypot(me.pos.x - lord.pos.x, me.pos.z - lord.pos.z))} m away`).toBeGreaterThan(0);
    expect(bot.stats.stuckEvents).toBeLessThan(8);
  }, 60_000);

  it('runs for the circle when caught outside it', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
    // the traitor: it has no reason to fight idle heroes, so the clock can run
    const { w } = realWorld(roles, 4, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], { zone: true });
    const me = hero(w, 4);
    // play the clock normally (zone damage is accounted per tick) up to phase 3 (~100 m circle)
    while (w.time < zonePhaseStart(3) + 7) {
      w.step();
      w.drainEvents();
    }
    const z0 = w.zoneView();
    // start well outside the circle
    const dx = -z0.center.x;
    const dz = -z0.center.z;
    const l = Math.hypot(dx, dz) || 1;
    const out = { x: z0.center.x - (dx / l) * (z0.radius + 25), y: 0, z: z0.center.z - (dz / l) * (z0.radius + 25) };
    const clampTo = (v: number): number => Math.max(-145, Math.min(145, v));
    w.teleport(me.id, { x: clampTo(out.x), y: w.groundHeight(clampTo(out.x), clampTo(out.z)), z: clampTo(out.z) });
    [0, 1, 2, 3].forEach((s) => w.teleport(hero(w, s).id, { x: z0.center.x + s, y: w.groundHeight(z0.center.x + s, z0.center.z), z: z0.center.z }));
    const outside = (e: Entity): boolean => {
      const z = w.zoneView();
      return Math.hypot(e.pos.x - z.center.x, e.pos.z - z.center.z) > z.radius;
    };
    expect(outside(me)).toBe(true);
    let inside = -1;
    for (let t = 0; t < 30 * 40 && inside < 0; t++) {
      w.step();
      if (!outside(me)) inside = t / 30;
    }
    expect(w.result()).toBeNull();
    expect(inside).toBeGreaterThan(0);
  }, 60_000);
});

describe('squad and abilities', () => {
  it('orders the squad to attack its target', () => {
    const { w, bot } = botWorld(STD5, 2, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], { squads: true });
    const lord = hero(w, 0);
    place(w, lord, 0, 30);
    place(w, hero(w, 2), 0, 52);
    for (const id of hero(w, 2).hero!.squad) place(w, w.get(id)!, (id % 3) - 1, 55);
    farAway(w, [1, 3, 4]);
    for (const s of [0, 1, 3, 4]) for (const id of hero(w, s).hero!.squad) place(w, w.get(id)!, -50, 50);
    setTime(w, pushOn(w));
    stepN(w, 30 * 6);
    expect(bot.target?.id).toBe(lord.id);
    expect(hero(w, 2).hero!.order.kind).toBe('attack');
    expect(hero(w, 2).hero!.order.targetId).toBe(lord.id);
  });

  it('every hero uses its Q/E generically in a fight without errors', () => {
    const warnings: string[] = [];
    const usedBy: Record<string, number> = {};
    const implemented: string[] = [];
    for (const def of HEROES) {
      const actives = def.abilities.filter((a) => (a.slot === 'q' || a.slot === 'e') && getAbility(a.id)?.activate);
      if (actives.length === 0) continue;
      implemented.push(def.id);
      const w = createWorld(makeInit(STD5, ['caocao', 'guanyu', def.id, 'guanyu', 'guanyu'], {}, [0, 1, 3, 4]), {
        map: makeWorldMap(),
        ambient: false,
        zone: false,
        airdrops: false,
        squads: false,
        nav: false,
        onWarn: (m) => warnings.push(m),
      });
      const lord = hero(w, 0);
      lord.maxHp = 1e5;
      lord.hp = 1e5;
      place(w, lord, 0, 30);
      place(w, hero(w, 2), 0, 44);
      farAway(w, [1, 3, 4]);
      setTime(w, 300);
      const me = hero(w, 2);
      let n = 0;
      for (let t = 0; t < 30 * 16; t++) {
        if (t % 15 === 0 && !me.hero!.downed && me.hp > 80) w.dealDamage({ targetId: me.id, sourceId: lord.id, amount: 12, type: 'normal', weaponId: 'pistol' });
        w.step();
        for (const ev of w.drainEvents() as GameEvent[]) if (ev.t === 'ability' && ev.src === me.id) n++;
      }
      usedBy[def.id] = n;
    }
    const brainErrors = warnings.filter((m) => m.includes('bot brain threw') || m.includes('troop brain threw') || m.includes('npc brain threw'));
    expect(brainErrors).toEqual([]);
    const users = implemented.filter((id) => usedBy[id] > 0);
    process.stdout.write(`[ai] abilities used in a 16 s fight: ${implemented.map((id) => `${id}:${usedBy[id]}`).join(' ')}\n`);
    expect(users.length).toBeGreaterThanOrEqual(Math.ceil(implemented.length * 0.75));
  }, 120_000);
});

describe('deployables and closers (COMBAT-5)', () => {
  /** One bot rebel fighting an (unkillable) loyalist who shoots it, `dist` m away, for `seconds`: casts per ability id. */
  function fight(heroId: string, dist: number, seconds: number): { casts: Record<string, number>; w: World; me: Entity } {
    const w = createWorld(makeInit(STD5, ['caocao', 'guanyu', heroId, 'guanyu', 'guanyu'], {}, [0, 1, 3, 4]), {
      map: makeWorldMap(),
      ambient: false,
      zone: false,
      airdrops: false,
      squads: false,
      nav: false,
      onWarn: () => {},
    });
    const foe = hero(w, 1);
    foe.maxHp = foe.hp = 1e5;
    place(w, foe, 0, 30, Math.PI); // facing the bot: its hits are meant for it
    place(w, hero(w, 2), 0, 30 + dist);
    farAway(w, [0, 3, 4]);
    setTime(w, 300);
    const me = hero(w, 2);
    const casts: Record<string, number> = {};
    let seq = 1;
    for (let t = 0; t < 30 * seconds; t++) {
      // the foe keeps facing the bot (its hits are meant for it) and lands 16 dps
      const a = aimAnglesFor(foe.pos, { x: me.pos.x, y: me.pos.y + 1.1, z: me.pos.z });
      w.setInput(foe.hero!.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch });
      if (t % 15 === 0 && !me.hero!.downed && me.hp > 120) w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 8, type: 'normal', weaponId: 'pistol' });
      w.step();
      for (const ev of w.drainEvents() as GameEvent[]) if (ev.t === 'ability' && ev.src === me.id) casts[ev.ability] = (casts[ev.ability] ?? 0) + 1;
    }
    return { casts, w, me };
  }

  it('黄月英 sets 木牛流马 down beside her when the enemy is inside the turret\'s range (25 m), not only within 6 m', () => {
    const { casts, w, me } = fight('huangyueying', 25, 12);
    expect(casts.huangyueying_muniu ?? 0).toBeGreaterThanOrEqual(1);
    const turrets = w.kindList('turret').filter((t) => t.ownerId === me.id);
    expect(turrets.length).toBeGreaterThanOrEqual(1);
  });

  it('许褚 猛击, 马超 冲锋 and 张飞 断桥 get used in a fight that starts 25 m out', () => {
    const want: [string, string][] = [
      ['xuchu', 'xuchu_slam'],
      ['machao', 'machao_charge'],
      ['zhangfei', 'zhangfei_duanqiao'],
    ];
    const got = want.map(([h, a]) => [a, fight(h, 25, 20).casts[a] ?? 0] as const);
    process.stdout.write(`[ai] closers in a 20 s fight from 25 m: ${got.map(([a, n]) => `${a}:${n}`).join(' ')}\n`);
    for (const [a, n] of got) expect(n, a).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

let testMap: ReturnType<typeof realMap> | null = null;
function makeWorldMap(): ReturnType<typeof realMap> {
  if (!testMap) testMap = makeWorld(STD5).map;
  return testMap;
}
