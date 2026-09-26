// 蜀 Shu abilities (sim/abilities/shu/*): every active does what its AbilityDef
// says in a small test world, passives trigger under the right conditions, and
// nothing throws when the caster is downed / dead / silenced or targets vanish.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { Entity, GameEvent, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import { SHU_HEROES } from '../../../src/data/heroes-shu';
import { getAbility } from '../../../src/sim/abilities';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const PARK = (i: number): [number, number] => [i * 8 - 40, 55];

let seq = 1;
let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
});
afterEach(() => {
  // a throwing hook / activate / scheduled callback is isolated by the world and reported here
  expect(warnings.filter((m) => /threw|non-finite/.test(m))).toEqual([]);
});

function world(heroes: string[], roles: RoleId[] = STD5, park = true): World {
  const w = makeWorld(roles, { heroes, onWarn: (m) => warnings.push(m) });
  if (park) {
    roles.forEach((_, i) => place(w, hero(w, i), ...PARK(i)));
    w.step();
    w.drainEvents();
  }
  return w;
}

function send(w: World, seat: number, actions: InputAction[], p: Partial<InputFrame> = {}): void {
  w.setInput(`p${seat}`, { ...emptyInput(seq++), ...p, actions });
}

/** Aim the hero at an entity's chest or at a world point (validated like a real client). */
function aim(w: World, from: Entity, at: Entity | Vec3): Partial<InputFrame> {
  const isEnt = (x: Entity | Vec3): x is Entity => (x as Entity).kind !== undefined;
  const p = isEnt(at) ? w.centerOf(at) : at;
  const ang = aimAnglesFor(from.pos, p);
  return { yaw: ang.yaw, pitch: ang.pitch, aimPoint: p, aimTargetId: isEnt(at) ? at.id : undefined };
}

const SKY: Partial<InputFrame> = { yaw: Math.PI, pitch: 1.2 };

/** Press an ability key with the given aim, run one tick, return the events of that tick. */
function press(w: World, seat: number, slot: 'q' | 'e' | 'lord', p: Partial<InputFrame> = {}): GameEvent[] {
  send(w, seat, [{ a: 'ability', slot }], p);
  w.step();
  return w.drainEvents();
}

const cast = (evs: GameEvent[], id: string): boolean => evs.some((e) => e.t === 'ability' && e.ability === id);
const ids = (w: World, kind: Entity['kind']): Entity[] => [...w.entities()].filter((e) => e.kind === kind && e.alive);

function troopsOf(w: World, commander: Entity, n: number, x: number, z: number): Entity[] {
  const out = w.spawnTroops(commander.id, 'shu_rifleman', n, { x, y: 0, z });
  out.forEach((t, i) => place(w, t, x + i * 1.2, z));
  return out;
}

describe('蜀 registration', () => {
  it('every Shu ability in the data has an implementation (actives have activate)', () => {
    expect(SHU_HEROES.map((h) => h.id)).toEqual(['liubei', 'guanyu', 'zhangfei', 'zhugeliang', 'zhaoyun', 'machao', 'huangyueying', 'huangzhong']);
    for (const h of SHU_HEROES) {
      for (const a of h.abilities) {
        const impl = getAbility(a.id);
        expect(impl, a.id).toBeDefined();
        if (!isPassiveAbility(a)) expect(impl!.activate, a.id).toBeTypeOf('function');
      }
    }
  });
});

// ── 刘备 ─────────────────────────────────────────────────────────────────────
describe('刘备', () => {
  const def = (slot: string) => HERO_BY_ID.liubei.abilities.find((a) => a.slot === slot)!;

  it('仁德: healing another hero heals you for 30 %, healing yourself does not echo', () => {
    const w = world(['liubei', 'dummy', 'dummy', 'dummy', 'dummy']);
    const lb = hero(w, 0);
    const ally = hero(w, 1);
    lb.hp = 200;
    ally.hp = 100;
    w.heal(ally.id, 100, lb.id);
    expect(ally.hp).toBe(200);
    expect(lb.hp).toBeCloseTo(200 + 100 * def('passive').params.selfHealFrac, 5);
    const before = lb.hp;
    w.heal(lb.id, 50, lb.id);
    expect(lb.hp).toBeCloseTo(before + 50, 5);
  });

  it('济民: heals the ally under the crosshair, gifts a card, spends a charge; the 2nd toss heals 刘备', () => {
    const w = world(['liubei', 'dummy', 'dummy', 'dummy', 'dummy']);
    const lb = hero(w, 0);
    const ally = hero(w, 1);
    place(w, lb, 0, 30);
    place(w, ally, 0, 20);
    w.step();
    lb.hp = 200;
    ally.hp = 100;
    const q = def('q');
    const evs = press(w, 0, 'q', aim(w, lb, ally));
    expect(cast(evs, q.id)).toBe(true);
    expect(ally.hp).toBeCloseTo(100 + q.params.heal, 5);
    const gifted = ally.hero!.items.filter((s) => s && s.id !== 'tao');
    expect(gifted.length).toBe(1);
    expect(['sha', 'shan', 'jiu']).toContain(gifted[0]!.id);
    expect(lb.hero!.charges[q.id]).toBe(1);
    expect(w.cooldownLeft(lb.id, q.id)).toBeGreaterThan(q.cooldown! - 0.5);
    // 仁德 echo only on the first toss
    expect(lb.hp).toBeCloseTo(200 + q.params.heal * 0.3, 5);
    press(w, 0, 'q', aim(w, lb, ally));
    expect(ally.hp).toBeCloseTo(100 + 2 * q.params.heal, 5);
    expect(lb.hp).toBeCloseTo(200 + 2 * q.params.heal * 0.3 + q.params.selfHeal, 5);
    expect(lb.hero!.charges[q.id]).toBe(0);
    // out of charges: nothing happens
    const hp = ally.hp;
    press(w, 0, 'q', aim(w, lb, ally));
    expect(ally.hp).toBe(hp);
  });

  it('济民: no target or a hostile target → nothing happens and no charge is spent', () => {
    const w = world(['liubei', 'dummy', 'dummy', 'dummy', 'dummy']);
    const lb = hero(w, 0);
    const rebel = hero(w, 2);
    place(w, lb, 0, 30);
    place(w, rebel, 0, 20);
    w.step();
    expect(cast(press(w, 0, 'q', SKY), 'liubei_jimin')).toBe(false);
    expect(lb.hero!.charges.liubei_jimin).toBe(2);
    // the rebel just shot 刘备: he is no friend
    rebel.hp = 100;
    w.dealDamage({ targetId: lb.id, sourceId: rebel.id, amount: 10, type: 'normal', weaponId: 'carbine' });
    press(w, 0, 'q', aim(w, lb, rebel));
    expect(rebel.hp).toBe(100);
    expect(lb.hero!.charges.liubei_jimin).toBe(2);
  });

  it('蜀汉旌旗: heroes and own soldiers inside regenerate, own soldiers hit harder, enemies are not healed', () => {
    const w = world(['liubei', 'dummy', 'dummy', 'dummy', 'dummy']);
    const lb = hero(w, 0);
    const ally = hero(w, 1);
    const traitor = hero(w, 4);
    const rebel = hero(w, 2);
    place(w, lb, 0, 30);
    place(w, ally, 3, 30);
    place(w, rebel, 0, 45); // outside the 8 m radius
    const mine = troopsOf(w, lb, 1, -2, 31)[0];
    const theirs = troopsOf(w, traitor, 1, 2, 32)[0];
    w.step();
    const e = def('e');
    for (const u of [lb, ally, rebel]) u.hp = 100;
    mine.hp = 10;
    theirs.hp = 10;
    const evs = press(w, 0, 'e');
    expect(cast(evs, e.id)).toBe(true);
    expect(ids(w, 'hazard').filter((h) => h.hazard!.kind === 'shuBanner')).toHaveLength(1);
    // one field tick (0.5 s worth) happened on the cast tick
    const tickHeal = e.params.hps * 0.5;
    expect(ally.hp).toBeCloseTo(100 + tickHeal, 5);
    expect(lb.hp).toBeCloseTo(100 + tickHeal + tickHeal * 0.3, 5); // + 仁德 echo of the ally heal
    expect(mine.hp).toBeCloseTo(10 + tickHeal, 5);
    expect(theirs.hp).toBe(10);
    expect(rebel.hp).toBe(100);
    expect(w.statusParam(mine.id, 'dmgBoost', 'mul', 1)).toBeCloseTo(e.params.troopDmgMul, 5);
    expect(w.hasStatus(theirs.id, 'dmgBoost')).toBe(false);
    expect(w.cooldownLeft(lb.id, e.id)).toBeGreaterThan(e.cooldown! - 0.5);
    stepN(w, Math.ceil(e.params.duration * 30) + 2);
    expect(ids(w, 'hazard').filter((h) => h.hazard!.kind === 'shuBanner')).toHaveLength(0);
  });

  it('激将: the real Lord summons temporary militia and speeds up Shu heroes that answer the call', () => {
    const w = world(['liubei', 'zhangfei', 'dummy', 'guanyu', 'huangzhong']);
    const lb = hero(w, 0);
    const zf = hero(w, 1); // loyal Shu
    const gy = hero(w, 3); // Shu rebel who is shooting the Lord
    const dummy = hero(w, 2); // not Shu
    const hz = hero(w, 4); // Shu, but too far
    place(w, lb, 0, 30);
    place(w, zf, 4, 30);
    place(w, gy, -4, 30);
    place(w, dummy, 0, 36);
    place(w, hz, 0, -5);
    w.step();
    w.dealDamage({ targetId: lb.id, sourceId: gy.id, amount: 5, type: 'normal', weaponId: 'qinglong' });
    const lord = def('lord');
    const evs = press(w, 0, 'lord');
    expect(cast(evs, lord.id)).toBe(true);
    const militia = ids(w, 'troop').filter((t) => t.troop!.troopType === 'shu_militia' && t.troop!.commanderId === lb.id);
    expect(militia).toHaveLength(lord.params.count);
    expect(w.statusParam(lb.id, 'fireRateUp', 'mul', 1)).toBeCloseTo(lord.params.fireRateMul, 5);
    expect(w.statusParam(zf.id, 'fireRateUp', 'mul', 1)).toBeCloseTo(lord.params.fireRateMul, 5);
    expect(w.hasStatus(gy.id, 'fireRateUp')).toBe(false);
    expect(w.hasStatus(dummy.id, 'fireRateUp')).toBe(false);
    expect(w.hasStatus(hz.id, 'fireRateUp')).toBe(false);
    expect(w.cooldownLeft(lb.id, lord.id)).toBeGreaterThan(lord.cooldown! - 0.5);
    // the militia is temporary
    stepN(w, Math.ceil(lord.params.lifetime * 30) + 5);
    expect(ids(w, 'troop').filter((t) => t.troop!.troopType === 'shu_militia')).toHaveLength(0);
  });

  it('激将 only works for the real Lord (not as a loyalist, not as the 影武者)', () => {
    for (const [roles, seat] of [
      [['lord', 'loyalist', 'rebel', 'rebel', 'traitor'], 1],
      [['lord', 'double', 'rebel', 'rebel', 'traitor'], 1],
    ] as [RoleId[], number][]) {
      const heroes = ['dummy', 'dummy', 'dummy', 'dummy', 'dummy'];
      heroes[seat] = 'liubei';
      const w = world(heroes, roles);
      const lb = hero(w, seat);
      expect(w.heroRt(lb.id)!.abilities.some((a) => a.def.id === 'liubei_jijiang')).toBe(false);
      const evs = press(w, seat, 'lord');
      expect(cast(evs, 'liubei_jijiang')).toBe(false);
      expect(ids(w, 'troop')).toHaveLength(0);
    }
  });
});

