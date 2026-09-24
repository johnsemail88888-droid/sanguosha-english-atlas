import { describe, expect, it } from 'vitest';
import type { RoleId, ViewEntity } from '../../../src/core/types';
import { VF_DEAD, VF_DOWNED, VF_LORD, VF_REVEALED, VF_STEALTH, emptyInput } from '../../../src/core/types';
import { VF_EXPOSED } from '../../../src/sim/snapshot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

function world(roles: RoleId[]): World {
  const w = makeWorld(roles);
  roles.forEach((_, i) => place(w, hero(w, i), i * 6 - 12, 30));
  w.step();
  return w;
}

const viewOf = (ents: ViewEntity[], id: number): ViewEntity | undefined => ents.find((v) => v.id === id);

describe('snapshots hide private information', () => {
  it('only the lord, yourself and the dead have visible roles', () => {
    const w = world(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
    const snap = w.snapshotFor('p2');
    const roles = [0, 1, 2, 3, 4].map((i) => viewOf(snap.ents, hero(w, i).id)!.role);
    expect(roles).toEqual(['lord', undefined, 'rebel', undefined, undefined]);
    expect(snap.players.map((p) => p.role)).toEqual(['lord', undefined, 'rebel', undefined, undefined]);
    expect(snap.you?.role).toBe('rebel');
    expect(viewOf(snap.ents, hero(w, 0).id)!.flags & VF_LORD).toBeTruthy();
    // nothing in the serialized snapshot leaks the traitor
    expect(JSON.stringify(snap)).not.toContain('traitor');
    // after death the role is public
    w.dealDamage({ targetId: hero(w, 4).id, amount: 1e4, type: 'true' });
    w.dealDamage({ targetId: hero(w, 4).id, amount: 1e4, type: 'true' });
    const after = w.snapshotFor('p2');
    const dead = viewOf(after.ents, hero(w, 4).id)!;
    expect(dead.role).toBe('traitor');
    expect(dead.flags & VF_DEAD).toBeTruthy();
    expect(dead.flags & VF_REVEALED).toBeTruthy();
  });

  it('影武者 appears as a lord to everyone except the real lord (and itself)', () => {
    const w = world(['lord', 'double', 'rebel', 'rebel', 'traitor']);
    const dbl = hero(w, 1);
    const rebelView = w.snapshotFor('p2');
    expect(viewOf(rebelView.ents, dbl.id)!.role).toBe('lord');
    expect(viewOf(rebelView.ents, dbl.id)!.flags & VF_LORD).toBeTruthy();
    expect(rebelView.players[1].role).toBe('lord');
    expect(JSON.stringify(rebelView)).not.toContain('double');
    const lordView = w.snapshotFor('p0');
    expect(viewOf(lordView.ents, dbl.id)!.role).toBe('double');
    expect(lordView.you?.knownAllies).toEqual([dbl.id]);
    const selfView = w.snapshotFor('p1');
    expect(selfView.you?.role).toBe('double');
    expect(selfView.you?.knownAllies).toEqual([hero(w, 0).id]);
  });

  it('enemy stealth beyond 8 m is not sent; close, own-side or revealed stealth is', () => {
    const w = world(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
    const sneaky = hero(w, 3);
    const viewer = hero(w, 2);
    place(w, viewer, 0, 30);
    place(w, sneaky, 0, 15);
    w.applyStatus(sneaky.id, 'stealth', 10, { sourceId: sneaky.id });
    const [troop] = w.spawnTroops(sneaky.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 12 });
    w.applyStatus(troop.id, 'stealth', 10, { sourceId: sneaky.id });
    w.step();
    let s = w.snapshotFor('p2');
    expect(viewOf(s.ents, sneaky.id)).toBeUndefined();
    expect(viewOf(s.ents, troop.id)).toBeUndefined();
    // the owner still sees himself and his stealthed troop
    const own = w.snapshotFor('p3');
    expect(viewOf(own.ents, sneaky.id)!.flags & VF_STEALTH).toBeTruthy();
    expect(viewOf(own.ents, troop.id)).toBeDefined();
    // within 8 m
    place(w, viewer, 0, 21);
    w.step();
    s = w.snapshotFor('p2');
    expect(viewOf(s.ents, sneaky.id)).toBeDefined();
    // revealed
    place(w, viewer, 0, 40);
    w.applyStatus(sneaky.id, 'reveal', 5, { sourceId: viewer.id });
    w.step();
    expect(viewOf(w.snapshotFor('p2').ents, sneaky.id)).toBeDefined();
  });

  it('private reveals (params.viewerId) are visible and routed only to their viewer', () => {
    const w = world(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
    const seer = hero(w, 1);
    const target = hero(w, 3);
    place(w, target, 30, 0);
    w.applyStatus(target.id, 'stealth', 10, { sourceId: target.id });
    w.drainEvents();
    w.applyStatus(target.id, 'reveal', 5, { sourceId: seer.id, params: { viewerId: seer.id } });
    const ev = w.drainEvents().find((e) => e.t === 'status' && e.status === 'reveal');
    expect(ev?.privateTo).toBe(seer.id);
    w.step();
    const mine = viewOf(w.snapshotFor('p1').ents, target.id);
    expect(mine).toBeDefined();
    expect(mine!.flags & VF_EXPOSED).toBeTruthy();
    expect(viewOf(w.snapshotFor('p2').ents, target.id)).toBeUndefined(); // still stealthed for others
    expect(w.canSee(seer, target)).toBe(true);
    expect(w.canSee(hero(w, 2), target)).toBe(false);
  });

  it('the private view carries active forced movement for prediction', () => {
    const w = world(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
    const e = hero(w, 2);
    w.dash(e.id, { x: 1, y: 0, z: 0 }, 6, 0.3);
    const you = w.snapshotFor('p2').you!;
    expect(you.forced?.vel.x).toBeCloseTo(20, 5);
    expect(you.forced?.remaining).toBeCloseTo(0.3, 3);
    stepN(w, 12);
    expect(w.snapshotFor('p2').you!.forced).toBeUndefined();
  });

  it('private hero view carries HUD state; others never get it', () => {
    const w = world(['lord', 'loyalist', 'rebel', 'bounty', 'traitor']);
    const hunter = hero(w, 3);
    const s = w.snapshotFor('p3');
    expect(s.you?.entityId).toBe(hunter.id);
    expect(s.you?.bountyTargetId).toBe(hunter.hero!.bountyTargetId);
    expect(s.you?.weapons[0]?.mag).toBeGreaterThan(0);
    expect(s.you?.items[0]).toEqual({ id: 'tao', count: 1 });
    expect(s.you?.dodgeCharges).toBe(2);
    expect(s.you?.moveMods).toMatchObject({ speedMul: expect.any(Number), rooted: false });
    expect(s.you?.onGround).toBe(true);
    const other = w.snapshotFor('p2');
    expect(other.you?.bountyTargetId).toBeUndefined();
    expect(JSON.stringify(other)).not.toContain('bounty');
    // spectators / unknown players get no private view
    expect(w.snapshotFor('nobody').you).toBeNull();
  });

  it('downed flag, cooldown seconds and ackSeq', () => {
    const w = world(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
    const e = hero(w, 2);
    w.setInput('p2', { ...emptyInput(41), moveZ: 0 });
    w.step();
    expect(w.snapshotFor('p2').ackSeq).toBe(41);
    w.dealDamage({ targetId: e.id, amount: 1e4, type: 'true' });
    const s = w.snapshotFor('p1');
    expect(viewOf(s.ents, e.id)!.flags & VF_DOWNED).toBeTruthy();
    const mine = w.snapshotFor('p2').you!;
    expect(mine.downed).toBe(true);
    expect(mine.downedRemaining).toBeGreaterThan(11);
    stepN(w, 3);
    expect(w.snapshotFor('p2').zone.radius).toBeGreaterThan(0);
  });
});
