import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, InputFrame } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, emptyInput } from '../../../src/core/types';
import { BULLET_EVASION_CAP } from '../../../src/data';
import type { AbilityImplEx } from '../../../src/sim/ext';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

const ROLES5 = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'] as const;

function duel(): { w: World; a: Entity; b: Entity } {
  const w = makeWorld([...ROLES5]);
  const a = hero(w, 2);
  const b = hero(w, 3);
  place(w, a, 0, 30);
  place(w, b, 0, 20);
  // park everyone else far away
  place(w, hero(w, 0), -50, 50);
  place(w, hero(w, 1), -50, 45);
  place(w, hero(w, 4), -45, 50);
  w.step(); // record lag-compensation history at the new positions
  return { w, a, b };
}

/** Inject an extra ability implementation onto a hero (test hook). */
function inject(w: World, e: Entity, impl: AbilityImplEx): void {
  w.heroRt(e.id)!.abilities.push({
    def: { id: impl.id, slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} },
    impl,
  });
}

/** Aimed (ADS) input toward a world point; `fire` adds BTN_FIRE. */
function aimFrame(w: World, shooter: Entity, target: { x: number; y: number; z: number }, p: Partial<InputFrame> = {}): InputFrame {
  const ang = aimAnglesFor(shooter.pos, target);
  const f = { ...emptyInput(), yaw: ang.yaw, pitch: ang.pitch, aimPoint: { ...target }, viewTick: w.tick, ...p };
  f.buttons |= BTN_ADS;
  return f;
}

function events<T extends GameEvent['t']>(evs: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] {
  return evs.filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);
}

