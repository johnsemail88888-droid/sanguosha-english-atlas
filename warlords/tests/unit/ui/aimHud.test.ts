// The aim HUD's logic (ui/hud/aim.ts, aimMarks.ts, damageNumbers.ts, ui/touch.ts; weapons spec
// C4–C9): damage-number colours and merging, holdover ladder marks, the TTK strip, the true-scale
// mil-dot reticle, the marksman stadia, hold-to-fire and the gyro mapping.
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID } from '../../../src/data';
import type { WeaponDef } from '../../../src/data/types';
import { STADIA_RANGES, armorReduces, hitDamageKind, marksmanMarkup, milDotMarkup, ttkAt, ttkTone } from '../../../src/ui/hud/aim';
import { LADDER_LABEL_GAP, ladderLabels, ladderMarks, ladderTicks } from '../../../src/ui/hud/aimMarks';
import { MERGE_WINDOW, mergeKind } from '../../../src/ui/hud/damageNumbers';
import { fireOnRelease, gyroLook } from '../../../src/ui/touch';
import { WEAPON_TTK } from '../../../src/data/weaponTtk.gen';

const W = (id: string): WeaponDef => WEAPON_BY_ID[id]!;

describe('damage numbers', () => {
  it('colour by hit: kill red, head gold, bullets into armor blue, squad its own, else white', () => {
    expect(hitDamageKind({ full: 120, head: true, dtype: 'normal' }, true, undefined)).toBe('kill');
    expect(hitDamageKind({ head: true, dtype: 'normal' }, true, 'tengjia')).toBe('head');
    expect(hitDamageKind({ dtype: 'normal' }, true, 'tengjia')).toBe('armor');
    expect(hitDamageKind({ dtype: 'fire' }, true, 'tengjia')).toBe('normal');
    expect(hitDamageKind({ dtype: 'normal' }, true, undefined)).toBe('normal');
    expect(hitDamageKind({ dtype: 'normal', head: true }, false, undefined)).toBe('squad');
    expect(armorReduces('renwang', 'normal')).toBe(true);
    expect(armorReduces(undefined, 'normal')).toBe(false);
  });

  it('merge within 0.6 s; the merged colour keeps the strongest tell (kill > head > armor > body)', () => {
    expect(MERGE_WINDOW).toBe(0.6);
    expect(mergeKind('normal', 'head')).toBe('head');
    expect(mergeKind('head', 'normal')).toBe('head');
    expect(mergeKind('armor', 'normal')).toBe('armor');
    expect(mergeKind('head', 'kill')).toBe('kill');
    expect(mergeKind('kill', 'head')).toBe('kill');
  });
});

describe('holdover ladder', () => {
  it('marks: grenade 20/40/60, a drawn bow 20/40/60 (烈弓 in its scope 30/50/75/100), a snap shot 10/20/30', () => {
    expect(ladderMarks(W('guanshi'), 0)).toEqual([20, 40, 60]);
    expect(ladderMarks(W('xiaoji'), 1)).toEqual([20, 40, 60]);
    expect(ladderMarks(W('liegong'), 1)).toEqual([30, 50, 75, 100]);
    expect(ladderMarks(W('liegong'), 0.2)).toEqual([10, 20, 30]);
    expect(ladderMarks(W('carbine'), 1)).toEqual([]);
  });

  it('ticks go down the screen with range, never past the round\'s reach, none without gravity', () => {
    const t = ladderTicks(W('guanshi'), 1, 1.3, 75, 1080);
    expect(t.length).toBeGreaterThan(0);
    for (let i = 1; i < t.length; i++) expect(t[i]!.px).toBeGreaterThan(t[i - 1]!.px);
    // an arrow that bursts at 60 m (lifetime 0.5 s at 120 m/s) has no 100 m mark
    const burst: WeaponDef = { ...W('liegong'), projectile: { ...W('liegong').projectile!, speed: 120, lifetime: 0.5 } };
    expect(ladderTicks(burst, 1, 2.5, 75, 1080).map((x) => x.d)).toEqual([30, 50]);
    expect(ladderTicks(W('fangtian'), 1, 1.3, 75, 1080)).toEqual([]);
    // a drawn arrow drops less than a snap shot at the same range
    const hip = ladderTicks(W('liegong'), 0, 1, 75, 1080).find((x) => x.d === 30)!;
    const drawn = ladderTicks(W('liegong'), 1, 1, 75, 1080).find((x) => x.d === 30)!;
    expect(drawn.px).toBeLessThan(hip.px);
  });

  it('labels: at least LADDER_LABEL_GAP px apart, the farthest mark always keeps its label', () => {
    const T = (...px: number[]) => px.map((v, i) => ({ d: (i + 1) * 10, px: v }));
    expect(ladderLabels(T(5, 30, 60))).toEqual([true, true, true]);
    expect(ladderLabels(T(5, 9, 30))).toEqual([true, false, true]);
    // the last two crowd each other: the nearer one gives up its label
    expect(ladderLabels(T(5, 30, 34))).toEqual([true, false, true]);
    expect(ladderLabels(T(3))).toEqual([true]);
    expect(ladderLabels([])).toEqual([]);
    for (const [w, a, z] of [['liegong', 1, 2.5], ['liegong', 1, 5], ['guanshi', 1, 1.3]] as const) {
      const t = ladderTicks(W(w), a, z, 75, 1080);
      const on = ladderLabels(t);
      expect(on[on.length - 1], w).toBe(true);
      const px = t.filter((_, i) => on[i]).map((x) => x.px);
      for (let i = 1; i < px.length; i++) expect(px[i]! - px[i - 1]!).toBeGreaterThanOrEqual(LADDER_LABEL_GAP);
    }
  });
});

