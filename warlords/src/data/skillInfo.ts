// Player-facing skill facts generated from the ability data (AbilityDef.params),
// so the words and numbers the player reads never drift from what the sim does:
//  - skillLine(): one plain line per skill ("冲锋 8 米，横扫前方扇形：90 伤害并击退"),
//    written as a template whose numbers are filled in from params;
//  - skillStats(): the key numbers as chips (伤害 / 射程 / 范围 / 持续 / 冷却 …);
//  - skillArea(): what the skill covers, for the targeting preview drawn on the ground
//    while its key is held (render/vfx/skillPreview.ts) and the "how to aim" tag.
// Pure data: no DOM, no three.js (unit-tested in tests/unit/data/skillInfo.test.ts).
import type { AbilityDef } from './types';

export type SkillLang = 'zh' | 'en';

// ── area / aiming ────────────────────────────────────────────────────────────

/**
 * What a skill covers, in the sim's own numbers (meters, degrees). Directions are the
 * flat aim yaw; points are the crosshair point clamped to `range` (sim aimPoint).
 */
export type SkillArea =
  /** around the caster */
  | { kind: 'ring'; radius: number }
  /** a circle at the crosshair point (clamped to range) */
  | { kind: 'circle'; range: number; radius: number }
  /** the caster moves forward `length` m (dash / leap / blink); damage corridor half-width `width`
   * (0: nothing on the way); an effect at the end: `endRadius` m, `endArc`° wide (360: all around) */
  | { kind: 'dash'; length: number; width: number; endRadius?: number; endArc?: number; blink?: boolean }
  /** the caster teleports to the crosshair point (clamped to range) */
  | { kind: 'blinkPoint'; range: number; radius: number }
  /** a cone in front: `arc`° wide, `range` m long */
  | { kind: 'cone'; range: number; arc: number }
  /** a strip in front from `start` to `start + length` m, half-width `width`; `endRadius`: a blast at its end;
   * `reach`: the real range when the strip only shows part of it (the chips read it; absent: start + length) */
  | { kind: 'line'; start: number; length: number; width: number; endRadius?: number; reach?: number }
  /** the unit under the crosshair within `range` (a secondary area of `radius` m around it) */
  | { kind: 'target'; range: number; side: 'enemy' | 'ally'; radius?: number; selfFallback?: boolean };

/** How a skill is aimed, as the tag the player reads (准星敌人 / 前方 / 自身周围 …). */
export type AimTag = 'passive' | 'self' | 'around' | 'forward' | 'point' | 'enemy' | 'ally';

const num = (p: Record<string, number>, k: string, fb = 0): number => {
  const v = p[k];
  return v === undefined || !Number.isFinite(v) ? fb : v;
};

