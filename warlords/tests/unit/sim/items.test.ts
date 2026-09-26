import { describe, expect, it } from 'vitest';
import type { Entity, InputAction, InputFrame } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, emptyInput } from '../../../src/core/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import { maxReserve, weaponDef } from '../../../src/sim/defs';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

let seq = 100;
function act(w: World, player: string, actions: InputAction[], p: Partial<InputFrame> = {}): void {
  w.setInput(player, { ...emptyInput(seq++), ...p, actions });
}

function setup(): { w: World; a: Entity } {
  const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor']);
  [0, 1, 2, 3, 4].forEach((i) => place(w, hero(w, i), i * 8 - 40, 50));
  const a = hero(w, 2);
  place(w, a, 0, 30);
  w.step();
  w.drainEvents();
  return { w, a };
}

describe('basic cards', () => {
  it('杀 refills 50 % reserve and is not consumed when full', () => {
    const { w, a } = setup();
    const wi = a.hero!.weapons[0]!;
    const max = maxReserve(weaponDef(wi.id));
    a.hero!.items = [{ id: 'sha', count: 2 }, null, null, null];
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    stepN(w, 30);
    expect(a.hero!.items[0]?.count).toBe(2); // full reserve: nothing to do
    wi.reserve = 0;
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    stepN(w, 30);
    expect(wi.reserve).toBe(Math.ceil(max * 0.5));
    expect(a.hero!.items[0]?.count).toBe(1);
  });

  it('闪 adds a dodge charge up to 3', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'shan', count: 3 }, null, null, null];
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    w.step();
    expect(a.hero!.dodgeCharges).toBe(3);
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    w.step();
    expect(a.hero!.dodgeCharges).toBe(3);
    expect(a.hero!.items[0]?.count).toBe(2);
  });

  it('桃 heals after its channel; moving is allowed at half speed; firing cancels it', () => {
    const { w, a } = setup();
    a.hp = 100;
    a.hero!.items = [{ id: 'tao', count: 2 }, null, null, null];
    act(w, 'p2', [{ a: 'item', slot: 0 }], { moveZ: 1 });
    const z0 = a.pos.z;
    stepN(w, 20);
    expect(a.hero!.channel?.kind).toBe('item');
    const moved = z0 - a.pos.z;
    expect(moved).toBeGreaterThan(0.5);
    expect(moved).toBeLessThan(5 * 0.55 * (20 / 30) + 0.2);
    stepN(w, 20);
    expect(a.hp).toBe(220);
    expect(a.hero!.items[0]?.count).toBe(1);
    // start again, then shoot → cancelled, item kept
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    stepN(w, 5);
    expect(a.hero!.channel).not.toBeNull();
    const target = { x: 0, y: 1, z: 10 };
    const ang = aimAnglesFor(a.pos, target);
    w.setInput('p2', { ...emptyInput(seq++), yaw: ang.yaw, pitch: ang.pitch, buttons: BTN_FIRE | BTN_ADS, aimPoint: target });
    w.step();
    expect(a.hero!.channel).toBeNull();
    stepN(w, 40);
    expect(a.hero!.items[0]?.count).toBe(1);
  });

  it('桃 used next to a downed ally in front of you revives them', () => {
    const { w, a } = setup();
    const ally = hero(w, 3);
    place(w, ally, 0, 28.5);
    w.dealDamage({ targetId: ally.id, amount: 1e4, type: 'true' });
    expect(ally.hero!.downed).toBe(true);
    a.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    act(w, 'p2', [{ a: 'item', slot: 0 }], { yaw: 0 });
    stepN(w, 60);
    expect(ally.hero!.downed).toBe(false);
    expect(ally.hp).toBe(100);
    expect(a.hero!.stats.rescues).toBe(1);
  });

  it('酒 makes your next hit deal double damage for 8 s', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'jiu', count: 1 }, null, null, null];
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    stepN(w, 20);
    expect(w.hasStatus(a.id, 'drunk')).toBe(true);
    expect(w.statusParam(a.id, 'drunk', 'mul', 0)).toBe(2);
  });

  it('items without an implementation are not consumed', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'no_such_card', count: 1 }, null, null, null];
    act(w, 'p2', [{ a: 'item', slot: 0 }]);
    stepN(w, 5);
    expect(a.hero!.items[0]?.count).toBe(1);
  });
});

