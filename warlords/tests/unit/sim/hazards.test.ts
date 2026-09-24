import { describe, expect, it } from 'vitest';
import type { AbilityDef } from '../../../src/data/types';
import type { AbilityCtx } from '../../../src/sim/api';
import {
  blink,
  circleAttack,
  coneAttack,
  crosshairEnemy,
  dashStrike,
  lineAttack,
  lineOfFields,
  projectileVolley,
  summonNpcs,
} from '../../../src/sim/abilities/common';
import { registerHazardKind } from '../../../src/sim/hazards';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

function setup(): World {
  const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
  [0, 1, 2, 3, 4].forEach((i) => place(w, hero(w, i), i * 10 - 45, 50));
  w.step();
  w.drainEvents();
  return w;
}

const DEF: AbilityDef = { id: 'test_ability', slot: 'q', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} };
const ctxOf = (w: World, seat: number): AbilityCtx => {
  const e = hero(w, seat);
  return { sim: w, self: e, def: DEF, hero: w.heroDef(e)!, input: w.inputOf(e) };
};

describe('hazards', () => {
  it('fire fields damage everyone inside except the owner side, per tick', () => {
    const w = setup();
    const owner = hero(w, 1);
    const victim = hero(w, 2);
    place(w, owner, 0, 30);
    place(w, victim, 1, 30);
    w.spawnHazard({ kind: 'fire', ownerId: owner.id, pos: { x: 0, y: 0, z: 30 }, radius: 3, duration: 2, tickEvery: 0.5, params: { damage: 10 }, dtype: 'fire' });
    stepN(w, 62);
    expect(owner.hp).toBe(owner.maxHp);
    expect(victim.maxHp - victim.hp).toBeCloseTo(40, 5); // ticks at 0, .5, 1, 1.5
    expect(w.kindList('hazard').length).toBe(0);
  });

  it('heal zones heal non-hostile units; traps trigger once on the first enemy', () => {
    const w = setup();
    const owner = hero(w, 1);
    const friend = hero(w, 0);
    place(w, owner, 0, 30);
    place(w, friend, 1.5, 30);
    friend.hp = 100;
    owner.hp = 100;
    w.spawnHazard({ kind: 'healZone', ownerId: owner.id, pos: { x: 0, y: 0, z: 30 }, radius: 4, duration: 1, tickEvery: 0.5, params: { heal: 20 } });
    stepN(w, 31);
    expect(owner.hp).toBeGreaterThan(100);
    expect(friend.hp).toBeGreaterThan(100);
    const enemy = hero(w, 3);
    const trap = w.spawnHazard({
      kind: 'trapDance',
      ownerId: owner.id,
      pos: { x: 20, y: 0, z: 30 },
      radius: 1.5,
      duration: 30,
      tickEvery: 0.1,
      params: {},
      status: { id: 'dance', duration: 3 },
      triggerOnce: true,
    });
    stepN(w, 10);
    expect(w.get(trap.id)).toBeDefined();
    place(w, enemy, 20, 30.5);
    stepN(w, 5);
    expect(w.hasStatus(enemy.id, 'dance')).toBe(true);
    expect(w.get(trap.id)).toBeUndefined();
  });

  it('followId makes a hazard follow its target; strike hits one unit with thunder', () => {
    const w = setup();
    const owner = hero(w, 1);
    const target = hero(w, 3);
    place(w, target, 10, 10);
    const cloud = w.spawnHazard({ kind: 'lightningCloud', ownerId: owner.id, pos: { x: 10, y: 0, z: 10 }, radius: 2, duration: 3, tickEvery: 1, params: { strike: 30 }, followId: target.id });
    place(w, target, 14, 10);
    stepN(w, 32);
    expect(cloud.pos.x).toBeCloseTo(14, 3);
    expect(target.maxHp - target.hp).toBeCloseTo(60, 5);
  });

  it('custom hazard kinds can be registered', () => {
    const w = setup();
    let ticks = 0;
    registerHazardKind({ kind: 'test_custom', tick: () => ((ticks += 1), true) });
    w.spawnHazard({ kind: 'test_custom', pos: { x: 0, y: 0, z: 0 }, radius: 2, duration: 1, tickEvery: 0.25, params: { damage: 999 } });
    stepN(w, 31);
    expect(ticks).toBe(4);
  });
});

