import { describe, expect, it } from 'vitest';
import { resolveSfxName, SFX, SFX_NAMES } from '../../../src/audio/catalog';
import { abilityFlavorOf, gunSoundOf, isChainWeapon, isProjectileWeapon, itemSoundOf, pickupSoundOf, stepSoundOf } from '../../../src/audio/classify';
import { HEROES, WEAPONS } from '../../../src/data';
import {
  bassPattern,
  degreeToMidi,
  layerGain,
  makeMelody,
  makePhrase,
  MODES,
  RHYTHMS_DRIVING,
  RHYTHMS_SLOW,
  rimPattern,
  taikoPattern,
} from '../../../src/audio/composition';
import { Rng } from '../../../src/core/rng';

describe('sound classification', () => {
  it('resolves weapon families from data and names', () => {
    expect(gunSoundOf('pistol')).toBe('pistol');
    expect(gunSoundOf('qinglong')).toBe('rifle');
    expect(gunSoundOf('zhangba')).toBe('shotgun');
    expect(gunSoundOf('qilin')).toBe('sniper');
    expect(gunSoundOf('fangtian')).toBe('launcher');
    expect(gunSoundOf('zhuque')).toBe('flamer');
    expect(gunSoundOf('zhuge')).toBe('smg');
    expect(gunSoundOf('troop_crossbow')).toBe('crossbow');
    expect(gunSoundOf('troop_melee')).toBe('melee');
    expect(gunSoundOf('turret_smg')).toBe('smg');
    expect(gunSoundOf('taiping')).toBe('tesla');
    expect(gunSoundOf('custom_longbow')).toBe('bow');
    expect(gunSoundOf('mystery')).toBe('rifle');
    expect(gunSoundOf(undefined)).toBe('rifle');
  });

  it('distinguishes similar item ids', () => {
    expect(itemSoundOf('tao')).toBe('peach');
    expect(itemSoundOf('taoyuan')).toBe('bigHeal');
    expect(itemSoundOf('shan')).toBe('dodge');
    expect(itemSoundOf('sha')).toBe('ammo');
    expect(itemSoundOf('shandian')).toBe('thunder');
    expect(itemSoundOf('shunshou')).toBe('steal');
    expect(itemSoundOf('jiu')).toBe('wine');
    expect(itemSoundOf('nanman')).toBe('summon');
    expect(itemSoundOf('wanjian')).toBe('arrows');
    expect(itemSoundOf('lebu')).toBe('trap');
    expect(itemSoundOf('???')).toBe('basic');
  });

  it('classifies pickups, abilities and footsteps', () => {
    expect(pickupSoundOf('qinglong')).toBe('weapon');
    expect(pickupSoundOf('bagua')).toBe('armor');
    expect(pickupSoundOf('chitu')).toBe('mount');
    expect(pickupSoundOf('tao')).toBe('item');
    expect(abilityFlavorOf('zhangjiao_leiji')).toBe('thunder');
    expect(abilityFlavorOf('zhouyu_huoshao')).toBe('fire');
    expect(abilityFlavorOf('zhugeliang_kongcheng')).toBe('guqin');
    expect(abilityFlavorOf('guanyu_yijue')).toBe('shout');
    expect(stepSoundOf('hero', 'machao', true)).toBe('hoof');
    expect(stepSoundOf('npc', 'war_elephant', false)).toBe('stomp');
    expect(stepSoundOf('troop', 'shu_rifleman', false)).toBe('foot');
  });

  it('ability flavors ignore the hero prefix and follow the ability data', () => {
    expect(abilityFlavorOf('menghuo_nanman')).toBe('summon');
    expect(abilityFlavorOf('menghuo_xiangbing')).toBe('summon');
    expect(abilityFlavorOf('ganning_jieying')).toBe('stealth');
    expect(abilityFlavorOf('luxun_liaoyuan')).toBe('fire');
    expect(abilityFlavorOf('zhaoyun_jiuzhu')).toBe('shield');
    // new content: rules match the skill part only, then damage type / AI hint
    expect(abilityFlavorOf('newhero_huogong')).toBe('fire');
    expect(abilityFlavorOf('huoshen_zzz')).toBe('generic');
    expect(abilityFlavorOf(undefined)).toBe('generic');
    // no real ability picks a fire / heal flavor just because of its hero's name
    for (const h of HEROES) {
      for (const a of h.abilities) {
        const f = abilityFlavorOf(a.id);
        if (f === 'fire') expect(a.dtype === 'fire' || /huo|liaoyuan|kurou|lianying/.test(a.id.slice(h.id.length + 1))).toBe(true);
        if (f === 'thunder') expect(a.dtype === 'thunder' || a.id === 'ganning_qixi').toBe(true);
      }
    }
  });

  it('knows chain-lightning and projectile weapons', () => {
    expect(isChainWeapon('taiping')).toBe(true);
    expect(isChainWeapon('qinglong')).toBe(false);
    expect(isProjectileWeapon('qinglong')).toBe(false);
    const proj = WEAPONS.find((w) => w.projectile);
    if (proj) expect(isProjectileWeapon(proj.id)).toBe(true);
    expect(isProjectileWeapon('custom_rocket_launcher')).toBe(true);
  });

  it('resolves sim sfx names and aliases', () => {
    expect(resolveSfxName('airdropLand')).toEqual({ name: 'airdropThud', variant: '' });
    expect(resolveSfxName('crate_open')).toEqual({ name: 'crateOpen', variant: '' });
    expect(resolveSfxName('impact:metal')).toEqual({ name: 'impact', variant: 'metal' });
    expect(resolveSfxName('gun.shotgun')).toEqual({ name: 'gun', variant: 'shotgun' });
    expect(resolveSfxName('Thunder')).toEqual({ name: 'lightning', variant: '' });
    expect(resolveSfxName('jump')).toEqual({ name: 'footstep', variant: 'jump' });
    expect(resolveSfxName('zzz')).toBeNull();
    expect(resolveSfxName('')).toBeNull();
  });

  it('catalog entries are well formed', () => {
    for (const n of SFX_NAMES) {
      const d = SFX[n];
      expect(typeof d.recipe).toBe('function');
      expect(d.gain).toBeGreaterThan(0);
      expect(d.gain).toBeLessThanOrEqual(1);
    }
  });
});