// ── 关羽 (reference implementation, reviewed) ────────────────────────────────
describe('关羽', () => {
  it('青龙斩 charges into a close enemy instead of through it', () => {
    const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
    const g = hero(w, 2);
    const foe = hero(w, 3);
    place(w, g, 0, 30);
    place(w, foe, 0, 27);
    w.step();
    press(w, 2, 'q', { yaw: 0 });
    stepN(w, 20);
    expect(foe.maxHp - foe.hp).toBeGreaterThanOrEqual(90 * 1.25 - 1e-6);
    expect(g.pos.z).toBeGreaterThan(27 - 1); // never ended up behind its target
  });

  it('青龙斩 while rooted sweeps in place', () => {
    const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
    const g = hero(w, 2);
    const foe = hero(w, 3);
    place(w, g, 0, 30);
    place(w, foe, 0, 27);
    w.step();
    w.applyStatus(g.id, 'root', 2, { sourceId: foe.id });
    const z = g.pos.z;
    press(w, 2, 'q', { yaw: 0 });
    stepN(w, 10);
    expect(g.pos.z).toBeCloseTo(z, 3);
    expect(foe.hp).toBeLessThan(foe.maxHp);
  });

  it('武圣: burn ticks are not hits (no bonus slash), direct hits on a burning target are', () => {
    const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
    const g = hero(w, 2);
    const foe = hero(w, 3);
    w.applyStatus(foe.id, 'burn', 5, { sourceId: g.id, params: { dps: 10 } });
    const hp = foe.hp;
    stepN(w, 16); // one burn tick at +0.5 s
    expect(hp - foe.hp).toBeCloseTo(5 * 1.25, 5);
  });
});