/** Per-skill areas the generic rules below cannot read off the params. */
const AREA_OVERRIDE: Readonly<Record<string, (p: Record<string, number>) => SkillArea | null>> = {
  // charge, then the sweep in front at the end of it
  guanyu_qinglong: (p) => ({ kind: 'dash', length: num(p, 'dash'), width: 0, endRadius: num(p, 'range'), endArc: num(p, 'arc') }),
  zhangfei_duanqiao: (p) => ({ kind: 'cone', range: num(p, 'range'), arc: num(p, 'arc') }),
  xuchu_slam: (p) => ({ kind: 'dash', length: num(p, 'leap'), width: 0, endRadius: num(p, 'radius'), endArc: 360 }),
  zhenji_lingbo: (p) => ({ kind: 'dash', length: num(p, 'blink'), width: 0, endRadius: num(p, 'burstRadius', num(p, 'radius')), endArc: 360, blink: true }),
  xiahouyuan_shensu: (p) => ({ kind: 'blinkPoint', range: num(p, 'range'), radius: 1 }),
  // the arrow flies 250 m: the preview shows the first stretch of its path
  huangzhong_chuanyang: () => ({ kind: 'line', start: 1, length: 60, width: 0.5, reach: 0 }),
  lubu_sheji: (p) => ({ kind: 'line', start: 1, length: Math.min(80, num(p, 'range', 80)), width: 0.35, reach: num(p, 'range') }),
  // the fire ship flies speed × lifetime and bursts at the end (or on contact)
  huanggai_huochuan: (p) => ({ kind: 'line', start: 1, length: num(p, 'speed') * num(p, 'lifetime') - 1, width: 1, endRadius: num(p, 'radius'), reach: num(p, 'speed') * num(p, 'lifetime') }),
  // blast centres from 0 to `length`, each `radius` wide
  zhouyu_chibi: (p) => ({ kind: 'line', start: 0, length: num(p, 'length'), width: num(p, 'radius') }),
  // fields at spacing × (0.75 + i), i < count, each `radius` wide
  luxun_huoshao: (p) => {
    const s = num(p, 'spacing');
    const r = num(p, 'radius');
    const first = s * 0.75;
    const last = s * (0.75 + Math.max(0, num(p, 'count') - 1));
    return { kind: 'line', start: Math.max(0, first - r), length: last - first + 2 * r, width: r };
  },
  // five arrows in a fan: the preview shows the fan's first 30 m
  sunshangxiang_gongyao: (p) => ({ kind: 'cone', range: 30, arc: num(p, 'spread') }),
  // the elephant charges `distance` m along your aim
  menghuo_xiangbing: (p) => ({ kind: 'line', start: 0, length: num(p, 'distance'), width: num(p, 'width') }),
  huangyueying_muniu: (p) => ({ kind: 'circle', range: num(p, 'range'), radius: 1 }),
  guojia_yiji: (p) => ({ kind: 'circle', range: num(p, 'range'), radius: 2 }),
  menghuo_nanman: (p) => ({ kind: 'circle', range: num(p, 'range'), radius: 3 }),
  // "no target → yourself"
  huatuo_qingnang: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'ally', selfFallback: true }),
  zhaoyun_jiuzhu: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'ally', selfFallback: true }),
  // no target → the squad charges freely
  caocao_ningjiao: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'enemy', selfFallback: true }),
  zhangliao_tuxi: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'enemy', radius: num(p, 'radius') }),
  // the second hero is picked around the first
  diaochan_lijian: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'enemy', radius: num(p, 'radius') }),
  diaochan_lianhuan: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'enemy', radius: num(p, 'radius') }),
  zhangjiao_taiping: (p) => ({ kind: 'target', range: num(p, 'range'), side: 'enemy', radius: num(p, 'radius') }),
  // self buffs whose `radius` is not an area the player aims
  zhugeliang_kongcheng: () => null,
};

/**
 * The area a skill covers (null: nothing to show on the ground — passives, pure self
 * buffs). Read from the targeting mode and the params (conventions in data/heroes.ts).
 */
export function skillArea(def: AbilityDef): SkillArea | null {
  if (def.slot === 'passive' || def.cooldown === undefined) return null;
  const p = def.params;
  const o = AREA_OVERRIDE[def.id];
  if (o) return o(p);
  switch (def.targeting) {
    case 'point':
      return { kind: 'circle', range: num(p, 'range', 30), radius: num(p, 'radius', 1.5) };
    case 'enemy':
    case 'ally':
      return { kind: 'target', range: num(p, 'range', 30), side: def.targeting };
    case 'direction': {
      if (p.dash !== undefined) return { kind: 'dash', length: num(p, 'dash'), width: num(p, 'width') };
      if (p.arc !== undefined) return { kind: 'cone', range: num(p, 'range'), arc: num(p, 'arc') };
      return { kind: 'line', start: 1, length: num(p, 'range', 40), width: num(p, 'width', 0.5) };
    }
    case 'self':
      return p.radius !== undefined && p.radius > 0 ? { kind: 'ring', radius: p.radius } : null;
    default:
      return null;
  }
}

/** The aim tag shown next to the skill name. */
export function skillAim(def: AbilityDef): AimTag {
  if (def.slot === 'passive' || def.cooldown === undefined) return 'passive';
  const a = skillArea(def);
  if (!a) return 'self';
  switch (a.kind) {
    case 'ring':
      return 'around';
    case 'circle':
    case 'blinkPoint':
      return 'point';
    case 'target':
      return a.side;
    default:
      return 'forward';
  }
}

export const AIM_LABEL: Readonly<Record<AimTag, readonly [string, string]>> = {
  passive: ['被动', 'Passive'],
  self: ['自身', 'Self'],
  around: ['自身周围', 'Around you'],
  forward: ['准星方向', 'Aimed direction'],
  point: ['准星落点', 'Aimed point'],
  enemy: ['准星敌人', 'Aimed enemy'],
  ally: ['准星友军', 'Aimed ally'],
};

/**
 * Should the key show a targeting preview while held and cast on release? Every skill
 * with an area on the ground or a unit to pick; pure self buffs still cast on press.
 */
export function skillAimed(def: AbilityDef | undefined): boolean {
  return !!def && skillArea(def) !== null;
}

// ── numbers ──────────────────────────────────────────────────────────────────

