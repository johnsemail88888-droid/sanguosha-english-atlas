import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, InputFrame } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, BTN_JUMP, BTN_SPRINT, emptyInput } from '../../../src/core/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { AbilityImplEx } from '../../../src/sim/ext';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

const ROLES5 = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'] as const;

function setup(): { w: World; a: Entity; b: Entity } {
  const w = makeWorld([...ROLES5]);
  const a = hero(w, 2);
  const b = hero(w, 3);
  place(w, a, 0, 30);
  place(w, b, 0, 20);
  place(w, hero(w, 0), -50, 50);
  place(w, hero(w, 1), -50, 45);
  place(w, hero(w, 4), -45, 50);
  w.step();
  w.drainEvents();
  return { w, a, b };
}

function inject(w: World, e: Entity, impl: AbilityImplEx, slot: 'passive' | 'q' = 'passive', cooldown?: number): void {
  w.heroRt(e.id)!.abilities.push({
    def: { id: impl.id, slot, nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, cooldown },
    impl,
  });
}

const statusEvents = (evs: GameEvent[]) => evs.filter((e): e is Extract<GameEvent, { t: 'status' }> => e.t === 'status');

let seq = 1;
function send(w: World, player: string, p: Partial<InputFrame>): void {
  w.setInput(player, { ...emptyInput(seq++), ...p });
}

