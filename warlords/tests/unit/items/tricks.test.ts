import { describe, expect, it } from 'vitest';
import { ITEM_BY_ID, LOOT_TABLES } from '../../../src/data';
import { maxReserve, weaponDef } from '../../../src/sim/defs';
import { chest, events, feet, giveAndUse, hero, hold, inject, place, setup, slotCount, stepN, ticks, useSlot } from './helpers';

const REWARD_IDS = new Set(LOOT_TABLES.reward.map((e) => e.id));

describe('无中生有 wuzhong', () => {
  it('draws 2 random reward items into the freed slot and the next free one', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'wuzhong', count: 1 }, { id: 'sha', count: 5 }, null, { id: 'shan', count: 3 }];
    useSlot(w, a, 0, chest(a));
    stepN(w, ticks(0.6));
    const got = a.hero!.items.filter((s, i) => s && i !== 1 && i !== 3);
    expect(got.map((s) => s!.count).reduce((x, y) => x + y, 0)).toBe(2);
    for (const s of got) expect(REWARD_IDS.has(s!.id)).toBe(true);
    expect(a.hero!.items[1]).toEqual({ id: 'sha', count: 5 });
  });

  it('drops the draw at your feet when every slot is full', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'wuzhong', count: 2 }, { id: 'sha', count: 5 }, { id: 'tao', count: 3 }, { id: 'shan', count: 3 }];
    // make sure the draw cannot stack anywhere
    const before = w.kindList('loot').length;
    useSlot(w, a, 0, chest(a));
    stepN(w, ticks(0.6));
    expect(slotCount(a, 0)).toBe(1);
    const inSlots = a.hero!.items.reduce((n, s) => n + (s?.count ?? 0), 0);
    const dropped = w.kindList('loot').length - before;
    // every drawn card is either stacked into a slot or lying at the user's feet
    expect(inSlots + dropped).toBe(1 + 5 + 3 + 3 + 2);
    for (const l of w.kindList('loot')) expect(Math.hypot(l.pos.x - a.pos.x, l.pos.z - a.pos.z)).toBeLessThan(0.5);
  });
});

describe('过河拆桥 guohe (EMP grenade)', () => {
  function armoured(w: ReturnType<typeof setup>['w'], e: ReturnType<typeof setup>['b']): void {
    e.hero!.armor = 'renwang';
    e.hero!.mount = 'dilu';
    w.addShield(e.id, 150, 30);
  }

  it('lands at the aim point and after the fuse strips armor, mount and shield onto the ground', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 35);
    armoured(w, b);
    w.step();
    w.drainEvents();
    giveAndUse(w, a, 'guohe', feet(b));
    expect(slotCount(a)).toBe(0);
    const ev = events(w.drainEvents(), 'itemUse');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ who: a.id, item: 'guohe' });
    expect(w.kindList('projectile').length).toBe(1); // the visible grenade
    stepN(w, ticks(1.0));
    // a warning marker lies where it landed, gear still on
    const marker = w.kindList('hazard').find((h) => h.hazard!.kind === 'grenadeEmp');
    expect(marker).toBeDefined();
    expect(Math.hypot(marker!.pos.x - b.pos.x, marker!.pos.z - b.pos.z)).toBeLessThan(1);
    expect(b.hero!.armor).toBe('renwang');
    expect(b.shield).toBeGreaterThan(0);
    stepN(w, ticks(0.25));
    expect(b.hero!.armor).toBeNull();
    expect(b.hero!.mount).toBeNull();
    expect(b.shield).toBe(0);
    const loot = w.kindList('loot').map((l) => l.loot!.itemId);
    expect(loot).toContain('renwang');
    expect(loot).toContain('dilu');
    expect(events(w.drainEvents(), 'explosion').some((e) => e.kind === 'emp')).toBe(true);
  });

  it('never touches the thrower, deals no damage and leaves units outside the radius alone', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 30);
    place(w, c, 8, 30); // 8 m from the blast
    armoured(w, b);
    c.hero!.armor = 'bagua';
    a.hero!.armor = 'tengjia';
    const hb = b.hp;
    giveAndUse(w, a, 'guohe', feet(b));
    stepN(w, ticks(1.4));
    expect(b.hero!.armor).toBeNull();
    expect(b.hp).toBe(hb);
    expect(c.hero!.armor).toBe('bagua');
    expect(a.hero!.armor).toBe('tengjia');
  });

  it('a wall in the way stops the grenade short', () => {
    const { w, a, b } = setup();
    // test map wall along z at x = 10 (z −5..5, 3 m tall)
    place(w, a, 0, 0, -Math.PI / 2);
    place(w, b, 16, 0);
    armoured(w, b);
    w.step();
    giveAndUse(w, a, 'guohe', feet(b));
    stepN(w, ticks(1.4));
    expect(b.hero!.armor).toBe('renwang');
    expect(b.shield).toBeGreaterThan(0);
  });

  it('无懈可击 cancels it for its holder (charge consumed); a holder with nothing to lose keeps the charge', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 35);
    place(w, c, 1.5, 35);
    armoured(w, b);
    w.applyStatus(b.id, 'nullify', 30, { sourceId: b.id });
    w.applyStatus(c.id, 'nullify', 30, { sourceId: c.id }); // c has no gear
    giveAndUse(w, a, 'guohe', feet(b));
    stepN(w, ticks(1.4));
    expect(b.hero!.armor).toBe('renwang');
    expect(b.hero!.mount).toBe('dilu');
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
    expect(w.hasStatus(c.id, 'nullify')).toBe(true);
  });

  it('白银狮子 stripped by the EMP heals its wearer 100', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 35);
    b.hero!.armor = 'baiyin';
    b.hp = 150;
    giveAndUse(w, a, 'guohe', feet(b));
    stepN(w, ticks(1.4));
    expect(b.hero!.armor).toBeNull();
    expect(b.hp).toBe(250);
  });
});