// ── 张飞 ─────────────────────────────────────────────────────────────────────
describe('张飞', () => {
  const def = (slot: string) => HERO_BY_ID.zhangfei.abilities.find((a) => a.slot === slot)!;

  it('蛇矛连击: faster shotgun reloads only with a shotgun out; a kill grants ammo-free fire', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    expect(w.modifiers(zf.id).reloadMul).toBeCloseTo(def('passive').params.reloadMul, 5);
    send(w, 1, [{ a: 'weapon', slot: 1 }]);
    stepN(w, 2);
    expect(w.modifiers(zf.id).reloadMul).toBe(1);
    // kill a (traitor's) soldier
    const t = troopsOf(w, hero(w, 4), 1, zf.pos.x + 3, zf.pos.z)[0];
    t.hp = 1;
    w.dealDamage({ targetId: t.id, sourceId: zf.id, amount: 5, type: 'normal', weaponId: 'zhangba' });
    expect(t.alive).toBe(false);
    expect(w.hasStatus(zf.id, 'noReload')).toBe(true);
    stepN(w, Math.ceil(def('passive').params.killNoReload * 30) + 2);
    expect(w.hasStatus(zf.id, 'noReload')).toBe(false);
  });

  it('咆哮: ammo-free rapid fire (an empty gun is racked), nearby enemies slowed, far ones not', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    const near = hero(w, 2);
    const far = hero(w, 4);
    place(w, zf, 0, 30);
    place(w, near, 0, 24);
    place(w, far, 0, 40);
    w.step();
    const q = def('q');
    const gun = zf.hero!.weapons[0]!;
    gun.mag = 0;
    expect(cast(press(w, 1, 'q', { yaw: Math.PI }), q.id)).toBe(true);
    expect(gun.mag).toBe(6);
    expect(w.hasStatus(zf.id, 'noReload')).toBe(true);
    expect(w.statusParam(zf.id, 'fireRateUp', 'mul', 1)).toBeCloseTo(q.params.fireRateMul, 5);
    expect(w.statusParam(near.id, 'slow', 'amount', 0)).toBeCloseTo(q.params.slow, 5);
    expect(w.hasStatus(far.id, 'slow')).toBe(false);
    // shooting (at the sky) does not use ammo
    send(w, 1, [], { yaw: Math.PI, pitch: 0.5, buttons: 1 });
    stepN(w, 20);
    expect(gun.mag).toBe(6);
    expect(w.cooldownLeft(zf.id, q.id)).toBeGreaterThan(q.cooldown! - 2);
  });

  it('据水断桥: cone shout — damage, knockback, short stun on heroes, long stun on soldiers', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    const foe = hero(w, 2);
    const behind = hero(w, 4);
    place(w, zf, 0, 30);
    place(w, foe, 0, 25);
    place(w, behind, 0, 34);
    const soldier = troopsOf(w, behind, 1, 2, 24)[0];
    w.step();
    const e = def('e');
    press(w, 1, 'e', { yaw: 0 });
    expect(foe.maxHp - foe.hp).toBeCloseTo(e.params.damage, 5);
    expect(w.hasStatus(foe.id, 'stun')).toBe(true);
    expect(w.hasStatus(soldier.id, 'stun')).toBe(true);
    expect(behind.hp).toBe(behind.maxHp);
    stepN(w, 10);
    expect(foe.pos.z).toBeLessThan(24); // knocked away from 张飞
    stepN(w, Math.ceil(e.params.stunHero * 30));
    expect(w.hasStatus(foe.id, 'stun')).toBe(false);
    expect(w.hasStatus(soldier.id, 'stun')).toBe(true);
    stepN(w, Math.ceil((e.params.stunTroop - e.params.stunHero) * 30) + 2);
    expect(w.hasStatus(soldier.id, 'stun')).toBe(false);
  });
});

// ── 诸葛亮 ───────────────────────────────────────────────────────────────────
describe('诸葛亮', () => {
  const def = (slot: string) => HERO_BY_ID.zhugeliang.abilities.find((a) => a.slot === slot)!;

  it('观星: periodically reveals nearby heroes to him alone', () => {
    const w = world(['dummy', 'zhugeliang', 'dummy', 'dummy', 'dummy'], STD5, false);
    const zgl = hero(w, 1);
    const near = hero(w, 2);
    const far = hero(w, 3);
    place(w, zgl, -30, 30);
    place(w, near, 0, 30); // 30 m
    place(w, far, 20, 30); // 50 m
    place(w, hero(w, 0), 40, -40);
    place(w, hero(w, 4), 40, -35);
    w.step();
    const p = def('passive').params;
    const evs = w.drainEvents();
    expect(w.statusParam(near.id, 'reveal', 'viewerId', -1)).toBe(zgl.id);
    expect(w.hasStatus(far.id, 'reveal')).toBe(false);
    const st = evs.find((e) => e.t === 'status' && e.status === 'reveal' && e.target === near.id);
    expect(st?.privateTo).toBe(zgl.id);
    expect(evs.find((e) => e.t === 'ability' && e.ability === 'zhugeliang_guanxing')?.privateTo).toBe(zgl.id);
    stepN(w, Math.ceil(p.duration * 30) + 2);
    expect(w.hasStatus(near.id, 'reveal')).toBe(false);
    stepN(w, Math.ceil((p.interval - p.duration) * 30));
    expect(w.hasStatus(near.id, 'reveal')).toBe(true);
  });

  it('八阵图: slows + silences enemies inside, gives own units evasion, clamps to range, expires', () => {
    const w = world(['dummy', 'zhugeliang', 'guanyu', 'dummy', 'dummy']);
    const zgl = hero(w, 1);
    const foe = hero(w, 2);
    place(w, zgl, 0, 30);
    place(w, foe, 0, 18);
    const mine = troopsOf(w, zgl, 1, 1, 21)[0];
    w.step();
    const q = def('q');
    const center = { x: 0, y: 0, z: 20 };
    const evs = press(w, 1, 'q', aim(w, zgl, center));
    expect(cast(evs, q.id)).toBe(true);
    const maze = ids(w, 'hazard').find((h) => h.hazard!.kind === 'bazhen')!;
    expect(maze).toBeDefined();
    expect(Math.hypot(maze.pos.x - center.x, maze.pos.z - center.z)).toBeLessThan(0.5);
    stepN(w, 2);
    expect(w.statusParam(foe.id, 'slow', 'amount', 0)).toBeCloseTo(q.params.slow, 5);
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    expect(w.statusParam(mine.id, 'dodgeChance', 'chance', 0)).toBeCloseTo(q.params.dodge, 5);
    expect(w.hasStatus(zgl.id, 'dodgeChance')).toBe(false); // he is outside his maze
    // silenced: 关羽 cannot cast
    press(w, 2, 'q', { yaw: Math.PI });
    expect(w.cooldownLeft(foe.id, 'guanyu_qinglong')).toBe(0);
    stepN(w, Math.ceil(q.params.duration * 30) + 20);
    expect(ids(w, 'hazard').some((h) => h.hazard!.kind === 'bazhen')).toBe(false);
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
    // far crosshair point: clamped to the cast range
    w.setCooldown(zgl.id, q.id, 0);
    press(w, 1, 'q', aim(w, zgl, { x: 0, y: 0, z: -40 }));
    const maze2 = ids(w, 'hazard').find((h) => h.hazard!.kind === 'bazhen')!;
    expect(Math.hypot(maze2.pos.x - zgl.pos.x, maze2.pos.z - zgl.pos.z)).toBeLessThanOrEqual(q.params.range + 0.5);
  });

  it('空城: invulnerable, untargetable, disarmed and slowed; nearby hostile soldiers drop aggro', () => {
    const w = world(['dummy', 'zhugeliang', 'dummy', 'dummy', 'dummy']);
    const zgl = hero(w, 1);
    const foe = hero(w, 2);
    place(w, zgl, 0, 30);
    place(w, foe, 0, 20);
    const soldier = troopsOf(w, foe, 1, 0, 26)[0];
    w.step();
    soldier.troop!.targetId = zgl.id;
    const e = def('e');
    const gun = zgl.hero!.weapons[0]!;
    expect(cast(press(w, 1, 'e', { yaw: 0, buttons: 1 }), e.id)).toBe(true);
    const mag = gun.mag; // (the cast tick itself may still fire: statuses bind from the next tick)
    expect(soldier.troop!.targetId).toBeUndefined();
    const r = w.dealDamage({ targetId: zgl.id, sourceId: foe.id, amount: 100, type: 'normal', weaponId: 'carbine' });
    expect(r.dealt).toBe(0);
    expect(zgl.hp).toBe(zgl.maxHp);
    send(w, 2, [], aim(w, foe, zgl));
    w.step();
    expect(w.aimTarget(foe, 60, { notFriendlyTo: foe.id })).toBeUndefined();
    expect(w.statusParam(zgl.id, 'slow', 'amount', 0)).toBeCloseTo(e.params.selfSlow, 5);
    stepN(w, 20);
    expect(gun.mag).toBe(mag); // holding fire does nothing
    expect(soldier.troop!.targetId).not.toBe(zgl.id);
    stepN(w, Math.ceil(e.params.duration * 30));
    expect(w.dealDamage({ targetId: zgl.id, sourceId: foe.id, amount: 10, type: 'normal' }).dealt).toBe(10);
  });
});

