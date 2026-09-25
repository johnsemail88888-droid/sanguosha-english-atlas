// 吴 Wu abilities (src/sim/abilities/wu/*): every active does what its
// description says, passives trigger under the right conditions, nothing
// throws for downed / dead / silenced casters or vanished targets, and a
// Wu-only 8-bot brawl plays out.
import { afterEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { Entity, GameEvent, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { BTN_FIRE, defaultSettings, emptyInput } from '../../../src/core/types';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import type { AbilityDef } from '../../../src/data/types';
import { getAbility, hasAbility } from '../../../src/sim/abilities';
import { FIRESHIP_FIELD, LUXUN_FIELD, NAPALM_FIELD } from '../../../src/sim/abilities/wu';
import { aimAnglesFor } from '../../../src/sim/aim';
import { maxReserve, weaponDef } from '../../../src/sim/defs';
import type { MatchInit } from '../../../src/sim/host';
import { generateMap } from '../../../src/sim/map/generate';
import { findOpenGround } from '../../../src/sim/physics';
import type { World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const WU = ['sunquan', 'ganning', 'lumeng', 'huanggai', 'zhouyu', 'daqiao', 'luxun', 'sunshangxiang'];
const D = 'dummy';
const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

// Sim warnings are process-wide and reported once per key: any ability/hook/scheduled
// callback that throws shows up here and fails the test it happened in.
const WARN: string[] = [];
const onWarn = (m: string): void => {
  WARN.push(m);
};
afterEach(() => {
  expect(WARN.filter((m) => m.includes('threw'))).toEqual([]);
});

type MkOpts = NonNullable<Parameters<typeof makeWorld>[1]>;

/** Test-map world with every hero parked far away (move the ones you need with place()). */
function mk(heroes: string[], roles: RoleId[] = STD5, opts: MkOpts = {}): World {
  const w = makeWorld(roles, { heroes, onWarn, ...opts });
  roles.forEach((_, i) => place(w, hero(w, i), -55 + i * 9, 52));
  w.step();
  w.drainEvents();
  return w;
}

let seq = 1;
function send(w: World, seat: number, actions: InputAction[], p: Partial<InputFrame> = {}): void {
  w.setInput(`p${seat}`, { ...emptyInput(seq++), ...p, actions });
}

const chest = (e: Entity): Vec3 => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });

function aimAt(self: Entity, t: Entity | Vec3): Partial<InputFrame> {
  const ent = 'kind' in t ? t : undefined;
  const p = ent ? chest(ent) : (t as Vec3);
  const a = aimAnglesFor(self.pos, p);
  return { yaw: a.yaw, pitch: a.pitch, aimPoint: p, aimTargetId: ent?.id };
}

/** Looking up into the sky: nothing under the crosshair. */
const SKY: Partial<InputFrame> = { yaw: Math.PI, pitch: 1.2 };

const abilityOf = (heroId: string, slot: AbilityDef['slot']): AbilityDef => HERO_BY_ID[heroId].abilities.find((a) => a.slot === slot)!;

/** Press an ability key for one tick; `fired` = the world emitted its activation event. */
function cast(w: World, seat: number, slot: 'q' | 'e' | 'lord', aim: Partial<InputFrame> = {}): { fired: boolean; events: GameEvent[] } {
  const e = hero(w, seat);
  const id = abilityOf(e.hero!.heroId, slot).id;
  send(w, seat, [{ a: 'ability', slot }], aim);
  w.step();
  const events = w.drainEvents();
  return { fired: events.some((ev) => ev.t === 'ability' && ev.src === e.id && ev.ability === id), events };
}

const itemCount = (e: Entity): number => e.hero!.items.reduce((n, s) => n + (s ? s.count : 0), 0);
const lost = (e: Entity): number => e.maxHp - e.hp;
const hazards = (w: World, kind: string, owner?: Entity): Entity[] =>
  w.kindList('hazard').filter((h) => h.hazard!.kind === kind && (!owner || h.ownerId === owner.id));

/** Temporarily override an ability param (the world reads the shared AbilityDef). */
function withParam<T>(heroId: string, abilityId: string, key: string, value: number, fn: () => T): T {
  const def = HERO_BY_ID[heroId].abilities.find((a) => a.id === abilityId)!;
  const old = def.params[key];
  def.params[key] = value;
  try {
    return fn();
  } finally {
    def.params[key] = old;
  }
}

describe('吴 registration', () => {
  it('every Wu ability from the data is implemented; actives can activate, passives cannot', () => {
    for (const id of WU) {
      for (const a of HERO_BY_ID[id].abilities) {
        expect(hasAbility(a.id), a.id).toBe(true);
        const impl = getAbility(a.id)!;
        if (isPassiveAbility(a)) expect(impl.activate, a.id).toBeUndefined();
        else expect(impl.activate, a.id).toBeTypeOf('function');
      }
    }
  });
});

// ── 孙权 ─────────────────────────────────────────────────────────────────────
describe('孙权 Sun Quan', () => {
  it('权衡: every weapon reloads 20 % faster', () => {
    const w = mk(['sunquan', D, D, D, D]);
    expect(w.modifiers(hero(w, 0).id).reloadMul).toBeCloseTo(0.8, 5);
  });

  it('制衡: rerolls the hand (one per occupied slot +1), reloads every weapon from reserve, refills dodges', () => {
    const w = mk(['sunquan', D, D, D, D]);
    const sq = hero(w, 0);
    place(w, sq, 0, 30);
    const h = sq.hero!;
    h.items = [{ id: 'tao', count: 3 }, { id: 'sha', count: 1 }, null, { id: 'jiu', count: 1 }];
    const guns = h.weapons.filter((x) => !!x).map((x) => x!);
    expect(guns.length).toBeGreaterThan(0);
    const reserves = guns.map((g) => {
      g.mag = 0;
      return g.reserve;
    });
    h.dodgeCharges = 0;
    const { fired, events } = cast(w, 0, 'q');
    expect(fired).toBe(true);
    // 3 occupied slots (the stack of 3 桃 counts once) → 3 + 1 fresh draws
    expect(itemCount(sq)).toBe(4);
    const pickups = events.filter((e) => e.t === 'pickup' && e.who === sq.id);
    expect(pickups).toHaveLength(4);
    expect(pickups.every((e) => e.privateTo === sq.id)).toBe(true);
    guns.forEach((g, i) => {
      const def = weaponDef(g.id);
      expect(g.mag).toBe(Math.min(def.magSize, reserves[i]));
      expect(g.reserve).toBe(reserves[i] - g.mag); // reloaded, not free ammo
    });
    expect(h.dodgeCharges).toBe(2);
    expect(w.cooldownLeft(sq.id, 'sunquan_zhiheng')).toBeCloseTo(24, 1);
  });

  it('制衡 with an empty hand still draws the +1', () => {
    const w = mk(['sunquan', D, D, D, D]);
    const sq = hero(w, 0);
    sq.hero!.items = [null, null, null, null];
    expect(cast(w, 0, 'q').fired).toBe(true);
    expect(itemCount(sq)).toBe(1);
  });

  it('坐断东南: recruits 2 Jiefan marksmen, never more than 2 over the squad cap', () => {
    const w = mk(['sunquan', D, D, D, D]); // squads off: empty squad; lord cap 4 + 2, +2 over
    const sq = hero(w, 0);
    place(w, sq, 0, 30);
    expect(cast(w, 0, 'e').fired).toBe(true);
    expect(sq.hero!.squad).toHaveLength(2);
    for (const id of sq.hero!.squad) expect(w.get(id)!.troop!.troopType).toBe('wu_crossbow');
    w.spawnTroops(sq.id, 'wu_crossbow', 5); // 7 of 8
    w.setCooldown(sq.id, 'sunquan_zuoduan', 0);
    expect(cast(w, 0, 'e').fired).toBe(true);
    expect(sq.hero!.squad).toHaveLength(8);
    w.setCooldown(sq.id, 'sunquan_zuoduan', 0);
    expect(cast(w, 0, 'e').fired).toBe(false); // full: no cooldown
    expect(sq.hero!.squad).toHaveLength(8);
    expect(w.cooldownLeft(sq.id, 'sunquan_zuoduan')).toBe(0);
  });

  it('救援 (lord): Wu units within 15 m take 30 % less for 6 s and he regens 10/s per Wu hero', () => {
    const w = mk(['sunquan', 'zhouyu', D, D, D]);
    const [sq, zy, foe, far] = [hero(w, 0), hero(w, 1), hero(w, 2), hero(w, 3)];
    place(w, sq, 0, 30);
    place(w, zy, 4, 30);
    place(w, foe, -4, 30);
    const wuTroop = w.spawnTroops(zy.id, 'wu_crossbow', 1, { x: 4, y: 0, z: 26 })[0];
    sq.hp = 200;
    expect(cast(w, 0, 'lord').fired).toBe(true);
    expect(w.hasStatus(sq.id, 'dmgTakenDown')).toBe(true);
    expect(w.hasStatus(zy.id, 'dmgTakenDown')).toBe(true);
    expect(w.hasStatus(wuTroop.id, 'dmgTakenDown')).toBe(true);
    expect(w.hasStatus(foe.id, 'dmgTakenDown')).toBe(false); // 群 hero
    expect(w.hasStatus(far.id, 'dmgTakenDown')).toBe(false);
    expect(w.dealDamage({ targetId: zy.id, sourceId: foe.id, amount: 100, type: 'normal' }).dealt).toBeCloseTo(70, 5);
    stepN(w, 6 * 30 + 3);
    // 12 half-second pulses × 2 Wu heroes × 10 HP/s
    expect(sq.hp).toBeCloseTo(200 + 10 * 2 * 6, 0);
    expect(w.hasStatus(zy.id, 'dmgTakenDown')).toBe(false);
  });

  it('救援 ends when he goes down, and does not exist for a Sun Quan who is not the real lord', () => {
    const w = mk(['sunquan', 'zhouyu', D, D, D]);
    const [sq, zy] = [hero(w, 0), hero(w, 1)];
    place(w, sq, 0, 30);
    place(w, zy, 4, 30);
    cast(w, 0, 'lord');
    w.downHero(sq, undefined);
    stepN(w, 12);
    expect(w.hasStatus(zy.id, 'dmgTakenDown')).toBe(false);

    const w2 = mk([D, 'sunquan', D, D, D]);
    const sq2 = hero(w2, 1);
    expect(w2.heroRt(sq2.id)!.abilities.some((a) => a.def.id === 'sunquan_jiuyuan')).toBe(false);
    send(w2, 1, [{ a: 'ability', slot: 'lord' }]);
    w2.step();
    expect(w2.hasStatus(sq2.id, 'dmgTakenDown')).toBe(false);
    expect(w2.cooldownLeft(sq2.id, 'sunquan_jiuyuan')).toBe(0);
  });
});

// ── 甘宁 ─────────────────────────────────────────────────────────────────────
describe('甘宁 Gan Ning', () => {
  function raid(): { w: World; g: Entity; foe: Entity } {
    const w = mk([D, D, 'ganning', D, D]);
    const g = hero(w, 2);
    const foe = hero(w, 4);
    place(w, g, 0, 30);
    place(w, foe, 0, 22);
    return { w, g, foe };
  }

  it('锦帆: +10 % speed; a kill (or downing a hero) refills the magazine', () => {
    const { w, g, foe } = raid();
    expect(w.modifiers(g.id).speedMul).toBeCloseTo(1.1, 5);
    const inst = g.hero!.weapons[g.hero!.activeSlot]!;
    const full = weaponDef(inst.id).magSize;
    const troop = w.spawnTroops(foe.id, 'shu_rifleman', 1)[0];
    inst.mag = 2;
    w.dealDamage({ targetId: troop.id, sourceId: g.id, amount: 9999, type: 'normal', weaponId: inst.id });
    expect(troop.alive).toBe(false);
    expect(inst.mag).toBe(full);
    inst.mag = 2;
    w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 9999, type: 'normal', weaponId: inst.id });
    expect(foe.hero!.downed).toBe(true);
    expect(inst.mag).toBe(full);
  });

  it('奇袭: the EMP bolt drops armor + mount as loot, clears the shield and silences 2.5 s', () => {
    const { w, g, foe } = raid();
    w.equip(foe.id, 'bagua');
    w.equip(foe.id, 'chitu');
    w.addShield(foe.id, 80, 10);
    const { fired } = cast(w, 2, 'q', aimAt(g, foe));
    expect(fired).toBe(true);
    expect(foe.hero!.armor).toBeNull();
    expect(foe.hero!.mount).toBeNull();
    expect(foe.shield).toBe(0);
    expect(w.hasStatus(foe.id, 'shield')).toBe(false);
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    const loot = w.kindList('loot').map((l) => l.loot!.itemId);
    expect(loot).toContain('bagua');
    expect(loot).toContain('chitu');
    expect(w.cooldownLeft(g.id, 'ganning_qixi')).toBeCloseTo(18, 1);
    stepN(w, 2.5 * 30 + 2);
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
  });

  it('奇袭: 无懈可击 cancels the whole bolt (spent); no target → no cooldown', () => {
    const { w, g, foe } = raid();
    w.equip(foe.id, 'bagua');
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    expect(cast(w, 2, 'q', aimAt(g, foe)).fired).toBe(true);
    expect(foe.hero!.armor).toBe('bagua');
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(false);
    expect(w.cooldownLeft(g.id, 'ganning_qixi')).toBeGreaterThan(0);

    const r = raid();
    expect(cast(r.w, 2, 'q', SKY).fired).toBe(false);
    expect(r.w.cooldownLeft(r.g.id, 'ganning_qixi')).toBe(0);
  });

  it('奇袭: a 无懈可击 already spent on his effect this tick cancels the whole bolt too (no strip)', () => {
    const { w, g, foe } = raid();
    w.equip(foe.id, 'bagua');
    w.equip(foe.id, 'chitu');
    w.addShield(foe.id, 50, 10);
    // the echo of a charge consumed by an earlier effect of Gan Ning in the cast tick
    w.nullifyEcho.set(foe.id, { creditId: g.id, tick: w.tick + 1 });
    expect(cast(w, 2, 'q', aimAt(g, foe)).fired).toBe(true);
    expect(foe.hero!.armor).toBe('bagua');
    expect(foe.hero!.mount).toBe('chitu');
    expect(foe.shield).toBeCloseTo(50, 5);
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
    expect(w.cooldownLeft(g.id, 'ganning_qixi')).toBeGreaterThan(0);
  });

  it('百骑劫营: he and his squad turn stealthy; the first attack (one trigger pull, ≤ 1 s) gets +60 %', () => {
    const { w, g, foe } = raid();
    const squad = w.spawnTroops(g.id, 'wu_crossbow', 2);
    expect(cast(w, 2, 'e').fired).toBe(true);
    expect(w.hasStatus(g.id, 'stealth')).toBe(true);
    for (const t of squad) expect(w.hasStatus(t.id, 'stealth')).toBe(true);
    expect(w.canSee(foe, g)).toBe(false); // 8 m away
    const wid = g.hero!.weapons[g.hero!.activeSlot]!.id;
    const shot = (): number => w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 10, type: 'normal', weaponId: wid }).dealt;
    // ability damage is not an attack from stealth
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 10, type: 'normal' }).dealt).toBeCloseTo(10, 5);
    expect(shot()).toBeCloseTo(16, 5);
    // he pulls the trigger (into the sky) and keeps it held: stealth breaks, the attack goes on
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    w.step();
    expect(w.hasStatus(g.id, 'stealth')).toBe(false);
    expect(shot()).toBeCloseTo(16, 5);
    stepN(w, 20);
    expect(shot()).toBeCloseTo(16, 5);
    stepN(w, 12); // past 1 s
    expect(shot()).toBeCloseTo(10, 5);
    foe.hp = foe.maxHp;
  });

  it('百骑劫营: releasing the trigger ends the attack; the bonus expires with the stealth', () => {
    const { w, g, foe } = raid();
    cast(w, 2, 'e');
    const wid = g.hero!.weapons[g.hero!.activeSlot]!.id;
    const shot = (): number => w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 10, type: 'normal', weaponId: wid }).dealt;
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    w.step();
    send(w, 2, [], SKY);
    w.step();
    expect(w.hasStatus(g.id, 'stealth')).toBe(false);
    expect(shot()).toBeCloseTo(10, 5);
    const r = raid();
    cast(r.w, 2, 'e');
    stepN(r.w, 8 * 30 + 2);
    expect(r.w.hasStatus(r.g.id, 'stealth')).toBe(false);
    const wid2 = r.g.hero!.weapons[r.g.hero!.activeSlot]!.id;
    expect(r.w.dealDamage({ targetId: r.foe.id, sourceId: r.g.id, amount: 10, type: 'normal', weaponId: wid2 }).dealt).toBeCloseTo(10, 5);
  });

  it('百骑劫营: a projectile weapon\'s first volley is boosted once, at launch', () => {
    const { w, g } = raid();
    w.giveWeapon(g.id, 'guanshi');
    const def = weaponDef('guanshi');
    cast(w, 2, 'e');
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    w.step();
    send(w, 2, [], SKY);
    const shells = w.kindList('projectile').filter((p) => p.ownerId === g.id && p.proj!.weaponId === 'guanshi');
    expect(shells.length).toBeGreaterThan(0);
    for (const p of shells) expect(p.proj!.explodeDamage).toBeCloseTo(def.projectile!.explodeDamage * 1.6, 5);
  });
});

