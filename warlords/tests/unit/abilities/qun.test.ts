// 群 Qun abilities (华佗 吕布 貂蝉 张角 袁绍 孟获): every passive / Q / E / lord skill in
// small test worlds, lord-only gating, robustness (downed / dead / silenced casters,
// vanishing targets, 无懈可击 / 谦逊-style vetoes), bots casting, and a full 8-bot
// all-Qun match on the generated map.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { Entity, EntityId, GameEvent, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { BTN_INTERACT, defaultSettings, emptyInput } from '../../../src/core/types';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import type { AbilityDef } from '../../../src/data/types';
import { getAbility, hasAbility } from '../../../src/sim/abilities';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { DamageRequest } from '../../../src/sim/api';
import type { AbilityImplEx } from '../../../src/sim/ext';
import type { MatchInit } from '../../../src/sim/host';
import type { World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const QUN = ['huatuo', 'lubu', 'diaochan', 'zhangjiao', 'yuanshao', 'menghuo'];
const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const T = (s: number): number => Math.round(s * 30);
let seq = 1;

// ── test-world helpers ──────────────────────────────────────────────────────
type WorldOpts = NonNullable<Parameters<typeof makeWorld>[1]>;

interface Arena {
  w: World;
  warns: string[];
  at: (seat: number) => Entity;
}

/** Quiet test world; every hero is parked along the north edge until a test places it. */
function arena(heroes: string[], roles: RoleId[] = STD5, extra: WorldOpts = {}): Arena {
  const warns: string[] = [];
  const w = makeWorld(roles, { heroes, onWarn: (m) => warns.push(m), ...extra });
  roles.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  w.step();
  w.drainEvents();
  return { w, warns, at: (seat) => hero(w, seat) };
}

function send(w: World, seat: number, actions: InputAction[], p: Partial<InputFrame> = {}): void {
  w.setInput(`p${seat}`, { ...emptyInput(seq++), ...p, actions });
}

const chest = (e: Entity): Vec3 => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });

function aimAt(caster: Entity, target: Entity): Partial<InputFrame> {
  const c = chest(target);
  const a = aimAnglesFor(caster.pos, c);
  return { yaw: a.yaw, pitch: a.pitch, aimPoint: c, aimTargetId: target.id };
}

function aimAtPoint(caster: Entity, p: Vec3): Partial<InputFrame> {
  const a = aimAnglesFor(caster.pos, p);
  return { yaw: a.yaw, pitch: a.pitch, aimPoint: { ...p } };
}

/** Looking up into the empty sky, nothing under the crosshair. */
const SKY: Partial<InputFrame> = { yaw: Math.PI, pitch: 1.2 };

function cast(a: Arena, seat: number, slot: 'q' | 'e' | 'lord', aim: Partial<InputFrame>): GameEvent[] {
  send(a.w, seat, [{ a: 'ability', slot }], aim);
  a.w.step();
  return a.w.drainEvents();
}

const abilityOf = (heroId: string, slot: AbilityDef['slot']): AbilityDef => HERO_BY_ID[heroId].abilities.find((x) => x.slot === slot)!;
/** one 雷击 bolt from the data (before 鬼道's +30 %) */
const LEIJI = HERO_BY_ID.zhangjiao.abilities.find((x) => x.id === 'zhangjiao_leiji')!.params.damage;
const fired = (evs: GameEvent[], id: string): boolean => evs.some((e) => e.t === 'ability' && e.ability === id);
const lost = (e: Entity): number => e.maxHp - e.hp;

/** Kill a hero outright (bleed-out skipped). */
function kill(w: World, e: Entity): void {
  w.killHero(e, undefined);
}

/** Record every SimApi.dealDamage call (ability code; weapon/NPC fire bypasses the method). */
function spyDamage(w: World): DamageRequest[] {
  const reqs: DamageRequest[] = [];
  const orig = w.dealDamage.bind(w);
  w.dealDamage = (r: DamageRequest) => {
    reqs.push({ ...r });
    return orig(r);
  };
  return reqs;
}

/** Call an ability's activate() directly (bypassing the world's stun/silence/downed gates). */
function activateDirect(w: World, e: Entity, id: string): boolean {
  const entry = w.heroRt(e.id)!.abilities.find((a) => a.def.id === id);
  if (!entry?.impl?.activate) throw new Error(`no activate for ${id}`);
  return entry.impl.activate(w.abilityCtx(e, entry.def));
}

function injectPassive(w: World, e: Entity, impl: AbilityImplEx): void {
  w.heroRt(e.id)!.abilities.push({
    def: { id: impl.id, slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} },
    impl,
  });
}

const threw = (warns: string[]): string[] => warns.filter((m) => /threw/.test(m));

// ── registration ────────────────────────────────────────────────────────────
describe('群 registration', () => {
  it('every Qun ability from the data has an implementation with the right hooks', () => {
    for (const id of QUN) {
      const h = HERO_BY_ID[id];
      expect(h.kingdom).toBe('qun');
      for (const a of h.abilities) {
        expect(hasAbility(a.id), a.id).toBe(true);
        const impl = getAbility(a.id)!;
        if (isPassiveAbility(a)) expect(impl.activate, `${a.id} is passive`).toBeUndefined();
        else expect(impl.activate, `${a.id} activates`).toBeTypeOf('function');
      }
    }
  });
});

