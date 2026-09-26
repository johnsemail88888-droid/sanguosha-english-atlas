import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, RoleId } from '../../../src/core/types';
import { BTN_INTERACT, emptyInput } from '../../../src/core/types';
import { evaluateWin, mvpScore, type WinCheckInput } from '../../../src/sim/rules';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

function roster(roles: RoleId[], dead: number[] = [], bountyKills: Record<number, number> = {}): WinCheckInput[] {
  return roles.map((role, i) => ({ id: i + 1, role, dead: dead.includes(i), bountyKills: bountyKills[i] ?? 0 }));
}

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const STD8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];

describe('win conditions (pure)', () => {
  it('game continues while the lord lives and enemies remain', () => {
    expect(evaluateWin(roster(STD5))).toBeNull();
    expect(evaluateWin(roster(STD5, [2]))).toBeNull();
    expect(evaluateWin(roster(STD5, [2, 3]))).toBeNull(); // traitor alive
    expect(evaluateWin(roster(STD8, [1, 2, 3, 4, 5, 6]))).toBeNull(); // lord vs traitor duel
  });

  it('lord dies → rebels win (all rebels, even dead ones)', () => {
    const r = evaluateWin(roster(STD5, [0]))!;
    expect(r.winner).toBe('rebel');
    expect(r.winners.sort()).toEqual([3, 4]);
    const r2 = evaluateWin(roster(STD5, [0, 2, 3]))!; // every rebel dead, loyalist + traitor alive
    expect(r2.winner).toBe('rebel');
    expect(r2.winners.sort()).toEqual([3, 4]);
    expect(r2.reasonZh.length).toBeGreaterThan(0);
    expect(r2.reasonEn.length).toBeGreaterThan(0);
  });

  it('lord dies with only the traitor left → traitor wins alone', () => {
    const r = evaluateWin(roster(STD5, [0, 1, 2, 3]))!;
    expect(r.winner).toBe('traitor');
    expect(r.winners).toEqual([5]);
    const r8 = evaluateWin(roster(STD8, [0, 1, 2, 3, 4, 5, 6]))!;
    expect(r8.winner).toBe('traitor');
    expect(r8.winners).toEqual([8]);
  });

  it('all rebels and the traitor dead while the lord lives → lord + loyalists (dead ones too) win', () => {
    const r = evaluateWin(roster(STD8, [1, 3, 4, 5, 6, 7]))!;
    expect(r.winner).toBe('lord');
    expect(r.winners.sort()).toEqual([1, 2, 3]);
  });

  it('everyone dead in the same tick → draw', () => {
    const r = evaluateWin(roster(STD5, [0, 1, 2, 3, 4]))!;
    expect(r.winner).toBe('draw');
    expect(r.winners).toEqual([]);
  });

  it('chaos: 影武者 fights for the lord side and is no substitute lord', () => {
    const roles: RoleId[] = ['lord', 'double', 'rebel', 'rebel', 'traitor'];
    const lordSide = evaluateWin(roster(roles, [2, 3, 4]))!;
    expect(lordSide.winner).toBe('lord');
    expect(lordSide.winners.sort()).toEqual([1, 2]);
    // real lord dead, double alive → rebels win
    const reb = evaluateWin(roster(roles, [0]))!;
    expect(reb.winner).toBe('rebel');
    // double dead changes nothing
    expect(evaluateWin(roster(roles, [1]))).toBeNull();
    // lord dead, only traitor + double... double is non-neutral → rebels
    expect(evaluateWin(roster(roles, [0, 2, 3]))!.winner).toBe('rebel');
    expect(evaluateWin(roster(roles, [0, 1, 2, 3]))!.winner).toBe('traitor');
  });

  it('chaos: 墙头草 wins alongside any side if alive, never blocks or causes wins', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'opportunist', 'traitor'];
    const r = evaluateWin(roster(roles, [0]))!;
    expect(r.winner).toBe('rebel');
    expect(r.winners.sort()).toEqual([3, 4]);
    const l = evaluateWin(roster(roles, [2, 4]))!;
    expect(l.winner).toBe('lord');
    expect(l.winners.sort()).toEqual([1, 2, 4]);
    // dead opportunist does not win
    expect(evaluateWin(roster(roles, [2, 3, 4]))!.winners.sort()).toEqual([1, 2]);
    // traitor + opportunist left after the lord died → traitor wins, opportunist too
    const t = evaluateWin(roster(roles, [0, 1, 2]))!;
    expect(t.winner).toBe('traitor');
    expect(t.winners.sort()).toEqual([4, 5]);
    // opportunist alone alive with the lord: the lord side still needs rebels+traitor dead → yes they are
    expect(evaluateWin(roster(roles, [1, 2, 4]))!.winner).toBe('lord');
  });

  it('chaos: 赏金猎人 bonus-wins only with ≥ 1 bounty kill and alive', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'bounty', 'traitor'];
    const withKill = evaluateWin(roster(roles, [0], { 4: 1 }))!;
    expect(withKill.winner).toBe('rebel');
    expect(withKill.winners.sort()).toEqual([3, 4, 5]);
    const noKill = evaluateWin(roster(roles, [0]))!;
    expect(noKill.winners.sort()).toEqual([3, 4]);
    const deadHunter = evaluateWin(roster(roles, [0, 4], { 4: 2 }))!;
    expect(deadHunter.winners.sort()).toEqual([3, 4]);
    // the bounty hunter never blocks the lord side win
    const lordWin = evaluateWin(roster(roles, [2, 3, 5], { 4: 1 }))!;
    expect(lordWin.winner).toBe('lord');
    expect(lordWin.winners.sort()).toEqual([1, 2, 5]);
  });

  it('every standard + chaos distribution has a reachable lord win and rebel win', async () => {
    const { ROLE_DISTRIBUTION } = await import('../../../src/data');
    for (const mode of ['standard', 'chaos'] as const) {
      for (const n of [5, 6, 7, 8] as const) {
        for (const roles of ROLE_DISTRIBUTION[mode][n]) {
          const enemies = roles.map((r, i) => (r === 'rebel' || r === 'traitor' ? i : -1)).filter((i) => i >= 0);
          expect(evaluateWin(roster(roles, enemies))?.winner).toBe('lord');
          expect(evaluateWin(roster(roles, [0]))?.winner).toBe('rebel');
          const allButTraitor = roles.map((r, i) => (r === 'traitor' || r === 'opportunist' || r === 'bounty' ? -1 : i)).filter((i) => i >= 0);
          expect(evaluateWin(roster(roles, allButTraitor))?.winner).toBe('traitor');
        }
      }
    }
  });

  it('MVP score formula', () => {
    expect(mvpScore({ kills: 2, damage: 500, healing: 100, rescues: 1 })).toBe(200 + 500 + 50 + 150);
  });
});

