// APP-5 / APP-7: a press that does nothing (an ability whose activate() refuses, a
// card that cannot be used) tells the human who pressed it why — a private
// { t:'sfx', name:'abilityDenied' | 'itemDenied', reason } cue — keeps the
// cooldown / the card, and never starts a pointless 使用中 channel. Bots get no cue.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { Entity, GameEvent, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
let seq = 1;

function arena(heroes: string[], humans?: number[]): { w: World; at: (seat: number) => Entity } {
  const w = makeWorld(STD5, { heroes, humans });
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  w.step();
  w.drainEvents();
  return { w, at: (seat) => hero(w, seat) };
}

function aimAt(caster: Entity, target: Entity): Partial<InputFrame> {
  const c: Vec3 = { x: target.pos.x, y: target.pos.y + 1.1, z: target.pos.z };
  const a = aimAnglesFor(caster.pos, c);
  return { yaw: a.yaw, pitch: a.pitch, aimPoint: c, aimTargetId: target.id };
}

/** Looking up into the empty sky, nothing under the crosshair. */
const SKY: Partial<InputFrame> = { yaw: Math.PI, pitch: 1.2 };

function press(w: World, seat: number, actions: InputAction[], aim: Partial<InputFrame> = {}): GameEvent[] {
  w.setInput(`p${seat}`, { ...emptyInput(seq++), ...aim, actions });
  w.step();
  return w.drainEvents();
}

type SfxEvent = Extract<GameEvent, { t: 'sfx' }>;
const denials = (evs: GameEvent[], name: 'abilityDenied' | 'itemDenied'): SfxEvent[] => evs.filter((e): e is SfxEvent => e.t === 'sfx' && e.name === name);
const fired = (evs: GameEvent[], id: string): boolean => evs.some((e) => e.t === 'ability' && e.ability === id);

describe('abilityDenied (APP-5)', () => {
  it('离间 on an isolated enemy: private needOther cue, no cast, no cooldown', () => {
    const { w, at } = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy']);
    const dc = at(2);
    const foe = at(3);
    place(w, dc, 0, 40);
    place(w, foe, 0, 25); // nobody else within 15 m of it, no soldiers either
    const evs = press(w, 2, [{ a: 'ability', slot: 'q' }], aimAt(dc, foe));
    expect(fired(evs, 'diaochan_lijian')).toBe(false);
    expect(w.cooldownLeft(dc.id, 'diaochan_lijian')).toBe(0);
    const d = denials(evs, 'abilityDenied');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ privateTo: dc.id, ability: 'diaochan_lijian', reason: 'needOther' });
    expect(d[0].pos).toBeDefined();
  });

  it('says why: nothing aimed at → noTarget, a downed hero → invalidTarget, silenced → silenced', () => {
    const { w, at } = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy']);
    const dc = at(2);
    const foe = at(3);
    place(w, dc, 0, 40);
    place(w, foe, 0, 25);
    place(w, at(4), 4, 25); // a second hero: 离间 would work on a standing target
    expect(denials(press(w, 2, [{ a: 'ability', slot: 'q' }], SKY), 'abilityDenied')[0]?.reason).toBe('noTarget');
    w.downHero(foe, undefined);
    expect(foe.hero!.downed).toBe(true);
    expect(denials(press(w, 2, [{ a: 'ability', slot: 'q' }], aimAt(dc, foe)), 'abilityDenied')[0]?.reason).toBe('invalidTarget');
    expect(w.cooldownLeft(dc.id, 'diaochan_lijian')).toBe(0);
    w.applyStatus(dc.id, 'silence', 3, { sourceId: foe.id });
    const evs = press(w, 2, [{ a: 'ability', slot: 'e' }], aimAt(dc, at(4)));
    expect(denials(evs, 'abilityDenied')).toEqual([expect.objectContaining({ reason: 'silenced', ability: 'diaochan_lianhuan', privateTo: dc.id })]);
    expect(fired(evs, 'diaochan_lianhuan')).toBe(false);
  });

  it('a cast that works sends no denial; a bot that fails a cast gets no cue', () => {
    const { w, at } = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy']);
    const dc = at(2);
    place(w, dc, 0, 40);
    place(w, at(3), 0, 25);
    place(w, at(4), 4, 25);
    const ok = press(w, 2, [{ a: 'ability', slot: 'q' }], aimAt(dc, at(3)));
    expect(fired(ok, 'diaochan_lijian')).toBe(true);
    expect(denials(ok, 'abilityDenied')).toEqual([]);

    // the same isolated-enemy press from a bot seat: refused (reason recorded), but no cue
    const b = scriptedBot(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy'], (self, sim) => ({ actions: [{ a: 'ability', slot: 'q' }], ...aimAt(self, hero(sim as World, 3)) }));
    place(b.w, b.at(2), 0, 40);
    place(b.w, b.at(3), 0, 25);
    b.w.step();
    const evs = b.w.drainEvents();
    expect(b.pressed()).toBeGreaterThan(0);
    expect(fired(evs, 'diaochan_lijian')).toBe(false);
    expect(denials(evs, 'abilityDenied')).toEqual([]);
  });
});

