// Squad / NPC brains: identity-aware restraint with bot commanders, hazards.
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function scenario(lordIsBot: boolean): { w: World; loyal: ReturnType<typeof hero> } {
  const w = makeWorld(STD5, {
    heroes: ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'],
    humans: lordIsBot ? [1, 2, 3, 4] : [0, 1, 2, 3, 4],
    squads: true,
    botFactory: (seat, d, seed) => new HeroBot(seat, d, seed),
  });
  const lord = hero(w, 0);
  const loyal = hero(w, 1);
  place(w, lord, 0, 30);
  place(w, loyal, 8, 36);
  for (const id of lord.hero!.squad) place(w, w.get(id)!, (id % 3) - 1, 26);
  for (const id of loyal.hero!.squad) place(w, w.get(id)!, 8 + (id % 3), 42);
  for (const s of [2, 3, 4]) {
    place(w, hero(w, s), -50 + s * 5, -50);
    for (const id of hero(w, s).hero!.squad) place(w, w.get(id)!, -50 + s * 5, -45);
  }
  w.tick = 120 * 30;
  w.time = 120;
  stepN(w, 10);
  // the loyalist behaves like one: claims 忠 and heals the lord
  lord.hp -= 150;
  stepN(w, 2);
  w.setInput('p1', { ...emptyInput(500), actions: [{ a: 'claim', role: 'loyalist' }] });
  w.heal(lord.id, 100, loyal.id);
  stepN(w, 30);
  // …then one stray bullet hits the lord
  w.dealDamage({ targetId: lord.id, sourceId: loyal.id, amount: 12, type: 'normal', weaponId: 'pistol' });
  stepN(w, 30 * 5);
  return { w, loyal };
}

describe('squad brain', () => {
  it("a bot lord's soldiers don't open fire on a believed loyalist over a stray bullet", () => {
    const withBot = scenario(true);
    expect(withBot.loyal.hp).toBe(withBot.loyal.maxHp);
    // control: a human lord's soldiers follow the world's retaliation rule
    const withHuman = scenario(false);
    expect(withHuman.loyal.hp).toBeLessThan(withHuman.loyal.maxHp);
  });

  it('soldiers step out of an enemy fire field', () => {
    const w = makeWorld(STD5, { squads: true, heroes: ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'] });
    const cmd = hero(w, 1);
    place(w, cmd, 0, 30);
    const t = w.get(cmd.hero!.squad[0])!;
    for (const id of cmd.hero!.squad) place(w, w.get(id)!, (id % 3) * 3 - 3, 40);
    place(w, t, 0, 45);
    for (const s of [0, 2, 3, 4]) place(w, hero(w, s), -50 + s * 5, -50);
    // hold order: without the fire they would stay right there
    w.setSquadOrder(cmd.id, { kind: 'hold', point: { x: 0, y: 0, z: 45 } });
    stepN(w, 30);
    w.spawnHazard({ kind: 'fire', ownerId: hero(w, 2).id, pos: { x: 0, y: 0, z: 45 }, radius: 3, duration: 8, tickEvery: 0.5, params: { damage: 10 }, dtype: 'fire' });
    stepN(w, 45);
    expect(Math.hypot(t.pos.x, t.pos.z - 45)).toBeGreaterThan(3);
  });
});