// ── 华佗 ────────────────────────────────────────────────────────────────────
describe('华佗 Hua Tuo', () => {
  function setup(): Arena {
    const a = arena(['huatuo', 'dummy', 'dummy', 'dummy', 'dummy']);
    place(a.w, a.at(0), 0, 30);
    return a;
  }

  it('急救: revives take 0.5 s, give +80 HP, and one per 30 s needs no 桃', () => {
    const a = setup();
    const { w } = a;
    const doc = a.at(0);
    const ally = a.at(1);
    const mods = w.modifiers(doc.id);
    expect(mods.reviveTimeMul).toBeCloseTo(0.5 / 1.5, 5);
    expect(mods.reviveHpBonus).toBe(80);
    doc.hero!.items = [null, null, null, null]; // no 桃 at all
    const downAlly = (): void => {
      place(w, ally, 0, 28.6);
      w.dealDamage({ targetId: ally.id, amount: 9999, type: 'true' });
      expect(ally.hero!.downed).toBe(true);
    };
    downAlly();
    send(w, 0, [{ a: 'interact' }], { yaw: 0, buttons: BTN_INTERACT });
    stepN(w, T(0.35));
    expect(ally.hero!.downed).toBe(true); // still channelling (0.5 s)
    stepN(w, T(0.25));
    expect(ally.hero!.downed).toBe(false);
    expect(ally.hp).toBe(180); // 100 + 80
    expect(w.cooldownLeft(doc.id, 'huatuo_jijiu')).toBeGreaterThan(29);
    expect(fired(w.drainEvents(), 'huatuo_jijiu')).toBe(true);

    // the free revive is on cooldown and there is no 桃: nothing happens
    downAlly();
    send(w, 0, [{ a: 'interact' }], { yaw: 0, buttons: BTN_INTERACT });
    stepN(w, T(1));
    expect(ally.hero!.downed).toBe(true);
    // with a 桃 it works (fast + bonus) and the free-revive timer is untouched
    w.giveItem(doc.id, 'tao');
    const cdBefore = w.cooldownLeft(doc.id, 'huatuo_jijiu');
    send(w, 0, [{ a: 'interact' }], { yaw: 0, buttons: BTN_INTERACT });
    stepN(w, T(0.6));
    expect(ally.hero!.downed).toBe(false);
    expect(ally.hp).toBe(180);
    expect(doc.hero!.items.some((s) => s?.id === 'tao')).toBe(false);
    expect(w.cooldownLeft(doc.id, 'huatuo_jijiu')).toBeCloseTo(cdBefore - T(0.6) / 30, 1);
    // 30 s later the free revive is back
    stepN(w, T(30));
    expect(w.hooks.canReviveFree(doc)).toBe(true);
  });

  it('急救: a ready free revive goes first — a carried 桃 is kept; on cooldown the 桃 is spent', () => {
    const a = setup();
    const { w } = a;
    const doc = a.at(0);
    const ally = a.at(1);
    doc.hero!.items = [null, { id: 'tao', count: 1 }, null, null];
    const taos = (): number => doc.hero!.items.reduce((n, s) => n + (s?.id === 'tao' ? s.count : 0), 0);
    const downAlly = (): void => {
      place(w, ally, 0, 28.6);
      w.dealDamage({ targetId: ally.id, amount: 9999, type: 'true' });
      expect(ally.hero!.downed).toBe(true);
    };
    downAlly();
    w.drainEvents();
    send(w, 0, [{ a: 'interact' }], { yaw: 0, buttons: BTN_INTERACT });
    stepN(w, T(0.6));
    expect(ally.hero!.downed).toBe(false);
    expect(ally.hp).toBe(180);
    expect(taos()).toBe(1); // the free revive was used, not the 桃
    expect(w.cooldownLeft(doc.id, 'huatuo_jijiu')).toBeGreaterThan(29);
    expect(fired(w.drainEvents(), 'huatuo_jijiu')).toBe(true);
    // the free revive is on cooldown: now the 桃 is spent and the timer is not restarted
    downAlly();
    const cdBefore = w.cooldownLeft(doc.id, 'huatuo_jijiu');
    send(w, 0, [{ a: 'interact' }], { yaw: 0, buttons: BTN_INTERACT });
    stepN(w, T(0.6));
    expect(ally.hero!.downed).toBe(false);
    expect(ally.hp).toBe(180);
    expect(taos()).toBe(0);
    expect(w.cooldownLeft(doc.id, 'huatuo_jijiu')).toBeLessThan(cdBefore);

    // the 桃 item used on a downed ally (a full bag, 3 stacked 桃): the free revive still goes first
    const b = setup();
    const doc2 = b.at(0);
    const ally2 = b.at(1);
    doc2.hero!.items = [{ id: 'tao', count: 3 }, { id: 'sha', count: 1 }, { id: 'sha', count: 1 }, { id: 'sha', count: 1 }];
    place(b.w, ally2, 0, 28.6);
    b.w.dealDamage({ targetId: ally2.id, amount: 9999, type: 'true' });
    expect(ally2.hero!.downed).toBe(true);
    send(b.w, 0, [{ a: 'item', slot: 0 }], { yaw: 0 });
    stepN(b.w, T(0.6));
    expect(ally2.hero!.downed).toBe(false);
    expect(ally2.hp).toBe(180);
    expect(doc2.hero!.items[0]).toEqual({ id: 'tao', count: 3 });
    expect(b.w.cooldownLeft(doc2.id, 'huatuo_jijiu')).toBeGreaterThan(29);
    for (const x of [a, b]) expect(threw(x.warns)).toEqual([]);
  });

  it('青囊: heals the crosshair hero 150 over 3 s and cleanses every debuff', () => {
    const a = setup();
    const { w } = a;
    const doc = a.at(0);
    const ally = a.at(1);
    const foe = a.at(2);
    place(w, ally, 0, 20);
    w.dealDamage({ targetId: ally.id, sourceId: foe.id, amount: 200, type: 'true' });
    w.applyStatus(ally.id, 'slow', 6, { sourceId: foe.id, params: { amount: 0.5 } });
    w.applyStatus(ally.id, 'silence', 6, { sourceId: foe.id });
    w.applyStatus(ally.id, 'burn', 6, { sourceId: foe.id, params: { dps: 10 } });
    const hp0 = ally.hp;
    const def = abilityOf('huatuo', 'q');
    const evs = cast(a, 0, 'q', aimAt(doc, ally));
    expect(fired(evs, def.id)).toBe(true);
    expect(w.cooldownLeft(doc.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    for (const s of ['slow', 'silence', 'burn'] as const) expect(w.hasStatus(ally.id, s), s).toBe(false);
    expect(w.hasStatus(ally.id, 'regen')).toBe(true);
    stepN(w, T(3.2));
    expect(ally.hp - hp0).toBeCloseTo(150, 0);
    expect(doc.hero!.stats.healing).toBeGreaterThanOrEqual(150 - 1e-6);
  });

  it('青囊: with nobody (or a downed hero) under the crosshair it treats Hua Tuo himself', () => {
    const a = setup();
    const { w } = a;
    const doc = a.at(0);
    w.dealDamage({ targetId: doc.id, sourceId: a.at(2).id, amount: 100, type: 'true' });
    w.applyStatus(doc.id, 'slow', 6, { sourceId: a.at(2).id });
    cast(a, 0, 'q', SKY);
    expect(w.hasStatus(doc.id, 'regen')).toBe(true);
    expect(w.hasStatus(doc.id, 'slow')).toBe(false);

    const b = setup();
    const ally = b.at(1);
    place(b.w, ally, 0, 24);
    b.w.dealDamage({ targetId: ally.id, amount: 9999, type: 'true' });
    expect(ally.hero!.downed).toBe(true);
    cast(b, 0, 'q', aimAt(b.at(0), ally));
    expect(b.w.hasStatus(b.at(0).id, 'regen')).toBe(true);
    expect(b.w.hasStatus(ally.id, 'regen')).toBe(false);
  });

  it('麻沸散: the flask lands after a short flight; enemies in 5 m are stunned 1.2 s, then slowed 40 %', () => {
    const a = setup();
    const { w } = a;
    const doc = a.at(0);
    const [e1, e2, far] = [a.at(2), a.at(3), a.at(4)];
    place(w, e1, 0, 12);
    place(w, e2, 3, 12);
    place(w, far, 0, 4);
    const def = abilityOf('huatuo', 'e');
    const troops = w.spawnTroops(doc.id, 'qun_raider', 1, { x: 1, y: 0, z: 11 });
    const evs = cast(a, 0, 'e', aimAtPoint(doc, { x: 0, y: 0, z: 12 }));
    expect(fired(evs, def.id)).toBe(true);
    expect(w.hasStatus(e1.id, 'stun')).toBe(false); // still in the air
    stepN(w, T(1));
    for (const e of [e1, e2]) {
      expect(w.hasStatus(e.id, 'stun')).toBe(true);
      expect(w.statusParam(e.id, 'slow', 'amount', 0)).toBeCloseTo(0.4, 5);
    }
    expect(w.hasStatus(far.id, 'stun')).toBe(false);
    expect(w.hasStatus(troops[0].id, 'stun')).toBe(false); // own soldiers are safe
    expect(w.kindList('hazard').some((h) => h.hazard?.kind === 'mafeiGas')).toBe(true);
    stepN(w, T(1.3));
    expect(w.hasStatus(e1.id, 'stun')).toBe(false);
    expect(w.hasStatus(e1.id, 'slow')).toBe(true);
    stepN(w, T(4));
    expect(w.hasStatus(e1.id, 'slow')).toBe(false);
  });
});

// ── 吕布 ────────────────────────────────────────────────────────────────────
describe('吕布 Lü Bu', () => {
  function setup(): Arena {
    const a = arena(['dummy', 'dummy', 'lubu', 'dummy', 'dummy']);
    place(a.w, a.at(2), 0, 30);
    return a;
  }

  it('无双: his damage ignores dodge i-frames and half of shields; others still get dodged', () => {
    const a = setup();
    const { w } = a;
    const lubu = a.at(2);
    const foe = a.at(3);
    const other = a.at(4);
    foe.hero!.dodgingUntil = w.time + 5;
    expect(w.dealDamage({ targetId: foe.id, sourceId: other.id, amount: 40, type: 'normal', weaponId: 'carbine' }).blocked).toBe('dodge');
    const r = w.dealDamage({ targetId: foe.id, sourceId: lubu.id, amount: 40, type: 'normal', weaponId: 'wushuang' });
    expect(r.blocked).toBeUndefined();
    expect(r.dealt).toBeCloseTo(40, 5);
    // shields: 50 % pierced
    w.addShield(foe.id, 100, 10);
    const s = w.dealDamage({ targetId: foe.id, sourceId: lubu.id, amount: 60, type: 'normal', weaponId: 'wushuang' });
    expect(s.absorbed).toBeCloseTo(30, 5);
    expect(s.dealt).toBeCloseTo(30, 5);
  });

  it('无双: rides 赤兔 (+15 % speed) without stacking with a looted mount', () => {
    const a = setup();
    const { w } = a;
    const lubu = a.at(2);
    expect(w.modifiers(lubu.id).speedMul).toBeCloseTo(1.15, 5);
    expect(w.modifiers(lubu.id).shieldPierce).toBeCloseTo(0.5, 5);
    w.equip(lubu.id, 'chitu'); // +40 %
    w.step();
    expect(w.modifiers(lubu.id).speedMul).toBeCloseTo(1, 5);
    w.equip(lubu.id, 'dilu'); // +18 % beats 赤兔's +15 %
    w.step();
    expect(w.modifiers(lubu.id).speedMul).toBeCloseTo(1, 5);
    w.dismount(lubu.id);
    w.step();
    expect(w.modifiers(lubu.id).speedMul).toBeCloseTo(1.15, 5);
  });

  it('方天画戟: 360° spin hits every enemy within 5 m for 110 with knockback', () => {
    const a = setup();
    const { w } = a;
    const lubu = a.at(2);
    const front = a.at(3);
    const back = a.at(4);
    const far = a.at(1);
    place(w, front, 0, 27);
    place(w, back, 0, 33);
    place(w, far, 8, 30);
    const troop = w.spawnTroops(lubu.id, 'qun_raider', 1, { x: 2, y: 0, z: 30 })[0];
    const def = abilityOf('lubu', 'q');
    const evs = cast(a, 2, 'q', { yaw: 0, pitch: 0 });
    expect(fired(evs, def.id)).toBe(true);
    expect(evs.some((e) => e.t === 'melee' && e.src === lubu.id && e.arc === 360)).toBe(true);
    expect(lost(front)).toBeCloseTo(110, 5);
    expect(lost(back)).toBeCloseTo(110, 5);
    expect(lost(far)).toBe(0);
    expect(troop.hp).toBe(troop.maxHp);
    stepN(w, T(0.5));
    expect(front.pos.z).toBeLessThan(26);
    expect(back.pos.z).toBeGreaterThan(34);
    expect(w.cooldownLeft(lubu.id, def.id)).toBeGreaterThan(def.cooldown! - 1);
  });

  it('辕门射戟: the first unit hit takes 140 and is stunned 1 s; into the sky it still fires', () => {
    const a = setup();
    const { w } = a;
    const lubu = a.at(2);
    place(w, lubu, 0, 50);
    const first = a.at(3);
    const behind = a.at(4);
    place(w, first, 0, 20);
    place(w, behind, 0.2, 14);
    const def = abilityOf('lubu', 'e');
    const evs = cast(a, 2, 'e', aimAt(lubu, first));
    expect(fired(evs, def.id)).toBe(true);
    expect(evs.some((e) => e.t === 'shot' && e.weapon === def.id && e.hit === first.id)).toBe(true);
    expect(lost(first)).toBeCloseTo(140, 5);
    expect(w.hasStatus(first.id, 'stun')).toBe(true);
    expect(lost(behind)).toBe(0);
    stepN(w, T(1.1));
    expect(w.hasStatus(first.id, 'stun')).toBe(false);

    const b = setup();
    const evs2 = cast(b, 2, 'e', SKY);
    expect(fired(evs2, def.id)).toBe(true);
    expect(b.w.cooldownLeft(b.at(2).id, def.id)).toBeGreaterThan(def.cooldown! - 1);
  });
});

// ── 貂蝉 ────────────────────────────────────────────────────────────────────
describe('貂蝉 Diaochan', () => {
  function setup(): Arena {
    const a = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy']);
    place(a.w, a.at(2), 0, 40);
    return a;
  }

  it('闭月: regenerates 5 HP/s only after 5 s without taking damage', () => {
    const a = setup();
    const { w } = a;
    const dc = a.at(2);
    w.dealDamage({ targetId: dc.id, sourceId: a.at(3).id, amount: 150, type: 'true' });
    const hp0 = dc.hp;
    stepN(w, T(4.8));
    expect(dc.hp).toBe(hp0);
    stepN(w, T(4.2)); // ≈ 4 s of regen
    expect(dc.hp - hp0).toBeGreaterThan(17);
    expect(dc.hp - hp0).toBeLessThan(23);
    // taking damage resets the timer
    w.dealDamage({ targetId: dc.id, sourceId: a.at(3).id, amount: 10, type: 'true' });
    const hp1 = dc.hp;
    stepN(w, T(4.5));
    expect(dc.hp).toBe(hp1);
    // never above max, nothing while downed
    stepN(w, T(60));
    expect(dc.hp).toBe(dc.maxHp);
  });

  it('离间: the crosshair enemy and the nearest other hero within 15 m are charmed onto each other', () => {
    const a = setup();
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(3);
    const B = a.at(4);
    const C = a.at(1);
    place(w, A, 0, 25);
    place(w, B, 5, 25);
    place(w, C, -9, 25);
    const def = abilityOf('diaochan', 'q');
    const evs = cast(a, 2, 'q', aimAt(dc, A));
    expect(fired(evs, def.id)).toBe(true);
    expect(w.statusParam(A.id, 'charm', 'targetId', -1)).toBe(B.id);
    expect(w.statusParam(B.id, 'charm', 'targetId', -1)).toBe(A.id);
    expect(w.hasStatus(C.id, 'charm')).toBe(false);
    expect(w.hasStatus(dc.id, 'charm')).toBe(false);
    stepN(w, T(2));
    // forced to shoot each other
    expect(B.hp).toBeLessThan(B.maxHp);
    expect(A.hp).toBeLessThan(A.maxHp);
    stepN(w, T(1));
    expect(w.hasStatus(A.id, 'charm')).toBe(false);
  });

  it('离间 is capped: each bot of the pair loses at most 150 HP to the other, and they stop after the charm (COMBAT-6)', () => {
    // two bot heroes 10 m apart with their signature weapons, hip-firing (uncapped: 190 / 170 here, and
    // 140 more in the 3 s after; the playtest lost 230–390 each, then kept fighting)
    const a = arena(['dummy', 'liubei', 'diaochan', 'dummy', 'zhangjiao'], STD5, {
      humans: [0, 2, 3],
      botFactory: (seat, d, seed) => new HeroBot(seat, d, seed),
    });
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(1);
    const B = a.at(4);
    for (const e of [A, B]) e.maxHp = e.hp = 2000;
    place(w, dc, 0, 55);
    place(w, A, -5, 25, 0);
    place(w, B, 5, 25, Math.PI);
    place(w, a.at(0), -50, -50);
    place(w, a.at(3), 50, -50);
    stepN(w, T(0.5));
    expect(fired(cast(a, 2, 'q', aimAt(dc, A)), 'diaochan_lijian')).toBe(true);
    const hitsOn = (e: Entity, by: Entity, evs: GameEvent[]): number =>
      evs.reduce((n, ev) => n + (ev.t === 'hit' && ev.target === e.id && ev.src === by.id ? ev.amount : 0), 0);
    const during: GameEvent[] = [];
    for (let i = 0; i < T(2.6); i++) {
      w.step();
      during.push(...w.drainEvents());
    }
    expect(w.hasStatus(A.id, 'charm')).toBe(false);
    const after: GameEvent[] = [];
    for (let i = 0; i < T(3); i++) {
      w.step();
      after.push(...w.drainEvents());
    }
    const dA = hitsOn(A, B, during);
    const dB = hitsOn(B, A, during);
    const lingering = hitsOn(A, B, after) + hitsOn(B, A, after);
    process.stdout.write(`[离间] charmed damage A←B ${dA.toFixed(0)} · B←A ${dB.toFixed(0)} · the 3 s after ${lingering.toFixed(0)}\n`);
    for (const d of [dA, dB]) {
      expect(d).toBeGreaterThan(20); // still a fight
      expect(d).toBeLessThanOrEqual(150);
    }
    expect(lingering).toBeLessThan(30);
  });

  it('离间 on two idle players (the charm aims and fires for them): ≤ 150 each, about a third of the uncapped fight (COMBAT-6)', () => {
    const run = (dmgMul: number): [number, number] => {
      const def = abilityOf('diaochan', 'q');
      const old = def.params.dmgMul;
      def.params.dmgMul = dmgMul;
      try {
        const a = arena(['dummy', 'liubei', 'diaochan', 'dummy', 'zhangjiao']);
        const { w } = a;
        const [dc, A, B] = [a.at(2), a.at(1), a.at(4)];
        for (const e of [A, B]) e.maxHp = e.hp = 2000;
        place(w, dc, 0, 50);
        place(w, A, -5, 25, 0);
        place(w, B, 5, 25, Math.PI);
        expect(fired(cast(a, 2, 'q', aimAt(dc, A)), 'diaochan_lijian')).toBe(true);
        stepN(w, T(3));
        return [lost(A), lost(B)];
      } finally {
        def.params.dmgMul = old;
      }
    };
    const full = run(1);
    const capped = run(abilityOf('diaochan', 'q').params.dmgMul);
    process.stdout.write(`[离间] idle pair, uncapped ${full.map((x) => x.toFixed(0)).join(' / ')} → capped ${capped.map((x) => x.toFixed(0)).join(' / ')}\n`);
    for (const d of capped) expect(d).toBeLessThanOrEqual(150);
    expect(capped[0] + capped[1]).toBeLessThan((full[0] + full[1]) * 0.5);
  });

  it('离间: alone, the target is turned on the nearest unit (third parties first, never its own squad)', () => {
    const a = setup();
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(3);
    place(w, A, 0, 25);
    const mine = w.spawnTroops(dc.id, 'qun_raider', 1, { x: 2, y: 0, z: 27 })[0];
    const its = w.spawnTroops(A.id, 'qun_raider', 1, { x: -1, y: 0, z: 24 })[0];
    const third = w.spawnTroops(a.at(0).id, 'qun_raider', 1, { x: 7, y: 0, z: 22 })[0];
    cast(a, 2, 'q', aimAt(dc, A));
    expect(w.statusParam(A.id, 'charm', 'targetId', -1)).toBe(third.id);

    // 1v1 with squads: only its own soldiers and Diaochan's → it turns on hers, not on its own
    const b = setup();
    const A2 = b.at(3);
    place(b.w, A2, 0, 25);
    const mine2 = b.w.spawnTroops(b.at(2).id, 'qun_raider', 1, { x: 3, y: 0, z: 28 })[0];
    b.w.spawnTroops(A2.id, 'qun_raider', 1, { x: -1, y: 0, z: 24 });
    cast(b, 2, 'q', aimAt(b.at(2), A2));
    expect(b.w.statusParam(A2.id, 'charm', 'targetId', -1)).toBe(mine2.id);
    void mine;
    void its;

    // nobody but its own squad: nothing happens and nothing is spent
    const c = setup();
    const A3 = c.at(3);
    place(c.w, A3, 0, 25);
    c.w.spawnTroops(A3.id, 'qun_raider', 2, { x: -1, y: 0, z: 24 });
    const evs = cast(c, 2, 'q', aimAt(c.at(2), A3));
    expect(fired(evs, 'diaochan_lijian')).toBe(false);
    expect(c.w.cooldownLeft(c.at(2).id, 'diaochan_lijian')).toBe(0);
    expect(c.w.hasStatus(A3.id, 'charm')).toBe(false);
    // no target under the crosshair: nothing
    expect(fired(cast(c, 2, 'q', SKY), 'diaochan_lijian')).toBe(false);
  });

  it('离间 / 连环计 never pull in untargetable (空城) or unseen stealthed units', () => {
    const a = setup();
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(3);
    const hidden = a.at(4);
    const C = a.at(1);
    place(w, A, 0, 25);
    place(w, hidden, 2, 25);
    place(w, C, 6, 25);
    w.applyStatus(hidden.id, 'untargetable', 5, { sourceId: hidden.id });
    cast(a, 2, 'q', aimAt(dc, A));
    expect(w.statusParam(A.id, 'charm', 'targetId', -1)).toBe(C.id);
    expect(w.hasStatus(hidden.id, 'charm')).toBe(false);

    const b = setup();
    const A2 = b.at(3);
    const sneak = b.at(4);
    place(b.w, A2, 0, 25);
    place(b.w, sneak, 3, 25);
    b.w.applyStatus(sneak.id, 'stealth', 8, { sourceId: sneak.id, params: { keep: 1 } });
    cast(b, 2, 'e', aimAt(b.at(2), A2));
    expect(b.w.hasStatus(A2.id, 'chained')).toBe(true);
    expect(b.w.hasStatus(sneak.id, 'chained')).toBe(false);
  });

  it('离间 respects the real 陆逊 谦逊 (when the Wu implementation is present)', () => {
    if (!hasAbility('luxun_qianxun')) return;
    const a = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'luxun']);
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(3);
    const lx = a.at(4);
    place(w, dc, 0, 40);
    place(w, A, 0, 25);
    place(w, lx, 4, 25);
    cast(a, 2, 'q', aimAt(dc, A));
    expect(w.statusParam(A.id, 'charm', 'targetId', -1)).toBe(lx.id);
    expect(w.hasStatus(lx.id, 'charm')).toBe(false);
    // aimed at 陆逊 himself: the charm can't land, the other one is still turned on him
    const b = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'luxun']);
    place(b.w, b.at(2), 0, 40);
    place(b.w, b.at(4), 0, 25);
    place(b.w, b.at(3), 4, 25);
    cast(b, 2, 'q', aimAt(b.at(2), b.at(4)));
    expect(b.w.hasStatus(b.at(4).id, 'charm')).toBe(false);
    expect(b.w.statusParam(b.at(3).id, 'charm', 'targetId', -1)).toBe(b.at(4).id);
    expect(threw([...a.warns, ...b.warns])).toEqual([]);
  });

  it('连环计: chains the target + 2 nearest enemies (8 s, slowed 25 %); fire spreads along the chain', () => {
    const a = setup();
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(3);
    place(w, A, 0, 25);
    place(w, a.at(4), 4, 25);
    place(w, a.at(1), 3, 28);
    place(w, a.at(0), 0, 19.5); // 5.5 m: a 4th enemy, not chained (only 2 extra)
    const def = abilityOf('diaochan', 'e');
    const evs = cast(a, 2, 'e', aimAt(dc, A));
    expect(fired(evs, def.id)).toBe(true);
    const chained = [A, a.at(4), a.at(1)];
    for (const e of chained) {
      expect(w.hasStatus(e.id, 'chained'), `seat ${e.hero!.seat}`).toBe(true);
      expect(w.statusParam(e.id, 'slow', 'amount', 0)).toBeCloseTo(0.25, 5);
    }
    expect(w.hasStatus(a.at(0).id, 'chained')).toBe(false);
    expect(w.hasStatus(dc.id, 'chained')).toBe(false);
    // fire on one → all chained take it
    const before = chained.map((e) => e.hp);
    w.dealDamage({ targetId: A.id, sourceId: a.at(0).id, amount: 30, type: 'fire' });
    chained.forEach((e, i) => expect(before[i] - e.hp).toBeCloseTo(30, 5));
    stepN(w, T(8.1));
    expect(w.hasStatus(A.id, 'chained')).toBe(false);
  });
  it('连环计 never links a downed hero, and is not cast on one', () => {
    const a = setup();
    const { w } = a;
    const dc = a.at(2);
    const A = a.at(3);
    const down = a.at(4);
    place(w, A, 0, 25);
    place(w, down, 2, 25); // nearest, and a hero — but downed
    const troop = w.spawnTroops(a.at(0).id, 'qun_raider', 1, { x: 6, y: 0, z: 25 })[0];
    w.dealDamage({ targetId: down.id, amount: 9999, type: 'true' });
    expect(down.hero!.downed).toBe(true);
    const evs = cast(a, 2, 'e', aimAt(dc, A));
    expect(fired(evs, 'diaochan_lianhuan')).toBe(true);
    expect(w.hasStatus(A.id, 'chained')).toBe(true);
    expect(w.hasStatus(troop.id, 'chained')).toBe(true);
    expect(w.hasStatus(down.id, 'chained')).toBe(false);

    // the crosshair on a downed hero: no cast, the cooldown is kept
    const b = setup();
    const D = b.at(3);
    place(b.w, D, 0, 25);
    b.w.dealDamage({ targetId: D.id, amount: 9999, type: 'true' });
    expect(D.hero!.downed).toBe(true);
    expect(fired(cast(b, 2, 'e', aimAt(b.at(2), D)), 'diaochan_lianhuan')).toBe(false);
    expect(b.w.cooldownLeft(b.at(2).id, 'diaochan_lianhuan')).toBe(0);
    expect(b.w.hasStatus(D.id, 'chained')).toBe(false);
  });
});

