// 濒死 (downed) the PUBG / Apex way: crawling, a revive pauses the bleed-out, enemies can
// finish a downed hero, F calls for a 桃, a downed hero can still ping.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent } from '../../../src/core/types';
import { BTN_FIRE, BTN_INTERACT, BTN_SPRINT, VF_DOWNED, VF_REVIVING, VF_SOUL, emptyInput } from '../../../src/core/types';
import { DOWNED_DAMAGE_TO_SECONDS } from '../../../src/sim/combat';
import { DOWNED_MUL, WALK_SPEED } from '../../../src/sim/physics';
import {
  BLEED_OUT_TIME,
  BLEED_OUT_TIMES,
  DOWNED_FINISH_DAMAGE,
  RECALL_HP,
  RECALL_TIME,
  REVIVE_TIME,
  SOUL_TIME,
  SQUAD_AID_HP,
  SQUAD_AID_TIME,
} from '../../../src/sim/rules';
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
    // (nothing of his own in the death box beside the reviver: the 桃 counted below is the reviver's)
    lord.hero!.items = [null, null, null, null];
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


describe('downed: each knock in one life bleeds out faster', () => {
  it('30 → 20 → 12 s; the snapshot carries the full bleed-out; 120 damage finishes any knock', () => {
    const w = world5();
    const [lord, loyal, rebel] = [hero(w, 0), hero(w, 1), hero(w, 2)];
    expect(BLEED_OUT_TIME).toBe(30);
    for (let k = 0; k < 4; k++) {
      down(w, rebel, loyal);
      const want = BLEED_OUT_TIMES[Math.min(k, BLEED_OUT_TIMES.length - 1)];
      expect(rebel.hero!.downedTotal).toBe(want);
      expect(remaining(w, rebel)).toBeCloseTo(want, 3);
      expect(w.snapshotFor('p2').you!.downedTotal).toBe(want);
      // hits drain it in proportion: half the finishing damage takes half the time
      w.dealDamage({ targetId: rebel.id, sourceId: lord.id, amount: DOWNED_FINISH_DAMAGE / 2, type: 'true' });
      expect(remaining(w, rebel)).toBeCloseTo(want / 2, 3);
      expect(rebel.hero!.dead).toBe(false);
      w.revive(rebel.id, 100, loyal.id);
      expect(rebel.hero!.downed).toBe(false);
      expect(rebel.hero!.downedTotal).toBeUndefined();
    }
    down(w, rebel, loyal);
    w.dealDamage({ targetId: rebel.id, sourceId: lord.id, amount: DOWNED_FINISH_DAMAGE + 1, type: 'true' });
    expect(rebel.hero!.dead).toBe(true);
  });
});

describe('death box', () => {
  it("a dead hero's cards, armor and sidearm lie at his body", () => {
    const w = world5();
    const [loyal, rebel] = [hero(w, 1), hero(w, 2)];
    rebel.hero!.items = [{ id: 'tao', count: 2 }, { id: 'jiu', count: 1 }, null, null];
    down(w, rebel, loyal);
    w.dealDamage({ targetId: rebel.id, sourceId: loyal.id, amount: 5000, type: 'true' });
    expect(rebel.hero!.dead).toBe(true);
    expect(rebel.hero!.items.every((s) => s === null)).toBe(true);
    const near = w.queryRadius(rebel.pos, 4, { kinds: ['loot'] }).map((l) => l.loot!.itemId);
    expect(near).toContain('tao');
    expect(near).toContain('jiu');
  });
});

