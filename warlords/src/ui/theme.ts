// Visual vocabulary shared by every screen: kingdom colors, role seals,
// rarity colors, status icons, quick-chat lines. Pure data (no DOM) so unit
// tests and the sim-side bots can import it.
import type { Kingdom, RoleId, SquadOrderKind, StatusId } from '../core/types';
import type { Rarity } from '../data/types';
import { ROLE_BY_ID, STATUS_HINT_BY_ID } from '../data';

export const KINGDOM_COLOR: Record<Kingdom, string> = {
  wei: '#2e5fa8',
  shu: '#c0392b',
  wu: '#2e8b57',
  qun: '#8a8a8a',
  god: '#c9a227',
};

export const KINGDOM_GLYPH: Record<Kingdom, string> = {
  wei: '魏',
  shu: '蜀',
  wu: '吴',
  qun: '群',
  god: '神',
};

export function kingdomColor(k: Kingdom | undefined): string {
  return (k && KINGDOM_COLOR[k]) || '#8a8a8a';
}

/** Seal glyph for every role (主/忠/反/内/影/墙/赏). */
export const ROLE_GLYPH: Record<RoleId, string> = {
  lord: '主',
  loyalist: '忠',
  rebel: '反',
  traitor: '内',
  double: '影',
  opportunist: '墙',
  bounty: '赏',
};

const ROLE_FALLBACK_COLOR: Record<RoleId, string> = {
  lord: '#e8b64a',
  loyalist: '#e0c060',
  rebel: '#d94a3a',
  traitor: '#5aa0e0',
  double: '#c9a3ff',
  opportunist: '#8fd16a',
  bounty: '#ff8a3d',
};

export function roleColor(role: RoleId | undefined | null): string {
  if (!role) return '#8a8a8a';
  return ROLE_BY_ID[role]?.color ?? ROLE_FALLBACK_COLOR[role] ?? '#8a8a8a';
}

/** Mix a #rrggbb color towards black (amount 0..1). */
export function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const k = 1 - Math.max(0, Math.min(1, amount));
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Relative luminance (0..1) of a #rrggbb color. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Role color readable as text on parchment (light role colors are darkened). */
export function roleInk(role: RoleId | undefined | null): string {
  const c = roleColor(role);
  const l = luminance(c);
  return l > 0.3 ? shade(c, 0.45) : l > 0.18 ? shade(c, 0.25) : c;
}

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#b9b2a2',
  rare: '#4f9fe0',
  epic: '#b06ae0',
  legendary: '#f0a530',
};

export const ORDER_KEYS: Record<SquadOrderKind, string> = {
  follow: 'Z',
  hold: 'X',
  attack: 'C',
  charge: 'V',
};

export const ORDER_GLYPH: Record<SquadOrderKind, string> = {
  follow: '随',
  hold: '守',
  attack: '攻',
  charge: '冲',
};

export const ORDER_SEQUENCE: readonly SquadOrderKind[] = ['follow', 'hold', 'attack', 'charge'];

export interface StatusInfo {
  zh: string;
  en: string;
  glyph: string;
  color: string;
  debuff: boolean;
}

