// How a bot handles its gun (sim/ai/weaponUse.ts, weapons spec C10) — the rules the balance
// reviews found wrong: hip fire out to 22 m, DMRs strafing with the sights up, 方天 never locking,
// the sniper spending bolts on near-misses, the aim tracker ignoring sprint-to-fire, dodges from
// rockets that were not locked on.
import { describe, expect, it } from 'vitest';
import { BTN_ADS, BTN_FIRE, emptyInput } from '../../../src/core/types';
import { WEAPON_BY_ID } from '../../../src/data';
import type { WeaponDef } from '../../../src/data/types';
import { aimProfile } from '../../../src/data/weaponFeel';
import type { AimOut } from '../../../src/sim/ai/aimer';
import { difficultyProfile } from '../../../src/sim/ai/difficulty';
import { ADS_BEYOND, AdsTracker, lockedRocketAt, onTarget, plantRange, plantsFeet, sightsReady, wantsAds } from '../../../src/sim/ai/weaponUse';
import { aimAnglesFor } from '../../../src/sim/aim';
import { LOCK_ADS_T } from '../../../src/sim/combat';
import { sprintOutTime } from '../../../src/sim/handling';
import { heroAt, makeDummy, placeAt, rangeWorld } from '../balance/range';

const W = (id: string): WeaponDef => WEAPON_BY_ID[id]!;
const normal = difficultyProfile('normal');
const hard = difficultyProfile('hard');

describe('bot weapon use (C10)', () => {
  it('rifles, LMGs, SMGs, pistols and crossbows aim beyond 12 m (not 22 m); the lord opening stays at the hip inside 22 m', () => {
    for (const id of ['carbine', 'huben', 'smg', 'pistol', 'jiguan']) {
      expect(wantsAds(W(id), 15, normal), id).toBe(true);
      expect(wantsAds(W(id), 15, hard), id).toBe(true);
      expect(wantsAds(W(id), ADS_BEYOND - 1, normal), id).toBe(false);
      // the bot 主公's opening seconds on a hero: his gun opens the fight (LORD_RESTRAINT.gunOpening)
      expect(wantsAds(W(id), 15, normal, false, true), id).toBe(false);
      expect(wantsAds(W(id), 25, normal, false, true), id).toBe(true);
    }
    for (const id of ['guding', 'zhuque']) expect(wantsAds(W(id), 15, normal), id).toBe(false);
  });

  it('DMRs aim beyond 10 m and plant their feet from ≈ 19 m (the moving penalty is wider than a body); snipers and bows at 40 m', () => {
    expect(wantsAds(W('qinggang'), 8, normal)).toBe(false);
    expect(wantsAds(W('qinggang'), 12, normal)).toBe(true);
    expect(wantsAds(W('qilin'), 8, normal)).toBe(true);
    expect(plantRange(W('qinggang'))).toBeGreaterThan(18);
    expect(plantRange(W('qinggang'))).toBeLessThan(20);
    expect(plantsFeet(W('qinggang'), 30, true)).toBe(true);
    expect(plantsFeet(W('qinggang'), 30, false)).toBe(false);
    expect(plantsFeet(W('qilin'), 30, true)).toBe(false);
    expect(plantsFeet(W('qilin'), 45, true)).toBe(true);
    expect(plantsFeet(W('carbine'), 60, true)).toBe(false);
  });

  it('方天 aims from its sidearm distance out to its lock range and fires only fully aimed there (a hip volley never locks)', () => {
    const ft = W('fangtian');
    const lockRange = ft.specialParams.lockRange ?? 40;
    expect(wantsAds(ft, 8, normal)).toBe(true);
    expect(wantsAds(ft, lockRange - 1, normal)).toBe(true);
    expect(sightsReady(ft, 0.9, 15)).toBe(false);
    expect(sightsReady(ft, LOCK_ADS_T + 0.02, 15)).toBe(true);
    // beyond the lock range it is an ordinary launcher
    expect(sightsReady(ft, 0.5, lockRange + 5)).toBe(true);
  });

  it('a bolt-action waits until the crosshair is on the body (targetAngle ×1.0), a rifle keeps ×1.25', () => {
    const o = (err: number): AimOut => ({ yaw: 0, pitch: 0, point: { x: 0, y: 0, z: 0 }, errAngle: err, targetAngle: 0.01, leadErrAngle: err });
    expect(onTarget(W('qilin'), o(0.0115), true, normal)).toBe(false);
    expect(onTarget(W('qilin'), o(0.0095), true, normal)).toBe(true);
    expect(onTarget(W('carbine'), o(0.0115), true, normal)).toBe(true);
  });

  it('aim pressed mid-sprint: the tracker holds at the hip for sprintOut, as the sim does', () => {
    const def = W('qilin');
    const t = new AdsTracker();
    const dt = 1 / 30;
    let now = 10;
    // pressed while sprinting
    let v = t.update(def, true, dt, now, true);
    expect(v).toBe(0);
    let firstUp = -1;
    for (let i = 0; i < 60; i++) {
      now += dt;
      v = t.update(def, true, dt, now, false);
      if (v > 0 && firstUp < 0) firstUp = now - 10;
    }
    expect(firstUp).toBeGreaterThanOrEqual(sprintOutTime(def) - 1e-9);
    expect(v).toBeGreaterThan(0.99);
    // not sprinting: it rises from the first tick
    const u = new AdsTracker();
    expect(u.update(def, true, dt, 5, false)).toBeCloseTo(Math.min(1, dt / aimProfile(def).adsTime), 1);
  });

  it('a bot rolls only out of a real lock — not out of any 方天 rocket flying its way', () => {
    const w = rangeWorld(3);
    const me = heroAt(w, 2);
    const t = heroAt(w, 3);
    placeAt(w, me, 0, 0, Math.PI);
    placeAt(w, t, 0, 15, 0);
    makeDummy(w, t);
    me.hero!.weapons[0] = w.newWeapon('fangtian');
    me.hero!.weapons[1] = null;
    me.hero!.activeSlot = 0;
    w.step();
    let seq = 1;
    const aim = (buttons: number): void => {
      const c = { x: t.pos.x, y: t.pos.y + 1.1, z: t.pos.z };
      const a = aimAnglesFor(me.pos, c);
      w.setInput(me.hero!.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimPoint: c, buttons });
      w.step();
    };
    // from the hip: rockets fly at it, nothing is locked
    aim(BTN_FIRE);
    aim(0);
    expect(w.kindList('projectile').length).toBeGreaterThan(0);
    expect(lockedRocketAt(w, t)).toBe(false);
    for (let i = 0; i < 60; i++) aim(0);
    // fully aimed: locked
    for (let i = 0; i < Math.ceil(aimProfile(W('fangtian')).adsTime * 30) + 3; i++) aim(BTN_ADS);
    aim(BTN_ADS | BTN_FIRE);
    expect(lockedRocketAt(w, t)).toBe(true);
  });
});