// ── 赵云 ─────────────────────────────────────────────────────────────────────
describe('赵云', () => {
  const def = (slot: string) => HERO_BY_ID.zhaoyun.abilities.find((a) => a.slot === slot)!;

  it('龙胆: 3 dodge charges from the start; a dodge empowers weapon hits (not ability hits) for a while', () => {
    const w = world(['dummy', 'zhaoyun', 'dummy', 'dummy', 'dummy']);
    const zy = hero(w, 1);
    const foe = hero(w, 2);
    const p = def('passive').params;
    expect(zy.hero!.dodgeCharges).toBe(p.maxDodges);
    send(w, 1, [{ a: 'dodge' }]);
    w.step();
    expect(cast(w.drainEvents(), 'zhaoyun_longdan')).toBe(true);
    expect(zy.hero!.dodgeCharges).toBe(p.maxDodges - 1);
    expect(w.dealDamage({ targetId: foe.id, sourceId: zy.id, amount: 100, type: 'normal', weaponId: 'longdan' }).dealt).toBeCloseTo(100 * p.mul, 5);
    expect(w.dealDamage({ targetId: foe.id, sourceId: zy.id, amount: 100, type: 'melee', abilityId: 'x' }).dealt).toBeCloseTo(100, 5);
    stepN(w, Math.ceil(p.duration * 30) + 1);
    expect(w.dealDamage({ targetId: foe.id, sourceId: zy.id, amount: 50, type: 'normal', weaponId: 'longdan' }).dealt).toBeCloseTo(50, 5);
  });

  it('七进七出: invulnerable dash that strikes everything passed through; 3 charges', () => {
    const w = world(['dummy', 'zhaoyun', 'dummy', 'dummy', 'dummy']);
    const zy = hero(w, 1);
    const foe = hero(w, 2);
    const side = hero(w, 3);
    place(w, zy, 0, 30);
    place(w, foe, 0, 26);
    place(w, side, 5, 26);
    w.step();
    const q = def('q');
    press(w, 1, 'q', { yaw: 0 });
    expect(zy.hero!.charges[q.id]).toBe(q.charges! - 1);
    // truly invulnerable during the dash (even undodgeable hits)
    expect(w.dealDamage({ targetId: zy.id, sourceId: side.id, amount: 50, type: 'true', canDodge: false }).dealt).toBe(0);
    stepN(w, 12);
    expect(30 - zy.pos.z).toBeGreaterThan(q.params.dash * 0.85);
    expect(foe.maxHp - foe.hp).toBeCloseTo(q.params.damage, 5);
    expect(side.hp).toBe(side.maxHp);
    // chain the remaining charges; then it is empty
    press(w, 1, 'q', { yaw: 0 });
    stepN(w, 10);
    press(w, 1, 'q', { yaw: 0 });
    stepN(w, 10);
    expect(zy.hero!.charges[q.id]).toBe(0);
    const z = zy.pos.z;
    press(w, 1, 'q', { yaw: 0 });
    stepN(w, 10);
    expect(zy.pos.z).toBeCloseTo(z, 3);
  });

  it('长坂救主: dash to the ally and shield both; without a target shield only yourself', () => {
    const w = world(['dummy', 'zhaoyun', 'dummy', 'dummy', 'dummy']);
    const zy = hero(w, 1);
    const lord = hero(w, 0);
    place(w, zy, 0, 30);
    place(w, lord, 0, 15);
    w.step();
    const e = def('e');
    expect(cast(press(w, 1, 'e', aim(w, zy, lord)), e.id)).toBe(true);
    expect(zy.shield).toBeCloseTo(e.params.shield, 5);
    expect(lord.shield).toBeCloseTo(e.params.shield, 5);
    stepN(w, 15);
    expect(Math.hypot(zy.pos.x - lord.pos.x, zy.pos.z - lord.pos.z)).toBeLessThan(3);
    stepN(w, Math.ceil(e.params.duration * 30));
    expect(lord.shield).toBe(0);
    // no target
    w.setCooldown(zy.id, e.id, 0);
    press(w, 1, 'e', SKY);
    expect(zy.shield).toBeCloseTo(e.params.shield, 5);
    expect(lord.shield).toBe(0);
  });
});

// ── 马超 ─────────────────────────────────────────────────────────────────────
describe('马超', () => {
  const def = (slot: string) => HERO_BY_ID.machao.abilities.find((a) => a.slot === slot)!;

  it('马术: permanent +20 % speed that does not stack with a mount', () => {
    const w = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const mc = hero(w, 1);
    const p = def('passive').params;
    expect(w.hooks.speedMul(mc)).toBeCloseTo(p.speedMul, 5);
    w.equip(mc.id, 'dilu'); // +18 % mount: the warhorse's +20 % still wins overall
    expect(w.hooks.speedMul(mc) * 1.18).toBeCloseTo(p.speedMul, 5);
    w.equip(mc.id, 'chitu'); // +40 %: the mount wins, no stacking
    expect(w.hooks.speedMul(mc)).toBeCloseTo(1, 5);
    // and he really outruns a plain hero
    const w2 = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const a = hero(w2, 1);
    const b = hero(w2, 2);
    place(w2, a, -5, 40);
    place(w2, b, 5, 40);
    const fa = w2.heroRt(a.id)!;
    const fb = w2.heroRt(b.id)!;
    send(w2, 1, [], { moveZ: 1, yaw: 0 });
    send(w2, 2, [], { moveZ: 1, yaw: 0 });
    stepN(w2, 30);
    const ratio = (40 - a.pos.z) / (40 - b.pos.z);
    const wm = (id: string) => HERO_BY_ID[id]?.speedMul ?? 1;
    void fa;
    void fb;
    expect(ratio).toBeGreaterThan(1.1 * wm('machao'));
  });

  it('铁骑: undodgeable, armor-piercing hits that silence heroes, for the duration only', () => {
    const w = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const mc = hero(w, 1);
    const foe = hero(w, 2);
    const q = def('q');
    expect(cast(press(w, 1, 'q'), q.id)).toBe(true);
    expect(w.hasStatus(mc.id, 'undodgeable')).toBe(true);
    expect(w.hasStatus(mc.id, 'pierce')).toBe(true);
    foe.hero!.armor = 'baiyin'; // caps hits at 60 — unless armor is ignored
    foe.hero!.dodgingUntil = w.time + 1; // mid-roll — unless the hit is undodgeable
    const r = w.dealDamage({ targetId: foe.id, sourceId: mc.id, amount: 100, type: 'normal', weaponId: 'hutou' });
    expect(r.blocked).toBeUndefined();
    expect(r.dealt).toBeCloseTo(100, 5);
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    stepN(w, Math.ceil(q.params.duration * 30) + 2);
    foe.hero!.dodgingUntil = 0;
    w.removeStatus(foe.id, 'silence');
    const r2 = w.dealDamage({ targetId: foe.id, sourceId: mc.id, amount: 100, type: 'normal', weaponId: 'hutou' });
    expect(r2.dealt).toBeLessThanOrEqual(60 + 1e-6);
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
  });

  it('西凉冲锋: gallops the full distance and tramples everything in the path once', () => {
    const w = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const mc = hero(w, 1);
    const foe = hero(w, 2);
    const off = hero(w, 3);
    place(w, mc, 0, 45);
    place(w, foe, 0, 38);
    place(w, off, 6, 36);
    const soldier = troopsOf(w, hero(w, 4), 1, 1.5, 34)[0];
    w.step();
    const e = def('e');
    const hp0 = soldier.hp;
    press(w, 1, 'e', { yaw: 0 });
    stepN(w, 25);
    expect(45 - mc.pos.z).toBeGreaterThan(e.params.dash * 0.85);
    expect(foe.maxHp - foe.hp).toBeCloseTo(e.params.damage, 5);
    expect(hp0 - Math.max(0, soldier.hp)).toBeGreaterThanOrEqual(Math.min(hp0, e.params.damage) - 1e-6);
    expect(off.hp).toBe(off.maxHp);
    expect(Math.abs(foe.pos.x) + Math.abs(foe.pos.z - 38)).toBeGreaterThan(1); // knocked back
  });

  it('西凉冲锋: rooted → cannot charge (no cooldown); knocked down mid-charge → the charge stops', () => {
    const w = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const mc = hero(w, 1);
    const foe = hero(w, 2);
    place(w, mc, 0, 45);
    place(w, foe, 0, 33);
    w.step();
    w.applyStatus(mc.id, 'root', 1, { sourceId: foe.id });
    press(w, 1, 'e', { yaw: 0 });
    expect(w.cooldownLeft(mc.id, 'machao_charge')).toBe(0);
    stepN(w, 31);
    press(w, 1, 'e', { yaw: 0 });
    stepN(w, 3);
    w.downHero(mc, foe.id, foe.id);
    stepN(w, 25);
    expect(foe.hp).toBe(foe.maxHp);
  });
});

