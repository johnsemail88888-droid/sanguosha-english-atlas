import { describe, expect, it } from 'vitest';
import type { Entity } from '../../../src/core/types';
import type { ItemImplEx } from '../../../src/sim/ext';
import { getItem } from '../../../src/sim/items';
import type { World } from '../../../src/sim/world';
import { makeTestMap } from '../sim/helpers';
import { aimFrame, chest, events, giveAndUse, hold, inject, place, send, setup, slotCount, stepN, ticks } from './helpers';

const should = (w: World, e: Entity, id: string): boolean => (getItem(id) as ItemImplEx).botShouldUse!(w, e);
const flat = (p: { x: number; z: number }, q: { x: number; z: number }): number => Math.hypot(p.x - q.x, p.z - q.z);

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

  it('placing it publishes no position: the itemUse event carries no point (hidden trap)', () => {
    const { w, a } = setup();
    giveAndUse(w, a, 'lebusishu', TRAP_AT);
    hold(w, a, ticks(0.55), TRAP_AT);
    const ev = events(w.drainEvents(), 'itemUse');
    expect(ev).toHaveLength(1);
    expect(ev[0].pos).toBeUndefined();
    expect(ev[0].target).toBe(a.id);
    const trap = trapOf(w, 'lebusishuTrap')!;
    expect(flat(trap.pos, TRAP_AT)).toBeLessThan(0.1); // still laid at the crosshair
  });

  it('is laid at most `range` (8 m) away when aimed further', () => {
    const { w, a } = setup();
    const far = { x: 0, y: 0, z: 40 };
    giveAndUse(w, a, 'bingliang', far);
    hold(w, a, ticks(0.55), far);
    const trap = trapOf(w, 'bingliangTrap')!;
    expect(flat(trap.pos, a.pos)).toBeLessThanOrEqual(8.01);
  });

  it('only springs on its own level: a hero on a bridge or floor above walks over it', () => {
    const { w, a, b } = setup();
    layTrap(w, a, 'lebusishu');
    const trap = trapOf(w, 'lebusishuTrap')!;
    stepN(w, ticks(1.1));
    trap.pos.y -= 2; // the trap lies on the level 2 m below b (inside its 2.5 m radius)
    place(w, b, 0, 26);
    stepN(w, 5);
    expect(w.hasStatus(b.id, 'dance')).toBe(false);
    expect(trapOf(w, 'lebusishuTrap')).toBeDefined();
    trap.pos.y += 1; // 1 m below: same level (slopes, steps)
    stepN(w, 5);
    expect(w.hasStatus(b.id, 'dance')).toBe(true);
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

  it('never chases a hero in stealth (the public cloud would give it away) until it is revealed', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 33);
    w.applyStatus(b.id, 'stealth', 30, { sourceId: b.id, params: { keep: 1 } });
    w.step();
    giveAndUse(w, a, 'shandian', { x: 0, y: 0, z: 31 });
    hold(w, a, ticks(0.55), chest(a));
    const cloud = trapOf(w, 'shandian')!;
    const toA = flat(cloud.pos, a.pos);
    const toB = flat(cloud.pos, b.pos);
    expect(toB).toBeLessThan(toA); // b is the nearest hero…
    stepN(w, 30);
    expect(flat(cloud.pos, a.pos)).toBeCloseTo(toA - 3.5, 1); // …but invisible: the cloud drifts to a
    expect(flat(cloud.pos, b.pos)).toBeGreaterThan(toB);
    // revealed to everyone: fair game again
    w.applyStatus(b.id, 'reveal', 10, { sourceId: a.id });
    const before = flat(cloud.pos, b.pos);
    stepN(w, 15);
    expect(flat(cloud.pos, b.pos)).toBeLessThan(before - 1);
  });

  it('ignores downed heroes and hangs still when nobody is in plain sight', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 33);
    w.step();
    giveAndUse(w, a, 'shandian', { x: 0, y: 0, z: 31 });
    hold(w, a, ticks(0.55), chest(a));
    const cloud = trapOf(w, 'shandian')!;
    w.dealDamage({ targetId: b.id, amount: 1e4, type: 'true' });
    expect(b.hero!.downed).toBe(true);
    for (const e of w.heroList()) if (e !== b) w.applyStatus(e.id, 'stealth', 30, { sourceId: e.id, params: { keep: 1 } });
    const p0 = { ...cloud.pos };
    stepN(w, 30);
    expect(flat(cloud.pos, p0)).toBeLessThan(1e-6);
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

