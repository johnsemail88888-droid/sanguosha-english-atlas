// In-match skill clarity logic (src/ui/hud/skills.ts): cast results from the event
// stream, the held-skill hint, first-ready tips.
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../../src/core/types';
import { ABILITY_BY_ID } from '../../../src/data';
import { SKILL_TIPS_KEY, SkillCastTracker, aimHintText, castResultText, castWindow, readTipCounts, readyTip } from '../../../src/ui/hud/skills';

const ME = 1;
const me = { id: ME, heroId: 'guanyu' };
const info = { isOwn: (id: number) => id === ME || id === 50, isHero: (id: number) => id < 10 };
const pos = { x: 0, y: 0, z: 0 };
const hit = (target: number, amount: number, dtype: 'melee' | 'normal' | 'fire' = 'melee', src = ME): GameEvent => ({ t: 'hit', target, src, amount, dtype, pos });

describe('SkillCastTracker', () => {
  it('counts the distinct units a cast hits with its own damage type', () => {
    const tr = new SkillCastTracker();
    const r0 = tr.push([{ t: 'ability', src: ME, ability: 'guanyu_qinglong' }], me, 0, info);
    expect(r0).toEqual([]); // nothing to show until something lands
    const r1 = tr.push([hit(2, 90), hit(3, 90), hit(20, 90), hit(2, 30)], me, 0.3, info);
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ abilityId: 'guanyu_qinglong', units: 3, heroes: 2, damage: 300, done: false });
    expect(castResultText(r1[0], 'zh', null)).toBe('命中 3（武将 2）');
    expect(castResultText(r1[0], 'en', null)).toBe('3 hit (2 heroes)');
    const done = tr.tick(10);
    expect(done[0]).toMatchObject({ done: true, missed: false, units: 3 });
  });

  it('gun hits (a shot of mine at that unit in the same batch), other damage types, own units and blocked hits do not count', () => {
    const tr = new SkillCastTracker();
    tr.push([{ t: 'ability', src: ME, ability: 'guanyu_qinglong' }], me, 0, info);
    const r = tr.push(
      [
        { t: 'shot', src: ME, weapon: 'qinglong', from: pos, to: pos, hit: 4 },
        hit(4, 24, 'melee'), // shot this batch: a gun hit
        hit(5, 24, 'normal'), // bullets
        hit(50, 90), // my own soldier
        { t: 'hit', target: 6, src: ME, amount: 0, dtype: 'melee', pos, blocked: 'dodge' },
        hit(7, 90, 'melee', 9), // someone else's
      ],
      me,
      0.2,
      info,
    );
    expect(r).toEqual([]);
    const done = tr.tick(5);
    expect(done[0].missed).toBe(true);
    expect(castResultText(done[0], 'zh', null)).toBe('未命中');
  });

  it('a skill that fires the held weapon counts its shots (夏侯渊 神速)', () => {
    const tr = new SkillCastTracker();
    const xhy = { id: ME, heroId: 'xiahouyuan' };
    tr.push([{ t: 'ability', src: ME, ability: 'xiahouyuan_shensu' }], xhy, 0, info);
    const r = tr.push([{ t: 'shot', src: ME, weapon: 'x', from: pos, to: pos, hit: 3 }, hit(3, 22, 'normal'), hit(3, 22, 'normal')], xhy, 0.3, info);
    expect(r[0]).toMatchObject({ units: 1, damage: 44 });
  });

  it('a targeted skill reports its target at once; debuffs landing meanwhile are listed', () => {
    const tr = new SkillCastTracker();
    const r = tr.push([{ t: 'ability', src: ME, ability: 'guanyu_yijue', target: 3 }, { t: 'status', target: 3, status: 'silence', on: true }], me, 0, info);
    expect(r[0]).toMatchObject({ target: 3, statuses: [{ id: 'silence', n: 1 }] });
    expect(castResultText(r[0], 'zh', '张飞')).toBe('→ 张飞');
  });

  it('the sim applies the status before it reports the cast (same batch): still counted', () => {
    const tr = new SkillCastTracker();
    const r = tr.push([{ t: 'status', target: 3, status: 'silence', on: true }, { t: 'ability', src: ME, ability: 'guanyu_yijue', target: 3 }], me, 0, info);
    expect(r[0]).toMatchObject({ target: 3, statuses: [{ id: 'silence', n: 1 }] });
  });

  it('area crowd control: statuses on others, never on you or yours, never private ones', () => {
    const tr = new SkillCastTracker();
    const zl = { id: ME, heroId: 'zhangliao' };
    tr.push([{ t: 'ability', src: ME, ability: 'zhangliao_weizhen' }], zl, 0, info);
    const r = tr.push(
      [
        { t: 'status', target: 2, status: 'silence', on: true },
        { t: 'status', target: 3, status: 'silence', on: true },
        { t: 'status', target: 2, status: 'slow', on: true },
        { t: 'status', target: ME, status: 'slow', on: true },
        { t: 'status', target: 50, status: 'stun', on: true },
        { t: 'status', target: 4, status: 'haste', on: true }, // a buff
        { t: 'status', target: 5, status: 'reveal', on: true, privateTo: ME },
      ],
      zl,
      0.1,
      info,
    );
    expect(r[0].statuses).toEqual([
      { id: 'silence', n: 2 },
      { id: 'slow', n: 1 },
    ]);
    expect(tr.tick(9)[0].missed).toBe(false);
  });

  it('self skills say they are on; passives, procs, other heroes’ and other players’ casts are ignored', () => {
    const tr = new SkillCastTracker();
    const xc = { id: ME, heroId: 'xuchu' };
    const r = tr.push([{ t: 'ability', src: ME, ability: 'xuchu_luoyi' }], xc, 0, info);
    expect(r[0]).toMatchObject({ self: true });
    expect(castResultText(r[0], 'zh', null)).toBe('生效 7 秒');
    expect(tr.push([{ t: 'ability', src: ME, ability: 'xuchu_huchi' }], xc, 0, info)).toEqual([]);
    expect(tr.push([{ t: 'ability', src: ME, ability: 'xuchu_slam', proc: true }], xc, 0, info)).toEqual([]);
    expect(tr.push([{ t: 'ability', src: ME, ability: 'guanyu_yijue', target: 3 }], xc, 0, info)).toEqual([]);
    expect(tr.push([{ t: 'ability', src: 7, ability: 'xuchu_luoyi' }], xc, 0, info)).toEqual([]);
    expect(tr.push([{ t: 'ability', src: ME, ability: 'xuchu_luoyi' }], null, 0, info)).toEqual([]);
  });

  it('a control field nobody walked into yet is no miss; a damaging one that caught nobody is', () => {
    const tr = new SkillCastTracker();
    const zgl = { id: ME, heroId: 'zhugeliang' };
    tr.push([{ t: 'ability', src: ME, ability: 'zhugeliang_bazhen' }], zgl, 0, info);
    expect(tr.tick(1)).toEqual([]); // 八阵图 lasts 8 s: its window covers the first 3
    // a unit walking in is still counted
    const r = tr.push([{ t: 'status', target: 2, status: 'silence', on: true }], zgl, 2.5, info);
    expect(r[0].statuses).toEqual([{ id: 'silence', n: 1 }]);
    const empty = new SkillCastTracker();
    empty.push([{ t: 'ability', src: ME, ability: 'zhugeliang_bazhen' }], zgl, 0, info);
    expect(empty.tick(9)[0]).toMatchObject({ done: true, missed: false });
    const lx = new SkillCastTracker();
    lx.push([{ t: 'ability', src: ME, ability: 'luxun_huoshao' }], { id: ME, heroId: 'luxun' }, 0, info);
    expect(lx.tick(9)[0].missed).toBe(true);
  });

  it('cast windows follow the skill’s timing, within 0.8–4 s', () => {
    expect(castWindow(ABILITY_BY_ID.lubu_fangtian)).toBeCloseTo(0.8, 6);
    expect(castWindow(ABILITY_BY_ID.guanyu_qinglong)).toBeCloseTo(0.95, 6); // 0.6 + dash 0.35
    expect(castWindow(ABILITY_BY_ID.zhouyu_chibi)).toBeCloseTo(2.1, 6); // 0.6 + delay 1.5
    expect(castWindow(ABILITY_BY_ID.zhangjiao_leiji)).toBeCloseTo(1.8, 6); // 0.6 + 2 × 0.6
    expect(castWindow(ABILITY_BY_ID.zhangjiao_taiping)).toBe(4); // capped
    expect(castWindow(ABILITY_BY_ID.zhugeliang_bazhen)).toBeCloseTo(3.6, 6); // a lasting field: its first 3 s
  });
});

