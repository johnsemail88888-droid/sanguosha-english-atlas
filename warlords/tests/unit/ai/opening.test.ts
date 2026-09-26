// C3-5: opening brawls. ~8–16 % of bot matches had a hero death in the first minute: a bot cast an
// area ability (周瑜 火烧赤壁, 陆逊 火烧连营, 黄盖 火船…) on an NPC camp, it caught a hero passing by,
// and the retaliation went on to the death (seeds 9523 / 9527 / 9529). Now an area cast aimed at a
// camp keeps clear of every known hero and other heroes' soldiers, and in the opening minute nobody
// is executed over such a scuffle (the bots stop at 35 % like the lord's mercy).
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, RoleId } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function camp(passerBy: boolean): { casts: number; hitsOnPasser: number } {
  const w: World = makeWorld(STD5, {
    heroes: ['caocao', 'dummy', 'zhouyu', 'dummy', 'dummy'],
    humans: [0, 1, 3, 4],
    nav: true,
    botFactory: (seat, d, s) => new HeroBot(seat, d, s),
  });
  const zy = hero(w, 2);
  const passer = hero(w, 3);
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  place(w, zy, 0, 42, 0);
  for (let i = 0; i < 4; i++) w.spawnNpc('yellowTurban', { x: -3 + i * 2, y: 0, z: 22 + (i % 2) * 2 });
  // 9 m beside the napalm's path to the camp (its burning ground lasts 6 s)
  if (passerBy) place(w, passer, 9, 30, 0);
  else place(w, passer, -50, -50);
  passer.maxHp = passer.hp = 5000;
  let casts = 0;
  let hitsOnPasser = 0;
  for (let i = 0; i < 30 * 12; i++) {
    w.step();
    for (const ev of w.drainEvents() as GameEvent[]) {
      if (ev.t === 'ability' && ev.src === zy.id && ev.ability === 'zhouyu_chibi') casts++;
      if (ev.t === 'hit' && ev.target === passer.id && ev.src === zy.id && ev.amount > 0) hitsOnPasser++;
    }
    if (passerBy) place(w, passer, 9, 30, 0); // idle next to the camp
  }
  return { casts, hitsOnPasser };
}

describe('C3-5: area casts on NPC camps avoid heroes', () => {
  it('周瑜 napalms a camp with nobody around, but not while a hero stands near its path', () => {
    const alone = camp(false);
    const busy = camp(true);
    process.stdout.write(`[C3-5 camp] alone: ${alone.casts} casts · hero by the camp: ${busy.casts} casts, ${busy.hitsOnPasser} hits on him\n`);
    expect(alone.casts).toBeGreaterThan(0);
    expect(busy.casts).toBe(0);
  }, 60000);
});

describe('C3-5: no executions in the opening minute', () => {
  function scuffle(at: number): { downed: boolean; dead: boolean; minHp: number; maxHp: number } {
    let bot: HeroBot | undefined;
    const w: World = makeWorld(STD5, {
      heroes: ['dummy', 'dummy', 'guanyu', 'dummy', 'dummy'],
      humans: [0, 1, 3, 4],
      squads: true,
      botFactory: (seat, d, s) => {
        const b = new HeroBot(seat, d, s);
        if (seat === 2) bot = b;
        return b;
      },
    });
    const me = hero(w, 2);
    const other = hero(w, 1); // a loyalist the rebel bot knows nothing about
    STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
    place(w, me, 0, 40, 0);
    place(w, other, 0, 28, Math.PI);
    for (const e of [...w.entities()]) {
      if (e.kind !== 'troop') continue;
      const c = w.commanderOf(e) as Entity;
      place(w, e, c.pos.x + 2, c.pos.z + 2);
    }
    w.tick = Math.round(at * 30);
    w.time = w.tick / 30;
    for (let i = 0; i < 10; i++) w.step();
    // a stray blast from him catches the bot: a real provocation
    for (let k = 0; k < 3; k++) {
      w.dealDamage({ targetId: me.id, sourceId: other.id, amount: 45, type: 'explosive', canDodge: false });
      w.step();
    }
    let minHp = other.hp;
    let downed = false;
    for (let i = 0; i < 30 * 15; i++) {
      w.step();
      minHp = Math.min(minHp, other.hp);
      if (other.hero!.downed) downed = true;
    }
    void bot;
    return { downed, dead: other.hero!.dead, minHp, maxHp: other.maxHp };
  }

  it('at 0:30 the bot answers the hit but leaves the stranger standing; at 4:00 the same scuffle goes further', () => {
    const early = scuffle(30);
    process.stdout.write(`[C3-5 opening] 0:30 → min hp ${Math.round(early.minHp)} downed ${early.downed} dead ${early.dead}\n`);
    expect(early.minHp).toBeLessThan(early.maxHp); // answered
    expect(early.downed || early.dead).toBe(false);
    const later = scuffle(240);
    process.stdout.write(`[C3-5 opening] 4:00 → min hp ${Math.round(later.minHp)} downed ${later.downed} dead ${later.dead}\n`);
    expect(later.minHp).toBeLessThan(early.minHp);
  }, 60000);
});

describe('C3-5: soldiers stay out of opening scuffles', () => {
  function burnt(at: number): { afterBurn: boolean; afterShot: boolean } {
    const w: World = makeWorld(STD5, { squads: true });
    STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
    const loyal = hero(w, 1);
    const rebel = hero(w, 2);
    place(w, loyal, 0, 30);
    place(w, rebel, 0, 12);
    const trooper = w.get(loyal.hero!.squad[0])!;
    w.tick = Math.round(at * 30);
    w.time = w.tick / 30;
    w.step();
    // the rebel's camp napalm left burning ground: the trooper walked in and burns
    w.applyStatus(trooper.id, 'burn', 2, { sourceId: rebel.id, params: { dps: 10 } });
    for (let i = 0; i < 30; i++) w.step();
    const afterBurn = w.isHostileTo(trooper, rebel);
    w.dealDamage({ targetId: loyal.id, sourceId: rebel.id, amount: 20, type: 'normal', weaponId: 'pistol' });
    w.step();
    return { afterBurn, afterShot: w.isHostileTo(trooper, rebel) };
  }

  it('in the opening a burn from a stranger’s field is no war for the squad, a shot at the commander is; later the burn counts too', () => {
    const early = burnt(20);
    expect(early.afterBurn).toBe(false);
    expect(early.afterShot).toBe(true);
    const later = burnt(120);
    expect(later.afterBurn).toBe(true);
  });
});
