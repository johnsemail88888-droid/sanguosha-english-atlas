// Bilingual display labels + colors for content enums (kingdoms, rarities,
// weapon classes, damage types, ability slots). UI / HUD / docs read these so
// every screen names things the same way.
import type { AbilitySlot, DamageType, Kingdom } from '../core/types';
import type { ItemKind, Rarity, WeaponClass } from './types';

export interface KingdomInfo {
  id: Kingdom;
  nameZh: string; // 蜀
  nameEn: string; // Shu
  /** full name, e.g. 蜀汉 / Shu Han */
  fullZh: string;
  fullEn: string;
  /** banner / frame color */
  color: string;
  /** darker shade for text on light backgrounds */
  dark: string;
  /** single glyph for banners and badges */
  glyph: string;
}

export const KINGDOM_INFO: Record<Kingdom, KingdomInfo> = {
  wei: { id: 'wei', nameZh: '魏', nameEn: 'Wei', fullZh: '曹魏', fullEn: 'Cao Wei', color: '#2e5fa8', dark: '#1d3d6e', glyph: '魏' },
  shu: { id: 'shu', nameZh: '蜀', nameEn: 'Shu', fullZh: '蜀汉', fullEn: 'Shu Han', color: '#c0392b', dark: '#7e241b', glyph: '蜀' },
  wu: { id: 'wu', nameZh: '吴', nameEn: 'Wu', fullZh: '东吴', fullEn: 'Eastern Wu', color: '#2e8b57', dark: '#1c5a38', glyph: '吴' },
  qun: { id: 'qun', nameZh: '群', nameEn: 'Qun', fullZh: '群雄', fullEn: 'Warlords', color: '#8a8a8a', dark: '#555555', glyph: '群' },
  god: { id: 'god', nameZh: '神', nameEn: 'God', fullZh: '神将', fullEn: 'Deities', color: '#c9a227', dark: '#7a6014', glyph: '神' },
};

/** Display order for galleries and hero select. */
export const KINGDOM_ORDER: readonly Kingdom[] = ['shu', 'wei', 'wu', 'qun', 'god'];

export interface LabelInfo {
  nameZh: string;
  nameEn: string;
  color: string;
}

export const RARITY_INFO: Record<Rarity, LabelInfo> = {
  common: { nameZh: '普通', nameEn: 'Common', color: '#b8b8b0' },
  rare: { nameZh: '稀有', nameEn: 'Rare', color: '#4a90d9' },
  epic: { nameZh: '史诗', nameEn: 'Epic', color: '#a060e0' },
  legendary: { nameZh: '传说', nameEn: 'Legendary', color: '#e8b64a' },
};

export const WEAPON_CLASS_INFO: Record<WeaponClass, LabelInfo> = {
  pistol: { nameZh: '手枪', nameEn: 'Pistol', color: '#9a9a9a' },
  smg: { nameZh: '冲锋枪', nameEn: 'SMG', color: '#9a9a9a' },
  rifle: { nameZh: '步枪', nameEn: 'Rifle', color: '#9a9a9a' },
  shotgun: { nameZh: '霰弹枪', nameEn: 'Shotgun', color: '#9a9a9a' },
  dmr: { nameZh: '射手步枪', nameEn: 'Marksman Rifle', color: '#9a9a9a' },
  sniper: { nameZh: '狙击枪', nameEn: 'Sniper Rifle', color: '#9a9a9a' },
  lmg: { nameZh: '轻机枪', nameEn: 'LMG', color: '#9a9a9a' },
  launcher: { nameZh: '发射器', nameEn: 'Launcher', color: '#9a9a9a' },
  flamer: { nameZh: '喷火器', nameEn: 'Flamethrower', color: '#9a9a9a' },
  bow: { nameZh: '弓', nameEn: 'Bow', color: '#9a9a9a' },
  crossbow: { nameZh: '弩', nameEn: 'Crossbow', color: '#9a9a9a' },
  melee: { nameZh: '近战', nameEn: 'Melee', color: '#9a9a9a' },
};

export const DAMAGE_TYPE_INFO: Record<DamageType, LabelInfo> = {
  normal: { nameZh: '普通', nameEn: 'Normal', color: '#f0f0f0' },
  melee: { nameZh: '近战', nameEn: 'Melee', color: '#e0c0a0' },
  fire: { nameZh: '火焰', nameEn: 'Fire', color: '#ff6a2a' },
  thunder: { nameZh: '雷电', nameEn: 'Thunder', color: '#8ad0ff' },
  explosive: { nameZh: '爆炸', nameEn: 'Explosive', color: '#ffb040' },
  pierce: { nameZh: '穿透', nameEn: 'Piercing', color: '#a8d8e8' },
  zone: { nameZh: '烽火', nameEn: 'Zone', color: '#d94a3a' },
  true: { nameZh: '真实', nameEn: 'True', color: '#ffffff' },
};

export const ITEM_KIND_INFO: Record<ItemKind, LabelInfo> = {
  basic: { nameZh: '基本牌', nameEn: 'Basic', color: '#e8e0d0' },
  ammo: { nameZh: '基本牌', nameEn: 'Basic', color: '#e8e0d0' },
  trick: { nameZh: '锦囊', nameEn: 'Trick', color: '#e8b64a' },
  delayTrick: { nameZh: '延时锦囊', nameEn: 'Delayed Trick', color: '#c07ad0' },
  utility: { nameZh: '军令', nameEn: 'Utility', color: '#c9a227' },
};

export interface SlotInfo {
  nameZh: string;
  nameEn: string;
  /** default key binding shown on HUD */
  key: string;
}

export const ABILITY_SLOT_INFO: Record<AbilitySlot | 'passive', SlotInfo> = {
  passive: { nameZh: '被动', nameEn: 'Passive', key: '' },
  q: { nameZh: '技能一', nameEn: 'Ability 1', key: 'Q' },
  e: { nameZh: '技能二', nameEn: 'Ability 2', key: 'E' },
  lord: { nameZh: '主公技', nameEn: 'Lord Skill', key: 'G' },
};
