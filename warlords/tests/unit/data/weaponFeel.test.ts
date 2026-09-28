// Per-class aiming (data/weaponFeel.ts): every class aims differently, the sim's spread formula is
// unchanged on the ground at the hip and aimed standing still (moving aimed and mid-air are wider now),
// a sniper (and 黄忠's 烈弓) has a real scope, each class kicks its own way, a bow's draw is its damage.
import { describe, expect, it } from 'vitest';
import { WEAPONS, WEAPON_BY_ID } from '../../../src/data';
import type { WeaponClass, WeaponDef } from '../../../src/data/types';
import {
  AIM_PROFILES,
  AIRBORNE_MIN_SPREAD,
  BLOOM_MAX,
  BLOOM_PER_SHOT,
  BOW_HIP_DAMAGE,
  MOVE_AIMED,
  accuracyScore,
  adsEase,
  adsSensitivityMul,
  adsZooms,
  aimProfile,
  aimSummary,
  drawDamageMul,
  isScopedBow,
  pickupSlot,
  recoilSettleDelay,
  shotKick,
  spreadDeg,
  stepAdsT,
  swayOffset,
  weaponStats,
  zoomLabel,
  zoomedFov,
} from '../../../src/data/weaponFeel';
import { crosshairStyle } from '../../../src/ui/hud/logic';

const CLASSES: WeaponClass[] = ['pistol', 'smg', 'rifle', 'shotgun', 'dmr', 'sniper', 'lmg', 'launcher', 'flamer', 'bow', 'crossbow', 'melee'];
const W = (id: string): WeaponDef => WEAPON_BY_ID[id]!;

/** The sim's spread before the aim time existed (sim/combat.ts, COMBAT-9): what hip / aimed must still give. */
function legacySpread(def: WeaponDef, ads: boolean, moving: boolean, airborne: boolean, burst: number): number {
  let spread = ads ? def.spreadAds : def.spreadHip;
  if (moving && !ads) spread *= 1.35;
  if (airborne) spread *= 1.8;
  if (def.special !== 'rapid' && def.class !== 'flamer') spread *= 1 + Math.min(BLOOM_MAX, burst * BLOOM_PER_SHOT);
  return Math.max(0, spread);
}