// ── 吕蒙 ─────────────────────────────────────────────────────────────────────
describe('吕蒙 Lü Meng', () => {
  function lm(): { w: World; l: Entity; foe: Entity } {
    const w = mk([D, D, 'lumeng', D, D]);
    const l = hero(w, 2);
    const foe = hero(w, 4);
    place(w, l, 0, 30);
    place(w, foe, 0, 22);
    return { w, l, foe };
  }
  const kejiOn = (w: World, e: Entity): boolean => e.statuses.some((s) => s.id === 'stealth' && s.until > w.time && (s.params?.keji ?? 0) > 0);

  it('克己: 5 s without firing or damage → stealth; damage breaks it; the idle timer restarts', () => {
    const { w, l, foe } = lm();
    stepN(w, 5 * 30 + 2);
    expect(kejiOn(w, l)).toBe(true);
    expect(w.canSee(foe, l)).toBe(false);
    w.dealDamage({ targetId: l.id, sourceId: foe.id, amount: 5, type: 'normal' });
    expect(w.hasStatus(l.id, 'stealth')).toBe(false);
    stepN(w, 4 * 30);
    expect(w.hasStatus(l.id, 'stealth')).toBe(false);
    stepN(w, 32);
    expect(kejiOn(w, l)).toBe(true);
    // lasts at most 8 s, then he must stay idle another 5 s
    stepN(w, 8 * 30 + 2);
    expect(kejiOn(w, l)).toBe(false);
  });

  it('克己: firing breaks it and resets the idle timer; no stealth while downed', () => {
    const { w, l } = lm();
    stepN(w, 5 * 30 + 2);
    expect(kejiOn(w, l)).toBe(true);
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    w.step();
    send(w, 2, [], SKY);
    w.step();
    expect(w.hasStatus(l.id, 'stealth')).toBe(false);
    stepN(w, 4 * 30);
    expect(w.hasStatus(l.id, 'stealth')).toBe(false);
    w.downHero(l, undefined);
    stepN(w, 6 * 30);
    expect(w.hasStatus(l.id, 'stealth')).toBe(false);
  });

  it('白衣渡江: 6 s stealth + 30 % haste that damage does not break', () => {
    const { w, l, foe } = lm();
    expect(cast(w, 2, 'q').fired).toBe(true);
    expect(w.hasStatus(l.id, 'stealth')).toBe(true);
    expect(w.statusParam(l.id, 'haste', 'amount', 0)).toBeCloseTo(0.3, 5);
    w.dealDamage({ targetId: l.id, sourceId: foe.id, amount: 5, type: 'normal' });
    expect(w.hasStatus(l.id, 'stealth')).toBe(true);
    stepN(w, 6 * 30 + 2);
    expect(l.statuses.some((s) => s.id === 'stealth' && s.sourceId === l.id && s.until > w.time)).toBe(false);
    expect(w.hasStatus(l.id, 'haste')).toBe(false);
  });

  it('攻心: disarms the crosshair enemy 2 s and steals an item; 谦逊 keeps the item', () => {
    const { w, l, foe } = lm();
    foe.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    l.hero!.items = [null, null, null, null];
    expect(cast(w, 2, 'e', aimAt(l, foe)).fired).toBe(true);
    expect(w.hasStatus(foe.id, 'disarm')).toBe(true);
    expect(itemCount(foe)).toBe(0);
    expect(l.hero!.items.some((s) => s?.id === 'tao')).toBe(true);
    stepN(w, 2 * 30 + 2);
    expect(w.hasStatus(foe.id, 'disarm')).toBe(false);

    const w2 = mk([D, D, 'lumeng', D, 'luxun']);
    const [l2, lx] = [hero(w2, 2), hero(w2, 4)];
    place(w2, l2, 0, 30);
    place(w2, lx, 0, 22);
    lx.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    expect(cast(w2, 2, 'e', aimAt(l2, lx)).fired).toBe(true);
    expect(w2.hasStatus(lx.id, 'disarm')).toBe(true);
    expect(itemCount(lx)).toBe(1);
  });
});