describe('ability helpers (abilities/common.ts)', () => {
  it('coneAttack hits enemies in the arc only, never the caster or own troops', () => {
    const w = setup();
    const me = hero(w, 1);
    place(w, me, 0, 30);
    const front = hero(w, 2);
    const behind = hero(w, 3);
    place(w, front, 0, 27.5);
    place(w, behind, 0, 32.5);
    const [troop] = w.spawnTroops(me.id, 'shu_rifleman', 1, { x: 0.8, y: 0, z: 28 });
    const hit = coneAttack(w, me, w.eyePos(me), { x: 0, y: 0, z: -1 }, 4, 90, { damage: 50, abilityId: 't' });
    expect(hit.map((e) => e.id)).toEqual([front.id]);
    expect(behind.hp).toBe(behind.maxHp);
    expect(troop.hp).toBe(troop.maxHp);
  });

  it('circleAttack / lineAttack apply damage + statuses around a point / along a segment', () => {
    const w = setup();
    const me = hero(w, 1);
    const a = hero(w, 2);
    const b = hero(w, 3);
    place(w, a, 5, 5);
    place(w, b, 6, 6);
    const hit = circleAttack(w, me, { x: 5.5, y: 0, z: 5.5 }, 3, { damage: 20, dtype: 'explosive', status: { id: 'slow', duration: 2, params: { amount: 0.3 } } });
    expect(hit.length).toBe(2);
    expect(w.hasStatus(a.id, 'slow')).toBe(true);
    place(w, a, 0, -20);
    const line = lineAttack(w, me, { x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: -30 }, 1, { damage: 10 });
    expect(line.map((e) => e.id)).toEqual([a.id]);
  });

  it('dashStrike moves the caster and fires onArrive; blink stops before walls', () => {
    const w = setup();
    const me = hero(w, 2);
    place(w, me, 0, 30);
    let arrived = false;
    dashStrike(ctxOf(w, 2), { distance: 6, duration: 0.3, dir: { x: 0, y: 0, z: -1 }, onArrive: () => (arrived = true) });
    stepN(w, 12);
    expect(arrived).toBe(true);
    expect(30 - me.pos.z).toBeGreaterThan(5);
    place(w, me, 5, 0);
    blink(ctxOf(w, 2), { x: 20, y: 0, z: 0 }, 12);
    expect(me.pos.x).toBeLessThan(9.5);
  });

  it('lineOfFields lays hazards along the aim, projectileVolley fires a fan, summonNpcs rush a point', () => {
    const w = setup();
    const me = hero(w, 2);
    place(w, me, 0, 30);
    w.heroRt(me.id)!.input = { ...w.inputOf(me), yaw: 0 };
    lineOfFields(ctxOf(w, 2), { kind: 'fire', count: 4, spacing: 3, radius: 1.5, duration: 5, tickEvery: 0.5, params: { damage: 5 }, dtype: 'fire' });
    const zs = w.kindList('hazard').map((h) => h.pos.z).sort((a, b) => b - a);
    expect(zs).toEqual([27, 24, 21, 18]);
    const ps = projectileVolley(ctxOf(w, 2), { kind: 'arrow', count: 5, fanDeg: 40, speed: 60, damage: 10, dtype: 'normal' });
    expect(ps.length).toBe(5);
    const npcs = summonNpcs(ctxOf(w, 2), 'barbarian', 3, 10, me.pos, { x: 0, y: 0, z: 0 });
    expect(npcs.every((n) => n.npc!.summonerId === me.id && n.npc!.ai.goalZ === 0)).toBe(true);
  });

  it('crosshairEnemy resolves the entity under the crosshair and skips own side', () => {
    const w = setup();
    const me = hero(w, 2);
    const foe = hero(w, 3);
    place(w, me, 0, 30);
    place(w, foe, 0, 20);
    w.step();
    const ctx = ctxOf(w, 2);
    w.heroRt(me.id)!.input = { ...w.inputOf(me), yaw: 0.06, pitch: -0.05, aimTargetId: foe.id };
    expect(crosshairEnemy({ ...ctx, input: w.inputOf(me) }, 30)?.id).toBe(foe.id);
    const [troop] = w.spawnTroops(me.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 25 });
    w.heroRt(me.id)!.input = { ...w.inputOf(me), aimTargetId: troop.id };
    expect(crosshairEnemy({ ...ctx, input: w.inputOf(me) }, 30)?.id).not.toBe(troop.id);
  });
});
