// 魏 Wei abilities (src/sim/abilities/wei/*): every active does what its
// description says in a small test world, passives trigger under the right
// conditions, nothing breaks for downed / dead / silenced casters or vanishing
// targets, and an 8-bot all-Wei match plays out without hook errors.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { AbilitySlot, Entity, GameEvent, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { BTN_FIRE, defaultSettings, emptyInput } from '../../../src/core/types';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import type { AbilityDef } from '../../../src/data/types';
import { getAbility, hasAbility } from '../../../src/sim/abilities';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { World } from '../../../src/sim/world';
import { statusRows } from '../../../src/sim/status';
import { createWorld } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const WEI = ['caocao', 'simayi', 'xiahoudun', 'zhangliao', 'xuchu', 'guojia', 'zhenji', 'xiahouyuan'];
const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const TICK = 1 / 30;
let seq = 1;

const secs = (s: number): number => Math.ceil(s / TICK);

function send(w: World, e: Entity, actions: InputAction[], p: Partial<InputFrame> = {}): void {
  w.setInput(e.hero!.playerId, { ...emptyInput(seq++), yaw: e.yaw, ...p, actions });
}

function abilityOf(heroId: string, slot: AbilityDef['slot']): AbilityDef {
  const a = HERO_BY_ID[heroId].abilities.find((x) => x.slot === slot);
  if (!a) throw new Error(`${heroId} has no ${slot}`);
  return a;
}

const chest = (e: Entity): Vec3 => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });

function aimAt(from: Entity, target: Entity): Partial<InputFrame> {
  const c = chest(target);
  const a = aimAnglesFor(from.pos, c);
  return { yaw: a.yaw, pitch: a.pitch, aimPoint: c, aimTargetId: target.id };
}

function aimPoint(from: Entity, p: Vec3): Partial<InputFrame> {
  const a = aimAnglesFor(from.pos, p);
  return { yaw: a.yaw, pitch: a.pitch, aimPoint: { ...p } };
}

/** Aim at the sky (nothing under the crosshair). */
const aimSky = (yaw = 0): Partial<InputFrame> => ({ yaw, pitch: 1.2 });

function cast(w: World, e: Entity, slot: AbilitySlot, aim: Partial<InputFrame> = {}): GameEvent[] {
  send(w, e, [{ a: 'ability', slot }], aim);
  w.step();
  return w.drainEvents();
}

interface Duel {
  w: World;
  me: Entity;
  foe: Entity;
  warns: string[];
}

/**
 * `heroId` at `seat` (default 2, a rebel) standing at (0, 30) facing −z; a dummy foe at seat 3
 * at (0, 20) facing it; everybody else parked out of the way. All seats are humans (no bots).
 */
function duel(heroId: string, o: { seat?: number; roles?: RoleId[]; heroes?: string[]; squads?: boolean } = {}): Duel {
  const roles = o.roles ?? STD5;
  const seat = o.seat ?? 2;
  const heroes = o.heroes ?? roles.map((_, i) => (i === seat ? heroId : 'dummy'));
  const warns: string[] = [];
  const w = makeWorld(roles, { heroes, onWarn: (m) => warns.push(m), squads: o.squads ?? false });
  roles.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 55));
  const me = hero(w, seat);
  const foe = hero(w, seat === 3 ? 2 : 3);
  place(w, me, 0, 30, 0);
  place(w, foe, 0, 20, Math.PI);
  for (const e of w.heroList()) send(w, e, [], { yaw: e.yaw });
  w.step();
  w.drainEvents();
  return { w, me, foe, warns };
}

const hazards = (w: World, kind: string): Entity[] => [...w.entities()].filter((e) => e.kind === 'hazard' && e.hazard?.kind === kind && e.alive);
const loots = (w: World): Entity[] => [...w.entities()].filter((e) => e.kind === 'loot' && e.alive);
const itemCount = (e: Entity): number => e.hero!.items.reduce((n, s) => n + (s ? s.count : 0), 0);
const hasItem = (e: Entity, id: string): boolean => e.hero!.items.some((s) => s?.id === id && s.count > 0);
const threw = (warns: string[]): string[] => warns.filter((m) => /threw/.test(m));

function bigHp(e: Entity, hp = 5000): void {
  e.maxHp = hp;
  e.hp = hp;
}

// ── registration ────────────────────────────────────────────────────────────
describe('魏 registration', () => {
  it('every Wei ability has an implementation; actives implement activate()', () => {
    for (const id of WEI) {
      const h = HERO_BY_ID[id];
      expect(h.kingdom).toBe('wei');
      for (const a of h.abilities) {
        const impl = getAbility(a.id);
        expect(hasAbility(a.id), a.id).toBe(true);
        if (!isPassiveAbility(a)) expect(impl?.activate, `${a.id} activate`).toBeTypeOf('function');
        else expect(impl?.activate, `${a.id} is passive`).toBeUndefined();
      }
    }
  });
});