/** "8", "2.5", "0.35" (at most two decimals, no trailing zeros). */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const r = Math.round(v * 100) / 100;
  return String(r);
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const plusPct = (mul: number): string => `${Math.round((mul - 1) * 100)}%`;
const minusPct = (mul: number): string => `${Math.round((1 - mul) * 100)}%`;

/**
 * Fill a template's placeholders from the skill's numbers:
 *   {k} the param · {k%} a 0..1 fraction as a percentage · {k+%} a multiplier's bonus
 *   (1.3 → 30%) · {k-%} a multiplier's reduction (0.6 → 40%) · {cd} cooldown · {charges}.
 * Unknown keys render as '?' (the unit test forbids them).
 */
export function fillSkillTemplate(tpl: string, def: Pick<AbilityDef, 'params' | 'cooldown' | 'charges'>): string {
  return tpl.replace(/\{(\w+)(%|\+%|-%)?\}/g, (_m, key: string, mode: string | undefined) => {
    let v: number | undefined;
    if (key === 'cd') v = def.cooldown;
    else if (key === 'charges') v = def.charges;
    else v = def.params[key];
    if (v === undefined || !Number.isFinite(v)) return '?';
    if (mode === '%') return pct(v);
    if (mode === '+%') return plusPct(v);
    if (mode === '-%') return minusPct(v);
    return fmtNum(v);
  });
}

/** Placeholder keys a template uses (for the unit test). */
export function templateKeys(tpl: string): string[] {
  return [...tpl.matchAll(/\{(\w+)(?:%|\+%|-%)?\}/g)].map((m) => m[1]);
}

// ── one-line summaries ───────────────────────────────────────────────────────
// Short, verb first, the one thing to know. The full rules stay in descZh / descEn.

