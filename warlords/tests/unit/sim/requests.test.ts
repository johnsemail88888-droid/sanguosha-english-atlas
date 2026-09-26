// Engine features added for docs/SIM_REQUESTS.md (wave 2): one block per request id.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, RoleId } from '../../../src/core/types';
import { BTN_INTERACT, BTN_SPRINT, emptyInput } from '../../../src/core/types';
import { circleAttack } from '../../../src/sim/abilities/common';
import { registerProjectileKind } from '../../../src/sim/combat';
import type { AbilityCast, AbilityImplEx } from '../../../src/sim/ext';
import { registerHazardKind } from '../../../src/sim/hazards';
import type { TroopBrain } from '../../../src/sim/ai/types';
import { BOOM_CLEAR, COMMANDER_CLEARANCE, FORMATION_MIN_DIST, boomDistance, followOffset, followSlot } from '../../../src/sim/troops';
import type { World } from '../../../src/sim/world';
import { hero, makeTestMap, makeWorld, place, stepN } from './helpers';

const ROLES5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

/** Five heroes spread on open ground (x = −20…20, z = 30), one step for history. */
function world(opts: Parameters<typeof makeWorld>[1] = {}): World {
  const w = makeWorld(ROLES5, opts);
  ROLES5.forEach((_, i) => place(w, hero(w, i), i * 10 - 20, 30));
  w.step();
  w.drainEvents();
  return w;
}

function inject(w: World, e: Entity, impl: AbilityImplEx, slot: 'passive' | 'q' | 'e' = 'passive'): void {
  w.heroRt(e.id)!.abilities.push({
    def: { id: impl.id, slot, nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, cooldown: slot === 'passive' ? undefined : 1 },
    impl,
  });
}

const ofType = <T extends GameEvent['t']>(evs: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] =>
  evs.filter((e): e is Extract<GameEvent, { t: T }> => e.t === t);

function press(w: World, seat: number, slot: 'q' | 'e'): GameEvent[] {
  w.setInput(`p${seat}`, { ...emptyInput(w.tick + 1), actions: [{ a: 'ability', slot }] });
  w.step();
  return w.drainEvents();
}

describe('SHU-3 / QUN-1 / WU-1 / WEI-3: ctx.cast overrides the ability event', () => {
  it('pos / target / dir written by activate() are copied verbatim', () => {
    const w = world();
    const e = hero(w, 2);
    const other = hero(w, 3);
    inject(
      w,
      e,
      {
        id: 't_cast',
        activate(ctx) {
          (ctx as typeof ctx & { cast?: AbilityCast }).cast = { pos: { x: 99, y: 1, z: -99 }, target: other.id, dir: { x: 0, y: 1, z: 0 } };
          return true;
        },
      },
      'q',
    );
    const ev = ofType(press(w, 2, 'q'), 'ability')[0];
    expect(ev.pos).toEqual({ x: 99, y: 1, z: -99 });
    expect(ev.target).toBe(other.id);
    expect(ev.dir).toEqual({ x: 0, y: 1, z: 0 });
    expect(ev.privateTo).toBeUndefined();
  });

  it('without an override the crosshair defaults remain; WU-2: a stealthed caster casts privately', () => {
    const w = world();
    const e = hero(w, 2);
    inject(w, e, { id: 't_plain', activate: () => true }, 'q');
    const pub = ofType(press(w, 2, 'q'), 'ability')[0];
    expect(pub.pos).toBeDefined();
    expect(pub.dir).toBeDefined();
    expect(pub.privateTo).toBeUndefined();
    stepN(w, 40); // cooldown 1 s
    w.applyStatus(e.id, 'stealth', 10, { sourceId: e.id, params: { keep: 1 } });
    w.drainEvents();
    const priv = ofType(press(w, 2, 'q'), 'ability')[0];
    expect(priv.privateTo).toBe(e.id);
  });
});

describe('SHU-2: piercing projectiles', () => {
  it('hit every unit in the line exactly once', () => {
    const w = world();
    const a = hero(w, 2);
    const b = hero(w, 3);
    const c = hero(w, 4);
    place(w, a, 0, 30);
    place(w, b, 0, 25);
    place(w, c, 0, 20);
    w.step();
    w.spawnProjectile({ kind: 'arrow', ownerId: a.id, pos: { x: 0, y: 1.2, z: 29 }, vel: { x: 0, y: 0, z: -160 }, damage: 100, dtype: 'pierce', pierce: 3, abilityId: 't' });
    stepN(w, 5);
    expect(b.maxHp - b.hp).toBe(100);
    expect(c.maxHp - c.hp).toBe(100);
  });
});

describe('QUN-2: shieldPierce comes from the hero’s own hits only', () => {
  it('his bullets ignore half the shield, his soldiers’ do not', () => {
    const w = world();
    const lb = hero(w, 2);
    const foe = hero(w, 3);
    inject(w, lb, { id: 't_wushuang', modifiers: () => ({ shieldPierce: 0.5 }) });
    w.step();
    w.addShield(foe.id, 200, 10);
    const r1 = w.dealDamage({ targetId: foe.id, sourceId: lb.id, amount: 100, type: 'normal', weaponId: 'pistol' });
    expect(r1.absorbed).toBeCloseTo(50, 6);
    expect(r1.dealt).toBeCloseTo(50, 6);
    const [soldier] = w.spawnTroops(lb.id, 'shu_rifleman', 1);
    const r2 = w.dealDamage({ targetId: foe.id, sourceId: soldier.id, amount: 60, type: 'normal', weaponId: 'troop_rifle' });
    expect(r2.dealt).toBe(0);
    expect(r2.absorbed).toBeCloseTo(60, 6);
  });
});