// ── 曹操 ────────────────────────────────────────────────────────────────────
describe('曹操 Cao Cao', () => {
  it('奸雄 turns 25 % of weapon damage taken into a 5 s shield, capped at 100; ability damage does not', () => {
    const { w, me, foe } = duel('caocao');
    bigHp(me);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'fire' });
    expect(me.shield).toBe(0);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal', weaponId: 'carbine' });
    expect(me.shield).toBeCloseTo(25, 5);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 1000, type: 'normal', weaponId: 'carbine' });
    expect(me.shield).toBeCloseTo(100, 5); // 25 soaked, then +min(243.75, 100) → capped
    stepN(w, secs(5.2));
    expect(me.shield).toBe(0);
  });

  it('宁教我负天下人: squad charges the crosshair target at +50 % damage, 20 % lifesteal for 6 s, then regroups', () => {
    const { w, me, foe } = duel('caocao');
    const troops = w.spawnTroops(me.id, 'wei_tiger', 3, { x: 3, y: 0, z: 32 });
    expect(troops).toHaveLength(3);
    const def = abilityOf('caocao', 'q');
    const ev = cast(w, me, 'q', aimAt(me, foe));
    expect(ev.some((e) => e.t === 'ability' && e.ability === def.id)).toBe(true);
    expect(w.cooldownLeft(me.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    expect(me.hero!.order.kind).toBe('attack');
    expect(me.hero!.order.targetId).toBe(foe.id);
    expect(w.hasStatus(me.id, 'lifesteal')).toBe(true);
    w.step();
    expect(w.modifiers(me.id).troopDmgMul).toBeCloseTo(1.5, 5);
    me.hp = 200;
    foe.hp = foe.maxHp = 5000;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(me.hp).toBeCloseTo(220, 5);
    stepN(w, secs(6.2));
    expect(w.modifiers(me.id).troopDmgMul).toBe(1);
    expect(w.hasStatus(me.id, 'lifesteal')).toBe(false);
    expect(me.hero!.order.kind).toBe('follow');
  });

  it('宁教我负天下人 without a target orders a free charge (never fails)', () => {
    const { w, me } = duel('caocao');
    w.spawnTroops(me.id, 'wei_tiger', 2);
    cast(w, me, 'q', aimSky(Math.PI / 2));
    expect(me.hero!.order.kind).toBe('charge');
    expect(w.cooldownLeft(me.id, 'caocao_ningjiao')).toBeGreaterThan(0);
  });

  it('望梅止渴 fully heals the squad, heals you 50 and hastes everyone', () => {
    const { w, me } = duel('caocao');
    const troops = w.spawnTroops(me.id, 'wei_tiger', 3);
    for (const t of troops) t.hp = 10;
    me.hp = 100;
    cast(w, me, 'e');
    for (const t of troops) {
      expect(t.hp).toBe(t.maxHp);
      expect(w.hasStatus(t.id, 'haste')).toBe(true);
    }
    expect(me.hp).toBeCloseTo(150, 5);
    expect(w.hasStatus(me.id, 'haste')).toBe(true);
    expect(w.statusParam(me.id, 'haste', 'amount', 0)).toBeCloseTo(0.3, 5);
    expect(w.cooldownLeft(me.id, 'caocao_wangmei')).toBeCloseTo(25, 1);
  });

  it('护驾 exists only for the real Lord (not the 影武者 or other roles)', () => {
    const roles: RoleId[] = ['lord', 'double', 'rebel', 'rebel', 'traitor'];
    const { w } = duel('caocao', { roles, heroes: ['caocao', 'caocao', 'caocao', 'dummy', 'dummy'], seat: 0 });
    const hasLord = (i: number): boolean => w.heroRt(hero(w, i).id)!.abilities.some((a) => a.def.id === 'caocao_hujia');
    expect(hasLord(0)).toBe(true);
    expect(hasLord(1)).toBe(false);
    expect(hasLord(2)).toBe(false);
    const dbl = hero(w, 1);
    cast(w, dbl, 'lord');
    expect(dbl.hero!.squad).toHaveLength(0);
    expect(w.cooldownLeft(dbl.id, 'caocao_hujia')).toBe(0);
  });

  it('护驾 summons 3 temporary Tiger Guards and moves half the damage you take onto them for 6 s', () => {
    const { w, me, foe } = duel('caocao', { seat: 0 });
    bigHp(me);
    const def = abilityOf('caocao', 'lord');
    cast(w, me, 'lord');
    expect(w.cooldownLeft(me.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    const guards = me.hero!.squad.map((id) => w.get(id)!);
    expect(guards).toHaveLength(3);
    for (const g of guards) expect(g.troop!.troopType).toBe('wei_tigerGuard');
    const guardHp = (): number => guards.reduce((s, g) => s + (g.alive ? g.hp : 0), 0);
    const hp0 = me.hp;
    const g0 = guardHp();
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal' });
    expect(hp0 - me.hp).toBeCloseTo(50, 5);
    expect(g0 - guardHp()).toBeCloseTo(50, 5);
    stepN(w, secs(6.2));
    const hp1 = me.hp;
    const g1 = guardHp();
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal' });
    expect(hp1 - me.hp).toBeCloseTo(100, 5);
    expect(guardHp()).toBeCloseTo(g1, 5);
    // temporary: gone after their 30 s lifetime
    stepN(w, secs(25));
    expect(guards.every((g) => !g.alive)).toBe(true);
  });

  it('护驾 falls back to a nearby Wei hero (never the attacker) when no soldier is around', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
    const { w, me, foe } = duel('caocao', { roles, heroes: ['caocao', 'xiahoudun', 'dummy', 'zhangliao', 'dummy'], seat: 0 });
    bigHp(me);
    cast(w, me, 'lord');
    for (const id of [...me.hero!.squad]) w.removeEntity(id);
    const xhd = hero(w, 1);
    place(w, xhd, 4, 30);
    // the attacker is a Wei hero standing right next to Cao Cao: it never soaks its own shot
    place(w, foe, -3, 30);
    const hp0 = me.hp;
    const x0 = xhd.hp;
    const f0 = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal' });
    expect(hp0 - me.hp).toBeCloseTo(50, 5);
    expect(x0 - xhd.hp).toBeCloseTo(50, 5);
    expect(foe.hp).toBe(f0);
  });
});

// ── 司马懿 ──────────────────────────────────────────────────────────────────
describe('司马懿 Sima Yi', () => {
  it('反馈 steals 1 item from a hero that hurts you (8 s icd, spent only on success), never from troops', () => {
    const { w, me, foe } = duel('simayi');
    bigHp(me);
    me.hero!.items = [null, null, null, null];
    foe.hero!.items = [{ id: 'sha', count: 3 }, null, null, null];
    const other = hero(w, 4);
    other.hero!.items = [null, null, null, null];
    // an item-less attacker: nothing to take, the icd stays ready
    w.dealDamage({ targetId: me.id, sourceId: other.id, amount: 10, type: 'normal', weaponId: 'carbine' });
    expect(itemCount(me)).toBe(0);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 10, type: 'normal', weaponId: 'carbine' });
    expect(hasItem(me, 'sha')).toBe(true);
    expect(itemCount(foe)).toBe(2);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 10, type: 'fire' });
    expect(itemCount(foe)).toBe(2); // icd
    stepN(w, secs(8.1));
    const troop = w.spawnTroops(foe.id, 'qun_raider', 1, { x: 0, y: 0, z: 25 })[0];
    w.dealDamage({ targetId: me.id, sourceId: troop.id, amount: 10, type: 'normal', weaponId: 'troop_shotgun' });
    expect(itemCount(foe)).toBe(2); // troops don't count
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 10, type: 'normal' });
    expect(itemCount(foe)).toBe(1);
    expect(itemCount(me)).toBe(2);
  });

  it('鬼才 halves bullets for 2.5 s and reflects the full original damage to the shooter', () => {
    const { w, me, foe } = duel('simayi');
    bigHp(me);
    bigHp(foe);
    foe.hero!.items = [null, null, null, null]; // keep 反馈 out of the way
    const def = abilityOf('simayi', 'q');
    cast(w, me, 'q');
    expect(w.cooldownLeft(me.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    expect(w.hasStatus(me.id, 'reflect')).toBe(true);
    expect(hazards(w, 'guicai')).toHaveLength(1);
    let hp = me.hp;
    let fhp = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal', weaponId: 'carbine' });
    expect(hp - me.hp).toBeCloseTo(50, 5);
    expect(fhp - foe.hp).toBeCloseTo(100, 5);
    // ability damage is not a bullet: neither halved nor reflected
    hp = me.hp;
    fhp = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal' });
    expect(hp - me.hp).toBeCloseTo(100, 5);
    expect(foe.hp).toBe(fhp);
    stepN(w, secs(2.6));
    expect(w.hasStatus(me.id, 'reflect')).toBe(false);
    expect(hazards(w, 'guicai')).toHaveLength(0);
    hp = me.hp;
    fhp = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal', weaponId: 'carbine' });
    expect(hp - me.hp).toBeCloseTo(100, 5);
    expect(foe.hp).toBe(fhp);
  });

  it('鬼才 reflects onto troops too, and ends early when you are downed', () => {
    const { w, me, foe } = duel('simayi');
    bigHp(me);
    cast(w, me, 'q');
    const troop = w.spawnTroops(foe.id, 'qun_raider', 1, { x: 0, y: 0, z: 24 })[0];
    const t0 = troop.hp;
    w.dealDamage({ targetId: me.id, sourceId: troop.id, amount: 20, type: 'normal', weaponId: 'troop_shotgun' });
    expect(t0 - troop.hp).toBeCloseTo(20, 5);
    w.dealDamage({ targetId: me.id, amount: 1e6, type: 'true' });
    expect(me.hero!.downed).toBe(true);
    w.step();
    expect(w.hasStatus(me.id, 'reflect')).toBe(false);
    expect(hazards(w, 'guicai')).toHaveLength(0);
  });

  it('two 鬼才 casters shooting each other never loop', () => {
    const { w, me, foe } = duel('simayi', { heroes: ['dummy', 'dummy', 'simayi', 'simayi', 'dummy'] });
    bigHp(me);
    bigHp(foe);
    me.hero!.items = [null, null, null, null];
    foe.hero!.items = [null, null, null, null];
    cast(w, me, 'q');
    cast(w, foe, 'q');
    const hp = me.hp;
    const fhp = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal', weaponId: 'hanbing' });
    expect(fhp - foe.hp).toBeCloseTo(50, 5);
    expect(hp - me.hp).toBeCloseTo(100, 5); // the reflection is not a bullet: not reflected again
  });

  it('狼顾 reveals heroes within 40 m to you alone and boosts your damage against them by 40 %', () => {
    const { w, me, foe } = duel('simayi');
    const far = hero(w, 4);
    place(w, far, 0, 75); // 45 m away
    bigHp(foe);
    bigHp(far);
    const ev = cast(w, me, 'e');
    const reveal = foe.statuses.find((s) => s.id === 'reveal');
    expect(reveal?.params?.viewerId).toBe(me.id);
    expect(far.statuses.some((s) => s.id === 'reveal')).toBe(false);
    expect(me.statuses.some((s) => s.id === 'reveal')).toBe(false);
    // the status event is private to Sima Yi
    const st = ev.find((e) => e.t === 'status' && e.status === 'reveal' && e.target === foe.id);
    expect(st?.privateTo).toBe(me.id);
    let hp = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(hp - foe.hp).toBeCloseTo(140, 5);
    hp = far.hp;
    w.dealDamage({ targetId: far.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(hp - far.hp).toBeCloseTo(100, 5);
    stepN(w, secs(5.2));
    hp = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(hp - foe.hp).toBeCloseTo(100, 5);
  });
});

describe('司马懿 Sima Yi — reflections', () => {
  it('鬼才 reflects exactly the original bullet: 狼顾 never boosts a reflection (his own shots still are)', () => {
    const { w, me, foe } = duel('simayi');
    bigHp(me);
    bigHp(foe);
    foe.hero!.items = [null, null, null, null]; // keep 反馈 out of the way
    cast(w, me, 'e'); // 狼顾: the foe is revealed to him → ×1.4 against it
    cast(w, me, 'q'); // 鬼才
    let fhp = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal', weaponId: 'carbine' });
    expect(fhp - foe.hp).toBeCloseTo(100, 5);
    fhp = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(fhp - foe.hp).toBeCloseTo(140, 5);
  });
});

// ── 夏侯惇 ──────────────────────────────────────────────────────────────────
describe('夏侯惇 Xiahou Dun', () => {
  it('刚烈 deals 30 % of any damage taken back to the attacker (not zone / DoT)', () => {
    const { w, me, foe } = duel('xiahoudun');
    bigHp(me);
    bigHp(foe);
    expect(w.hasStatus(me.id, 'thorns')).toBe(true);
    let f = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'fire' });
    expect(f - foe.hp).toBeCloseTo(30, 5);
    f = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 50, type: 'normal', weaponId: 'carbine' });
    expect(f - foe.hp).toBeCloseTo(15, 5);
    f = foe.hp;
    w.dealDamage({ targetId: me.id, amount: 50, type: 'zone' });
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 50, type: 'fire', noReflect: true, abilityId: 'status:burn' });
    expect(foe.hp).toBe(f);
    // a troop attacker gets it back too
    const troop = w.spawnTroops(foe.id, 'qun_raider', 1, { x: 0, y: 0, z: 24 })[0];
    const t0 = troop.hp;
    w.dealDamage({ targetId: me.id, sourceId: troop.id, amount: 20, type: 'normal', weaponId: 'troop_shotgun' });
    expect(t0 - troop.hp).toBeCloseTo(6, 5);
  });

  it('拔矢啖睛 heals 30 % of missing HP and gives ×1.3 damage for 6 s', () => {
    const { w, me, foe } = duel('xiahoudun');
    bigHp(foe);
    me.hp = 100;
    cast(w, me, 'q');
    expect(me.hp).toBeCloseTo(100 + 300 * 0.3, 5);
    expect(w.cooldownLeft(me.id, 'xiahoudun_bashi')).toBeCloseTo(18, 1);
    let f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(f - foe.hp).toBeCloseTo(130, 5);
    stepN(w, secs(6.2));
    f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(f - foe.hp).toBeCloseTo(100, 5);
  });

  it('独目怒冲 stops at the first hero in the path: 60 melee + 1 s stun; heroes behind it are safe', () => {
    const { w, me, foe } = duel('xiahoudun');
    const behind = hero(w, 4);
    place(w, foe, 0, 23, Math.PI);
    place(w, behind, 0, 20);
    const f0 = foe.hp;
    const b0 = behind.hp;
    cast(w, me, 'e', { yaw: 0, pitch: 0 });
    expect(w.cooldownLeft(me.id, 'xiahoudun_charge')).toBeCloseTo(16, 1);
    let stunnedAtImpact = false;
    for (let i = 0; i < 30; i++) {
      w.step();
      if (foe.hp < f0 && !stunnedAtImpact) stunnedAtImpact = w.hasStatus(foe.id, 'stun');
    }
    expect(f0 - foe.hp).toBeCloseTo(60, 5);
    expect(stunnedAtImpact).toBe(true);
    expect(behind.hp).toBe(b0);
    expect(me.pos.z).toBeGreaterThan(23); // stopped at the foe, did not run through it
    expect(me.pos.z).toBeLessThan(26.5);
  });

  it('独目怒冲 runs the full 12 m when nobody is in the way, and passes through a dodging hero', () => {
    const { w, me, foe } = duel('xiahoudun');
    place(w, foe, 20, 20);
    cast(w, me, 'e', { yaw: 0, pitch: 0 });
    stepN(w, 45);
    expect(30 - me.pos.z).toBeGreaterThan(10.5);
    expect(30 - me.pos.z).toBeLessThan(13.5); // braked: no post-dash slide

    const d = duel('xiahoudun');
    const behind = hero(d.w, 4);
    place(d.w, d.foe, 0, 25, Math.PI);
    place(d.w, behind, 0, 21);
    d.foe.hero!.dodgingUntil = d.w.time + 2; // mid-roll i-frames
    const f0 = d.foe.hp;
    const b0 = behind.hp;
    cast(d.w, d.me, 'e', { yaw: 0, pitch: 0 });
    stepN(d.w, 25);
    expect(d.foe.hp).toBe(f0);
    expect(b0 - behind.hp).toBeCloseTo(60, 5);
  });
});

