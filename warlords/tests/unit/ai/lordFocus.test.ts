// 「怎么我一下主公一下就死了？」 — a human hero next to the bot 主公 and his guard squad
// (tests/unit/ai/lordFocus.ts). Before the fix (same scenes, 5 lords × 3 seeds): an admitted
// rebel focused at 18 m in the late game went down in 1.1–2.7 s (median 2.1; dead as little as
// 0.3 s later), up to 364 damage in one second, ~80 % of it from the lord's guards; one shot at
// the lord from inside his squad cost up to 255 in a second. After: 3.5–6.8 s (median 4.5).
// Now troops / summons deal less to heroes and are soft-capped per second per commander on one
// hero (sim/combat.ts TROOP_VS_HERO), they drain a downed hero's bleed-out slowly, and the bot
// lord opens with his gun, not his signature burst (ai/abilityUse.ts LORD_RESTRAINT).
import { describe, expect, it } from 'vitest';
import { TROOP_FOCUS_DPS, TROOP_FOCUS_OVER, TROOP_VS_HERO_MUL, troopFocusDamage } from '../../../src/sim/combat';
import type { Entity } from '../../../src/core/types';
import { hero, setup } from '../items/helpers';
import { LORD_CANDIDATE_IDS } from '../../../src/data';
import { fmtLordFocus, runLordFocus } from './lordFocus';

describe('troops vs heroes: reduced and soft-capped per hero', () => {
  /** Troop DPS a hero actually takes from `raw` DPS of soldier fire, in hits of `hit` damage. */
  function sustained(raw: number, hit: number, seconds = 6): number {
    const heat = { value: 0, at: 0 };
    const every = hit / raw;
    let took = 0;
    let t = 0;
    for (; t < seconds; t += every) took += troopFocusDamage(heat, t, hit);
    return took / seconds;
  }

  it('a 4-man rifle squad (≈ 60 DPS) is barely touched; a 12-man guard (≈ 200 DPS) adds little over the cap', () => {
    const small = sustained(60, 11);
    const big = sustained(200, 11);
    process.stdout.write(`[troop focus] 60 raw DPS → ${small.toFixed(0)} · 200 raw DPS → ${big.toFixed(0)} (cap ${TROOP_FOCUS_DPS}, ×${TROOP_VS_HERO_MUL})\n`);
    expect(small).toBeGreaterThan(60 * TROOP_VS_HERO_MUL * 0.8);
    expect(small).toBeLessThanOrEqual(60 * TROOP_VS_HERO_MUL + 1);
    expect(big).toBeLessThan(TROOP_FOCUS_DPS + (200 * TROOP_VS_HERO_MUL - TROOP_FOCUS_DPS) * TROOP_FOCUS_OVER + 8);
    expect(big).toBeLessThan(110);
    // the heat cools off: after a break the full damage lands again
    const heat = { value: 0, at: 0 };
    for (let i = 0; i < 40; i++) troopFocusDamage(heat, i * 0.05, 11);
    expect(troopFocusDamage(heat, 2.05, 11)).toBeLessThan(11 * TROOP_VS_HERO_MUL);
    expect(troopFocusDamage(heat, 8, 11)).toBeCloseTo(11 * TROOP_VS_HERO_MUL, 3);
  });

  it("the cap is per squad: a second commander's soldiers still land in full (the 主公 under four rebel squads takes four squads)", () => {
    const { w, b, c } = setup();
    const lord = hero(w, 0);
    b.maxHp = 1e6;
    b.hp = 1e6;
    const [guard] = w.spawnTroops(lord.id, 'shu_rifleman', 1, { x: 40, y: 0, z: 42 });
    const [other] = w.spawnTroops(c.id, 'shu_rifleman', 1, { x: 50, y: 0, z: 30 });
    const shot = (t: Entity): number => w.dealDamage({ targetId: b.id, sourceId: t.id, amount: 20, type: 'normal', weaponId: 'troop_rifle' }).dealt;
    expect(shot(guard)).toBeCloseTo(20 * TROOP_VS_HERO_MUL, 5);
    for (let i = 0; i < 6; i++) shot(guard); // same instant: ≈ 100 on the lord squad's heat
    expect(shot(guard)).toBeCloseTo(20 * TROOP_VS_HERO_MUL * TROOP_FOCUS_OVER, 5);
    expect(shot(other)).toBeCloseTo(20 * TROOP_VS_HERO_MUL, 5);
  });
});

describe('near the bot lord', () => {
  it('an admitted rebel under the lord + whole guard squad at 18 m (late game) survives ≥ 3 s, and is not shredded once down', () => {
    for (const lord of LORD_CANDIDATE_IDS) {
      const r = runLordFocus({ lord, scenario: 'rebelFocus', dist: 18, startAt: 400, seconds: 14, seed: 1000 });
      process.stdout.write(`[lord focus] ${fmtLordFocus(r)}\n`);
      expect(r.took.lordGuards, `${lord}: the guards do fire`).toBeGreaterThan(80);
      expect(r.firstHitToDown, `${lord}: time to 濒死`).toBeGreaterThanOrEqual(3);
      // (before: 0.3–0.8 s from 濒死 to death — the guards shredded the 12 s bleed-out)
      if (r.dead) expect(r.firstHitToDeath - r.firstHitToDown, `${lord}: 濒死 → death`).toBeGreaterThanOrEqual(1);
    }
  }, 120000);

  it('one shot at the lord from a rebel walking into his squad: punished, not deleted', () => {
    for (const lord of LORD_CANDIDATE_IDS) {
      const r = runLordFocus({ lord, scenario: 'rebelShot', dist: 8, seconds: 6, seed: 1001 });
      process.stdout.write(`[lord focus] ${fmtLordFocus(r)}\n`);
      expect(r.downed, `${lord}: not downed within 6 s of one shot`).toBe(false);
      expect(r.peak1s, `${lord}: damage in the worst second`).toBeLessThan(200);
    }
  }, 120000);

  it('a HUMAN loyalist who hits the lord once by accident, or stands next to him, takes nothing from the lord side', () => {
    for (const lord of LORD_CANDIDATE_IDS) {
      const shot = runLordFocus({ lord, scenario: 'loyalShot', dist: 10, seconds: 8, seed: 1000 });
      const near = runLordFocus({ lord, scenario: 'loyalNear', dist: 6, seconds: 8, seed: 1000 });
      process.stdout.write(`[lord focus] ${fmtLordFocus(shot)}\n[lord focus] ${fmtLordFocus(near)}\n`);
      for (const r of [shot, near]) {
        expect(r.took.lordGun + r.took.lordAbility + r.took.lordGuards, `${lord} ${r.opts.scenario}`).toBe(0);
        expect(r.downed).toBe(false);
      }
    }
  }, 120000);
});