describe('aim profiles per weapon class', () => {
  it('covers every class, and the hip crosshair matches the HUD mapping', () => {
    for (const c of CLASSES) {
      expect(AIM_PROFILES[c], c).toBeDefined();
      expect(AIM_PROFILES[c].crosshair, c).toBe(crosshairStyle(c));
    }
  });

  it('shoulders at different speeds: pistol quickest, then SMG, rifle; LMG heavy; scopes settle', () => {
    const t = (c: WeaponClass): number => AIM_PROFILES[c].adsTime;
    expect(t('pistol')).toBeLessThan(t('smg'));
    expect(t('smg')).toBeLessThan(t('rifle'));
    expect(t('rifle')).toBeLessThan(t('dmr'));
    expect(t('dmr')).toBeLessThan(t('sniper'));
    expect(t('lmg')).toBeGreaterThan(t('rifle'));
    expect(t('lmg')).toBeGreaterThan(t('sniper'));
    for (const c of CLASSES) expect(t(c), c).toBeLessThanOrEqual(0.4);
  });

  it('only scoped classes cover the screen with a lens; the sniper sways most and can hold its breath', () => {
    const overlay = CLASSES.filter((c) => AIM_PROFILES[c].overlay);
    expect(overlay.sort()).toEqual(['dmr', 'sniper']);
    expect(AIM_PROFILES.sniper.sight).toBe('scope');
    expect(AIM_PROFILES.sniper.holdBreath).toBe(true);
    for (const c of CLASSES) if (c !== 'sniper') expect(AIM_PROFILES[c].sway, c).toBeLessThan(AIM_PROFILES.sniper.sway);
    expect(AIM_PROFILES.lmg.sway).toBeGreaterThan(AIM_PROFILES.rifle.sway);
    expect(AIM_PROFILES.pistol.sway).toBe(0);
    // sights differ between the everyday classes
    const sights = new Set((['pistol', 'smg', 'rifle', 'dmr', 'sniper', 'shotgun', 'bow'] as WeaponClass[]).map((c) => AIM_PROFILES[c].sight));
    expect(sights.size).toBe(7);
  });

  it('a sniper has a real scope: two zoom steps, at least 4×', () => {
    for (const w of WEAPONS.filter((x) => x.class === 'sniper')) {
      const z = adsZooms(w);
      expect(z.length, w.id).toBe(2);
      expect(z[0], w.id).toBeGreaterThanOrEqual(4);
      expect(z[1], w.id).toBeCloseTo(z[0]! * 2, 6);
    }
    expect(zoomLabel(W('qilin'))).toBe('4× / 8×');
    expect(adsZooms(W('carbine'))).toEqual([1.5]);
    expect(adsZooms(undefined)).toEqual([1]);
    for (const w of WEAPONS.filter((x) => x.class === 'dmr')) {
      expect(w.adsZoom, w.id).toBeGreaterThanOrEqual(1.8); // 白衣 1.8× … 倚天 2.5× (weapons spec C1)
      expect(w.adsZoom, w.id).toBeLessThan(4);
    }
    expect(aimProfile(undefined)).toBe(AIM_PROFILES.rifle);
  });

  it('黄忠\'s 烈弓 (a 复合狙击弓) aims through a real scope: 2.5× / 5×, hold breath, the draw inside the lens', () => {
    const lg = W('liegong');
    const p = aimProfile(lg);
    expect(p.sight).toBe('scope');
    expect(p.overlay).toBe(true);
    expect(p.holdBreath).toBe(true);
    expect(p.crosshair).toBe('bow');
    expect(p.fatigueAfter).toBe(AIM_PROFILES.bow.fatigueAfter);
    expect(p.sway).toBeLessThan(AIM_PROFILES.sniper.sway);
    expect(adsZooms(lg)).toEqual([2.5, 5]);
    expect(zoomLabel(lg)).toBe('2.5× / 5×');
    expect(isScopedBow(lg)).toBe(true);
    // 孙尚香's bow stays a plain drawn bow; the class table itself is untouched
    expect(aimProfile(W('xiaoji'))).toBe(AIM_PROFILES.bow);
    expect(isScopedBow(W('xiaoji'))).toBe(false);
    expect(AIM_PROFILES.bow.overlay).toBe(false);
    expect(aimProfile(lg)).toBe(aimProfile(lg));
  });

  it('the LMG has its own sight (not the SMG\'s red dot)', () => {
    expect(AIM_PROFILES.lmg.sight).not.toBe(AIM_PROFILES.smg.sight);
    expect(AIM_PROFILES.lmg.sight).not.toBe(AIM_PROFILES.rifle.sight);
  });
});

