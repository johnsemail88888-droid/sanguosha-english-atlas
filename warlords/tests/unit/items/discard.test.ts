// NP-1: a card the hero discarded by choice (X + slot / 丢弃此锦囊) or swapped out with F
// stays on the ground for THAT hero: walking over it never auto-picks it back up (before the
// fix it came back ~3 s later, as soon as DROP_LOCK ran out). Only an explicit F takes it;
// every other hero auto-picks it like any loot.
// NP-2: discarded / swapped-out pieces land beside or in front of the hero — never behind
// him, i.e. never between the hero and the over-the-shoulder camera.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, ItemStack, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { cameraRig } from '../../../src/sim/aim';
import { DROP_LOCK, SWAP_LOCK } from '../../../src/sim/inventory';
import { scatterAround } from '../../../src/sim/loot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
let seq = 1;

const loots = (w: World): Entity[] => [...w.entities()].filter((e) => e.kind === 'loot' && e.alive);
const ids = (items: readonly (ItemStack | null)[]): string[] => items.map((s) => (s ? `${s.id}x${s.count}` : '-'));

/** all seats human (no bot wanders over to the card) */
function scene(yaw = 0): { w: World; me: Entity } {
  const w = makeWorld(STD5);
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
  const me = hero(w, 2);
  place(w, me, 0, 42, yaw);
  me.hero!.items = [
    { id: 'wugu', count: 1 },
    { id: 'jiedao', count: 1 },
    { id: 'tiesuo', count: 1 },
    { id: 'wuxie', count: 1 },
  ];
  // actions run before this tick's aim: settle the facing first
  w.setInput('p2', { ...emptyInput(seq++), yaw, pitch: 0.4 });
  w.step();
  w.drainEvents();
  return { w, me };
}

function press(w: World, pid: string, actions: ReturnType<typeof emptyInput>['actions'], yaw = 0, aimTargetId?: number): GameEvent[] {
  w.setInput(pid, { ...emptyInput(seq++), yaw, pitch: 0.4, aimTargetId, actions });
  w.step();
  return w.drainEvents();
}

/** stand still on top of `l` for `s` seconds (auto-pickup range) */
function standOn(w: World, e: Entity, l: Entity, s: number, pid = 'p2'): void {
  for (let i = 0; i < Math.ceil(s * 30); i++) {
    place(w, e, l.pos.x, l.pos.z, e.yaw);
    w.setInput(pid, { ...emptyInput(seq++), yaw: e.yaw, pitch: 0.4 });
    w.step();
  }
}

/** signed offset of `p` from the hero along his facing (+ = in front) and to his right */
function local(me: Entity, p: { x: number; z: number }): { fwd: number; right: number } {
  const dx = p.x - me.pos.x;
  const dz = p.z - me.pos.z;
  return { fwd: dx * -Math.sin(me.yaw) + dz * -Math.cos(me.yaw), right: dx * Math.cos(me.yaw) + dz * -Math.sin(me.yaw) };
}

describe('NP-1: a discarded card is not auto-picked back up by the hero who dropped it', () => {
  it('X + slot: the card stays on the ground while he stands on it well past DROP_LOCK; F takes it', () => {
    const { w, me } = scene();
    press(w, 'p2', [{ a: 'drop', slot: 2, what: 'item' }]);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', '-', 'wuxiex1']);
    const card = loots(w).find((l) => l.loot!.itemId === 'tiesuo')!;
    expect(card).toBeDefined();
    standOn(w, me, card, DROP_LOCK + 3);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', '-', 'wuxiex1']);
    expect(card.alive).toBe(true);
    // an explicit F on it picks it up
    place(w, me, card.pos.x, card.pos.z + 1.5, 0);
    const evs = press(w, 'p2', [{ a: 'interact' }], 0, card.id);
    expect(evs.some((e) => e.t === 'pickup' && e.who === me.id && e.item === 'tiesuo')).toBe(true);
    expect(card.alive).toBe(false);
    expect(me.hero!.items.filter((s) => s?.id === 'tiesuo')).toHaveLength(1);
  });

  it('another hero walking over the discarded card auto-picks it as usual', () => {
    const { w, me } = scene();
    press(w, 'p2', [{ a: 'drop', slot: 2, what: 'item' }]);
    const card = loots(w).find((l) => l.loot!.itemId === 'tiesuo')!;
    const other = hero(w, 3);
    other.hero!.items = [null, null, null, null];
    place(w, me, -20, 42, 0);
    standOn(w, other, card, 0.5, 'p3');
    expect(card.alive).toBe(false);
    expect(other.hero!.items.some((s) => s?.id === 'tiesuo')).toBe(true);
  });

  it('the card an F-swap drops is not auto-picked back up once a slot frees', () => {
    const { w, me } = scene();
    const ground = w.spawnLoot({ x: 0, y: 0, z: 40.2 }, { itemId: 'tao', count: 1 });
    w.step();
    press(w, 'p2', [{ a: 'interact' }], 0, ground.id);
    expect(ids(me.hero!.items)).toEqual(['wugux1', 'jiedaox1', 'tiesuox1', 'taox1']);
    const old = loots(w).find((l) => l.loot!.itemId === 'wuxie')!;
    expect(old).toBeDefined();
    // a slot frees (e.g. a card used); well past SWAP_LOCK he stands on the swapped-out card
    me.hero!.items[0] = null;
    standOn(w, me, old, SWAP_LOCK + 3);
    expect(old.alive).toBe(true);
    expect(me.hero!.items[0]).toBeNull();
    // explicit F still works
    place(w, me, old.pos.x, old.pos.z + 1.5, 0);
    press(w, 'p2', [{ a: 'interact' }], 0, old.id);
    expect(old.alive).toBe(false);
    expect(me.hero!.items.some((s) => s?.id === 'wuxie')).toBe(true);
  });

  it('a card he picked up again with F and drops a second time is still his discard', () => {
    const { w, me } = scene();
    press(w, 'p2', [{ a: 'drop', slot: 1, what: 'item' }]);
    let card = loots(w).find((l) => l.loot!.itemId === 'jiedao')!;
    stepN(w, Math.ceil(DROP_LOCK * 30) + 2);
    place(w, me, card.pos.x, card.pos.z + 1.5, 0);
    press(w, 'p2', [{ a: 'interact' }], 0, card.id);
    expect(me.hero!.items.some((s) => s?.id === 'jiedao')).toBe(true);
    const slot = me.hero!.items.findIndex((s) => s?.id === 'jiedao');
    press(w, 'p2', [{ a: 'drop', slot, what: 'item' }]);
    card = loots(w).find((l) => l.loot!.itemId === 'jiedao')!;
    standOn(w, me, card, DROP_LOCK + 2);
    expect(card.alive).toBe(true);
  });
});