describe('QUN-7: 铁索连环 spreads an area strike once per chained unit', () => {
  it('three chained heroes in one thunder blast each take it once', () => {
    const w = world();
    const caster = hero(w, 2);
    const chained = [hero(w, 1), hero(w, 3), hero(w, 4)];
    chained.forEach((h, i) => place(w, h, i * 1.5 - 1.5, 20));
    w.step();
    for (const h of chained) w.applyStatus(h.id, 'chained', 8, { sourceId: caster.id });
    circleAttack(w, caster, { x: 0, y: 0, z: 20 }, 5, { damage: 60, dtype: 'thunder', abilityId: 't_bolt' });
    for (const h of chained) expect(h.maxHp - h.hp).toBe(60);
    // a separate strike next tick spreads again
    w.step();
    circleAttack(w, caster, { x: 0, y: 0, z: 20 }, 5, { damage: 60, dtype: 'thunder', abilityId: 't_bolt' });
    for (const h of chained) expect(h.maxHp - h.hp).toBe(120);
  });

  it('repeated direct hits of one strike on a chained unit all land; the chain passes each on once', () => {
    const w = world();
    const caster = hero(w, 2);
    const [a, b, c] = [hero(w, 1), hero(w, 3), hero(w, 4)];
    for (const h of [a, b]) w.applyStatus(h.id, 'chained', 8, { sourceId: caster.id });
    // two projectiles of one cast land in the same tick: on chained A, and on unchained C
    for (const target of [a, a, c, c]) w.dealDamage({ targetId: target.id, sourceId: caster.id, amount: 30, type: 'fire', abilityId: 't_volley' });
    expect(a.maxHp - a.hp).toBe(60);
    expect(c.maxHp - c.hp).toBe(60);
    expect(b.maxHp - b.hp).toBe(30);
    // B was reached through the chain: the same strike hitting B directly this tick is skipped
    w.dealDamage({ targetId: b.id, sourceId: caster.id, amount: 30, type: 'fire', abilityId: 't_volley' });
    expect(b.maxHp - b.hp).toBe(30);
    // next tick it is a new strike
    w.step();
    w.dealDamage({ targetId: b.id, sourceId: caster.id, amount: 30, type: 'fire', abilityId: 't_volley' });
    expect(b.maxHp - b.hp).toBe(60);
    expect(a.maxHp - a.hp).toBe(90);
  });

  it('a single hit on one chained unit still reaches every other chained unit', () => {
    const w = world();
    const caster = hero(w, 2);
    const [a, b] = [hero(w, 1), hero(w, 3)];
    for (const h of [a, b]) w.applyStatus(h.id, 'chained', 8, { sourceId: caster.id });
    w.dealDamage({ targetId: a.id, sourceId: caster.id, amount: 40, type: 'fire', abilityId: 't_fire' });
    expect(a.maxHp - a.hp).toBe(40);
    expect(b.maxHp - b.hp).toBe(40);
  });
});

describe('WEI-1 / WEI-8 / ITEMS-8: final amounts and uncancellable hits', () => {
  it('a redirected hit skips the attacker’s outgoing multipliers and 无懈可击', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    w.applyStatus(a.id, 'dmgBoost', 10, { sourceId: a.id, params: { mul: 2 } });
    w.applyStatus(t.id, 'nullify', 20, { sourceId: t.id });
    const r = w.dealDamage({ targetId: t.id, sourceId: a.id, amount: 50, type: 'normal', abilityId: 't', redirected: true });
    expect(r.dealt).toBe(50);
    expect(w.hasStatus(t.id, 'nullify')).toBe(true);
  });

  it('thorns return what came in, untouched by the reflector’s dmgBoost', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    w.applyStatus(t.id, 'thorns', 10, { sourceId: t.id, params: { frac: 0.3 } });
    w.applyStatus(t.id, 'dmgBoost', 10, { sourceId: t.id, params: { mul: 1.3 } });
    w.dealDamage({ targetId: t.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' });
    expect(a.maxHp - a.hp).toBeCloseTo(30, 6);
  });

  it('noNullify hits are never cancelled (决斗 penalty)', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    w.applyStatus(t.id, 'nullify', 20, { sourceId: t.id });
    const r = w.dealDamage({ targetId: t.id, sourceId: a.id, amount: 80, type: 'normal', abilityId: 'juedou', noNullify: true });
    expect(r.dealt).toBe(80);
    expect(w.hasStatus(t.id, 'nullify')).toBe(true);
    // the same hit without the flag is cancelled
    expect(w.dealDamage({ targetId: t.id, sourceId: a.id, amount: 80, type: 'normal', abilityId: 'juedou' }).blocked).toBe('nullify');
  });
});