// ── 黄盖 ─────────────────────────────────────────────────────────────────────
describe('黄盖 Huang Gai', () => {
  function hg(): { w: World; g: Entity; foe: Entity } {
    const w = mk([D, D, 'huanggai', D, D]);
    const g = hero(w, 2);
    const foe = hero(w, 4);
    place(w, g, 0, 30);
    place(w, foe, 0, 18);
    return { w, g, foe };
  }

  it('赤胆: below 50 % HP his fire and explosive damage is +30 %', () => {
    const { w, g, foe } = hg();
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 100, type: 'fire' }).dealt).toBeCloseTo(100, 5);
    g.hp = 150;
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 100, type: 'fire' }).dealt).toBeCloseTo(130, 5);
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 50, type: 'explosive' }).dealt).toBeCloseTo(65, 5);
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 50, type: 'normal' }).dealt).toBeCloseTo(50, 5);
  });

  it('苦肉: lose 40 HP (not damage) → 2 items and ×1.4 fire rate 5 s; needs more than 40 HP', () => {
    const { w, g } = hg();
    g.hero!.items = [null, null, null, null];
    g.shield = 0;
    w.addShield(g.id, 50, 10);
    expect(cast(w, 2, 'q').fired).toBe(true);
    expect(g.hp).toBe(360);
    expect(g.shield).toBe(50); // not damage: the shield is untouched
    expect(itemCount(g)).toBe(2);
    expect(w.statusParam(g.id, 'fireRateUp', 'mul', 1)).toBeCloseTo(1.4, 5);
    stepN(w, 5 * 30 + 2);
    expect(w.hasStatus(g.id, 'fireRateUp')).toBe(false);
    g.hp = 40;
    w.setCooldown(g.id, 'huanggai_kurou', 0);
    expect(cast(w, 2, 'q').fired).toBe(false);
    expect(g.hp).toBe(40);
    expect(w.cooldownLeft(g.id, 'huanggai_kurou')).toBe(0);
  });

  it('诈降火船: the drone flies at 12 m/s, blows up on contact (120 fire, 6 m) and leaves a burning field', () => {
    const { w, g, foe } = hg();
    const bystander = hero(w, 3);
    place(w, bystander, 4, 17);
    cast(w, 2, 'e', aimAt(g, foe));
    const ship = w.kindList('projectile').find((p) => p.proj!.abilityId === 'huanggai_huochuan');
    expect(ship).toBeDefined();
    expect(Math.hypot(ship!.vel.x, ship!.vel.y, ship!.vel.z)).toBeCloseTo(12, 3);
    stepN(w, 15);
    expect(lost(foe)).toBe(0); // still on its way (12 m away)
    stepN(w, 25);
    expect(ship!.alive).toBe(false);
    expect(lost(foe)).toBeGreaterThanOrEqual(110);
    expect(lost(foe)).toBeLessThanOrEqual(130);
    expect(lost(bystander)).toBeGreaterThan(50); // inside 6 m: falloff, but hit
    expect(hazards(w, FIRESHIP_FIELD, g)).toHaveLength(1);
    const after = lost(foe);
    stepN(w, 30);
    expect(lost(foe)).toBeGreaterThan(after); // burning ground (15/s)
    expect(lost(g)).toBe(0); // never his own blast
  });

  it('诈降火船: explodes after 3 s in the open, and still explodes if he dies mid-flight', () => {
    const { w, g } = hg();
    cast(w, 2, 'e', { yaw: Math.PI / 2, pitch: 0 });
    stepN(w, 80);
    expect(hazards(w, FIRESHIP_FIELD, g)).toHaveLength(0);
    stepN(w, 14);
    const f = hazards(w, FIRESHIP_FIELD, g);
    expect(f).toHaveLength(1);
    expect(f[0].pos.x).toBeLessThan(-30);

    const r = hg();
    cast(r.w, 2, 'e', aimAt(r.g, r.foe));
    r.w.killHero(r.g, undefined);
    stepN(r.w, 40);
    expect(lost(r.foe)).toBeGreaterThanOrEqual(100);
  });
});