describe('顺手牵羊 shunshou', () => {
  it('steals one item from the enemy hero under the crosshair within 8 m', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 26);
    b.hero!.items = [{ id: 'tao', count: 2 }, null, null, null];
    b.hero!.armor = null;
    giveAndUse(w, a, 'shunshou', chest(b), b);
    expect(slotCount(a)).toBe(0); // card spent
    expect(a.hero!.items.find((s) => s?.id === 'tao')?.count).toBe(1);
    expect(b.hero!.items[0]?.count).toBe(1);
    const ev = events(w.drainEvents(), 'itemUse');
    expect(ev[0]).toMatchObject({ who: a.id, item: 'shunshou', target: b.id });
  });

  it('can take equipment: the stolen armor is worn by the thief', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 26);
    b.hero!.items = [null, null, null, null];
    b.hero!.armor = 'bagua';
    giveAndUse(w, a, 'shunshou', chest(b), b);
    expect(b.hero!.armor).toBeNull();
    expect(a.hero!.armor).toBe('bagua');
  });

  it('is kept when out of range, when the victim has nothing, or when 谦逊 vetoes the theft', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 32); // 12 m
    b.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    giveAndUse(w, a, 'shunshou', chest(b), b);
    expect(slotCount(a)).toBe(1);
    place(w, b, 0, 26);
    b.hero!.items = [null, null, null, null];
    w.step();
    useSlot(w, a, 0, chest(b), b);
    expect(slotCount(a)).toBe(1);
    b.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    inject(w, b, { id: 't_qianxun', canBeAffected: (_c, s) => s !== 'steal' });
    useSlot(w, a, 0, chest(b), b);
    expect(slotCount(a)).toBe(1);
    expect(b.hero!.items[0]?.count).toBe(1);
  });

  it('无懈可击 cancels the theft but the card is spent', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 26);
    b.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    w.applyStatus(b.id, 'nullify', 30, { sourceId: b.id });
    giveAndUse(w, a, 'shunshou', chest(b), b);
    expect(slotCount(a)).toBe(0);
    expect(b.hero!.items[0]?.count).toBe(1);
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
  });
});