describe('夏侯惇 Xiahou Dun — regressions', () => {
  it('刚烈 thorns is a finite status, refreshed silently forever (never an "until consumed" row)', () => {
    const { w, me } = duel('xiahoudun');
    const left = (): number => Math.max(0, ...me.statuses.filter((s) => s.id === 'thorns').map((s) => s.until - w.time));
    expect(left()).toBeGreaterThan(30);
    expect(left()).toBeLessThanOrEqual(60);
    let events = 0;
    let minLeft = Infinity;
    for (let i = 0; i < secs(100); i++) {
      w.step();
      events += w.drainEvents().filter((e) => e.t === 'status' && e.status === 'thorns').length;
      minLeft = Math.min(minLeft, left());
    }
    expect(events).toBe(0);
    expect(minLeft).toBeGreaterThan(29);
    expect(me.statuses.filter((s) => s.id === 'thorns')).toHaveLength(1);
    const row = statusRows(me, w.time, me.id).find((r) => r.id === 'thorns');
    expect(row?.remaining).toBeGreaterThan(0); // -1 would reach remote clients as 0 (docs/SIM_REQUESTS.md WEI-9)
  });

  it('独目怒冲 never hits a hero through a wall it runs along', () => {
    // the 1 m test wall spans x 9.5–10.5, z −5…5 (3 m tall); he hugs its west face, the foe stands east of it
    const { w, me, foe } = duel('xiahoudun');
    place(w, me, 9.05, -6, Math.PI); // facing +z
    place(w, foe, 10.9, -1, 0); // 1.85 m to the side of the lane: inside the corridor, behind the wall
    const f0 = foe.hp;
    cast(w, me, 'e', { yaw: Math.PI, pitch: 0 });
    let stunned = false;
    for (let i = 0; i < 30; i++) {
      w.step();
      stunned ||= w.hasStatus(foe.id, 'stun');
    }
    expect(foe.hp).toBe(f0);
    expect(stunned).toBe(false);
    expect(me.pos.z).toBeGreaterThan(4); // the charge ran on past it

    // control: the same offsets in the open are a hit
    const d = duel('xiahoudun');
    place(d.w, d.me, -11, -6, Math.PI);
    place(d.w, d.foe, -9.15, -1, 0);
    const g0 = d.foe.hp;
    cast(d.w, d.me, 'e', { yaw: Math.PI, pitch: 0 });
    stepN(d.w, 30);
    expect(g0 - d.foe.hp).toBeCloseTo(60, 5);
  });

  it('独目怒冲 passes under a hero standing on a ledge above the lane', () => {
    // the stair landing: x −1.5…1.5, z −16.4…−12.4, top 1.6 m
    const { w, me, foe } = duel('xiahoudun');
    place(w, me, 2.3, -20, Math.PI);
    place(w, foe, 1.0, -14.4, 0);
    expect(foe.pos.y).toBeCloseTo(1.6, 1);
    const f0 = foe.hp;
    cast(w, me, 'e', { yaw: Math.PI, pitch: 0 });
    stepN(w, 30);
    expect(foe.hp).toBe(f0);
    expect(me.pos.z).toBeGreaterThan(-12); // ran on past it
  });
});