// ── in-world rules ──────────────────────────────────────────────────────────
function world5(roles: RoleId[] = STD5): World {
  const w = makeWorld(roles);
  roles.forEach((_, i) => place(w, hero(w, i), i * 6 - 12, 30));
  w.step();
  w.drainEvents();
  return w;
}

const ofType = <T extends GameEvent['t']>(evs: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] =>
  evs.filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);

function kill(w: World, victim: Entity, by: Entity): void {
  w.dealDamage({ targetId: victim.id, sourceId: by.id, amount: 5000, type: 'true' });
  if (!victim.hero!.dead) w.dealDamage({ targetId: victim.id, sourceId: by.id, amount: 5000, type: 'true' });
}

describe('life, death and rewards', () => {
  it('lord and 影武者 get +100 max HP', () => {
    const w = world5(['lord', 'double', 'rebel', 'rebel', 'traitor']);
    expect(hero(w, 0).maxHp).toBe(hero(w, 2).maxHp + 100);
    expect(hero(w, 1).maxHp).toBe(hero(w, 2).maxHp + 100);
  });

  it('bleed-out after 12 s kills and credits whoever downed you', () => {
    const w = world5();
    const [, loyal, rebel] = [hero(w, 0), hero(w, 1), hero(w, 2)];
    w.dealDamage({ targetId: rebel.id, sourceId: loyal.id, amount: 5000, type: 'true' });
    expect(rebel.hero!.downed).toBe(true);
    stepN(w, 30 * 11);
    expect(rebel.hero!.dead).toBe(false);
    stepN(w, 40);
    expect(rebel.hero!.dead).toBe(true);
    expect(rebel.hero!.killerId).toBe(loyal.id);
    const death = ofType(w.drainEvents(), 'death').find((d) => d.target === rebel.id)!;
    expect(death).toMatchObject({ killer: loyal.id, role: 'rebel', kind: 'hero', heroId: rebel.hero!.heroId });
    expect(rebel.hero!.roleRevealed).toBe(true);
  });

  it('killing a rebel draws 3 random items', () => {
    const w = world5();
    const loyal = hero(w, 1);
    const rebel = hero(w, 2);
    loyal.hero!.items = [null, null, null, null];
    kill(w, rebel, loyal);
    const reward = ofType(w.drainEvents(), 'reward')[0];
    expect(reward).toMatchObject({ who: loyal.id, kind: 'rebelKill' });
    expect(reward.items!.length).toBe(3);
    const held = loyal.hero!.items.reduce((n, s) => n + (s?.count ?? 0), 0);
    const dropped = w.kindList('loot').length;
    expect(held + dropped).toBe(3);
  });

  it('the lord killing a loyalist drops every item, armor, mount and the secondary weapon', () => {
    const w = world5();
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    const lh = lord.hero!;
    lh.items = [{ id: 'tao', count: 2 }, { id: 'shan', count: 1 }, null, null];
    lh.armor = 'bagua';
    lh.mount = 'chitu';
    const sec = lh.weapons[1]!.id;
    kill(w, loyal, lord);
    expect(lh.items.every((s) => s === null)).toBe(true);
    expect(lh.armor).toBeNull();
    expect(lh.mount).toBeNull();
    expect(lh.weapons[1]).toBeNull();
    expect(lh.weapons[0]).not.toBeNull();
    const loot = w.kindList('loot').map((l) => l.loot!.itemId ?? l.loot!.weaponId);
    expect(loot.sort()).toEqual(['bagua', 'chitu', sec, 'shan', 'tao'].sort());
    expect(ofType(w.drainEvents(), 'reward').some((r) => r.kind === 'lordPenalty' && r.who === lord.id)).toBe(true);
  });

  it("no lord penalty when the lord's troops land the kill", () => {
    const w = world5();
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    lord.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    const [t] = w.spawnTroops(lord.id, 'shu_rifleman', 1, { x: -12, y: 0, z: 26 });
    w.dealDamage({ targetId: loyal.id, sourceId: t.id, amount: 5000, type: 'true' });
    w.dealDamage({ targetId: loyal.id, sourceId: t.id, amount: 5000, type: 'true' });
    expect(loyal.hero!.dead).toBe(true);
    expect(loyal.hero!.killerId).toBe(lord.id);
    expect(lord.hero!.items[0]).not.toBeNull();
  });

  it("no lord penalty when the lord's summoned NPCs land the kill (黄天 黄巾力士), even after they despawn", () => {
    const w = world5();
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    lord.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    const npc = w.spawnNpc('yellowTurban', { x: -12, y: 0, z: 26 }, { summonerId: lord.id, lifetime: 30 });
    w.dealDamage({ targetId: loyal.id, sourceId: npc.id, amount: 5000, type: 'true' });
    expect(loyal.hero!.downed).toBe(true);
    // the summon is gone before the loyalist bleeds out
    w.removeEntity(npc.id);
    stepN(w, 30 * 13);
    expect(loyal.hero!.dead).toBe(true);
    expect(loyal.hero!.killerId).toBe(lord.id);
    expect(lord.hero!.items[0]).not.toBeNull();
    expect(ofType(w.drainEvents(), 'reward').some((r) => r.kind === 'lordPenalty')).toBe(false);
  });

  it("the lord's own projectile kill still counts as his own hand", () => {
    const w = world5();
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    lord.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    const p = w.spawnProjectile({ kind: 'rocket', ownerId: lord.id, pos: { x: 0, y: 5, z: 0 }, vel: { x: 0, y: 0, z: 1 }, damage: 1, dtype: 'explosive' });
    kill(w, loyal, p);
    expect(loyal.hero!.dead).toBe(true);
    expect(lord.hero!.items[0]).toBeNull();
    expect(ofType(w.drainEvents(), 'reward').some((r) => r.kind === 'lordPenalty' && r.who === lord.id)).toBe(true);
  });

  it("bounty: a kill by the hunter's troops is credited but not paid", () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'bounty', 'traitor'];
    const w = world5(roles);
    const hunter = hero(w, 3);
    const target = w.get(hunter.hero!.bountyTargetId)!;
    const [t] = w.spawnTroops(hunter.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 26 });
    kill(w, target, t);
    expect(target.hero!.dead).toBe(true);
    expect(target.hero!.killerId).toBe(hunter.id);
    expect(w.heroRt(hunter.id)!.bountyKills).toBe(0);
    expect(ofType(w.drainEvents(), 'reward').some((r) => r.kind === 'bounty')).toBe(false);
    // a new target is assigned either way
    expect(hunter.hero!.bountyTargetId).not.toBe(target.id);
  });

  it('revive: hold F with a 桃 for 1.5 s → 100 HP, 桃 consumed, rescue counted; releasing F cancels', () => {
    const w = world5();
    const lord = hero(w, 0);
    const loyal = hero(w, 1);
    place(w, loyal, lord.pos.x + 1.2, lord.pos.z);
    w.dealDamage({ targetId: lord.id, sourceId: hero(w, 2).id, amount: 5000, type: 'true' });
    expect(lord.hero!.downed).toBe(true);
    loyal.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    const yaw = Math.atan2(-(lord.pos.x - loyal.pos.x), -(lord.pos.z - loyal.pos.z));
    // press F then release early
    w.setInput('p1', { ...emptyInput(1), yaw, aimTargetId: lord.id, buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    stepN(w, 10);
    expect(loyal.hero!.channel?.kind).toBe('revive');
    w.setInput('p1', { ...emptyInput(2), yaw, aimTargetId: lord.id, buttons: 0 });
    w.step();
    expect(loyal.hero!.channel).toBeNull();
    // hold the full duration
    w.setInput('p1', { ...emptyInput(3), yaw, aimTargetId: lord.id, buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    stepN(w, 50);
    expect(lord.hero!.downed).toBe(false);
    expect(lord.hp).toBe(100);
    expect(loyal.hero!.items[0]).toBeNull();
    expect(loyal.hero!.stats.rescues).toBe(1);
  });

  it('酒 lets a downed hero get back up with 50 HP', () => {
    const w = world5();
    const rebel = hero(w, 2);
    rebel.hero!.items = [{ id: 'jiu', count: 1 }, null, null, null];
    w.dealDamage({ targetId: rebel.id, sourceId: hero(w, 1).id, amount: 5000, type: 'true' });
    expect(rebel.hero!.downed).toBe(true);
    w.setInput('p2', { ...emptyInput(1), actions: [{ a: 'item', slot: 0 }] });
    stepN(w, 25);
    expect(rebel.hero!.downed).toBe(false);
    expect(rebel.hp).toBe(50);
    expect(rebel.hero!.items[0]).toBeNull();
  });

  it("a dead commander's squad disbands into neutral NPCs that vanish after 20 s", () => {
    const w = world5();
    const loyal = hero(w, 1);
    const troops = w.spawnTroops(loyal.id, 'shu_rifleman', 3, { x: -6, y: 0, z: 35 });
    kill(w, loyal, hero(w, 2));
    for (const t of troops) {
      expect(t.kind).toBe('npc');
      expect(t.troop).toBeUndefined();
      expect(t.npc?.expiresAt).toBeCloseTo(w.time + 20, 3);
    }
    expect(loyal.hero!.squad.length).toBe(0);
    stepN(w, 30 * 21);
    for (const t of troops) expect(w.get(t.id)).toBeUndefined();
  });

  it('bounty: target killed by someone else is reassigned; a personal kill pays 2 rare items', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'bounty', 'traitor'];
    const w = world5(roles);
    const hunter = hero(w, 3);
    const first = w.get(hunter.hero!.bountyTargetId)!;
    expect(first).toBeDefined();
    expect(first.hero!.role).not.toBe('lord');
    expect(first).not.toBe(hunter);
    // someone else kills the target
    const other = [hero(w, 0), hero(w, 1), hero(w, 2), hero(w, 4)].find((e) => e !== first)!;
    kill(w, first, other);
    const second = w.get(hunter.hero!.bountyTargetId);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(second!.hero!.role).not.toBe('lord');
    expect(w.heroRt(hunter.id)!.bountyKills).toBe(0);
    // the hunter kills the new target personally
    hunter.hero!.items = [null, null, null, null];
    kill(w, second!, hunter);
    expect(w.heroRt(hunter.id)!.bountyKills).toBe(1);
    const reward = ofType(w.drainEvents(), 'reward').find((r) => r.kind === 'bounty')!;
    expect(reward.who).toBe(hunter.id);
    expect(reward.items!.length).toBe(2);
  });

  it('a decided game emits gameOver once, reveals all roles, picks the MVP among winners and stops', () => {
    const w = world5();
    const [lord, loyal, r1, r2, traitor] = [0, 1, 2, 3, 4].map((i) => hero(w, i));
    loyal.hero!.stats.damage = 5000; // big stats, but on the losing side
    r1.hero!.stats.kills = 1;
    kill(w, lord, r2);
    w.step();
    const res = w.result()!;
    expect(res.winner).toBe('rebel');
    expect(res.winners.sort()).toEqual([r1.id, r2.id].sort());
    expect([r1.id, r2.id]).toContain(res.mvp);
    expect(res.roles[traitor.id]).toBe('traitor');
    expect(res.durationSec).toBeGreaterThan(0);
    expect(ofType(w.drainEvents(), 'gameOver').length).toBe(1);
    const tick = w.tick;
    w.step();
    expect(w.tick).toBe(tick);
    expect(w.snapshotFor('p3').players.every((p) => p.role !== undefined)).toBe(true);
  });
});
