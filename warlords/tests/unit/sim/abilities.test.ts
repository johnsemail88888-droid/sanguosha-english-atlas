import { describe, expect, it } from 'vitest';
import type { Entity, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HERO_BY_ID } from '../../../src/data';
import { getAbility, hasAbility } from '../../../src/sim/abilities';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { AbilityImplEx } from '../../../src/sim/ext';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from './helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
let seq = 1;

function send(w: World, player: string, actions: InputAction[], p: Partial<InputFrame> = {}): void {
  w.setInput(player, { ...emptyInput(seq++), ...p, actions });
}

function guanyuDuel(): { w: World; g: Entity; foe: Entity } {
  const w = makeWorld(STD5, { heroes: ['dummy', 'dummy', 'guanyu', 'dummy', 'dummy'] });
  STD5.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 55));
  const g = hero(w, 2);
  const foe = hero(w, 3);
  place(w, g, 0, 30);
  place(w, foe, 0, 20);
  w.step();
  w.drainEvents();
  return { w, g, foe };
}

describe('关羽 (reference implementation)', () => {
  it('registers all three abilities from the data', () => {
    for (const a of HERO_BY_ID.guanyu.abilities) expect(hasAbility(a.id)).toBe(true);
    expect(getAbility('guanyu_qinglong')?.activate).toBeTypeOf('function');
  });

  it('青龙斩 dashes forward, sweeps the arc with knockback and starts its cooldown', () => {
    const { w, g, foe } = guanyuDuel();
    const def = HERO_BY_ID.guanyu.abilities.find((a) => a.slot === 'q')!;
    send(w, 'p2', [{ a: 'ability', slot: 'q' }], { yaw: 0 });
    w.step();
    expect(w.drainEvents().some((e) => e.t === 'ability' && e.ability === def.id)).toBe(true);
    expect(w.cooldownLeft(g.id, def.id)).toBeCloseTo(def.cooldown!, 1);
    stepN(w, 20);
    expect(30 - g.pos.z).toBeGreaterThan((def.params.dash ?? 8) * 0.8);
    expect(foe.maxHp - foe.hp).toBeGreaterThanOrEqual((def.params.damage ?? 90) * 1.25 - 1e-6); // 武圣 +25 % melee
    expect(foe.pos.z).toBeLessThan(20); // knocked back
    // on cooldown: a second press does nothing
    const hp = foe.hp;
    send(w, 'p2', [{ a: 'ability', slot: 'q' }], { yaw: 0 });
    stepN(w, 20);
    expect(foe.hp).toBe(hp);
  });

  it('义绝 silences the crosshair target and boosts your damage against it', () => {
    const { w, g, foe } = guanyuDuel();
    const chest = { x: foe.pos.x, y: foe.pos.y + 1.1, z: foe.pos.z };
    const ang = aimAnglesFor(g.pos, chest);
    send(w, 'p2', [{ a: 'ability', slot: 'e' }], { yaw: ang.yaw, pitch: ang.pitch, aimPoint: chest, aimTargetId: foe.id });
    w.step();
    expect(w.hasStatus(foe.id, 'silence')).toBe(true);
    const before = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 100, type: 'normal' });
    expect(before - foe.hp).toBeCloseTo(130, 5);
    // no target under the crosshair → nothing happens and no cooldown
    const { w: w2, g: g2 } = guanyuDuel();
    send(w2, 'p2', [{ a: 'ability', slot: 'e' }], { yaw: Math.PI, pitch: 0.8 });
    w2.step();
    expect(w2.cooldownLeft(g2.id, 'guanyu_yijue')).toBe(0);
  });

  it('武圣 boosts fire/explosive/melee and adds a bonus slash on burning targets', () => {
    const { w, g, foe } = guanyuDuel();
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 40, type: 'fire' }).dealt).toBeCloseTo(50, 5);
    expect(w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 40, type: 'normal' }).dealt).toBeCloseTo(40, 5);
    w.applyStatus(foe.id, 'burn', 5, { sourceId: g.id, params: { dps: 1 } });
    const hp = foe.hp;
    w.dealDamage({ targetId: foe.id, sourceId: g.id, amount: 10, type: 'normal' });
    // 10 + bonus slash 30 × 1.25 (melee)
    expect(hp - foe.hp).toBeCloseTo(10 + 30 * 1.25, 5);
  });
});