describe('recoil per class (the view climbs; shots follow it)', () => {
  const kick = (id: string, blend = 1): number => shotKick(W(id), blend).pitch;
  it('a sniper kicks hardest, then DMRs; autos kick little per shot', () => {
    expect(kick('qilin')).toBeGreaterThanOrEqual(2.5);
    expect(kick('qilin')).toBeGreaterThan(kick('qinggang'));
    expect(kick('qinggang')).toBeGreaterThan(kick('carbine') * 2);
    expect(kick('pistol')).toBeGreaterThan(kick('carbine'));
    expect(kick('carbine')).toBeGreaterThan(kick('smg'));
    expect(kick('carbine')).toBeGreaterThan(0.2);
    expect(kick('smg')).toBeGreaterThan(0.1);
    // held down, an auto still climbs a couple of degrees a second
    expect(kick('carbine') * W('carbine').fireRate).toBeGreaterThan(1.5);
    expect(kick('smg') * W('smg').fireRate).toBeGreaterThan(1.5);
    expect(kick('guding')).toBeGreaterThan(1.5);
  });

  it('each gun\'s own recoil counts: 吕布\'s rifle kicks harder than the carbine, 吕蒙\'s suppressed DMR less than 青釭', () => {
    expect(kick('wushuang')).toBeGreaterThan(kick('carbine') * 1.5);
    expect(kick('baiyi')).toBeLessThan(kick('qinggang'));
  });

  it('SMGs dance sideways; a braced LMG kicks 40 % less once aimed; melee never kicks', () => {
    const smg = shotKick(W('smg'), 1);
    expect(smg.yaw).toBeGreaterThan(smg.pitch * 0.6);
    expect(kick('huben', 1)).toBeCloseTo(kick('huben', 0) * 0.6, 9);
    expect(kick('qilin', 1)).toBeCloseTo(kick('qilin', 0), 9);
    expect(shotKick(W('troop_melee'), 1)).toEqual({ pitch: 0, yaw: 0 });
  });

  it('the view settles only once the trigger rests (a held auto keeps climbing), a sniper between its shots', () => {
    for (const id of ['carbine', 'smg', 'huben', 'zhuge']) expect(recoilSettleDelay(W(id)), id).toBeGreaterThan(1 / W(id).fireRate);
    expect(recoilSettleDelay(W('qilin'))).toBeLessThan(0.3);
  });
});

describe('bows: the draw is the damage', () => {
  it('a hip shot hits for BOW_HIP_DAMAGE of a full draw; other classes are unaffected', () => {
    expect(drawDamageMul(W('liegong'), 0)).toBeCloseTo(BOW_HIP_DAMAGE, 9);
    expect(drawDamageMul(W('liegong'), 1)).toBe(1);
    expect(drawDamageMul(W('xiaoji'), 0.5)).toBeGreaterThan(BOW_HIP_DAMAGE);
    expect(drawDamageMul(W('xiaoji'), 0.5)).toBeLessThan(1);
    expect(drawDamageMul(W('qilin'), 0)).toBe(1);
    expect(drawDamageMul(W('carbine'), 0)).toBe(1);
  });
});

