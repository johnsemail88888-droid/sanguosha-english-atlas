// Bot hints (ItemImplEx.botShouldUse) make sense, and real bots use the
// cards in a quick match without any item implementation throwing.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { Entity, GameEvent } from '../../../src/core/types';
import { ITEMS } from '../../../src/data';
import type { ItemImplEx } from '../../../src/sim/ext';
import { getItem } from '../../../src/sim/items';
import type { World } from '../../../src/sim/world';
import { makeWorld } from '../sim/helpers';
import { ROLES5, aimFrame, chest, feet, hero, place, send, setup } from './helpers';

const impl = (id: string): ItemImplEx => getItem(id) as ItemImplEx;
const should = (w: World, e: Entity, id: string): boolean => impl(id).botShouldUse!(w, e);

/** The bot `a` is fighting `t` (its crosshair target), as a bot brain would set it. */
function fighting(w: World, a: Entity, t: Entity | undefined): void {
  send(w, a, aimFrame(w, a, t ? chest(t) : { x: a.pos.x, y: a.pos.y + 1, z: a.pos.z + 10 }, { aimTargetId: t?.id }));
  w.step();
}

describe('registration', () => {
  it('every item in data/items.ts has an implementation with a bot hint', () => {
    for (const def of ITEMS) {
      const i = impl(def.id);
      expect(i, def.id).toBeDefined();
      expect(typeof i.use, def.id).toBe('function');
      expect(typeof i.botShouldUse, `${def.id} botShouldUse`).toBe('function');
    }
    expect(impl('jiu').usableWhileDowned).toBe(true);
    expect(impl('tao').canRevive).toBe(true);
    for (const def of ITEMS) if (def.id !== 'jiu') expect(impl(def.id).usableWhileDowned ?? false, def.id).toBe(false);
  });
});