export const SKILL_LINES: Readonly<Record<string, readonly [string, string]>> = {
  // 刘备
  liubei_rende: ['治疗其他武将时，你也回复其 {selfHealFrac%}；带兵 +{troopBonus}', 'Healing another hero heals you {selfHealFrac%} of it; squad +{troopBonus}'],
  liubei_jimin: ['给准星处武将投补给：回复 {heal} 并送 1 张牌', 'Toss supplies to the aimed hero: +{heal} HP and a card'],
  liubei_banner: ['插旗：{radius} 米内每秒回复 {hps}，持续 {duration} 秒', 'Plant a banner: {hps} HP/s within {radius} m for {duration} s'],
  liubei_jijiang: ['召 {count} 名义军；{radius} 米内蜀将射速 +{fireRateMul+%}', 'Summon {count} militia; Shu heroes within {radius} m fire {fireRateMul+%} faster'],
  // 关羽
  guanyu_wusheng: ['近战、火焰、爆炸伤害 +{mul+%}', 'Melee, fire and explosive damage +{mul+%}'],
  guanyu_qinglong: ['冲锋 {dash} 米，横扫前方扇形：{damage} 伤害并击退', 'Charge {dash} m and sweep ahead: {damage} damage + knockback'],
  guanyu_yijue: ['沉默准星处敌人 {duration} 秒，你对其伤害 +{mul+%}', 'Silence the aimed enemy for {duration} s; you deal it +{mul+%}'],
  // 张飞
  zhangfei_shemao: ['霰弹换弹快 {reloadMul-%}；击杀后 {killNoReload} 秒不耗弹', 'Shotgun reloads {reloadMul-%} faster; {killNoReload} s free ammo after a kill'],
  zhangfei_paoxiao: ['{duration} 秒不耗弹、射速 +{fireRateMul+%}；{radius} 米内敌人减速', '{duration} s free ammo, fire rate +{fireRateMul+%}; slows enemies within {radius} m'],
  zhangfei_duanqiao: ['向前 {range} 米怒吼：{damage} 伤害、击退并眩晕', 'Roar {range} m ahead: {damage} damage, knockback and stun'],
  // 诸葛亮
  zhugeliang_guanxing: ['每 {interval} 秒看穿 {radius} 米内武将 {duration} 秒（仅你可见）', 'Every {interval} s, see heroes within {radius} m for {duration} s (only you)'],
  zhugeliang_bazhen: ['在准星处布 {radius} 米石阵 {duration} 秒：敌人减速并沉默', 'Place a {radius} m stone maze for {duration} s: enemies slowed + silenced'],
  zhugeliang_kongcheng: ['{duration} 秒无敌、不可选中（不能攻击）', '{duration} s invulnerable and untargetable (cannot attack)'],
  // 赵云
  zhaoyun_longdan: ['闪避上限 {maxDodges}；闪避后 {duration} 秒伤害 +{mul+%}', 'Up to {maxDodges} dodges; +{mul+%} damage for {duration} s after one'],
  zhaoyun_qijin: ['无敌冲刺 {dash} 米，穿过的敌人受 {damage} 伤害', 'Invulnerable dash {dash} m: {damage} damage to enemies passed'],
  zhaoyun_jiuzhu: ['冲向准星处友军：你们各得 {shield} 护盾', 'Rush to the aimed ally: {shield} shield for both of you'],
  // 马超
  machao_mashu: ['始终骑马：移速 +{speedMul+%}', 'Always mounted: +{speedMul+%} move speed'],
  machao_tieji: ['{duration} 秒内攻击必中、无视护甲、附带沉默', 'For {duration} s your hits cannot be dodged, pierce armor and silence'],
  machao_charge: ['策马冲锋 {dash} 米：沿途 {damage} 伤害并击退', 'Charge {dash} m on horseback: {damage} damage + knockback on the way'],
  // 黄月英
  huangyueying_jizhi: ['每用 1 张锦囊，技能冷却 -{cdr} 秒', 'Each card you use: skill cooldowns -{cdr} s'],
  huangyueying_muniu: ['在准星处放自动炮台（{lifetime} 秒，最多 {maxActive} 座）', 'Deploy an auto turret at the crosshair ({lifetime} s, up to {maxActive})'],
  huangyueying_qicai: ['{duration} 秒：炮台与士兵射速 +{fireRateMul+%}，你不耗弹', '{duration} s: turrets & soldiers fire +{fireRateMul+%}, you use no ammo'],
  // 黄忠
  huangzhong_liegong: ['对 {minDist} 米外目标必中，伤害 +{mul+%}', 'Hits beyond {minDist} m cannot be dodged and deal +{mul+%}'],
  huangzhong_chuanyang: ['射出穿甲箭：{damage} 伤害，穿透 {pierce} 个目标', 'Piercing arrow: {damage} damage through up to {pierce} targets'],
  huangzhong_laodang: ['回复 {healFrac%} 最大生命，加速 {haste%} {duration} 秒', 'Heal {healFrac%} max HP and gain {haste%} speed for {duration} s'],
  // 曹操
  caocao_jianxiong: ['受到武器伤害的 {frac%} 转为护盾', '{frac%} of weapon damage taken becomes shield'],
  caocao_ningjiao: ['{duration} 秒：士兵伤害 +{troopDmgMul+%} 并冲向准星目标；你吸血', '{duration} s: soldiers +{troopDmgMul+%} damage, rush the aimed target; you lifesteal'],
  caocao_wangmei: ['士兵回满血，你回复 {selfHeal}，全体加速 {duration} 秒', 'Soldiers fully healed, you +{selfHeal} HP, all hasted {duration} s'],
  caocao_hujia: ['召 {count} 名亲卫；{duration} 秒内 {redirectFrac%} 伤害由周围魏军承担', 'Summon {count} guards; for {duration} s nearby Wei units take {redirectFrac%} of your damage'],
  // 司马懿
  simayi_fankui: ['被武将打伤时，偷其 1 张锦囊', 'When a hero hurts you, steal one of their cards'],
  simayi_guicai: ['{duration} 秒内子弹伤害减半，并反弹给射手', 'For {duration} s bullets deal half and bounce back to the shooter'],
  simayi_langgu: ['看穿 {radius} 米内武将 {duration} 秒，对其伤害 +{mul+%}', 'See heroes within {radius} m for {duration} s; +{mul+%} damage to them'],
  // 夏侯惇
  xiahoudun_ganglie: ['受伤时把 {reflectFrac%} 伤害反弹给攻击者', 'Reflect {reflectFrac%} of damage taken to the attacker'],
  xiahoudun_bashi: ['回复已损失生命的 {missingFrac%}；{duration} 秒伤害 +{mul+%}', 'Heal {missingFrac%} of missing HP; +{mul+%} damage for {duration} s'],
  xiahoudun_charge: ['冲锋 {dash} 米：撞到的首个武将受 {damage} 伤害并眩晕', 'Charge {dash} m: the first hero hit takes {damage} and is stunned'],
  // 张辽
  zhangliao_liaolai: ['攻击背对你的目标伤害 +{mul+%}', '+{mul+%} damage to targets facing away'],
  zhangliao_tuxi: ['闪到准星处敌人身后，偷附近至多 {maxTargets} 人的锦囊', 'Blink behind the aimed enemy; steal a card from up to {maxTargets} nearby'],
  zhangliao_weizhen: ['{radius} 米内敌将沉默 {silence} 秒并减速，士兵眩晕', 'Enemy heroes within {radius} m silenced {silence} s + slowed; soldiers stunned'],
  // 许褚
  xuchu_huchi: ['免疫击退与击飞；带兵 +{troopBonus}', 'Immune to knockback; squad +{troopBonus}'],
  xuchu_luoyi: ['{duration} 秒伤害 +{mul+%}，但受到伤害 +{takenMul+%}', '{duration} s: +{mul+%} damage dealt, +{takenMul+%} taken'],
  xuchu_slam: ['向前跃起 {leap} 米砸地：{radius} 米内 {damage} 伤害并击飞', 'Leap {leap} m and slam: {damage} damage + knock-up within {radius} m'],
  // 郭嘉
  guojia_tiandu: ['单次受伤 ≥{threshold}：得 1 张锦囊并装满弹匣', 'Taking ≥{threshold} in one hit: gain a card and refill your magazine'],
  guojia_yiji: ['在准星处呼叫空投：{delay} 秒后落下 {items} 张锦囊', 'Call an airdrop at the crosshair: {items} cards land after {delay} s'],
  guojia_guimou: ['标记准星处敌人 {duration} 秒：受到伤害 +{takenMul+%} 并暴露', 'Mark the aimed enemy {duration} s: takes +{takenMul+%} damage, revealed'],
  // 甄姬
  zhenji_qingguo: ['移动中 {chance%} 几率闪开子弹', 'While moving, {chance%} chance to evade bullets'],
  zhenji_luoshen: ['连续判定最多 {maxDraws} 次，每次成功得 1 张锦囊', 'Draw up to {maxDraws} times; each success gives a card'],
  zhenji_lingbo: ['向前闪现 {blink} 米：落点 {damage} 冰霜伤害，原地留减速冰区', 'Blink {blink} m: {damage} frost damage where you land, a slowing field behind'],
  // 夏侯渊
  xiahouyuan_jixing: ['移速 +{speedMul+%}；冲刺时不收镜', '+{speedMul+%} move speed; sprinting keeps your aim'],
  xiahouyuan_shensu: ['闪现到准星处（{range} 米内），向最近敌人齐射 {shots} 发', 'Blink to the crosshair (≤{range} m) and fire {shots} shots at the nearest enemy'],
  xiahouyuan_hubu: ['加速 {haste%} {duration} 秒，并回满闪避', '{haste%} speed for {duration} s and full dodge charges'],
  // 孙权
  sunquan_quanheng: ['所有武器换弹快 {reloadMul-%}', 'All weapons reload {reloadMul-%} faster'],
  sunquan_zhiheng: ['重抽全部锦囊（多得 {extra} 张），装满弹匣、回满闪避', 'Redraw all cards (+{extra}), refill magazine and dodges'],
  sunquan_zuoduan: ['立即征召 {count} 名士兵', 'Recruit {count} soldiers at once'],
  sunquan_jiuyuan: ['{duration} 秒：你与 {radius} 米内吴军受伤 -{takenMul-%}', '{duration} s: you and Wu units within {radius} m take {takenMul-%} less'],
  // 甘宁
  ganning_jinfan: ['移速 +{speedMul+%}；击杀后装满弹匣', '+{speedMul+%} move speed; a kill refills your magazine'],
  ganning_qixi: ['电磁弩射准星处敌人：打落护甲坐骑、清护盾、沉默 {silence} 秒', 'EMP bolt at the aimed enemy: drops armor & mount, clears shield, silences {silence} s'],
  ganning_jieying: ['你与士兵潜行 {duration} 秒，首轮攻击 +{firstHitMul+%}', 'You and your soldiers stealth {duration} s; first volley +{firstHitMul+%}'],
  // 吕蒙
  lumeng_keji: ['{idleTime} 秒不开火也不受伤，自动潜行', 'After {idleTime} s without firing or damage, you stealth'],
  lumeng_baiyi: ['潜行 {duration} 秒并加速 {haste%}（开火解除）', 'Stealth {duration} s with {haste%} speed (firing breaks it)'],
  lumeng_gongxin: ['缴械准星处敌人 {disarm} 秒并偷 1 张锦囊', 'Disarm the aimed enemy {disarm} s and steal a card'],
  // 黄盖
  huanggai_chidan: ['生命低于 {hpFrac%} 时火焰/爆炸伤害 +{mul+%}', 'Below {hpFrac%} HP: fire & explosive damage +{mul+%}'],
  huanggai_kurou: ['失去 {hpCost} 生命：得 {items} 张锦囊，射速 +{fireRateMul+%}', 'Lose {hpCost} HP: gain {items} cards and +{fireRateMul+%} fire rate'],
  huanggai_huochuan: ['放出火船：{radius} 米内 {damage} 火焰伤害，留下火海', 'Launch a fire ship: {damage} fire damage within {radius} m, leaves flames'],
  // 周瑜
  zhouyu_yingzi: ['换弹快 {reloadMul-%}；技能冷却 -{cdMul-%}', 'Reload {reloadMul-%} faster; cooldowns -{cdMul-%}'],
  zhouyu_fanjian: ['魅惑准星处敌人 {duration} 秒，让它打身边另一名武将', 'Charm the aimed enemy {duration} s: it attacks another hero near it'],
  zhouyu_chibi: ['{delay} 秒后沿前方 {length} 米投下火海：{damage} 火焰伤害', 'After {delay} s, napalm {length} m ahead: {damage} fire damage'],
  // 大乔
  daqiao_liuli: ['中弹时 {chance%} 几率把伤害转给 {radius} 米内他人', 'When shot, {chance%} chance to pass the damage to someone within {radius} m'],
  daqiao_guose: ['准星处敌人跳舞 {duration} 秒：不能射击和放技能', 'The aimed enemy dances {duration} s: no shooting, no skills'],
  daqiao_anxian: ['为你、士兵和 {radius} 米内武将回复 {heal}', 'Heal you, your soldiers and heroes within {radius} m for {heal}'],
  // 陆逊
  luxun_qianxun: ['免疫魅惑、跳舞与偷取', 'Immune to charm, dance and theft'],
  luxun_lianying: ['弹匣打空时自动装填半匣', 'An empty magazine instantly refills halfway'],
  luxun_huoshao: ['向前铺 {count} 片火海：每秒 {dps} 伤害，持续 {duration} 秒', 'Lay {count} fire fields ahead: {dps} damage/s for {duration} s'],
  luxun_liaoyuan: ['{duration} 秒不耗弹；你的火海变大并续时', '{duration} s free ammo; your fire fields grow and last longer'],
  // 孙尚香
  sunshangxiang_xiaoji: ['掉甲/掉马或残血时：加速、满弹、得 1 张锦囊', 'Losing armor/mount or dropping low: haste, full ammo and a card'],
  sunshangxiang_jieyin: ['为准星处男性武将与你各回复 {heal}', 'Heal the aimed male hero and yourself {heal} each'],
  sunshangxiang_gongyao: ['扇形射出 {arrows} 支爆炸箭，每支 {damage}+{explodeDamage} 伤害', 'Fan of {arrows} explosive arrows, {damage}+{explodeDamage} damage each'],
  // 华佗
  huatuo_jijiu: ['救人只需 {reviveTime} 秒，并额外回复 {reviveHpBonus}', 'Revive in {reviveTime} s with +{reviveHpBonus} HP'],
  huatuo_qingnang: ['准星处武将（没有则自己）{duration} 秒回复 {heal} 并净化', 'Aimed hero (or you) heals {heal} over {duration} s, debuffs removed'],
  huatuo_mafei: ['向准星处投麻醉毒气 {radius} 米：眩晕 {stun} 秒后减速', 'Throw sleeping gas ({radius} m) at the crosshair: stun {stun} s, then slow'],
  // 吕布
  lubu_wushuang: ['伤害不可闪避，无视 {shieldPierce%} 护盾；骑赤兔', 'Your damage cannot be dodged and ignores {shieldPierce%} of shields; rides Red Hare'],
  lubu_fangtian: ['旋斩周围 {radius} 米：{damage} 伤害并击退', 'Spin slash around you ({radius} m): {damage} damage + knockback'],
  lubu_sheji: ['射出长弹：首个目标 {damage} 伤害并眩晕 {stun} 秒', 'Long shot: the first target takes {damage} and is stunned {stun} s'],
  // 貂蝉
  diaochan_biyue: ['{delay} 秒没受伤后，每秒回复 {hps}', 'After {delay} s unhurt, regenerate {hps} HP/s'],
  diaochan_lijian: ['魅惑准星处敌人和它身边一名武将 {duration} 秒，二人互殴', 'Charm the aimed enemy and a hero near it for {duration} s: they fight'],
  diaochan_lianhuan: ['连环准星处敌人和身边 {extraTargets} 人：减速，火/雷伤害互传', 'Chain the aimed enemy + {extraTargets} nearby: slowed, fire/thunder spreads'],
  // 张角
  zhangjiao_guidao: ['雷电伤害 +{mul+%}', 'Thunder damage +{mul+%}'],
  zhangjiao_leiji: ['准星处连降 {bolts} 道雷，每道 {damage} 伤害', 'Call {bolts} lightning bolts at the crosshair, {damage} damage each'],
  zhangjiao_taiping: ['雷云跟随准星处敌人 {duration} 秒，反复劈下 {damage} 伤害', 'A storm follows the aimed enemy {duration} s, striking for {damage}'],
  zhangjiao_huangtian: ['召唤 {count} 名黄巾力士，持续 {lifetime} 秒', 'Summon {count} Yellow Turban warriors for {lifetime} s'],
  // 袁绍
  yuanshao_mingmen: ['带兵 +{troopBonus}；士兵生命 +{troopHpMul+%}', 'Squad +{troopBonus}; soldiers +{troopHpMul+%} HP'],
  yuanshao_luanji: ['向准星处 {radius} 米倾泻箭雨 {duration} 秒', 'Rain arrows on a {radius} m area at the crosshair for {duration} s'],
  yuanshao_sishi: ['召唤 {count} 名弩手，持续 {lifetime} 秒', 'Summon {count} crossbowmen for {lifetime} s'],
  yuanshao_xueyi: ['每名存活的其他群雄武将使你生命 +{hpPerQun}', 'Each other living Qun hero gives you +{hpPerQun} max HP'],
  // 孟获
  menghuo_huoshou: ['南蛮单位不会伤害你', 'Nanman units never harm you'],
  menghuo_zaiqi: ['每局一次：倒地时立即以 {hpFrac%} 生命站起', 'Once per match: when downed, get up at {hpFrac%} HP'],
  menghuo_nanman: ['召唤 {count} 名南蛮勇士冲向准星处', 'Summon {count} Nanman warriors charging to the crosshair'],
  menghuo_xiangbing: ['战象向前冲锋 {distance} 米：{damage} 伤害并击退', 'A war elephant charges {distance} m ahead: {damage} damage + knockback'],
};

