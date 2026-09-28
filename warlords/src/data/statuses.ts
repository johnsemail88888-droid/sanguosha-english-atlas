// HUD / nameplate hints for every status effect (core/types.ts StatusId).
// `icon` is a single glyph drawn inside a small badge tinted with `color`;
// debuffs get a red frame, buffs a gold one. `effectZh` / `effectEn`: what a control
// effect does to you (the HUD banner when one lands on you: 「沉默 · 不能放技能、用锦囊」).
import type { StatusId } from '../core/types';
import type { StatusVisualHint } from './types';

export const STATUS_HINTS: StatusVisualHint[] = [
  { id: 'stun', nameZh: '眩晕', nameEn: 'Stunned', color: '#f0d040', icon: '晕', debuff: true, effectZh: '不能移动、开火、放技能', effectEn: "Can't move, shoot or cast" },
  { id: 'root', nameZh: '定身', nameEn: 'Rooted', color: '#a08040', icon: '定', debuff: true, effectZh: '不能移动', effectEn: "Can't move" },
  { id: 'slow', nameZh: '减速', nameEn: 'Slowed', color: '#6a8ad0', icon: '缓', debuff: true, effectZh: '移动变慢', effectEn: 'Moving slower' },
  { id: 'haste', nameZh: '加速', nameEn: 'Haste', color: '#5ad08a', icon: '疾', debuff: false },
  { id: 'burn', nameZh: '燃烧', nameEn: 'Burning', color: '#ff6a2a', icon: '焚', debuff: true, effectZh: '持续受火焰伤害', effectEn: 'Taking fire damage over time' },
  { id: 'freeze', nameZh: '冰冻', nameEn: 'Frozen', color: '#9ad8ff', icon: '冰', debuff: true, effectZh: '移动极慢，不能冲刺、跳跃、闪避', effectEn: 'Barely moving: no sprint, jump or dodge' },
  { id: 'poison', nameZh: '中毒', nameEn: 'Poisoned', color: '#7ac040', icon: '毒', debuff: true, effectZh: '持续掉血', effectEn: 'Losing HP over time' },
  { id: 'stealth', nameZh: '潜行', nameEn: 'Stealth', color: '#8a9aaa', icon: '隐', debuff: false },
  { id: 'invuln', nameZh: '无敌', nameEn: 'Invulnerable', color: '#ffe080', icon: '金', debuff: false },
  { id: 'untargetable', nameZh: '不可选中', nameEn: 'Untargetable', color: '#d0d0f0', icon: '空', debuff: false },
  { id: 'dmgBoost', nameZh: '增伤', nameEn: 'Damage Up', color: '#ff8a3d', icon: '怒', debuff: false },
  { id: 'dmgTakenUp', nameZh: '易伤', nameEn: 'Vulnerable', color: '#d94a3a', icon: '破', debuff: true, effectZh: '受到的伤害增加', effectEn: 'Taking more damage' },
  { id: 'dmgTakenDown', nameZh: '减伤', nameEn: 'Damage Reduction', color: '#4a90d9', icon: '守', debuff: false },
  { id: 'noReload', nameZh: '无限弹药', nameEn: 'Infinite Ammo', color: '#e8b64a', icon: '连', debuff: false },
  { id: 'fireRateUp', nameZh: '急速射击', nameEn: 'Rapid Fire', color: '#ffb040', icon: '射', debuff: false },
  { id: 'reveal', nameZh: '暴露', nameEn: 'Spotted', color: '#ff5a5a', icon: '露', debuff: true, effectZh: '你的位置被看穿', effectEn: 'Your position is seen' },
  { id: 'charm', nameZh: '魅惑', nameEn: 'Charmed', color: '#ff70c0', icon: '惑', debuff: true, effectZh: '枪口被控制，自动攻击别人', effectEn: 'Your gun is turned on someone else' },
  { id: 'silence', nameZh: '沉默', nameEn: 'Silenced', color: '#9a7ad0', icon: '默', debuff: true, effectZh: '不能放技能、用锦囊', effectEn: 'No skills, no cards' },
  { id: 'disarm', nameZh: '缴械', nameEn: 'Disarmed', color: '#b07050', icon: '缴', debuff: true, effectZh: '不能开火', effectEn: "Can't shoot" },
  { id: 'dance', nameZh: '乐不思蜀', nameEn: 'Dancing', color: '#e070b0', icon: '乐', debuff: true, effectZh: '不能开火、放技能，移动减半', effectEn: 'No shooting or skills, half speed' },
  { id: 'nullify', nameZh: '无懈可击', nameEn: 'Impeccable', color: '#f0e0a0', icon: '懈', debuff: false },
  { id: 'chained', nameZh: '连环', nameEn: 'Chained', color: '#8a8a9a', icon: '锁', debuff: true, effectZh: '火/雷伤害会传给连环的人', effectEn: 'Fire / thunder damage spreads along the chain' },
  { id: 'marked', nameZh: '被标记', nameEn: 'Marked', color: '#ff3030', icon: '标', debuff: true, effectZh: '被敌方部曲集火', effectEn: "A squad's focus-fire target" },
  { id: 'dodgeChance', nameZh: '闪避', nameEn: 'Evasion', color: '#6ad0e0', icon: '闪', debuff: false },
  { id: 'regen', nameZh: '回复', nameEn: 'Regeneration', color: '#5ad05a', icon: '愈', debuff: false },
  { id: 'lifesteal', nameZh: '吸血', nameEn: 'Lifesteal', color: '#c0304a', icon: '吸', debuff: false },
  { id: 'reflect', nameZh: '反弹', nameEn: 'Reflect', color: '#a070ff', icon: '反', debuff: false },
  { id: 'thorns', nameZh: '刚烈', nameEn: 'Thorns', color: '#b04030', icon: '刚', debuff: false },
  { id: 'undodgeable', nameZh: '必中', nameEn: 'Undodgeable', color: '#ffd060', icon: '必', debuff: false },
  { id: 'pierce', nameZh: '破甲', nameEn: 'Armor Piercing', color: '#a8d8e8', icon: '穿', debuff: false },
  { id: 'shield', nameZh: '护盾', nameEn: 'Shield', color: '#8ab8ff', icon: '盾', debuff: false },
  { id: 'drunk', nameZh: '酒', nameEn: 'Drunk', color: '#b5651d', icon: '酒', debuff: false },
];

export const STATUS_HINT_BY_ID: Record<StatusId, StatusVisualHint> = Object.fromEntries(
  STATUS_HINTS.map((s) => [s.id, s]),
) as Record<StatusId, StatusVisualHint>;
