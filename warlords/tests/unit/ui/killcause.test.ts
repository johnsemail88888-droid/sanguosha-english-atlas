// Kill feed glyph: what a kill / down was made with, read from the event stream.
import { describe, expect, it } from 'vitest';
import type { EntityId, GameEvent } from '../../../src/core/types';
import { CAUSE_MEMORY, KillCauses, RECENT_ACTION } from '../../../src/ui/hud/killcause';

const P = { x: 0, y: 0, z: 0 };
const shot = (src: EntityId, weapon: string, hit?: EntityId): GameEvent => ({ t: 'shot', src, weapon, from: P, to: P, hit });
const hit = (src: EntityId, target: EntityId, amount = 40): GameEvent => ({ t: 'hit', src, target, amount, dtype: 'normal', pos: P });
const cast = (src: EntityId, ability: string, target?: EntityId, proc = false): GameEvent => ({ t: 'ability', src, ability, target, proc });

/** heroes 1..3 hold their signature weapons; 50 is a troop of hero 1 */
function tracker(): KillCauses {
  const held: Record<number, string> = { 1: 'qinglong', 2: 'zhangba', 3: 'pistol', 50: 'troop_rifle' };
  const owner: Record<number, number> = { 50: 1 };
  return new KillCauses({ heldWeapon: (id) => held[id], ownerOf: (id) => owner[id] });
}

describe('KillCauses', () => {
  it('a shot that hit the victim names the weapon', () => {
    const k = tracker();
    k.ingest([hit(2, 9), shot(2, 'zhangba', 9)], 10);
    expect(k.causeOf(9, 2, 10)).toEqual({ kind: 'weapon', id: 'zhangba' });
  });

  it('an ability hitscan (shot.weapon = the ability id) names the ability', () => {
    const k = tracker();
    k.ingest([hit(1, 9), shot(1, 'guanyu_wusheng', 9)], 10);
    expect(k.causeOf(9, 1, 10)).toEqual({ kind: 'ability', id: 'guanyu_wusheng' });
  });

  it("shot.weapon = 'ability' uses the attacker's latest cast", () => {
    const k = tracker();
    k.ingest([cast(1, 'guanyu_qinglong')], 10);
    k.ingest([hit(1, 9), shot(1, 'ability', 9)], 10.4);
    expect(k.causeOf(9, 1, 10.4)).toEqual({ kind: 'ability', id: 'guanyu_qinglong' });
  });

  it('a cast aimed at the victim, or an area cast in the same batch, names the ability', () => {
    const k = tracker();
    k.ingest([cast(2, 'zhangfei_paoxiao', 9), hit(2, 9)], 5);
    expect(k.causeOf(9, 2, 5)).toEqual({ kind: 'ability', id: 'zhangfei_paoxiao' });
    k.ingest([cast(3, 'zhangliao_liaolai'), hit(3, 8), hit(3, 7)], 6);
    expect(k.causeOf(8, 3, 6)).toEqual({ kind: 'ability', id: 'zhangliao_liaolai' });
    expect(k.causeOf(7, 3, 6)).toEqual({ kind: 'ability', id: 'zhangliao_liaolai' });
  });

  it("the victim's own passive proc does not steal the credit", () => {
    const k = tracker();
    // 9 reflects with a passive while 2 shoots it
    k.ingest([cast(9, 'xiahoudun_ganglie', 2, true), hit(2, 9), shot(2, 'zhangba', 9)], 3);
    expect(k.causeOf(9, 2, 3)).toEqual({ kind: 'weapon', id: 'zhangba' });
  });

  it('a card (itemUse) names the card', () => {
    const k = tracker();
    k.ingest([{ t: 'itemUse', who: 2, item: 'nanman' }, hit(2, 9)], 4);
    expect(k.causeOf(9, 2, 4)).toEqual({ kind: 'item', id: 'nanman' });
  });

  it("a troop's shot credited to its hero names the troop's weapon (no art → no glyph)", () => {
    const k = tracker();
    k.ingest([hit(1, 9), shot(50, 'troop_rifle', 9)], 4);
    expect(k.causeOf(9, 1, 4)).toEqual({ kind: 'weapon', id: 'troop_rifle' });
  });

  it('damage landing later (projectile, burn) goes to the recent action, then the held weapon', () => {
    const k = tracker();
    k.ingest([cast(2, 'zhangfei_paoxiao')], 1);
    k.ingest([hit(2, 9)], 1 + RECENT_ACTION - 0.5);
    expect(k.causeOf(9, 2, 3)).toEqual({ kind: 'ability', id: 'zhangfei_paoxiao' });
    k.ingest([hit(2, 8)], 1 + RECENT_ACTION + 2);
    expect(k.causeOf(8, 2, 7)).toEqual({ kind: 'weapon', id: 'zhangba' });
  });

  it('the last hit counts; a downed victim bleeding out keeps it for a while, then the held weapon', () => {
    const k = tracker();
    k.ingest([hit(1, 9), shot(1, 'guanyu_wusheng', 9)], 10);
    k.ingest([hit(1, 9), shot(1, 'qinglong', 9)], 11);
    expect(k.causeOf(9, 1, 20)).toEqual({ kind: 'weapon', id: 'qinglong' });
    k.ingest([hit(1, 9), shot(1, 'guanyu_wusheng', 9)], 12);
    expect(k.causeOf(9, 1, 12 + CAUSE_MEMORY - 1)).toEqual({ kind: 'ability', id: 'guanyu_wusheng' });
    expect(k.causeOf(9, 1, 12 + CAUSE_MEMORY + 1)).toEqual({ kind: 'weapon', id: 'qinglong' });
  });

  it('forget() drops a dead victim; no killer or no weapon → null', () => {
    const k = tracker();
    k.ingest([hit(2, 9), shot(2, 'zhangfei_paoxiao', 9)], 1);
    k.forget(9);
    expect(k.causeOf(9, 2, 1)).toEqual({ kind: 'weapon', id: 'zhangba' });
    expect(k.causeOf(9, undefined, 1)).toBeNull();
    expect(k.causeOf(9, 77, 1)).toBeNull();
  });

  it('zero-damage (blocked) hits and self-damage are ignored', () => {
    const k = tracker();
    k.ingest([cast(2, 'zhangfei_paoxiao', 9), hit(2, 9, 0)], 1);
    k.ingest([hit(9, 9)], 1);
    expect(k.causeOf(9, 2, 5)).toEqual({ kind: 'weapon', id: 'zhangba' });
  });
});
