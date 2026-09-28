// Aim progress in the sim (HeroRuntime.adsT): spread eases from hip to aimed over the weapon
// class's ADS time (data/weaponFeel.ts), so a sniper is not dead accurate the tick the right button
// goes down; another weapon in hand and a reload both start the sights over. A scoped sniper is not
// a laser on the move or mid-jump; a bow's draw is its damage; a knock / kill reports the whole shot;
// a copy of a gun you hold gives you its ammo instead of a pointless swap.
import { describe, expect, it } from 'vitest';
import type { Entity, RoleId } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, SIM_HZ, emptyInput } from '../../../src/core/types';
import { WEAPON_BY_ID } from '../../../src/data';
import { AIM_PROFILES, AIRBORNE_MIN_SPREAD, BOW_HIP_DAMAGE, MOVE_AIMED } from '../../../src/data/weaponFeel';
import { currentSpread } from '../../../src/sim/combat';
import { pickUp } from '../../../src/sim/inventory';
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

describe('moving and jumping with a scope', () => {
  it('a fully scoped sniper spreads while strafing and far more mid-air', () => {
    const { w, me, tick } = setup('qilin');
    const def = WEAPON_BY_ID.qilin!;
    for (let i = 0; i < 20; i++) tick(BTN_ADS);
    expect(currentSpread(w, me, def)).toBe(0);
    me.vel.x = 4;
    expect(currentSpread(w, me, def)).toBeCloseTo(MOVE_AIMED.sniper!, 9);
    me.vel.x = 0;
    me.onGround = false;
    expect(currentSpread(w, me, def)).toBeGreaterThanOrEqual(AIRBORNE_MIN_SPREAD);
  });
});

describe('bows: the draw is the damage', () => {
  /** The first hit on the target from one arrow at 6 m (chest height); aimed: the bow fully drawn first. */
  function arrowHit(aimed: boolean): { amount: number; head: boolean } | null {
    const { w, me } = setup('liegong');
    const t = hero(w, 3);
    place(w, t, -45, -41, 0); // 6 m straight ahead (yaw 0 looks toward −z)
    const h = me.hero!;
    let seq = 1;
    const frame = (buttons: number): void => {
      w.setInput(h.playerId, { ...emptyInput(seq++), yaw: 0, pitch: Math.atan2(-0.45, 6), buttons });
      w.step();
    };
    for (let i = 0; i < 30; i++) frame(aimed ? BTN_ADS : 0);
    w.drainEvents();
    frame((aimed ? BTN_ADS : 0) | BTN_FIRE);
    for (let i = 0; i < 30; i++) {
      const hit = w.drainEvents().find((e) => e.t === 'hit' && e.target === t.id);
      if (hit && hit.t === 'hit') return { amount: hit.amount, head: !!hit.head };
      frame(aimed ? BTN_ADS : 0);
    }
    return null;
  }

  it('a hip shot hits for BOW_HIP_DAMAGE of a fully drawn one', () => {
    const def = WEAPON_BY_ID.liegong!;
    const body = (r: { amount: number; head: boolean } | null): number => (r ? r.amount / (r.head ? def.headshotMul : 1) : NaN);
    const full = body(arrowHit(true));
    const hip = body(arrowHit(false));
    expect(full).toBeCloseTo(def.damage, 0);
    expect(hip).toBeCloseTo(def.damage * BOW_HIP_DAMAGE, 0);
    expect(hip / full).toBeLessThan(0.7);
  });
});

describe('a knock or kill reports the whole shot', () => {
  it('the hit event keeps the HP that went (amount) and the full shot (full)', () => {
    const { w, me } = setup('qilin');
    const t = hero(w, 3);
    t.hp = 9;
    w.drainEvents();
    w.dealDamage({ targetId: t.id, sourceId: me.id, amount: 145, type: 'normal', weaponId: 'qilin' });
    const hit = w.drainEvents().find((e) => e.t === 'hit' && e.target === t.id);
    expect(hit && hit.t === 'hit' && hit.amount).toBe(9);
    expect(hit && hit.t === 'hit' && hit.full).toBe(145);
    // an ordinary hit carries no extra field
    const t2 = hero(w, 4);
    w.dealDamage({ targetId: t2.id, sourceId: me.id, amount: 30, type: 'normal', weaponId: 'qilin' });
    const hit2 = w.drainEvents().find((e) => e.t === 'hit' && e.target === t2.id);
    expect(hit2 && hit2.t === 'hit' && 'full' in hit2).toBe(false);
  });
});

describe('a copy of the gun you hold', () => {
  it('F on a second 制式手枪 takes its rounds; nothing to take when the reserve is full', () => {
    const { w, me } = setup('carbine', 'pistol');
    const h = me.hero!;
    const pistol = WEAPON_BY_ID.pistol!;
    const max = pistol.magSize * pistol.reserveMags;
    h.weapons[1]!.reserve = 10;
    const loot = w.spawnLoot({ x: me.pos.x, y: me.pos.y, z: me.pos.z - 1 }, { weaponId: 'pistol', count: 1 }, { id: 'pistol', mag: 12, reserve: 24 });
    expect(pickUp(w, me, loot, true)).toBe(true);
    expect(h.weapons[0]!.id).toBe('carbine');
    expect(h.weapons[1]!.id).toBe('pistol');
    expect(h.weapons[1]!.reserve).toBe(Math.min(max, 10 + 36));
    expect(loot.alive).toBe(false);
    // no pistol was dropped in exchange
    expect([...w.entities()].some((e) => e.kind === 'loot' && e.alive && e.loot?.weaponId === 'pistol')).toBe(false);
    h.weapons[1]!.reserve = max;
    const again = w.spawnLoot({ x: me.pos.x, y: me.pos.y, z: me.pos.z - 1 }, { weaponId: 'pistol', count: 1 });
    expect(pickUp(w, me, again, true)).toBe(false);
    expect(again.alive).toBe(true);
  });
});