describe('WU-10: redirectDamage', () => {
  it('hands the post-outgoing amount to the new victim once; the shooter sees "redirect"', () => {
    const w = world();
    const a = hero(w, 2);
    const dq = hero(w, 3);
    const other = hero(w, 4);
    w.applyStatus(a.id, 'dmgBoost', 10, { sourceId: a.id, params: { mul: 1.5 } });
    inject(w, dq, {
      id: 't_liuli',
      modifyIncoming(ctx) {
        (ctx.sim as World).redirectDamage(ctx.req, other.id);
        return 0;
      },
    });
    w.drainEvents();
    const r = w.dealDamage({ targetId: dq.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' });
    expect(r.blocked).toBe('redirect');
    expect(dq.hp).toBe(dq.maxHp);
    expect(other.maxHp - other.hp).toBeCloseTo(150, 6);
    const hits = ofType(w.drainEvents(), 'hit');
    expect(hits.find((h) => h.target === dq.id)?.blocked).toBe('redirect');
    expect(other.lastDamagedBy).toBe(a.id);
  });
});

describe('WEI-2: fireHitscan with the held weapon applies its on-hit special', () => {
  it('a 寒冰 round slows its target', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    place(w, a, 0, 30);
    place(w, t, 0, 20);
    w.step();
    const eye = w.eyePos(a);
    const c = w.centerOf(t);
    w.fireHitscan(a.id, eye, { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z }, { damage: 10, range: 50, dtype: 'normal', weaponId: 'hanbing', canDodge: false });
    expect(w.hasStatus(t.id, 'slow')).toBe(true);
    // opt-out
    const t2 = hero(w, 4);
    place(w, t2, 5, 20);
    w.step();
    const c2 = w.centerOf(t2);
    w.fireHitscan(a.id, eye, { x: c2.x - eye.x, y: c2.y - eye.y, z: c2.z - eye.z }, { damage: 10, range: 50, dtype: 'normal', weaponId: 'hanbing', canDodge: false, weaponSpecials: false });
    expect(w.hasStatus(t2.id, 'slow')).toBe(false);
  });
});

describe('WU-7: projectile kinds get one detonation callback', () => {
  const calls: { kind: string; x: number; hitId?: number }[] = [];
  registerProjectileKind({
    kind: 't_boom',
    onDetonate(_sim, p, at, hitId) {
      calls.push({ kind: p.proj!.kind, x: at.x, hitId });
    },
  });

  it('on a wall, on a unit and on expiry', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    place(w, a, 0, 0);
    place(w, t, 0, -8);
    w.step();
    calls.length = 0;
    // wall at x = 9.5 … 10.5 (test map)
    w.spawnProjectile({ kind: 't_boom', ownerId: a.id, pos: { x: 2, y: 1, z: 0 }, vel: { x: 30, y: 0, z: 0 }, damage: 0, dtype: 'fire' });
    stepN(w, 15);
    expect(calls.length).toBe(1);
    expect(calls[0].x).toBeCloseTo(9.5, 1);
    expect(calls[0].hitId).toBeUndefined();
    // a unit
    w.spawnProjectile({ kind: 't_boom', ownerId: a.id, pos: { x: 0, y: 1, z: -2 }, vel: { x: 0, y: 0, z: -30 }, damage: 5, dtype: 'fire' });
    stepN(w, 15);
    expect(calls.length).toBe(2);
    expect(calls[1].hitId).toBe(t.id);
    // expiry in the open
    w.spawnProjectile({ kind: 't_boom', ownerId: a.id, pos: { x: -2, y: 1, z: 5 }, vel: { x: -1, y: 0, z: 0 }, damage: 0, dtype: 'fire', lifetime: 0.2 });
    stepN(w, 15);
    expect(calls.length).toBe(3);
  });
});