// ── 张辽 ────────────────────────────────────────────────────────────────────
describe('张辽 Zhang Liao', () => {
  it('辽来 +40 % damage against units facing away from you', () => {
    const { w, me, foe } = duel('zhangliao');
    bigHp(foe);
    foe.yaw = 0; // facing −z: its back is toward Zhang Liao (+z)
    let f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal', weaponId: 'smg' });
    expect(f - foe.hp).toBeCloseTo(140, 5);
    foe.yaw = Math.PI; // facing him
    f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal', weaponId: 'smg' });
    expect(f - foe.hp).toBeCloseTo(100, 5);
    foe.yaw = Math.PI / 2; // side-on: outside the 120° rear arc
    f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal', weaponId: 'smg' });
    expect(f - foe.hp).toBeCloseTo(100, 5);
  });

  it('突袭 blinks behind the target, steals from up to 2 enemies within 6 m and slows them', () => {
    const { w, me, foe } = duel('zhangliao');
    place(w, foe, 0, 22, Math.PI); // facing Zhang Liao
    const second = hero(w, 4);
    const third = hero(w, 0);
    place(w, second, 2.2, 19.5);
    place(w, third, -3.5, 16.5);
    me.hero!.items = [null, null, null, null];
    foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    second.hero!.items = [{ id: 'shan', count: 1 }, null, null, null];
    third.hero!.items = [{ id: 'jiu', count: 1 }, null, null, null];
    cast(w, me, 'q', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, 'zhangliao_tuxi')).toBeCloseTo(14, 1);
    expect(me.pos.z).toBeLessThan(21.5); // behind it (its back faces −z)
    expect(hasItem(me, 'sha')).toBe(true);
    expect(hasItem(me, 'shan')).toBe(true);
    expect(hasItem(me, 'jiu')).toBe(false);
    expect(itemCount(foe)).toBe(0);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
    expect(w.hasStatus(second.id, 'slow')).toBe(true);
    expect(w.hasStatus(third.id, 'slow')).toBe(false);
    expect(w.statusParam(foe.id, 'slow', 'amount', 0)).toBeCloseTo(0.3, 5);
  });

  it('突袭 without a target (or beyond 12 m) does nothing and keeps the cooldown', () => {
    const { w, me, foe } = duel('zhangliao');
    cast(w, me, 'q', aimSky());
    expect(w.cooldownLeft(me.id, 'zhangliao_tuxi')).toBe(0);
    place(w, foe, 0, 10);
    const z0 = me.pos.z;
    cast(w, me, 'q', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, 'zhangliao_tuxi')).toBe(0);
    expect(me.pos.z).toBeCloseTo(z0, 5);
  });

  it('突袭 vs 无懈可击: one charge cancels the whole steal + slow', () => {
    const { w, me, foe } = duel('zhangliao');
    place(w, foe, 0, 22, Math.PI);
    foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    cast(w, me, 'q', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, 'zhangliao_tuxi')).toBeGreaterThan(0);
    expect(hasItem(foe, 'sha')).toBe(true);
    expect(w.hasStatus(foe.id, 'slow')).toBe(false);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(false);
  });

  it('威震逍遥津 silences + slows enemy heroes and stuns soldiers within 10 m', () => {
    const { w, me, foe } = duel('zhangliao');
    place(w, foe, 0, 22);
    const far = hero(w, 4);
    place(w, far, 0, 15);
    const troop = w.spawnTroops(foe.id, 'qun_raider', 1, { x: 3, y: 0, z: 26 })[0];
    const mine = w.spawnTroops(me.id, 'wei_tiger', 1, { x: -3, y: 0, z: 30 })[0];
    cast(w, me, 'e');
    expect(w.cooldownLeft(me.id, 'zhangliao_weizhen')).toBeCloseTo(20, 1);
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
    expect(w.hasStatus(foe.id, 'stun')).toBe(false);
    expect(w.hasStatus(troop.id, 'stun')).toBe(true);
    expect(w.hasStatus(mine.id, 'stun')).toBe(false);
    expect(w.hasStatus(far.id, 'silence')).toBe(false);
    stepN(w, secs(2.1));
    expect(w.hasStatus(foe.id, 'silence')).toBe(false);
    expect(w.hasStatus(troop.id, 'stun')).toBe(true); // 2.5 s on soldiers
  });
});

describe('张辽 Zhang Liao — regressions', () => {
  it('突袭 onto a target under a roof lands on its floor (not on the roof) and raids it', () => {
    // the test roof slab spans x −23…−17, z −23…−17 at 2.5–2.9 m
    const { w, me, foe } = duel('zhangliao');
    place(w, foe, -20, -20, Math.PI); // facing +z, toward him
    foe.pos.y = 0; // under the slab (place() puts it on the topmost surface)
    place(w, me, -20, -12, 0);
    foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    me.hero!.items = [null, null, null, null];
    cast(w, me, 'q', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, 'zhangliao_tuxi')).toBeCloseTo(14, 1);
    expect(me.pos.y).toBeLessThan(0.5);
    expect(me.pos.z).toBeLessThan(-20.5); // behind it: its back faces −z
    expect(Math.hypot(me.pos.x + 20, me.pos.z + 20)).toBeLessThan(2.5);
    expect(hasItem(me, 'sha')).toBe(true);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
  });

  it('突袭 only raids enemies it can see from the landing spot', () => {
    const { w, me, foe } = duel('zhangliao');
    const hidden = hero(w, 4);
    place(w, foe, 6, 0, Math.PI / 2); // facing −x, toward him; the test wall (x 9.5–10.5) is behind it
    place(w, me, -2, 0, -Math.PI / 2);
    place(w, hidden, 11.5, 0); // ~4 m from the landing spot, on the far side of the wall
    foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    hidden.hero!.items = [{ id: 'shan', count: 1 }, null, null, null];
    me.hero!.items = [null, null, null, null];
    cast(w, me, 'q', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, 'zhangliao_tuxi')).toBeGreaterThan(0);
    expect(me.pos.x).toBeGreaterThan(6.5);
    expect(me.pos.x).toBeLessThan(9.5);
    expect(hasItem(me, 'sha')).toBe(true);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
    expect(hasItem(hidden, 'shan')).toBe(true);
    expect(w.hasStatus(hidden.id, 'slow')).toBe(false);
  });

  it('突袭 records where the blink started as the cast point (the VFX streak runs from there)', () => {
    const { w, me, foe } = duel('zhangliao');
    place(w, foe, 0, 22, Math.PI);
    send(w, me, [], aimAt(me, foe));
    w.step();
    const def = abilityOf('zhangliao', 'q');
    const ctx = w.abilityCtx(me, def) as ReturnType<World['abilityCtx']> & { cast?: { pos?: Vec3; target?: number } };
    expect(getAbility(def.id)!.activate!(ctx)).toBe(true);
    expect(ctx.cast?.target).toBe(foe.id);
    expect(Math.hypot(ctx.cast!.pos!.x, ctx.cast!.pos!.z - 30)).toBeLessThan(0.05);
  });

  it('辽来 never boosts reflected damage', () => {
    const { w, me, foe } = duel('zhangliao');
    bigHp(me);
    bigHp(foe);
    foe.yaw = 0; // its back toward Zhang Liao: 辽来 would apply
    w.applyStatus(me.id, 'thorns', 10, { sourceId: me.id, params: { frac: 0.3 } });
    const f = foe.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'fire' });
    expect(f - foe.hp).toBeCloseTo(30, 5);
  });
});

