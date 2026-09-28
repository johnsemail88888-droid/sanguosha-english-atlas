// In-match skill clarity logic (src/ui/hud/skills.ts): cast results from the event
// stream, the held-skill hint, first-ready tips.
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../../src/core/types';
import { ABILITY_BY_ID } from '../../../src/data';
import { SKILL_TIPS_KEY, SelfCcModel, SkillCastTracker, aimHintText, castResultText, castWindow, readTipCounts, readyTip } from '../../../src/ui/hud/skills';

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
    expect(aimHintText(ABILITY_BY_ID.guanyu_qinglong, 'Q', true, 'zh')).toEqual({ name: '青龙斩', how: '松开 Q 施放 · 右键取消', bad: false, warn: false });
    expect(aimHintText(ABILITY_BY_ID.guanyu_yijue, 'E', false, 'zh')).toEqual({ name: '义绝', how: '准星对准一名敌人（30 米内）', bad: true, warn: false });
    expect(aimHintText(ABILITY_BY_ID.liubei_jimin, 'Q', false, 'en').how).toBe('Put the crosshair on a hero (within 25 m)');
    expect(aimHintText(ABILITY_BY_ID.sunshangxiang_jieyin, 'Q', false, 'zh').how).toBe('准星对准一名男性武将（25 米内）');
  });

  it('an enemy aimed at out of range is "too far", not "aim at an enemy"', () => {
    const far = aimHintText(ABILITY_BY_ID.zhangliao_tuxi, 'Q', { valid: false, reason: 'far', targetId: 5, dist: 20.4 }, 'zh', { target: '孙权' });
    expect(far).toMatchObject({ how: '孙权 20 米 · 太远（12 米内）', bad: true });
    expect(aimHintText(ABILITY_BY_ID.zhangliao_tuxi, 'Q', { valid: false, reason: 'far', targetId: 5, dist: 20 }, 'en', { target: 'Sun Quan' }).how).toBe('Sun Quan 20 m · too far (within 12 m)');
    // a skill that works without a target still casts (on you), in amber
    const qn = aimHintText(ABILITY_BY_ID.huatuo_qingnang, 'E', { valid: true, reason: 'far', targetId: 5, dist: 40 }, 'zh', { target: '张飞' });
    expect(qn).toMatchObject({ bad: false, warn: true });
    expect(qn.how).toContain('对自己施放');
  });

  it('names the target, 反间 / 离间 partners, the fallback, how many the area catches, a clamped point', () => {
    expect(aimHintText(ABILITY_BY_ID.guanyu_yijue, 'E', { valid: true, targetId: 3 }, 'zh', { target: '张飞' }).how).toBe('松开 E 施放 · → 张飞 · 右键取消');
    expect(aimHintText(ABILITY_BY_ID.zhouyu_fanjian, 'Q', { valid: true, targetId: 3, linkId: 4 }, 'zh', { target: '关羽', link: '张飞' }).how).toContain('关羽 → 张飞');
    const alone = aimHintText(ABILITY_BY_ID.zhouyu_fanjian, 'Q', { valid: true, targetId: 3, fallback: 'disarm' }, 'zh', { target: '关羽' });
    expect(alone).toMatchObject({ bad: false, warn: true });
    expect(alone.how).toContain('关羽 身边无人 → 改为缴械 3 秒');
    expect(aimHintText(ABILITY_BY_ID.diaochan_lijian, 'Q', { valid: false, reason: 'alone', targetId: 3 }, 'zh', { target: '关羽' })).toMatchObject({ how: '关羽 身边 15 米内无人可离间', bad: true });
    expect(aimHintText(ABILITY_BY_ID.zhangliao_weizhen, 'E', { valid: true, caught: 4 }, 'zh').how).toBe('松开 E 施放 · 范围内 4 人 · 右键取消');
    const clamped = aimHintText(ABILITY_BY_ID.zhugeliang_bazhen, 'Q', { valid: true, clamped: 30 }, 'zh');
    expect(clamped).toMatchObject({ warn: true });
    expect(clamped.how.startsWith('超出射程 · 落在 30 米处')).toBe(true);
  });
});