/** The skill's one plain line in this language (the description when no line is written). */
export function skillLine(def: AbilityDef, lang: SkillLang): string {
  const tpl = SKILL_LINES[def.id];
  if (!tpl) return lang === 'en' ? def.descEn : def.descZh;
  return fillSkillTemplate(lang === 'en' ? tpl[1] : tpl[0], def);
}

// ── key-number chips ─────────────────────────────────────────────────────────

export type StatKind = 'damage' | 'dot' | 'heal' | 'shield' | 'stun' | 'silence' | 'disarm' | 'slow' | 'range' | 'move' | 'radius' | 'arc' | 'duration' | 'summon' | 'cooldown' | 'charges';

export const STAT_LABEL: Readonly<Record<StatKind, readonly [string, string]>> = {
  damage: ['伤害', 'Damage'],
  dot: ['持续伤害', 'Burn'],
  heal: ['治疗', 'Heal'],
  shield: ['护盾', 'Shield'],
  stun: ['眩晕', 'Stun'],
  silence: ['沉默', 'Silence'],
  disarm: ['缴械', 'Disarm'],
  slow: ['减速', 'Slow'],
  range: ['射程', 'Range'],
  move: ['位移', 'Move'],
  radius: ['范围', 'Area'],
  arc: ['扇形', 'Arc'],
  duration: ['持续', 'Lasts'],
  summon: ['召唤', 'Summons'],
  cooldown: ['冷却', 'Cooldown'],
  charges: ['充能', 'Charges'],
};