describe('决斗 juedou', () => {
  function duel(): ReturnType<typeof setup> {
    const s = setup();
    place(s.w, s.b, 0, 32);
    s.w.step();
    return s;
  }

  it('marks both duelists so each side focuses the other, and shows the duel in abilityState', () => {
    const { w, a, b } = duel();
    giveAndUse(w, a, 'juedou', chest(b), b);
    expect(slotCount(a)).toBe(0);
    expect(b.statuses.some((s) => s.id === 'marked' && s.sourceId === a.id)).toBe(true);
    expect(a.statuses.some((s) => s.id === 'marked' && s.sourceId === b.id)).toBe(true);
    expect(a.hero!.abilityState['item:juedou:vs']).toBe(b.id);
    expect(b.hero!.abilityState['item:juedou:vs']).toBe(a.id);
  });

  it('after 8 s whoever lost more HP takes 80 from the other', () => {
    const { w, a, b } = duel();
    giveAndUse(w, a, 'juedou', chest(b), b);
    w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 100, type: 'normal', weaponId: 'pistol' });
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal', weaponId: 'pistol' });
    const ha = a.hp;
    const hb = b.hp;
    stepN(w, ticks(7.8));
    expect(a.hp).toBe(ha);
    stepN(w, ticks(0.4));
    expect(a.hp).toBe(ha - 80);
    expect(b.hp).toBe(hb);
    expect(a.hero!.abilityState['item:juedou:vs']).toBeUndefined();
  });

  it('a tie punishes nobody; shields count as HP', () => {
    const { w, a, b } = duel();
    w.addShield(b.id, 50, 30);
    giveAndUse(w, a, 'juedou', chest(b), b);
    w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 50, type: 'normal', weaponId: 'pistol' });
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'normal', weaponId: 'pistol' }); // soaked by the shield
    const ha = a.hp;
    const hb = b.hp;
    stepN(w, ticks(8.5));
    expect(a.hp).toBe(ha);
    expect(b.hp).toBe(hb);
  });

  it('ends early when the duelists are 35 m+ apart, and the target loses if it ran after losing more', () => {
    const { w, a, b } = duel();
    giveAndUse(w, a, 'juedou', chest(b), b);
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 60, type: 'normal', weaponId: 'pistol' });
    const hb = b.hp;
    stepN(w, ticks(2));
    place(w, b, 0, 56); // 36 m
    stepN(w, ticks(0.6));
    expect(b.hp).toBe(hb - 80);
    expect(a.hero!.abilityState['item:juedou:vs']).toBeUndefined();
  });

  it('a duelist who goes down loses without being hit again', () => {
    const { w, a, b } = duel();
    giveAndUse(w, a, 'juedou', chest(b), b);
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1e4, type: 'true' });
    expect(b.hero!.downed).toBe(true);
    const until = b.hero!.downedUntil;
    stepN(w, ticks(1));
    expect(b.hero!.downedUntil).toBe(until);
    expect(a.hero!.abilityState['item:juedou:vs']).toBeUndefined();
  });

  it('无懈可击 refuses the duel (card spent, no marks); you cannot start a second duel', () => {
    const { w, a, b, c } = duel();
    w.applyStatus(b.id, 'nullify', 30, { sourceId: b.id });
    giveAndUse(w, a, 'juedou', chest(b), b);
    expect(slotCount(a)).toBe(0);
    expect(w.hasStatus(b.id, 'marked')).toBe(false);
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
    // second duel while one is running
    giveAndUse(w, a, 'juedou', chest(b), b);
    expect(slotCount(a)).toBe(0);
    place(w, c, 5, 32);
    w.step();
    giveAndUse(w, a, 'juedou', chest(c), c);
    expect(slotCount(a)).toBe(1);
  });
});