// ── 黄月英 ───────────────────────────────────────────────────────────────────
describe('黄月英', () => {
  const def = (slot: string) => HERO_BY_ID.huangyueying.abilities.find((a) => a.slot === slot)!;
  const turrets = (w: World, owner: Entity) => ids(w, 'turret').filter((t) => t.ownerId === owner.id);

  it('木牛流马: deploys a turret nearby (hp, lifetime), at most 2 at once, oldest replaced', () => {
    const w = world(['dummy', 'huangyueying', 'dummy', 'dummy', 'dummy']);
    const hy = hero(w, 1);
    place(w, hy, 0, 30);
    w.step();
    const q = def('q');
    const spot = { x: 0, y: 0, z: 26 };
    expect(cast(press(w, 1, 'q', aim(w, hy, spot)), q.id)).toBe(true);
    const first = turrets(w, hy);
    expect(first).toHaveLength(1);
    const t = first[0];
    expect(t.maxHp).toBe(q.params.hp);
    expect(t.turret!.weaponId).toBe('turret_smg');
    expect(t.turret!.expiresAt - w.time).toBeGreaterThan(q.params.lifetime - 0.5);
    expect(Math.hypot(t.pos.x - hy.pos.x, t.pos.z - hy.pos.z)).toBeLessThanOrEqual(q.params.range + 1);
    for (let i = 0; i < 2; i++) {
      stepN(w, 3);
      w.setCooldown(hy.id, q.id, 0);
      press(w, 1, 'q', aim(w, hy, { x: i * 2 - 1, y: 0, z: 27 }));
    }
    const now = turrets(w, hy);
    expect(now).toHaveLength(q.params.maxActive);
    expect(now.some((x) => x.id === t.id)).toBe(false);
    // turrets expire…
    stepN(w, Math.ceil(q.params.lifetime * 30) + 5);
    expect(turrets(w, hy)).toHaveLength(0);
  });

  it('木牛流马: turrets fall apart when 黄月英 dies', () => {
    const w = world(['dummy', 'huangyueying', 'dummy', 'dummy', 'dummy']);
    const hy = hero(w, 1);
    place(w, hy, 0, 30);
    w.step();
    press(w, 1, 'q', aim(w, hy, { x: 0, y: 0, z: 26 }));
    expect(turrets(w, hy)).toHaveLength(1);
    w.killHero(hy, undefined);
    stepN(w, 20);
    expect(turrets(w, hy)).toHaveLength(0);
  });

  it('奇才: own turrets + soldiers fire faster (new turrets too), her weapon uses no ammo', () => {
    const w = world(['dummy', 'huangyueying', 'dummy', 'dummy', 'dummy']);
    const hy = hero(w, 1);
    place(w, hy, 0, 30);
    const soldiers = troopsOf(w, hy, 2, 3, 30);
    const enemySoldier = troopsOf(w, hero(w, 4), 1, -3, 30)[0];
    w.step();
    press(w, 1, 'q', aim(w, hy, { x: 0, y: 0, z: 26 }));
    const e = def('e');
    expect(cast(press(w, 1, 'e'), e.id)).toBe(true);
    const mul = e.params.fireRateMul;
    expect(w.hasStatus(hy.id, 'noReload')).toBe(true);
    for (const u of [...soldiers, ...turrets(w, hy)]) expect(w.statusParam(u.id, 'fireRateUp', 'mul', 1)).toBeCloseTo(mul, 5);
    expect(w.hasStatus(enemySoldier.id, 'fireRateUp')).toBe(false);
    // a turret deployed during the window is overclocked within a refresh
    w.setCooldown(hy.id, 'huangyueying_muniu', 0);
    press(w, 1, 'q', aim(w, hy, { x: 2, y: 0, z: 27 }));
    stepN(w, 20);
    for (const u of turrets(w, hy)) expect(w.statusParam(u.id, 'fireRateUp', 'mul', 1)).toBeCloseTo(mul, 5);
    stepN(w, Math.ceil(e.params.duration * 30));
    for (const u of [...soldiers, ...turrets(w, hy), hy]) expect(w.hasStatus(u.id, 'fireRateUp') || w.hasStatus(u.id, 'noReload')).toBe(false);
  });

  it('集智: using an item cuts every running cooldown by 3 s', () => {
    const w = world(['dummy', 'huangyueying', 'dummy', 'dummy', 'dummy']);
    const hy = hero(w, 1);
    place(w, hy, 0, 30);
    w.step();
    press(w, 1, 'q', aim(w, hy, { x: 0, y: 0, z: 26 }));
    press(w, 1, 'e');
    const q = w.cooldownLeft(hy.id, 'huangyueying_muniu');
    const e = w.cooldownLeft(hy.id, 'huangyueying_qicai');
    hy.hero!.dodgeCharges = 0;
    hy.hero!.items[1] = { id: 'shan', count: 1 };
    send(w, 1, [{ a: 'item', slot: 1 }]);
    w.step();
    const cdr = def('passive').params.cdr;
    expect(hy.hero!.items[1]).toBeNull();
    expect(w.cooldownLeft(hy.id, 'huangyueying_muniu')).toBeCloseTo(q - cdr - 1 / 30, 3);
    expect(w.cooldownLeft(hy.id, 'huangyueying_qicai')).toBeCloseTo(e - cdr - 1 / 30, 3);
  });
});

