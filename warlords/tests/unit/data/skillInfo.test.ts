import { describe, expect, it } from 'vitest';
import { HEROES, isPassiveAbility } from '../../../src/data';
import type { AbilityDef } from '../../../src/data/types';
import { SKILL_LINES, fillSkillTemplate, fmtNum, skillAim, skillAimed, skillArea, skillLine, skillStats, skillStatsText, templateKeys } from '../../../src/data/skillInfo';

const ALL: AbilityDef[] = HEROES.flatMap((h) => h.abilities);
const byId = (id: string): AbilityDef => ALL.find((a) => a.id === id)!;

describe('skill one-liners', () => {
  it('every ability of every hero has a zh + en line', () => {
    const missing = ALL.filter((a) => !SKILL_LINES[a.id]).map((a) => a.id);
    expect(missing).toEqual([]);
    // and no line for an ability that does not exist
    const known = new Set(ALL.map((a) => a.id));
    expect(Object.keys(SKILL_LINES).filter((id) => !known.has(id))).toEqual([]);
  });

  it('every placeholder names a real number of that ability (no text drifts from the params)', () => {
    const bad: string[] = [];
    for (const a of ALL) {
      for (const tpl of SKILL_LINES[a.id] ?? []) {
        for (const k of templateKeys(tpl)) {
          const v = k === 'cd' ? a.cooldown : k === 'charges' ? a.charges : a.params[k];
          if (v === undefined || !Number.isFinite(v)) bad.push(`${a.id}: {${k}}`);
        }
        if (fillSkillTemplate(tpl, a).includes('?')) bad.push(`${a.id}: unresolved in "${tpl}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('zh and en lines carry the same numbers', () => {
    for (const a of ALL) {
      const [zh, en] = SKILL_LINES[a.id];
      expect(templateKeys(zh).sort(), a.id).toEqual(templateKeys(en).sort());
    }
  });

  it('lines stay one line (short enough for a tooltip / the first-ready tip)', () => {
    for (const a of ALL) {
      expect(skillLine(a, 'zh').length, a.id).toBeLessThanOrEqual(40);
      expect(skillLine(a, 'en').length, a.id).toBeLessThanOrEqual(96);
    }
  });

  it('fills numbers from the params: plain, fraction, bonus and reduction', () => {
    expect(skillLine(byId('guanyu_qinglong'), 'zh')).toBe('冲锋至多 8 米（遇敌即停），横扫前方：90 伤害并击退');
    expect(skillLine(byId('guanyu_yijue'), 'en')).toBe('Silence the aimed enemy for 6 s; you deal it +30%');
    expect(skillLine(byId('zhangfei_shemao'), 'zh')).toContain('霰弹换弹快 40%');
    expect(skillLine(byId('huangzhong_laodang'), 'zh')).toBe('回复 25% 最大生命，加速 30% 5 秒');
    // a changed param changes the text
    const tuned = { ...byId('guanyu_qinglong'), params: { ...byId('guanyu_qinglong').params, damage: 120 } };
    expect(skillLine(tuned, 'zh')).toContain('120 伤害');
    expect(fillSkillTemplate('{cd} / {charges} / {nope}', { params: {}, cooldown: 9, charges: 3 })).toBe('9 / 3 / ?');
  });

  it('formats numbers without float noise', () => {
    expect(fmtNum(8)).toBe('8');
    expect(fmtNum(2.5)).toBe('2.5');
    expect(fmtNum(0.35)).toBe('0.35');
    expect(fmtNum(0.1 + 0.2)).toBe('0.3');
  });
});

describe('skill areas (targeting preview)', () => {
  it('passives and passive lord skills have no area and are not aimed', () => {
    for (const a of ALL.filter(isPassiveAbility)) {
      expect(skillArea(a), a.id).toBeNull();
      expect(skillAim(a)).toBe('passive');
      expect(skillAimed(a)).toBe(false);
    }
  });

  it('every point / enemy / ally / direction skill has an area with real sizes', () => {
    for (const a of ALL) {
      if (isPassiveAbility(a) || a.targeting === 'self' || a.targeting === undefined) continue;
      const area = skillArea(a);
      expect(area, a.id).not.toBeNull();
      const nums = Object.entries(area!).filter(([, v]) => typeof v === 'number') as [string, number][];
      for (const [k, v] of nums) expect(Number.isFinite(v) && v >= 0, `${a.id}.${k}=${v}`).toBe(true);
    }
  });

  it('reads the shapes off the params', () => {
    expect(skillArea(byId('guanyu_qinglong'))).toEqual({ kind: 'dash', length: 8, width: 0, endRadius: 4.5, endArc: 110, stop: { width: 1, gap: 1.2 } });
    expect(skillArea(byId('xiahoudun_charge'))).toMatchObject({ kind: 'dash', length: 12, stop: { heroesOnly: true } });
    expect(skillArea(byId('zhaoyun_qijin'))).toEqual({ kind: 'dash', length: 7, width: 1.5 });
    expect(skillArea(byId('zhangfei_duanqiao'))).toEqual({ kind: 'cone', range: 10, arc: 70 });
    expect(skillArea(byId('zhugeliang_bazhen'))).toEqual({ kind: 'circle', range: 30, radius: 7 });
    expect(skillArea(byId('guanyu_yijue'))).toEqual({ kind: 'target', range: 30, side: 'enemy' });
    expect(skillArea(byId('huatuo_qingnang'))).toMatchObject({ kind: 'target', side: 'ally', selfFallback: true });
    expect(skillArea(byId('zhangliao_weizhen'))).toEqual({ kind: 'ring', radius: 10 });
    // 火烧连营: fields at 4 × (0.75 + i), radius 2.5 → a strip from 0.5 m to 21.5 m
    expect(skillArea(byId('luxun_huoshao'))).toEqual({ kind: 'line', start: 0.5, length: 21, width: 2.5 });
    // 火船: 12 m/s × 3 s, a 6 m blast at the end
    expect(skillArea(byId('huanggai_huochuan'))).toMatchObject({ kind: 'line', start: 1, length: 35, endRadius: 6, reach: 36 });
    // pure self buffs: cast on press, nothing on the ground
    expect(skillArea(byId('xuchu_luoyi'))).toBeNull();
    expect(skillAimed(byId('xuchu_luoyi'))).toBe(false);
    expect(skillAimed(byId('guanyu_qinglong'))).toBe(true);
    expect(skillAim(byId('zhugeliang_bazhen'))).toBe('point');
    expect(skillAim(byId('lubu_fangtian'))).toBe('around');
    expect(skillAim(byId('machao_charge'))).toBe('forward');
    expect(skillAim(byId('liubei_jimin'))).toBe('ally');
  });
});

describe('key-number chips', () => {
  it('every active skill shows at least its cooldown, and never a NaN', () => {
    for (const a of ALL) {
      const stats = skillStats(a, 'zh');
      for (const s of stats) expect(s.value, `${a.id} ${s.kind}`).not.toMatch(/NaN|undefined|\?/);
      if (!isPassiveAbility(a)) expect(stats.some((s) => s.kind === 'cooldown'), a.id).toBe(true);
    }
  });

  it('青龙斩: damage, move, area, arc, cooldown — in that order', () => {
    expect(skillStats(byId('guanyu_qinglong'), 'zh').map((s) => `${s.label} ${s.value}`)).toEqual(['伤害 90', '位移 8 米', '范围 4.5 米', '扇形 110°', '冷却 9 秒']);
    expect(skillStatsText(byId('guanyu_qinglong'), 'en', 3)).toBe('Damage 90 · Move 8 m · Area 4.5 m');
  });

  it('multi-hit damage reads as hits × damage', () => {
    expect(skillStats(byId('zhangjiao_leiji'), 'zh')[0]).toMatchObject({ kind: 'damage', value: '3×42' });
    expect(skillStats(byId('xiahouyuan_shensu'), 'zh')[0]).toMatchObject({ kind: 'damage', value: '5×22' });
    expect(skillStats(byId('yuanshao_luanji'), 'zh')[0]).toMatchObject({ kind: 'damage', value: '16×6' });
  });

  it('crowd control and charges show up', () => {
    const tuxi = skillStats(byId('zhangliao_weizhen'), 'en');
    expect(tuxi.find((s) => s.kind === 'silence')?.value).toBe('2 s');
    expect(tuxi.find((s) => s.kind === 'slow')?.value).toBe('30%');
    expect(skillStats(byId('zhaoyun_qijin'), 'zh').find((s) => s.kind === 'charges')?.value).toBe('3');
    expect(skillStats(byId('huatuo_mafei'), 'zh').find((s) => s.kind === 'stun')?.value).toBe('1.2 秒');
  });

  it('a fallback effect is not shown as the skill’s point, a preview-only length is not a range', () => {
    expect(skillStats(byId('zhouyu_fanjian'), 'zh').some((s) => s.kind === 'disarm')).toBe(false);
    expect(skillStats(byId('huangzhong_chuanyang'), 'zh').some((s) => s.kind === 'range')).toBe(false);
    expect(skillStats(byId('lubu_sheji'), 'zh').find((s) => s.kind === 'range')?.value).toBe('120 米');
    // a marker at the point (空投, 炮台) is not an area
    expect(skillStats(byId('guojia_yiji'), 'zh').some((s) => s.kind === 'radius')).toBe(false);
  });
});

describe('long descriptions agree with the params', () => {
  // every number the player reads in descZh / descEn is a param (as is, as a percentage,
  // or as a multiplier's bonus / reduction), the cooldown or the charges: tuning a param
  // without the text (or the other way round) fails here
  it('no number in a description is missing from the ability data', () => {
    const drift: string[] = [];
    for (const a of ALL) {
      const vals = new Set<number>();
      const addV = (v: number): void => {
        for (const x of [v, v * 100, (v - 1) * 100, (1 - v) * 100]) vals.add(Math.round(x * 100) / 100);
      };
      for (const v of Object.values(a.params)) addV(v);
      if (a.cooldown) addV(a.cooldown);
      if (a.charges) addV(a.charges);
      for (const d of [a.descZh, a.descEn]) {
        const bad = [...d.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((n) => n !== 1 && !vals.has(n));
        if (bad.length) drift.push(`${a.id}: ${bad.join(', ')} in "${d}"`);
      }
    }
    expect(drift).toEqual([]);
  });
});