describe('WU-8 / ITEMS-6 / AI-3: hazards', () => {
  it('fields of one cast sharing params.group do not stack', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    place(w, t, 0, 20);
    w.step();
    for (const x of [-1, 1]) {
      w.spawnHazard({ kind: 'fire', ownerId: a.id, pos: { x, y: 0, z: 20 }, radius: 2.5, duration: 0.4, tickEvery: 1, params: { damage: 10, group: 7 }, dtype: 'fire' });
    }
    stepN(w, 3);
    expect(t.maxHp - t.hp).toBe(10);
    // without a group both burn
    for (const x of [-1, 1]) {
      w.spawnHazard({ kind: 'fire', ownerId: a.id, pos: { x, y: 0, z: 20 }, radius: 2.5, duration: 0.4, tickEvery: 1, params: { damage: 10 }, dtype: 'fire' });
    }
    stepN(w, 3);
    expect(t.maxHp - t.hp).toBe(30);
  });

  it('a field burns only its own floor (roof slab at (−20, −20), top 2.9 m)', () => {
    const w = world();
    const a = hero(w, 2);
    const below = hero(w, 3);
    const above = hero(w, 4);
    place(w, below, -20, -20);
    below.pos.y = 0; // place() puts it on the slab: stand under it instead
    above.pos.x = -19;
    above.pos.z = -19;
    above.pos.y = 2.9;
    w.markGridDirty();
    w.step();
    // on the slab
    w.spawnHazard({ kind: 'fire', ownerId: a.id, pos: { x: -20, y: 2.9, z: -20 }, radius: 3, duration: 0.3, tickEvery: 1, params: { damage: 10 }, dtype: 'fire' });
    w.step();
    expect(below.hp).toBe(below.maxHp);
    expect(above.maxHp - above.hp).toBe(10);
  });

  it('a field on a roof does not reach the street beside the building', () => {
    const w = world();
    const a = hero(w, 2);
    const street = hero(w, 3);
    const roof = hero(w, 4);
    place(w, street, -16.3, -20); // on the ground, 0.7 m past the slab's edge (x = −17)
    roof.pos.x = -19;
    roof.pos.z = -21;
    roof.pos.y = 2.9;
    w.markGridDirty();
    w.step();
    w.spawnHazard({ kind: 'fire', ownerId: a.id, pos: { x: -20, y: 2.9, z: -20 }, radius: 5, duration: 0.3, tickEvery: 1, params: { damage: 10 }, dtype: 'fire' });
    w.step();
    expect(street.hp).toBe(street.maxHp);
    expect(roof.maxHp - roof.hp).toBe(10);
    // the same field on the ground beside the building reaches the street, not the roof
    w.spawnHazard({ kind: 'fire', ownerId: a.id, pos: { x: -15, y: 0, z: -20 }, radius: 5, duration: 0.3, tickEvery: 1, params: { damage: 10 }, dtype: 'fire' });
    w.step();
    expect(street.maxHp - street.hp).toBe(10);
    expect(roof.maxHp - roof.hp).toBe(10);
  });

  it('discrete custom kinds consume 无懈可击, periodic ones do not; custom ticks get the dtype', () => {
    const w = world();
    const a = hero(w, 2);
    const t = hero(w, 3);
    place(w, t, 0, 20);
    w.step();
    const seen: string[] = [];
    registerHazardKind({
      kind: 't_trap',
      discrete: true,
      harmful: true,
      tick(sim, hz, affected, rt) {
        seen.push(rt.dtype);
        for (const u of affected) if (u.id !== hz.ownerId) sim.applyStatus(u.id, 'root', 1, { sourceId: hz.ownerId });
        return true;
      },
    });
    registerHazardKind({
      kind: 't_field',
      tick(sim, hz, affected) {
        for (const u of affected) if (u.id !== hz.ownerId) sim.applyStatus(u.id, 'slow', 1, { sourceId: hz.ownerId, params: { amount: 0.3 } });
        return true;
      },
    });
    w.applyStatus(t.id, 'nullify', 30, { sourceId: t.id });
    const trap = w.spawnHazard({ kind: 't_trap', ownerId: a.id, pos: { x: 0, y: 0, z: 20 }, radius: 2, duration: 0.2, tickEvery: 1, params: {}, dtype: 'thunder' });
    expect(trap.hazard!.harmful).toBe(true);
    w.step();
    expect(seen).toEqual(['thunder']);
    expect(w.hasStatus(t.id, 'root')).toBe(false);
    expect(w.hasStatus(t.id, 'nullify')).toBe(false);
    w.applyStatus(t.id, 'nullify', 30, { sourceId: t.id });
    w.spawnHazard({ kind: 't_field', ownerId: a.id, pos: { x: 0, y: 0, z: 20 }, radius: 2, duration: 0.2, tickEvery: 1, params: {} });
    w.step();
    expect(w.hasStatus(t.id, 'slow')).toBe(true);
    expect(w.hasStatus(t.id, 'nullify')).toBe(true);
    // harmful flag for brains
    const heal = w.spawnHazard({ kind: 'healZone', ownerId: a.id, pos: { x: 30, y: 0, z: 0 }, radius: 3, duration: 1, tickEvery: 0.5, params: { heal: 5 } });
    const fire = w.spawnHazard({ kind: 'fire', ownerId: a.id, pos: { x: 30, y: 0, z: 10 }, radius: 3, duration: 1, tickEvery: 0.5, params: { damage: 5 } });
    const gas = w.spawnHazard({ kind: 'gas', ownerId: a.id, pos: { x: 30, y: 0, z: 20 }, radius: 3, duration: 1, tickEvery: 0.5, params: {}, status: { id: 'stun', duration: 1 } });
    expect(heal.hazard!.harmful).toBeUndefined();
    expect(fire.hazard!.harmful).toBe(true);
    expect(gas.hazard!.harmful).toBe(true);
  });

  it('ITEMS-4: hidden hazards are sent to enemies within 6 m only', () => {
    const w = world();
    const owner = hero(w, 2);
    const viewer = hero(w, 3);
    place(w, viewer, 0, 20);
    const trap = w.spawnHazard({ kind: 'trapDance', ownerId: owner.id, pos: { x: 7, y: 0, z: 20 }, radius: 1.5, duration: 30, tickEvery: 0.2, params: {}, triggerOnce: true });
    trap.statuses.push({ id: 'stealth', until: Infinity, stacks: 1, params: { keep: 1 } });
    w.step();
    expect(w.snapshotFor('p3').ents.some((v) => v.id === trap.id)).toBe(false);
    place(w, viewer, 1.5, 20);
    w.step();
    expect(w.snapshotFor('p3').ents.some((v) => v.id === trap.id)).toBe(true);
    // its owner always sees it
    expect(w.snapshotFor('p2').ents.some((v) => v.id === trap.id)).toBe(true);
  });
});

