// 濒死 (downed) the PUBG / Apex way: crawling, a revive pauses the bleed-out, enemies can
// finish a downed hero, F calls for a 桃, a downed hero can still ping.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent } from '../../../src/core/types';
import { BTN_FIRE, BTN_INTERACT, BTN_SPRINT, VF_DOWNED, VF_REVIVING, emptyInput } from '../../../src/core/types';
import { DOWNED_DAMAGE_TO_SECONDS } from '../../../src/sim/combat';
import { DOWNED_MUL, WALK_SPEED } from '../../../src/sim/physics';
import { BLEED_OUT_TIME, REVIVE_TIME } from '../../../src/sim/rules';
import { HELP_CALL_GAP, type World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

const TPS = 30;

function world5(): World {
  const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
  [0, 1, 2, 3, 4].forEach((i) => place(w, hero(w, i), i * 8 - 16, 30));
  w.step();
  w.drainEvents();
  return w;
}

function down(w: World, victim: Entity, by: Entity): void {
  w.dealDamage({ targetId: victim.id, sourceId: by.id, amount: 5000, type: 'true' });
  expect(victim.hero!.downed).toBe(true);
}

const remaining = (w: World, e: Entity): number => e.hero!.downedUntil - w.time;
const yawTo = (from: Entity, to: Entity): number => Math.atan2(-(to.pos.x - from.pos.x), -(to.pos.z - from.pos.z));

/** `rescuer` (player p<seat>) holds F on `target` for `ticks` ticks. */
function holdRevive(w: World, rescuer: Entity, target: Entity, ticks: number, seq = 1): void {
  const pid = `p${rescuer.hero!.seat}`;
  const yaw = yawTo(rescuer, target);
  w.setInput(pid, { ...emptyInput(seq), yaw, aimTargetId: target.id, buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
  w.step();
  w.setInput(pid, { ...emptyInput(seq + 1), yaw, aimTargetId: target.id, buttons: BTN_INTERACT });
  stepN(w, ticks - 1);
}

function ofType<T extends GameEvent['t']>(evs: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] {
  return evs.filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);
}

describe('downed: crawling', () => {
  it('a downed hero crawls at WALK_SPEED × DOWNED_MUL — no sprint, no fire', () => {
    const w = world5();
    const rebel = hero(w, 2);
    down(w, rebel, hero(w, 1));
    const z0 = rebel.pos.z;
    const mag = rebel.hero!.weapons[rebel.hero!.activeSlot]?.mag;
    w.setInput('p2', { ...emptyInput(1), moveZ: 1, yaw: 0, buttons: BTN_SPRINT | BTN_FIRE });
    stepN(w, TPS * 2);
    const speed = (z0 - rebel.pos.z) / 2;
    expect(speed).toBeGreaterThan(WALK_SPEED * DOWNED_MUL * 0.85);
    expect(speed).toBeLessThan(WALK_SPEED * DOWNED_MUL * 1.05);
    expect(rebel.hero!.sprinting).toBe(false);
    expect(rebel.hero!.weapons[rebel.hero!.activeSlot]?.mag).toBe(mag);
  });
});

describe('downed: a revive pauses the bleed-out', () => {
  it('hold F: the bleed-out clock stands still while the channel runs; the downed hero sees who and how far', () => {
    const w = world5();
    const [lord, loyal] = [hero(w, 0), hero(w, 1)];
    place(w, loyal, lord.pos.x + 1.2, lord.pos.z);
    down(w, lord, hero(w, 2));
    loyal.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    stepN(w, TPS * 2);
    const before = remaining(w, lord);
    holdRevive(w, loyal, lord, Math.round(TPS * REVIVE_TIME * 0.6));
    expect(loyal.hero!.channel?.kind).toBe('revive');
    // paused: at most the tick the channel started on went by
    expect(remaining(w, lord)).toBeGreaterThan(before - 2 / TPS);
    expect(lord.hero!.rescue?.by).toBe(loyal.id);
    const snap = w.snapshotFor('p0');
    expect(snap.you!.rescue?.by).toBe(loyal.id);
    expect(snap.you!.rescue!.progress).toBeGreaterThan(0.4);
    expect(snap.you!.rescue!.progress).toBeLessThan(0.8);
    // the reviver's HUD knows whom he is reviving (the progress ring)
    expect(w.snapshotFor('p1').you!.channel).toMatchObject({ kind: 'revive', revive: lord.id });
    const pub = w.snapshotFor('p3').ents.find((v) => v.id === lord.id)!;
    expect(pub.flags & VF_DOWNED).toBeTruthy();
    expect(pub.flags & VF_REVIVING).toBeTruthy();
    // let go of F: the channel ends, the clock runs again
    w.setInput('p1', { ...emptyInput(9), buttons: 0 });
    w.step();
    expect(loyal.hero!.channel).toBeNull();
    expect(lord.hero!.rescue).toBeUndefined();
    const held = remaining(w, lord);
    stepN(w, TPS);
    expect(remaining(w, lord)).toBeCloseTo(held - 1, 1);
    expect(w.snapshotFor('p0').you!.rescue).toBeUndefined();
    expect(w.snapshotFor('p3').ents.find((v) => v.id === lord.id)!.flags & VF_REVIVING).toBe(0);
  });

  it('a revive started with 1 s of bleed-out left still lands (1.5 s channel)', () => {
    const w = world5();
    const [lord, loyal] = [hero(w, 0), hero(w, 1)];
    place(w, loyal, lord.pos.x + 1.2, lord.pos.z);
    down(w, lord, hero(w, 2));
    loyal.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    stepN(w, Math.round(TPS * (BLEED_OUT_TIME - 1)));
    expect(lord.hero!.downed).toBe(true);
    holdRevive(w, loyal, lord, Math.round(TPS * REVIVE_TIME) + 4);
    expect(lord.hero!.dead).toBe(false);
    expect(lord.hero!.downed).toBe(false);
    expect(lord.hp).toBe(100);
    expect(lord.hero!.rescue).toBeUndefined();
  });

  it('a 桃 used from the item bar on a downed hero (the bots\' way) pauses it too', () => {
    const w = world5();
    const [lord, loyal] = [hero(w, 0), hero(w, 1)];
    place(w, loyal, lord.pos.x + 1.2, lord.pos.z);
    down(w, lord, hero(w, 2));
    loyal.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    stepN(w, TPS);
    const before = remaining(w, lord);
    w.setInput('p1', { ...emptyInput(1), yaw: yawTo(loyal, lord), aimTargetId: lord.id, actions: [{ a: 'item', slot: 0 }] });
    stepN(w, TPS);
    expect(loyal.hero!.channel?.kind).toBe('item');
    expect(lord.hero!.rescue?.by).toBe(loyal.id);
    expect(remaining(w, lord)).toBeGreaterThan(before - 2 / TPS);
    stepN(w, TPS);
    expect(lord.hero!.downed).toBe(false);
  });

  it("eating his own 桃 while downed does not pause it (C3-6); his channel says whom it revives", () => {
    const w = world5();
    const rebel = hero(w, 2);
    down(w, rebel, hero(w, 1));
    rebel.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    stepN(w, TPS * 2);
    const before = remaining(w, rebel);
    w.setInput('p2', { ...emptyInput(1), actions: [{ a: 'item', slot: 0 }] });
    stepN(w, TPS);
    expect(rebel.hero!.rescue).toBeUndefined();
    expect(remaining(w, rebel)).toBeCloseTo(before - 1, 1);
    expect(w.snapshotFor('p2').you!.channel).toMatchObject({ kind: 'item', revive: rebel.id });
    expect(w.snapshotFor('p2').you!.rescue).toBeUndefined();
    expect(w.snapshotFor('p1').ents.find((v) => v.id === rebel.id)!.flags & VF_REVIVING).toBe(0);
    stepN(w, TPS);
    expect(rebel.hero!.downed).toBe(false);
  });

  it('no pause without a rescuer: the full bleed-out still kills', () => {
    const w = world5();
    const rebel = hero(w, 2);
    down(w, rebel, hero(w, 1));
    stepN(w, Math.round(TPS * BLEED_OUT_TIME) + 2);
    expect(rebel.hero!.dead).toBe(true);
    expect(rebel.hero!.killerId).toBe(hero(w, 1).id);
  });
});

describe('downed: finishing a downed hero', () => {
  it('damage shortens the bleed-out; enough of it kills, credited to the finisher', () => {
    const w = world5();
    const [loyal, rebel, rebel2] = [hero(w, 1), hero(w, 2), hero(w, 3)];
    down(w, rebel, loyal);
    const r0 = remaining(w, rebel);
    w.dealDamage({ targetId: rebel.id, sourceId: rebel2.id, amount: 30, type: 'true' });
    expect(remaining(w, rebel)).toBeCloseTo(r0 - 30 * DOWNED_DAMAGE_TO_SECONDS, 3);
    expect(rebel.hero!.dead).toBe(false);
    w.dealDamage({ targetId: rebel.id, sourceId: rebel2.id, amount: 500, type: 'true' });
    expect(rebel.hero!.dead).toBe(true);
    expect(rebel.hero!.killerId).toBe(rebel2.id);
    const evs = w.drainEvents();
    expect(ofType(evs, 'death').find((d) => d.target === rebel.id)?.killer).toBe(rebel2.id);
  });

  it('a revive under fire is lost: the pause never shields a downed hero from damage', () => {
    const w = world5();
    const [lord, loyal, rebel] = [hero(w, 0), hero(w, 1), hero(w, 2)];
    place(w, loyal, lord.pos.x + 1.2, lord.pos.z);
    down(w, lord, rebel);
    loyal.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    holdRevive(w, loyal, lord, 10);
    expect(lord.hero!.rescue).toBeDefined();
    w.dealDamage({ targetId: lord.id, sourceId: rebel.id, amount: 5000, type: 'true' });
    expect(lord.hero!.dead).toBe(true);
    expect(lord.hero!.killerId).toBe(rebel.id);
    w.step();
    expect(loyal.hero!.channel).toBeNull();
    expect(loyal.hero!.items[0]).toEqual({ id: 'tao', count: 1 });
  });
});

describe('downed: calling for help and pinging', () => {
  it('F while downed sends 「需要桃！」 at most every HELP_CALL_GAP s', () => {
    const w = world5();
    const rebel = hero(w, 2);
    down(w, rebel, hero(w, 1));
    w.drainEvents();
    const calls = (): number => ofType(w.drainEvents(), 'quickchat').filter((q) => q.who === rebel.id && q.id === 'needPeach').length;
    w.setInput('p2', { ...emptyInput(1), buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    w.step();
    expect(calls()).toBe(1);
    w.setInput('p2', { ...emptyInput(2), buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    w.step();
    expect(calls()).toBe(0);
    stepN(w, Math.round(TPS * HELP_CALL_GAP));
    w.setInput('p2', { ...emptyInput(3), buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    w.step();
    expect(calls()).toBe(1);
  });

  it('F on its feet is still interact (no call for help)', () => {
    const w = world5();
    const rebel = hero(w, 2);
    w.setInput('p2', { ...emptyInput(1), buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    w.step();
    expect(ofType(w.drainEvents(), 'quickchat')).toHaveLength(0);
    expect(rebel.hero!.downed).toBe(false);
  });

  it('a downed hero can still mark (ping) the enemy in his crosshair', () => {
    const w = world5();
    const [loyal, rebel] = [hero(w, 1), hero(w, 2)];
    place(w, loyal, 0, 30);
    place(w, rebel, 0, 20);
    down(w, loyal, rebel);
    w.setInput('p1', { ...emptyInput(1), yaw: yawTo(loyal, rebel), pitch: 0, aimTargetId: rebel.id, actions: [{ a: 'mark' }] });
    w.step();
    expect(rebel.statuses.some((s) => s.id === 'marked' && s.sourceId === loyal.id)).toBe(true);
  });
});