// ── 周瑜 ─────────────────────────────────────────────────────────────────────
describe('周瑜 Zhou Yu', () => {
  it('英姿: reload ×0.75 and ability cooldowns ×0.85', () => {
    const w = mk([D, D, 'zhouyu', D, D]);
    const zy = hero(w, 2);
    expect(w.modifiers(zy.id).reloadMul).toBeCloseTo(0.75, 5);
    expect(w.modifiers(zy.id).cooldownMul).toBeCloseTo(0.85, 5);
    place(w, zy, 0, 30);
    cast(w, 2, 'e');
    expect(w.cooldownLeft(zy.id, 'zhouyu_chibi')).toBeCloseTo(28 * 0.85, 1);
  });

  it('反间: the charmed enemy attacks the nearest other hero (never him); nobody near → disarm', () => {
    const w = mk([D, D, 'zhouyu', D, D]);
    const [zy, other, foe] = [hero(w, 2), hero(w, 3), hero(w, 4)];
    place(w, zy, 0, 26);
    place(w, foe, 0, 22);
    place(w, other, 5, 18);
    expect(cast(w, 2, 'q', aimAt(zy, foe)).fired).toBe(true);
    expect(w.hasStatus(foe.id, 'charm')).toBe(true);
    expect(w.statusParam(foe.id, 'charm', 'targetId', -1)).toBe(other.id);
    stepN(w, 45);
    expect(lost(other)).toBeGreaterThan(0); // it really shot its neighbour
    expect(lost(zy)).toBe(0);
    stepN(w, 20);
    expect(w.hasStatus(foe.id, 'charm')).toBe(false);

    const w2 = mk([D, D, 'zhouyu', D, D]);
    const [zy2, foe2] = [hero(w2, 2), hero(w2, 4)];
    place(w2, zy2, 0, 30);
    place(w2, foe2, 0, 22);
    expect(cast(w2, 2, 'q', aimAt(zy2, foe2)).fired).toBe(true);
    expect(w2.hasStatus(foe2.id, 'charm')).toBe(false);
    expect(w2.hasStatus(foe2.id, 'disarm')).toBe(true);
  });

  it('反间: 谦逊 makes 陆逊 an invalid target (no cooldown); a downed or missing target fails', () => {
    const w = mk([D, D, 'zhouyu', D, 'luxun']);
    const [zy, other, lx] = [hero(w, 2), hero(w, 3), hero(w, 4)];
    place(w, zy, 0, 30);
    place(w, lx, 0, 22);
    place(w, other, 4, 20);
    expect(cast(w, 2, 'q', aimAt(zy, lx)).fired).toBe(false);
    expect(w.hasStatus(lx.id, 'charm')).toBe(false);
    expect(w.cooldownLeft(zy.id, 'zhouyu_fanjian')).toBe(0);
    w.downHero(other, undefined);
    expect(cast(w, 2, 'q', aimAt(zy, other)).fired).toBe(false);
    expect(cast(w, 2, 'q', SKY).fired).toBe(false);
  });

  it('反间: never turns the victim on a hero hidden in stealth; a target that vanishes is swapped', () => {
    const w = mk([D, D, 'zhouyu', D, D]);
    const [far, zy, near, foe] = [hero(w, 0), hero(w, 2), hero(w, 3), hero(w, 4)];
    place(w, zy, 0, 26);
    place(w, foe, 0, 22);
    place(w, near, 8, 16); // 10 m from the victim, in stealth: invisible to it
    place(w, far, -14, 8); // ≈ 20 m, in plain sight
    w.applyStatus(near.id, 'stealth', 30, { sourceId: near.id });
    expect(w.canSee(foe, near)).toBe(false);
    const { fired, events } = cast(w, 2, 'q', aimAt(zy, foe));
    expect(fired).toBe(true);
    expect(w.statusParam(foe.id, 'charm', 'targetId', -1)).toBe(far.id);
    // the public cast event never points at the stealthed hero either
    const ev = events.find((e) => e.t === 'ability' && e.ability === 'zhouyu_fanjian');
    expect(ev?.t === 'ability' && ev.pos ? Math.hypot(ev.pos.x - near.pos.x, ev.pos.z - near.pos.z) : 0).toBeGreaterThan(6);
    // mid-charm the target slips into stealth → swapped for the next visible hero (none → ends)
    w.removeStatus(near.id, 'stealth');
    w.applyStatus(far.id, 'stealth', 30, { sourceId: far.id });
    w.step();
    expect(w.statusParam(foe.id, 'charm', 'targetId', -1)).toBe(near.id);
    w.applyStatus(near.id, 'stealth', 30, { sourceId: near.id });
    w.step();
    w.step();
    expect(w.hasStatus(foe.id, 'charm')).toBe(false);

    // only a stealthed hero around → disarm instead
    const w2 = mk([D, D, 'zhouyu', D, D]);
    const [zy2, near2, foe2] = [hero(w2, 2), hero(w2, 3), hero(w2, 4)];
    place(w2, zy2, 0, 30);
    place(w2, foe2, 0, 22);
    place(w2, near2, 8, 18);
    w2.applyStatus(near2.id, 'stealth', 30, { sourceId: near2.id });
    expect(cast(w2, 2, 'q', aimAt(zy2, foe2)).fired).toBe(true);
    expect(w2.hasStatus(foe2.id, 'charm')).toBe(false);
    expect(w2.hasStatus(foe2.id, 'disarm')).toBe(true);
  });

  it('火烧赤壁: after 1.5 s five bombs hit the 25 m line: 100 fire once per unit, then burning ground', () => {
    const w = mk([D, D, 'zhouyu', D, D]);
    const [zy, a, b] = [hero(w, 2), hero(w, 3), hero(w, 4)];
    place(w, zy, 0, 40);
    place(w, a, 0, 40 - 9.375); // between bombs 2 and 3 (6.25 m apart): inside both blasts
    place(w, b, 6, 40 - 12.5); // 6 m off the line
    expect(cast(w, 2, 'e', { yaw: 0, pitch: 0 }).fired).toBe(true);
    // the line was fixed at cast time
    place(w, zy, -20, 40);
    stepN(w, 44);
    expect(lost(a)).toBe(0);
    stepN(w, 1);
    expect(lost(a)).toBeCloseTo(100, 5);
    expect(lost(b)).toBe(0);
    expect(hazards(w, NAPALM_FIELD, zy)).toHaveLength(5);
    stepN(w, 30);
    // burning ground: 15/s; overlapping edges of two fields don't stack
    expect(lost(a)).toBeGreaterThan(100);
    expect(lost(a)).toBeLessThanOrEqual(100 + 15 * 1.5 + 1e-6);
    stepN(w, 6 * 30);
    expect(hazards(w, NAPALM_FIELD, zy)).toHaveLength(0);
  });

  it('火烧赤壁: a bomb bursting on a roof neither blasts nor burns whoever stands under it', () => {
    const w = mk([D, D, 'zhouyu', D, D]);
    const [zy, under, open] = [hero(w, 2), hero(w, 3), hero(w, 4)];
    // bombs at z = -32.5, -26.25, -20 (on the roof slab over (-20, -20)), -13.75, -7.5
    place(w, zy, -20, -32.5);
    place(w, under, -20, -20);
    under.pos.y = 0; // on the floor under the slab (2.5–2.9 m), not on top of it
    place(w, open, -20, -26.25);
    cast(w, 2, 'e', { yaw: Math.PI, pitch: 0 });
    expect(under.pos.y).toBeLessThan(0.1);
    stepN(w, 45 + 60);
    expect(lost(open)).toBeGreaterThanOrEqual(100);
    expect(lost(under)).toBe(0);
    expect(hazards(w, NAPALM_FIELD, zy).some((h) => h.pos.y > 2)).toBe(true);
  });

  it('火烧赤壁 lands even if he dies during the 1.5 s delay', () => {
    const w = mk([D, D, 'zhouyu', D, D]);
    const [zy, a] = [hero(w, 2), hero(w, 3)];
    place(w, zy, 0, 40);
    place(w, a, 0, 27.5);
    cast(w, 2, 'e', { yaw: 0, pitch: 0 });
    w.killHero(zy, undefined);
    stepN(w, 46);
    expect(lost(a)).toBeGreaterThanOrEqual(100);
  });
});