// ── 张角 ────────────────────────────────────────────────────────────────────
describe('张角 Zhang Jiao', () => {
  function setup(roles: RoleId[] = STD5): Arena {
    const a = arena(['zhangjiao', 'dummy', 'dummy', 'dummy', 'dummy'], roles);
    place(a.w, a.at(0), 0, 40);
    return a;
  }

  it('鬼道: thunder damage +30 %, other types unchanged', () => {
    const a = setup();
    const zj = a.at(0);
    const foe = a.at(2);
    expect(a.w.dealDamage({ targetId: foe.id, sourceId: zj.id, amount: 100, type: 'thunder' }).dealt).toBeCloseTo(130, 5);
    expect(a.w.dealDamage({ targetId: foe.id, sourceId: zj.id, amount: 100, type: 'normal' }).dealt).toBeCloseTo(100, 5);
  });

  it('雷击: 3 bolts 0.6 s apart on the cast point, params.damage (+30 %) each in 3 m; only the first stuns', () => {
    const a = setup();
    const { w } = a;
    const zj = a.at(0);
    const [e1, e2, out] = [a.at(2), a.at(3), a.at(4)];
    place(w, e1, 0, 25);
    place(w, e2, 2, 25);
    place(w, out, 6, 25);
    const def = abilityOf('zhangjiao', 'q');
    const evs = cast(a, 0, 'q', aimAtPoint(zj, { x: 0, y: 0, z: 25 }));
    expect(fired(evs, def.id)).toBe(true);
    expect(evs.filter((e) => e.t === 'explosion' && e.kind === 'thunder')).toHaveLength(1);
    const bolt = LEIJI * 1.3;
    expect(lost(e1)).toBeCloseTo(bolt, 5);
    expect(lost(e2)).toBeCloseTo(bolt, 5);
    expect(lost(out)).toBe(0);
    expect(w.hasStatus(e1.id, 'stun')).toBe(true);
    // the target walks away between bolts: the strikes stay on the cast point
    place(w, e2, 12, 25);
    stepN(w, T(0.6));
    expect(lost(e1)).toBeCloseTo(2 * bolt, 5);
    expect(w.hasStatus(e1.id, 'stun')).toBe(false); // 2nd bolt doesn't stun
    stepN(w, T(0.6));
    expect(lost(e1)).toBeCloseTo(3 * bolt, 5);
    expect(lost(e2)).toBeCloseTo(bolt, 5);
    stepN(w, T(2));
    expect(lost(e1)).toBeCloseTo(3 * bolt, 5); // exactly 3
  });

  it('太平要术: a cloud follows the target 8 s and strikes every 1.5 s (2.5 m); none without a target', () => {
    const a = setup();
    const { w } = a;
    const zj = a.at(0);
    const foe = a.at(2);
    const buddy = a.at(3);
    place(w, foe, 0, 25);
    place(w, buddy, 30, 50);
    const def = abilityOf('zhangjiao', 'e');
    const evs = cast(a, 0, 'e', aimAt(zj, foe));
    expect(fired(evs, def.id)).toBe(true);
    const cloud = w.kindList('hazard').find((h) => h.hazard?.kind === 'lightningCloud')!;
    expect(cloud.hazard!.followId).toBe(foe.id);
    // the target runs: the cloud follows
    place(w, foe, 6, 20);
    place(w, buddy, 7, 20); // 1 m away: struck too
    stepN(w, T(1.3));
    expect(Math.hypot(cloud.pos.x - 6, cloud.pos.z - 20)).toBeLessThan(0.5);
    expect(lost(foe)).toBe(0); // first strike after one interval
    stepN(w, T(0.3));
    const strike = 35 * 1.3;
    expect(lost(foe)).toBeCloseTo(strike, 5);
    expect(lost(buddy)).toBeCloseTo(strike, 5);
    stepN(w, T(7));
    expect(lost(foe)).toBeCloseTo(5 * strike, 5);
    expect(w.kindList('hazard').some((h) => h.hazard?.kind === 'lightningCloud')).toBe(false);

    const b = setup();
    expect(fired(cast(b, 0, 'e', SKY), def.id)).toBe(false);
    expect(b.w.cooldownLeft(b.at(0).id, def.id)).toBe(0);
  });

  it('雷击 / 太平要术 on a 连环计 chain: every chained unit takes each strike exactly once', () => {
    const ROLES8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const build = (): { a: Arena; c: Entity[]; far: Entity; plain: Entity } => {
      const a = arena(['zhangjiao', 'dummy', 'dummy', 'dummy', 'dummy', 'dummy', 'dummy', 'dummy'], ROLES8);
      const { w } = a;
      place(w, a.at(0), 0, 45);
      const c = [a.at(3), a.at(4), a.at(5)];
      place(w, c[0], 0, 25); // a 3 m cluster around (0, 25)
      place(w, c[1], 1.5, 25);
      place(w, c[2], 0, 26.5);
      const far = a.at(6); // chained, far outside the strike
      place(w, far, 20, 25);
      const plain = a.at(7); // inside the strike, not chained
      place(w, plain, -1.5, 25);
      for (const e of [...c, far]) w.applyStatus(e.id, 'chained', 20);
      w.step();
      w.drainEvents();
      return { a, c, far, plain };
    };
    // 雷击: 3 bolts each — not 3 × 3 bolts for the chained cluster
    const L = build();
    const bolt = LEIJI * 1.3;
    expect(fired(cast(L.a, 0, 'q', aimAtPoint(L.a.at(0), { x: 0, y: 0, z: 25 })), 'zhangjiao_leiji')).toBe(true);
    for (const e of [...L.c, L.far, L.plain]) expect(lost(e), `seat ${e.hero!.seat} after bolt 1`).toBeCloseTo(bolt, 5);
    // the first bolt stuns everyone inside the circle (spread-reached links too), not the far link
    for (const e of [...L.c, L.plain]) expect(L.a.w.hasStatus(e.id, 'stun'), `seat ${e.hero!.seat} stunned`).toBe(true);
    expect(L.a.w.hasStatus(L.far.id, 'stun')).toBe(false);
    stepN(L.a.w, T(3));
    for (const e of [...L.c, L.far, L.plain]) expect(lost(e), `seat ${e.hero!.seat}`).toBeCloseTo(3 * bolt, 5);
    expect(threw(L.a.warns)).toEqual([]);

    // 太平要术: 5 strikes × 45.5 each on every link (227.5), wherever the links stand
    const S = build();
    expect(fired(cast(S.a, 0, 'e', aimAt(S.a.at(0), S.c[0])), 'zhangjiao_taiping')).toBe(true);
    stepN(S.a.w, T(8.5));
    for (const e of [...S.c, S.far, S.plain]) expect(lost(e), `seat ${e.hero!.seat}`).toBeCloseTo(5 * 35 * 1.3, 5);
    expect(threw(S.a.warns)).toEqual([]);

    // a nullify on the first link: it is spared the whole bolt (spread included); the rest still take it once
    const N = build();
    N.a.w.applyStatus(N.c[0].id, 'nullify', 20, { sourceId: N.c[0].id });
    cast(N.a, 0, 'q', aimAtPoint(N.a.at(0), { x: 0, y: 0, z: 25 }));
    expect(lost(N.c[0])).toBe(0);
    expect(N.a.w.hasStatus(N.c[0].id, 'stun')).toBe(false);
    for (const e of [N.c[1], N.c[2], N.far, N.plain]) expect(lost(e), `seat ${e.hero!.seat}`).toBeCloseTo(bolt, 5);
  });

  it('太平要术 disperses when Zhang Jiao dies, and stops following a stealthed target', () => {
    // the caster (a rebel: his death does not end the match) dies after the first strike
    const a = arena(['dummy', 'dummy', 'zhangjiao', 'dummy', 'dummy']);
    const { w } = a;
    const zj = a.at(2);
    const foe = a.at(4);
    place(w, zj, 0, 45);
    place(w, foe, 0, 25);
    cast(a, 2, 'e', aimAt(zj, foe));
    stepN(w, T(1.6));
    const strike = 35 * 1.3;
    expect(lost(foe)).toBeCloseTo(strike, 5);
    // downed: the storm keeps going
    zj.hero!.abilityState['menghuo_zaiqi:used'] = 1;
    w.dealDamage({ targetId: zj.id, amount: 9999, type: 'true' });
    expect(zj.hero!.downed).toBe(true);
    stepN(w, T(1.5));
    expect(lost(foe)).toBeCloseTo(2 * strike, 5);
    // dead: the cloud is gone at once and never strikes again
    kill(w, zj);
    w.step();
    expect(w.kindList('hazard').some((h) => h.hazard?.kind === 'lightningCloud')).toBe(false);
    stepN(w, T(6));
    expect(lost(foe)).toBeCloseTo(2 * strike, 5);
    expect(w.result()).toBeNull();

    // stealth: the cloud stays where it lost the target, then picks it up again
    const b = arena(['zhangjiao', 'dummy', 'dummy', 'dummy', 'dummy']);
    place(b.w, b.at(0), 0, 45);
    const t = b.at(3);
    place(b.w, t, 0, 25);
    cast(b, 0, 'e', aimAt(b.at(0), t));
    stepN(b.w, T(0.5));
    const cloud = b.w.kindList('hazard').find((h) => h.hazard?.kind === 'lightningCloud')!;
    b.w.applyStatus(t.id, 'stealth', 5, { sourceId: t.id });
    b.w.step();
    place(b.w, t, 10, 20);
    stepN(b.w, T(0.5));
    expect(Math.hypot(cloud.pos.x - 0, cloud.pos.z - 25)).toBeLessThan(0.5);
    b.w.removeStatus(t.id, 'stealth');
    stepN(b.w, T(0.2));
    expect(Math.hypot(cloud.pos.x - 10, cloud.pos.z - 20)).toBeLessThan(0.5);
    for (const x of [a, b]) expect(threw(x.warns)).toEqual([]);
  });

  it('黄天: only the real Lord summons 5 黄巾力士 for 30 s', () => {
    const a = setup();
    const { w } = a;
    const zj = a.at(0);
    const def = abilityOf('zhangjiao', 'lord');
    const evs = cast(a, 0, 'lord', { yaw: 0, pitch: 0 });
    expect(fired(evs, def.id)).toBe(true);
    const warriors = zj.hero!.squad.map((id) => w.get(id)!).filter((t) => t.troop?.troopType === 'yellowTurbanWarrior');
    expect(warriors).toHaveLength(5);
    expect(w.cooldownLeft(zj.id, def.id)).toBeGreaterThan(def.cooldown! - 1);
    stepN(w, T(30.5));
    expect(warriors.every((t) => !t.alive)).toBe(true);

    // 影武者 (and anyone else) has no lord skill: G does nothing
    const b = arena(['dummy', 'zhangjiao', 'dummy', 'dummy', 'dummy'], ['lord', 'double', 'rebel', 'rebel', 'traitor']);
    const dbl = b.at(1);
    expect(b.w.heroRt(dbl.id)!.abilities.some((x) => x.def.slot === 'lord')).toBe(false);
    const evs2 = cast(b, 1, 'lord', { yaw: 0, pitch: 0 });
    expect(fired(evs2, def.id)).toBe(false);
    expect(dbl.hero!.squad).toHaveLength(0);
    // even called directly the implementation refuses a non-lord
    const impl = getAbility(def.id)!;
    expect(impl.activate!(b.w.abilityCtx(dbl, def))).toBe(false);
  });
});

