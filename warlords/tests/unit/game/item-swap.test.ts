// COMBAT-7: a full item bar can be managed. F on a card while all four slots hold
// other cards swaps it for the last slot's card (dropped behind you, briefly locked
// for you — like a gear swap); walking over it never swaps; the HUD's F prompt names
// the same slot the sim swaps; X + 4–7 (the discard chord) reaches the sim's drop.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, ItemStack, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { InputState } from '../../../src/game/input';
import { DROP_LOCK, SWAP_LOCK, itemSwapSlot, lootLockedFor } from '../../../src/sim/inventory';
import type { World } from '../../../src/sim/world';
import { itemSwapSlot as hudSwapSlot } from '../../../src/ui/hud/logic';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
let seq = 1;

const loots = (w: World): Entity[] => [...w.entities()].filter((e) => e.kind === 'loot' && e.alive);
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const ids = (items: readonly (ItemStack | null)[]): string[] => items.map((s) => (s ? `${s.id}x${s.count}` : '-'));

/** The human hero (seat 2) with four different cards, a card lying 1.8 m in front of him. */
function scene(ground: { itemId: string; count?: number }, bar: (ItemStack | null)[] = [
  { id: 'wugu', count: 1 },
  { id: 'jiedao', count: 1 },
  { id: 'tiesuo', count: 1 },
  { id: 'wuxie', count: 1 },
]): { w: World; me: Entity; card: Entity } {
  const w = makeWorld(STD5, { humans: [2] });
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  const me = hero(w, 2);
  place(w, me, 0, 42, 0); // yaw 0 faces -z
  me.hero!.items = bar.map((s) => (s ? { ...s } : null));
  const card = w.spawnLoot({ x: 0, y: 0, z: 40.2 }, { itemId: ground.itemId, count: ground.count ?? 1 });
  w.step();
  w.drainEvents();
  return { w, me, card };
}

function press(w: World, actions: ReturnType<typeof emptyInput>['actions'], aimTargetId?: number): GameEvent[] {
  w.setInput('p2', { ...emptyInput(seq++), yaw: 0, pitch: 0.4, aimTargetId, actions });
  w.step();
  return w.drainEvents();
}