// ── 大乔 ─────────────────────────────────────────────────────────────────────
describe('大乔 Da Qiao', () => {
  function dq(heroes = [D, D, 'daqiao', D, D]): { w: World; q: Entity; att: Entity; by: Entity } {
    const w = mk(heroes);
    const q = hero(w, 2);
    const att = hero(w, 4);
    const by = hero(w, 3);
    place(w, q, 0, 30);
    place(w, att, 0, 20); // 10 m: outside 流离 range anyway
    place(w, by, 4, 30);
    return { w, q, att, by };
  }
  const bullet = (w: World, from: Entity, to: Entity, amount: number): void => {
    w.dealDamage({ targetId: to.id, sourceId: from.id, amount, type: 'normal', weaponId: 'carbine' });
  };

  it('流离: a displaced bullet hits another unit within 8 m instead of her (never the attacker)', () => {
    withParam('daqiao', 'daqiao_liuli', 'chance', 1, () => {
      const { w, q, att, by } = dq();
      bullet(w, att, q, 50);
      expect(lost(q)).toBe(0);
      expect(lost(by)).toBeCloseTo(50, 5);
      expect(w.drainEvents().some((e) => e.t === 'ability' && e.ability === 'daqiao_liuli' && e.target === by.id)).toBe(true);
      // ability damage is not a bullet
      w.dealDamage({ targetId: q.id, sourceId: att.id, amount: 20, type: 'normal' });
      expect(lost(q)).toBeCloseTo(20, 5);
      // only the attacker nearby → nothing to displace to
      place(w, by, 40, 30);
      place(w, att, 0, 26);
      bullet(w, att, q, 30);
      expect(lost(q)).toBeCloseTo(50, 5);
      expect(lost(att)).toBe(0);
    });
  });

  it('流离: redirected bullets never bounce again (two Da Qiaos)', () => {
    withParam('daqiao', 'daqiao_liuli', 'chance', 1, () => {
      const w = mk([D, 'daqiao', 'daqiao', D, D]);
      const [q1, q2, att] = [hero(w, 1), hero(w, 2), hero(w, 4)];
      place(w, q1, 0, 30);
      place(w, q2, 3, 30);
      place(w, att, 0, 18);
      bullet(w, att, q1, 40);
      expect(lost(q1)).toBe(0);
      expect(lost(q2)).toBeCloseTo(40, 5);
    });
  });

  it('流离: about 30 % of bullets are displaced; none while she is downed', () => {
    const { w, q, att, by } = dq();
    for (let i = 0; i < 300; i++) bullet(w, att, q, 1);
    expect(lost(by)).toBeGreaterThan(55);
    expect(lost(by)).toBeLessThan(125);
    expect(lost(q) + lost(by)).toBeCloseTo(300, 5);
    withParam('daqiao', 'daqiao_liuli', 'chance', 1, () => {
      w.downHero(q, att.id);
      const before = lost(by);
      bullet(w, att, q, 10);
      expect(lost(by)).toBe(before);
    });
  });

  it('流离: never into a downed friend or a known ally — her own soldier takes it, else she does', () => {
    withParam('daqiao', 'daqiao_liuli', 'chance', 1, () => {
      // loyalist Da Qiao reviving her downed Lord under fire, her soldier nearby
      const w = mk([D, 'daqiao', D, D, D]);
      const [lord, q, att, by] = [hero(w, 0), hero(w, 1), hero(w, 4), hero(w, 3)];
      place(w, q, 0, 30);
      place(w, lord, 1.5, 30);
      place(w, att, 0, 20);
      const own = w.spawnTroops(q.id, 'wu_crossbow', 1, { x: -3, y: 0, z: 30 })[0];
      w.downHero(lord, att.id);
      const bleed = lord.hero!.downedUntil;
      bullet(w, att, q, 40);
      expect(lost(own)).toBeGreaterThan(0);
      expect(lost(q)).toBe(0);
      expect(lord.hero!.downedUntil).toBe(bleed);
      // soldier gone: six more hits all stay on her, the Lord's bleed-out is untouched
      w.killUnit(own, undefined, false);
      for (let i = 0; i < 6; i++) bullet(w, att, q, 40);
      expect(lord.hero!.downedUntil).toBe(bleed);
      expect(lord.hero!.dead).toBe(false);
      expect(lost(q)).toBeCloseTo(240, 5);
      // standing, the Lord (a known ally) is still never picked; an unknown hero is
      w.revive(lord.id, 100, q.id);
      q.hp = q.maxHp;
      bullet(w, att, q, 30);
      expect(lost(q)).toBeCloseTo(30, 5);
      expect(lord.hp).toBe(100);
      place(w, by, -2, 31);
      bullet(w, att, q, 30);
      expect(lost(by)).toBeCloseTo(30, 5);
      expect(lord.hp).toBe(100);
    });
  });

  it('流离: a downed known enemy is fair game; walls and stealth hide candidates', () => {
    withParam('daqiao', 'daqiao_liuli', 'chance', 1, () => {
      // rebel Da Qiao: the (public) Lord is a known enemy
      const w = mk([D, D, 'daqiao', D, D]);
      const [lord, q, by, att] = [hero(w, 0), hero(w, 2), hero(w, 3), hero(w, 4)];
      place(w, q, 0, 30);
      place(w, lord, 2, 30);
      place(w, att, 0, 20);
      w.downHero(lord, att.id);
      const bleed = lord.hero!.downedUntil;
      bullet(w, att, q, 20);
      expect(lost(q)).toBe(0);
      expect(lord.hero!.downedUntil).toBeCloseTo(bleed - 20 * 0.1, 5);

      // the 3 m wall at x = 10 (z −5…5) stands between her and the only other unit
      const w2 = mk([D, D, 'daqiao', D, D]);
      const [q2, by2, att2] = [hero(w2, 2), hero(w2, 3), hero(w2, 4)];
      place(w2, q2, 8.5, 0);
      place(w2, by2, 12.5, 0);
      place(w2, att2, 0, 0);
      bullet(w2, att2, q2, 25);
      expect(lost(q2)).toBeCloseTo(25, 5);
      expect(lost(by2)).toBe(0);
      place(w2, by2, 8.5, 3.5);
      bullet(w2, att2, q2, 25);
      expect(lost(by2)).toBeCloseTo(25, 5);
      // stealthed 7 m away (she can't see it): not a candidate
      place(w2, by2, 8.5, 7.5);
      w2.applyStatus(by2.id, 'stealth', 10, { sourceId: by2.id });
      bullet(w2, att2, q2, 25);
      expect(lost(q2)).toBeCloseTo(50, 5);
      expect(lost(by2)).toBeCloseTo(25, 5);
      void by;
    });
  });

  it('流离: the displaced bullet is the full shot — 酒 doubles it once, 寒冰 slows, the attacker is credited', () => {
    withParam('daqiao', 'daqiao_liuli', 'chance', 1, () => {
      const { w, q, att, by } = dq();
      const lordHero = hero(w, 0);
      w.applyStatus(att.id, 'drunk', 8, { sourceId: att.id, params: { mul: 2, weaponOnly: 1 } });
      w.step();
      bullet(w, att, q, 50);
      expect(lost(q)).toBe(0);
      expect(lost(by)).toBeCloseTo(100, 5);
      expect(w.hasStatus(att.id, 'drunk')).toBe(false); // spent once, by the displaced bullet
      bullet(w, att, q, 50);
      expect(lost(by)).toBeCloseTo(150, 5);

      // the 酒 went into an earlier hit of the same tick (another target): not carried over twice
      w.applyStatus(att.id, 'drunk', 8, { sourceId: att.id, params: { mul: 2, weaponOnly: 1 } });
      w.step();
      bullet(w, att, lordHero, 10);
      expect(lost(lordHero)).toBeCloseTo(20, 5);
      bullet(w, att, q, 50);
      expect(lost(by)).toBeCloseTo(200, 5);

      // weapon on-hit specials land on the new victim (寒冰: slow stacks), not on her
      w.dealDamage({ targetId: q.id, sourceId: att.id, amount: 10, type: 'normal', weaponId: 'hanbing' });
      expect(w.hasStatus(by.id, 'slow')).toBe(true);
      expect(w.hasStatus(q.id, 'slow')).toBe(false);

      // a lethal redirect is the attacker's hit (kill credit, attack memory)
      by.hp = 5;
      bullet(w, att, q, 50);
      expect(by.hero!.downed).toBe(true);
      expect(by.lastDamagedBy).toBe(att.id);
      expect(lost(q)).toBe(0);
    });
  });

  it('国色: the crosshair enemy dances 2.5 s and cannot shoot; 谦逊 / 无懈可击 handled', () => {
    const { w, q, att } = dq();
    expect(cast(w, 2, 'q', aimAt(q, att)).fired).toBe(true);
    expect(w.hasStatus(att.id, 'dance')).toBe(true);
    const inst = att.hero!.weapons[att.hero!.activeSlot]!;
    const mag = inst.mag;
    send(w, 4, [], { ...aimAt(att, q), buttons: BTN_FIRE });
    stepN(w, 10);
    expect(inst.mag).toBe(mag);
    stepN(w, 2.5 * 30);
    expect(w.hasStatus(att.id, 'dance')).toBe(false);

    const w2 = mk([D, D, 'daqiao', D, 'luxun']);
    const [q2, lx] = [hero(w2, 2), hero(w2, 4)];
    place(w2, q2, 0, 30);
    place(w2, lx, 0, 22);
    expect(cast(w2, 2, 'q', aimAt(q2, lx)).fired).toBe(false);
    expect(w2.cooldownLeft(q2.id, 'daqiao_guose')).toBe(0);

    const r = dq();
    r.w.applyStatus(r.att.id, 'nullify', 20, { sourceId: r.att.id });
    expect(cast(r.w, 2, 'q', aimAt(r.q, r.att)).fired).toBe(true);
    expect(r.w.hasStatus(r.att.id, 'dance')).toBe(false);
    expect(r.w.cooldownLeft(r.q.id, 'daqiao_guose')).toBeGreaterThan(0);
  });

  it('安娴: heals her, her soldiers and every hero within 8 m for 80', () => {
    const { w, q, att, by } = dq();
    const lordHero = hero(w, 0);
    place(w, att, 12, 30); // 12 m: out of range
    const own = w.spawnTroops(q.id, 'wu_crossbow', 1, { x: 0, y: 0, z: 33 })[0];
    const enemyTroop = w.spawnTroops(lordHero.id, 'shu_rifleman', 1, { x: -3, y: 0, z: 30 })[0];
    for (const e of [q, att, by, own, enemyTroop]) e.hp = 10;
    expect(cast(w, 2, 'e').fired).toBe(true);
    expect(q.hp).toBeCloseTo(90, 5);
    expect(by.hp).toBeCloseTo(90, 5);
    expect(own.hp).toBeCloseTo(Math.min(own.maxHp, 90), 5);
    expect(att.hp).toBe(10);
    expect(enemyTroop.hp).toBe(10);
  });
});

