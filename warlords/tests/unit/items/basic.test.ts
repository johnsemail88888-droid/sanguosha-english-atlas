import { describe, expect, it } from 'vitest';
import { ITEMS, ITEM_BY_ID } from '../../../src/data';
import { chest, events, feet, giveAndUse, hold, place, setup, slotCount, stepN, ticks, useSlot } from './helpers';

describe('酒 jiu', () => {
  it('drunk while downed: gets back up with 50 HP after its short channel', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'jiu', count: 2 }, null, null, null];
    w.dealDamage({ targetId: a.id, amount: 1e4, type: 'true' });
    expect(a.hero!.downed).toBe(true);
    useSlot(w, a, 0, chest(a));
    hold(w, a, ticks(ITEM_BY_ID.jiu.useTime) + 1, chest(a));
    expect(a.hero!.downed).toBe(false);
    expect(a.hp).toBe(ITEM_BY_ID.jiu.params.reviveHp);
    expect(slotCount(a)).toBe(1);
    expect(w.hasStatus(a.id, 'drunk')).toBe(false); // the revive, not the buff
  });

  it('the ×2 applies to the next weapon hit only — ability/item damage neither doubles nor consumes it', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 30);
    giveAndUse(w, a, 'jiu', chest(a));
    hold(w, a, ticks(0.6), chest(a));
    expect(w.hasStatus(a.id, 'drunk')).toBe(true);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'fire', abilityId: 'huogong' }).dealt).toBe(30);
    expect(w.hasStatus(a.id, 'drunk')).toBe(true);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal', weaponId: 'pistol' }).dealt).toBe(60);
    expect(w.hasStatus(a.id, 'drunk')).toBe(false);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal', weaponId: 'pistol' }).dealt).toBe(30);
  });

  it('wears off unused after 8 s', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'jiu', chest(a));
    hold(w, a, ticks(0.6), chest(a));
    stepN(w, ticks(8));
    expect(w.hasStatus(a.id, 'drunk')).toBe(false);
  });
});

describe('桃 tao', () => {
  it('is kept at full HP; heals 120 otherwise (capped at max)', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'tao', chest(a), undefined, 2);
    hold(w, a, ticks(1.3), chest(a));
    expect(slotCount(a)).toBe(2);
    a.hp = a.maxHp - 50;
    useSlot(w, a, 0, chest(a));
    hold(w, a, ticks(1.3), chest(a));
    expect(a.hp).toBe(a.maxHp);
    expect(slotCount(a)).toBe(1);
  });

  it('a downed player cannot eat their own 桃 (only 酒 works while downed)', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    w.dealDamage({ targetId: a.id, amount: 1e4, type: 'true' });
    useSlot(w, a, 0, chest(a));
    hold(w, a, ticks(1.6), chest(a));
    expect(a.hero!.downed).toBe(true);
    expect(slotCount(a)).toBe(1);
  });
});

describe('闪 shan', () => {
  it('+1 dodge charge up to 3, kept when already at 3', () => {
    const { w, a } = setup();
    a.hero!.dodgeCharges = 1;
    giveAndUse(w, a, 'shan', chest(a), undefined, 3);
    expect(a.hero!.dodgeCharges).toBe(2);
    useSlot(w, a, 0, chest(a));
    useSlot(w, a, 0, chest(a));
    expect(a.hero!.dodgeCharges).toBe(3);
    expect(slotCount(a)).toBe(1);
  });
});

describe('itemUse events', () => {
  it('every successful use emits { itemUse, who, item } (pos for point items, target for enemy items)', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 28);
    b.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    w.step();
    a.hp = a.maxHp - 150;
    for (const def of ITEMS) {
      if (def.id === 'sha' || def.id === 'jiedao') continue; // need ammo loss / a squad: covered elsewhere
      if (def.id === 'juedou' && (a.hero!.abilityState['item:juedou:until'] ?? 0) > w.time) continue;
      w.drainEvents();
      a.hero!.dodgeCharges = 0;
      a.hp = Math.min(a.hp, a.maxHp - 150);
      const point = def.targeting === 'point' ? feet(b) : chest(b);
      giveAndUse(w, a, def.id, point, b);
      hold(w, a, ticks(def.useTime) + 2, point, b);
      const ev = events(w.drainEvents(), 'itemUse').filter((e) => e.who === a.id && e.item === def.id);
      expect(ev, def.id).toHaveLength(1);
      if (def.targeting === 'point') expect(Math.hypot(ev[0].pos!.x - b.pos.x, ev[0].pos!.z - b.pos.z), def.id).toBeLessThan(def.range);
      if (def.targeting === 'enemy') expect(ev[0].target, def.id).toBe(b.id);
      if (!b.hero!.items.some(Boolean)) b.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    }
  });
});
