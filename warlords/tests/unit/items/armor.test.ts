// Armor (防具) and mounts (坐骑) behave as data/items.ts describes. The rules
// live in SIM-CORE's combat.ts / inventory.ts; these tests pin the contract.
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, SIM_HZ, emptyInput } from '../../../src/core/types';
import { AIM_PROFILES } from '../../../src/data/weaponFeel';
import { ARMOR_BY_ID, MOUNTS, MOUNT_BY_ID } from '../../../src/data';
import type { World } from '../../../src/sim/world';
import { TROOP_VS_HERO_MUL } from '../../../src/sim/combat';
import { aimFrame, chest, feet, giveAndUse, place, send, setup, stepN, ticks } from './helpers';

/**
 * Look down the sniper scope at `b` for the class's ADS time (data/weaponFeel.ts): a sniper's
 * aimed spread (0°) is only reached once the scope is up — a same-tick quickscope fires at hip spread.
 */
function scopeIn(w: World, a: Entity, b: Entity): void {
  const n = Math.ceil(AIM_PROFILES.sniper.adsTime * SIM_HZ) + 1;
  for (let i = 0; i < n; i++) {
    w.setInput(a.hero!.playerId, aimFrame(w, a, chest(b), { buttons: BTN_ADS }));
    w.step();
  }
}

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
  it('evades ~30 % of dodgeable bullets — fire / thunder / rocket direct hits too; never ability hits, splash, melee or undodgeable rounds', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'bagua';
    const p = ARMOR_BY_ID.bagua.params.chance;
    expect(p).toBe(0.3);
    const rate = (req: { amount: number; type: 'normal' | 'fire' | 'thunder' | 'explosive'; weaponId: string }, n = 2000): number => {
      let dodged = 0;
      for (let i = 0; i < n; i++) if (w.dealDamage({ targetId: b.id, sourceId: a.id, ...req }).blocked === 'dodge') dodged++;
      return dodged / n;
    };
    for (const req of [
      { amount: 1, type: 'normal', weaponId: 'pistol' },
      { amount: 1, type: 'fire', weaponId: 'zhuque' },
      { amount: 1, type: 'thunder', weaponId: 'taiping' },
      { amount: 1, type: 'explosive', weaponId: 'guanshi' },
    ] as const) {
      const r = rate(req);
      expect(r, req.weaponId).toBeGreaterThan(p - 0.04);
      expect(r, req.weaponId).toBeLessThan(p + 0.04);
    }
    for (let i = 0; i < 100; i++) {
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', abilityId: 'x' }).blocked).toBeUndefined();
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'fire', abilityId: 'huogong' }).blocked).toBeUndefined();
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'normal', weaponId: 'pistol', canDodge: false }).blocked).toBeUndefined();
      // an explosion's area damage is not a bullet (sim/damageKinds.ts)
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 1, type: 'explosive', weaponId: 'guanshi', splash: true }).blocked).toBeUndefined();
    }
  });
});

describe('仁王盾 renwang', () => {
  it('−40 % bullet damage from the front 90° only', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'renwang';
    // a is at −z of b: b facing −z (yaw 0) looks straight at a
    const at = (deg: number): number => {
      b.yaw = (deg * Math.PI) / 180;
      return bullet(w, a.id, b.id, 100).dealt;
    };
    expect(at(0)).toBeCloseTo(60, 5);
    expect(at(40)).toBeCloseTo(60, 5); // inside the 45° half-arc
    expect(at(-40)).toBeCloseTo(60, 5);
    expect(at(50)).toBeCloseTo(100, 5);
    expect(at(180)).toBeCloseTo(100, 5);
    b.yaw = 0;
    // every weapon's direct hit is a bullet: a thunder round or a rocket striking the shield too
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'thunder', weaponId: 'taiping' }).dealt).toBeCloseTo(60, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'explosive', weaponId: 'guanshi' }).dealt).toBeCloseTo(60, 5);
    // not bullets: blasts (a weapon's splash included) and ability hits go straight through the shield
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'explosive', abilityId: 'x' }).dealt).toBeCloseTo(100, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'explosive', weaponId: 'guanshi', splash: true }).dealt).toBeCloseTo(100, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', abilityId: 'x' }).dealt).toBeCloseTo(100, 5);
  });

  it("also blocks soldiers' bullets from the front", () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'renwang';
    b.yaw = 0;
    const [t] = w.spawnTroops(a.id, 'shu_rifleman', 1, { x: 0, y: 0, z: 25 });
    // (a soldier's hit on a hero lands at TROOP_VS_HERO_MUL — 「一下就死了」)
    expect(w.dealDamage({ targetId: b.id, sourceId: t.id, amount: 40, type: 'normal', weaponId: 'troop_rifle' }).dealt).toBeCloseTo(24 * TROOP_VS_HERO_MUL, 5);
  });
});