describe('ability plumbing', () => {
  function inject(w: World, e: Entity, impl: AbilityImplEx, slot: 'q' | 'e' | 'lord' | 'passive', extra: Record<string, unknown> = {}): void {
    w.heroRt(e.id)!.abilities.push({
      def: { id: impl.id, slot, nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, ...extra },
      impl,
    });
  }

  it('lord skills only exist for the real lord (not the 影武者)', () => {
    const lordCand = Object.values(HERO_BY_ID).find((h) => h.abilities.some((a) => a.slot === 'lord'));
    if (!lordCand) return; // data not loaded yet
    const roles: RoleId[] = ['lord', 'double', 'rebel', 'rebel', 'traitor'];
    const w = makeWorld(roles, { heroes: [lordCand.id, lordCand.id, lordCand.id, 'dummy', 'dummy'] });
    const has = (i: number) => w.heroRt(hero(w, i).id)!.abilities.some((a) => a.def.slot === 'lord');
    expect(has(0)).toBe(true);
    expect(has(1)).toBe(false);
    expect(has(2)).toBe(false);
  });

  it('activations only start a cooldown when they fire; cooldowns scale with modifiers', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    let ok = false;
    inject(w, e, { id: 't_q', activate: () => ok }, 'q', { cooldown: 10 });
    inject(w, e, { id: 't_mod', modifiers: () => ({ cooldownMul: 0.5 }) }, 'passive');
    send(w, 'p2', [{ a: 'ability', slot: 'q' }]);
    w.step();
    expect(w.cooldownLeft(e.id, 't_q')).toBe(0);
    ok = true;
    send(w, 'p2', [{ a: 'ability', slot: 'q' }]);
    w.step();
    expect(w.cooldownLeft(e.id, 't_q')).toBeCloseTo(5, 1);
  });

  it('charge-based abilities spend charges and recharge one per cooldown', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    let fired = 0;
    inject(w, e, { id: 't_c', activate: () => (++fired, true) }, 'q', { cooldown: 2, charges: 2 });
    e.hero!.charges.t_c = 2;
    send(w, 'p2', [{ a: 'ability', slot: 'q' }, { a: 'ability', slot: 'q' }, { a: 'ability', slot: 'q' }]);
    w.step();
    expect(fired).toBe(2);
    expect(e.hero!.charges.t_c).toBe(0);
    stepN(w, 65);
    expect(e.hero!.charges.t_c).toBe(1);
    stepN(w, 65);
    expect(e.hero!.charges.t_c).toBe(2);
  });

  it('hooks that throw are isolated (warned once) and never crash the host', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    inject(w, e, {
      id: 't_bad',
      tick: () => {
        throw new Error('boom');
      },
      modifyIncoming: () => {
        throw new Error('boom');
      },
    }, 'passive');
    expect(() => stepN(w, 5)).not.toThrow();
    expect(w.dealDamage({ targetId: e.id, amount: 10, type: 'normal' }).dealt).toBe(10);
  });

  it('abilities without an implementation are a safe no-op', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    w.heroRt(e.id)!.abilities.push({
      def: { id: 'not_implemented', slot: 'e', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, cooldown: 5 },
      impl: undefined,
    });
    send(w, 'p2', [{ a: 'ability', slot: 'e' }]);
    expect(() => w.step()).not.toThrow();
    expect(w.cooldownLeft(e.id, 'not_implemented')).toBe(0);
  });

  it('modifier hooks affect movement, reloads and dodge charges', () => {
    const w = makeWorld(STD5);
    const e = hero(w, 2);
    place(w, e, 0, 30);
    inject(w, e, { id: 't_m', modifiers: () => ({ speedMul: 1.5, extraDodgeCharges: 1, reloadMul: 0.5 }) }, 'passive');
    send(w, 'p2', [], { moveZ: 1, yaw: 0 });
    stepN(w, 30);
    expect(30 - e.pos.z).toBeGreaterThan(5 * 1.3);
    stepN(w, 30 * 9);
    expect(e.hero!.dodgeCharges).toBe(3);
  });
});