// ── 袁绍 ────────────────────────────────────────────────────────────────────
describe('袁绍 Yuan Shao', () => {
  it('名门: every soldier he fields has +20 % max HP', () => {
    const a = arena(['yuanshao', 'dummy', 'dummy', 'dummy', 'dummy']);
    const t = a.w.spawnTroops(a.at(0).id, 'qun_raider', 1)[0];
    expect(t.maxHp).toBe(120);
  });

  it('乱击: 10 m arrow rain for 3 s, 16 every 0.5 s to enemies only', () => {
    const a = arena(['dummy', 'dummy', 'yuanshao', 'dummy', 'dummy']);
    const { w } = a;
    const ys = a.at(2);
    place(w, ys, 0, 45);
    const [e1, e2, out] = [a.at(3), a.at(4), a.at(1)];
    place(w, e1, 0, 25);
    place(w, e2, 8, 25);
    place(w, out, 0, 13);
    const mine = w.spawnTroops(ys.id, 'qun_raider', 1, { x: -3, y: 0, z: 25 })[0];
    const def = abilityOf('yuanshao', 'q');
    const evs = cast(a, 2, 'q', aimAtPoint(ys, { x: 0, y: 0, z: 25 }));
    expect(fired(evs, def.id)).toBe(true);
    const rain = w.kindList('hazard').find((h) => h.hazard?.kind === 'arrowRain')!;
    expect(rain.hazard!.radius).toBe(10);
    stepN(w, T(3.5));
    expect(lost(e1)).toBeCloseTo(96, 5);
    expect(lost(e2)).toBeCloseTo(96, 5);
    expect(lost(out)).toBe(0);
    expect(mine.hp).toBe(mine.maxHp);
  });

  it('四世三公: 4 crossbowmen (with 名门 HP) join the squad for 25 s and fight for him', () => {
    // a loyalist 袁绍: his crossbowmen only engage what he shoots / known enemies
    const a = arena(['dummy', 'yuanshao', 'dummy', 'dummy', 'dummy']);
    const { w } = a;
    const ys = a.at(1);
    place(w, ys, 0, 40);
    const evs = cast(a, 1, 'e', { yaw: 0, pitch: 0 });
    expect(fired(evs, 'yuanshao_sishi')).toBe(true);
    const cb = ys.hero!.squad.map((id) => w.get(id)!).filter((t) => t.troop?.troopType === 'qun_crossbowman');
    expect(cb).toHaveLength(4);
    for (const t of cb) expect(t.maxHp).toBe(96);
    // a revealed rebel in range gets shot
    const rebel = a.at(2);
    rebel.hero!.roleRevealed = true;
    place(w, rebel, 0, 15);
    stepN(w, T(6));
    expect(rebel.hp).toBeLessThan(rebel.maxHp);
    stepN(w, T(19.5));
    expect(w.result()).toBeNull();
    expect(cb.every((t) => !t.alive)).toBe(true);
  });

  it('血裔: as the real Lord +50 max HP per other living Qun hero (max 3) and +1 soldier', () => {
    const a = arena(['yuanshao', 'lubu', 'diaochan', 'guanyu', 'dummy'], STD5);
    const { w } = a;
    const ys = a.at(0);
    // dummy placeholder heroes fall back to kingdom 'qun' too: lubu + diaochan + dummy
    expect(ys.maxHp).toBe(500 + 150);
    expect(ys.hp).toBe(ys.maxHp);
    kill(w, a.at(1));
    w.step();
    expect(ys.maxHp).toBe(500 + 100);
    expect(ys.hp).toBeLessThanOrEqual(ys.maxHp);
    // capped at 3
    const b = arena(['yuanshao', 'lubu', 'diaochan', 'huatuo', 'menghuo'], STD5);
    expect(b.at(0).maxHp).toBe(500 + 150);
    // not the lord: no bonus at all
    const c = arena(['guanyu', 'yuanshao', 'lubu', 'diaochan', 'huatuo'], STD5);
    expect(c.at(1).maxHp).toBe(400);
    expect(c.w.modifiers(c.at(1).id).squadBonus).toBe(0);
    // squads: lord 袁绍 = 4 + 名门 1 + lord 2 + 血裔 1; a loyalist 袁绍 = 4 + 1
    const d = makeWorld(STD5, { heroes: ['yuanshao', 'yuanshao', 'guanyu', 'dummy', 'dummy'], squads: true, onWarn: () => {} });
    const base = defaultSettings().troopsPerHero;
    expect(hero(d, 0).hero!.squad).toHaveLength(base + 1 + 2 + 1);
    expect(hero(d, 1).hero!.squad).toHaveLength(base + 1);
  });
});