describe('藤甲 tengjia', () => {
  it('−30 % hero bullets, immune to soldier / NPC / turret bullets, fire ×1.75', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'tengjia';
    expect(bullet(w, a.id, b.id, 100).dealt).toBeCloseTo(70, 5);
    // a thunder round's direct hit is a bullet (×0.7); a fire bullet meets only the fire × (no reduction)
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'thunder', weaponId: 'taiping', canDodge: false }).dealt).toBeCloseTo(70, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'fire', weaponId: 'zhuque', canDodge: false }).dealt).toBeCloseTo(175, 5);
    // a rocket's direct hit is reduced, its splash is not
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'explosive', weaponId: 'guanshi' }).dealt).toBeCloseTo(70, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 100, type: 'explosive', weaponId: 'guanshi', splash: true }).dealt).toBeCloseTo(100, 5);
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
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'fire', abilityId: 'x' }).dealt).toBeCloseTo(87.5, 5);
    expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 50, type: 'explosive', abilityId: 'x' }).dealt).toBeCloseTo(50, 5);
    // soldiers' melee / blasts are not bullets
    expect(w.dealDamage({ targetId: b.id, sourceId: t.id, amount: 30, type: 'melee' }).dealt).toBeCloseTo(30 * TROOP_VS_HERO_MUL, 5);
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

describe('bullets vs melee (sim/damageKinds.ts)', () => {
  it("a soldier's melee blow is never a bullet: 藤甲 / 八卦 / 仁王 let it through unreduced, never dodged", () => {
    // the same 20 blows from a soldier the hero faces (仁王's front arc), fresh troop heat each time
    const land = (armor: string | null): { dealt: number; blocked: number } => {
      const { w, a, b } = duel();
      b.hero!.armor = armor;
      const [t] = w.spawnTroops(a.id, 'shu_rifleman', 1, { x: b.pos.x, y: 0, z: b.pos.z - 1.5 });
      b.yaw = Math.atan2(-(t.pos.x - b.pos.x), -(t.pos.z - b.pos.z));
      let dealt = 0;
      let blocked = 0;
      for (let i = 0; i < 20; i++) {
        const r = w.dealDamage({ targetId: b.id, sourceId: t.id, amount: 10, type: 'melee', weaponId: 'troop_melee' });
        dealt += r.dealt;
        if (r.blocked) blocked++;
      }
      return { dealt, blocked };
    };
    const none = land(null);
    expect(none.dealt).toBeGreaterThan(0);
    for (const armor of ['tengjia', 'bagua', 'renwang']) {
      const r = land(armor);
      expect(r.blocked, armor).toBe(0);
      expect(r.dealt, armor).toBeCloseTo(none.dealt, 6);
    }
  });
});

describe('白银狮子 baiyin', () => {
  it('caps any single hit at 80 (bullets, blasts, fire, thunder); the zone is not capped', () => {
    const { w, a, b } = duel();
    b.hero!.armor = 'baiyin';
    const cap = ARMOR_BY_ID.baiyin.params.cap;
    expect(cap).toBe(80);
    expect(bullet(w, a.id, b.id, 145, 'qilin').dealt).toBe(cap);
    for (const type of ['explosive', 'fire', 'thunder', 'melee'] as const) {
      expect(w.dealDamage({ targetId: b.id, sourceId: a.id, amount: 250, type, abilityId: 'x' }).dealt).toBe(cap);
    }
    expect(bullet(w, a.id, b.id, 40).dealt).toBe(40);
    expect(w.dealDamage({ targetId: b.id, amount: 200, type: 'zone' }).dealt).toBe(200);
  });

  it("the 'hit' event says what the armor took (soak): the HUD's blue number and the armor tick key on it", () => {
    const { w, a, b } = duel();
    const soakOf = (armor: string, req: Parameters<World['dealDamage']>[0]): number | undefined => {
      b.hero!.armor = armor;
      w.drainEvents();
      w.dealDamage(req);
      const ev = w.drainEvents().find((e) => e.t === 'hit' && e.target === b.id);
      return ev && ev.t === 'hit' ? ev.soak : undefined;
    };
    // 藤甲 −30 % on a hero bullet; 白银 over its cap: soaked
    expect(soakOf('tengjia', { targetId: b.id, sourceId: a.id, amount: 100, type: 'normal', weaponId: 'pistol' })).toBeCloseTo(30, 1);
    expect(soakOf('baiyin', { targetId: b.id, sourceId: a.id, amount: 145, type: 'normal', weaponId: 'qilin' })).toBeCloseTo(65, 1);
    // nothing taken off: 青釭 (ignoreArmor) through 藤甲, 白银 under its cap, 八卦 (it dodges or lets it through whole), fire on 藤甲 (×1.75)
    expect(soakOf('tengjia', { targetId: b.id, sourceId: a.id, amount: 46, type: 'normal', weaponId: 'qinggang', ignoreArmor: true })).toBeUndefined();
    expect(soakOf('baiyin', { targetId: b.id, sourceId: a.id, amount: 40, type: 'normal', weaponId: 'pistol' })).toBeUndefined();
    expect(soakOf('bagua', { targetId: b.id, sourceId: a.id, amount: 13, type: 'normal', weaponId: 'smg', canDodge: false })).toBeUndefined();
    expect(soakOf('tengjia', { targetId: b.id, sourceId: a.id, amount: 20, type: 'fire', weaponId: 'zhuque' })).toBeUndefined();
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
    scopeIn(w, a, b);
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
    scopeIn(w, a, b);
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
