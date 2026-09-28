// 方天 lock events (sim/lockWatch.ts): every homing lock that begins or ends in the world's
// projHoming table becomes a public { t: 'lock' } event — the target's warning and the shooter's
// tone follow them, however combat.ts picks, retargets or clears locks (a dodge roll deletes one).
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../../src/core/types';
import { emitLockChanges } from '../../../src/sim/lockWatch';
import { DUMMY, hero, makeWorld, place } from './helpers';

type Lock = Extract<GameEvent, { t: 'lock' }>;

function setup() {
  const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor'], { heroes: [DUMMY, DUMMY, DUMMY, DUMMY, DUMMY] });
  const a = hero(w, 2);
  const b = hero(w, 3);
  const c = hero(w, 4);
  place(w, a, 0, 0);
  place(w, b, 0, -15);
  place(w, c, 3, -15);
  const rocket = (): number =>
    w.spawnProjectile({ kind: 'rocket', ownerId: a.id, pos: { x: 0, y: 1.6, z: -1 }, vel: { x: 0, y: 0, z: -45 }, damage: 24, dtype: 'normal', gravity: 0, explodeRadius: 3, explodeDamage: 44, lifetime: 3, pierce: 0, canDodge: true, weaponId: 'fangtian' }).id;
  const locks = (): Lock[] => w.drainEvents().filter((e): e is Lock => e.t === 'lock');
  return { w, a, b, c, rocket, locks };
}

describe('lock events', () => {
  it('a lock that begins → on (shooter, target, rocket); nothing more while it holds', () => {
    const { w, a, b, rocket, locks } = setup();
    locks();
    const p = rocket();
    w.projHoming.set(p, { targetId: b.id, turnRate: 2.5 });
    emitLockChanges(w);
    expect(locks()).toEqual([{ t: 'lock', src: a.id, target: b.id, proj: p, on: true }]);
    emitLockChanges(w);
    expect(locks()).toEqual([]);
  });

  it('cleared homing (a dodge roll) or a retarget → off (and on for the new target)', () => {
    const { w, a, b, c, rocket, locks } = setup();
    const p = rocket();
    w.projHoming.set(p, { targetId: b.id, turnRate: 2.5 });
    emitLockChanges(w);
    locks();
    w.projHoming.set(p, { targetId: c.id, turnRate: 2.5 });
    emitLockChanges(w);
    expect(locks()).toEqual([
      { t: 'lock', src: a.id, target: b.id, proj: p, on: false },
      { t: 'lock', src: a.id, target: c.id, proj: p, on: true },
    ]);
    w.projHoming.delete(p);
    emitLockChanges(w);
    expect(locks()).toEqual([{ t: 'lock', src: a.id, target: c.id, proj: p, on: false }]);
  });

  it('the world emits them each tick: a rocket that bursts ends its lock', () => {
    const { w, b, rocket, locks } = setup();
    locks();
    const p = rocket();
    w.projHoming.set(p, { targetId: b.id, turnRate: 2.5 });
    w.step();
    expect(locks().filter((e) => e.on).map((e) => e.target)).toEqual([b.id]);
    for (let i = 0; i < 90 && w.projHoming.has(p); i++) w.step();
    expect(w.projHoming.has(p)).toBe(false);
    w.step();
    const all = locks();
    expect(all.some((e) => !e.on && e.proj === p && e.target === b.id)).toBe(true);
  });
});
