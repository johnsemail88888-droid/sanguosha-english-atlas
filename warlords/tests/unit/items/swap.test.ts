// Gear swaps at a loot pile: the replaced weapon / armor / mount lands ~1.35 m
// behind the hero, clear of the rest of the pile (so the next F takes the next
// piece, not the one just dropped), locked for the dropper for 1.5 s.
import { describe, expect, it } from 'vitest';
import type { Entity, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { SWAP_LOCK, lootLockedFor } from '../../../src/sim/inventory';
import { scatterAround } from '../../../src/sim/loot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
let seq = 1;

const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const loots = (w: World): Entity[] => [...w.entities()].filter((e) => e.kind === 'loot' && e.alive);

/** A crate-style pile of 3 pieces (radius 1.3 around `c`) and the hero 1.6 m south of it, facing it. */
function pileScene(what: { itemId?: string; weaponId?: string }[]): { w: World; me: Entity; pile: Entity[] } {
  const w = makeWorld(STD5, { humans: [2] });
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  const c = { x: 0, y: 0, z: 40 };
  const pile = what.map((x, i) => w.spawnLoot(scatterAround(c, i, what.length, 1.3), { ...x, count: 1 }));
  const me = hero(w, 2);
  place(w, me, 0, 42.2, 0); // yaw 0 faces -z: the pile is in front
  w.step();
  w.drainEvents();
  return { w, me, pile };
}

function pressF(w: World, target: Entity): void {
  w.setInput('p2', { ...emptyInput(seq++), yaw: 0, pitch: 0.4, aimTargetId: target.id, actions: [{ a: 'interact' }] });
  w.step();
}

describe('gear swap drop', () => {
  it('armor swapped at a pile drops ≥ 1 m from every remaining pile item, locked 1.5 s for the dropper', () => {
    const { w, me, pile } = pileScene([{ itemId: 'renwang' }, { itemId: 'tengjia' }, { itemId: 'chitu' }]);
    me.hero!.armor = 'bagua';
    const take = pile.find((l) => l.loot!.itemId === 'renwang')!;
    // stand right by it
    place(w, me, take.pos.x, take.pos.z + 1.4, 0);
    pressF(w, take);
    expect(me.hero!.armor).toBe('renwang');
    const dropped = loots(w).find((l) => l.loot!.itemId === 'bagua');
    expect(dropped).toBeDefined();
    const rest = loots(w).filter((l) => l !== dropped);
    expect(rest.length).toBe(2);
    for (const r of rest) expect(flat(dropped!.pos, r.pos)).toBeGreaterThanOrEqual(1);
    // behind the hero (1.2–1.5 m), not under his feet
    const d = flat(dropped!.pos, me.pos);
    expect(d).toBeGreaterThan(1.1);
    expect(d).toBeLessThan(1.6);
    expect(lootLockedFor(w, dropped!, me.id)).toBe(true);
    stepN(w, Math.ceil(SWAP_LOCK * 30) + 2);
    expect(lootLockedFor(w, dropped!, me.id)).toBe(false);
  });

  it('a weapon swap drops the old gun clear of the pile too', () => {
    const { w, me, pile } = pileScene([{ weaponId: 'qilin' }, { weaponId: 'zhuge' }, { itemId: 'tao' }, { itemId: 'dilu' }]);
    const old = me.hero!.weapons[0]!.id;
    const take = pile.find((l) => l.loot!.weaponId === 'qilin')!;
    place(w, me, take.pos.x + 0.3, take.pos.z + 1.3, 0);
    pressF(w, take);
    expect(me.hero!.weapons[0]!.id).toBe('qilin');
    const dropped = loots(w).find((l) => l.loot!.weaponId === old);
    expect(dropped).toBeDefined();
    for (const r of loots(w)) if (r !== dropped) expect(flat(dropped!.pos, r.pos)).toBeGreaterThanOrEqual(1);
    expect(flat(dropped!.pos, me.pos)).toBeGreaterThan(1.1);
    expect(flat(dropped!.pos, take.pos)).toBeGreaterThan(1.5); // not where the new gun lay
    expect(lootLockedFor(w, dropped!, me.id)).toBe(true);
    // the same F press again goes to the next pile piece, not back to the dropped gun
    stepN(w, 3);
    const zhuge = pile.find((l) => l.loot!.weaponId === 'zhuge')!;
    place(w, me, zhuge.pos.x, zhuge.pos.z + 1.3, 0);
    pressF(w, zhuge);
    expect(me.hero!.weapons[0]!.id).toBe('zhuge');
  });

  it('a tight pile (reward cards dropped at one spot): the old piece still lands ≥ 1 m from all of it', () => {
    const w = makeWorld(STD5, { humans: [2] });
    STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
    const c = { x: 0, y: 0, z: 40 };
    const pile = [
      w.spawnLoot({ x: c.x, y: 0, z: c.z }, { itemId: 'jueying', count: 1 }),
      w.spawnLoot({ x: c.x + 0.4, y: 0, z: c.z + 0.2 }, { itemId: 'tao', count: 1 }),
      w.spawnLoot({ x: c.x - 0.3, y: 0, z: c.z + 0.35 }, { itemId: 'wuxie', count: 1 }),
      w.spawnLoot({ x: c.x + 0.1, y: 0, z: c.z - 0.4 }, { weaponId: 'guding', count: 1 }),
    ];
    const me = hero(w, 2);
    me.hero!.mount = 'dilu';
    place(w, me, c.x + 0.2, c.z + 1.1, 0);
    w.step();
    pressF(w, pile[0]);
    expect(me.hero!.mount).toBe('jueying');
    const dropped = loots(w).find((l) => l.loot!.itemId === 'dilu')!;
    expect(dropped).toBeDefined();
    for (const r of loots(w)) if (r !== dropped) expect(flat(dropped.pos, r.pos)).toBeGreaterThanOrEqual(1);
  });
});
