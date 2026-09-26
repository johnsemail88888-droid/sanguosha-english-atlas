// Armor (防具) and mounts (坐骑) behave as data/items.ts describes. The rules
// live in SIM-CORE's combat.ts / inventory.ts; these tests pin the contract.
import { describe, expect, it } from 'vitest';
import { BTN_ADS, BTN_FIRE, emptyInput } from '../../../src/core/types';
import { ARMOR_BY_ID, MOUNTS, MOUNT_BY_ID } from '../../../src/data';
import type { World } from '../../../src/sim/world';
import { aimFrame, chest, feet, giveAndUse, place, send, setup, stepN, ticks } from './helpers';

function duel(): ReturnType<typeof setup> {
  const s = setup();
  place(s.w, s.b, 0, 40); // 20 m in front of a
  s.w.step();
  s.b.maxHp = 1e6;
  s.b.hp = 1e6;
  return s;
}

const bullet = (w: World, from: number, to: number, amount = 100, weaponId = 'pistol') =>
  w.dealDamage({ targetId: to, sourceId: from, amount, type: 'normal', weaponId });

describe('八卦阵 bagua', () => {
  it('evades ~35 % of dodgeable bullets; never ability hits, fire, or undodgeable rounds', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'bagua';
    const p = ARMOR_BY_ID.bagua.params.chance;
    let dodged = 0;
    for (let i = 0; i < 2000; i++) if (bullet(w, a.id, b.id, 1).blocked === 'dodge') dodged++;
    expect(dodged / 2000).toBeGreaterThan(p - 0.04);
    expect(dodged / 2000).toBeLessThan(p + 0.04);
    for (let i = 0; i < 100; i++) {
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', abilityId: 'x' }).blocked).toBeUndefined();
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'fire', abilityId: 'huogong' }).blocked).toBeUndefined();
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', weaponId: 'pistol', canDodge: false }).blocked).toBeUndefined();
    }
  });
});

describe('仁王盾 renwang', () => {
  it('−70 % bullet damage from the front 90° only', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'renwang';
    // a is at −z of b: b facing −z (yaw 0) looks straight at a
    const at = (deg: number): number => {
      b.yaw = (deg * Math.PI) / 180;
      return bullet(w, a.id, b.id, 100).dealt;
    };
    expect(at(0)).toBeCloseTo(30, 5);
    expect(at(40)).toBeCloseTo(30, 5); // inside the 45° half-arc
    expect(at(-40)).toBeCloseTo(30, 5);
    expect(at(50)).toBeCloseTo(100, 5);
    expect(at(180)).toBeCloseTo(100, 5);
    // not bullets: blasts and ability hits go straight through the shield
    b.yaw = 0;
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'explosive', abilityId: 'x' }).dealt).toBeCloseTo(100, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', abilityId: 'x' }).dealt).toBeCloseTo(100, 5);
  });

  it("also blocks soldiers' bullets from the front", () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'renwang';
    b.yaw = 0;
    const [t] = w.spawnTroops(a.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 25 });
    expect(w.dealDamage({ targetId: b.id, sourceId: t.id, amount: 40, type: 'normal', weaponId: 'troop_rifle' }).dealt).toBeCloseTo(12, 5);
  });
});

describe('藤甲 tengjia', () => {
  it('−40 % hero bullets, immune to soldier / NPC / turret bullets, fire ×2', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'tengjia';
    expect(bullet(w, a.id, b.id, 100).dealt).toBeCloseTo(60, 5);
    const [t] = w.spawnTroops(a.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 25 });
    const npc = w.spawnNpc('yellowTurban', { x: 5, y: 0, z: 30 });
    const tur = w.spawnTurret(a.id, { x: -5, y: 0, z: 30 }, 'muniu', 'turret_smg', 20, 200);
    for (const [src, wid] of [
      [t, 'troop_rifle'],
      [npc, 'troop_smg'],
      [tur, 'turret_smg'],
    ] as const) {
      const r = w.dealDamage({ targetId: b.id, sourceId: src.id, amount: 30, type: 'normal', weaponId: wid });
      expect(r.dealt).toBe(0);
      expect(r.blocked).toBe('armor');
    }
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'fire', abilityId: 'x' }).dealt).toBeCloseTo(100, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'explosive', abilityId: 'x' }).dealt).toBeCloseTo(50, 5);
    // soldiers' melee / blasts are not bullets
    expect(w.dealDamage({ targetId: b.id, sourceId: t.id, amount: 30, type: 'melee' }).dealt).toBeCloseTo(30, 5);
  });

  it('losing it to an EMP removes the fire weakness', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 35);
    b.hero!.armor = 'tengjia';
    giveAndUse(w, a, 'guohe', feet(b));
    stepN(w, ticks(1.4));
    expect(b.hero!.armor).toBeNull();
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'fire', abilityId: 'x' }).dealt).toBeCloseTo(50, 5);
  });
});

