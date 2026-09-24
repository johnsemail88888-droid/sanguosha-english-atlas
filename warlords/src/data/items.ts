// SEED FILE — the DATA agent expands this (docs/GAME_SPEC.md §7). Keep export names stable.
import type { ArmorDef, ItemDef, MountDef } from './types';

export const ITEMS: ItemDef[] = [
  {
    id: 'tao',
    nameZh: '桃',
    nameEn: 'Peach (Medkit)',
    sgsCard: '桃',
    kind: 'basic',
    descZh: '回复 120 点体力；也可对濒死的角色使用将其救起。',
    descEn: 'Restore 120 HP; can also be used on a downed character to revive them.',
    rarity: 'common',
    useTime: 1.2,
    targeting: 'self',
    range: 3,
    maxStack: 3,
    params: { heal: 120, reviveHp: 100 },
    icon: '桃',
    color: '#ff7a8a',
    aiHint: 'heal',
  },
];

export const ARMORS: ArmorDef[] = [
  {
    id: 'bagua',
    nameZh: '八卦阵',
    nameEn: 'Bagua Deflector',
    sgsCard: '八卦阵',
    descZh: '能量偏导力场：受到子弹时 35% 几率完全闪避。',
    descEn: 'Deflector field: 35% chance to completely evade each incoming bullet.',
    rarity: 'rare',
    bulletReduction: 0,
    special: 'bagua',
    params: { chance: 0.35 },
    color: '#e8d27a',
  },
];

export const MOUNTS: MountDef[] = [
  {
    id: 'chitu',
    nameZh: '赤兔',
    nameEn: 'Red Hare',
    sgsCard: '赤兔',
    descZh: '-1 马（进攻马）：移动速度 +40%。',
    descEn: 'Offensive mount: +40% move speed.',
    rarity: 'epic',
    type: 'offense',
    speedMul: 1.4,
    damageTakenMul: 1.0,
    color: '#b3261e',
  },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const ARMOR_BY_ID: Record<string, ArmorDef> = Object.fromEntries(ARMORS.map((a) => [a.id, a]));
export const MOUNT_BY_ID: Record<string, MountDef> = Object.fromEntries(MOUNTS.map((m) => [m.id, m]));