describe('pentatonic composition', () => {
  it('maps degrees across octaves', () => {
    expect(degreeToMidi(45, MODES.yu, 0)).toBe(45);
    expect(degreeToMidi(45, MODES.yu, 1)).toBe(48);
    expect(degreeToMidi(45, MODES.yu, 5)).toBe(57);
    expect(degreeToMidi(45, MODES.yu, -1)).toBe(43);
    expect(degreeToMidi(60, MODES.gong, 7)).toBe(76);
  });

  it('phrases fill their bars, stay in range and land on the cadence', () => {
    const rng = new Rng(5);
    for (let k = 0; k < 20; k++) {
      const notes = makePhrase(rng, { bars: 2, rhythms: RHYTHMS_DRIVING, start: 4, end: 0, lo: -2, hi: 8 });
      const total = notes.reduce((s, n) => s + n.len, 0);
      expect(total).toBe(32);
      expect(notes[notes.length - 1].deg).toBe(0);
      for (const n of notes) {
        expect(n.deg).toBeGreaterThanOrEqual(-2);
        expect(n.deg).toBeLessThanOrEqual(9);
        expect(n.vel).toBeGreaterThan(0);
        expect(n.vel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('melodies are deterministic per seed and contiguous', () => {
    const form = { cadences: [3, 0, 3, 0] as [number, number, number, number], barsPerPhrase: 2, rhythms: RHYTHMS_SLOW, lo: 3, hi: 11 };
    const a = makeMelody(42, form);
    const b = makeMelody(42, form);
    expect(a).toEqual(b);
    expect(makeMelody(43, form)).not.toEqual(a);
    let step = 0;
    for (const n of a) {
      expect(n.step).toBe(step);
      step += n.len;
    }
    expect(step).toBe(8 * 16);
    expect(a[a.length - 1].deg).toBe(0);
  });

  it('drum and bass patterns scale with intensity', () => {
    const count = (p: number[]) => p.filter((x) => x > 0).length;
    expect(count(taikoPattern(1, 0))).toBeGreaterThan(count(taikoPattern(0, 0)));
    expect(count(taikoPattern(0.9, 3))).toBeGreaterThan(count(taikoPattern(0.9, 0)));
    expect(count(rimPattern(0))).toBe(0);
    expect(count(rimPattern(1))).toBeGreaterThan(count(rimPattern(0.3)));
    for (const i of [0, 0.5, 1]) {
      expect(taikoPattern(i, 1)).toHaveLength(16);
      expect(bassPattern(i)).toHaveLength(8);
    }
    expect(layerGain(0, 0.5)).toBe(0);
    expect(layerGain(1, 0.5)).toBe(1);
    expect(layerGain(0.5, 0.5)).toBeCloseTo(0.5, 5);
  });
});