// ── 黄忠 ─────────────────────────────────────────────────────────────────────
describe('黄忠', () => {
  const def = (slot: string) => HERO_BY_ID.huangzhong.abilities.find((a) => a.slot === slot)!;

  it('烈弓: beyond 30 m hits are undodgeable and +25 %; closer ones are normal', () => {
    const w = world(['dummy', 'huangzhong', 'dummy', 'dummy', 'dummy']);
    const hz = hero(w, 1);
    const far = hero(w, 2);
    const near = hero(w, 3);
    place(w, hz, 0, 50);
    place(w, far, 0, 10);
    place(w, near, 5, 42);
    w.step();
    const p = def('passive').params;
    far.hero!.dodgingUntil = w.time + 1;
    near.hero!.dodgingUntil = w.time + 1;
    const r1 = w.dealDamage({ targetId: far.id, sourceId: hz.id, amount: 100, type: 'normal', weaponId: 'liegong' });
    expect(r1.dealt).toBeCloseTo(100 * p.mul, 5);
    expect(w.dealDamage({ targetId: near.id, sourceId: hz.id, amount: 100, type: 'normal', weaponId: 'liegong' }).blocked).toBe('dodge');
    near.hero!.dodgingUntil = 0;
    expect(w.dealDamage({ targetId: near.id, sourceId: hz.id, amount: 100, type: 'normal', weaponId: 'liegong' }).dealt).toBeCloseTo(100, 5);
  });

  it('百步穿杨: one armor-piercing arrow passes through a line of targets', () => {
    const w = world(['dummy', 'huangzhong', 'dummy', 'dummy', 'dummy']);
    const hz = hero(w, 1);
    const line = [hero(w, 0), hero(w, 2), hero(w, 3)];
    place(w, hz, 0, 50);
    line.forEach((t, i) => place(w, t, 0, 40 - i * 5));
    place(w, hero(w, 4), 20, 50);
    line[1].hero!.armor = 'baiyin'; // would cap a normal hit at 60
    w.step();
    const q = def('q');
    expect(cast(press(w, 1, 'q', aim(w, hz, { x: 0, y: 0.2, z: 0 })), q.id)).toBe(true);
    expect(ids(w, 'projectile').some((p) => p.proj!.abilityId === q.id)).toBe(true);
    stepN(w, 15);
    for (const t of line) expect(t.maxHp - t.hp, `target at z=${t.pos.z.toFixed(1)}`).toBeCloseTo(q.params.damage, 5);
    expect(w.cooldownLeft(hz.id, q.id)).toBeGreaterThan(q.cooldown! - 1);
  });

  it('老当益壮: heals 25 % of max HP and hastes', () => {
    const w = world(['dummy', 'huangzhong', 'dummy', 'dummy', 'dummy']);
    const hz = hero(w, 1);
    hz.hp = 100;
    const e = def('e');
    expect(cast(press(w, 1, 'e'), e.id)).toBe(true);
    expect(hz.hp).toBeCloseTo(100 + hz.maxHp * e.params.healFrac, 5);
    expect(w.statusParam(hz.id, 'haste', 'amount', 0)).toBeCloseTo(e.params.haste, 5);
  });
});

// ── robustness ───────────────────────────────────────────────────────────────
describe('蜀 robustness', () => {
  const heroesWith = (id: string): string[] => ['dummy', id, 'dummy', 'dummy', 'dummy'];

  it('silenced or downed casters cannot activate anything (no cooldown, no charge spent)', () => {
    for (const h of SHU_HEROES) {
      for (const mode of ['silence', 'downed'] as const) {
        const w = world(heroesWith(h.id));
        const e = hero(w, 1);
        place(w, e, 0, 30);
        place(w, hero(w, 2), 0, 22);
        w.step();
        if (mode === 'silence') w.applyStatus(e.id, 'silence', 5, { sourceId: hero(w, 2).id });
        else w.downHero(e, hero(w, 2).id, hero(w, 2).id);
        const charges = { ...e.hero!.charges };
        for (const slot of ['q', 'e'] as const) {
          const evs = press(w, 1, slot, aim(w, e, hero(w, 2)));
          const a = h.abilities.find((x) => x.slot === slot)!;
          expect(cast(evs, a.id), `${a.id} ${mode}`).toBe(false);
          expect(w.cooldownLeft(e.id, a.id), `${a.id} ${mode}`).toBe(0);
        }
        expect(e.hero!.charges).toEqual(charges);
      }
    }
  });

  it('activate() and every hook are safe on a dead caster with vanished targets', () => {
    for (const h of SHU_HEROES) {
      const w = world(heroesWith(h.id));
      const e = hero(w, 1);
      const foe = hero(w, 2);
      w.killHero(e, foe.id, foe.id);
      w.killHero(foe, undefined);
      for (const a of h.abilities) {
        const impl = getAbility(a.id)!;
        const ctx = w.abilityCtx(e, a);
        const dctx = { ...ctx, req: { targetId: foe.id, sourceId: e.id, amount: 10, type: 'normal' as const }, other: undefined };
        expect(() => {
          impl.activate?.(ctx);
          impl.tick?.(ctx, 1 / 30);
          impl.modifiers?.(ctx);
          impl.speedMul?.(ctx);
          impl.beforeDamageDealt?.(dctx);
          impl.modifyOutgoing?.(dctx, 10);
          impl.onDamageDealt?.(dctx, 10);
          impl.onDamageDealt?.({ ...dctx, other: foe }, 10);
          impl.onKill?.(ctx, foe);
          impl.onDodge?.(ctx);
          impl.onHealGiven?.(ctx, foe, 10);
          impl.onItemUsed?.(ctx, 'tao');
        }, a.id).not.toThrow();
      }
      expect(() => stepN(w, 60)).not.toThrow();
    }
  });

  it('targets that die mid-effect do not break charges, mazes or banners', () => {
    const w = world(['liubei', 'zhaoyun', 'zhugeliang', 'machao', 'dummy']);
    const [lb, zy, zgl, mc, foe] = [0, 1, 2, 3, 4].map((i) => hero(w, i));
    place(w, lb, -20, 30);
    place(w, zy, 0, 30);
    place(w, zgl, 20, 30);
    place(w, mc, 10, 45);
    place(w, foe, 0, 26);
    const soldiers = troopsOf(w, foe, 3, 0, 24);
    w.step();
    press(w, 0, 'e');
    press(w, 1, 'q', { yaw: 0 });
    press(w, 2, 'q', aim(w, zgl, { x: 2, y: 0, z: 24 }));
    press(w, 3, 'e', { yaw: 0 });
    w.killHero(foe, zy.id, zy.id);
    for (const s of soldiers) w.removeEntity(s.id);
    expect(() => stepN(w, 60)).not.toThrow();
  });
});

