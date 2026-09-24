import { describe, expect, it } from 'vitest';
import type { Entity } from '../../../src/core/types';
import type { World } from '../../../src/sim/world';
import { chest, events, giveAndUse, hold, inject, place, setup, slotCount, stepN, ticks } from './helpers';

const TRAP_AT = { x: 0, y: 0, z: 26 }; // 6 m in front of the user at (0, 20)

function trapOf(w: World, kind: string): Entity | undefined {
  return w.kindList('hazard').find((h) => h.hazard!.kind === kind);
}

/** Step until sim time `t` (absolute). */
function stepTo(w: World, t: number): void {
  while (w.time < t - 1e-9) w.step();
}

/** Place a trap (0.5 s channel); returns the sim time it was laid at. */
function layTrap(w: World, a: Entity, itemId: 'lebusishu' | 'bingliang'): number {
  giveAndUse(w, a, itemId, TRAP_AT);
  hold(w, a, ticks(0.55), TRAP_AT); // 0.5 s placing channel
  expect(slotCount(a)).toBe(0);
  const trap = w.kindList('hazard').find((h) => h.hazard!.kind.endsWith('Trap'))!;
  return trap.hazard!.params.armAt - 1;
}

describe('乐不思蜀 lebusishu (trap)', () => {
  it('arms after 1 s, then the first enemy hero inside dances 3 s and the trap is gone', () => {
    const { w, a, b } = setup();
    const laid = layTrap(w, a, 'lebusishu');
    const trap = trapOf(w, 'lebusishuTrap')!;
    expect(trap).toBeDefined();
    expect(Math.hypot(trap.pos.x - TRAP_AT.x, trap.pos.z - TRAP_AT.z)).toBeLessThan(0.1);
    expect(trap.hazard!.radius).toBe(2.5);
    place(w, b, 1, 26); // steps in before it is armed
    stepTo(w, laid + 0.95);
    expect(w.hasStatus(b.id, 'dance')).toBe(false);
    stepTo(w, laid + 1.15);
    expect(w.hasStatus(b.id, 'dance')).toBe(true);
    expect(trapOf(w, 'lebusishuTrap')).toBeUndefined();
    stepN(w, ticks(3.1));
    expect(w.hasStatus(b.id, 'dance')).toBe(false);
  });

  it('ignores its owner, the owner’s soldiers, enemy soldiers and downed heroes', () => {
    const { w, a, b } = setup();
    layTrap(w, a, 'lebusishu');
    stepN(w, ticks(1.1));
    const [own] = w.spawnTroops(a.id, 'qun_raider', 1, { x: 0.5, y: 0, z: 26 });
    const [foe] = w.spawnTroops(b.id, 'qun_raider', 1, { x: -0.5, y: 0, z: 26 });
    place(w, a, 0, 25.5);
    w.dealDamage({ targetId: b.id, amount: 1e4, type: 'true' });
    place(w, b, 0, 26.5);
    stepN(w, ticks(0.5));
    expect(trapOf(w, 'lebusishuTrap')).toBeDefined();
    for (const e of [a, own, foe, b]) expect(w.hasStatus(e.id, 'dance')).toBe(false);
  });

  it('is hidden from enemies beyond stealth range but always visible to its owner', () => {
    const { w, a, b } = setup();
    layTrap(w, a, 'lebusishu');
    const trap = trapOf(w, 'lebusishuTrap')!;
    const sees = (player: string): boolean => w.snapshotFor(player).ents.some((v) => v.id === trap.id);
    expect(sees(a.hero!.playerId)).toBe(true);
    expect(sees(b.hero!.playerId)).toBe(false); // b is ~50 m away
    place(w, b, 0, 33); // 7 m from the trap, outside its radius
    w.step();
    expect(sees(b.hero!.playerId)).toBe(true);
    place(w, a, -40, -40);
    w.step();
    expect(sees(a.hero!.playerId)).toBe(true);
  });

  it('无懈可击 is consumed by the trap springing (no dance)', () => {
    const { w, a, b } = setup();
    layTrap(w, a, 'lebusishu');
    w.applyStatus(b.id, 'nullify', 30, { sourceId: b.id });
    stepN(w, ticks(1.1));
    place(w, b, 0, 26);
    stepN(w, 5);
    expect(w.hasStatus(b.id, 'dance')).toBe(false);
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
    expect(trapOf(w, 'lebusishuTrap')).toBeUndefined();
  });

  it('a hero immune to dance (谦逊) walks over it; the next enemy hero springs it', () => {
    const { w, a, b, c } = setup();
    layTrap(w, a, 'lebusishu');
    inject(w, b, { id: 't_qianxun', canBeAffected: (_ctx, s) => s !== 'dance' });
    stepN(w, ticks(1.1));
    place(w, b, 0, 26);
    stepN(w, 5);
    expect(w.hasStatus(b.id, 'dance')).toBe(false);
    expect(trapOf(w, 'lebusishuTrap')).toBeDefined();
    place(w, b, 20, 26);
    place(w, c, 0.5, 26);
    stepN(w, 5);
    expect(w.hasStatus(c.id, 'dance')).toBe(true);
  });

  it('expires after 60 s', () => {
    const { w, a } = setup();
    const laid = layTrap(w, a, 'lebusishu');
    stepTo(w, laid + 59.9);
    expect(trapOf(w, 'lebusishuTrap')).toBeDefined();
    stepTo(w, laid + 60.1);
    expect(trapOf(w, 'lebusishuTrap')).toBeUndefined();
  });
});