describe('damage pipeline', () => {
  it('applies plain damage, emits a hit event and credits stats', () => {
    const { w, a, b } = duel();
    w.drainEvents();
    const r = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'normal', weaponId: 'pistol' });
    expect(r.dealt).toBe(50);
    expect(b.hp).toBe(b.maxHp - 50);
    expect(a.hero!.stats.damage).toBe(50);
    const hit = events(w.drainEvents(), 'hit')[0];
    expect(hit.target).toBe(b.id);
    expect(hit.src).toBe(a.id);
    expect(hit.amount).toBe(50);
  });

  it('dodge i-frames block dodgeable damage; canDodge=false and undodgeable attackers go through', () => {
    const { w, a, b } = duel();
    b.hero!.dodgingUntil = w.time + 5;
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal', weaponId: 'pistol' }).blocked).toBe('dodge');
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal', canDodge: false }).dealt).toBe(30);
    w.applyStatus(a.id, 'undodgeable', 5, { sourceId: a.id });
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal', weaponId: 'pistol' }).dealt).toBe(30);
  });

  it('invuln blocks everything including the zone; untargetable does not block zone damage', () => {
    const { w, b } = duel();
    w.applyStatus(b.id, 'invuln', 5, { sourceId: b.id });
    expect(w.dealDamage({ targetId: b.id, amount: 30, type: 'zone' }).blocked).toBe('invuln');
    w.removeStatus(b.id, 'invuln');
    w.applyStatus(b.id, 'untargetable', 5, { sourceId: b.id });
    expect(w.dealDamage({ targetId: b.id, amount: 30, type: 'normal' }).blocked).toBe('invuln');
    expect(w.dealDamage({ targetId: b.id, amount: 30, type: 'zone' }).dealt).toBe(30);
  });

  it('八卦 evades ~35 % of bullets but never melee', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'bagua';
    b.maxHp = 1e9;
    b.hp = 1e9;
    let dodged = 0;
    for (let i = 0; i < 1000; i++) if (w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', weaponId: 'pistol' }).blocked === 'dodge') dodged++;
    expect(dodged).toBeGreaterThan(290);
    expect(dodged).toBeLessThan(410);
    for (let i = 0; i < 100; i++) expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'melee' }).blocked).toBeUndefined();
    // armor-piercing rounds ignore 八卦 entirely
    for (let i = 0; i < 100; i++) expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', weaponId: 'qinggang', ignoreArmor: true }).blocked).toBeUndefined();
  });

  it('bullet evasion sources combine as 1 − Π(1 − p) and are capped at BULLET_EVASION_CAP', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'bagua'; // 0.35
    w.applyStatus(b.id, 'dodgeChance', 1e6, { sourceId: b.id, params: { chance: 0.5 } }); // → 0.675 uncapped
    b.maxHp = 1e9;
    b.hp = 1e9;
    let dodged = 0;
    for (let i = 0; i < 2000; i++) if (w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', weaponId: 'pistol' }).blocked === 'dodge') dodged++;
    expect(dodged / 2000).toBeGreaterThan(BULLET_EVASION_CAP - 0.04);
    expect(dodged / 2000).toBeLessThan(BULLET_EVASION_CAP + 0.04);
  });

  it('仁王盾 reduces bullets from the front only', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'renwang';
    // b at z=20 facing +z (toward a at z=30): yaw = pi
    b.yaw = Math.PI;
    const front = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' });
    expect(front.dealt).toBeCloseTo(30, 5);
    b.yaw = 0; // facing away
    const back = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' });
    expect(back.dealt).toBeCloseTo(100, 5);
  });

  it('藤甲: -40 % bullets, immune to troop bullets, fire ×2', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'tengjia';
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' }).dealt).toBeCloseTo(60, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'fire' }).dealt).toBeCloseTo(100, 5);
    const [troop] = w.spawnTroops(a.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 25 });
    const r = w.dealDamage({ targetId: b.id, sourceId: troop.id, amount: 40, type: 'normal', weaponId: 'troop_rifle' });
    expect(r.dealt).toBe(0);
    expect(r.blocked).toBe('armor');
  });

  it('白银狮子 caps single hits at 60 and heals 100 when removed', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'baiyin';
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 250, type: 'explosive' }).dealt).toBe(60);
    const hpBefore = b.hp;
    w.stripArmor(b.id);
    expect(b.hero!.armor).toBeNull();
    expect(b.hp).toBe(Math.min(b.maxHp, hpBefore + 100));
  });

  it('mount damageTakenMul and dmgTaken statuses multiply incoming damage', () => {
    const { w, a, b } = duel();
    b.hero!.mount = 'jueying'; // 0.82
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' }).dealt).toBeCloseTo(82, 5);
    w.applyStatus(b.id, 'dmgTakenUp', 5, { sourceId: a.id, params: { mul: 1.5 } });
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' }).dealt).toBeCloseTo(123, 5);
  });

  it('outgoing mods apply before armor, victim modifyIncoming after armor, shield after that', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'tengjia'; // bullets ×0.6
    let seenIncoming = -1;
    inject(w, a, { id: 't_out', modifyOutgoing: (_c, amt) => amt * 2 });
    inject(w, b, {
      id: 't_in',
      modifyIncoming: (_c, amt) => {
        seenIncoming = amt;
        return amt - 10;
      },
    });
    w.addShield(b.id, 20, 10);
    const r = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'normal', weaponId: 'pistol' });
    expect(seenIncoming).toBeCloseTo(50 * 2 * 0.6, 5);
    expect(r.absorbed).toBeCloseTo(20, 5);
    expect(r.dealt).toBeCloseTo(60 - 10 - 20, 5);
    expect(b.shield).toBe(0);
  });

  it('dmgBoost multiplies and 酒 (drunk) doubles the next direct hit then is consumed', () => {
    const { w, a, b } = duel();
    w.applyStatus(a.id, 'dmgBoost', 5, { sourceId: a.id, params: { mul: 1.5 } });
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'normal' }).dealt).toBeCloseTo(15, 5);
    w.removeStatus(a.id, 'dmgBoost');
    w.applyStatus(a.id, 'drunk', 8, { sourceId: a.id, params: { mul: 2 } });
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'normal' }).dealt).toBeCloseTo(20, 5);
    expect(w.hasStatus(a.id, 'drunk')).toBe(false);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'normal' }).dealt).toBeCloseTo(10, 5);
    // 酒 with weaponOnly: ability damage neither doubles nor consumes it; the next weapon hit does
    w.applyStatus(a.id, 'drunk', 8, { sourceId: a.id, params: { mul: 2, weaponOnly: 1 } });
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'melee', abilityId: 'x' }).dealt).toBeCloseTo(10, 5);
    expect(w.hasStatus(a.id, 'drunk')).toBe(true);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'normal', weaponId: 'pistol' }).dealt).toBeCloseTo(20, 5);
    expect(w.hasStatus(a.id, 'drunk')).toBe(false);
  });

  it('shields absorb before HP and report blocked=shield when fully absorbed', () => {
    const { w, a, b } = duel();
    w.addShield(b.id, 50, 5);
    const r1 = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal' });
    expect(r1.absorbed).toBe(30);
    expect(r1.dealt).toBe(0);
    expect(r1.blocked).toBeUndefined();
    const r2 = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal' });
    expect(r2.absorbed).toBe(20);
    expect(r2.dealt).toBe(10);
    expect(w.hasStatus(b.id, 'shield')).toBe(false);
    // true / zone damage ignores shields
    w.addShield(b.id, 50, 5);
    expect(w.dealDamage({ targetId: b.id, amount: 10, type: 'true' }).absorbed).toBe(0);
  });

  it('shields expire with their status', () => {
    const { w, b } = duel();
    w.addShield(b.id, 40, 1);
    stepN(w, 40);
    expect(b.shield).toBe(0);
  });

  it('reflect and thorns hit the attacker once and never loop', () => {
    const { w, a, b } = duel();
    w.applyStatus(a.id, 'reflect', 10, { sourceId: a.id, params: { frac: 1 } });
    w.applyStatus(b.id, 'reflect', 10, { sourceId: b.id, params: { frac: 1 } });
    w.applyStatus(a.id, 'thorns', 10, { sourceId: a.id, params: { frac: 1 } });
    w.applyStatus(b.id, 'thorns', 10, { sourceId: b.id, params: { frac: 1 } });
    const aHp = a.hp;
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 20, type: 'normal', weaponId: 'pistol' });
    // reflect (20) + thorns (20), each only once
    expect(aHp - a.hp).toBeCloseTo(40, 5);
    expect(b.maxHp - b.hp).toBeCloseTo(20, 5);
  });

  it('lifesteal heals the attacker', () => {
    const { w, a, b } = duel();
    a.hp = 100;
    w.applyStatus(a.id, 'lifesteal', 5, { sourceId: a.id, params: { frac: 0.5 } });
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 40, type: 'normal' });
    expect(a.hp).toBeCloseTo(120, 5);
    expect(a.hero!.stats.healing).toBeCloseTo(20, 5);
  });

  it('铁索连环: fire/thunder spreads to every chained unit exactly once', () => {
    const { w, a, b } = duel();
    const c = hero(w, 4);
    place(w, c, 5, 20);
    for (const e of [b, c]) w.applyStatus(e.id, 'chained', 8, { sourceId: a.id });
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'fire' });
    expect(b.maxHp - b.hp).toBeCloseTo(30, 5);
    expect(c.maxHp - c.hp).toBeCloseTo(30, 5);
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 30, type: 'normal' });
    expect(c.maxHp - c.hp).toBeCloseTo(30, 5);
  });

  it('commanders and their own troops never damage each other', () => {
    const { w, a } = duel();
    const [t] = w.spawnTroops(a.id, 'shu_rifleman', 1, { x: 2, y: 0, z: 30 });
    expect(w.dealDamage({ targetId: t.id, sourceId: a.id, amount: 50, type: 'normal' }).dealt).toBe(0);
    expect(w.dealDamage({ targetId: a.id, sourceId: t.id, amount: 50, type: 'normal' }).dealt).toBe(0);
    // own AoE spares own troops and self
    w.explode({ x: 1, y: 0, z: 30 }, 5, 100, 'explosive', a.id);
    expect(t.hp).toBe(t.maxHp);
    expect(a.hp).toBe(a.maxHp);
    // self damage (苦肉) is allowed
    expect(w.dealDamage({ targetId: a.id, sourceId: a.id, amount: 40, type: 'true' }).dealt).toBe(40);
  });

  it('explosions fall off to 50 % at the edge and are blocked by walls', () => {
    const { w, a, b } = duel();
    place(w, b, 0, 0); // behind nothing
    w.explode({ x: 0, y: 0, z: 0 }, 4, 100, 'explosive', a.id);
    const close = b.maxHp - b.hp;
    expect(close).toBeGreaterThan(70);
    expect(close).toBeLessThanOrEqual(100);
    const c = hero(w, 4);
    place(w, c, 11.5, 0); // other side of the wall at x=10
    const before = c.hp;
    w.explode({ x: 8.5, y: 0.5, z: 0 }, 5, 100, 'explosive', a.id);
    expect(c.hp).toBe(before);
  });

  it('downed at 0 HP, damage while downed shortens bleed-out, finishing kills', () => {
    const { w, a, b } = duel();
    w.drainEvents();
    const r = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1000, type: 'normal' });
    expect(r.killed).toBe(true);
    expect(b.hero!.downed).toBe(true);
    expect(b.alive).toBe(true);
    expect(events(w.drainEvents(), 'downed')[0]).toMatchObject({ target: b.id, src: a.id });
    const until = b.hero!.downedUntil;
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 20, type: 'normal' });
    expect(b.hero!.downedUntil).toBeCloseTo(until - 2, 5);
    w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 500, type: 'normal' });
    expect(b.hero!.dead).toBe(true);
    const death = events(w.drainEvents(), 'death')[0];
    expect(death).toMatchObject({ target: b.id, killer: a.id, kind: 'hero', role: 'rebel' });
    expect(a.hero!.stats.kills).toBe(1);
  });

  it('zone damage ignores armor, shields and dodge', () => {
    const { w, b } = duel();
    b.hero!.armor = 'baiyin';
    w.addShield(b.id, 100, 10);
    b.hero!.dodgingUntil = w.time + 10;
    expect(w.dealDamage({ targetId: b.id, amount: 70, type: 'zone' }).dealt).toBe(70);
  });
});