describe('白银狮子 baiyin', () => {
  it('caps any single hit at 60 (bullets, blasts, fire, thunder); the zone is not capped', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'baiyin';
    const cap = ARMOR_BY_ID.baiyin.params.cap;
    expect(bullet(w, a.id, b.id, 145, 'qilin').dealt).toBe(cap);
    for (const type of ['explosive', 'fire', 'thunder', 'melee'] as const) {
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 250, type, abilityId: 'x' }).dealt).toBe(cap);
    }
    expect(bullet(w, a.id, b.id, 40).dealt).toBe(40);
    expect(w.dealDamage({ targetId: b.id, amount: 200, type: 'zone' }).dealt).toBe(200);
  });

  it('heals 100 when stolen by 顺手牵羊 (the thief now wears it)', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 26);
    b.hero!.items = [null, null, null, null];
    b.hero!.armor = 'baiyin';
    b.hp = 100;
    giveAndUse(w, a, 'shunshou', chest(b), b);
    expect(b.hero!.armor).toBeNull();
    expect(b.hp).toBe(200);
    expect(a.hero!.armor).toBe('baiyin');
  });
});

describe('mounts', () => {
  it('multiply incoming damage by damageTakenMul (offense 1.0, defense < 1)', () => {
    const { w, a, b } = duel();
    for (const m of MOUNTS) {
      b.hero!.mount = m.id;
      expect(bullet(w, a.id, b.id, 100).dealt, m.id).toBeCloseTo(100 * m.damageTakenMul, 5);
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'fire', abilityId: 'x' }).dealt, m.id).toBeCloseTo(100 * m.damageTakenMul, 5);
    }
  });

  it('multiply movement speed by speedMul', () => {
    const { w, a } = setup();
    const run = (mount: string | null): number => {
      place(w, a, 0, -40, Math.PI); // open ground, facing +z
      a.hero!.mount = mount;
      for (let i = 0; i < 40; i++) {
        send(w, a, { ...emptyInput(), yaw: Math.PI, moveZ: 1 });
        w.step();
      }
      return Math.hypot(a.vel.x, a.vel.z);
    };
    const base = run(null);
    expect(base).toBeGreaterThan(1);
    for (const m of MOUNTS) expect(run(m.id) / base, m.id).toBeCloseTo(m.speedMul, 2);
    a.hero!.mount = null;
  });

  it('麒麟弓 hits knock the rider off: the mount drops as loot and the rider is slowed', () => {
    const { w, a, b } = duel();
    b.hp = b.maxHp = 400;
    b.hero!.mount = 'chitu';
    a.hero!.weapons[0] = { id: 'qilin', mag: 5, reserve: 20 };
    a.hero!.activeSlot = 0;
    w.setInput(a.hero!.playerId, aimFrame(w, a, chest(b), { buttons: BTN_FIRE | BTN_ADS }));
    w.step();
    expect(b.hero!.mount).toBeNull();
    expect(w.kindList('loot').some((l) => l.loot?.itemId === 'chitu')).toBe(true);
    expect(w.hasStatus(b.id, 'slow')).toBe(true);
    expect(b.hp).toBeLessThan(400);
  });

  it('麒麟弓: the mount is flung 2–3 m off and the rider cannot climb back on for 5 s (COMBAT-2)', () => {
    const { w, a, b } = duel();
    b.hp = b.maxHp = 400;
    b.hero!.mount = 'chitu';
    a.hero!.weapons[0] = { id: 'qilin', mag: 5, reserve: 20 };
    a.hero!.activeSlot = 0;
    w.setInput(a.hero!.playerId, aimFrame(w, a, chest(b), { buttons: BTN_FIRE | BTN_ADS }));
    w.step();
    const horse = w.kindList('loot').find((l) => l.loot?.itemId === 'chitu')!;
    const d = Math.hypot(horse.pos.x - b.pos.x, horse.pos.z - b.pos.z);
    expect(d).toBeGreaterThan(1.9);
    expect(d).toBeLessThan(3.1);
    w.setInput(a.hero!.playerId, { ...emptyInput(), yaw: 0 });
    // the rider walks onto it and presses F: locked
    place(w, b, horse.pos.x, horse.pos.z);
    send(w, b, aimFrame(w, b, feet(horse)), [{ a: 'interact' }]);
    w.step();
    expect(b.hero!.mount).toBeNull();
    stepN(w, ticks(5));
    send(w, b, aimFrame(w, b, feet(horse)), [{ a: 'interact' }]);
    w.step();
    expect(b.hero!.mount).toBe('chitu');
  });

  it('过河拆桥 knocks the rider off too; a hero keeps a single mount (picking another drops the old one)', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 35);
    b.hero!.mount = 'jueying';
    giveAndUse(w, a, 'guohe', feet(b));
    stepN(w, ticks(1.4));
    expect(b.hero!.mount).toBeNull();
    const loot = w.kindList('loot').find((l) => l.loot?.itemId === 'jueying');
    expect(loot).toBeDefined();
    // the rider can climb back on with F
    a.hero!.mount = 'dawan';
    w.equip(a.id, 'zhuahuang');
    expect(a.hero!.mount).toBe('zhuahuang');
    expect(w.kindList('loot').some((l) => l.loot?.itemId === 'dawan')).toBe(true);
    expect(MOUNT_BY_ID.zhuahuang.type).toBe('defense');
  });
});
