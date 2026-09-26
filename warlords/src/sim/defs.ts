// Safe content lookups for the simulation.
//
// The DATA engineer fills src/data/* concurrently, and saved matches / network
// peers may reference ids this build does not know. The sim must never crash
// on an unknown id: every lookup here warns once and returns a sensible,
// cached fallback definition.
import type { Kingdom } from '../core/types';
import {
  ARMOR_BY_ID,
  HERO_BY_ID,
  ITEM_BY_ID,
  MOUNT_BY_ID,
  TROOP_BY_ID,
  TROOPS,
  WEAPON_BY_ID,
} from '../data';
import type { ArmorDef, HeroDef, ItemDef, MountDef, TroopTypeDef, WeaponDef } from '../data/types';

const warned = new Set<string>();
let warnSink: (msg: string) => void = (msg) => {
  // eslint-disable-next-line no-console
  console.warn(msg);
};

/** Redirect sim warnings (tests silence them, the host may forward them to a log). */
export function setWarnSink(fn: (msg: string) => void): void {
  warnSink = fn;
}

/** Log `msg` once per `key` for the lifetime of the process. */
export function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warnSink(`[sim] ${msg}`);
}

// ── Weapons ─────────────────────────────────────────────────────────────────
const weaponFallbacks = new Map<string, WeaponDef>();

function genericWeapon(id: string): WeaponDef {
  const troop = id.startsWith('troop_') || id.startsWith('turret_');
  const melee = id.includes('melee');
  return {
    id,
    nameZh: id,
    nameEn: id,
    sgsCard: '',
    descZh: '',
    descEn: '',
    class: melee ? 'melee' : troop ? 'rifle' : 'rifle',
    rarity: 'common',
    damage: melee ? 30 : troop ? 14 : 24,
    headshotMul: 1.5,
    fireRate: melee ? 1.2 : troop ? 3 : 7,
    auto: true,
    magSize: melee ? 0 : 30,
    reserveMags: 4,
    reloadTime: 2,
    falloffStart: 30,
    maxRange: melee ? 2.5 : 100,
    spreadHip: 3,
    spreadAds: 1,
    pellets: 1,
    recoil: 1,
    adsZoom: 1.4,
    moveSpeedMul: 1,
    dtype: melee ? 'melee' : 'normal',
    melee: melee ? { range: 2.2, arcDeg: 90 } : undefined,
    special: 'none',
    specialParams: {},
    lootable: false,
    model: { length: 0.8, bodyColor: '#333333', accentColor: '#888888', style: melee ? 'sword' : 'rifle', ornament: 'none' },
  };
}

export function weaponDef(id: string): WeaponDef {
  const def = WEAPON_BY_ID[id];
  if (def) return def;
  let fb = weaponFallbacks.get(id);
  if (!fb) {
    warnOnce(`weapon:${id}`, `unknown weapon '${id}', using a generic rifle`);
    fb = genericWeapon(id);
    weaponFallbacks.set(id, fb);
  }
  return fb;
}

export const isKnownWeapon = (id: string): boolean => !!WEAPON_BY_ID[id];

/** Max reserve ammo for a weapon (spawn reserve). */
export const maxReserve = (def: WeaponDef): number => Math.max(0, def.magSize * def.reserveMags);

/** Melee weapons (and anything without a magazine) never need ammo. */
export const usesAmmo = (def: WeaponDef): boolean => !def.melee && def.magSize > 0;

// ── Heroes ──────────────────────────────────────────────────────────────────
const heroFallbacks = new Map<string, HeroDef>();

const KINGDOM_TROOP: Record<Kingdom, string> = {
  shu: 'shu_rifleman',
  wei: 'wei_tiger',
  wu: 'wu_crossbow',
  qun: 'qun_raider',
  god: 'shu_rifleman',
};