// ── 陆逊 ─────────────────────────────────────────────────────────────────────
describe('陆逊 Lu Xun', () => {
  function lxw(): { w: World; lx: Entity; foe: Entity; other: Entity } {
    const w = mk([D, D, 'luxun', D, D]);
    const lx = hero(w, 2);
    const foe = hero(w, 4);
    const other = hero(w, 3);
    place(w, lx, 0, 0);
    place(w, foe, 0, -8);
    return { w, lx, foe, other };
  }

  it('谦逊: charm, dance and theft never land; other debuffs do', () => {
    const { w, lx, foe, other } = lxw();
    lx.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    expect(w.applyStatus(lx.id, 'charm', 3, { sourceId: foe.id, params: { targetId: other.id } })).toBe(false);
    expect(w.applyStatus(lx.id, 'dance', 3, { sourceId: foe.id })).toBe(false);
    expect(w.stealItem(foe.id, lx.id)).toBeNull();
    expect(itemCount(lx)).toBe(1);
    expect(w.applyStatus(lx.id, 'silence', 1, { sourceId: foe.id })).toBe(true);
  });

  it('连营: an emptied magazine instantly loads half a magazine from reserve (5 s cooldown)', () => {
    const { w, lx } = lxw();
    const inst = lx.hero!.weapons[lx.hero!.activeSlot]!;
    const def = weaponDef(inst.id);
    const half = Math.ceil(def.magSize * 0.5);
    inst.mag = 1;
    inst.reserve = 100;
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    w.step();
    send(w, 2, [], SKY);
    expect(inst.mag).toBe(half);
    expect(inst.reserve).toBe(100 - half);
    expect(lx.hero!.reloadUntil).toBe(0);
    // on cooldown: the next empty mag reloads normally
    stepN(w, 2);
    inst.mag = 1;
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    w.step();
    send(w, 2, [], SKY);
    expect(inst.mag).toBe(0);
    expect(lx.hero!.reloadUntil).toBeGreaterThan(w.time);
  });

  it('火烧连营: 5 fire fields 4 m apart ahead; they stop at walls and overlapping fields do not stack', () => {
    const { w, lx, foe } = lxw();
    // facing -x: open ground
    expect(cast(w, 2, 'q', { yaw: Math.PI / 2, pitch: 0 }).fired).toBe(true);
    const f = hazards(w, LUXUN_FIELD, lx).sort((a, b) => b.pos.x - a.pos.x);
    expect(f).toHaveLength(5);
    f.forEach((h, i) => {
      expect(h.pos.x).toBeCloseTo(-(3 + 4 * i), 3);
      expect(h.hazard!.radius).toBeCloseTo(2.5, 5);
    });
    expect(f[4].hazard!.expiresAt - w.time).toBeCloseTo(5, 1);

    // facing +x: the wall at x = 10 stops the line after 2 fields
    const r = lxw();
    place(r.w, r.foe, 5, 0); // inside the overlap of the fields at 3 m and 7 m
    expect(cast(r.w, 2, 'q', { yaw: -Math.PI / 2, pitch: 0 }).fired).toBe(true);
    expect(hazards(r.w, LUXUN_FIELD, r.lx)).toHaveLength(2);
    expect(lost(r.foe)).toBeCloseTo(10, 5); // one 0.5 s tick of 20/s, once
    stepN(r.w, 15);
    expect(lost(r.foe)).toBeCloseTo(20, 5);
    expect(lost(r.lx)).toBe(0);
    void foe;
  });

  it('火烧连营 under a roof burns on the floor, not on the roof', () => {
    const { w, lx } = lxw();
    place(w, lx, -20, -13); // the test map's roof slab spans x, z ∈ [-23, -17] at 2.5–2.9 m
    expect(cast(w, 2, 'q', { yaw: 0, pitch: 0 }).fired).toBe(true);
    const f = hazards(w, LUXUN_FIELD, lx);
    expect(f).toHaveLength(5);
    for (const h of f) expect(h.pos.y).toBeLessThan(0.1);
  });

  it('燎原: 6 s of shots without ammo; his fire fields grow ×1.5 and burn 5 s again', () => {
    const { w, lx } = lxw();
    cast(w, 2, 'q', { yaw: Math.PI / 2, pitch: 0 });
    stepN(w, 60);
    expect(cast(w, 2, 'e').fired).toBe(true);
    expect(w.hasStatus(lx.id, 'noReload')).toBe(true);
    const f = hazards(w, LUXUN_FIELD, lx);
    expect(f).toHaveLength(5);
    for (const h of f) {
      expect(h.hazard!.radius).toBeCloseTo(3.75, 5);
      expect(h.hazard!.expiresAt - w.time).toBeCloseTo(5, 1);
    }
    // fields laid during 燎原 are already spread
    w.setCooldown(lx.id, 'luxun_huoshao', 0);
    cast(w, 2, 'q', { yaw: 0, pitch: 0 });
    const fresh = hazards(w, LUXUN_FIELD, lx).filter((h) => !f.includes(h));
    expect(fresh.length).toBeGreaterThan(0);
    for (const h of fresh) expect(h.hazard!.radius).toBeCloseTo(3.75, 5);
    // no ammo used
    const inst = lx.hero!.weapons[lx.hero!.activeSlot]!;
    const mag = inst.mag;
    send(w, 2, [], { ...SKY, buttons: BTN_FIRE });
    stepN(w, 10);
    send(w, 2, [], SKY);
    expect(inst.mag).toBe(mag);
  });
});