// ── 许褚 ────────────────────────────────────────────────────────────────────
describe('许褚 Xu Chu', () => {
  it('虎痴: immune to knockback and knock-up', () => {
    const { w, me } = duel('xuchu');
    expect(w.modifiers(me.id).knockbackImmune).toBe(true);
    w.knockback(me.id, { x: 1, y: 0, z: 0 }, 10);
    w.knockback(me.id, { x: 0, y: 1, z: 0 }, 10);
    expect(me.forced).toBeUndefined();
    expect(me.vel.y).toBeLessThanOrEqual(0);
  });

  it('裸衣: ×1.5 damage dealt and ×1.25 damage taken for 7 s', () => {
    const { w, me, foe } = duel('xuchu');
    bigHp(me);
    bigHp(foe);
    cast(w, me, 'q');
    expect(w.cooldownLeft(me.id, 'xuchu_luoyi')).toBeCloseTo(20, 1);
    let f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    expect(f - foe.hp).toBeCloseTo(150, 5);
    let m = me.hp;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal' });
    expect(m - me.hp).toBeCloseTo(125, 5);
    stepN(w, secs(7.2));
    f = foe.hp;
    m = me.hp;
    w.dealDamage({ targetId: foe.id, sourceId: me.id, amount: 100, type: 'normal' });
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 100, type: 'normal' });
    expect(f - foe.hp).toBeCloseTo(100, 5);
    expect(m - me.hp).toBeCloseTo(100, 5);
  });

  it('虎卫猛击 leaps 6 m and slams: 80 melee + knock-up to enemies within 6 m of the landing only', () => {
    const { w, me, foe } = duel('xuchu');
    place(w, foe, 0, 20); // 4 m from the landing point (0, 24)
    const far = hero(w, 4);
    place(w, far, 0, 12); // 12 m away
    const f0 = foe.hp;
    const r0 = far.hp;
    cast(w, me, 'e', { yaw: 0, pitch: 0 });
    expect(w.cooldownLeft(me.id, 'xuchu_slam')).toBeCloseTo(14, 1);
    let launched = false;
    for (let i = 0; i < secs(1.2); i++) {
      w.step();
      if (foe.vel.y > 3) launched = true;
    }
    expect(30 - me.pos.z).toBeGreaterThan(5);
    expect(30 - me.pos.z).toBeLessThan(7.5);
    expect(f0 - foe.hp).toBeCloseTo(80, 5);
    expect(launched).toBe(true);
    expect(far.hp).toBe(r0);
  });

  it('虎卫猛击 never lands when you are downed mid-leap', () => {
    const { w, me, foe } = duel('xuchu');
    place(w, foe, 0, 25);
    const f0 = foe.hp;
    cast(w, me, 'e', { yaw: 0, pitch: 0 });
    w.dealDamage({ targetId: me.id, amount: 1e6, type: 'true' });
    expect(() => stepN(w, secs(1))).not.toThrow();
    expect(foe.hp).toBe(f0);
  });
});

// ── 郭嘉 ────────────────────────────────────────────────────────────────────
describe('郭嘉 Guo Jia', () => {
  it('天妒: a hit of 40+ grants 1 item and refills the magazine (6 s icd); smaller hits do nothing', () => {
    const { w, me, foe } = duel('guojia');
    bigHp(me);
    me.hero!.items = [null, null, null, null];
    const wi = me.hero!.weapons[me.hero!.activeSlot]!;
    wi.mag = 0;
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 30, type: 'normal' });
    expect(itemCount(me)).toBe(0);
    expect(wi.mag).toBe(0);
    const ev0 = w.drainEvents();
    expect(ev0.some((e) => e.t === 'ability' && e.ability === 'guojia_tiandu')).toBe(false);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 50, type: 'normal' });
    expect(itemCount(me)).toBe(1);
    expect(wi.mag).toBeGreaterThan(0);
    const ev1 = w.drainEvents();
    expect(ev1.some((e) => e.t === 'ability' && e.ability === 'guojia_tiandu')).toBe(true);
    expect(ev1.some((e) => e.t === 'pickup' && e.who === me.id)).toBe(true);
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 80, type: 'normal' });
    expect(itemCount(me)).toBe(1); // icd
    // a stealthed Guo Jia's proc is private (no position leak)
    stepN(w, secs(6.1));
    w.drainEvents();
    w.applyStatus(me.id, 'stealth', 5, { sourceId: me.id });
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 80, type: 'normal' });
    const proc = w.drainEvents().find((e) => e.t === 'ability' && e.ability === 'guojia_tiandu');
    expect(proc?.privateTo).toBe(me.id);
    w.removeStatus(me.id, 'stealth');
    stepN(w, secs(6.1));
    w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 80, type: 'normal' });
    expect(itemCount(me)).toBe(3);
  });

  it('遗计: smoke marker at the crosshair, then 2 items land there after 3 s (even if you die meanwhile)', () => {
    const { w, me } = duel('guojia');
    const p = { x: 6, y: 0, z: 15 };
    const def = abilityOf('guojia', 'q');
    cast(w, me, 'q', aimPoint(me, p));
    expect(w.cooldownLeft(me.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    const marker = hazards(w, 'yijiSmoke');
    expect(marker).toHaveLength(1);
    expect(Math.hypot(marker[0].pos.x - p.x, marker[0].pos.z - p.z)).toBeLessThan(1.5);
    w.dealDamage({ targetId: me.id, amount: 1e6, type: 'true' });
    w.dealDamage({ targetId: me.id, amount: 1e6, type: 'true' });
    expect(me.hero!.dead).toBe(true);
    const before = loots(w).length;
    stepN(w, secs(2.5));
    expect(loots(w).length).toBe(before);
    stepN(w, secs(0.7));
    const landed = loots(w).filter((l) => Math.hypot(l.pos.x - p.x, l.pos.z - p.z) < 3);
    expect(landed).toHaveLength(2);
    expect(landed.every((l) => !!l.loot?.itemId)).toBe(true);
    expect(hazards(w, 'yijiSmoke')).toHaveLength(0);
  });

  it('遗计 is clamped to 40 m', () => {
    const { w, me } = duel('guojia');
    cast(w, me, 'q', aimPoint(me, { x: 0, y: 0, z: 30 - 70 }));
    const m = hazards(w, 'yijiSmoke')[0];
    expect(m).toBeDefined();
    expect(Math.hypot(m.pos.x - me.pos.x, m.pos.z - me.pos.z)).toBeLessThanOrEqual(40.01);
  });

  it('鬼谋 marks the crosshair enemy: ×1.25 damage from every source, public reveal, squad mark', () => {
    const { w, me, foe } = duel('guojia');
    bigHp(foe);
    const other = hero(w, 4);
    const def = abilityOf('guojia', 'e');
    cast(w, me, 'e', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    const rev = foe.statuses.find((s) => s.id === 'reveal');
    expect(rev).toBeDefined();
    expect(rev!.params?.viewerId).toBeUndefined();
    expect(w.hasStatus(foe.id, 'marked')).toBe(true);
    const f = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: other.id, amount: 100, type: 'normal' });
    expect(f - foe.hp).toBeCloseTo(125, 5);
    stepN(w, secs(6.2));
    expect(w.hasStatus(foe.id, 'dmgTakenUp')).toBe(false);
    expect(w.hasStatus(foe.id, 'reveal')).toBe(false);
  });

  it('鬼谋 without a target keeps its cooldown; vs 无懈可击 the vulnerability is cancelled but the reveal lands', () => {
    const { w, me, foe } = duel('guojia');
    cast(w, me, 'e', aimSky());
    expect(w.cooldownLeft(me.id, 'guojia_guimou')).toBe(0);
    w.applyStatus(foe.id, 'nullify', 20, { sourceId: foe.id });
    cast(w, me, 'e', aimAt(me, foe));
    expect(w.cooldownLeft(me.id, 'guojia_guimou')).toBeGreaterThan(0);
    expect(w.hasStatus(foe.id, 'dmgTakenUp')).toBe(false);
    expect(w.hasStatus(foe.id, 'reveal')).toBe(true);
    expect(w.hasStatus(foe.id, 'nullify')).toBe(false);
  });
});

