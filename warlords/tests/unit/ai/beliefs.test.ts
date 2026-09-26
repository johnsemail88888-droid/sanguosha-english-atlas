// Suspicion model (跳身份 logic): evidence from public observations moves
// beliefs the right way, respects the table, and decays.
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const ROLES: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];

function setup(spySeat: number, difficulty: 'easy' | 'normal' | 'hard' = 'normal'): { w: World; bot: HeroBot } {
  let bot: HeroBot | undefined;
  const w = makeWorld(ROLES, {
    heroes: ['caocao', 'guanyu', 'zhaoyun', 'lubu', 'machao', 'xuchu', 'ganning', 'huangzhong'],
    humans: ROLES.map((_, i) => i).filter((i) => i !== spySeat),
    settings: { botDifficulty: difficulty },
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      if (seat === spySeat) bot = b;
      return b;
    },
  });
  ROLES.forEach((_, i) => place(w, hero(w, i), (i - 4) * 6, 40));
  w.step();
  return { w, bot: bot! };
}

describe('beliefs', () => {
  it('shooting the lord makes a hero look like a rebel; the loyalist bot turns on him', () => {
    const { w, bot } = setup(1);
    const lord = hero(w, 0);
    const shooter = hero(w, 5);
    const other = hero(w, 6);
    const base = bot.beliefs.rebelness(w, hero(w, 1), shooter);
    for (let i = 0; i < 6; i++) {
      w.dealDamage({ targetId: lord.id, sourceId: shooter.id, amount: 12, type: 'normal', weaponId: 'pistol' });
      stepN(w, 10);
    }
    stepN(w, 20);
    const self = hero(w, 1);
    expect(bot.beliefs.rebelness(w, self, shooter)).toBeGreaterThan(base + 0.2);
    expect(bot.beliefs.rebelness(w, self, shooter)).toBeGreaterThan(bot.beliefs.rebelness(w, self, other));
    expect(bot.hostility(shooter)).toBeGreaterThan(0.9);
    expect(bot.hostility(other)).toBeLessThan(0.8);
    // it engages the shooter
    expect(bot.target?.id).toBe(shooter.id);
  });

  it('healing / reviving the lord looks loyal; claims move beliefs (忠 weakly, 反 strongly)', () => {
    const { w, bot } = setup(2);
    const self = hero(w, 2);
    const lord = hero(w, 0);
    const healer = hero(w, 7);
    const claimer = hero(w, 4);
    lord.hp = 200;
    stepN(w, 2);
    const p0 = bot.beliefs.lordSideness(w, self, healer);
    w.heal(lord.id, 80, healer.id);
    stepN(w, 20);
    expect(bot.beliefs.lordSideness(w, self, healer)).toBeGreaterThan(p0 + 0.1);
    w.setInput('p4', { ...emptyInput(900), actions: [{ a: 'claim', role: 'rebel' }] });
    stepN(w, 20);
    expect(bot.beliefs.rebelness(w, self, claimer)).toBeGreaterThan(0.9);
    // a declared rebel is fair game
    expect(bot.hostility(claimer)).toBeGreaterThan(0.84);
  });

  it('probabilities stay consistent with the public table (Sinkhorn)', () => {
    const { w, bot } = setup(1);
    const self = hero(w, 1);
    for (let i = 0; i < 4; i++) {
      w.dealDamage({ targetId: hero(w, 0).id, sourceId: hero(w, 3).id, amount: 15, type: 'normal', weaponId: 'pistol' });
      stepN(w, 15);
    }
    stepN(w, 20);
    let rebels = 0;
    let loyal = 0;
    let traitor = 0;
    for (let i = 2; i < 8; i++) {
      const e = hero(w, i);
      rebels += bot.beliefs.p(w, self, e, 'rebel');
      loyal += bot.beliefs.p(w, self, e, 'loyalist');
      traitor += bot.beliefs.p(w, self, e, 'traitor');
    }
    expect(rebels).toBeCloseTo(4, 1);
    expect(loyal).toBeCloseTo(1, 1);
    expect(traitor).toBeCloseTo(1, 1);
  });

  it('shooting someone nobody knows anything about is not evidence; a stray hit is not a war', () => {
    const { w, bot } = setup(1);
    const self = hero(w, 1);
    const a = hero(w, 3);
    const b = hero(w, 4);
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 40, type: 'normal', weaponId: 'pistol' });
    stepN(w, 20);
    const ev = bot.beliefs.evidence(a.id);
    expect(ev.pro + ev.anti).toBeLessThan(0.2);
    // one stray bullet on the bot itself
    w.dealDamage({ targetId: self.id, sourceId: b.id, amount: 8, type: 'normal', weaponId: 'pistol' });
    stepN(w, 10);
    expect(bot.hostility(b)).toBeLessThan(0.84);
  });

  it('evidence decays over time', () => {
    const { w, bot } = setup(1);
    for (let i = 0; i < 3; i++) {
      w.dealDamage({ targetId: hero(w, 0).id, sourceId: hero(w, 5).id, amount: 10, type: 'normal', weaponId: 'pistol' });
      stepN(w, 10);
    }
    stepN(w, 10);
    const a0 = bot.beliefs.evidence(hero(w, 5).id).anti;
    expect(a0).toBeGreaterThan(0.3);
    // keep the bot busy elsewhere: move the shooter far away so it doesn't get shot
    place(w, hero(w, 5), 50, -50);
    stepN(w, 30 * 100);
    expect(bot.beliefs.evidence(hero(w, 5).id).anti).toBeLessThan(a0 * 0.6);
  });

  it('easy bots read the table more slowly than hard bots', () => {
    const run = (d: 'easy' | 'hard'): number => {
      const { w, bot } = setup(1, d);
      for (let i = 0; i < 3; i++) {
        w.dealDamage({ targetId: hero(w, 0).id, sourceId: hero(w, 5).id, amount: 8, type: 'normal', weaponId: 'pistol' });
        stepN(w, 10);
      }
      stepN(w, 20);
      return bot.beliefs.evidence(hero(w, 5).id).anti;
    };
    expect(run('hard')).toBeGreaterThan(run('easy') * 1.5);
  });
});