describe('借刀杀人 jiedao', () => {
  it("turns the target's soldiers on the hero nearest their commander (never the user) for 6 s", () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 45);
    place(w, c, 6, 51); // nearest other hero to b
    const troops = w.spawnTroops(b.id, 'qun_raider', 3, { x: 4, y: 0, z: 48 });
    expect(troops).toHaveLength(3);
    w.step();
    const hc = c.hp;
    giveAndUse(w, a, 'jiedao', chest(b), b);
    stepN(w, ticks(0.5)); // 0.5 s channel
    expect(slotCount(a)).toBe(0);
    expect(b.hero!.order).toMatchObject({ kind: 'attack', targetId: c.id });
    // the commander tries to countermand: the hack holds
    w.setSquadOrder(b.id, { kind: 'follow' });
    stepN(w, ticks(4));
    expect(b.hero!.order).toMatchObject({ kind: 'attack', targetId: c.id });
    expect(c.hp).toBeLessThan(hc);
    expect(a.hp).toBe(a.maxHp);
    stepN(w, ticks(2.5));
    expect(b.hero!.order.kind).toBe('follow');
  });

  it('is kept without soldiers or without another hero near the target; 无懈可击 cancels it', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 45);
    place(w, c, 55, -55);
    for (const h of [hero(w, 0), hero(w, 1)]) place(w, h, -55, -55);
    w.step();
    giveAndUse(w, a, 'jiedao', chest(b), b);
    stepN(w, ticks(0.6));
    expect(slotCount(a)).toBe(1); // no squad
    w.spawnTroops(b.id, 'qun_raider', 2, { x: 3, y: 0, z: 47 });
    w.step();
    useSlot(w, a, 0, chest(b), b);
    hold(w, a, ticks(0.6), chest(b), b);
    expect(slotCount(a)).toBe(1); // nobody but the user near b
    place(w, c, 5, 49);
    w.applyStatus(b.id, 'nullify', 30, { sourceId: b.id });
    w.step();
    useSlot(w, a, 0, chest(b), b);
    hold(w, a, ticks(0.6), chest(b), b);
    expect(slotCount(a)).toBe(0);
    expect(b.hero!.order.kind).toBe('follow');
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
  });

  it('aiming at one of the soldiers hacks their commander', () => {
    const { w, a, b, c } = setup();
    place(w, b, 10, 50);
    place(w, c, 14, 52);
    const [t] = w.spawnTroops(b.id, 'qun_raider', 2, { x: 0, y: 0, z: 32 });
    w.step();
    giveAndUse(w, a, 'jiedao', chest(t), t);
    hold(w, a, ticks(0.6), chest(t), t);
    expect(slotCount(a)).toBe(0);
    expect(b.hero!.order).toMatchObject({ kind: 'attack', targetId: c.id });
  });
});

describe('无懈可击 wuxie', () => {
  it('grants nullify for 20 s; a second card stacks a second charge', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'wuxie', chest(a), undefined, 2);
    expect(w.hasStatus(a.id, 'nullify')).toBe(true);
    useSlot(w, a, 0, chest(a));
    expect(a.statuses.filter((s) => s.id === 'nullify').reduce((n, s) => n + (s.stacks ?? 1), 0)).toBe(2);
    stepN(w, ticks(20.2));
    expect(w.hasStatus(a.id, 'nullify')).toBe(false);
  });
});

describe('南蛮入侵 nanman', () => {
  it('summons 5 barbarians that rush the aim point, attack others but never you, and vanish after 20 s', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 50);
    w.step();
    giveAndUse(w, a, 'nanman', feet(b), b);
    stepN(w, ticks(0.5));
    const npcs = w.kindList('npc').filter((n) => n.npc?.summonerId === a.id);
    expect(npcs).toHaveLength(5);
    for (const n of npcs) {
      expect(n.npc!.npcType).toBe('barbarian');
      expect(Math.hypot(n.npc!.ai.goalX! - b.pos.x, n.npc!.ai.goalZ! - b.pos.z)).toBeLessThan(2);
      expect(w.isHostileTo(n, a)).toBe(false);
      expect(w.isHostileTo(n, b)).toBe(true);
    }
    const hb = b.hp;
    stepN(w, ticks(8));
    expect(b.hp).toBeLessThan(hb);
    expect(a.hp).toBe(a.maxHp);
    stepN(w, ticks(12));
    expect(w.kindList('npc').filter((n) => n.npc?.summonerId === a.id)).toHaveLength(0);
  });
});

