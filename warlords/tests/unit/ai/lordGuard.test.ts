// C3-4: the bot 主公 holds his post. Before the endgame he leaves a hero farther than ~40 m that is
// not hurting the lord side to his loyalists (he was the top killer and the lord side won 62–66 % of
// bot matches); he still answers whoever shoots him or a believed ally, and anyone who comes close.
import { describe, expect, it } from 'vitest';
import type { GameEvent, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function scene(rebelZ: number, provoke: boolean): number {
  const w: World = makeWorld(STD5, {
    heroes: ['caocao', 'guanyu', 'dummy', 'dummy', 'dummy'],
    humans: [1, 2, 3, 4],
    botFactory: (seat, d, s) => new HeroBot(seat, d, s),
  });
  const lord = hero(w, 0);
  const loyal = hero(w, 1);
  const rebel = hero(w, 2);
  place(w, lord, 0, 40, 0);
  place(w, loyal, 3, 42);
  place(w, rebel, 0, rebelZ, Math.PI);
  place(w, hero(w, 3), -50, -50);
  place(w, hero(w, 4), 50, -50);
  rebel.maxHp = rebel.hp = 5000;
  w.tick = 200 * 30;
  w.time = 200;
  // the rebel admitted it (跳反)
  w.setInput('p2', { ...emptyInput(1), actions: [{ a: 'claim', role: 'rebel' }] });
  for (let i = 0; i < 60; i++) w.step();
  w.drainEvents();
  let hits = 0;
  for (let i = 0; i < 30 * 8; i++) {
    if (provoke && i % 15 === 0) w.dealDamage({ targetId: loyal.id, sourceId: rebel.id, amount: 15, type: 'normal', canDodge: false });
    w.step();
    for (const ev of w.drainEvents() as GameEvent[]) if (ev.t === 'hit' && ev.target === rebel.id && ev.src === lord.id && ev.amount > 0) hits++;
  }
  return hits;
}

describe('C3-4: the bot lord holds his post', () => {
  it('an admitted rebel idling 48 m out is left alone; shooting the lord’s loyalist or coming within 25 m is not', () => {
    const far = scene(-8, false);
    const farShooting = scene(-8, true);
    const near = scene(15, false);
    process.stdout.write(`[C3-4 guard] lord hits on the rebel: 48 m idle ${far} · 48 m shooting the loyalist ${farShooting} · 25 m idle ${near}\n`);
    expect(far).toBe(0);
    expect(farShooting).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(0);
  }, 60000);
});
