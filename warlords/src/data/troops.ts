// SEED FILE — the DATA agent expands this (docs/GAME_SPEC.md §8). Keep export names stable.
import type { TroopTypeDef } from './types';

export const TROOPS: TroopTypeDef[] = [
  {
    id: 'shu_rifleman',
    nameZh: '白毦兵',
    nameEn: 'White-Plume Rifleman',
    kingdom: 'shu',
    hp: 90,
    speed: 5.2,
    weapon: 'troop_rifle',
    accuracy: 0.45,
    aggroRange: 35,
    attackRange: 40,
    melee: false,
    visual: { primary: '#b8322a', secondary: '#e8e0d0', headgear: 'helmet', body: 'normal' },
  },
  {
    id: 'yellowTurban',
    nameZh: '黄巾贼',
    nameEn: 'Yellow Turban Bandit',
    kingdom: 'neutral',
    hp: 70,
    speed: 5.0,
    weapon: 'troop_smg',
    accuracy: 0.35,
    aggroRange: 28,
    attackRange: 25,
    melee: false,
    visual: { primary: '#c9a227', secondary: '#6b5530', headgear: 'turban', body: 'slim' },
  },
];

export const TROOP_BY_ID: Record<string, TroopTypeDef> = Object.fromEntries(TROOPS.map((t) => [t.id, t]));