// ── 无懈可击 / 谦逊 / several casters ─────────────────────────────────────────
describe('蜀 interactions', () => {
  it('无懈可击 cancels 义绝 whole (card still spent, no damage amp)', () => {
    const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
    const g = hero(w, 2);
    const foe = hero(w, 3);
    place(w, g, 0, 30);
    place(w, foe, 0, 20);
    w.step();
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    press(w, 2, 'e', aim(w, g, foe));
    expect(w.cooldownLeft(g.id, 'guanyu_yijue')).toBeGreaterThan(0);
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(false);
    stepN(w, 2);
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 100, type: 'normal' }).dealt).toBeCloseTo(100, 5);
  });

  it('无懈可击 cancels the whole 据水断桥 hit on its holder (damage, knockback, stun) for one charge', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    const foe = hero(w, 2);
    const other = hero(w, 3);
    place(w, zf, 0, 30);
    place(w, foe, 0, 25);
    place(w, other, 1.5, 25);
    w.step();
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    press(w, 1, 'e', { yaw: 0 });
    stepN(w, 10);
    expect(foe.hp).toBe(foe.maxHp);
    expect(w.hasStatus(foe.id, 'stun')).toBe(false);
    expect(foe.pos.z).toBeCloseTo(25, 1);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(false);
    // the unprotected neighbour takes the full shout
    expect(other.hp).toBeLessThan(other.maxHp);
  });

  it('八阵图 is a lingering field: it slows / silences a 无懈可击 holder without consuming the charge', () => {
    const w = world(['dummy', 'zhugeliang', 'dummy', 'dummy', 'dummy']);
    const zgl = hero(w, 1);
    const foe = hero(w, 2);
    place(w, zgl, 0, 30);
    place(w, foe, 0, 20);
    w.step();
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    press(w, 1, 'q', aim(w, zgl, { x: 0, y: 0, z: 20 }));
    stepN(w, 2);
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(true);
  });

  it('铁骑: weapon hits land on a 无懈可击 holder, the silence is what gets nullified', () => {
    const w = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const mc = hero(w, 1);
    const foe = hero(w, 2);
    press(w, 1, 'q');
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    expect(w.dealDamage({ targetId: foe.id, sourceId: mc.id, amount: 50, type: 'normal', weaponId: 'hutou' }).dealt).toBeCloseTo(50, 5);
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(false);
    w.step();
    w.dealDamage({ targetId: foe.id, sourceId: mc.id, amount: 50, type: 'normal', weaponId: 'hutou' });
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
  });

  it('a 谦逊-style veto blocks the control part only (断桥 still damages, no stun; 义绝 no silence)', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'guanyu', 'dummy']);
    const zf = hero(w, 1);
    const foe = hero(w, 2);
    const g = hero(w, 3);
    place(w, zf, 0, 30);
    place(w, foe, 0, 25);
    place(w, g, 0, 12);
    w.step();
    const veto = new Set(['stun', 'silence', 'charm', 'dance', 'steal']);
    w.heroRt(foe.id)!.abilities.push({
      def: { id: 't_qianxun', slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} },
      impl: { id: 't_qianxun', canBeAffected: (_c, s) => !veto.has(s) },
    });
    press(w, 1, 'e', { yaw: 0 });
    expect(foe.maxHp - foe.hp).toBeCloseTo(20, 5);
    expect(w.hasStatus(foe.id, 'stun')).toBe(false);
    stepN(w, 15);
    press(w, 3, 'e', aim(w, g, foe));
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
  });

  it('several Shu casters at once: overlapping banner + maze, two charges through the same foe', () => {
    const w = world(['liubei', 'zhugeliang', 'zhaoyun', 'machao', 'dummy']);
    const [lb, zgl, zy, mc, foe] = [0, 1, 2, 3, 4].map((i) => hero(w, i));
    place(w, lb, -9, 21); // banner overlaps the west side of the maze, the foe stays outside it
    place(w, zgl, 10, 30);
    place(w, zy, -4, 28.5); // outside the maze (it would silence him: he is not 诸葛亮's own side)
    place(w, mc, 2, 34);
    place(w, foe, 0, 22);
    w.step();
    lb.hp = 200;
    press(w, 0, 'e');
    press(w, 1, 'q', aim(w, zgl, { x: 0, y: 0, z: 21 }));
    // both dash through the foe in the same tick
    const yawTo = (a: Entity, b: Entity): number => Math.atan2(-(b.pos.x - a.pos.x), -(b.pos.z - a.pos.z));
    send(w, 2, [{ a: 'ability', slot: 'q' }], { yaw: yawTo(zy, foe) });
    send(w, 3, [{ a: 'ability', slot: 'e' }], { yaw: yawTo(mc, foe) });
    w.step();
    stepN(w, 30);
    const hazards = ids(w, 'hazard').map((h) => h.hazard!.kind).sort();
    expect(hazards).toEqual(['bazhen', 'shuBanner']);
    // one 七进七出 strike (40) + one 西凉冲锋 trample (70): each charge hit the foe exactly once
    expect(foe.maxHp - foe.hp).toBeCloseTo(40 + 70, 5);
    expect(lb.hp).toBeGreaterThan(200);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
  });
});

describe('关羽 义绝 targeting', () => {
  it('prefers the hero under the crosshair over a soldier standing in front of it', () => {
    const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
    const g = hero(w, 2);
    const foe = hero(w, 3);
    place(w, g, 0, 30);
    place(w, foe, 0, 18);
    const shield = troopsOf(w, foe, 1, 0, 24)[0];
    w.step();
    press(w, 2, 'e', aim(w, g, w.centerOf(foe)));
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    expect(w.hasStatus(shield.id, 'silence')).toBe(false);
  });
});

// ── review fixes: bystanders, exact dash / shove distances, known allies ─────
describe('蜀 movement accuracy', () => {
  const flat = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

  it('青龙斩: units beside or behind 关羽 do not cancel the charge; the target ahead is hit', () => {
    for (const [bx, bz] of [
      [0, 31.2], // 1.2 m behind
      [1.2, 30], // 1.2 m to the side
      [-0.6, 30.3], // overlapping his shoulder
    ]) {
      const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
      const g = hero(w, 2);
      const foe = hero(w, 3);
      const by = hero(w, 4);
      place(w, g, 0, 30);
      place(w, by, bx, bz);
      place(w, foe, 0, 22.5); // 7.5 m ahead
      const soldier = troopsOf(w, hero(w, 0), 1, -1.2, 30.8)[0]; // a Lord's soldier at his back too
      w.step();
      press(w, 2, 'q', { yaw: 0 });
      stepN(w, 20);
      expect(30 - g.pos.z, `bystander at ${bx},${bz}`).toBeGreaterThan(5);
      expect(foe.maxHp - foe.hp, `bystander at ${bx},${bz}`).toBeCloseTo(90 * 1.25, 5);
      expect(g.pos.z).toBeGreaterThan(foe.pos.z); // stopped in front of it, not through it
      expect(by.hp).toBe(by.maxHp);
      expect(soldier.hp).toBe(soldier.maxHp);
    }
  });

  it('青龙斩: stops short of the first unit in front (about 1.2 m gap), not past it', () => {
    const w = world(['dummy', 'dummy', 'guanyu', 'dummy', 'dummy']);
    const g = hero(w, 2);
    const foe = hero(w, 3);
    place(w, g, 0, 30);
    place(w, foe, 0, 24);
    w.step();
    press(w, 2, 'q', { yaw: 0 });
    stepN(w, 20);
    const gap = g.pos.z - foe.pos.z; // the foe was knocked back by the sweep: use its hit position
    expect(gap).toBeGreaterThan(0);
    expect(foe.maxHp - foe.hp).toBeCloseTo(90 * 1.25, 5);
    // where he stopped: 6 m − radius − 1.2 gap ≈ 4.4 m travelled (+ the braked slide)
    expect(30 - g.pos.z).toBeGreaterThan(4.2);
    expect(30 - g.pos.z).toBeLessThan(4.9);
  });

  it('七进七出 covers its data distance (no one-tick overshoot, no long slide)', () => {
    const w = world(['dummy', 'zhaoyun', 'dummy', 'dummy', 'dummy']);
    const zy = hero(w, 1);
    place(w, zy, 0, 30);
    w.step();
    const q = HERO_BY_ID.zhaoyun.abilities.find((a) => a.slot === 'q')!;
    press(w, 1, 'q', { yaw: 0 });
    stepN(w, 40);
    const d = 30 - zy.pos.z;
    expect(d).toBeGreaterThanOrEqual(q.params.dash - 0.05);
    expect(d).toBeLessThan(q.params.dash + 0.35); // walking-speed slide after the brake
    expect(Math.abs(zy.pos.x)).toBeLessThan(1e-6);
  });

  it('长坂救主 ends next to the ally without overlapping it (near and far rescues)', () => {
    for (const z of [22, 15, 11]) {
      const w = world(['dummy', 'zhaoyun', 'dummy', 'dummy', 'dummy']);
      const zy = hero(w, 1);
      const lord = hero(w, 0);
      place(w, zy, 0, 30);
      place(w, lord, 0, z);
      w.step();
      press(w, 1, 'e', aim(w, zy, lord));
      stepN(w, 30);
      const d = flat(zy.pos, lord.pos);
      expect(d, `rescue from ${30 - z} m`).toBeGreaterThan(zy.radius + lord.radius + 0.2);
      expect(d, `rescue from ${30 - z} m`).toBeLessThan(zy.radius + lord.radius + 0.6 + 0.05);
    }
  });

  it('据水断桥 knockback: heroes and soldiers travel about the data distance (no slide)', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    const foe = hero(w, 2);
    place(w, zf, 0, 30);
    place(w, foe, 0, 25);
    const soldier = troopsOf(w, hero(w, 4), 1, -2.5, 26)[0];
    w.step();
    const kb = HERO_BY_ID.zhangfei.abilities.find((a) => a.slot === 'e')!.params.knockback;
    const f0 = { ...foe.pos };
    const s0 = { ...soldier.pos };
    press(w, 1, 'e', { yaw: 0 });
    stepN(w, 60);
    expect(flat(foe.pos, f0)).toBeGreaterThan(kb * 0.9);
    expect(flat(foe.pos, f0)).toBeLessThan(kb * 1.2);
    expect(flat(soldier.pos, s0)).toBeGreaterThan(kb * 0.9);
    expect(flat(soldier.pos, s0)).toBeLessThan(kb * 1.2);
  });

  it('西凉冲锋 knockback: a trampled hero travels about the data distance', () => {
    const w = world(['dummy', 'machao', 'dummy', 'dummy', 'dummy']);
    const mc = hero(w, 1);
    const foe = hero(w, 2);
    place(w, mc, 0, 45);
    place(w, foe, 1, 38);
    w.step();
    const e = HERO_BY_ID.machao.abilities.find((a) => a.slot === 'e')!;
    press(w, 1, 'e', { yaw: 0 });
    let hitAt: Vec3 | undefined;
    for (let i = 0; i < 60; i++) {
      w.step();
      if (!hitAt && foe.hp < foe.maxHp) hitAt = { ...foe.pos };
    }
    expect(hitAt).toBeDefined();
    const travel = flat(foe.pos, hitAt!);
    expect(travel).toBeGreaterThan(e.params.knockback * 0.85);
    expect(travel).toBeLessThan(e.params.knockback * 1.25);
    expect(45 - mc.pos.z).toBeGreaterThanOrEqual(e.params.dash - 0.05);
    expect(45 - mc.pos.z).toBeLessThan(e.params.dash + 0.35);
  });

  it('a knockback replaced by another shove is not braked by the stale watcher', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    const foe = hero(w, 2);
    place(w, zf, 0, 30);
    place(w, foe, 0, 25);
    w.step();
    press(w, 1, 'e', { yaw: 0 });
    stepN(w, 7); // the shout's shove is on its last ticks
    // a second, engine-side shove (e.g. an explosion) takes over mid-flight
    w.knockback(foe.id, { x: 1, y: 0, z: 0 }, 6);
    const f = foe.forced;
    expect(f).toBeDefined();
    stepN(w, 3); // past the end of the first shove, well inside the second (0.3 s)
    expect(foe.forced).toBe(f);
    // still flying sideways at full shove speed: the first watcher let go
    expect(foe.vel.x).toBeGreaterThan(15);
    expect(() => stepN(w, 30)).not.toThrow();
  });
});