// ── 孙尚香 ───────────────────────────────────────────────────────────────────
describe('孙尚香 Sun Shangxiang', () => {
  function ssx(heroes = [D, D, 'sunshangxiang', D, D]): { w: World; s: Entity; foe: Entity } {
    const w = mk(heroes);
    const s = hero(w, 2);
    const foe = hero(w, 4);
    place(w, s, 0, 30);
    place(w, foe, 0, 22);
    s.hero!.items = [null, null, null, null];
    return { w, s, foe };
  }
  const drain = (e: Entity): void => {
    for (const g of e.hero!.weapons) {
      if (!g) continue;
      g.mag = 0;
      g.reserve = 0;
    }
  };
  const fullAmmo = (e: Entity): boolean =>
    e.hero!.weapons.every((g) => !g || (g.mag === weaponDef(g.id).magSize && g.reserve >= maxReserve(weaponDef(g.id))));

  it('枭姬: losing armor → haste, full ammo and 1 item; 20 s cooldown', () => {
    const { w, s } = ssx();
    w.equip(s.id, 'bagua');
    w.step();
    drain(s);
    w.stripArmor(s.id, true);
    w.step();
    expect(w.statusParam(s.id, 'haste', 'amount', 0)).toBeCloseTo(0.3, 5);
    expect(fullAmmo(s)).toBe(true);
    expect(itemCount(s)).toBe(1);
    w.equip(s.id, 'tengjia');
    w.step();
    w.stripArmor(s.id, true);
    w.step();
    expect(itemCount(s)).toBe(1); // on cooldown
  });

  it('枭姬: losing a mount triggers it; swapping armor for another piece does not', () => {
    const { w, s } = ssx();
    w.equip(s.id, 'bagua');
    w.step();
    w.equip(s.id, 'tengjia'); // swap: old one dropped, slot still filled
    w.step();
    expect(itemCount(s)).toBe(0);
    expect(w.hasStatus(s.id, 'haste')).toBe(false);
    w.equip(s.id, 'chitu');
    w.step();
    w.dismount(s.id);
    w.step();
    expect(itemCount(s)).toBe(1);
    expect(w.hasStatus(s.id, 'haste')).toBe(true);
  });

  it('枭姬: first drop below 50 % HP triggers; it re-arms above 50 %; not when downed outright', () => {
    const { w, s, foe } = ssx();
    w.dealDamage({ targetId: s.id, sourceId: foe.id, amount: 160, type: 'normal' });
    expect(itemCount(s)).toBe(1);
    w.dealDamage({ targetId: s.id, sourceId: foe.id, amount: 10, type: 'normal' });
    expect(itemCount(s)).toBe(1); // already below: no re-trigger
    w.heal(s.id, 300);
    w.step();
    s.hero!.abilityState['sunshangxiang_xiaoji:ready'] = 0; // skip the 20 s cooldown
    w.dealDamage({ targetId: s.id, sourceId: foe.id, amount: 200, type: 'normal' });
    expect(itemCount(s)).toBe(2);
    w.heal(s.id, 300);
    w.step();
    s.hero!.abilityState['sunshangxiang_xiaoji:ready'] = 0;
    w.dealDamage({ targetId: s.id, sourceId: foe.id, amount: 999, type: 'normal' });
    expect(s.hero!.downed).toBe(true);
    w.step();
    expect(itemCount(s)).toBe(2);
  });

  it('结姻: heals her and the male hero under the crosshair 100 each; females / known enemies invalid', () => {
    const w = mk(['sunshangxiang', D, D, 'daqiao', D]);
    const [s, ally, rebel, dq] = [hero(w, 0), hero(w, 1), hero(w, 2), hero(w, 3)];
    place(w, s, 0, 30);
    place(w, ally, 0, 22);
    s.hp = 100;
    ally.hp = 200;
    expect(cast(w, 0, 'q', aimAt(s, ally)).fired).toBe(true);
    expect(ally.hp).toBeCloseTo(300, 5);
    expect(s.hp).toBeCloseTo(200, 5);
    w.setCooldown(s.id, 'sunshangxiang_jieyin', 0);
    place(w, ally, -40, 52);
    place(w, dq, 0, 22);
    expect(cast(w, 0, 'q', aimAt(s, dq)).fired).toBe(false);
    place(w, dq, 40, 52);
    place(w, rebel, 0, 22);
    rebel.hero!.roleRevealed = true; // a known rebel is hostile to the lord
    expect(cast(w, 0, 'q', aimAt(s, rebel)).fired).toBe(false);
    expect(w.cooldownLeft(s.id, 'sunshangxiang_jieyin')).toBe(0);
  });

  it('弓腰姬: 5 explosive arrows in a 30° fan: 30 on hit + 20 blast', () => {
    const { w, s, foe } = ssx();
    expect(cast(w, 2, 'e', aimAt(s, foe)).fired).toBe(true);
    const arrows = w.kindList('projectile').filter((p) => p.proj!.abilityId === 'sunshangxiang_gongyao');
    expect(arrows).toHaveLength(5);
    for (const a of arrows) {
      expect(a.proj!.weaponId).toBeUndefined();
      expect(a.proj!.dtype).toBe('explosive');
    }
    // widest horizontal angle between two arrows = the fan
    let fan = 0;
    for (const a of arrows) {
      for (const b of arrows) {
        const la = Math.hypot(a.vel.x, a.vel.z);
        const lb = Math.hypot(b.vel.x, b.vel.z);
        fan = Math.max(fan, Math.acos(Math.min(1, (a.vel.x * b.vel.x + a.vel.z * b.vel.z) / (la * lb))));
      }
    }
    expect(fan * (180 / Math.PI)).toBeCloseTo(30, 0);
    stepN(w, 10);
    expect(lost(foe)).toBeGreaterThanOrEqual(30 + 15);
    expect(lost(foe)).toBeLessThan(300);
    expect(lost(s)).toBe(0);
  });
});