// ── 甄姬 ────────────────────────────────────────────────────────────────────
describe('甄姬 Zhen Ji', () => {
  it('倾国 evades ~25 % of bullets while moving, none while standing or against ability damage', () => {
    const { w, me, foe } = duel('zhenji');
    const hitN = (n: number, weapon: boolean): number => {
      let dodged = 0;
      for (let i = 0; i < n; i++) {
        me.hp = me.maxHp;
        const r = w.dealDamage({ targetId: me.id, sourceId: foe.id, amount: 1, type: 'normal', weaponId: weapon ? 'carbine' : undefined });
        if (r.blocked === 'dodge') dodged++;
      }
      return dodged;
    };
    me.vel.x = 0;
    me.vel.z = 0;
    expect(hitN(200, true)).toBe(0);
    me.vel.x = 5;
    const d = hitN(800, true);
    expect(d).toBeGreaterThan(800 * 0.25 - 60);
    expect(d).toBeLessThan(800 * 0.25 + 60);
    expect(hitN(200, false)).toBe(0);
    // the hook only reports the chance (combat rolls it)
    const def = abilityOf('zhenji', 'passive');
    const ctx = { ...w.abilityCtx(me, def), req: { targetId: me.id, amount: 1, type: 'normal' as const, weaponId: 'carbine' }, other: foe };
    expect(getAbility(def.id)!.bulletEvadeChance!(ctx)).toBeCloseTo(0.25, 5);
    me.vel.x = 1;
    expect(getAbility(def.id)!.bulletEvadeChance!(ctx)).toBe(0);
  });

  it('洛神 draws one item per success and stops at the first failure (at most 4)', () => {
    const script = (outcomes: boolean[]): { won: number; gained: number; ps: number[] } => {
      const { w, me } = duel('zhenji');
      me.hero!.items = [null, null, null, null];
      const ps: number[] = [];
      const orig = w.rng.chance.bind(w.rng);
      let k = 0;
      w.rng.chance = (p: number): boolean => {
        ps.push(p);
        return k < outcomes.length ? outcomes[k++] : orig(p);
      };
      const loot0 = loots(w).length;
      cast(w, me, 'q');
      stepN(w, secs(2));
      w.rng.chance = orig;
      const gained = itemCount(me) + (loots(w).length - loot0);
      return { won: me.hero!.abilityState['zhenji_luoshen:won'] ?? -1, gained, ps };
    };
    const a = script([true, true, false]);
    expect(a.won).toBe(2);
    expect(a.gained).toBe(2);
    expect(a.ps).toEqual([0.6, 0.5, 0.4]);
    const b = script([true, true, true, true]);
    expect(b.won).toBe(4);
    expect(b.gained).toBe(4);
    expect(b.ps).toEqual([0.6, 0.5, 0.4, 0.3]); // no 5th draw
    const c = script([false]);
    expect(c.won).toBe(0);
    expect(c.gained).toBe(0);
  });

  it('洛神 with the real RNG averages ≈ 1.06 items per cast', () => {
    const { w, me } = duel('zhenji');
    const def = abilityOf('zhenji', 'q');
    let total = 0;
    const N = 250;
    for (let i = 0; i < N; i++) {
      me.hero!.items = [null, null, null, null];
      w.setCooldown(me.id, def.id, 0);
      cast(w, me, 'q');
      stepN(w, 30);
      total += me.hero!.abilityState['zhenji_luoshen:won'];
    }
    for (const l of loots(w)) w.removeEntity(l.id);
    const mean = total / N;
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(1.35);
  });

  it('凌波微步 blinks 10 m along the aim and leaves a slowing frost field behind', () => {
    const { w, me, foe } = duel('zhenji');
    place(w, foe, 30, 40);
    cast(w, me, 'e', { yaw: 0, pitch: 0 });
    expect(30 - me.pos.z).toBeGreaterThan(9);
    expect(w.cooldownLeft(me.id, 'zhenji_lingbo')).toBeCloseTo(14, 1);
    const field = hazards(w, 'lingboFrost');
    expect(field).toHaveLength(1);
    expect(Math.hypot(field[0].pos.x, field[0].pos.z - 30)).toBeLessThan(0.5);
    place(w, foe, 1, 30);
    stepN(w, 10);
    expect(w.hasStatus(foe.id, 'slow')).toBe(true);
    expect(w.statusParam(foe.id, 'slow', 'amount', 0)).toBeCloseTo(0.4, 5);
    expect(w.hasStatus(me.id, 'slow')).toBe(false);

    // the cast point is where she started (the frost field), she herself is at the landing
    const c = duel('zhenji');
    send(c.w, c.me, [], { yaw: 0, pitch: 0 });
    c.w.step();
    const def = abilityOf('zhenji', 'e');
    const ctx = c.w.abilityCtx(c.me, def) as ReturnType<World['abilityCtx']> & { cast?: { pos?: Vec3 } };
    expect(getAbility(def.id)!.activate!(ctx)).toBe(true);
    expect(Math.hypot(ctx.cast!.pos!.x, ctx.cast!.pos!.z - 30)).toBeLessThan(0.05);
    expect(30 - c.me.pos.z).toBeGreaterThan(9);

    const d = duel('zhenji');
    cast(d.w, d.me, 'e', { yaw: -Math.PI / 2, pitch: 0 }); // looking +x
    expect(d.me.pos.x).toBeGreaterThan(9);
    expect(Math.abs(d.me.pos.z - 30)).toBeLessThan(0.5);
  });

  it('凌波微步 into a wall does nothing and keeps the cooldown', () => {
    const { w, me } = duel('zhenji');
    place(w, me, 8.8, 0, -Math.PI / 2); // facing +x, the wall at x = 10 right ahead
    cast(w, me, 'e', { yaw: -Math.PI / 2, pitch: 0 });
    expect(w.cooldownLeft(me.id, 'zhenji_lingbo')).toBe(0);
    expect(hazards(w, 'lingboFrost')).toHaveLength(0);
    expect(me.pos.x).toBeLessThan(10);
  });
});