describe('COMBAT-7: F on a card with a full bar swaps it for the last slot', () => {
  it('the 桃 replaces slot 7 (无懈可击), which lands behind the hero, locked for him', () => {
    const { w, me, card } = scene({ itemId: 'tao' });
    const evs = press(w, [{ a: 'interact' }], card.id);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', 'tiesuox1', 'taox1']);
    expect(card.alive).toBe(false);
    expect(evs.some((e) => e.t === 'pickup' && e.who === me.id && e.item === 'tao')).toBe(true);
    const dropped = loots(w).find((l) => l.loot!.itemId === 'wuxie');
    expect(dropped).toBeDefined();
    expect(dropped!.loot!.count).toBe(1);
    const d = flat(dropped!.pos, me.pos);
    expect(d).toBeGreaterThan(1.1);
    expect(d).toBeLessThan(1.6);
    // not straight back under the next F press
    expect(lootLockedFor(w, dropped!, me.id)).toBe(true);
    stepN(w, Math.ceil(SWAP_LOCK * 30) + 2);
    expect(lootLockedFor(w, dropped!, me.id)).toBe(false);
  });

  it('a whole stack is swapped out; a ground stack larger than one slot leaves the rest lying', () => {
    const { w, me, card } = scene({ itemId: 'sha', count: 7 }, [
      { id: 'wugu', count: 1 },
      { id: 'jiedao', count: 1 },
      { id: 'tiesuo', count: 1 },
      { id: 'tao', count: 2 },
    ]);
    press(w, [{ a: 'interact' }], card.id);
    expect(me.hero!.items[3]).toEqual({ id: 'sha', count: 5 });
    expect(card.alive).toBe(true);
    expect(card.loot!.count).toBe(2);
    expect(loots(w).find((l) => l.loot!.itemId === 'tao')?.loot!.count).toBe(2);
  });

  it('never swaps a card for itself: the last slot holding ANOTHER card goes', () => {
    const { w, me, card } = scene({ itemId: 'tao' }, [
      { id: 'wugu', count: 1 },
      { id: 'jiedao', count: 1 },
      { id: 'tiesuo', count: 1 },
      { id: 'tao', count: 3 },
    ]);
    press(w, [{ a: 'interact' }], card.id);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', 'taox1', 'taox3']);
    expect(loots(w).some((l) => l.loot!.itemId === 'tiesuo')).toBe(true);
  });

  it('four full stacks of that very card: F does nothing, the card stays on the ground', () => {
    const full = [0, 1, 2, 3].map(() => ({ id: 'tao', count: 3 }));
    const { w, me, card } = scene({ itemId: 'tao' }, full);
    press(w, [{ a: 'interact' }], card.id);
    expect(ids(me.hero!.items)).toEqual(['taox3', 'taox3', 'taox3', 'taox3']);
    expect(card.alive).toBe(true);
    expect(loots(w)).toHaveLength(1);
  });

  it('walking over a card with a full bar never swaps (only an explicit F does)', () => {
    const { w, me, card } = scene({ itemId: 'tao' });
    place(w, me, card.pos.x, card.pos.z, 0);
    stepN(w, 20);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', 'tiesuox1', 'wuxiex1']);
    expect(card.alive).toBe(true);
  });

  it('the HUD prompt names the slot the sim swaps (ui/hud/logic.ts mirrors sim/inventory.ts)', () => {
    const cases: [(ItemStack | null)[], string][] = [
      [[{ id: 'a', count: 1 }, { id: 'b', count: 1 }, { id: 'c', count: 1 }, { id: 'd', count: 1 }], 'tao'],
      [[{ id: 'a', count: 1 }, { id: 'b', count: 1 }, { id: 'c', count: 1 }, { id: 'tao', count: 3 }], 'tao'],
      [[{ id: 'tao', count: 3 }, { id: 'tao', count: 3 }, { id: 'tao', count: 3 }, { id: 'tao', count: 3 }], 'tao'],
      [[{ id: 'a', count: 1 }, { id: 'tao', count: 3 }, { id: 'tao', count: 3 }, { id: 'tao', count: 3 }], 'tao'],
      [[null, null, null, null], 'tao'],
    ];
    for (const [items, id] of cases) expect(hudSwapSlot(items, id)).toBe(itemSwapSlot(items, id));
    expect(itemSwapSlot(cases[0][0], 'tao')).toBe(3);
    expect(itemSwapSlot(cases[1][0], 'tao')).toBe(2);
    expect(itemSwapSlot(cases[2][0], 'tao')).toBe(-1);
    expect(itemSwapSlot(cases[3][0], 'tao')).toBe(0);
  });
});

describe('COMBAT-7: X + slot key discards through the sim drop action', () => {
  it('hold X, press 6: slot 6 is emptied and the card lies at your feet, locked for you', () => {
    const { w, me, card } = scene({ itemId: 'tao' });
    w.removeEntity(card.id); // (a free slot would take it back by walking over it)
    const input = new InputState();
    input.keyDown('KeyX');
    input.keyDown('Digit6');
    const f = input.frame();
    expect(f.actions).toEqual([{ a: 'drop', slot: 2, what: 'item' }]);
    press(w, f.actions);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', '-', 'wuxiex1']);
    const dropped = loots(w).find((l) => l.loot!.itemId === 'tiesuo');
    expect(dropped).toBeDefined();
    expect(lootLockedFor(w, dropped!, me.id)).toBe(true);
    stepN(w, Math.ceil(DROP_LOCK * 30) + 2);
    expect(lootLockedFor(w, dropped!, me.id)).toBe(false);
    // …and X's release does not also order the squad to hold
    input.keyUp('Digit6');
    input.keyUp('KeyX');
    expect(input.frame().actions).toEqual([]);
  });
});