describe('反间 cast result', () => {
  it('says why it disarmed instead of charming', () => {
    const r = { seq: 1, abilityId: 'zhouyu_fanjian', units: 0, heroes: 0, damage: 0, statuses: [{ id: 'disarm' as const, n: 1 }], target: 7, done: false, missed: false, self: false };
    expect(castResultText(r, 'zh', '关羽')).toBe('→ 关羽（附近无人可打）');
    expect(castResultText({ ...r, statuses: [{ id: 'charm', n: 1 }] }, 'zh', '关羽')).toBe('→ 关羽');
  });
});

describe('what enemy skills do to you (SelfCcModel)', () => {
  const pos: Record<number, { x: number; z: number }> = { 1: { x: 0, z: 0 }, 9: { x: 0, z: -8 }, 10: { x: 30, z: 0 } };
  const posOf = (id: number) => pos[id] ?? null;
  const names: Record<number, string> = { 9: '关羽', 10: '张辽' };

  it('names the control effect, what it does, the time left and who did it', () => {
    const b = new SelfCcModel((id) => names[id] ?? null);
    b.ingest([{ t: 'ability', src: 9, ability: 'guanyu_yijue', target: 1 }, { t: 'status', target: 1, status: 'silence', on: true, dur: 6 }], 1, 10, posOf);
    const v = b.view({ statuses: [{ id: 'silence', remaining: 5.8 }], dead: false }, 10.2, 'zh');
    expect(v).toMatchObject({ kind: 'cc', icon: '默', text: '沉默 5.8 秒 · 不能放技能、用锦囊 ← 关羽「义绝」', frac: 1 });
    // the bar drains
    expect(b.view({ statuses: [{ id: 'silence', remaining: 2.9 }], dead: false }, 13, 'zh')!.frac).toBeCloseTo(0.5, 6);
    // stun outranks silence
    expect(b.view({ statuses: [{ id: 'silence', remaining: 2 }, { id: 'stun', remaining: 1.2 }], dead: false }, 14, 'zh')!.text).toBe('眩晕 1.2 秒 · 不能移动、开火、放技能');
    expect(b.view({ statuses: [], dead: false }, 15, 'zh')).toBeNull();
    expect(b.view({ statuses: [{ id: 'silence', remaining: 2 }], dead: true }, 15, 'zh')).toBeNull();
  });

  it('an area skill around you is the source when nothing was aimed at you; one far away is not', () => {
    const b = new SelfCcModel((id) => names[id] ?? null);
    // 张辽 30 m away: his 10 m 威震 cannot have reached you
    b.ingest([{ t: 'ability', src: 10, ability: 'zhangliao_weizhen' }, { t: 'status', target: 1, status: 'silence', on: true }], 1, 5, posOf);
    expect(b.view({ statuses: [{ id: 'silence', remaining: 2 }], dead: false }, 5, 'zh')!.text).not.toContain('←');
    pos[10] = { x: 6, z: 0 };
    b.ingest([{ t: 'ability', src: 10, ability: 'zhangliao_weizhen' }, { t: 'status', target: 1, status: 'silence', on: true }], 1, 6, posOf);
    expect(b.view({ statuses: [{ id: 'silence', remaining: 2 }], dead: false }, 6, 'zh')!.text).toContain('← 张辽「威震逍遥津」');
  });

  it('a skill that only hurts you gets a short notice with its damage', () => {
    const b = new SelfCcModel((id) => names[id] ?? null);
    const def = ABILITY_BY_ID.guanyu_qinglong;
    b.ingest([{ t: 'ability', src: 9, ability: def.id }, { t: 'hit', target: 1, src: 9, amount: 50, dtype: def.dtype!, pos: { x: 0, y: 0, z: 0 } }, { t: 'hit', target: 1, src: 9, amount: 27, dtype: def.dtype!, pos: { x: 0, y: 0, z: 0 } }], 1, 3, posOf);
    expect(b.view({ statuses: [], dead: false }, 3.1, 'zh')).toMatchObject({ kind: 'hit', text: '关羽「青龙斩」 −77' });
    expect(b.view({ statuses: [], dead: false }, 9, 'zh')).toBeNull();
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