// ── 孟获 ────────────────────────────────────────────────────────────────────
describe('孟获 Meng Huo', () => {
  function setup(): Arena {
    const a = arena(['dummy', 'dummy', 'menghuo', 'dummy', 'dummy']);
    place(a.w, a.at(2), 0, 50);
    return a;
  }

  it('祸首: barbarians (even someone else\'s) never target nor hurt him', () => {
    const a = setup();
    const { w } = a;
    const mh = a.at(2);
    const other = a.at(3);
    place(w, other, 3, 50);
    expect(w.modifiers(mh.id).npcImmune).toEqual(expect.arrayContaining(['barbarian', 'elephant']));
    const barb = w.spawnNpc('barbarian', { x: 1.5, y: 0, z: 48 }, { summonerId: a.at(4).id, lifetime: 20 });
    expect(w.isHostileTo(barb, mh)).toBe(false);
    expect(w.isHostileTo(barb, other)).toBe(true);
    expect(w.dealDamage({ targetId: mh.id, sourceId: barb.id, amount: 30, type: 'melee', weaponId: 'troop_melee' }).dealt).toBe(0);
    expect(w.dealDamage({ targetId: other.id, sourceId: barb.id, amount: 30, type: 'melee', weaponId: 'troop_melee' }).dealt).toBe(30);
    stepN(w, T(4));
    expect(mh.hp).toBe(mh.maxHp);
  });

  it('再起: the first time he would be downed he rises with 50 % HP; the second time he goes down', () => {
    const a = setup();
    const { w } = a;
    const mh = a.at(2);
    w.dealDamage({ targetId: mh.id, sourceId: a.at(3).id, amount: 9999, type: 'true' });
    expect(mh.hero!.downed).toBe(false);
    expect(mh.hp).toBe(mh.maxHp * 0.5);
    const evs = w.drainEvents();
    expect(evs.some((e) => e.t === 'revived' && e.target === mh.id)).toBe(true);
    expect(fired(evs, 'menghuo_zaiqi')).toBe(true);
    expect(mh.hero!.abilityState['menghuo_zaiqi:used']).toBe(1);
    w.dealDamage({ targetId: mh.id, sourceId: a.at(3).id, amount: 9999, type: 'true' });
    expect(mh.hero!.downed).toBe(true);
  });

  it('南蛮入侵: params.count barbarians (params.lifetime s) spawn beside him and rush the crosshair point', () => {
    const a = setup();
    const { w } = a;
    const mh = a.at(2);
    // everyone else far south, out of the barbarians' aggro range
    for (const s of [0, 1, 3, 4]) place(w, a.at(s), s * 8 - 16, -50);
    const point = { x: 0, y: 0, z: 22 };
    const def = abilityOf('menghuo', 'q');
    const evs = cast(a, 2, 'q', aimAtPoint(mh, point));
    expect(fired(evs, def.id)).toBe(true);
    const barbs = w.kindList('npc').filter((n) => n.npc?.npcType === 'barbarian' && n.npc.summonerId === mh.id);
    expect(barbs).toHaveLength(def.params.count);
    for (const b of barbs) {
      expect(b.npc!.ai.goalX).toBeCloseTo(point.x, 3);
      expect(b.npc!.ai.goalZ).toBeCloseTo(point.z, 3);
      expect(b.npc!.expiresAt).toBeCloseTo(w.time + def.params.lifetime, 1);
      expect(Math.hypot(b.pos.x - mh.pos.x, b.pos.z - mh.pos.z)).toBeLessThan(6);
    }
    stepN(w, T(4));
    const mean = barbs.reduce((s, b) => s + b.pos.z, 0) / barbs.length;
    expect(mean).toBeLessThan(40); // rushing toward z = 22
    stepN(w, T(def.params.lifetime - 3.5));
    expect(barbs.every((b) => !b.alive)).toBe(true);
  });

  it('象兵: the elephant charges 30 m, tramples each enemy in its path once (100 + knockback), then fights', () => {
    const a = setup();
    const { w } = a;
    const mh = a.at(2);
    const [e1, e2, off] = [a.at(3), a.at(4), a.at(1)];
    place(w, e1, 0, 38);
    place(w, e2, 2, 28);
    place(w, off, 9, 32);
    const mine = w.spawnTroops(mh.id, 'qun_raider', 1, { x: -1, y: 0, z: 33 })[0];
    const reqs = spyDamage(w);
    const def = abilityOf('menghuo', 'e');
    const evs = cast(a, 2, 'e', { yaw: 0, pitch: 0 });
    expect(fired(evs, def.id)).toBe(true);
    const ele = w.kindList('npc').find((n) => n.npc?.npcType === 'elephant')!;
    expect(ele.npc!.summonerId).toBe(mh.id);
    stepN(w, T(2.2));
    const trampled = (id: EntityId): number => reqs.filter((r) => r.targetId === id && r.abilityId === def.id).length;
    expect(trampled(e1.id)).toBe(1);
    expect(trampled(e2.id)).toBe(1);
    expect(trampled(off.id)).toBe(0);
    expect(trampled(mine.id)).toBe(0);
    expect(reqs.find((r) => r.abilityId === def.id)!.amount).toBe(100);
    expect(50 - 2.5 - ele.pos.z).toBeGreaterThan(24); // ≈ 30 m charge
    expect(ele.alive).toBe(true);
    stepN(w, T(12.5));
    expect(ele.alive).toBe(false);
  });
  it('象兵: nobody behind (or right beside, behind the spawn point) Meng Huo is trampled', () => {
    const a = setup();
    const { w } = a;
    const mh = a.at(2);
    const behind = a.at(3);
    const ahead = a.at(4);
    place(w, behind, 0, 52.5); // 2.5 m behind him (he charges toward -z)
    place(w, ahead, 0, 40);
    const reqs = spyDamage(w);
    cast(a, 2, 'e', { yaw: 0, pitch: 0 });
    stepN(w, T(2.2));
    const trampled = (id: EntityId): number => reqs.filter((r) => r.targetId === id && r.abilityId === 'menghuo_xiangbing').length;
    expect(trampled(behind.id)).toBe(0);
    expect(lost(behind)).toBe(0);
    expect(Math.abs(behind.pos.z - 52.5)).toBeLessThan(0.5); // not knocked anywhere
    expect(trampled(ahead.id)).toBe(1);
    expect(lost(ahead)).toBe(100);
  });
});