describe('status effects', () => {
  it('re-applying from one source: a dominating application replaces, a dominated one only stacks', () => {
    const { w, a, b } = setup();
    expect(w.applyStatus(b.id, 'slow', 2, { sourceId: a.id, params: { amount: 0.3 } })).toBe(true);
    stepN(w, 15);
    // stronger and longer: replaces (stacks carry over)
    expect(w.applyStatus(b.id, 'slow', 2, { sourceId: a.id, params: { amount: 0.4 } })).toBe(true);
    let inst = b.statuses.filter((s) => s.id === 'slow');
    expect(inst.length).toBe(1);
    expect(inst[0].params?.amount).toBe(0.4);
    expect(inst[0].stacks).toBe(2);
    expect(inst[0].until).toBeCloseTo(w.time + 2, 5);
    // weaker and shorter: absorbed
    expect(w.applyStatus(b.id, 'slow', 1, { sourceId: a.id, params: { amount: 0.1 } })).toBe(true);
    inst = b.statuses.filter((s) => s.id === 'slow');
    expect(inst.length).toBe(1);
    expect(inst[0].stacks).toBe(3);
    const evs = statusEvents(w.drainEvents());
    expect(evs.filter((e) => e.on).length).toBe(1);
    expect(evs.filter((e) => !e.on).length).toBe(0);
    stepN(w, 61);
    expect(w.hasStatus(b.id, 'slow')).toBe(false);
    expect(statusEvents(w.drainEvents()).filter((e) => e.status === 'slow' && !e.on).length).toBe(1);
  });

  it('a short strong slow never inherits the duration of a long weak one (any source)', () => {
    const { w, a, b } = setup();
    const c = hero(w, 4);
    // same source: 1 s 80 % then 10 s 10 %
    w.applyStatus(b.id, 'slow', 1, { sourceId: a.id, params: { amount: 0.8 } });
    w.applyStatus(b.id, 'slow', 10, { sourceId: a.id, params: { amount: 0.1 } });
    expect(b.statuses.filter((s) => s.id === 'slow').length).toBe(2);
    expect(w.statusParam(b.id, 'slow', 'amount', 0)).toBeCloseTo(0.8, 6);
    stepN(w, 31);
    expect(w.statusParam(b.id, 'slow', 'amount', 0)).toBeCloseTo(0.1, 6);
    // different sources: strongest active slow wins, each keeps its own expiry
    w.applyStatus(b.id, 'slow', 1, { sourceId: c.id, params: { amount: 0.5 } });
    expect(w.statusParam(b.id, 'slow', 'amount', 0)).toBeCloseTo(0.5, 6);
    stepN(w, 31);
    expect(w.statusParam(b.id, 'slow', 'amount', 0)).toBeCloseTo(0.1, 6);
    // statusSpeedMul uses the strongest slow only (no multiplicative stacking)
    w.applyStatus(b.id, 'slow', 5, { sourceId: c.id, params: { amount: 0.3 } });
    const z0 = b.pos.z;
    send(w, 'p3', { moveZ: 1 });
    stepN(w, 30);
    expect(z0 - b.pos.z).toBeGreaterThan(5 * 0.7 - 0.4);
    expect(z0 - b.pos.z).toBeLessThan(5 * 0.7 + 0.1);
  });

  it('multiplicative statuses combine across sources, strongest per source', () => {
    const { w, a, b } = setup();
    const c = hero(w, 4);
    w.applyStatus(a.id, 'dmgBoost', 5, { sourceId: a.id, params: { mul: 1.5 } });
    w.applyStatus(a.id, 'dmgBoost', 5, { sourceId: a.id, params: { mul: 1.2 } }); // same source, weaker: dominated
    w.applyStatus(a.id, 'dmgBoost', 5, { sourceId: c.id, params: { mul: 1.2 } });
    expect(w.statusParam(a.id, 'dmgBoost', 'mul', 1)).toBeCloseTo(1.8, 6);
    const r = w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 10, type: 'true', abilityId: 'x' });
    expect(r.dealt).toBeCloseTo(18, 5);
    // dmgTakenDown stacks multiplicatively but never below the floor
    for (const s of [a, c, hero(w, 0)]) w.applyStatus(b.id, 'dmgTakenDown', 5, { sourceId: s.id, params: { mul: 0.5 } });
    expect(w.statusParam(b.id, 'dmgTakenDown', 'mul', 1)).toBeCloseTo(0.2, 6);
    // regen from two sources both tick
    b.hp = 100;
    w.applyStatus(b.id, 'regen', 1, { sourceId: a.id, params: { hps: 10 } });
    w.applyStatus(b.id, 'regen', 1, { sourceId: c.id, params: { hps: 10 } });
    stepN(w, 31);
    expect(b.hp).toBeCloseTo(120, 5);
  });

  it('private reveals are kept per viewer; a public reveal is separate', () => {
    const { w, a, b } = setup();
    const c = hero(w, 4);
    w.applyStatus(b.id, 'reveal', 5, { sourceId: a.id, params: { viewerId: a.id } });
    w.applyStatus(b.id, 'reveal', 5, { sourceId: c.id, params: { viewerId: c.id } });
    let evs = statusEvents(w.drainEvents()).filter((e) => e.status === 'reveal' && e.on);
    expect(evs.map((e) => e.privateTo).sort()).toEqual([a.id, c.id].sort());
    expect(w.canSee(a, b) && w.canSee(c, b)).toBe(true);
    // a public reveal does not merge into a private one
    w.applyStatus(b.id, 'reveal', 3, { sourceId: a.id });
    evs = statusEvents(w.drainEvents()).filter((e) => e.status === 'reveal');
    expect(evs).toEqual([{ t: 'status', target: b.id, status: 'reveal', on: true }]);
    expect(b.statuses.filter((s) => s.id === 'reveal').length).toBe(3);
    // the public one expires first: the private viewers keep theirs
    stepN(w, 91);
    const offs = statusEvents(w.drainEvents()).filter((e) => e.status === 'reveal' && !e.on);
    expect(offs).toEqual([{ t: 'status', target: b.id, status: 'reveal', on: false }]);
    expect(b.statuses.filter((s) => s.id === 'reveal').map((s) => s.params?.viewerId).sort()).toEqual([a.id, c.id].sort());
    // the revealed hero's own HUD never lists someone else's private reveal
    const you = w.snapshotFor('p3').you!;
    expect(you.statuses.some((s) => s.id === 'reveal')).toBe(false);
  });

  it('burn deals fire damage over time, poison true damage, regen heals', () => {
    const { w, a, b } = setup();
    w.applyStatus(b.id, 'burn', 2, { sourceId: a.id, params: { dps: 10 } });
    stepN(w, 61);
    expect(b.maxHp - b.hp).toBeCloseTo(20, 5);
    expect(a.hero!.stats.damage).toBeCloseTo(20, 5);
    b.hp = 100;
    w.applyStatus(b.id, 'regen', 2, { sourceId: b.id, params: { hps: 20 } });
    stepN(w, 61);
    expect(b.hp).toBeCloseTo(140, 5);
    w.applyStatus(b.id, 'poison', 1, { sourceId: a.id, params: { dps: 10 } });
    b.hero!.armor = 'baiyin';
    stepN(w, 31);
    expect(b.hp).toBeCloseTo(130, 5);
  });

  it('无懈可击 (nullify) cancels the next hostile status from an enemy and is consumed', () => {
    const { w, a, b } = setup();
    w.applyStatus(b.id, 'nullify', 20, { sourceId: b.id });
    expect(w.applyStatus(b.id, 'stun', 2, { sourceId: a.id })).toBe(false);
    expect(w.hasStatus(b.id, 'stun')).toBe(false);
    expect(w.hasStatus(b.id, 'nullify')).toBe(false);
    // the nullify notice is private to the two parties
    const hits = w.drainEvents().filter((e) => e.t === 'hit');
    expect(hits.length).toBe(2);
    for (const h of hits) expect(h).toMatchObject({ target: b.id, blocked: 'nullify' });
    expect(hits.map((h) => h.privateTo).sort()).toEqual([a.id, b.id].sort());
    // the rest of that cast (same enemy, same tick) is cancelled too, without another charge
    expect(w.applyStatus(b.id, 'slow', 2, { sourceId: a.id, params: { amount: 0.5 } })).toBe(false);
    w.step();
    expect(w.applyStatus(b.id, 'stun', 2, { sourceId: a.id })).toBe(true);
    // buffs are never cancelled
    w.applyStatus(b.id, 'nullify', 20, { sourceId: b.id });
    expect(w.applyStatus(b.id, 'haste', 2, { sourceId: a.id, params: { amount: 0.3 } })).toBe(true);
    expect(w.hasStatus(b.id, 'nullify')).toBe(true);
  });

  it('canBeAffected vetoes (陆逊 谦逊) block statuses and steals', () => {
    const { w, a, b } = setup();
    inject(w, b, { id: 't_qianxun', canBeAffected: (_ctx, st) => !(st === 'stun' || st === 'steal') });
    expect(w.applyStatus(b.id, 'stun', 2, { sourceId: a.id })).toBe(false);
    expect(w.applyStatus(b.id, 'slow', 2, { sourceId: a.id, params: { amount: 0.3 } })).toBe(true);
    b.hero!.items[1] = { id: 'shan', count: 1 };
    expect(w.stealItem(a.id, b.id)).toBeNull();
    expect(w.takeRandomItem(b.id)).toBeNull();
    expect(b.hero!.items[1]).not.toBeNull();
  });

  it('stun stops movement and actions; root stops movement only; freeze prevents sprint/jump', () => {
    const { w, a } = setup();
    w.applyStatus(a.id, 'stun', 1, { sourceId: a.id });
    const z0 = a.pos.z;
    send(w, 'p2', { moveZ: 1, actions: [{ a: 'dodge' }] });
    stepN(w, 10);
    expect(a.pos.z).toBeCloseTo(z0, 5);
    expect(a.hero!.dodgeCharges).toBe(2);
    stepN(w, 25);
    w.applyStatus(a.id, 'root', 1, { sourceId: a.id });
    const zr = a.pos.z;
    send(w, 'p2', { moveZ: 1 });
    stepN(w, 10);
    expect(a.pos.z).toBeCloseTo(zr, 5);
    stepN(w, 25);
    w.applyStatus(a.id, 'freeze', 2, { sourceId: a.id });
    send(w, 'p2', { moveZ: 1, buttons: BTN_SPRINT | BTN_JUMP });
    const zStart = a.pos.z;
    stepN(w, 30);
    expect(a.hero!.sprinting).toBe(false);
    expect(zStart - a.pos.z).toBeLessThan(5 * 0.4 + 0.1);
    expect(a.pos.y).toBeCloseTo(0, 5);
  });

  it('haste speeds you up; slow and dance slow you down', () => {
    const { w, a } = setup();
    w.applyStatus(a.id, 'haste', 5, { sourceId: a.id, params: { amount: 0.5 } });
    send(w, 'p2', { moveZ: 1 });
    const z0 = a.pos.z;
    stepN(w, 30);
    expect(z0 - a.pos.z).toBeGreaterThan(5 * 1.3);
    w.removeStatus(a.id, 'haste');
    w.applyStatus(a.id, 'dance', 5, { sourceId: a.id });
    const z1 = a.pos.z;
    stepN(w, 30);
    expect(z1 - a.pos.z).toBeLessThan(5 * 0.55);
  });

  it('silence blocks abilities and items; disarm and dance block shooting', () => {
    const { w, a, b } = setup();
    let fired = 0;
    inject(w, a, { id: 't_q', activate: () => (++fired, true) }, 'q', 1);
    a.hero!.items[0] = { id: 'shan', count: 1 };
    a.hero!.dodgeCharges = 1;
    w.applyStatus(a.id, 'silence', 1, { sourceId: b.id });
    send(w, 'p2', { actions: [{ a: 'ability', slot: 'q' }, { a: 'item', slot: 0 }] });
    stepN(w, 2);
    expect(fired).toBe(0);
    expect(a.hero!.items[0]).not.toBeNull();
    stepN(w, 35);
    send(w, 'p2', { actions: [{ a: 'ability', slot: 'q' }, { a: 'item', slot: 0 }] });
    stepN(w, 2);
    expect(fired).toBe(1);
    expect(a.hero!.dodgeCharges).toBe(2);
    // disarm: no shots
    const mag = a.hero!.weapons[0]!.mag;
    w.applyStatus(a.id, 'disarm', 1, { sourceId: b.id });
    const chest = { x: b.pos.x, y: 1.1, z: b.pos.z };
    const ang = aimAnglesFor(a.pos, chest);
    send(w, 'p2', { yaw: ang.yaw, pitch: ang.pitch, aimPoint: chest, buttons: BTN_FIRE | BTN_ADS });
    stepN(w, 10);
    expect(a.hero!.weapons[0]!.mag).toBe(mag);
    w.removeStatus(a.id, 'disarm');
    w.applyStatus(a.id, 'dance', 1, { sourceId: b.id });
    stepN(w, 10);
    expect(a.hero!.weapons[0]!.mag).toBe(mag);
    w.removeStatus(a.id, 'dance');
    stepN(w, 3);
    expect(a.hero!.weapons[0]!.mag).toBeLessThan(mag);
  });

  it('charm drags your aim onto the charm target and auto-fires', () => {
    const { w, a, b } = setup();
    const mag = a.hero!.weapons[0]!.mag;
    w.applyStatus(a.id, 'charm', 1, { sourceId: hero(w, 4).id, params: { targetId: b.id } });
    send(w, 'p2', { yaw: Math.PI, pitch: 0.5, buttons: 0 });
    stepN(w, 30);
    expect(a.hero!.weapons[0]!.mag).toBeLessThan(mag);
    expect(Math.abs(a.yaw)).toBeLessThan(0.2); // turned toward b (-z)
    expect(b.hp).toBeLessThan(b.maxHp);
  });

  it('stealth breaks when firing unless params.keep', () => {
    const { w, a, b } = setup();
    w.applyStatus(a.id, 'stealth', 10, { sourceId: a.id });
    const chest = { x: b.pos.x, y: 1.1, z: b.pos.z };
    const ang = aimAnglesFor(a.pos, chest);
    send(w, 'p2', { yaw: ang.yaw, pitch: ang.pitch, aimPoint: chest, buttons: BTN_FIRE | BTN_ADS });
    stepN(w, 2);
    expect(w.hasStatus(a.id, 'stealth')).toBe(false);
    send(w, 'p2', { yaw: ang.yaw, pitch: ang.pitch, buttons: 0 });
    stepN(w, 20);
    w.applyStatus(a.id, 'stealth', 10, { sourceId: a.id, params: { keep: 1 } });
    send(w, 'p2', { yaw: ang.yaw, pitch: ang.pitch, aimPoint: chest, buttons: BTN_FIRE | BTN_ADS });
    stepN(w, 2);
    expect(w.hasStatus(a.id, 'stealth')).toBe(true);
  });

  it('untargetable units are ignored by bullets', () => {
    const { w, b } = setup();
    w.applyStatus(b.id, 'untargetable', 3, { sourceId: b.id });
    const hit = w.raycast({ x: 0, y: 1, z: 26 }, { x: 0, y: 0, z: -1 }, 20);
    expect(hit?.entityId).toBeUndefined();
  });

  it('cleanse removes every debuff but keeps buffs', () => {
    const { w, a, b } = setup();
    w.applyStatus(b.id, 'slow', 5, { sourceId: a.id, params: { amount: 0.3 } });
    w.applyStatus(b.id, 'burn', 5, { sourceId: a.id, params: { dps: 5 } });
    w.applyStatus(b.id, 'haste', 5, { sourceId: b.id, params: { amount: 0.3 } });
    w.cleanse(b.id);
    expect(w.hasStatus(b.id, 'slow')).toBe(false);
    expect(w.hasStatus(b.id, 'burn')).toBe(false);
    expect(w.hasStatus(b.id, 'haste')).toBe(true);
  });

  it('marking puts a marked status on the crosshair target (not blocked by nullify)', () => {
    const { w, a, b } = setup();
    w.applyStatus(b.id, 'nullify', 20, { sourceId: b.id });
    const chest = { x: b.pos.x, y: 1.1, z: b.pos.z };
    const ang = aimAnglesFor(a.pos, chest);
    send(w, 'p2', { yaw: ang.yaw, pitch: ang.pitch, aimPoint: chest, aimTargetId: b.id, actions: [{ a: 'mark' }] });
    w.step();
    const m = b.statuses.find((s) => s.id === 'marked');
    expect(m?.sourceId).toBe(a.id);
    expect(w.hasStatus(b.id, 'nullify')).toBe(true);
  });
});