describe('蜀 review fixes', () => {
  it('蛇矛连击: a kill with the last shell leaves the gun loaded (no reload inside the window)', () => {
    const w = world(['dummy', 'zhangfei', 'dummy', 'dummy', 'dummy']);
    const zf = hero(w, 1);
    place(w, zf, 0, 30);
    const t = troopsOf(w, hero(w, 4), 1, 0, 27)[0];
    w.step();
    t.hp = 1;
    const gun = zf.hero!.weapons[0]!;
    expect(gun.id).toBe('zhangba');
    gun.mag = 1;
    send(w, 1, [], { ...aim(w, zf, t), buttons: 1 });
    w.step();
    expect(t.alive).toBe(false);
    expect(w.hasStatus(zf.id, 'noReload')).toBe(true);
    expect(gun.mag).toBeGreaterThan(0);
    expect(zf.hero!.reloadUntil).toBeLessThanOrEqual(w.time);
    // a kill that lands while reloading (a burn tick, an ability) racks the gun too
    const t2 = troopsOf(w, hero(w, 4), 1, 3, 27)[0];
    t2.hp = 1;
    gun.mag = 0;
    zf.hero!.reloadUntil = w.time + 2;
    w.dealDamage({ targetId: t2.id, sourceId: zf.id, amount: 5, type: 'fire', abilityId: 'status:burn' });
    expect(t2.alive).toBe(false);
    expect(gun.mag).toBeGreaterThan(0);
    expect(zf.hero!.reloadUntil).toBe(0);
  });

  it('空城: only soldiers fighting 诸葛亮 lose aggro; an uninvolved commander’s troops keep their fight', () => {
    const w = world(['dummy', 'zhugeliang', 'dummy', 'dummy', 'dummy']);
    const lord = hero(w, 0);
    const zgl = hero(w, 1); // loyalist, role unknown to the others
    const rebel = hero(w, 2);
    place(w, lord, -6, 34);
    place(w, zgl, 0, 30);
    place(w, rebel, 6, 20);
    const lordsMan = troopsOf(w, lord, 1, -4, 30)[0];
    const rebelsMan = troopsOf(w, rebel, 1, 4, 26)[0];
    w.step();
    lordsMan.troop!.targetId = rebel.id;
    rebelsMan.troop!.targetId = zgl.id;
    press(w, 1, 'e', { yaw: 0 });
    expect(rebelsMan.troop!.targetId).toBeUndefined();
    expect(lordsMan.troop!.targetId).toBe(rebel.id);
  });

  it('八阵图 spares known allies: a loyalist 诸葛亮 never slows / silences the Lord or the Lord’s soldiers', () => {
    const w = world(['dummy', 'zhugeliang', 'dummy', 'dummy', 'dummy']);
    const lord = hero(w, 0);
    const zgl = hero(w, 1); // loyalist
    const rebel = hero(w, 2);
    const traitor = hero(w, 4);
    place(w, zgl, 0, 32);
    place(w, lord, -2, 20);
    place(w, rebel, 2, 20);
    place(w, traitor, 0, 17);
    const lordsMan = troopsOf(w, lord, 1, -1, 22)[0];
    w.step();
    press(w, 1, 'q', aim(w, zgl, { x: 0, y: 0, z: 20 }));
    stepN(w, 2);
    expect(w.hasStatus(lord.id, 'slow')).toBe(false);
    expect(w.hasStatus(lord.id, 'silence')).toBe(false);
    expect(w.hasStatus(lordsMan.id, 'slow')).toBe(false);
    // unknown heroes are fair game (hidden roles)
    expect(w.hasStatus(rebel.id, 'silence')).toBe(true);
    expect(w.hasStatus(traitor.id, 'slow')).toBe(true);
    // …and a "Lord" who turns on him is no ally any more
    w.dealDamage({ targetId: zgl.id, sourceId: lord.id, amount: 5, type: 'normal', weaponId: 'carbine' });
    stepN(w, 10);
    expect(w.hasStatus(lord.id, 'silence')).toBe(true);
  });

  it('八阵图 of a rebel 诸葛亮 does slow and silence the Lord', () => {
    const w = world(['dummy', 'dummy', 'zhugeliang', 'dummy', 'dummy']);
    const lord = hero(w, 0);
    const zgl = hero(w, 2); // rebel
    place(w, zgl, 0, 32);
    place(w, lord, 0, 20);
    w.step();
    press(w, 2, 'q', aim(w, zgl, { x: 0, y: 0, z: 20 }));
    stepN(w, 2);
    expect(w.hasStatus(lord.id, 'slow')).toBe(true);
    expect(w.hasStatus(lord.id, 'silence')).toBe(true);
  });
});