// ── robustness ──────────────────────────────────────────────────────────────
describe('群 robustness', () => {
  const ACTIVE: [string, 'q' | 'e' | 'lord'][] = [];
  for (const id of QUN) for (const a of HERO_BY_ID[id].abilities) if (!isPassiveAbility(a)) ACTIVE.push([id, a.slot as 'q' | 'e' | 'lord']);

  it('downed or dead casters never activate; silenced / stunned ones are blocked by the world', () => {
    for (const [heroId, slot] of ACTIVE) {
      const def = abilityOf(heroId, slot);
      // lord skills need the real lord (seat 0); everything else is cast by a rebel (seat 2),
      // whose death does not end the match, so in-flight effects keep being simulated
      const seat = slot === 'lord' ? 0 : 2;
      const heroes = ['dummy', 'dummy', 'dummy', 'dummy', 'dummy'];
      heroes[seat] = heroId;
      const a = arena(heroes);
      const { w } = a;
      const me = a.at(seat);
      place(w, me, 0, 40);
      const foe = a.at(4);
      place(w, foe, 0, 28);
      place(w, a.at(3), 4, 28); // a second hero near the target (离间 needs a pair)
      const aim = aimAt(me, foe);
      // silenced
      w.applyStatus(me.id, 'silence', 3, { sourceId: foe.id });
      expect(fired(cast(a, seat, slot, aim), def.id), `${def.id} silenced`).toBe(false);
      expect(w.cooldownLeft(me.id, def.id)).toBe(0);
      w.removeStatus(me.id, 'silence');
      // stunned
      w.applyStatus(me.id, 'stun', 1, { sourceId: foe.id });
      expect(fired(cast(a, seat, slot, aim), def.id), `${def.id} stunned`).toBe(false);
      w.removeStatus(me.id, 'stun');
      // a real cast, then downed (再起 spent first) while its effects are in flight
      expect(fired(cast(a, seat, slot, aim), def.id), `${def.id} casts`).toBe(true);
      me.hero!.abilityState['menghuo_zaiqi:used'] = 1;
      w.dealDamage({ targetId: me.id, amount: 9999, type: 'true' });
      expect(me.hero!.downed).toBe(true);
      w.setCooldown(me.id, def.id, 0);
      expect(fired(cast(a, seat, slot, aim), def.id), `${def.id} downed`).toBe(false);
      expect(activateDirect(w, me, def.id), `${def.id} direct while downed`).toBe(false);
      // dead
      kill(w, me);
      expect(activateDirect(w, me, def.id), `${def.id} direct while dead`).toBe(false);
      expect(() => stepN(w, T(9))).not.toThrow();
      expect(threw(a.warns), def.id).toEqual([]);
    }
  });

  it('effects already in flight survive the caster dying and targets vanishing', () => {
    // 雷击: the caster dies right after calling the storm — the called bolts still fall
    const a = arena(['dummy', 'dummy', 'zhangjiao', 'dummy', 'dummy']);
    place(a.w, a.at(2), 0, 40);
    const foe = a.at(4);
    place(a.w, foe, 0, 25);
    cast(a, 2, 'q', aimAtPoint(a.at(2), { x: 0, y: 0, z: 25 }));
    kill(a.w, a.at(2));
    stepN(a.w, T(2));
    expect(a.w.result()).toBeNull();
    expect(lost(foe)).toBeCloseTo(3 * LEIJI * 1.3, 5);

    // 太平要术: the followed target dies → the cloud lingers there and expires cleanly
    const b = arena(['dummy', 'dummy', 'zhangjiao', 'dummy', 'dummy']);
    place(b.w, b.at(2), 0, 40);
    const t = b.at(4);
    place(b.w, t, 0, 25);
    cast(b, 2, 'e', aimAt(b.at(2), t));
    stepN(b.w, T(2));
    kill(b.w, t);
    expect(() => stepN(b.w, T(8))).not.toThrow();
    expect(b.w.result()).toBeNull();
    expect(b.w.kindList('hazard').length).toBe(0);

    // 麻沸散: Hua Tuo dies while the flask flies — it still lands
    const c = arena(['dummy', 'dummy', 'huatuo', 'dummy', 'dummy']);
    place(c.w, c.at(2), 0, 40);
    const g = c.at(4);
    place(c.w, g, 0, 18);
    cast(c, 2, 'e', aimAtPoint(c.at(2), { x: 0, y: 0, z: 18 }));
    kill(c.w, c.at(2));
    stepN(c.w, T(1.2));
    expect(c.w.hasStatus(g.id, 'stun')).toBe(true);

    // 象兵: the elephant is killed mid-charge → the trample stops, nothing breaks
    const d = arena(['dummy', 'dummy', 'menghuo', 'dummy', 'dummy']);
    place(d.w, d.at(2), 0, 50);
    const late = d.at(3);
    place(d.w, late, 0, 22);
    cast(d, 2, 'e', { yaw: 0, pitch: 0 });
    stepN(d.w, T(0.3));
    const ele = d.w.kindList('npc').find((n) => n.npc?.npcType === 'elephant')!;
    d.w.killUnit(ele, undefined);
    expect(() => stepN(d.w, T(3))).not.toThrow();
    expect(lost(late)).toBe(0);

    // 离间: one of the pair dies → the other's charm ends
    const e = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy']);
    place(e.w, e.at(2), 0, 40);
    const A = e.at(3);
    const B = e.at(4);
    place(e.w, A, 0, 25);
    place(e.w, B, 4, 25);
    cast(e, 2, 'q', aimAt(e.at(2), A));
    expect(e.w.hasStatus(A.id, 'charm')).toBe(true);
    kill(e.w, B);
    e.w.step();
    expect(e.w.hasStatus(A.id, 'charm')).toBe(false);

    for (const x of [a, b, c, d, e]) expect(threw(x.warns)).toEqual([]);
  });

  it('无懈可击 cancels a whole cast on its holder (one charge), 谦逊-style vetoes are respected', () => {
    // 麻沸散: stun + slow of one flask cost a single nullify charge
    const a = arena(['huatuo', 'dummy', 'dummy', 'dummy', 'dummy']);
    place(a.w, a.at(0), 0, 40);
    const n = a.at(2);
    const plain = a.at(3);
    place(a.w, n, 0, 20);
    place(a.w, plain, 2, 20);
    a.w.applyStatus(n.id, 'nullify', 20, { sourceId: n.id });
    cast(a, 0, 'e', aimAtPoint(a.at(0), { x: 1, y: 0, z: 20 }));
    stepN(a.w, T(1.2));
    expect(a.w.hasStatus(n.id, 'stun')).toBe(false);
    expect(a.w.hasStatus(n.id, 'slow')).toBe(false);
    expect(a.w.hasStatus(n.id, 'nullify')).toBe(false);
    expect(a.w.hasStatus(plain.id, 'stun')).toBe(true);

    // 雷击: the first bolt is cancelled (no damage, no stun); the next ones land
    const b = arena(['zhangjiao', 'dummy', 'dummy', 'dummy', 'dummy']);
    place(b.w, b.at(0), 0, 40);
    const m = b.at(2);
    place(b.w, m, 0, 25);
    b.w.applyStatus(m.id, 'nullify', 20, { sourceId: m.id });
    cast(b, 0, 'q', aimAtPoint(b.at(0), { x: 0, y: 0, z: 25 }));
    expect(lost(m)).toBe(0);
    expect(b.w.hasStatus(m.id, 'stun')).toBe(false);
    stepN(b.w, T(1.3));
    expect(lost(m)).toBeCloseTo(2 * LEIJI * 1.3, 5);

    // 离间 on a hero that can't be charmed (谦逊-like veto): only the other one is turned
    const c = arena(['dummy', 'dummy', 'diaochan', 'dummy', 'dummy']);
    place(c.w, c.at(2), 0, 40);
    const A = c.at(3);
    const B = c.at(4);
    place(c.w, A, 0, 25);
    place(c.w, B, 4, 25);
    injectPassive(c.w, B, { id: 't_qianxun', canBeAffected: (_ctx, st) => st !== 'charm' });
    const evs = cast(c, 2, 'q', aimAt(c.at(2), A));
    expect(fired(evs, 'diaochan_lijian')).toBe(true);
    expect(c.w.statusParam(A.id, 'charm', 'targetId', -1)).toBe(B.id);
    expect(c.w.hasStatus(B.id, 'charm')).toBe(false);
    stepN(c.w, T(3));
    for (const x of [a, b, c]) expect(threw(x.warns)).toEqual([]);
  });

  it('two copies of a hero cast at once without sharing state', () => {
    const a = arena(['dummy', 'dummy', 'zhangjiao', 'zhangjiao', 'dummy']);
    const { w } = a;
    const z1 = a.at(2);
    const z2 = a.at(3);
    place(w, z1, -10, 45);
    place(w, z2, 10, 45);
    const foe = a.at(0); // the lord: 500 HP survives 6 bolts
    place(w, foe, 0, 25);
    send(w, 2, [{ a: 'ability', slot: 'q' }], aimAtPoint(z1, { x: 0, y: 0, z: 25 }));
    send(w, 3, [{ a: 'ability', slot: 'q' }], aimAtPoint(z2, { x: 0, y: 0, z: 25 }));
    w.step();
    stepN(w, T(1.5));
    // 6 bolts in total (the stun of the second first bolt refreshes, no extra damage)
    expect(lost(foe)).toBeCloseTo(6 * LEIJI * 1.3, 5);
    expect(threw(a.warns)).toEqual([]);
  });

  it('bots with Qun heroes fight and cast for 90 s on the test map without errors', () => {
    const warns: string[] = [];
    const heroes = ['zhangjiao', 'lubu', 'diaochan', 'huatuo', 'menghuo'];
    const w = makeWorld(STD5, { heroes, humans: [], squads: true, onWarn: (m) => warns.push(m) });
    const spots: [number, number][] = [[0, 30], [4, 26], [-4, 22], [3, 18], [-2, 34]];
    STD5.forEach((_, i) => place(w, hero(w, i), spots[i][0], spots[i][1]));
    for (const h of w.heroList()) h.hero!.roleRevealed = true; // everyone engages at once
    const casts = new Set<string>();
    for (let i = 0; i < T(90) && !w.result(); i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'ability') casts.add(e.ability);
    }
    expect(threw(warns)).toEqual([]);
    expect(casts.size).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

// ── full match ──────────────────────────────────────────────────────────────
describe('群 full match', () => {
  const ROLES8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
  const CASES: { lord: string; seed: number; heroes: string[] }[] = [
    { lord: '张角', seed: 777, heroes: ['zhangjiao', 'huatuo', 'lubu', 'diaochan', 'yuanshao', 'menghuo', 'lubu', 'diaochan'] },
    { lord: '袁绍', seed: 778, heroes: ['yuanshao', 'menghuo', 'diaochan', 'huatuo', 'zhangjiao', 'lubu', 'menghuo', 'huatuo'] },
  ];
  for (const c of CASES) {
    it(`8 bots, all Qun heroes (${c.lord} as Lord), end with a valid GameResult and no ability errors`, () => {
      const init: MatchInit = {
        settings: { ...defaultSettings(), playerCount: 8 },
        seed: c.seed,
        seats: ROLES8.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `Bot ${i}`, isBot: true, role, heroId: c.heroes[i] })),
      };
      const warns: string[] = [];
      const w = createWorld(init, { onWarn: (m) => warns.push(m) });
      const lord = w.heroList().find((h) => h.hero!.role === 'lord')!;
      if (c.heroes[0] === 'yuanshao') {
        // 血裔 in a real match: 3 other Qun heroes alive at the start (capped) → +150, squad 4 + 1 + 2 + 1
        expect(lord.maxHp).toBe(400 + 100 + 150);
        expect(lord.hero!.squad).toHaveLength(defaultSettings().troopsPerHero + 1 + 2 + 1);
      }
      const casts = new Map<string, number>();
      const maxTicks = T(15 * 60 + 150);
      for (let i = 0; i < maxTicks && !w.result(); i++) {
        w.step();
        for (const e of w.drainEvents()) if (e.t === 'ability') casts.set(e.ability, (casts.get(e.ability) ?? 0) + 1);
      }
      const res = w.result();
      expect(res).toBeTruthy();
      expect(['lord', 'rebel', 'traitor', 'draw']).toContain(res!.winner);
      expect(Object.keys(res!.roles)).toHaveLength(8);
      expect(threw(warns)).toEqual([]);
      const qunCasts = [...casts.keys()].filter((id) => QUN.some((h) => id.startsWith(`${h}_`)));
      expect(qunCasts.length).toBeGreaterThanOrEqual(5);
      console.log(`[qun match ${c.lord}] ${res!.winner} after ${res!.durationSec}s; casts: ${[...casts].map(([k, v]) => `${k}×${v}`).join(' ')}`);
    }, 240_000);
  }
});