describe('loot & pickups', () => {
  it('walking over consumables picks them up when a slot/stack is free', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'tao', count: 1 }, { id: 'shan', count: 1 }, { id: 'jiu', count: 1 }, { id: 'sha', count: 1 }];
    const loot = w.spawnLoot({ x: 0, y: 0, z: 29 }, { itemId: 'tao', count: 1 });
    const loot2 = w.spawnLoot({ x: 0.5, y: 0, z: 29 }, { itemId: 'wuzhong', count: 1 });
    w.step();
    expect(a.hero!.items[0]).toEqual({ id: 'tao', count: 2 }); // stacked
    expect(w.get(loot.id)).toBeUndefined();
    expect(w.get(loot2.id)).toBeDefined(); // no free slot
  });

  it('weapons, armor and mounts need F, and swap by dropping the old one', () => {
    const { w, a } = setup();
    const old = a.hero!.weapons[0]!;
    old.mag = 7;
    const gun = w.spawnLoot({ x: 0, y: 0, z: 29 }, { weaponId: 'zhangba' });
    stepN(w, 3);
    expect(w.get(gun.id)).toBeDefined(); // not auto-picked
    act(w, 'p2', [{ a: 'interact' }], { yaw: 0 });
    w.step();
    expect(a.hero!.weapons[0]!.id).toBe('zhangba');
    expect(a.hero!.weapons[0]!.mag).toBe(weaponDef('zhangba').magSize);
    const dropped = w.kindList('loot').find((l) => l.loot?.weaponId === old.id)!;
    expect(dropped.loot!.mag).toBe(7);
    w.removeEntity(dropped.id);
    // armor
    a.hero!.armor = 'renwang';
    w.spawnLoot({ x: 0.3, y: 0, z: 29 }, { itemId: 'bagua' });
    act(w, 'p2', [{ a: 'interact' }], { yaw: 0 });
    w.step();
    expect(a.hero!.armor).toBe('bagua');
    expect(w.kindList('loot').some((l) => l.loot?.itemId === 'renwang')).toBe(true);
  });

  it('drop action drops items and weapons, but never your last weapon', () => {
    const { w, a } = setup();
    a.hero!.items = [{ id: 'shan', count: 2 }, null, null, null];
    act(w, 'p2', [{ a: 'drop', slot: 0, what: 'item' }]);
    w.step();
    expect(a.hero!.items[0]).toBeNull();
    const l = w.kindList('loot').find((x) => x.loot?.itemId === 'shan')!;
    expect(l.loot!.count).toBe(2);
    act(w, 'p2', [{ a: 'drop', slot: 1, what: 'weapon' }]);
    w.step();
    expect(a.hero!.weapons[1]).toBeNull();
    act(w, 'p2', [{ a: 'drop', slot: 0, what: 'weapon' }]);
    w.step();
    expect(a.hero!.weapons[0]).not.toBeNull();
  });

  it('crates open with a short F channel and scatter their loot', () => {
    const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor'], { ambient: true });
    const a = hero(w, 2);
    const crate = w.kindList('crate').find((c) => Math.hypot(c.pos.x + 5, c.pos.z - 40) < 1)!;
    expect(crate).toBeDefined();
    place(w, a, -5, 41.5);
    w.step();
    const before = w.kindList('loot').length;
    act(w, 'p2', [{ a: 'interact' }], { yaw: 0 });
    w.step();
    expect(a.hero!.channel?.kind).toBe('open');
    stepN(w, 20);
    expect(crate.crate!.opened).toBe(true);
    expect(w.kindList('loot').length + a.hero!.items.filter(Boolean).length).toBeGreaterThan(before);
  });

  it('airdrops arrive every 100 s from 2:00 and fall for 12 s', () => {
    const w = makeWorld(['lord', 'loyalist', 'rebel', 'rebel', 'traitor'], { airdrops: true });
    while (w.time < 119.9) w.step();
    expect(w.kindList('airdrop').length).toBe(0);
    w.drainEvents();
    stepN(w, 3);
    const drops = w.kindList('airdrop');
    expect(drops.length).toBe(1);
    expect(w.drainEvents().some((e) => e.t === 'airdrop' && e.id === drops[0].id)).toBe(true);
    expect(drops[0].onGround).toBe(false);
    stepN(w, 30 * 11);
    expect(drops[0].onGround).toBe(false);
    stepN(w, 40);
    expect(drops[0].onGround).toBe(true);
    while (w.time < 220.1) w.step();
    expect(w.kindList('airdrop').length).toBe(2);
  });

  it('giveItem stacks up to maxStack and uses free slots', () => {
    const { w, a } = setup();
    a.hero!.items = [null, null, null, null];
    expect(w.giveItem(a.id, 'tao', 4)).toBe(true);
    expect(a.hero!.items[0]).toEqual({ id: 'tao', count: 3 });
    expect(a.hero!.items[1]).toEqual({ id: 'tao', count: 1 });
    expect(w.giveItem(a.id, 'unknown_thing', 1)).toBe(false);
  });
});