// ── robustness ───────────────────────────────────────────────────────────────
describe('robustness: downed / dead / silenced casters, vanishing targets', () => {
  const actives = (heroId: string): AbilityDef[] => HERO_BY_ID[heroId].abilities.filter((a) => !isPassiveAbility(a));

  function setup(heroId: string): { w: World; e: Entity; foe: Entity } {
    // seat 0 = real lord so lord skills exist
    const w = mk([heroId, D, D, D, D]);
    const e = hero(w, 0);
    const foe = hero(w, 4);
    place(w, e, 0, 30);
    place(w, foe, 0, 22);
    w.spawnTroops(e.id, 'wu_crossbow', 2);
    foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    return { w, e, foe };
  }

  for (const heroId of WU) {
    it(`${heroId}: no activation while downed, dead or silenced; nothing throws`, () => {
      {
        const { w, e, foe } = setup(heroId);
        w.applyStatus(e.id, 'silence', 10, { sourceId: foe.id });
        for (const a of actives(heroId)) {
          expect(cast(w, 0, a.slot as 'q' | 'e' | 'lord', aimAt(e, foe)).fired, `${a.id} silenced`).toBe(false);
          expect(w.cooldownLeft(e.id, a.id)).toBe(0);
        }
      }
      {
        const { w, e, foe } = setup(heroId);
        w.downHero(e, foe.id);
        for (const a of actives(heroId)) {
          expect(cast(w, 0, a.slot as 'q' | 'e' | 'lord', aimAt(e, foe)).fired, `${a.id} downed`).toBe(false);
          expect(getAbility(a.id)!.activate!(w.abilityCtx(e, a)), `${a.id} direct while downed`).toBe(false);
        }
        stepN(w, 60);
        w.killHero(e, foe.id);
        for (const a of actives(heroId)) expect(getAbility(a.id)!.activate!(w.abilityCtx(e, a)), `${a.id} dead`).toBe(false);
        stepN(w, 60);
      }
    });

    it(`${heroId}: every active cast at a target that then vanishes, caster dying mid-effect`, () => {
      const { w, e, foe } = setup(heroId);
      for (const a of actives(heroId)) {
        cast(w, 0, a.slot as 'q' | 'e' | 'lord', aimAt(e, foe));
        w.step();
      }
      w.killHero(foe, e.id);
      stepN(w, 30);
      w.killHero(e, undefined);
      stepN(w, 6 * 30);
      expect(e.hero!.dead).toBe(true);
    });
  }

  it('hooks tolerate odd requests (no source, zero amounts, dead owners)', () => {
    const w = mk(['sunquan', 'ganning', 'daqiao', 'luxun', 'sunshangxiang']);
    const hs = [0, 1, 2, 3, 4].map((i) => hero(w, i));
    hs.forEach((h, i) => place(w, h, i * 3, 30));
    for (const h of hs) {
      w.dealDamage({ targetId: h.id, amount: 5, type: 'normal', weaponId: 'carbine' });
      w.dealDamage({ targetId: h.id, sourceId: hs[(hs.indexOf(h) + 1) % hs.length].id, amount: 0, type: 'fire' });
    }
    w.killHero(hs[2], undefined);
    w.dealDamage({ targetId: hs[3].id, sourceId: hs[2].id, amount: 10, type: 'normal', weaponId: 'carbine' });
    stepN(w, 30);
  });
});

// ── 8 Wu bots ────────────────────────────────────────────────────────────────
describe('Wu-only 8-bot match', () => {
  it('eight Wu bots brawl to a valid result without ability errors, using their skills', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const init: MatchInit = {
      settings: { ...defaultSettings(), playerCount: 8, botDifficulty: 'hard' },
      seed: 4242,
      seats: roles.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `Bot ${i}`, isBot: true, role, heroId: WU[i] })),
    };
    const w = createWorld(init, { map: generateMap(20260924), onWarn });
    const heroes = w.heroList();
    // every role public: identity-aware bots engage at once; gather them on open ground
    for (const h of heroes) h.hero!.roleRevealed = true;
    const rand = (): number => w.rng.next();
    heroes.forEach((h, i) => {
      const a = (i / heroes.length) * Math.PI * 2;
      const spot = findOpenGround(w.cw, Math.cos(a) * 14, Math.sin(a) * 14, 8, rand, { radius: 0.6 }) ?? { x: Math.cos(a) * 14, y: 0, z: Math.sin(a) * 14 };
      w.teleport(h.id, spot);
    });
    const cast = new Map<string, number>();
    const maxTicks = 15 * 60 * 30 + 150;
    for (let i = 0; i < maxTicks && !w.result(); i++) {
      w.step();
      for (const ev of w.drainEvents()) if (ev.t === 'ability') cast.set(ev.ability, (cast.get(ev.ability) ?? 0) + 1);
    }
    const res = w.result();
    expect(res).toBeTruthy();
    expect(['lord', 'rebel', 'traitor', 'draw']).toContain(res!.winner);
    const wuActives = new Set(WU.flatMap((id) => HERO_BY_ID[id].abilities.filter((a) => !isPassiveAbility(a)).map((a) => a.id)));
    const used = [...cast.keys()].filter((id) => wuActives.has(id));
    // eslint-disable-next-line no-console
    console.log(`[wu-match] ${res!.winner} after ${res!.durationSec}s; casts: ${JSON.stringify(Object.fromEntries(cast))}`);
    expect(used.length).toBeGreaterThanOrEqual(6);
  }, 240_000);
});