describe('botShouldUse', () => {
  it('basic cards: heal when hurt, ammo when low, dodge below the cap, wine to self-revive or with a spare', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 35);
    fighting(w, a, b);
    expect(should(w, a, 'tao')).toBe(false);
    a.hp = a.maxHp * 0.4;
    expect(should(w, a, 'tao')).toBe(true);
    expect(should(w, a, 'sha')).toBe(false);
    a.hero!.weapons[0]!.reserve = 0;
    expect(should(w, a, 'sha')).toBe(true);
    a.hero!.dodgeCharges = 3;
    expect(should(w, a, 'shan')).toBe(false);
    a.hero!.dodgeCharges = 1;
    expect(should(w, a, 'shan')).toBe(true);
    a.hero!.items = [{ id: 'jiu', count: 1 }, null, null, null];
    expect(should(w, a, 'jiu')).toBe(false); // keep the only one for a self-revive
    a.hero!.items = [{ id: 'jiu', count: 2 }, null, null, null];
    expect(should(w, a, 'jiu')).toBe(true);
    a.hero!.items = [{ id: 'jiu', count: 1 }, null, null, null];
    w.dealDamage({ targetId: a.id, amount: 1e4, type: 'true' });
    expect(should(w, a, 'jiu')).toBe(true);
  });

  it('过河拆桥 only against gear worth stripping, in range', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 35);
    fighting(w, a, b);
    expect(should(w, a, 'guohe')).toBe(false);
    b.hero!.armor = 'renwang';
    expect(should(w, a, 'guohe')).toBe(true);
    place(w, b, 0, 52); // 32 m
    fighting(w, a, b);
    expect(should(w, a, 'guohe')).toBe(false);
  });

  it('顺手牵羊 within 8 m of a hero carrying something', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 26);
    b.hero!.items = [null, null, null, null];
    fighting(w, a, b);
    expect(should(w, a, 'shunshou')).toBe(false);
    b.hero!.items = [{ id: 'tao', count: 1 }, null, null, null];
    expect(should(w, a, 'shunshou')).toBe(true);
    place(w, b, 0, 32);
    fighting(w, a, b);
    expect(should(w, a, 'shunshou')).toBe(false);
  });

  it('决斗: any fair fight when healthy, finishing a weak foe — never from behind or out of range', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 32);
    fighting(w, a, b);
    expect(should(w, a, 'juedou')).toBe(true); // even and healthy
    b.hp = b.maxHp * 0.5;
    expect(should(w, a, 'juedou')).toBe(true);
    a.hp = a.maxHp * 0.32;
    expect(should(w, a, 'juedou')).toBe(false); // hurt, foe not beaten down
    b.hp = b.maxHp * 0.2;
    expect(should(w, a, 'juedou')).toBe(true); // finish it
    a.hp = a.maxHp;
    b.hp = b.maxHp;
    b.shield = b.maxHp; // far more HP + shield than us
    expect(should(w, a, 'juedou')).toBe(false);
    b.shield = 0;
    place(w, b, 0, 42); // 22 m
    fighting(w, a, b);
    expect(should(w, a, 'juedou')).toBe(false);
  });

  it('借刀杀人 needs a squad to hack and someone to turn it on', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 45);
    fighting(w, a, b);
    expect(should(w, a, 'jiedao')).toBe(false);
    w.spawnTroops(b.id, 'qun_raider', 3, { x: 3, y: 0, z: 47 });
    place(w, c, 5, 50);
    fighting(w, a, b);
    expect(should(w, a, 'jiedao')).toBe(true);
  });

  it('无懈可击 when a hero fight is on and no charge is up', () => {
    const { w, a, b } = setup();
    fighting(w, a, undefined);
    expect(should(w, a, 'wuxie')).toBe(false);
    place(w, b, 0, 40);
    fighting(w, a, b);
    expect(should(w, a, 'wuxie')).toBe(true);
    w.applyStatus(a.id, 'nullify', 20, { sourceId: a.id });
    expect(should(w, a, 'wuxie')).toBe(false);
  });

  it('万箭齐发 on clusters or pinned heroes, 铁索连环 on packs', () => {
    const { w, a, b, c } = setup();
    place(w, b, 0, 45);
    fighting(w, a, b);
    expect(should(w, a, 'wanjian')).toBe(false);
    expect(should(w, a, 'tiesuo')).toBe(false);
    w.applyStatus(b.id, 'root', 3, { sourceId: a.id });
    expect(should(w, a, 'wanjian')).toBe(true);
    w.removeStatus(b.id, 'root');
    // b's squad and c (who shot us) crowd around b
    w.spawnTroops(b.id, 'qun_raider', 2, { x: 2, y: 0, z: 46 });
    place(w, c, -2, 45);
    w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 5, type: 'normal', weaponId: 'pistol' });
    w.dealDamage({ targetId: a.id, sourceId: c.id, amount: 5, type: 'normal', weaponId: 'pistol' });
    fighting(w, a, b);
    expect(should(w, a, 'wanjian')).toBe(true);
    expect(should(w, a, 'tiesuo')).toBe(true);
  });

  it('桃园结义 when it helps us more than the enemy', () => {
    const { w, a, b } = setup();
    fighting(w, a, undefined);
    expect(should(w, a, 'taoyuan')).toBe(false); // not hurt
    a.hp = a.maxHp - 150;
    expect(should(w, a, 'taoyuan')).toBe(true);
    place(w, b, 0, 28);
    b.hp = b.maxHp - 200;
    fighting(w, a, b);
    expect(should(w, a, 'taoyuan')).toBe(false); // would patch up our foe
  });

  it('五谷丰登 / 无中生有 / 征兵令 when calm; not in a close firefight', () => {
    const { w, a, b } = setup();
    fighting(w, a, undefined);
    expect(should(w, a, 'wugu')).toBe(true);
    expect(should(w, a, 'wuzhong')).toBe(true);
    expect(should(w, a, 'zhengbing')).toBe(true);
    place(w, b, 0, 30);
    w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 5, type: 'normal', weaponId: 'pistol' });
    fighting(w, a, b);
    expect(should(w, a, 'wugu')).toBe(false);
    expect(should(w, a, 'wuzhong')).toBe(false);
    expect(should(w, a, 'zhengbing')).toBe(false);
  });

  it('征兵令: refills below the cap; over it only before a fight or when the card just takes up room', () => {
    const { w, a, b } = setup();
    w.spawnTroops(a.id, 'qun_raider', 4); // at the cap (4)
    a.hero!.items = [{ id: 'zhengbing', count: 1 }, null, null, null];
    fighting(w, a, undefined);
    expect(should(w, a, 'zhengbing')).toBe(false); // calm, squad full, bag has room
    a.hero!.items = [{ id: 'zhengbing', count: 1 }, { id: 'tao', count: 1 }, { id: 'sha', count: 1 }, null];
    expect(should(w, a, 'zhengbing')).toBe(true); // bag nearly full
    a.hero!.items = [{ id: 'zhengbing', count: 2 }, null, null, null];
    expect(should(w, a, 'zhengbing')).toBe(true); // a full stack
    a.hero!.items = [{ id: 'zhengbing', count: 1 }, null, null, null];
    place(w, b, 0, 50); // a foe in sight 30 m out, not shooting yet
    fighting(w, a, b);
    expect(should(w, a, 'zhengbing')).toBe(true);
    w.spawnTroops(a.id, 'qun_raider', 2); // cap + 2: no room at all
    expect(should(w, a, 'zhengbing')).toBe(false);
  });

  it('火攻 not at point-blank; 南蛮入侵 against a hero; 闪电 from a safe distance', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 23);
    fighting(w, a, b);
    expect(should(w, a, 'huogong')).toBe(false);
    expect(should(w, a, 'shandian')).toBe(false);
    expect(should(w, a, 'nanman')).toBe(true);
    place(w, b, 0, 32);
    fighting(w, a, b);
    expect(should(w, a, 'huogong')).toBe(true);
    expect(should(w, a, 'shandian')).toBe(true);
    fighting(w, a, undefined);
    expect(should(w, a, 'nanman')).toBe(false);
  });

  it('traps when an enemy hero charges in (or while fleeing hurt) — delayed.test.ts has the spots', () => {
    const { w, a, b } = setup();
    place(w, b, 0, 30);
    fighting(w, a, b);
    expect(should(w, a, 'lebusishu')).toBe(false);
    b.vel.z = -5; // running at a
    expect(should(w, a, 'lebusishu')).toBe(true);
    expect(should(w, a, 'bingliang')).toBe(true);
    b.vel.z = 0;
    a.hp = a.maxHp * 0.3;
    w.dealDamage({ targetId: a.id, sourceId: b.id, amount: 5, type: 'normal', weaponId: 'pistol' });
    expect(should(w, a, 'bingliang')).toBe(true);
  });
});

