// Engine features added for docs/SIM_REQUESTS.md (wave 2): one block per request id.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, RoleId } from '../../../src/core/types';
import { BTN_INTERACT, emptyInput } from '../../../src/core/types';
import { circleAttack } from '../../../src/sim/abilities/common';
import { registerProjectileKind } from '../../../src/sim/combat';
import type { AbilityCast, AbilityImplEx } from '../../../src/sim/ext';
import { registerHazardKind } from '../../../src/sim/hazards';
import { COMMANDER_CLEARANCE, FORMATION_MIN_DIST, boomDistance, followOffset } from '../../../src/sim/troops';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

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
        ctx.sim.dealDamage; // SimApi face
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
  it('follow slots are ≥ 3 m from the commander and clear of the camera boom', () => {
    for (let s = 0; s < 20; s++) {
      const o = followOffset(s);
      expect(Math.hypot(o.right, o.back), `slot ${s}`).toBeGreaterThanOrEqual(FORMATION_MIN_DIST);
      expect(boomDistance(o.right, o.back), `slot ${s}`).toBeGreaterThanOrEqual(1.3);
    }
  });

  it('a squad spawns in formation around its commander, out of his camera', () => {
    const w = makeWorld(ROLES5, { squads: true });
    for (let i = 0; i < 5; i++) {
      const cmd = hero(w, i);
      for (const id of cmd.hero!.squad) {
        const t = w.get(id)!;
        const dx = t.pos.x - cmd.pos.x;
        const dz = t.pos.z - cmd.pos.z;
        const right = dx * Math.cos(cmd.yaw) - dz * Math.sin(cmd.yaw);
        const back = dx * Math.sin(cmd.yaw) + dz * Math.cos(cmd.yaw);
        expect(Math.hypot(dx, dz)).toBeGreaterThan(COMMANDER_CLEARANCE);
        expect(boomDistance(right, back)).toBeGreaterThan(1.2);
      }
    }
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
});