// ── 夏侯渊 ──────────────────────────────────────────────────────────────────
describe('夏侯渊 Xiahou Yuan', () => {
  it('疾行: +15 % speed and sprint keeps ADS', () => {
    const { w, me } = duel('xiahouyuan');
    expect(w.modifiers(me.id).speedMul).toBeCloseTo(1.15, 5);
    expect(w.modifiers(me.id).sprintAds).toBe(true);
  });

  it('神速 blinks to the crosshair and volleys 5 × 22 weapon rounds into the nearest enemy (no ammo)', () => {
    const { w, me, foe } = duel('xiahouyuan');
    place(w, me, 0, 40, 0);
    const wi = me.hero!.weapons[me.hero!.activeSlot]!;
    const mag = wi.mag;
    const f0 = foe.hp;
    const ev = cast(w, me, 'q', aimPoint(me, { x: 0, y: 0, z: 30 }));
    expect(w.cooldownLeft(me.id, 'xiahouyuan_shensu')).toBeCloseTo(14, 1);
    expect(me.pos.z).toBeCloseTo(30, 0);
    stepN(w, 10);
    const shots = [...ev, ...w.drainEvents()].filter((e) => e.t === 'shot' && e.src === me.id);
    expect(shots).toHaveLength(5);
    expect(shots.every((s) => s.t === 'shot' && s.weapon === wi.id)).toBe(true);
    expect(f0 - foe.hp).toBeCloseTo(5 * 22, 5);
    expect(wi.mag).toBe(mag);
  });

  it('神速 aimed at an enemy stops short of it and prefers it over closer units', () => {
    const { w, me, foe } = duel('xiahouyuan');
    place(w, foe, 0, 16, Math.PI);
    const decoy = w.spawnTroops(hero(w, 4).id, 'qun_raider', 1, { x: 6, y: 0, z: 22 })[0];
    const d0 = decoy.hp;
    const f0 = foe.hp;
    cast(w, me, 'q', aimAt(me, foe));
    expect(me.pos.z).toBeGreaterThan(16 + 1.5);
    stepN(w, 10);
    expect(f0 - foe.hp).toBeGreaterThan(100);
    expect(decoy.hp).toBe(d0);
  });

  it('神速 retargets when the target falls mid-volley, and does nothing without a destination or target', () => {
    const { w, me, foe } = duel('xiahouyuan');
    const other = hero(w, 4);
    place(w, other, 4, 22);
    cast(w, me, 'q', aimAt(me, foe));
    w.dealDamage({ targetId: foe.id, amount: 1e6, type: 'true' });
    const o0 = other.hp;
    expect(() => stepN(w, 10)).not.toThrow();
    expect(other.hp).toBeLessThan(o0);

    const d = duel('xiahouyuan');
    place(d.w, d.foe, 40, 60);
    place(d.w, hero(d.w, 4), -50, -40);
    place(d.w, d.me, 8.8, 0, -Math.PI / 2); // nose against the wall at x = 10
    cast(d.w, d.me, 'q', aimPoint(d.me, { x: 9.5, y: 1.2, z: 0 }));
    expect(d.w.cooldownLeft(d.me.id, 'xiahouyuan_shensu')).toBe(0);
    expect(d.me.pos.x).toBeLessThan(9.5);
  });

  it('虎步关右: 40 % haste for 5 s and every dodge charge back', () => {
    const { w, me } = duel('xiahouyuan');
    me.hero!.dodgeCharges = 0;
    me.hero!.dodgeRechargeAt = w.time + 5;
    cast(w, me, 'e');
    expect(me.hero!.dodgeCharges).toBe(2);
    expect(w.statusParam(me.id, 'haste', 'amount', 0)).toBeCloseTo(0.4, 5);
    expect(w.cooldownLeft(me.id, 'xiahouyuan_hubu')).toBeCloseTo(20, 1);
  });
});

// ── cast info (docs/SIM_REQUESTS.md SHU-3) ──────────────────────────────────
describe('魏 cast info', () => {
  it('actives record where they really happened on ctx.cast', () => {
    const { w, me, foe } = duel('guojia');
    const def = abilityOf('guojia', 'q');
    send(w, me, [], aimPoint(me, { x: 6, y: 0, z: 15 }));
    w.step();
    const ctx = w.abilityCtx(me, def) as ReturnType<World['abilityCtx']> & { cast?: { pos?: Vec3; target?: number } };
    expect(getAbility(def.id)!.activate!(ctx)).toBe(true);
    expect(ctx.cast?.pos).toBeDefined();
    expect(Math.hypot(ctx.cast!.pos!.x - 6, ctx.cast!.pos!.z - 15)).toBeLessThan(1);
    const e = abilityOf('guojia', 'e');
    send(w, me, [], aimAt(me, foe));
    w.step();
    const ctx2 = w.abilityCtx(me, e) as typeof ctx;
    expect(getAbility(e.id)!.activate!(ctx2)).toBe(true);
    expect(ctx2.cast?.target).toBe(foe.id);
  });
});

// ── robustness ──────────────────────────────────────────────────────────────
describe('魏 robustness', () => {
  const actives = (): { heroId: string; def: AbilityDef }[] =>
    WEI.flatMap((heroId) => HERO_BY_ID[heroId].abilities.filter((a) => !isPassiveAbility(a)).map((def) => ({ heroId, def })));

  it('every active is a safe no-op for downed and dead casters', () => {
    for (const { heroId, def } of actives()) {
      const { w, me, warns } = duel(heroId, { seat: heroId === 'caocao' ? 0 : 2 });
      const impl = getAbility(def.id)!;
      w.dealDamage({ targetId: me.id, amount: 1e6, type: 'true' });
      expect(me.hero!.downed, heroId).toBe(true);
      expect(impl.activate!(w.abilityCtx(me, def)), `${def.id} downed`).toBe(false);
      w.dealDamage({ targetId: me.id, amount: 1e6, type: 'true' });
      expect(me.hero!.dead, heroId).toBe(true);
      expect(impl.activate!(w.abilityCtx(me, def)), `${def.id} dead`).toBe(false);
      expect(() => stepN(w, 5)).not.toThrow();
      expect(threw(warns), def.id).toEqual([]);
    }
  });

  it('silenced or stunned casters cannot cast (no cooldown spent)', () => {
    for (const { heroId, def } of actives()) {
      for (const st of ['silence', 'stun'] as const) {
        const { w, me, foe } = duel(heroId, { seat: heroId === 'caocao' ? 0 : 2 });
        w.applyStatus(me.id, st, 5, { sourceId: foe.id });
        cast(w, me, def.slot as AbilitySlot, aimAt(me, foe));
        expect(w.cooldownLeft(me.id, def.id), `${def.id} ${st}`).toBe(0);
      }
    }
  });

  it('casts survive the caster and every target dying right after, without hook errors', () => {
    for (const heroId of WEI) {
      const { w, me, foe, warns } = duel(heroId, { seat: heroId === 'caocao' ? 0 : 2, squads: true });
      const other = hero(w, 4);
      place(w, other, 3, 24);
      place(w, foe, 0, 24, Math.PI);
      for (const a of HERO_BY_ID[heroId].abilities) {
        if (isPassiveAbility(a)) continue;
        w.setCooldown(me.id, a.id, 0);
        cast(w, me, a.slot as AbilitySlot, aimAt(me, foe));
      }
      // everyone falls while effects are in flight
      for (const e of [foe, other, me]) {
        w.dealDamage({ targetId: e.id, amount: 1e6, type: 'true' });
        w.dealDamage({ targetId: e.id, amount: 1e6, type: 'true' });
      }
      expect(() => stepN(w, secs(4))).not.toThrow();
      expect(threw(warns), heroId).toEqual([]);
    }
  });

  it('items gained by Wei abilities are announced to the new owner only (items are hidden information)', () => {
    const pickups = (ev: GameEvent[]): Extract<GameEvent, { t: 'pickup' }>[] => ev.filter((e): e is Extract<GameEvent, { t: 'pickup' }> => e.t === 'pickup');
    // 反馈
    const a = duel('simayi');
    bigHp(a.me);
    a.me.hero!.items = [null, null, null, null];
    a.foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    a.w.dealDamage({ targetId: a.me.id, sourceId: a.foe.id, amount: 10, type: 'normal', weaponId: 'carbine' });
    const pa = pickups(a.w.drainEvents());
    expect(pa).toHaveLength(1);
    expect(pa[0].privateTo).toBe(a.me.id);
    // 突袭
    const b = duel('zhangliao');
    place(b.w, b.foe, 0, 22, Math.PI);
    b.me.hero!.items = [null, null, null, null];
    b.foe.hero!.items = [{ id: 'sha', count: 1 }, null, null, null];
    const pb = pickups(cast(b.w, b.me, 'q', aimAt(b.me, b.foe)));
    expect(pb).toHaveLength(1);
    expect(pb[0].privateTo).toBe(b.me.id);
    // 洛神 (first draw wins, second fails)
    const c = duel('zhenji');
    c.me.hero!.items = [null, null, null, null];
    const outcomes = [true, false];
    c.w.rng.chance = (): boolean => outcomes.shift() ?? false;
    const pc = pickups([...cast(c.w, c.me, 'q'), ...(stepN(c.w, secs(1)), c.w.drainEvents())]);
    expect(pc).toHaveLength(1);
    expect(pc[0].privateTo).toBe(c.me.id);
    // 天妒
    const d = duel('guojia');
    bigHp(d.me);
    d.me.hero!.items = [null, null, null, null];
    d.w.dealDamage({ targetId: d.me.id, sourceId: d.foe.id, amount: 50, type: 'normal', weaponId: 'carbine' });
    const pd = pickups(d.w.drainEvents());
    expect(pd).toHaveLength(1);
    expect(pd[0].privateTo).toBe(d.me.id);
  });

  it('passives and hooks tolerate source-less, zone and self damage', () => {
    for (const heroId of WEI) {
      const { w, me, warns } = duel(heroId, { seat: heroId === 'caocao' ? 0 : 2 });
      bigHp(me);
      for (const type of ['normal', 'fire', 'zone', 'true', 'melee'] as const) {
        w.dealDamage({ targetId: me.id, amount: 60, type });
        w.dealDamage({ targetId: me.id, sourceId: me.id, amount: 60, type, weaponId: type === 'normal' ? 'carbine' : undefined });
      }
      expect(() => stepN(w, 3)).not.toThrow();
      expect(threw(warns), heroId).toEqual([]);
    }
  });
});