// Every card whose hint says "yes" must really be usable at that moment: a
// hint that fires while use() refuses (keeps the card) makes a bot retry and
// back off forever. Drives each item through the input path, no AI planner.
interface Case {
  id: string;
  count?: number;
  /** set the scene; returns what a bot would aim at (point, optional entity) */
  scene(w: World, a: Entity, b: Entity, c: Entity): { at: Vec3; target?: Entity };
}

const aimB = (w: World, a: Entity, b: Entity, dz = 32): { at: Vec3; target: Entity } => {
  place(w, b, 0, dz);
  fighting(w, a, b);
  return { at: chest(b), target: b };
};
const calm = (w: World, a: Entity): { at: Vec3 } => {
  fighting(w, a, undefined);
  return { at: { x: a.pos.x, y: a.pos.y + 1, z: a.pos.z + 10 } };
};

const CASES: Case[] = [
  { id: 'sha', scene: (w, a, b) => ((a.hero!.weapons[0]!.reserve = 0), aimB(w, a, b)) },
  { id: 'shan', scene: (w, a, b) => ((a.hero!.dodgeCharges = 1), aimB(w, a, b)) },
  { id: 'tao', scene: (w, a) => ((a.hp = a.maxHp * 0.4), calm(w, a)) },
  { id: 'jiu', count: 2, scene: (w, a, b) => aimB(w, a, b) },
  { id: 'wuzhong', scene: (w, a) => calm(w, a) },
  { id: 'guohe', scene: (w, a, b) => ((b.hero!.armor = 'renwang'), { ...aimB(w, a, b), at: feet(b) }) },
  { id: 'shunshou', scene: (w, a, b) => ((b.hero!.items = [{ id: 'tao', count: 1 }, null, null, null]), aimB(w, a, b, 26)) },
  { id: 'juedou', scene: (w, a, b) => aimB(w, a, b) },
  {
    id: 'jiedao',
    scene: (w, a, b, c) => {
      place(w, c, 5, 50);
      w.spawnTroops(b.id, 'qun_raider', 3, { x: 3, y: 0, z: 47 });
      return aimB(w, a, b, 45);
    },
  },
  { id: 'wuxie', scene: (w, a, b) => aimB(w, a, b) },
  { id: 'nanman', scene: (w, a, b) => ({ ...aimB(w, a, b), at: feet(b) }) },
  { id: 'wanjian', scene: (w, a, b) => (w.applyStatus(b.id, 'root', 5, { sourceId: a.id }), { ...aimB(w, a, b), at: feet(b) }) },
  { id: 'taoyuan', scene: (w, a) => ((a.hp = a.maxHp - 150), calm(w, a)) },
  { id: 'wugu', scene: (w, a) => calm(w, a) },
  { id: 'huogong', scene: (w, a, b) => ({ ...aimB(w, a, b), at: feet(b) }) },
  {
    id: 'tiesuo',
    scene: (w, a, b) => {
      w.spawnTroops(b.id, 'qun_raider', 2, { x: 2, y: 0, z: 33 });
      return { ...aimB(w, a, b), at: feet(b) };
    },
  },
  {
    id: 'lebusishu',
    scene: (w, a, b) => {
      const r = aimB(w, a, b, 36);
      b.vel.z = -5;
      return r;
    },
  },
  {
    id: 'bingliang',
    scene: (w, a, b) => {
      const r = aimB(w, a, b, 36);
      a.vel.z = -4;
      return r;
    },
  },
  { id: 'shandian', scene: (w, a, b) => ({ ...aimB(w, a, b), at: feet(b) }) },
  { id: 'zhengbing', scene: (w, a) => calm(w, a) },
];

