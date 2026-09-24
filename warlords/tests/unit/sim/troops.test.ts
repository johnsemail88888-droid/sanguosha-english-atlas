import { describe, expect, it } from 'vitest';
import type { Entity, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { wedgeSlot } from '../../../src/sim/ai/troopBrain';
import { HERO_BY_ID } from '../../../src/data';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function spread(w: World, roles: RoleId[]): void {
  roles.forEach((_, i) => place(w, hero(w, i), i * 25 - 50, 45));
  w.step();
}

describe('squads (带兵)', () => {
  it('spawn troopsPerHero + troopBonus (+2 for the lord) of the hero troop type', () => {
    const heroes = ['guanyu', 'guanyu', 'guanyu', 'guanyu', 'guanyu'];
    const w = makeWorld(STD5, { squads: true, heroes });
    const bonus = HERO_BY_ID.guanyu.troopBonus;
    expect(hero(w, 0).hero!.squad.length).toBe(4 + bonus + 2);
    expect(hero(w, 1).hero!.squad.length).toBe(4 + bonus);
    const t = w.get(hero(w, 1).hero!.squad[0])!;
    expect(t.troop!.troopType).toBe(HERO_BY_ID.guanyu.troopType);
    // the 影武者 mirrors the lord's squad size (disguise)
    const chaos = makeWorld(['lord', 'double', 'rebel', 'rebel', 'traitor'], { squads: true, heroes });
    expect(hero(chaos, 1).hero!.squad.length).toBe(hero(chaos, 0).hero!.squad.length);
    expect(t.troop!.commanderId).toBe(hero(w, 1).id);
    expect(t.kingdom).toBe('shu');
  });

  it('follow: troops form a wedge behind the moving commander', () => {
    const w = makeWorld(STD5, { squads: true });
    spread(w, STD5);
    const cmd = hero(w, 2);
    place(w, cmd, 0, 45);
    for (const id of cmd.hero!.squad) place(w, w.get(id)!, 0, 50);
    // walk north for 3 s, then stop
    w.setInput('p2', { ...emptyInput(1), moveZ: 1, yaw: 0 });
    stepN(w, 90);
    w.setInput('p2', { ...emptyInput(2), moveZ: 0, yaw: 0 });
    stepN(w, 150);
    for (const id of cmd.hero!.squad) {
      const t = w.get(id)!;
      const slot = wedgeSlot(cmd, t.troop!.slot);
      expect(Math.hypot(t.pos.x - slot.x, t.pos.z - slot.z)).toBeLessThan(2.5);
      expect(t.pos.z).toBeGreaterThan(cmd.pos.z); // behind (north is -z)
    }
  });

  it('troops never attack heroes without a reason, but retaliate against attackers of their commander', () => {
    const w = makeWorld(STD5, { squads: true });
    spread(w, STD5);
    const loyal = hero(w, 1);
    const rebel = hero(w, 2);
    place(w, loyal, 0, 30);
    place(w, rebel, 0, 12);
    for (const id of loyal.hero!.squad) place(w, w.get(id)!, (id % 3) - 1, 33);
    for (const id of rebel.hero!.squad) place(w, w.get(id)!, (id % 3) - 1, 9);
    stepN(w, 90);
    expect(rebel.hp).toBe(rebel.maxHp);
    expect(loyal.hp).toBe(loyal.maxHp);
    // the rebel shoots the loyalist once → the loyalist's squad engages the rebel
    w.dealDamage({ targetId: loyal.id, sourceId: rebel.id, amount: 1, type: 'normal', weaponId: 'pistol' });
    expect(w.isHostileTo(w.get(loyal.hero!.squad[0])!, rebel)).toBe(true);
    stepN(w, 120);
    expect(rebel.hp).toBeLessThan(rebel.maxHp);
  });

  it("rebel troops know the lord is public and engage him", () => {
    const w = makeWorld(STD5, { squads: true });
    spread(w, STD5);
    const lord = hero(w, 0);
    const rebel = hero(w, 2);
    const trooper = w.get(rebel.hero!.squad[0])!;
    const loyalTroop = w.get(hero(w, 1).hero!.squad[0])!;
    expect(w.isHostileTo(trooper, lord)).toBe(true);
    expect(w.isHostileTo(loyalTroop, lord)).toBe(false);
    expect(w.isHostileTo(loyalTroop, rebel)).toBe(false); // hidden role
    expect(w.isHostileTo(trooper, hero(w, 1))).toBe(false);
  });

  it('attack order on a target makes the squad engage it; hold keeps them at the point', () => {
    const w = makeWorld(STD5, { squads: true });
    spread(w, STD5);
    const cmd = hero(w, 1);
    const victim = hero(w, 4);
    place(w, cmd, 0, 30);
    place(w, victim, 0, 5);
    for (const id of cmd.hero!.squad) place(w, w.get(id)!, (id % 3) - 1, 33);
    w.setSquadOrder(cmd.id, { kind: 'attack', targetId: victim.id });
    stepN(w, 150);
    expect(victim.hp).toBeLessThan(victim.maxHp);
    w.setSquadOrder(cmd.id, { kind: 'hold', point: { x: 20, y: 0, z: 40 } });
    place(w, victim, -55, -55);
    stepN(w, 330);
    for (const id of cmd.hero!.squad) {
      const t = w.get(id)!;
      expect(Math.hypot(t.pos.x - 20, t.pos.z - 40)).toBeLessThan(4);
    }
  });

  it('commander marks focus the squad and count as hostile', () => {
    const w = makeWorld(STD5, { squads: true });
    spread(w, STD5);
    const cmd = hero(w, 1);
    const other = hero(w, 3);
    const t = w.get(cmd.hero!.squad[0])!;
    expect(w.isHostileTo(t, other)).toBe(false);
    other.statuses.push({ id: 'marked', until: w.time + 10, sourceId: cmd.id, stacks: 1 });
    expect(w.isHostileTo(t, other)).toBe(true);
  });
});

describe('NPCs and turrets', () => {
  it('黄巾 camps aggro on nearby heroes and leash back home', () => {
    const w = makeWorld(STD5, { ambient: true });
    spread(w, STD5);
    const npcs = w.kindList('npc');
    expect(npcs.length).toBe(3);
    const e = hero(w, 2);
    place(w, e, -40, -30);
    stepN(w, 150);
    expect(e.hp).toBeLessThan(e.maxHp);
    // run far away: bandits give up and walk home
    place(w, e, 50, 50);
    stepN(w, 30 * 25);
    for (const n of w.kindList('npc')) expect(Math.hypot(n.pos.x - n.npc!.home.x, n.pos.z - n.npc!.home.z)).toBeLessThan(8);
  });

  it('summoned NPCs attack everything not on the summoner side and expire', () => {
    const w = makeWorld(STD5);
    spread(w, STD5);
    const summoner = hero(w, 1);
    const victim = hero(w, 3);
    place(w, summoner, 0, 30);
    place(w, victim, 0, 22);
    const npc = w.spawnNpc('barbarian', { x: 0, y: 0, z: 26 }, { summonerId: summoner.id, lifetime: 5 });
    expect(w.isHostileTo(npc, summoner)).toBe(false);
    expect(w.isHostileTo(npc, victim)).toBe(true);
    stepN(w, 90);
    expect(victim.hp).toBeLessThan(victim.maxHp);
    expect(summoner.hp).toBe(summoner.maxHp);
    stepN(w, 100);
    expect(w.get(npc.id)).toBeUndefined();
  });

  it('turrets shoot hostiles only and expire', () => {
    const w = makeWorld(STD5);
    spread(w, STD5);
    const owner = hero(w, 1);
    const enemy = hero(w, 2);
    const neutral = hero(w, 3);
    place(w, owner, 0, 30);
    place(w, enemy, 5, 15);
    place(w, neutral, -5, 15);
    const turret = w.spawnTurret(owner.id, { x: 0, y: 0, z: 25 }, 'muniu', 'turret_smg', 4, 200);
    stepN(w, 60);
    expect(enemy.hp).toBe(enemy.maxHp);
    w.dealDamage({ targetId: owner.id, sourceId: enemy.id, amount: 1, type: 'normal' });
    stepN(w, 60);
    expect(enemy.hp).toBeLessThan(enemy.maxHp);
    expect(neutral.hp).toBe(neutral.maxHp);
    stepN(w, 90);
    expect(turret.alive).toBe(false);
  });
});

describe('temporary troops', () => {
  it('abilities can spawn temporary troops that disappear on schedule', () => {
    const w = makeWorld(STD5);
    spread(w, STD5);
    const cmd = hero(w, 0);
    const ts: Entity[] = w.spawnTroops(cmd.id, 'shu_militia', 3, undefined, { temporary: 2 });
    expect(cmd.hero!.squad.length).toBe(3);
    stepN(w, 70);
    for (const t of ts) expect(t.alive).toBe(false);
    expect(cmd.hero!.squad.length).toBe(0);
  });
});