describe('SimExt queries and state helpers', () => {
  it('ITEMS-2 / WU-6 squadCap is the spawn rule', () => {
    const w = makeWorld(['lord', 'double', 'rebel', 'rebel', 'traitor'], { squads: true });
    for (let i = 0; i < 5; i++) {
      const h = hero(w, i);
      expect(w.squadCap(h.id)).toBe(h.hero!.squad.length);
    }
    expect(w.squadCap(hero(w, 0).id)).toBe(w.settings.troopsPerHero + 2);
    expect(w.squadCap(hero(w, 1).id)).toBe(w.settings.troopsPerHero + 2);
    expect(w.squadCap(hero(w, 2).id)).toBe(w.settings.troopsPerHero);
  });

  it('WEI-5 maxDodgeCharges / WEI-6 endDash', () => {
    const w = world();
    const e = hero(w, 2);
    expect(w.maxDodgeCharges(e.id)).toBe(2);
    inject(w, e, { id: 't_longdan', modifiers: () => ({ extraDodgeCharges: 1 }) });
    w.step();
    expect(w.maxDodgeCharges(e.id)).toBe(3);
    w.dash(e.id, { x: 1, y: 0, z: 0 }, 10, 0.4);
    w.step();
    w.endDash(e.id);
    expect(e.forced).toBeUndefined();
    expect(Math.hypot(e.vel.x, e.vel.z)).toBeLessThanOrEqual(5 + 1e-9);
    // a knockback is not a dash
    w.knockback(e.id, { x: 1, y: 0, z: 0 }, 5);
    w.endDash(e.id);
    expect(e.forced).toBeDefined();
  });

  it('ITEMS-5 / WU-3 remove one source’s / one kind of instance', () => {
    const w = world();
    const t = hero(w, 3);
    const [a, b] = [hero(w, 1), hero(w, 2)];
    w.applyStatus(t.id, 'slow', 5, { sourceId: a.id, params: { amount: 0.2 } });
    w.applyStatus(t.id, 'slow', 5, { sourceId: b.id, params: { amount: 0.4 } });
    w.removeStatusFrom(t.id, 'slow', b.id);
    expect(t.statuses.filter((s) => s.id === 'slow').map((s) => s.sourceId)).toEqual([a.id]);
    w.applyStatus(t.id, 'stealth', 5, { params: { keji: 1 } });
    w.applyStatus(t.id, 'stealth', 5, { sourceId: t.id, params: { keep: 1 } });
    w.removeStatusWhere(t.id, 'stealth', (s) => (s.params?.keji ?? 0) > 0);
    expect(t.statuses.filter((s) => s.id === 'stealth').length).toBe(1);
    expect(w.hasStatus(t.id, 'stealth')).toBe(true);
  });

  it('SHU-4 dropAggro clears the target and holds acquisition', () => {
    const w = world();
    const npc = w.spawnNpc('yellowTurban', { x: 0, y: 0, z: 20 });
    npc.npc!.targetId = hero(w, 2).id;
    w.dropAggro(npc.id, 3);
    expect(npc.npc!.targetId).toBeUndefined();
    expect(npc.npc!.ai.aggroHoldUntil).toBeCloseTo(w.time + 3, 9);
  });

  it('WU-4 / ITEMS-9: gated strips with a drop spot and a pickup lock', () => {
    const w = world();
    const thief = hero(w, 2);
    const t = hero(w, 3);
    t.hero!.mount = 'chitu';
    w.applyStatus(t.id, 'nullify', 20, { sourceId: t.id });
    expect(w.dismount(t.id, { sourceId: thief.id })).toBe(false);
    expect(t.hero!.mount).toBe('chitu');
    expect(w.hasStatus(t.id, 'nullify')).toBe(false);
    w.step(); // the rest of this tick's burst from the same enemy would be cancelled too (echo)
    const at = { x: t.pos.x + 2.5, y: t.pos.y, z: t.pos.z };
    expect(w.dismount(t.id, { sourceId: thief.id, at, lock: 5 })).toBe(true);
    expect(t.hero!.mount).toBeNull();
    const loot = w.kindList('loot').find((l) => l.loot?.itemId === 'chitu')!;
    expect(Math.hypot(loot.pos.x - at.x, loot.pos.z - at.z)).toBeLessThan(1e-6);
    expect(w.lootLocks.get(loot.id)?.heroId).toBe(t.id);
    // weapon specials (no sourceId) are never gated
    t.hero!.mount = 'dilu';
    w.applyStatus(t.id, 'nullify', 20, { sourceId: t.id });
    expect(w.dismount(t.id)).toBe(true);
    expect(w.hasStatus(t.id, 'nullify')).toBe(true);
  });

  it('AI-1 / AI-2: public event tap and match info', () => {
    const w = world();
    const start = w.publicEventsSince(0).seq;
    w.emit({ t: 'quickchat', who: hero(w, 1).id, id: 'focus' });
    w.emit({ t: 'sfx', name: 'secret', privateTo: hero(w, 2).id });
    w.emit({ t: 'claim', who: hero(w, 3).id, role: 'loyalist' });
    const r = w.publicEventsSince(start);
    expect(r.events.map((e) => e.t)).toEqual(['quickchat', 'claim']);
    expect(w.publicEventsSince(r.seq).events).toEqual([]);
    expect(w.matchInfo()).toEqual({ playerCount: 5, mode: 'standard' });
  });

  it('AI-1: a bounty reward never reaches the public event tap (it reveals the 赏金猎人)', () => {
    const w = makeWorld(['lord', 'loyalist', 'rebel', 'bounty', 'traitor']);
    ROLES5.forEach((_, i) => place(w, hero(w, i), i * 10 - 20, 30));
    w.step();
    const hunter = hero(w, 3);
    const target = w.get(hunter.hero!.bountyTargetId)!;
    const start = w.publicEventsSince(0).seq;
    w.dealDamage({ targetId: target.id, sourceId: hunter.id, amount: 5000, type: 'true' });
    if (!target.hero!.dead) w.dealDamage({ targetId: target.id, sourceId: hunter.id, amount: 5000, type: 'true' });
    expect(target.hero!.dead).toBe(true);
    const all = ofType(w.drainEvents(), 'reward').filter((r) => r.kind === 'bounty');
    expect(all.length).toBe(1);
    expect(all[0].privateTo).toBe(hunter.id);
    expect(w.publicEventsSince(start).events.some((e) => e.t === 'reward' && e.kind === 'bounty')).toBe(false);
    // an emitter that forgets privateTo is covered too
    w.emit({ t: 'reward', who: hunter.id, kind: 'bounty', items: [] });
    expect(w.publicEventsSince(start).events.some((e) => e.t === 'reward' && e.kind === 'bounty')).toBe(false);
  });

  it('a knockback on a troop that already moved this tick (troop / NPC phase) travels its full force', () => {
    const F = 5;
    let trigger = -1;
    let pushes: Entity[] = [];
    // the last soldier of the squad shoves the first (which already moved this tick); an NPC shoves the second
    const troopBrain: TroopBrain = {
      think(sim, self, _dt, out) {
        const sq = sim.get(self.troop!.commanderId)!.hero!.squad;
        if (sim.tick === trigger && self.id === sq[sq.length - 1]) sim.knockback(sq[0], { x: 1, y: 0, z: 0 }, F);
        return out;
      },
    };
    const npcBrain: TroopBrain = {
      think(sim, _self, _dt, out) {
        if (sim.tick === trigger) sim.knockback(pushes[1].id, { x: 1, y: 0, z: 0 }, F);
        return out;
      },
    };
    const w = makeWorld(ROLES5, { squads: true, troopBrain, npcBrain });
    const cmd = hero(w, 2);
    ROLES5.forEach((_, i) => place(w, hero(w, i), i * 12 - 10, -45));
    pushes = cmd.hero!.squad.slice(0, 2).map((id) => w.get(id)!);
    pushes.forEach((t, k) => place(w, t, -20, 20 + k * 6));
    cmd.hero!.squad.slice(2).forEach((id, k) => place(w, w.get(id)!, 20 + k * 2, 20));
    w.spawnNpc('yellowTurban', { x: 30, y: 0, z: 40 });
    w.markGridDirty();
    w.step();
    const x0 = pushes.map((t) => t.pos.x);
    trigger = w.tick + 1;
    stepN(w, 45);
    for (let k = 0; k < 2; k++) {
      const moved = pushes[k].pos.x - x0[k];
      expect(moved, `soldier ${k}`).toBeGreaterThan(F - 1e-6);
      expect(moved, `soldier ${k}`).toBeLessThan(F + 0.5);
    }
  });
});