describe('hint ⇒ usable', () => {
  it('covers every item', () => {
    expect(CASES.map((c) => c.id).sort()).toEqual(ITEMS.map((d) => d.id).sort());
  });
  for (const k of CASES) {
    it(`${k.id}: when the hint says yes, the card is really used`, () => {
      const { w, a, b, c } = setup();
      a.hero!.items = [{ id: k.id, count: k.count ?? 1 }, null, null, null];
      const { at, target } = k.scene(w, a, b, c);
      expect(should(w, a, k.id), `${k.id} hint`).toBe(true);
      w.drainEvents();
      send(w, a, aimFrame(w, a, at, { aimTargetId: target?.id }), [{ a: 'item', slot: 0 }]);
      w.step();
      const useTime = ITEMS.find((d) => d.id === k.id)!.useTime;
      for (let i = 0; i < Math.ceil((useTime + 0.1) * 30); i++) {
        send(w, a, aimFrame(w, a, at, { aimTargetId: target?.id }));
        w.step();
      }
      const used = (w.drainEvents() as GameEvent[]).some((e) => e.t === 'itemUse' && e.who === a.id && e.item === k.id);
      expect(used, `${k.id} used`).toBe(true);
    });
  }
});

describe('bots with cards', () => {
  it('a short all-bot skirmish: cards get played and no item implementation throws', () => {
    const warnings: string[] = [];
    const w = makeWorld(ROLES5, { humans: [], settings: { botDifficulty: 'hard' }, onWarn: (m) => warnings.push(m) });
    // everyone starts close together, loaded with cards
    const decks = [
      ['guohe', 'huogong', 'wuxie', 'tao'],
      ['juedou', 'wanjian', 'tiesuo', 'shandian'],
      ['shunshou', 'nanman', 'lebusishu', 'jiu'],
      ['jiedao', 'bingliang', 'taoyuan', 'zhengbing'],
      ['wuzhong', 'wugu', 'huogong', 'shan'],
    ];
    for (let s = 0; s < 5; s++) {
      const e = hero(w, s);
      place(w, e, Math.cos(s * 1.26) * 12, 30 + Math.sin(s * 1.26) * 12);
      e.hero!.items = decks[s].map((id) => ({ id, count: 1 }));
      e.hero!.armor = s % 2 ? 'renwang' : null;
    }
    const used = new Set<string>();
    for (let i = 0; i < 30 * 90 && !w.result(); i++) {
      // make it a brawl right away: everybody has shot everybody
      if (i === 30) for (const x of w.heroList()) for (const y of w.heroList()) if (x !== y) w.recordAttack(x.id, y.id);
      w.step();
      for (const ev of w.drainEvents() as GameEvent[]) if (ev.t === 'itemUse') used.add(ev.item);
    }
    expect(warnings.filter((m) => /threw|NaN|non-finite/.test(m))).toEqual([]);
    // how many different cards get played is AI tuning (ai/itemUse.ts); the
    // per-card "hint ⇒ usable" cases above pin the item side
    expect(used.size).toBeGreaterThanOrEqual(3);
  });
});