describe('stat card: 5 / 20 / 50 m time-to-kill strip', () => {
  it('reads the generated table; no kill → null; tones by speed', () => {
    for (const id of ['carbine', 'smg', 'qilin', 'guding']) expect(WEAPON_TTK[id], id).toBeDefined();
    expect(ttkAt('carbine', 'm20')).toBeGreaterThan(0);
    expect(ttkAt('guding', 'm50')).toBeNull();
    expect(ttkAt('nope', 'm5')).toBeNull();
    // a shotgun wins up close, a sniper far out
    expect(ttkAt('guding', 'm5')!).toBeLessThan(ttkAt('qilin', 'm5')!);
    expect(ttkAt('qilin', 'm50')!).toBeLessThan(ttkAt('carbine', 'm50')!);
    expect(ttkTone(2)).toBe('fast');
    expect(ttkTone(3)).toBe('ok');
    expect(ttkTone(6)).toBe('slow');
    expect(ttkTone(null)).toBe('none');
  });
});

describe('reticles', () => {
  it('mil-dots every 5 mil at the scale given; the fine cross stays inside the lens', () => {
    const dotsAt = (svg: string): number[] => [...svg.matchAll(/<circle cx="([\d.]+)" cy="0"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    const u4 = 0.69; // units per mil at 4× on 1080p
    const d4 = dotsAt(milDotMarkup(u4));
    expect(d4[0]).toBeCloseTo(5 * u4, 2);
    expect(d4[1]! - d4[0]!).toBeCloseTo(5 * u4, 2);
    const d8 = dotsAt(milDotMarkup(u4 * 2));
    expect(d8[0]).toBeCloseTo(10 * u4, 2);
    expect(Math.max(...d8)).toBeLessThan(80);
  });

  it('mil-dots: 10 mil apart when 5 mil would crowd; a bow scope leaves the ladder side (below) clear', () => {
    const dotsAt = (svg: string): number[] => [...svg.matchAll(/<circle cx="([\d.]+)" cy="0"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    const u = 0.4; // 2 units per 5 mil
    const fine = dotsAt(milDotMarkup(u));
    const coarse = dotsAt(milDotMarkup(u, false, 3));
    expect(fine[1]! - fine[0]!).toBeCloseTo(5 * u, 2);
    expect(coarse[1]! - coarse[0]!).toBeCloseTo(10 * u, 2);
    const below = (svg: string): number => [...svg.matchAll(/<circle cx="0" cy="([\d.]+)"/g)].filter((m) => Number(m[1]) > 0).length;
    expect(below(milDotMarkup(2))).toBeGreaterThan(0);
    expect(below(milDotMarkup(2, true))).toBe(0);
  });

  it('marksman stadia: one bracket per range, taller for nearer heroes', () => {
    const svg = marksmanMarkup(300);
    for (const d of STADIA_RANGES) expect(svg).toContain(`>${d}</text>`);
    const hs = [...svg.matchAll(/<line x1="(\d+)" y1="(-?[\d.]+)" x2="\1" y2="([\d.]+)"\/>/g)].map((m) => Number(m[3]) - Number(m[2]));
    expect(hs.length).toBe(4);
    for (let i = 1; i < hs.length; i++) expect(hs[i]!).toBeLessThan(hs[i - 1]!);
  });
});

describe('touch', () => {
  it('hold to aim, release to fire: sniper / bows / DMRs only, only when the setting is on', () => {
    expect(fireOnRelease(W('qilin'), true)).toBe(true);
    expect(fireOnRelease(W('liegong'), true)).toBe(true);
    expect(fireOnRelease(W('qinggang'), true)).toBe(true);
    expect(fireOnRelease(W('carbine'), true)).toBe(false);
    expect(fireOnRelease(W('qilin'), false)).toBe(false);
    expect(fireOnRelease(undefined, true)).toBe(false);
  });

  it('gyro: turning the phone left turns the view left (yaw +), tilting it up looks up, in every orientation', () => {
    const r = (x: number): number => (x * Math.PI) / 180;
    // portrait: gamma about the screen's up axis, beta about its right axis
    expect(gyroLook({ gamma: 90 }, 0, 1).yaw).toBeCloseTo(r(90), 9);
    expect(gyroLook({ beta: 90 }, 0, 1).pitch).toBeCloseTo(r(90), 9);
    // landscape (90): the screen's up axis is the device's x axis
    expect(gyroLook({ beta: 45 }, 90, 0.5).yaw).toBeCloseTo(r(22.5), 9);
    expect(gyroLook({ gamma: 45 }, 90, 1).pitch).toBeCloseTo(-r(45), 9);
    expect(gyroLook({ beta: 45 }, 270, 1).yaw).toBeCloseTo(-r(45), 9);
    expect(gyroLook({ gamma: 45 }, -90, 1).pitch).toBeCloseTo(r(45), 9);
    expect(gyroLook({}, 0, 1)).toEqual({ yaw: 0, pitch: 0 });
  });
});
