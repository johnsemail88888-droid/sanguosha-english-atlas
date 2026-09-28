// Aim progress in the sim (HeroRuntime.adsT): spread eases from hip to aimed over the weapon
// class's ADS time (data/weaponFeel.ts), so a sniper is not dead accurate the tick the right button
// goes down; another weapon in hand and a reload both start the sights over.
import { describe, expect, it } from 'vitest';
import type { Entity, RoleId } from '../../../src/core/types';
import { BTN_ADS, SIM_HZ, emptyInput } from '../../../src/core/types';
import { WEAPON_BY_ID } from '../../../src/data';
import { AIM_PROFILES } from '../../../src/data/weaponFeel';
import { currentSpread } from '../../../src/sim/combat';
import type { World } from '../../../src/sim/world';
import { DUMMY, hero, makeWorld, place } from './helpers';

const ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function setup(primary: string, secondary: string | null = null): { w: World; me: Entity; tick: (buttons: number, actions?: object[]) => void } {
  const w = makeWorld(ROLES, { heroes: [DUMMY, DUMMY, DUMMY, DUMMY, DUMMY] });
  const me = hero(w, 2);
  for (const s of [0, 1, 3, 4]) place(w, hero(w, s), 40 + s * 4, 50);
  place(w, me, -45, -35, 0);
  const h = me.hero!;
  h.weapons[0] = { id: primary, mag: WEAPON_BY_ID[primary]!.magSize, reserve: 40 };
  h.weapons[1] = secondary ? { id: secondary, mag: WEAPON_BY_ID[secondary]!.magSize, reserve: 40 } : null;
  h.activeSlot = 0;
  let seq = 1;
  const tick = (buttons: number, actions: object[] = []): void => {
    w.setInput(h.playerId, { ...emptyInput(seq++), yaw: 0, pitch: 0, buttons, actions: actions as never });
    w.step();
  };
  return { w, me, tick };
}

describe('sim aim progress', () => {
  it('a sniper tightens over its ADS time instead of the instant the button goes down', () => {
    const { w, me, tick } = setup('qilin');
    const def = WEAPON_BY_ID.qilin!;
    for (let i = 0; i < 5; i++) tick(0);
    expect(currentSpread(w, me, def)).toBeCloseTo(def.spreadHip, 9);
    tick(BTN_ADS);
    expect(me.hero!.ads).toBe(true);
    expect(currentSpread(w, me, def)).toBeGreaterThan(def.spreadHip * 0.8);
    const ticks = Math.ceil(AIM_PROFILES.sniper.adsTime * SIM_HZ) + 1;
    for (let i = 0; i < ticks; i++) tick(BTN_ADS);
    expect(currentSpread(w, me, def)).toBeCloseTo(def.spreadAds, 9);
    // let go: back at the hip within 60 % of the ADS time
    for (let i = 0; i < ticks; i++) tick(0);
    expect(currentSpread(w, me, def)).toBeCloseTo(def.spreadHip, 9);
  });

  it('a pistol is up almost at once, an LMG takes three times as long', () => {
    const p = setup('pistol');
    const l = setup('huben');
    for (let i = 0; i < 4; i++) {
      p.tick(BTN_ADS);
      l.tick(BTN_ADS);
    }
    const pd = WEAPON_BY_ID.pistol!;
    const ld = WEAPON_BY_ID.huben!;
    expect(currentSpread(p.w, p.me, pd)).toBeCloseTo(pd.spreadAds, 9);
    expect(currentSpread(l.w, l.me, ld)).toBeGreaterThan(ld.spreadAds + (ld.spreadHip - ld.spreadAds) * 0.3);
  });

  it('switching weapons and reloading both lower the sights', () => {
    const { w, me, tick } = setup('carbine', 'pistol');
    const carbine = WEAPON_BY_ID.carbine!;
    const pistol = WEAPON_BY_ID.pistol!;
    for (let i = 0; i < 15; i++) tick(BTN_ADS);
    expect(currentSpread(w, me, carbine)).toBeCloseTo(carbine.spreadAds, 9);
    tick(BTN_ADS, [{ a: 'weapon', slot: 1 }]);
    expect(me.hero!.activeSlot).toBe(1);
    expect(currentSpread(w, me, pistol)).toBeGreaterThan(pistol.spreadAds);
    for (let i = 0; i < 10; i++) tick(BTN_ADS);
    expect(currentSpread(w, me, pistol)).toBeCloseTo(pistol.spreadAds, 9);
    // reload: not aiming while the magazine is out, and the sights come up again afterwards
    me.hero!.weapons[1]!.mag = 3;
    tick(BTN_ADS, [{ a: 'reload' }]);
    expect(me.hero!.reloadUntil).toBeGreaterThan(w.time);
    expect(me.hero!.ads).toBe(false);
    while (me.hero!.reloadUntil > 0) tick(BTN_ADS);
    tick(BTN_ADS);
    expect(me.hero!.ads).toBe(true);
    expect(currentSpread(w, me, pistol)).toBeGreaterThan(pistol.spreadAds);
  });
});