describe('QUN-6 / ITEMS-3 / ITEMS-7: revives and item use', () => {
  it('a ready free revive is used before the 桃', () => {
    const w = world();
    const medic = hero(w, 2);
    const down = hero(w, 1);
    let freeUses = 0;
    inject(w, medic, {
      id: 't_jijiu',
      canReviveFree: () => true,
      onRevive: (_c, _t, free) => {
        if (free) freeUses++;
      },
    });
    place(w, down, 0, 20);
    place(w, medic, 0, 21.5, 0); // facing −z, toward the downed hero
    w.step();
    w.downHero(down, undefined);
    w.setInput('p2', { ...emptyInput(w.tick + 1), yaw: 0, buttons: BTN_INTERACT, actions: [{ a: 'interact' }] });
    for (let i = 0; i < 60 && down.hero!.downed; i++) {
      w.setInput('p2', { ...emptyInput(w.tick + 2 + i), yaw: 0, buttons: BTN_INTERACT });
      w.step();
    }
    expect(down.hero!.downed).toBe(false);
    expect(freeUses).toBe(1);
    expect(medic.hero!.items[0]).toEqual({ id: 'tao', count: 1 });
  });

  it('a stealthed user’s item use is private; a card without a target gives a private denied cue', () => {
    const w = world();
    const e = hero(w, 2);
    e.hero!.items[1] = { id: 'shan', count: 1 };
    w.applyStatus(e.id, 'stealth', 10, { sourceId: e.id, params: { keep: 1 } });
    w.setInput('p2', { ...emptyInput(w.tick + 1), actions: [{ a: 'item', slot: 1 }] });
    w.step();
    const use = ofType(w.drainEvents(), 'itemUse')[0];
    expect(use.item).toBe('shan');
    expect(use.privateTo).toBe(e.id);
    e.hero!.items[2] = { id: 'shunshou', count: 1 };
    w.setInput('p2', { ...emptyInput(w.tick + 1), pitch: 1.2, actions: [{ a: 'item', slot: 2 }] });
    w.step();
    const denied = ofType(w.drainEvents(), 'sfx').find((s) => s.name === 'itemDenied');
    expect(denied?.privateTo).toBe(e.id);
    expect(e.hero!.items[2]).toEqual({ id: 'shunshou', count: 1 });
  });
});

describe('RENDER-1: riders are hit where they are drawn', () => {
  it('a shot at 2.0 m hits a mounted hero in the head and flies over an unmounted one', () => {
    const w = world();
    const a = hero(w, 2);
    const rider = hero(w, 3);
    const walker = hero(w, 4);
    place(w, a, 0, 30);
    place(w, rider, 0, 20);
    place(w, walker, 6, 20);
    rider.hero!.mount = 'chitu';
    w.step();
    const shoot = (t: Entity) => w.raycast({ x: t.pos.x, y: t.pos.y + 2.02, z: t.pos.z + 5 }, { x: 0, y: 0, z: -1 }, 10, { ignore: [a.id] });
    const hr = shoot(rider);
    expect(hr?.entityId).toBe(rider.id);
    expect(hr?.head).toBe(true);
    expect(shoot(walker)?.entityId).toBeUndefined();
  });
});