/** Params that are a fallback, not the skill's point (反间 disarms only when nobody is near). */
const STAT_SKIP: Readonly<Record<string, readonly string[]>> = {
  zhouyu_fanjian: ['disarm'],
};

export interface SkillStat {
  kind: StatKind;
  label: string;
  value: string;
}

const secs = (v: number, lang: SkillLang): string => (lang === 'en' ? `${fmtNum(v)} s` : `${fmtNum(v)} 秒`);
const meters = (v: number, lang: SkillLang): string => (lang === 'en' ? `${fmtNum(v)} m` : `${fmtNum(v)} 米`);

/**
 * The key numbers of a skill, in reading order (what it does → where → how long → cooldown).
 * Everything comes from params / cooldown / charges; a number the params do not carry is
 * never invented.
 */
export function skillStats(def: AbilityDef, lang: SkillLang): SkillStat[] {
  const p = def.params;
  const out: SkillStat[] = [];
  const add = (kind: StatKind, value: string): void => {
    if (!out.some((s) => s.kind === kind)) out.push({ kind, label: lang === 'en' ? STAT_LABEL[kind][1] : STAT_LABEL[kind][0], value });
  };
  const has = (k: string): boolean => p[k] !== undefined && Number.isFinite(p[k]) && p[k] > 0;
  const passive = def.slot === 'passive' || def.cooldown === undefined;
  const skip = STAT_SKIP[def.id];

  // what it does
  if (!passive) {
    if (has('shots') && has('shotDamage')) add('damage', `${fmtNum(p.shots)}×${fmtNum(p.shotDamage)}`);
    else if (has('bolts') && has('damage')) add('damage', `${fmtNum(p.bolts)}×${fmtNum(p.damage)}`);
    else if (has('arrows') && has('damage')) add('damage', `${fmtNum(p.arrows)}×${fmtNum(p.damage + (p.explodeDamage ?? 0))}`);
    else if (has('damage') && has('tickEvery') && has('duration')) add('damage', `${fmtNum(p.damage)}×${Math.floor(p.duration / p.tickEvery + 1e-6)}`);
    else if (has('damage') && has('interval') && has('duration')) add('damage', `${fmtNum(p.damage)}×${Math.floor(p.duration / p.interval + 1e-6)}`);
    else if (has('damage')) add('damage', fmtNum(p.damage));
    const dot = has('fieldDps') ? p.fieldDps : has('dps') ? p.dps : 0;
    if (dot > 0) add('dot', lang === 'en' ? `${fmtNum(dot)}/s` : `${fmtNum(dot)}/秒`);
    if (has('heal')) add('heal', fmtNum(p.heal));
    else if (has('hps')) add('heal', lang === 'en' ? `${fmtNum(p.hps)}/s` : `${fmtNum(p.hps)}/秒`);
    else if (has('healFrac')) add('heal', pct(p.healFrac));
    else if (has('missingFrac')) add('heal', pct(p.missingFrac));
    else if (has('selfHeal')) add('heal', fmtNum(p.selfHeal));
    if (has('shield')) add('shield', fmtNum(p.shield));
    const stun = has('stun') ? p.stun : has('stunHero') ? p.stunHero : 0;
    if (stun > 0) add('stun', secs(stun, lang));
    if (has('silence')) add('silence', secs(p.silence, lang));
    if (has('disarm') && !skip?.includes('disarm')) add('disarm', secs(p.disarm, lang));
    if (has('slow')) add('slow', pct(p.slow));
    if (has('count') && has('lifetime')) add('summon', `${fmtNum(p.count)}`);
  }
  // where
  const area = skillArea(def);
  if (area) {
    switch (area.kind) {
      case 'target':
      case 'circle':
      case 'blinkPoint':
        add('range', meters(area.range, lang));
        // (a marker drawn at the point is not an area: only a radius the params carry)
        if (area.kind !== 'blinkPoint' && has('radius') && (area.kind === 'circle' || area.radius)) add('radius', meters(p.radius, lang));
        break;
      case 'ring':
        add('radius', meters(area.radius, lang));
        break;
      case 'dash':
        add('move', meters(area.length, lang));
        if (area.endRadius) add('radius', meters(area.endRadius, lang));
        if (area.endArc && area.endArc < 360) add('arc', `${fmtNum(area.endArc)}°`);
        break;
      case 'cone':
        add('range', meters(area.range, lang));
        add('arc', `${fmtNum(area.arc)}°`);
        break;
      case 'line': {
        const reach = area.reach ?? area.start + area.length;
        if (reach > 0) add('range', meters(reach, lang));
        if (area.endRadius) add('radius', meters(area.endRadius, lang));
        break;
      }
    }
  }
  // how long
  if (!passive) {
    // the effect's own time: a status / field / summon (a fire ship's fuse is not "how long")
    if (has('duration')) add('duration', secs(p.duration, lang));
    else if (has('fieldTime')) add('duration', secs(p.fieldTime, lang));
    else if (has('lifetime')) add('duration', secs(p.lifetime, lang));
    if (def.cooldown) add('cooldown', secs(def.cooldown, lang));
    if (def.charges && def.charges > 1) add('charges', fmtNum(def.charges));
  } else if (has('icd')) {
    add('cooldown', secs(p.icd, lang));
  }
  return out;
}

/** "准星敌人 · 伤害 90 · 射程 30 米 · 冷却 9 秒": the chips as one line (tooltips, tips). */
export function skillStatsText(def: AbilityDef, lang: SkillLang, max = 5): string {
  return skillStats(def, lang)
    .slice(0, max)
    .map((s) => `${s.label} ${s.value}`)
    .join(' · ');
}