export function heroDef(id: string): HeroDef {
  const def = HERO_BY_ID[id];
  if (def) return def;
  let fb = heroFallbacks.get(id);
  if (!fb) {
    warnOnce(`hero:${id}`, `unknown hero '${id}', using a generic 4-hp warrior without abilities`);
    fb = {
      id,
      nameZh: id,
      nameEn: id,
      titleZh: '',
      titleEn: '',
      kingdom: 'qun',
      gender: 'male',
      sgsHp: 4,
      maxHp: 400,
      speedMul: 1,
      lordCandidate: false,
      signatureWeapon: 'carbine',
      troopType: KINGDOM_TROOP.qun,
      troopBonus: 0,
      abilities: [],
      visual: {
        skin: '#d9a877',
        hair: '#222222',
        primary: '#777777',
        secondary: '#555555',
        accent: '#c9a227',
        headgear: 'helmet',
        beard: 'short',
        body: 'normal',
        extras: [],
        artPromptEn: '',
      },
      bioZh: '',
      bioEn: '',
      playstyleZh: '',
      playstyleEn: '',
      difficulty: 1,
      quotesZh: [],
      series: 'standard',
    };
    heroFallbacks.set(id, fb);
  }
  return fb;
}

// ── Troops / NPC types ─────────────────────────────────────────────────────
const troopFallbacks = new Map<string, TroopTypeDef>();

export function troopDef(id: string, kingdomHint?: Kingdom | 'neutral'): TroopTypeDef {
  const def = TROOP_BY_ID[id];
  if (def) return def;
  let fb = troopFallbacks.get(id);
  if (!fb) {
    warnOnce(`troop:${id}`, `unknown troop type '${id}', using a generic rifleman`);
    const base: TroopTypeDef | undefined = TROOP_BY_ID.shu_rifleman ?? TROOPS[0];
    const melee = /melee|brute|lishi|barbarian|nanman|elephant|guard/i.test(id);
    fb = {
      id,
      nameZh: base?.nameZh ?? id,
      nameEn: base?.nameEn ?? id,
      kingdom: kingdomHint ?? base?.kingdom ?? 'neutral',
      hp: base?.hp ?? 90,
      speed: base?.speed ?? 5,
      weapon: melee ? 'troop_melee' : (base?.weapon ?? 'troop_rifle'),
      accuracy: base?.accuracy ?? 0.4,
      aggroRange: base?.aggroRange ?? 30,
      attackRange: melee ? 2.2 : (base?.attackRange ?? 35),
      melee,
      visual: base?.visual ?? { primary: '#777777', secondary: '#555555', headgear: 'helmet', body: 'normal' },
    };
    troopFallbacks.set(id, fb);
  }
  return fb;
}

// ── Items / equipment ───────────────────────────────────────────────────────
export function itemDef(id: string): ItemDef | undefined {
  const def = ITEM_BY_ID[id];
  if (!def && !ARMOR_BY_ID[id] && !MOUNT_BY_ID[id] && !WEAPON_BY_ID[id]) warnOnce(`item:${id}`, `unknown item '${id}'`);
  return def;
}

export function armorDef(id: string | null | undefined): ArmorDef | undefined {
  if (!id) return undefined;
  const def = ARMOR_BY_ID[id];
  if (!def) warnOnce(`armor:${id}`, `unknown armor '${id}', treated as plain armor`);
  return def;
}

export function mountDef(id: string | null | undefined): MountDef | undefined {
  if (!id) return undefined;
  const def = MOUNT_BY_ID[id];
  if (!def) warnOnce(`mount:${id}`, `unknown mount '${id}', treated as a plain horse`);
  return def;
}

export type LootKind = 'item' | 'weapon' | 'armor' | 'mount' | 'unknown';

/** Classify a loot/equipment id. */
export function lootKindOf(id: string): LootKind {
  if (ITEM_BY_ID[id]) return 'item';
  if (WEAPON_BY_ID[id]) return 'weapon';
  if (ARMOR_BY_ID[id]) return 'armor';
  if (MOUNT_BY_ID[id]) return 'mount';
  return 'unknown';
}

export const maxStackOf = (id: string): number => Math.max(1, ITEM_BY_ID[id]?.maxStack ?? 1);