describe('万箭齐发 wanjian', () => {
  it('after 0.8 s rains 18 every 0.5 s for 3 s on everyone in 8 m but your side', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 45);
    place(w, c, 6, 45);
    w.applyStatus(c.id, 'nullify', 30, { sourceId: c.id });
    w.step();
    const hb = b.hp;
    const hc = c.hp;
    giveAndUse(w, a, 'wanjian', feet(b));
    expect(w.kindList('hazard').some((h) => h.hazard!.kind === 'wanjianArrows')).toBe(true);
    stepN(w, ticks(0.7));
    expect(b.hp).toBe(hb);
    stepN(w, ticks(3.3));
    expect(hb - b.hp).toBe(6 * 18);
    expect(hc - c.hp).toBe(6 * 18);
    expect(w.hasStatus(c.id, 'nullify')).toBe(true); // a lingering field never consumes it
    expect(w.kindList('hazard').some((h) => h.hazard!.kind === 'wanjianArrows')).toBe(false);
  });

  it("the user's own arrows never hurt the user", () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'wanjian', feet(a));
    stepN(w, ticks(4));
    expect(a.hp).toBe(a.maxHp);
  });
});

describe('桃园结义 taoyuan', () => {
  it('heals every hero (enemies too) and soldier within 15 m by 80', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 30);
    place(w, c, 0, 50); // 30 m: out of range
    const [t] = w.spawnTroops(a.id, 'qun_raider', 1, { x: 3, y: 0, z: 20 });
    for (const e of [a, b, c, t]) e.hp = Math.max(1, e.maxHp - 200);
    const hc = c.hp;
    giveAndUse(w, a, 'taoyuan', chest(a));
    hold(w, a, ticks(1.05), chest(a));
    expect(slotCount(a)).toBe(0);
    expect(a.hp).toBe(a.maxHp - 120);
    expect(b.hp).toBe(b.maxHp - 120);
    expect(t.hp).toBe(Math.min(t.maxHp, Math.max(1, t.maxHp - 200) + 80));
    expect(c.hp).toBe(hc);
  });

  it('is kept when nobody around is hurt', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'taoyuan', chest(a));
    hold(w, a, ticks(1.1), chest(a));
    expect(slotCount(a)).toBe(1);
  });
});

describe('五谷丰登 wugu', () => {
  it('bursts 4 reward items onto the ground within 3 m, out of auto-pickup reach', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'wugu', chest(a));
    hold(w, a, ticks(0.6), chest(a));
    expect(slotCount(a)).toBe(0);
    const loot = w.kindList('loot');
    expect(loot).toHaveLength(4);
    for (const l of loot) {
      expect(REWARD_IDS.has(l.loot!.itemId!)).toBe(true);
      const d = Math.hypot(l.pos.x - a.pos.x, l.pos.z - a.pos.z);
      expect(d).toBeLessThanOrEqual(3);
      expect(d).toBeGreaterThan(1.4);
    }
    // first come, first served: anyone can walk over and take them
    stepN(w, 5);
    expect(w.kindList('loot')).toHaveLength(4);
  });
});

describe('火攻 huogong', () => {
  it('1.5 s fuse, then 40 fire in 4 m + burn + a 6 s fire field (15/s)', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 38);
    w.step();
    const hb = b.hp;
    giveAndUse(w, a, 'huogong', feet(b), undefined, 3);
    expect(slotCount(a)).toBe(2);
    stepN(w, ticks(1.4));
    expect(b.hp).toBe(hb);
    let n = 0;
    while (b.hp === hb && n++ < 30) w.step();
    expect(hb - b.hp).toBe(40); // the blast alone, on the detonation tick
    expect(w.hasStatus(b.id, 'burn')).toBe(true);
    expect(w.kindList('hazard').some((h) => h.hazard!.kind === 'huogongFire')).toBe(true);
    stepN(w, ticks(6.2));
    // 40 blast + 10/s × 3 s burn + 15/s × 6 s field
    expect(hb - b.hp).toBeCloseTo(40 + 30 + 90, 0);
  });

  it('藤甲 takes double from the blast; chained units share the fire', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 38);
    place(w, c, 30, -30); // far away, but chained
    b.hero!.armor = 'tengjia';
    w.applyStatus(b.id, 'chained', 10, { sourceId: a.id });
    w.applyStatus(c.id, 'chained', 10, { sourceId: a.id });
    w.step();
    const hb = b.hp;
    const hc = c.hp;
    giveAndUse(w, a, 'huogong', feet(b));
    let n = 0;
    while (b.hp === hb && n++ < 60) w.step();
    expect(hb - b.hp).toBe(80);
    expect(hc - c.hp).toBe(40);
  });
});