// ── bots ────────────────────────────────────────────────────────────────────
describe('魏 bots', () => {
  /**
   * One Wei bot vs a (human, scripted) enemy that keeps within 8 m and shoots in short bursts;
   * bystanders parked far away. For 12 s the bot is kept healthy, then dropped to 45 % HP so
   * the heals come up. Returns the Wei abilities the bot cast.
   */
  function skirmish(heroId: string): { used: Set<string>; warns: string[] } {
    const seat = heroId === 'caocao' ? 0 : 2;
    const warns: string[] = [];
    const heroes = STD5.map((_, i) => (i === seat ? heroId : 'dummy'));
    const w = makeWorld(STD5, { heroes, humans: STD5.map((_, i) => i).filter((i) => i !== seat), onWarn: (m) => warns.push(m) });
    const me = hero(w, seat);
    const foe = hero(w, seat === 0 ? 2 : 0);
    for (const h of w.heroList()) h.hero!.roleRevealed = true;
    STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 16, -55));
    place(w, me, 0, 30);
    place(w, foe, 0, 22, Math.PI);
    const used = new Set<string>();
    for (let i = 0; i < secs(25) && !w.result(); i++) {
      if (foe.hero!.downed || foe.hero!.dead) break;
      foe.hp = Math.max(foe.hp, foe.maxHp * 0.5);
      const dx = foe.pos.x - me.pos.x;
      const dz = foe.pos.z - me.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      if (Math.abs(l - 8) > 1) place(w, foe, me.pos.x + (dx / l) * 8, me.pos.z + (dz / l) * 8, Math.atan2(dx / l, dz / l));
      if (i < secs(12)) me.hp = Math.max(me.hp, me.maxHp * 0.8);
      if (i === secs(12)) me.hp = me.maxHp * 0.45;
      w.setInput(foe.hero!.playerId, { ...emptyInput(seq++), ...aimAt(foe, me), buttons: i % 60 < 6 ? BTN_FIRE : 0, actions: [] });
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'ability' && e.src === me.id) used.add(e.ability);
    }
    return { used, warns };
  }

  it('a bot in a close fight uses its Wei actives — 张辽 both 突袭 and 威震逍遥津', () => {
    const used = new Set<string>();
    for (const heroId of WEI) {
      const r = skirmish(heroId);
      expect(threw(r.warns), heroId).toEqual([]);
      for (const id of r.used) used.add(id);
    }
    const actives = WEI.flatMap((h) => HERO_BY_ID[h].abilities.filter((a) => !isPassiveAbility(a)).map((a) => a.id));
    const missing = actives.filter((id) => !used.has(id));
    // eslint-disable-next-line no-console
    console.log(`[wei-bots] ${actives.length - missing.length}/${actives.length} actives cast; never: ${missing.join(', ') || '—'}`);
    expect(used.has('zhangliao_tuxi'), 'zhangliao_tuxi').toBe(true);
    expect(used.has('zhangliao_weizhen'), 'zhangliao_weizhen').toBe(true);
    // the rest is AI-owned heuristics (sim/ai/abilityUse.ts): every active today, allow a little drift
    expect(missing.length, `never cast: ${missing.join(', ')}`).toBeLessThanOrEqual(2);
  }, 60_000);
});

// ── full match ──────────────────────────────────────────────────────────────
describe('魏 8-bot match', () => {
  it('8 Wei bots (曹操 as Lord) play a full match on the generated map to a valid result, no ability errors', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const warns: string[] = [];
    const w = createWorld(
      {
        settings: { ...defaultSettings(), playerCount: 8 },
        seed: 7,
        seats: roles.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `Bot ${i}`, isBot: true, role, heroId: WEI[i] })),
      },
      { onWarn: (m) => warns.push(m) },
    );
    const casts = new Map<string, number>();
    const maxTicks = secs(15 * 60 + 10);
    for (let i = 0; i < maxTicks && !w.result(); i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'ability') casts.set(e.ability, (casts.get(e.ability) ?? 0) + 1);
    }
    const res = w.result();
    expect(res).toBeTruthy();
    expect(['lord', 'rebel', 'traitor', 'draw']).toContain(res!.winner);
    expect(threw(warns)).toEqual([]);
    expect(warns.filter((m) => /no implementation|no activate/.test(m) && /caocao|simayi|xiahou|zhangliao|xuchu|guojia|zhenji/.test(m))).toEqual([]);
    // bots actually used the kit. One seed does not reach every active (who fights whom is
    // role-driven: 11–16 of the 17 over seeds 3/5/7/11/21); the close-fight test above covers each.
    const actives = WEI.flatMap((h) => HERO_BY_ID[h].abilities.filter((a) => !isPassiveAbility(a)).map((a) => a.id));
    const used = actives.filter((id) => (casts.get(id) ?? 0) > 0);
    // eslint-disable-next-line no-console
    console.log(`[wei-match] ${res!.winner} after ${res!.durationSec}s; ${used.length}/${actives.length} actives; never: ${actives.filter((id) => !casts.get(id)).join(', ') || '—'}`);
    expect(used.length).toBeGreaterThanOrEqual(10);
  }, 240_000);
});