describe('trap bot hints (botShouldUse picks the moment and the spot)', () => {
  /** a fights b (b under its crosshair), as a bot brain would set it */
  function fighting(w: World, a: Entity, b: Entity): void {
    send(w, a, aimFrame(w, a, chest(b), { aimTargetId: b.id }));
    w.step();
  }

  it('an enemy hero charging in: the trap goes on its path, far enough out to be armed in time', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 36);
    fighting(w, a, b);
    expect(should(w, a, 'lebusishu')).toBe(false); // standing still, nothing to do yet
    b.vel.z = -5; // running at a
    expect(should(w, a, 'lebusishu')).toBe(true);
    // the card lands where the hint decided, whatever the crosshair says
    const side = { x: 6, y: 0, z: 22 };
    giveAndUse(w, a, 'lebusishu', side);
    hold(w, a, ticks(0.55), side);
    const trap = trapOf(w, 'lebusishuTrap')!;
    expect(Math.abs(trap.pos.x)).toBeLessThan(0.5); // on b's line, not at the crosshair
    expect(trap.pos.z).toBeGreaterThan(24);
    expect(trap.pos.z).toBeLessThan(28.5); // ≤ 8 m from a, ≥ 1.6 s of running from b
  });

  it('retreating from a hostile: the trap goes right behind the bot; not twice within 4 s', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 36);
    fighting(w, a, b);
    a.vel.z = -4; // backing away from b (b is at +z)
    expect(should(w, a, 'bingliang')).toBe(true);
    giveAndUse(w, a, 'bingliang', chest(b), b);
    hold(w, a, ticks(0.55), chest(b), b);
    const trap = trapOf(w, 'bingliangTrap')!;
    expect(trap.pos.z).toBeGreaterThan(20.5);
    expect(trap.pos.z).toBeLessThan(23);
    a.vel.z = -4;
    expect(should(w, a, 'lebusishu')).toBe(false); // just laid one
  });

  it('hurt and under fire: between the bot and its attacker', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 32);
    a.hp = a.maxHp * 0.3;
    w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 5, type: 'normal', weaponId: 'pistol' });
    fighting(w, a, b);
    expect(should(w, a, 'lebusishu')).toBe(true);
  });

  it('calm: on a loot pile enemies will come for — never in the open for nothing', () => {
    const { w, a } = setup();
    send(w, a, aimFrame(w, a, { x: 0, y: 1, z: 30 }));
    w.step();
    expect(should(w, a, 'lebusishu')).toBe(false); // open field, nobody around
    w.spawnLoot({ x: 3, y: 0, z: 25 }, { itemId: 'tao' });
    w.spawnLoot({ x: 4, y: 0, z: 26 }, { itemId: 'sha' });
    w.step();
    expect(should(w, a, 'lebusishu')).toBe(true);
    giveAndUse(w, a, 'lebusishu', { x: -5, y: 0, z: 22 });
    hold(w, a, ticks(0.55), { x: -5, y: 0, z: 22 });
    const trap = trapOf(w, 'lebusishuTrap')!;
    expect(flat(trap.pos, { x: 3.5, z: 25.5 })).toBeLessThan(1.5);
  });

  it('calm: in a doorway / narrow passage within reach', () => {
    const map = makeTestMap();
    // a wall across the field at z 24.5..27.5 with a 3 m wide opening at x −1.5..1.5
    map.colliders.push({ kind: 'box', cx: -6.5, cy: 1.5, cz: 26, hx: 5, hy: 1.5, hz: 1.5, rot: 0 });
    map.colliders.push({ kind: 'box', cx: 6.5, cy: 1.5, cz: 26, hx: 5, hy: 1.5, hz: 1.5, rot: 0 });
    const { w, a } = setup({ map });
    send(w, a, aimFrame(w, a, { x: 0, y: 1, z: 30 }));
    w.step();
    expect(should(w, a, 'bingliang')).toBe(true);
    giveAndUse(w, a, 'bingliang', { x: 0, y: 1, z: 30 });
    hold(w, a, ticks(0.55), { x: 0, y: 1, z: 30 });
    const trap = trapOf(w, 'bingliangTrap')!;
    expect(Math.abs(trap.pos.x)).toBeLessThan(1.5);
    expect(trap.pos.z).toBeGreaterThan(24.4);
    expect(trap.pos.z).toBeLessThan(27.6);
    // one calm trap at a time: the next doorway waits 20 s
    expect(should(w, a, 'lebusishu')).toBe(false);
  });
});