/** Every seat is a bot; seat 2 presses what `frame` says once, the others idle. */
function scriptedBot(heroes: string[], frame: (self: Entity, sim: unknown) => Partial<InputFrame>): { w: World; at: (seat: number) => Entity; pressed: () => number } {
  let presses = 0;
  const w = makeWorld(STD5, {
    heroes,
    humans: [],
    botFactory: (seat) => ({
      think(sim, self) {
        const f = { ...emptyInput(seq++), yaw: self.yaw, pitch: self.pitch };
        if (seat !== 2 || presses > 0) return f;
        presses++;
        return { ...f, ...frame(self, sim) } as InputFrame;
      },
    }),
  });
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  w.drainEvents();
  return { w, at: (seat) => hero(w, seat), pressed: () => presses };
}

describe('itemDenied (APP-7)', () => {
  it('桃 at full HP: refused before any channel starts, card kept, reason fullHp', () => {
    const { w, at } = arena(['dummy', 'dummy', 'dummy', 'dummy', 'dummy']);
    const me = at(2);
    place(w, me, 0, 40);
    expect(me.hp).toBe(me.maxHp);
    expect(me.hero!.items[0]).toEqual({ id: 'tao', count: 1 });
    const evs = press(w, 2, [{ a: 'item', slot: 0 }]);
    expect(me.hero!.channel).toBeNull();
    expect(me.hero!.items[0]).toEqual({ id: 'tao', count: 1 });
    expect(denials(evs, 'itemDenied')).toEqual([expect.objectContaining({ privateTo: me.id, item: 'tao', reason: 'fullHp' })]);
    // hurt: the same press starts the 使用中 channel and heals
    w.dealDamage({ targetId: me.id, amount: 150, type: 'true' });
    const ok = press(w, 2, [{ a: 'item', slot: 0 }]);
    expect(denials(ok, 'itemDenied')).toEqual([]);
    expect(me.hero!.channel?.kind).toBe('item');
    stepN(w, 45);
    expect(me.hp).toBeGreaterThan(me.maxHp - 150);
    expect(me.hero!.items[0]).toBeNull();
  });

  it('闪 at the dodge cap → cap; an enemy card with nothing aimed at → noTarget; silenced → silenced', () => {
    const { w, at } = arena(['dummy', 'dummy', 'dummy', 'dummy', 'dummy']);
    const me = at(2);
    place(w, me, 0, 40);
    me.hero!.items = [{ id: 'shan', count: 1 }, { id: 'shunshou', count: 1 }, { id: 'sha', count: 1 }, null];
    me.hero!.dodgeCharges = 3;
    expect(denials(press(w, 2, [{ a: 'item', slot: 0 }]), 'itemDenied')[0]).toMatchObject({ item: 'shan', reason: 'cap' });
    expect(me.hero!.items[0]).toEqual({ id: 'shan', count: 1 });
    expect(denials(press(w, 2, [{ a: 'item', slot: 1 }], SKY), 'itemDenied')[0]).toMatchObject({ item: 'shunshou', reason: 'noTarget' });
    // full reserve: 杀 has nothing to refill (no channel)
    expect(denials(press(w, 2, [{ a: 'item', slot: 2 }]), 'itemDenied')[0]).toMatchObject({ item: 'sha', reason: 'cap' });
    expect(me.hero!.channel).toBeNull();
    w.applyStatus(me.id, 'silence', 3, { sourceId: at(3).id });
    me.hero!.dodgeCharges = 0;
    expect(denials(press(w, 2, [{ a: 'item', slot: 0 }]), 'itemDenied')[0]).toMatchObject({ item: 'shan', reason: 'silenced' });
  });

  it('a bot at full HP pressing 桃: no cue and no channel', () => {
    const b = scriptedBot(['dummy', 'dummy', 'dummy', 'dummy', 'dummy'], () => ({ actions: [{ a: 'item', slot: 0 }] }));
    const bot = b.at(2);
    place(b.w, bot, 0, 40);
    b.w.step();
    expect(b.pressed()).toBe(1);
    expect(bot.hero!.channel).toBeNull();
    expect(denials(b.w.drainEvents(), 'itemDenied')).toEqual([]);
    expect(bot.hero!.items[0]).toEqual({ id: 'tao', count: 1 });
  });
});