describe('兵粮寸断 bingliang (trap)', () => {
  it('roots the first enemy hero 2.5 s and halves the reserve ammo of both weapons', () => {
    const { w, a, b } = setup();
    layTrap(w, a, 'bingliang');
    expect(trapOf(w, 'bingliangTrap')).toBeDefined();
    const [w0, w1] = b.hero!.weapons;
    w0!.reserve = 90;
    w1!.reserve = 41;
    const mag = w0!.mag;
    stepN(w, ticks(1.1));
    place(w, b, 0, 27);
    stepN(w, 5);
    expect(w.hasStatus(b.id, 'root')).toBe(true);
    expect(w0!.reserve).toBe(45);
    expect(w1!.reserve).toBe(20);
    expect(w0!.mag).toBe(mag);
    stepN(w, ticks(2.6));
    expect(w.hasStatus(b.id, 'root')).toBe(false);
    expect(events(w.drainEvents(), 'sfx').some((e) => e.name === 'trap')).toBe(true);
  });
});

describe('闪电 shandian (storm cloud)', () => {
  it('forms at the aim point, sits on the nearest hero and strikes 70 thunder every 3 s', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 32);
    w.step();
    const hb = b.hp;
    giveAndUse(w, a, 'shandian', { x: 0, y: 0, z: 32 });
    hold(w, a, ticks(0.55), chest(a));
    expect(slotCount(a)).toBe(0);
    const cloud = trapOf(w, 'shandian')!;
    expect(cloud).toBeDefined();
    expect(cloud.hazard!.radius).toBe(3);
    const first = cloud.hazard!.nextTickAt;
    expect(first - (cloud.hazard!.expiresAt - 18)).toBeCloseTo(3, 5);
    stepTo(w, first - 0.1);
    expect(b.hp).toBe(hb);
    stepTo(w, first + 0.1);
    expect(hb - b.hp).toBe(70);
    expect(events(w.drainEvents(), 'explosion').some((e) => e.kind === 'thunder')).toBe(true);
    stepN(w, ticks(3));
    expect(hb - b.hp).toBe(140);
    expect(a.hp).toBe(a.maxHp);
  });

  it('drifts at 3.5 m/s toward the nearest hero — and can strike its own summoner', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'shandian', { x: 0, y: 0, z: 30 }); // nobody else near: a is the nearest hero
    hold(w, a, ticks(0.55), chest(a));
    const cloud = trapOf(w, 'shandian')!;
    const first = cloud.hazard!.nextTickAt;
    const d0 = Math.hypot(cloud.pos.x - a.pos.x, cloud.pos.z - a.pos.z);
    stepN(w, 30);
    const d1 = Math.hypot(cloud.pos.x - a.pos.x, cloud.pos.z - a.pos.z);
    expect(d0 - d1).toBeCloseTo(3.5, 1);
    stepTo(w, first + 0.1);
    expect(a.maxHp - a.hp).toBe(70);
  });

  it('a bolt consumes 无懈可击; the cloud dissipates after 18 s', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 32);
    w.applyStatus(b.id, 'nullify', 60, { sourceId: b.id });
    w.step();
    const hb = b.hp;
    giveAndUse(w, a, 'shandian', { x: 0, y: 0, z: 32 });
    hold(w, a, ticks(0.55), chest(a));
    const cloud = trapOf(w, 'shandian')!;
    const first = cloud.hazard!.nextTickAt;
    const end = cloud.hazard!.expiresAt;
    stepTo(w, first + 0.1);
    expect(b.hp).toBe(hb);
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
    stepTo(w, first + 3.1);
    expect(hb - b.hp).toBe(70);
    stepTo(w, end - 0.1);
    expect(trapOf(w, 'shandian')).toBeDefined();
    expect(hb - b.hp).toBe(70 * 4); // bolts at 3, 6, 9, 12, 15 s; the first was cancelled; 18 s = gone
    stepTo(w, end + 0.1);
    expect(trapOf(w, 'shandian')).toBeUndefined();
  });
});