describe('squads and the third-person camera', () => {
  /** Commander-local (right, back) offset and distance of a unit. */
  const local = (cmd: Entity, u: Entity): { right: number; back: number; d: number } => {
    const dx = u.pos.x - cmd.pos.x;
    const dz = u.pos.z - cmd.pos.z;
    return { right: dx * Math.cos(cmd.yaw) - dz * Math.sin(cmd.yaw), back: dx * Math.sin(cmd.yaw) + dz * Math.cos(cmd.yaw), d: Math.hypot(dx, dz) };
  };
  /** A minimal brain for INT-2: soldiers steer straight to followSlot and stop within 1 m of it. */
  const followSlotBrain: TroopBrain = {
    think(sim, self, _dt, out) {
      const cmd = sim.get(self.troop!.commanderId)!;
      const g = followSlot(cmd, self.troop!.slot);
      const dx = g.x - self.pos.x;
      const dz = g.z - self.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1) {
        out.moveX = dx / d;
        out.moveZ = dz / d;
      }
      return out;
    },
  };
  /** Squads in formation, heroes 25 m apart on open ground. */
  function squadWorld(opts: Parameters<typeof makeWorld>[1] = {}): World {
    const w = makeWorld(ROLES5, { squads: true, ...opts });
    ROLES5.forEach((_, i) => {
      const c = hero(w, i);
      place(w, c, i * 25 - 50, 45);
      for (const id of c.hero!.squad) {
        const t = w.get(id)!;
        const p = followSlot(c, t.troop!.slot);
        place(w, t, p.x, p.z);
      }
    });
    w.markGridDirty();
    return w;
  }

  it('follow slots are ≥ 1 m past the 3 m minimum (a brain stops ~1 m short) and clear of the camera boom', () => {
    for (let s = 0; s < 20; s++) {
      const o = followOffset(s);
      expect(Math.hypot(o.right, o.back), `slot ${s}`).toBeGreaterThanOrEqual(FORMATION_MIN_DIST + 1);
      expect(boomDistance(o.right, o.back), `slot ${s}`).toBeGreaterThanOrEqual(BOOM_CLEAR + 1);
    }
  });

  it('a squad spawns in formation around its commander, out of his camera', () => {
    const w = makeWorld(ROLES5, { squads: true });
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const cmd = hero(w, i);
      for (const id of cmd.hero!.squad) {
        const l = local(cmd, w.get(id)!);
        expect(l.d).toBeGreaterThanOrEqual(FORMATION_MIN_DIST);
        expect(boomDistance(l.right, l.back)).toBeGreaterThanOrEqual(BOOM_CLEAR);
        n++;
      }
    }
    expect(n).toBeGreaterThan(15);
  });

  for (const [label, brain] of [
    ['the current troop brain', undefined],
    ['a brain that steers to followSlot', followSlotBrain],
  ] as const) {
    it(`turning 90° / 180° / −90°: every soldier is out of the camera boom within 0.5 s (${label})`, () => {
      const w = squadWorld(brain ? { troopBrain: brain } : {});
      const cmd = hero(w, 2);
      let yaw = 0;
      let seq = 0;
      const hold = (ticks: number, check: (i: number) => void): void => {
        for (let i = 0; i < ticks; i++) {
          w.setInput('p2', { ...emptyInput(++seq), yaw });
          w.step();
          check(i);
        }
      };
      hold(90, () => {});
      for (const turn of [Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI]) {
        yaw += turn;
        let late = Infinity;
        let near = Infinity;
        let settled = Infinity;
        hold(150, (i) => {
          for (const id of cmd.hero!.squad) {
            const l = local(cmd, w.get(id)!);
            near = Math.min(near, l.d);
            if (i >= 15) late = Math.min(late, boomDistance(l.right, l.back));
            if (i === 149) settled = Math.min(settled, l.d);
          }
        });
        expect(late, `boom distance after turning ${turn.toFixed(2)}`).toBeGreaterThanOrEqual(1.0);
        expect(near).toBeGreaterThanOrEqual(COMMANDER_CLEARANCE - 1e-6);
        // formed up again 5 s later: ≥ 3 m away (the brain steers to the engine's slots)
        expect(settled).toBeGreaterThanOrEqual(FORMATION_MIN_DIST);
      }
      // and then they stand still (nobody paces around the boom for a slot inside it)
      let fastest = 0;
      hold(300, (i) => {
        if (i < 240) return;
        for (const id of cmd.hero!.squad) fastest = Math.max(fastest, Math.hypot(w.get(id)!.vel.x, w.get(id)!.vel.z));
      });
      expect(fastest).toBeLessThan(0.5);
    });
  }

  it('walking backwards into the squad: soldiers yield out of the boom and personal space', () => {
    const w = squadWorld();
    const cmd = hero(w, 2);
    let late = Infinity;
    let near = Infinity;
    for (let i = 0; i < 120; i++) {
      w.setInput('p2', { ...emptyInput(i + 1), moveZ: i < 60 ? -1 : 0, yaw: 0 });
      w.step();
      for (const id of cmd.hero!.squad) {
        const l = local(cmd, w.get(id)!);
        near = Math.min(near, l.d);
        if (i >= 75) late = Math.min(late, boomDistance(l.right, l.back));
      }
    }
    expect(near).toBeGreaterThanOrEqual(COMMANDER_CLEARANCE - 1e-6);
    expect(late).toBeGreaterThanOrEqual(1.0);
  });

  it('a strafing commander does not drag soldiers along inside his camera boom', () => {
    const w = squadWorld();
    const cmd = hero(w, 2);
    // three soldiers right behind him, on the boom
    cmd.hero!.squad.slice(0, 3).forEach((id, k) => place(w, w.get(id)!, cmd.pos.x + 0.1 * k, cmd.pos.z + 1.4 + 0.6 * k));
    w.markGridDirty();
    const run = new Map<number, number>();
    let longest = 0;
    for (let i = 0; i < 120; i++) {
      w.setInput('p2', { ...emptyInput(i + 1), moveX: -1, yaw: 0, buttons: BTN_SPRINT });
      w.step();
      for (const id of cmd.hero!.squad) {
        const l = local(cmd, w.get(id)!);
        const r = boomDistance(l.right, l.back) < 1.0 ? (run.get(id) ?? 0) + 1 : 0;
        run.set(id, r);
        longest = Math.max(longest, r);
      }
    }
    expect(longest).toBeLessThanOrEqual(15);
  });

  it('own soldiers never end a tick within 1.2 m of their commander', () => {
    const w = makeWorld(ROLES5, { squads: true });
    const cmd = hero(w, 2);
    place(w, cmd, 0, 45);
    for (const id of cmd.hero!.squad) place(w, w.get(id)!, 0.1, 45.1);
    let worst = Infinity;
    for (let i = 0; i < 60; i++) {
      w.setInput('p2', { ...emptyInput(i + 1), moveZ: i < 30 ? 0 : 1, yaw: 0 });
      w.step();
      for (const id of cmd.hero!.squad) {
        const t = w.get(id)!;
        worst = Math.min(worst, Math.hypot(t.pos.x - cmd.pos.x, t.pos.z - cmd.pos.z));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(COMMANDER_CLEARANCE - 1e-6);
  });

  /**
   * Walk the commander from `from` toward `to` onto a soldier standing at `at`
   * (the rest of his squad parked at `park`); worst distance of any of his
   * soldiers to him at the end of a tick. The soldier's brain stands still
   * (a soldier holding its spot to shoot); `rooted` also roots it.
   */
  function walkInto(w: World, at: { x: number; z: number }, from: { x: number; z: number }, to: { x: number; z: number }, park: { x: number; z: number }, rooted = false): number {
    const cmd = hero(w, 2);
    ROLES5.forEach((_, i) => {
      if (i !== 2) place(w, hero(w, i), i * 12 - 10, -45);
    });
    place(w, cmd, from.x, from.z);
    const [first, ...rest] = cmd.hero!.squad;
    place(w, w.get(first)!, at.x, at.z);
    if (rooted) w.applyStatus(first, 'root', 10);
    rest.forEach((id, k) => place(w, w.get(id)!, park.x + k, park.z));
    w.markGridDirty();
    const yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    let worst = Infinity;
    for (let i = 0; i < 90; i++) {
      w.setInput('p2', { ...emptyInput(i + 1), moveZ: 1, yaw });
      w.step();
      for (const id of cmd.hero!.squad) {
        const t = w.get(id)!;
        worst = Math.min(worst, Math.hypot(t.pos.x - cmd.pos.x, t.pos.z - cmd.pos.z));
      }
    }
    return worst;
  }

  /** Soldiers that hold their spot (stand and shoot). */
  const standBrain: TroopBrain = { think: (_sim, _self, _dt, out) => out };

  for (const rooted of [false, true]) {
  it(`the 1.2 m rule holds in a corner: the soldier slips out along a wall${rooted ? ' (rooted)' : ''}`, () => {
    const map = makeTestMap();
    // an L-shaped corner opening toward −x / +z: walls x ∈ [3.5, 4.5] (z 38…52) and z ∈ [39, 40] (x −6…4.5)
    map.colliders = [
      ...map.colliders,
      { kind: 'box', cx: 4, cy: 1.5, cz: 45, hx: 0.5, hy: 1.5, hz: 7, rot: 0 },
      { kind: 'box', cx: -0.75, cy: 1.5, cz: 39.5, hx: 5.25, hy: 1.5, hz: 0.5, rot: 0 },
    ];
    const w = makeWorld(ROLES5, { squads: true, map, troopBrain: standBrain });
    expect(walkInto(w, { x: 3.05, z: 40.45 }, { x: 0, z: 44 }, { x: 3.05, z: 40.45 }, { x: -12, z: 50 }, rooted)).toBeGreaterThanOrEqual(COMMANDER_CLEARANCE - 1e-6);
  });

  it(`the 1.2 m rule holds at the foot of a steep slope${rooted ? ' (rooted)' : ''}`, () => {
    const w = makeWorld(ROLES5, { squads: true, mapOpts: { hill: true }, troopBrain: standBrain });
    // the 60° hill rises toward −x from x = −30: the soldier cannot be pushed up it
    expect(walkInto(w, { x: -29.6, z: 45 }, { x: -24, z: 45 }, { x: -31, z: 45 }, { x: -18, z: 52 }, rooted)).toBeGreaterThanOrEqual(COMMANDER_CLEARANCE - 1e-6);
  });
  }
});