/** Status icon vocabulary for the HUD (buff = gold frame, debuff = red frame). */
export const STATUS_INFO: Record<StatusId, StatusInfo> = {
  stun: { zh: '眩晕', en: 'Stunned', glyph: '晕', color: '#e0c040', debuff: true },
  root: { zh: '定身', en: 'Rooted', glyph: '定', color: '#8a6a3a', debuff: true },
  slow: { zh: '减速', en: 'Slowed', glyph: '缓', color: '#6a8ac0', debuff: true },
  haste: { zh: '加速', en: 'Haste', glyph: '疾', color: '#5ac07a', debuff: false },
  burn: { zh: '燃烧', en: 'Burning', glyph: '火', color: '#e0602a', debuff: true },
  freeze: { zh: '冰冻', en: 'Frozen', glyph: '冰', color: '#7ad0f0', debuff: true },
  poison: { zh: '中毒', en: 'Poisoned', glyph: '毒', color: '#7ab040', debuff: true },
  stealth: { zh: '隐匿', en: 'Stealth', glyph: '隐', color: '#8a8ab0', debuff: false },
  invuln: { zh: '无敌', en: 'Invulnerable', glyph: '金', color: '#f0d060', debuff: false },
  untargetable: { zh: '不可选中', en: 'Untargetable', glyph: '空', color: '#c0c0e0', debuff: false },
  dmgBoost: { zh: '增伤', en: 'Damage up', glyph: '威', color: '#e05a3a', debuff: false },
  dmgTakenUp: { zh: '易伤', en: 'Vulnerable', glyph: '破', color: '#c03a3a', debuff: true },
  dmgTakenDown: { zh: '减伤', en: 'Damage reduction', glyph: '坚', color: '#6a9ad0', debuff: false },
  noReload: { zh: '无限弹药', en: 'No reload', glyph: '连', color: '#e0a030', debuff: false },
  fireRateUp: { zh: '急射', en: 'Rapid fire', glyph: '速', color: '#f0b040', debuff: false },
  reveal: { zh: '暴露', en: 'Revealed', glyph: '显', color: '#e07a3a', debuff: true },
  charm: { zh: '魅惑', en: 'Charmed', glyph: '惑', color: '#e070b0', debuff: true },
  silence: { zh: '沉默', en: 'Silenced', glyph: '默', color: '#9a7ac0', debuff: true },
  disarm: { zh: '缴械', en: 'Disarmed', glyph: '缴', color: '#b07a4a', debuff: true },
  dance: { zh: '乐不思蜀', en: 'Dancing', glyph: '乐', color: '#e090d0', debuff: true },
  nullify: { zh: '无懈可击', en: 'Nullify', glyph: '懈', color: '#d0c0f0', debuff: false },
  chained: { zh: '铁索连环', en: 'Chained', glyph: '锁', color: '#9aa0a8', debuff: true },
  marked: { zh: '被标记', en: 'Marked', glyph: '标', color: '#e04a3a', debuff: true },
  dodgeChance: { zh: '闪避', en: 'Evasion', glyph: '闪', color: '#70c0e0', debuff: false },
  regen: { zh: '回复', en: 'Regeneration', glyph: '愈', color: '#60d080', debuff: false },
  lifesteal: { zh: '吸血', en: 'Lifesteal', glyph: '吸', color: '#d04060', debuff: false },
  reflect: { zh: '反弹', en: 'Reflect', glyph: '反', color: '#a0a0f0', debuff: false },
  thorns: { zh: '反伤', en: 'Thorns', glyph: '刺', color: '#c08040', debuff: false },
  undodgeable: { zh: '必中', en: 'Undodgeable', glyph: '中', color: '#f07040', debuff: false },
  pierce: { zh: '破甲', en: 'Armor piercing', glyph: '穿', color: '#d0d0d0', debuff: false },
  shield: { zh: '护盾', en: 'Shield', glyph: '盾', color: '#80c0f0', debuff: false },
  drunk: { zh: '酒', en: 'Drunk', glyph: '酒', color: '#e0a060', debuff: false },
};

/** Status visuals: DATA's STATUS_HINTS first (shared with nameplates), UI table as fallback. */
export function statusInfo(id: StatusId): StatusInfo | undefined {
  const d = STATUS_HINT_BY_ID?.[id];
  if (d) return { zh: d.nameZh, en: d.nameEn, glyph: d.icon, color: d.color, debuff: d.debuff };
  return STATUS_INFO[id];
}

export interface QuickChatLine {
  id: string;
  zh: string;
  en: string;
}

/** Quick-chat ids shared with the sim/bots (GameEvent quickchat.id / InputAction quickchat.id). */
export const QUICKCHAT: readonly QuickChatLine[] = [
  { id: 'protectLord', zh: '保护主公！', en: 'Protect the Lord!' },
  { id: 'focus', zh: '集火此人！', en: 'Focus this target!' },
  { id: 'needPeach', zh: '需要桃！', en: 'I need a Peach!' },
  { id: 'followMe', zh: '跟我来！', en: 'Follow me!' },
  { id: 'retreat', zh: '撤退！', en: 'Fall back!' },
  { id: 'thanks', zh: '多谢！', en: 'Thanks!' },
  { id: 'help', zh: '救我！', en: 'Help me!' },
  { id: 'enemy', zh: '发现敌人！', en: 'Enemy spotted!' },
];

export function quickChatText(id: string, lang: 'zh' | 'en'): string {
  const q = QUICKCHAT.find((l) => l.id === id);
  if (!q) return id;
  return lang === 'en' ? q.en : q.zh;
}

/** Roles a player may publicly claim from the T wheel. */
export const CLAIMABLE_ROLES: readonly RoleId[] = ['loyalist', 'rebel', 'traitor'];

export const CLAIM_TEXT: Partial<Record<RoleId, { zh: string; en: string }>> = {
  loyalist: { zh: '我是忠臣！', en: 'I am a Loyalist!' },
  rebel: { zh: '我是反贼！', en: 'I am a Rebel!' },
  traitor: { zh: '我是内奸！', en: 'I am the Traitor!' },
  lord: { zh: '我是主公！', en: 'I am the Lord!' },
  opportunist: { zh: '我是墙头草！', en: 'I am the Opportunist!' },
  bounty: { zh: '我是赏金猎人！', en: 'I am the Bounty Hunter!' },
  double: { zh: '我才是主公！', en: 'I am the real Lord!' },
};

export const CRATE_NAME: Record<1 | 2 | 3, { zh: string; en: string }> = {
  1: { zh: '锦囊', en: 'Chest' },
  2: { zh: '铜锦囊', en: 'Bronze chest' },
  3: { zh: '天降锦囊', en: 'Airdrop' },
};
