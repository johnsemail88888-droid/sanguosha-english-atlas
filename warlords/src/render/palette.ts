// Shared color palette for the "ink & gold" art direction (GAME_SPEC §12).
// All values are sRGB hex strings; three.js converts them to linear on use.
import type { Kingdom, RoleId } from '../core/types';
import type { Rarity } from '../data/types';

export const KINGDOM_COLORS: Record<Kingdom, string> = {
  wei: '#2e5fa8',
  shu: '#c0392b',
  wu: '#2e8b57',
  qun: '#8a8a8a',
  god: '#d4a017',
};

/** Single-character kingdom glyphs used on banners, tents and portraits. */
export const KINGDOM_GLYPHS: Record<Kingdom, string> = {
  wei: '魏',
  shu: '蜀',
  wu: '吴',
  qun: '群',
  god: '神',
};

export const NEUTRAL_COLOR = '#b08a3a';

export const kingdomColor = (k: Kingdom | 'neutral' | undefined | null): string =>
  k && k !== 'neutral' ? KINGDOM_COLORS[k] ?? NEUTRAL_COLOR : NEUTRAL_COLOR;

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#d8d4c8',
  rare: '#3f8fe8',
  epic: '#a650e8',
  legendary: '#f0b429',
};

export const ROLE_BADGE: Record<RoleId, { glyph: string; color: string }> = {
  lord: { glyph: '主', color: '#e8b64a' },
  loyalist: { glyph: '忠', color: '#d9a42c' },
  rebel: { glyph: '反', color: '#d94a3a' },
  traitor: { glyph: '内', color: '#4a8fd9' },
  double: { glyph: '影', color: '#c9a04a' },
  opportunist: { glyph: '墙', color: '#6fae5a' },
  bounty: { glyph: '赏', color: '#b0643a' },
};

/** Architecture / environment palette. */
export const ARCH = {
  pillarRed: '#9b2b22',
  pillarRedDark: '#6e1d17',
  wallWhite: '#e6ddcb',
  wallPlaster: '#d8cdb6',
  roofTile: '#4b5059',
  roofTileDark: '#363a41',
  roofGlazed: '#c8962e',
  roofGreen: '#3f6b55',
  gold: '#d8ac4c',
  goldDark: '#a37a2c',
  wood: '#6b4a2e',
  woodDark: '#43301f',
  woodLight: '#9a7650',
  stone: '#8f8a80',
  stoneDark: '#6c6860',
  stoneLight: '#b3ada0',
  brick: '#77736b',
  earth: '#9a7f5a',
  lattice: '#3a2a1c',
  paper: '#efe3c4',
  bronze: '#7c6a3a',
  bronzeGreen: '#4f7a62',
  cloth: '#c9bda0',
  rope: '#b39a6a',
  ink: '#1c1a18',
} as const;

export const NATURE = {
  grass: '#6f8a3a',
  grassLush: '#5d7d33',
  grassDry: '#a19a55',
  dirt: '#8a6d49',
  rock: '#7a756c',
  rockDark: '#5e5a53',
  sand: '#cbb98a',
  riverbed: '#5f5a47',
  trunk: '#5a3f2a',
  leaf: '#4f7a2e',
  leafAutumn: '#b8742a',
  leafBlossom: '#e3a0a8',
  pine: '#2f5a3a',
  bamboo: '#7fa04a',
  bambooLeaf: '#5f8a34',
  water: '#2f6f7a',
  waterDeep: '#1b3f4f',
} as const;

/** Sky / atmosphere (late-afternoon ink wash). */
export const SKY = {
  zenith: '#5d7a92',
  horizon: '#e9d9b8',
  haze: '#d8c9a8',
  sun: '#fff1c8',
  fog: '#d6c7a6',
  mountainNear: '#6a7478',
  mountainMid: '#8a9290',
  mountainFar: '#aeb2a8',
} as const;