describe('held-skill hint', () => {
  it('how to cast, or what is missing', () => {
    expect(aimHintText(ABILITY_BY_ID.guanyu_qinglong, 'Q', true, 'zh')).toEqual({ name: '青龙斩', how: '松开 Q 施放 · 右键取消', bad: false });
    expect(aimHintText(ABILITY_BY_ID.guanyu_yijue, 'E', false, 'zh')).toEqual({ name: '义绝', how: '准星对准一名敌人（30 米内）', bad: true });
    expect(aimHintText(ABILITY_BY_ID.liubei_jimin, 'Q', false, 'en').how).toBe('Put the crosshair on a hero (within 25 m)');
    expect(aimHintText(ABILITY_BY_ID.sunshangxiang_jieyin, 'Q', false, 'zh').how).toBe('准星对准一名男性武将（25 米内）');
  });
});

describe('first-ready tips', () => {
  it('one line: key, name, what it does, how to cast', () => {
    expect(readyTip(ABILITY_BY_ID.guanyu_qinglong, 'zh')).toEqual({ key: 'Q', name: '青龙斩', line: '冲锋至多 8 米（遇敌即停），横扫前方：90 伤害并击退', how: '按住 Q 看范围' });
    expect(readyTip(ABILITY_BY_ID.xuchu_luoyi, 'en').how).toBe('press Q');
    expect(readyTip(ABILITY_BY_ID.guanyu_wusheng, 'zh')).toMatchObject({ key: '被动', how: '被动' });
  });

  it('reads the per-skill counts defensively', () => {
    expect(readTipCounts({ getItem: (k: string) => (k === SKILL_TIPS_KEY ? '{"guanyu_qinglong":2}' : null) })).toEqual({ guanyu_qinglong: 2 });
    expect(readTipCounts({ getItem: () => 'not json' })).toEqual({});
    expect(readTipCounts(null)).toEqual({});
  });
});