describe('spread (the sim formula the HUD crosshair draws)', () => {
  it('is exactly the old spread on the ground: at the hip (standing or moving) and aimed standing still', () => {
    for (const def of WEAPONS) {
      for (const [ads, moving] of [[false, false], [false, true], [true, false]] as const) {
        for (const burst of [0, 3, 20]) {
          const now = spreadDeg(def, { adsT: ads ? 1 : 0, moving, airborne: false, burst });
          expect(now, `${def.id} ${ads} ${moving} ${burst}`).toBeCloseTo(legacySpread(def, ads, moving, false, burst), 9);
        }
      }
    }
  });

  it('aiming on the move widens the aimed cone (a scope most); mid-air nothing is accurate', () => {
    const at = (id: string, o: { ads: boolean; moving?: boolean; airborne?: boolean }): number =>
      spreadDeg(W(id), { adsT: o.ads ? 1 : 0, moving: !!o.moving, airborne: !!o.airborne, burst: 0 });
    // the scoped sniper: dead on standing, not while strafing or jumping
    expect(at('qilin', { ads: true })).toBe(0);
    expect(at('qilin', { ads: true, moving: true })).toBeCloseTo(MOVE_AIMED.sniper!, 9);
    expect(at('qilin', { ads: true, airborne: true })).toBeGreaterThanOrEqual(AIRBORNE_MIN_SPREAD);
    expect(at('qinggang', { ads: true, moving: true })).toBeCloseTo(W('qinggang').spreadAds + MOVE_AIMED.dmr!, 9);
    expect(at('liegong', { ads: true, moving: true })).toBeCloseTo(W('liegong').spreadAds + MOVE_AIMED.bow!, 9);
    // a rifle's sights care much less
    const rifleMove = at('carbine', { ads: true, moving: true }) - at('carbine', { ads: true });
    expect(rifleMove).toBeGreaterThan(0);
    expect(rifleMove).toBeLessThan(MOVE_AIMED.sniper! / 4);
    for (const def of WEAPONS) {
      if (def.melee) continue;
      for (const ads of [false, true]) {
        const air = spreadDeg(def, { adsT: ads ? 1 : 0, moving: false, airborne: true, burst: 0 });
        expect(air, def.id).toBeGreaterThanOrEqual(AIRBORNE_MIN_SPREAD);
        expect(air, def.id).toBeGreaterThanOrEqual(legacySpread(def, ads, false, true, 0) - 1e-9);
      }
    }
  });

  it('tightens steadily while the sights come up', () => {
    const q = W('qilin');
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const s = spreadDeg(q, { adsT: t, moving: false, airborne: false, burst: 0 });
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    // half way up a sniper is still far from its aimed 0°
    expect(spreadDeg(q, { adsT: 0.5, moving: false, airborne: false, burst: 0 })).toBeGreaterThan(2);
  });

  it('aim progress: up over the ADS time, down in 60 % of it', () => {
    let t = 0;
    for (let i = 0; i < 9; i++) t = stepAdsT(t, true, 0.3, 0.03);
    expect(t).toBeCloseTo(0.9, 6);
    t = stepAdsT(t, true, 0.3, 0.04);
    expect(t).toBe(1);
    t = stepAdsT(t, false, 0.3, 0.09);
    expect(t).toBeCloseTo(0.5, 6);
    expect(stepAdsT(0, false, 0.3, 1)).toBe(0);
    expect(adsEase(0)).toBe(0);
    expect(adsEase(1)).toBe(1);
    expect(adsEase(0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('zoom-scaled ADS sensitivity', () => {
  it('keeps the ADS setting up to 1.5×, then scales with the view', () => {
    expect(adsSensitivityMul(1, 75, 0.6)).toBeCloseTo(0.6, 9);
    expect(adsSensitivityMul(1.25, 75, 0.6)).toBeCloseTo(0.6, 9);
    expect(adsSensitivityMul(1.5, 75, 0.6)).toBeCloseTo(0.6, 9);
    const s4 = adsSensitivityMul(4, 75, 0.6);
    const s8 = adsSensitivityMul(8, 75, 0.6);
    expect(s4).toBeLessThan(0.6 * 0.45);
    expect(s8).toBeLessThan(s4 * 0.55);
    expect(s8).toBeGreaterThan(0);
    // the same share of the picture per mouse movement: sensitivity / tan(fov / 2) is constant above 1.5×
    const k = (z: number): number => adsSensitivityMul(z, 75, 1) / Math.tan((zoomedFov(75, z) * Math.PI) / 360);
    expect(k(4)).toBeCloseTo(k(8), 9);
    expect(k(2.2)).toBeCloseTo(k(4), 9);
    // close to the old rule (setting / (zoom / 1.5)) for every data zoom
    for (const w of WEAPONS) {
      const z = w.adsZoom;
      if (z <= 1) continue;
      const old = 0.6 / Math.max(1, z / 1.5);
      expect(Math.abs(adsSensitivityMul(z, 75, 0.6) - old) / old, w.id).toBeLessThan(0.15);
    }
  });

  it('zoomed FOV follows the camera rig (divisor, clamped)', () => {
    expect(zoomedFov(75, 1)).toBe(75);
    expect(zoomedFov(75, 4)).toBeCloseTo(18.75, 9);
    expect(zoomedFov(75, 20)).toBe(8);
  });
});

describe('weapon identity: stat bars', () => {
  it('five bars in 0..1 that tell the classes apart', () => {
    for (const w of WEAPONS) {
      const st = weaponStats(w);
      expect(st.map((s) => s.key)).toEqual(['damage', 'rate', 'range', 'mag', 'accuracy']);
      for (const s of st) {
        expect(s.bar, `${w.id} ${s.key}`).toBeGreaterThanOrEqual(0);
        expect(s.bar, `${w.id} ${s.key}`).toBeLessThanOrEqual(1);
        expect(s.value.length, `${w.id} ${s.key}`).toBeGreaterThan(0);
      }
    }
    const bar = (id: string, k: string): number => weaponStats(W(id)).find((s) => s.key === k)!.bar;
    expect(bar('qilin', 'damage')).toBeGreaterThan(bar('carbine', 'damage'));
    expect(bar('smg', 'rate')).toBeGreaterThan(bar('carbine', 'rate'));
    expect(bar('carbine', 'rate')).toBeGreaterThan(bar('qilin', 'rate'));
    expect(bar('qilin', 'range')).toBeGreaterThan(bar('carbine', 'range'));
    expect(bar('carbine', 'range')).toBeGreaterThan(bar('smg', 'range'));
    expect(bar('huben', 'mag')).toBeGreaterThan(bar('carbine', 'mag'));
    expect(accuracyScore(W('qilin'))).toBeGreaterThan(accuracyScore(W('carbine')));
    expect(accuracyScore(W('carbine'))).toBeGreaterThan(accuracyScore(W('guding')));
    // 精准 is the aimed cone: the sniper tops the scoped bow and the DMR (its wild hip cone is on the aim line instead)
    expect(accuracyScore(W('qilin'))).toBe(1);
    expect(accuracyScore(W('qilin'))).toBeGreaterThan(accuracyScore(W('liegong')));
    expect(accuracyScore(W('liegong'))).toBeGreaterThan(accuracyScore(W('qinggang')));
    expect(accuracyScore(W('qinggang'))).toBeGreaterThan(accuracyScore(W('carbine')));
    expect(accuracyScore(W('carbine'))).toBeGreaterThan(accuracyScore(W('smg')));
    // pellet guns show pellets × damage
    expect(weaponStats(W('guding'))[0]!.value).toBe(`${W('guding').damage}×${W('guding').pellets}`);
  });

  it('the aim line: sight + zoom steps, aim time, the hip cone; no sight name for the flamer', () => {
    const q = aimSummary(W('qilin'));
    expect(q.zh).toBe('狙击镜 4× / 8× · 开镜 0.3 秒 · 腰射 ±10° · Shift 屏息');
    expect(q.en).toContain('Sniper scope 4× / 8×');
    expect(q.en).toContain('hip ±10°');
    const fl = aimSummary(W('zhuque'));
    expect(fl.zh).not.toContain('无');
    expect(fl.zh.startsWith('开镜')).toBe(true);
    expect(aimSummary(W('liegong')).zh).toContain('狙击镜 2.5× / 5×');
    expect(aimSummary(W('liegong')).zh).toContain('满弦');
    expect(aimSummary(W('huben')).zh.startsWith('宽框反射镜')).toBe(true);
  });

  it('a pickup lands in the slot the sim puts it (pistols beside a primary go to slot 2)', () => {
    expect(pickupSlot(W('pistol'), 'carbine')).toBe(1);
    expect(pickupSlot(W('pistol'), 'pistol')).toBe(0);
    expect(pickupSlot(W('pistol'), null)).toBe(0);
    expect(pickupSlot(W('qilin'), 'carbine')).toBe(0);
  });

  it('sway stays within its amplitude and is zero without one', () => {
    const a = (0.3 * Math.PI) / 180;
    for (let t = 0; t < 20; t += 0.37) {
      const o = swayOffset(t, 0.3);
      expect(Math.abs(o.yaw)).toBeLessThanOrEqual(a + 1e-12);
      expect(Math.abs(o.pitch)).toBeLessThanOrEqual(a * 0.6 + 1e-12);
    }
    expect(swayOffset(3, 0)).toEqual({ yaw: 0, pitch: 0 });
  });
});
