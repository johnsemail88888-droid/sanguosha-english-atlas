import { describe, expect, it } from 'vitest';
import type { ViewEntity } from '../../../src/core/types';
import { VF_DEAD, VF_DOWNED, VF_REVIVING } from '../../../src/core/types';
import { DamageLog, HELP_MARK_TIME, HelpCalls, RECAP_WINDOW, bleedText, downedMarkers, knownFriends } from '../../../src/ui/hud/deathlog';

const hero = (id: number, x: number, z: number, flags = 0, role?: ViewEntity['role']): ViewEntity => ({
  id, kind: 'hero', sub: 'zhaoyun', x, y: 0, z, yaw: 0, pitch: 0, speed: 0, hp: 0, maxHp: 400, shield: 0, flags, role,
});

describe('death recap: DamageLog', () => {
  it('groups the last 10 s of hits by attacker, most damage first, with causes and headshots', () => {
    const log = new DamageLog();
    const w = (id: string) => ({ kind: 'weapon' as const, id });
    log.add({ at: 1, src: 7, amount: 999, head: false, dtype: 'normal', cause: w('zhangba') }); // too old at t=20
    log.add({ at: 12, src: 7, amount: 40, head: false, dtype: 'normal', cause: w('zhangba') });
    log.add({ at: 13, src: 9, amount: 30, head: true, dtype: 'normal', cause: w('bow') });
    log.add({ at: 14, src: 7, amount: 55, head: true, dtype: 'normal', cause: w('zhangba') });
    log.add({ at: 15, src: 7, amount: 20, head: false, dtype: 'fire', cause: { kind: 'ability', id: 'huoji' } });
    log.add({ at: 16, amount: 12, head: false, dtype: 'zone', cause: null });
    log.add({ at: 17, src: 9, amount: 0, head: false, dtype: 'normal', cause: null }); // nothing: ignored
    const r = log.recap(20, 7, 9, w('zhangba'));
    expect(r.window).toBe(RECAP_WINDOW);
    expect(r.killer).toBe(7);
    expect(r.downedBy).toBe(9);
    expect(r.rows.map((x) => x.src)).toEqual([7, 9, null]);
    expect(r.rows[0]).toMatchObject({ total: 115, hits: 3, heads: 1 });
    expect(r.rows[0].causes).toEqual([w('zhangba'), { kind: 'ability', id: 'huoji' }]);
    expect(r.rows[1]).toMatchObject({ total: 30, hits: 1, heads: 1 });
    expect(r.rows[2]).toMatchObject({ zone: true, total: 12 });
    expect(r.total).toBe(157);
  });

  it('a zone death with no attacker has no killer; clear() forgets everything', () => {
    const log = new DamageLog();
    log.add({ at: 5, amount: 10, head: false, dtype: 'zone', cause: null });
    const r = log.recap(6, undefined, undefined, null);
    expect(r.killer).toBeNull();
    expect(r.rows).toHaveLength(1);
    log.clear();
    expect(log.rows(6)).toEqual([]);
  });

  it('stays bounded under a long stream of hits', () => {
    const log = new DamageLog();
    for (let i = 0; i < 2000; i++) log.add({ at: i * 0.1, src: 1, amount: 1, head: false, dtype: 'normal', cause: null });
    const rows = log.rows(200);
    expect(rows[0].hits).toBeLessThanOrEqual(RECAP_WINDOW * 10 + 1);
  });
});

describe('revive markers', () => {
  it('only a known ally or someone who called for help lately — never yourself, the standing or the dead', () => {
    const calls = new HelpCalls();
    const ents = [
      hero(1, 0, 0, VF_DOWNED), // me
      hero(2, 10, 0, VF_DOWNED), // called for help
      hero(3, 20, 0, VF_DOWNED | VF_REVIVING), // known ally being revived
      hero(4, 5, 0, VF_DOWNED), // a stranger, silent: no marker (hidden roles stay hidden)
      hero(5, 5, 5, 0), // standing
      hero(6, 6, 0, VF_DEAD | VF_DOWNED),
    ];
    calls.note(2, 100);
    calls.note(5, 100);
    const m = downedMarkers(1, { x: 0, z: 0 }, ents, new Set([3]), calls, 101);
    expect(m.map((x) => x.id)).toEqual([2, 3]);
    expect(m[0]).toMatchObject({ called: true, ally: false, reviving: false, dist: 10 });
    expect(m[1]).toMatchObject({ called: false, ally: true, reviving: true });
    // the call fades
    expect(downedMarkers(1, { x: 0, z: 0 }, ents, new Set(), calls, 100 + HELP_MARK_TIME + 0.5).map((x) => x.id)).toEqual([]);
    // out of range
    expect(downedMarkers(1, { x: 0, z: 0 }, ents, new Set([3]), calls, 101, 15).map((x) => x.id)).toEqual([2]);
  });

  it('HelpCalls: since / forget', () => {
    const c = new HelpCalls();
    expect(c.since(1, 5)).toBe(Infinity);
    c.note(1, 5);
    expect(c.since(1, 7)).toBe(2);
    expect(c.active(1, 7)).toBe(true);
    c.forget(1);
    expect(c.active(1, 7)).toBe(false);
  });

  it('knownFriends: knownAllies, plus the public Lord for his loyalists — nothing hidden', () => {
    const ents = [hero(1, 0, 0, 0, 'lord'), hero(2, 0, 0), hero(3, 0, 0, 0, 'rebel')];
    expect([...knownFriends('loyalist', undefined, ents)]).toEqual([1]);
    expect([...knownFriends('rebel', undefined, ents)]).toEqual([]);
    expect([...knownFriends('lord', [7], ents)]).toEqual([7]);
    expect([...knownFriends('double', [1], ents)]).toEqual([1]);
  });
});

describe('bleedText', () => {
  it('one decimal under 10 s, whole seconds above', () => {
    expect(bleedText(11.2)).toBe('12');
    expect(bleedText(9.94)).toBe('9.9');
    expect(bleedText(-1)).toBe('0.0');
  });
});