describe('NP-2: dropped / swapped-out pieces land beside or in front of the hero, never behind him', () => {
  const yaws = [0, 0.7, Math.PI / 2, 2.4, Math.PI, -1.1];

  it('X + slot discard: in front / to the side, clear of the camera ray', () => {
    for (const yaw of yaws) {
      const { w, me } = scene(yaw);
      press(w, 'p2', [{ a: 'drop', slot: 2, what: 'item' }], yaw);
      const card = loots(w).find((l) => l.loot!.itemId === 'tiesuo')!;
      const o = local(me, card.pos);
      expect(o.fwd, `yaw ${yaw}`).toBeGreaterThanOrEqual(-0.05);
      expect(Math.hypot(o.fwd, o.right), `yaw ${yaw}`).toBeGreaterThan(1.1);
      // farther from the camera than the hero himself
      const cam = cameraRig(me.pos, yaw, 0.4).origin;
      expect(Math.hypot(card.pos.x - cam.x, card.pos.z - cam.z)).toBeGreaterThan(Math.hypot(me.pos.x - cam.x, me.pos.z - cam.z));
    }
  });

  it('F-swap of a card with a full bar: the old card lands beside / in front, not behind', () => {
    for (const yaw of yaws) {
      const { w, me } = scene(yaw);
      // the card lies 1.8 m in front of him
      const ground = w.spawnLoot({ x: me.pos.x - Math.sin(yaw) * 1.8, y: 0, z: me.pos.z - Math.cos(yaw) * 1.8 }, { itemId: 'tao', count: 1 });
      w.step();
      press(w, 'p2', [{ a: 'interact' }], yaw, ground.id);
      const old = loots(w).find((l) => l.loot!.itemId === 'wuxie')!;
      expect(old, `yaw ${yaw}`).toBeDefined();
      const o = local(me, old.pos);
      expect(o.fwd, `yaw ${yaw}`).toBeGreaterThanOrEqual(-0.05);
      expect(Math.hypot(o.fwd, o.right)).toBeGreaterThan(1.1);
      expect(Math.hypot(o.fwd, o.right)).toBeLessThan(1.8);
      // clear of where the taken card lay (the next F goes to the next pile piece)
      expect(Math.hypot(old.pos.x - ground.pos.x, old.pos.z - ground.pos.z)).toBeGreaterThan(1.2);
    }
  });

  it('gear swap at a pile in front: the old armor lands to the side, ≥ 1 m from every pile piece', () => {
    const w = makeWorld(STD5);
    STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
    const c = { x: 0, y: 0, z: 40 };
    const what = ['renwang', 'tengjia', 'chitu'];
    const pile = what.map((id, i) => w.spawnLoot(scatterAround(c, i, what.length, 1.3), { itemId: id, count: 1 }));
    const me = hero(w, 2);
    me.hero!.armor = 'bagua';
    place(w, me, 0, 42.2, 0);
    w.setInput('p2', { ...emptyInput(seq++), yaw: 0, pitch: 0.4 });
    w.step();
    press(w, 'p2', [{ a: 'interact' }], 0, pile[1].id);
    expect(me.hero!.armor).toBe('tengjia');
    const dropped = loots(w).find((l) => l.loot!.itemId === 'bagua')!;
    expect(local(me, dropped.pos).fwd).toBeGreaterThanOrEqual(-0.05);
    for (const r of loots(w)) if (r !== dropped) expect(Math.hypot(dropped.pos.x - r.pos.x, dropped.pos.z - r.pos.z)).toBeGreaterThanOrEqual(1);
  });

  it('a wall on one side: the piece goes to the open side (never through the wall)', () => {
    // test map wall: x = 9.5..10.5, z = -5..5, 3 m high. Hero at x = 8.9 facing +z: the wall is on his left
    const w = makeWorld(STD5);
    STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
    const me = hero(w, 2);
    place(w, me, 8.9, -3, Math.PI);
    me.hero!.items = [{ id: 'wugu', count: 1 }, null, null, null];
    w.setInput('p2', { ...emptyInput(seq++), yaw: Math.PI, pitch: 0.4 });
    w.step();
    press(w, 'p2', [{ a: 'drop', slot: 0, what: 'item' }], Math.PI);
    const card = loots(w).find((l) => l.loot!.itemId === 'wugu')!;
    expect(card.pos.x).toBeLessThan(9.4);
    expect(local(me, card.pos).fwd).toBeGreaterThanOrEqual(-0.05);
  });
});