describe('战场急救: your own soldiers bandage you', () => {
  function squadWorld(): { w: World; lord: Entity; rebel: Entity; squad: Entity[] } {
    const w = world5();
    const [lord, rebel] = [hero(w, 0), hero(w, 2)];
    place(w, lord, -30, 30);
    place(w, rebel, 30, 30);
    const squad = w.spawnTroops(lord.id, 'shu_rifleman', 3, { x: -30, y: 0, z: 36 });
    w.step();
    return { w, lord, rebel, squad };
  }

  it('nobody hostile near: the nearest soldier runs over, bandages for SQUAD_AID_TIME s (bleed-out paused) and is spent', () => {
    const { w, lord, rebel, squad } = squadWorld();
    down(w, lord, rebel);
    w.drainEvents();
    let started = -1;
    for (let i = 0; i < TPS * 12 && lord.hero!.downed; i++) {
      w.step();
      if (started < 0 && lord.hero!.rescue?.squad) {
        started = w.time;
        const snap = w.snapshotFor('p0');
        expect(snap.you!.rescue?.squad).toBe(true);
        expect(w.snapshotFor("p3").ents.find((v) => v.id === lord.id)!.flags & VF_REVIVING).toBeTruthy();
      }
    }
    expect(started).toBeGreaterThan(0);
    expect(lord.hero!.downed).toBe(false);
    expect(lord.hp).toBe(SQUAD_AID_HP);
    expect(w.time - started).toBeGreaterThanOrEqual(SQUAD_AID_TIME - 0.05);
    // the bleed-out never ran out meanwhile, and one soldier gave everything
    expect(squad.filter((s) => s.alive).length).toBe(2);
    const rev = ofType(w.drainEvents(), 'revived').find((e) => e.target === lord.id);
    expect(rev).toMatchObject({ squad: true });
  });

  it('a hostile hero close by: the squad fights instead — and a hit breaks the bandaging', () => {
    const { w, lord, rebel } = squadWorld();
    place(w, rebel, -24, 30);
    down(w, lord, rebel);
    stepN(w, TPS * 4);
    expect(lord.hero!.rescue).toBeUndefined();
    // the rebel walks off: bandaging starts; a hit on the commander breaks it
    place(w, rebel, 40, -40);
    for (let i = 0; i < TPS * 8 && !lord.hero!.rescue; i++) w.step();
    expect(lord.hero!.rescue?.squad).toBe(true);
    w.dealDamage({ targetId: lord.id, sourceId: rebel.id, amount: 5, type: 'true' });
    w.step();
    expect(lord.hero!.rescue).toBeUndefined();
  });
});

describe('招魂: a fallen hero can be called back once', () => {
  function killed(): { w: World; loyal: Entity; rebel: Entity; lord: Entity } {
    const w = world5();
    const [lord, loyal, rebel] = [hero(w, 0), hero(w, 1), hero(w, 2)];
    place(w, lord, -30, -30);
    place(w, loyal, 0, 30);
    place(w, rebel, 20, 30);
    loyal.hero!.items = [null, null, null, null];
    down(w, loyal, rebel);
    w.dealDamage({ targetId: loyal.id, sourceId: rebel.id, amount: 5000, type: 'true' });
    expect(loyal.hero!.dead).toBe(true);
    return { w, loyal, rebel, lord };
  }

  it('his 魂幡 stands SOUL_TIME s; holding F at the body for RECALL_TIME s brings him back with RECALL_HP', () => {
    const { w, loyal, lord } = killed();
    w.step();
    expect(w.snapshotFor("p3").ents.find((v) => v.id === loyal.id)!.flags & VF_SOUL).toBeTruthy();
    expect(w.snapshotFor('p1').you!.soul!.remaining).toBeGreaterThan(SOUL_TIME - 1);
    place(w, lord, loyal.pos.x + 1.4, loyal.pos.z);
    holdRevive(w, lord, loyal, Math.round(TPS * RECALL_TIME * 0.5));
    expect(lord.hero!.channel).toMatchObject({ kind: 'revive', recall: true });
    expect(w.snapshotFor('p1').you!.soul).toMatchObject({ by: lord.id });
    stepN(w, Math.round(TPS * RECALL_TIME * 0.5) + 3);
    expect(loyal.hero!.dead).toBe(false);
    expect(loyal.alive).toBe(true);
    expect(loyal.hp).toBe(RECALL_HP);
    expect(loyal.hero!.squad).toEqual([]);
    expect(loyal.hero!.roleRevealed).toBe(true);
    expect(ofType(w.drainEvents(), 'revived').find((e) => e.target === loyal.id)).toMatchObject({ recall: true, by: lord.id });
    // a moment of protection, then — once per match — the next death leaves no 魂幡
    w.dealDamage({ targetId: loyal.id, sourceId: lord.id, amount: 5000, type: 'true' });
    expect(loyal.hero!.downed).toBe(false);
    stepN(w, TPS * 3);
    down(w, loyal, lord);
    w.dealDamage({ targetId: loyal.id, sourceId: lord.id, amount: 5000, type: 'true' });
    expect(loyal.hero!.dead).toBe(true);
    expect(loyal.hero!.soul).toBeUndefined();
  });

  it('letting go breaks it; the 魂幡 falls after SOUL_TIME s', () => {
    const { w, loyal, lord } = killed();
    place(w, lord, loyal.pos.x + 1.4, loyal.pos.z);
    holdRevive(w, lord, loyal, 10);
    expect(lord.hero!.channel?.recall).toBe(true);
    w.setInput('p0', { ...emptyInput(9), yaw: lord.yaw });
    w.step();
    expect(lord.hero!.channel).toBeNull();
    stepN(w, Math.round(TPS * SOUL_TIME) + 2);
    expect(loyal.hero!.soul).toBeUndefined();
    expect(w.snapshotFor('p1').you!.soul).toBeUndefined();
  });
});