describe('铁索连环 tiesuo', () => {
  it('chains up to 3 enemies within 6 m of the aim point, heroes first, for 10 s', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 45);
    place(w, c, 3, 45);
    const troops = w.spawnTroops(hero(w, 0).id, 'shu_rifleman', 3, { x: -2, y: 0, z: 46 });
    const own = w.spawnTroops(a.id, 'qun_raider', 1, { x: 1, y: 0, z: 44 });
    w.step();
    giveAndUse(w, a, 'tiesuo', feet(b), undefined, 3);
    expect(slotCount(a)).toBe(2);
    expect(w.hasStatus(b.id, 'chained')).toBe(true);
    expect(w.hasStatus(c.id, 'chained')).toBe(true);
    expect(troops.filter((t) => w.hasStatus(t.id, 'chained'))).toHaveLength(1);
    expect(w.hasStatus(own[0].id, 'chained')).toBe(false);
    stepN(w, ticks(10.1));
    expect(w.hasStatus(b.id, 'chained')).toBe(false);
  });

  it('is kept when nobody is there; 无懈可击 cancels it for its holder', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 45);
    w.step();
    giveAndUse(w, a, 'tiesuo', { x: 20, y: 0, z: 45 });
    expect(slotCount(a)).toBe(1);
    w.applyStatus(b.id, 'nullify', 30, { sourceId: b.id });
    useSlot(w, a, 0, feet(b));
    expect(slotCount(a)).toBe(0);
    expect(w.hasStatus(b.id, 'chained')).toBe(false);
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
  });
});

describe('征兵令 zhengbing', () => {
  it('channels 1.5 s and recruits 2 soldiers of your troop type', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'zhengbing', chest(a));
    hold(w, a, ticks(1.3), chest(a));
    expect(a.hero!.squad).toHaveLength(0);
    hold(w, a, ticks(0.3), chest(a));
    expect(a.hero!.squad).toHaveLength(2);
    const t = w.get(a.hero!.squad[0])!;
    expect(t.troop!.troopType).toBe(w.heroRt(a.id)!.def.troopType);
    expect(slotCount(a)).toBe(0);
  });

  it('never exceeds the squad cap + 2, and is kept when the squad is already there', () => {
    const { w, a } = setup();
    // cap for a plain rebel: troopsPerHero 4 → 6 with the order
    w.spawnTroops(a.id, 'qun_raider', 5);
    giveAndUse(w, a, 'zhengbing', chest(a), undefined, 2);
    hold(w, a, ticks(1.6), chest(a));
    expect(a.hero!.squad).toHaveLength(6);
    expect(slotCount(a)).toBe(1);
    useSlot(w, a, 0, chest(a));
    hold(w, a, ticks(1.6), chest(a));
    expect(a.hero!.squad).toHaveLength(6);
    expect(slotCount(a)).toBe(1);
  });
});

describe('ammo bookkeeping sanity', () => {
  it('杀 still refills after wave-2 registration', () => {
    const { w, a } = setup();
    const wi = a.hero!.weapons[0]!;
    wi.reserve = 0;
    giveAndUse(w, a, 'sha', chest(a));
    hold(w, a, ticks(0.7), chest(a));
    expect(wi.reserve).toBe(Math.ceil(maxReserve(weaponDef(wi.id)) * (ITEM_BY_ID.sha.params.reserveFrac ?? 0.5)));
  });
});
