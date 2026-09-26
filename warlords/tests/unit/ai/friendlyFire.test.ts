// C3-3: friendly fire on the bot lord. A human loyalist (关羽, seat 1) who hits the bot 主公 a few
// times must not be executed for it: his own squad does not turn on the lord from a small hit
// (only sustained fire or a mark does), the lord's side forgives small fire from a 忠-claimer and
// never finishes a downed one. Before the fix (pt3-combat ff.test.ts): one pistol shot → his own
// squad fired 30–37 shots (12–22 at the lord) and the lord side dealt him 260–370; three carbine
// shots without a claim → dead in 2.2–3.5 s on 5 of 5 lords; eight with a claim → dead 4 of 5.
import { describe, expect, it } from 'vitest';
import type { Entity, RoleId } from '../../../src/core/types';
import { BTN_FIRE, emptyInput } from '../../../src/core/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from '../sim/helpers';

interface FfResult {
  fired: number;
  meTook: number;
  meHp: number;
  downed: boolean;
  dead: boolean;
  myTroopShots: number;
  myTroopShotsAtLord: number;
  lordHp: number;
  lordPenalty: boolean;
}

const ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function ffRun(lordHero: string, shots: number, claim: boolean, weapon: string, seconds = 12): FfResult {
  const w: World = makeWorld(ROLES, {
    heroes: [lordHero, 'guanyu', 'dummy', 'dummy', 'dummy'],
    humans: [1],
    squads: true,
    nav: true,
    botFactory: (seat, d, s) => new HeroBot(seat, d, s),
  });
  const lord = hero(w, 0);
  const me = hero(w, 1);
  for (const s of [2, 3, 4]) place(w, hero(w, s), 50, 50 + s * 3);
  place(w, lord, -20, -20, 0);
  place(w, me, -20, -5, Math.PI);
  for (const e of [...w.entities()]) {
    if (e.kind !== 'troop') continue;
    const c = w.commanderOf(e);
    if (c) place(w, e, c.pos.x + 2, c.pos.z + (c === me ? 2 : -2));
  }
  me.hero!.weapons[0] = { id: weapon, mag: 30, reserve: 90 };
  me.hero!.activeSlot = 0;
  let seq = 1;
  const chest = (e: Entity): { x: number; y: number; z: number } => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });
  const frame = (buttons = 0, actions: ReturnType<typeof emptyInput>['actions'] = []): void => {
    const c = chest(lord);
    const a = aimAnglesFor(me.pos, c);
    w.setInput(me.hero!.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimTargetId: lord.id, aimPoint: c, buttons, actions });
  };
  for (let i = 0; i < 60; i++) {
    frame(0, i === 5 && claim ? [{ a: 'claim', role: 'loyalist' }] : []);
    w.step();
    w.drainEvents();
  }
  const r: FfResult = { fired: 0, meTook: 0, meHp: 0, downed: false, dead: false, myTroopShots: 0, myTroopShotsAtLord: 0, lordHp: 0, lordPenalty: false };
  let pressed = false;
  for (let i = 0; i < 30 * seconds; i++) {
    let b = 0;
    if (r.fired < shots) {
      const ready = me.hero!.nextFireAt <= w.time + 1e-6;
      if (ready && !pressed) b = BTN_FIRE;
      pressed = b !== 0;
    }
    const mag0 = me.hero!.weapons[0]!.mag;
    frame(b);
    w.step();
    r.fired += Math.max(0, mag0 - me.hero!.weapons[0]!.mag);
    for (const ev of w.drainEvents()) {
      if (ev.t === 'shot') {
        const sh = w.get(ev.src);
        if (sh?.kind === 'troop' && w.commanderOf(sh) === me) {
          r.myTroopShots++;
          if (ev.hit === lord.id) r.myTroopShotsAtLord++;
        }
      }
      if (ev.t === 'hit' && ev.target === me.id) r.meTook += ev.amount;
      if (ev.t === 'downed' && ev.target === me.id) r.downed = true;
      if (ev.t === 'death' && ev.target === me.id) r.dead = true;
      if (ev.t === 'reward' && ev.kind === 'lordPenalty') r.lordPenalty = true;
    }
  }
  r.meHp = me.hp;
  r.lordHp = lord.hp;
  return r;
}

const LORDS = (process.env.FF_LORDS ?? 'sunquan,caocao,yuanshao').split(',');
const fmt = (l: string, s: string, r: FfResult): string =>
  `[C3-3 ${l} ${s}] fired ${r.fired} took ${Math.round(r.meTook)} hp ${Math.round(r.meHp)} downed ${r.downed} dead ${r.dead} squad shots ${r.myTroopShots} (at lord ${r.myTroopShotsAtLord}) lord ${Math.round(r.lordHp)}`;

describe('C3-3: a human loyalist’s friendly fire on the bot lord', () => {
  it('one pistol shot (忠 claimed): his squad stays out of it and he is not punished for it', () => {
    for (const l of LORDS) {
      const r = ffRun(l, 1, true, 'pistol');
      process.stdout.write(fmt(l, '1 pistol +claim', r) + '\n');
      expect(r.myTroopShotsAtLord, l).toBe(0);
      expect(r.downed || r.dead, l).toBe(false);
      expect(r.meTook, l).toBeLessThan(100);
    }
  }, 120000);

  it('three carbine shots (忠 claimed): still forgiven — no squad war, never downed', () => {
    for (const l of LORDS) {
      const r = ffRun(l, 3, true, 'carbine');
      process.stdout.write(fmt(l, '3 carbine +claim', r) + '\n');
      expect(r.myTroopShotsAtLord, l).toBe(0);
      expect(r.downed || r.dead, l).toBe(false);
    }
  }, 120000);

  it('three carbine shots, no claim: his squad stays out of it; the lord (who cannot tell him from a rebel) answers but does not execute him', () => {
    for (const l of LORDS) {
      const r = ffRun(l, 3, false, 'carbine', 20);
      process.stdout.write(fmt(l, '3 carbine', r) + ` penalty ${r.lordPenalty}\n`);
      expect(r.myTroopShotsAtLord, l).toBe(0);
      expect(r.downed || r.dead, l).toBe(false);
    }
  }, 120000);

  it('eight carbine shots (忠 claimed): the lord may answer, but a downed 忠-claimer is never finished', () => {
    for (const l of LORDS) {
      const r = ffRun(l, 8, true, 'carbine', 20); // past a 12 s bleed-out
      process.stdout.write(fmt(l, '8 carbine +claim', r) + '\n');
      expect(r.dead, l).toBe(false);
      expect(r.lordPenalty, l).toBe(false);
    }
  }, 120000);
});
