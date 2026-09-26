import { describe, expect, it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { createMatch } from '../../../src/sim/world';
import { hero, makeInit, makeTestMap, makeWorld, place, stepN } from './helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

describe('SimHost contract', () => {
  it('createMatch returns a SimHost; entityOf maps players to heroes', () => {
    const host = createMatch(makeInit(STD5, [], {}, [0]), { map: makeTestMap(), onWarn: () => {}, nav: false });
    const id = host.entityOf('p0');
    expect(id).not.toBeNull();
    expect(host.entityOf('bot-1')).not.toBeNull();
    expect(host.entityOf('stranger')).toBeNull();
    host.step();
    expect(host.tick).toBe(1);
    expect(host.time).toBeCloseTo(1 / 30, 9);
    const snap = host.snapshotFor('p0');
    expect(snap.you?.entityId).toBe(id);
    expect(snap.players.length).toBe(5);
    expect(host.result()).toBeNull();
  });

  it('actions from several frames between ticks are queued, never dropped', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    e.hero!.items = [{ id: 'shan', count: 1 }, null, null, null];
    e.hero!.dodgeCharges = 1;
    w.setInput('p2', { ...emptyInput(1), actions: [{ a: 'claim', role: 'loyalist' }] });
    w.setInput('p2', { ...emptyInput(2), actions: [{ a: 'item', slot: 0 }] });
    w.setInput('p2', { ...emptyInput(3), actions: [] });
    w.drainEvents();
    w.step();
    expect(e.hero!.claim).toBe('loyalist');
    expect(e.hero!.dodgeCharges).toBe(2);
    expect(w.drainEvents().some((ev) => ev.t === 'claim' && ev.who === e.id)).toBe(true);
  });

  it('stale / duplicate frames are ignored and ackSeq tracks the applied frame', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    place(w, e, 0, 30);
    w.setInput('p2', { ...emptyInput(5), moveZ: 1, yaw: 0 });
    w.setInput('p2', { ...emptyInput(4), moveZ: -1, yaw: 0, actions: [{ a: 'claim', role: 'rebel' }] });
    stepN(w, 15);
    expect(e.pos.z).toBeLessThan(30);
    expect(e.hero!.claim).toBeNull();
    expect(w.snapshotFor('p2').ackSeq).toBe(5);
  });

  it('non-finite input values are sanitised', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    w.setInput('p2', { ...emptyInput(1), moveX: NaN, moveZ: Infinity, yaw: NaN, pitch: NaN, aimPoint: { x: NaN, y: 0, z: 0 } });
    stepN(w, 5);
    expect(Number.isFinite(e.pos.x) && Number.isFinite(e.pos.z) && Number.isFinite(e.yaw)).toBe(true);
  });

  it('convertToBot hands the hero to a bot brain; convertToHuman gives it back under a new id', () => {
    const w = makeWorld(STD5, { humans: [2] });
    const e = hero(w, 2);
    w.convertToBot('p2');
    expect(e.hero!.isBot).toBe(true);
    stepN(w, 60);
    w.convertToHuman(2, 'newbie', 'Newbie');
    expect(w.entityOf('newbie')).toBe(e.id);
    expect(w.entityOf('p2')).toBeNull();
    expect(e.hero!.name).toBe('Newbie');
    expect(e.hero!.isBot).toBe(false);
    const snap = w.snapshotFor('newbie');
    expect(snap.you?.entityId).toBe(e.id);
    expect(snap.players.find((p) => p.seat === 2)?.name).toBe('Newbie');
    // the new client's first frame (seq 1) is accepted
    w.setInput('newbie', { ...emptyInput(1), moveZ: 1, yaw: 0 });
    const z = e.pos.z;
    stepN(w, 10);
    expect(e.pos.z).toBeLessThan(z);
  });

  it('unknown hero / weapon ids fall back gracefully', () => {
    const warnings: string[] = [];
    const w = makeWorld(STD5, { heroes: ['no_such_hero'], onWarn: (m) => warnings.push(m) });
    const e = hero(w, 0);
    expect(e.maxHp).toBeGreaterThan(0);
    e.hero!.weapons[0] = { id: 'laser_cannon', mag: 5, reserve: 5 };
    w.setInput('p0', { ...emptyInput(1), buttons: 1 });
    expect(() => stepN(w, 10)).not.toThrow();
    expect(warnings.some((m) => m.includes('no_such_hero'))).toBe(true);
    expect(warnings.some((m) => m.includes('laser_cannon'))).toBe(true);
    expect(() => w.spawnTroops(e.id, 'ghost_army', 2)).not.toThrow();
    expect(() => w.spawnNpc('ghost', { x: 0, y: 0, z: 0 })).not.toThrow();
  });

  it('recovers units whose position became non-finite', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    place(w, e, 3, 33);
    w.step();
    e.pos.x = NaN;
    w.step();
    expect(Number.isFinite(e.pos.x)).toBe(true);
    expect(Math.hypot(e.pos.x - 3, e.pos.z - 33)).toBeLessThan(2);
  });

  it('is deterministic for identical inputs and seeds', () => {
    const run = () => {
      const w = makeWorld(STD5, { humans: [], ambient: true, zone: true, squads: true });
      stepN(w, 300);
      return JSON.stringify(w.snapshotFor('bot-0').ents.map((v) => [v.id, v.x, v.z, v.hp]));
    };
    expect(run()).toBe(run());
  });
});
