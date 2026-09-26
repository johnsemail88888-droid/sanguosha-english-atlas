// C3-6: 三国杀 — a dying player may play his own 桃. A downed hero with a 桃 in his bar uses it on
// himself as a ~1.5 s channel and gets back up with the revive HP (before: the card was refused,
// the hint only said to wait for teammates).
import { describe, expect, it } from 'vitest';
import type { GameEvent, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { ITEM_BY_ID } from '../../../src/data';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const TAO = ITEM_BY_ID.tao;
let seq = 1;

function downedWithTao(count = 1): { w: ReturnType<typeof makeWorld>; me: ReturnType<typeof hero> } {
  const w = makeWorld(STD5);
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  const me = hero(w, 2);
  place(w, me, 0, 30);
  me.hero!.items = [{ id: 'sha', count: 1 }, { id: 'tao', count }, null, null];
  w.step();
  w.dealDamage({ targetId: me.id, amount: 5000, type: 'true' });
  expect(me.hero!.downed).toBe(true);
  w.drainEvents();
  return { w, me };
}

function use(w: ReturnType<typeof makeWorld>, slot: number): GameEvent[] {
  w.setInput('p2', { ...emptyInput(seq++), actions: [{ a: 'item', slot }] });
  w.step();
  return w.drainEvents();
}

describe('C3-6: self-桃 while downed', () => {
  it('channels ~1.5 s, then the hero is back up with the revive HP and the card is spent', () => {
    const { w, me } = downedWithTao(2);
    const evs = use(w, 1);
    expect(evs.some((e) => e.t === 'sfx' && e.name === 'itemDenied')).toBe(false);
    expect(me.hero!.channel?.kind).toBe('item');
    const len = me.hero!.channel!.until - me.hero!.channel!.start;
    expect(len).toBeCloseTo(TAO.params.reviveTime, 5);
    stepN(w, Math.floor(len * 30) - 3);
    expect(me.hero!.downed).toBe(true); // not instant
    const out: GameEvent[] = [];
    for (let i = 0; i < 6; i++) {
      w.step();
      out.push(...w.drainEvents());
    }
    expect(me.hero!.downed).toBe(false);
    expect(me.hp).toBe(TAO.params.reviveHp);
    expect(me.hero!.items[1]).toEqual({ id: 'tao', count: 1 });
    expect(out.some((e) => e.t === 'revived' && e.target === me.id)).toBe(true);
    expect(out.some((e) => e.t === 'itemUse' && e.who === me.id && e.item === 'tao')).toBe(true);
    // a self-save is no rescue
    expect(me.hero!.stats.rescues).toBe(0);
  });

  it('other cards stay refused while downed (only 桃 / 酒)', () => {
    const { w, me } = downedWithTao();
    use(w, 0);
    expect(me.hero!.channel).toBeNull();
    expect(me.hero!.items[0]).toEqual({ id: 'sha', count: 1 });
  });

  it('revived by a teammate mid-channel: the channel stops and the 桃 is kept', () => {
    const { w, me } = downedWithTao();
    use(w, 1);
    stepN(w, 10);
    w.revive(me.id, 100, hero(w, 3).id);
    stepN(w, 60);
    expect(me.hero!.downed).toBe(false);
    expect(me.hero!.items[1]).toEqual({ id: 'tao', count: 1 });
    expect(me.hp).toBe(100);
  });

  it('bleeding out before the channel ends kills him (the card does not save a hero already out of time)', () => {
    const { w, me } = downedWithTao();
    me.hero!.downedUntil = w.time + 0.5;
    use(w, 1);
    stepN(w, 60);
    expect(me.hero!.dead).toBe(true);
  });
});