describe('weapons', () => {
  it('hitscan shots hit what the crosshair points at, with headshots', () => {
    const { w, a, b } = duel();
    b.hp = b.maxHp;
    const chest = { x: b.pos.x, y: b.pos.y + 1.1, z: b.pos.z };
    a.hero!.weapons[0] = { id: 'qinggang', mag: 12, reserve: 48 }; // accurate DMR
    w.setInput('p2', aimFrame(w, a, chest, { seq: 1, buttons: BTN_FIRE }));
    w.drainEvents();
    w.step();
    const hits = events(w.drainEvents(), 'hit').filter((h) => h.target === b.id);
    expect(hits.length).toBe(1);
    expect(hits[0].head).toBeFalsy();
    const body = hits[0].amount;
    expect(a.hero!.weapons[0]!.mag).toBe(11);
    // headshot
    const head = { x: b.pos.x, y: b.pos.y + 1.62, z: b.pos.z };
    w.setInput('p2', aimFrame(w, a, head, { seq: 2, buttons: 0 }));
    stepN(w, 20);
    w.setInput('p2', aimFrame(w, a, head, { seq: 3, buttons: BTN_FIRE }));
    w.drainEvents();
    w.step();
    const hh = events(w.drainEvents(), 'hit').filter((h) => h.target === b.id);
    expect(hh.length).toBe(1);
    expect(hh[0].head).toBe(true);
    expect(hh[0].amount).toBeGreaterThan(body * 1.3);
  });

  it('semi-auto weapons need the trigger released; auto weapons keep firing; empty mags reload', () => {
    const { w, a, b } = duel();
    const chest = { x: b.pos.x, y: b.pos.y + 1.1, z: b.pos.z };
    a.hero!.weapons[0] = { id: 'pistol', mag: 12, reserve: 48 };
    let seq = 1;
    for (let i = 0; i < 30; i++) {
      w.setInput('p2', aimFrame(w, a, chest, { seq: seq++, buttons: BTN_FIRE }));
      w.step();
    }
    expect(a.hero!.weapons[0]!.mag).toBe(11); // held: one shot only
    a.hero!.weapons[0] = { id: 'carbine', mag: 3, reserve: 60 };
    for (let i = 0; i < 20; i++) {
      w.setInput('p2', aimFrame(w, a, chest, { seq: seq++, buttons: BTN_FIRE }));
      w.step();
    }
    expect(a.hero!.weapons[0]!.mag + a.hero!.weapons[0]!.reserve).toBe(60); // 3 fired
    // emptied → auto reload
    expect(a.hero!.reloadUntil > w.time || a.hero!.weapons[0]!.mag > 0).toBe(true);
    stepN(w, 90);
    expect(a.hero!.weapons[0]!.mag).toBeGreaterThan(0);
  });

  it('lag compensation rewinds targets to the shooter view tick', () => {
    const { w, a, b } = duel();
    a.hero!.weapons[0] = { id: 'qinggang', mag: 12, reserve: 48 };
    // b stands still for a few ticks at x=0 (history), then teleports 3 m to the side
    stepN(w, 5);
    const viewTick = w.tick;
    const oldChest = { x: b.pos.x, y: b.pos.y + 1.1, z: b.pos.z };
    place(w, b, 3, 20);
    stepN(w, 2);
    w.setInput('p2', aimFrame(w, a, oldChest, { seq: 10, buttons: BTN_FIRE, viewTick }));
    w.drainEvents();
    w.step();
    expect(events(w.drainEvents(), 'hit').some((h) => h.target === b.id)).toBe(true);
    // without lag compensation (viewTick = now) the same shot misses
    place(w, b, 3, 20);
    stepN(w, 20);
    w.setInput('p2', aimFrame(w, a, oldChest, { seq: 11, buttons: 0, viewTick: w.tick }));
    w.step();
    w.setInput('p2', aimFrame(w, a, oldChest, { seq: 12, buttons: BTN_FIRE, viewTick: w.tick }));
    w.drainEvents();
    w.step();
    expect(events(w.drainEvents(), 'hit').some((h) => h.target === b.id)).toBe(false);
  });

  it('grenade launcher projectiles explode and 贯石斧 splash ignores dodge', () => {
    const { w, a, b } = duel();
    a.hero!.weapons[0] = { id: 'guanshi', mag: 6, reserve: 12 };
    b.hero!.dodgingUntil = w.time + 100;
    const feet = { x: b.pos.x, y: b.pos.y + 0.3, z: b.pos.z };
    w.setInput('p2', aimFrame(w, a, feet, { seq: 1, buttons: BTN_FIRE }));
    w.step();
    expect(w.kindList('projectile').length).toBe(1);
    w.setInput('p2', aimFrame(w, a, feet, { seq: 2, buttons: 0 }));
    stepN(w, 45);
    expect(w.kindList('projectile').length).toBe(0);
    expect(b.hp).toBeLessThan(b.maxHp);
  });

  it('青龙 followUp: a dodged round is refunded and the next hit is ×1.5', () => {
    const { w, a, b } = duel();
    a.hero!.weapons[0] = { id: 'qinglong', mag: 30, reserve: 90 };
    b.hero!.dodgingUntil = w.time + 0.2;
    const chest = { x: b.pos.x, y: b.pos.y + 1.1, z: b.pos.z };
    w.setInput('p2', aimFrame(w, a, chest, { seq: 1, buttons: BTN_FIRE }));
    w.drainEvents();
    w.step();
    const first = events(w.drainEvents(), 'hit').filter((h) => h.target === b.id);
    expect(first[0]?.blocked).toBe('dodge');
    expect(a.hero!.weapons[0]!.mag).toBe(30); // refunded
    stepN(w, 20);
    const later = w.drainEvents();
    const dealt = events(later, 'hit').filter((h) => h.target === b.id && !h.blocked);
    expect(dealt.length).toBeGreaterThan(1);
    expect(dealt[0].amount).toBeGreaterThan(dealt[1].amount * 1.3);
  });

  it('World.raycast hits entity capsules and reports headshots', () => {
    const { w, b } = duel();
    const body = w.raycast({ x: 0, y: 1.0, z: 26 }, { x: 0, y: 0, z: -1 }, 50);
    expect(body?.entityId).toBe(b.id);
    expect(body?.head).toBeFalsy();
    expect(body!.dist).toBeCloseTo(6 - b.radius, 2);
    const head = w.raycast({ x: 0, y: 1.62, z: 26 }, { x: 0, y: 0, z: -1 }, 50);
    expect(head?.entityId).toBe(b.id);
    expect(head?.head).toBe(true);
    const miss = w.raycast({ x: 0, y: 1.0, z: 26 }, { x: 0, y: 0, z: -1 }, 50, { ignore: [b.id] });
    expect(miss?.entityId).toBeUndefined();
  });
});
