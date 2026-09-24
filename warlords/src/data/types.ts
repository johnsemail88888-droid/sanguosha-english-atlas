// Static game-content definitions (heroes, weapons, items, armor, mounts,
// troops, roles). Pure data: no imports from sim/render. Implementations of
// ability/item behaviour live in sim/abilities and sim/items and are looked up
// by id.
import type { AbilitySlot, DamageType, Faction, Gender, Kingdom, RoleId, StatusId } from '../core/types';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

// ── Heroes ──────────────────────────────────────────────────────────────────
export type Headgear =
  | 'none'
  | 'crown' // 冕旒/帝冠 (lords)
  | 'helmet' // generic general helmet
  | 'plumeHelmet' // 雉鸡翎 long pheasant feathers (吕布)
  | 'scholarHat' // 纶巾 (诸葛亮 / 郭嘉 / 司马懿)
  | 'headband' // 抹额
  | 'hood'
  | 'hairBun' // female bun + pins
  | 'longHair' // female long hair
  | 'turban' // 黄巾
  | 'featherCrown' // 南蛮 feathers
  | 'bandana'
  | 'tacticalHelmet' // modern helmet + goggles
  | 'beret';

export type BodyType = 'slim' | 'normal' | 'heavy' | 'huge';

export type HeroExtra =
  | 'fan' // 羽扇
  | 'eyepatch' // 夏侯惇
  | 'shoulderPads'
  | 'backFlags' // 靠旗
  | 'cape'
  | 'scarf'
  | 'goggles'
  | 'mask'
  | 'bareChest' // 许褚 裸衣
  | 'bells' // 甘宁 铃铛
  | 'whiteRobe' // 吕蒙 白衣
  | 'medicBag' // 华佗
  | 'ribbons' // 貂蝉/大乔 silk ribbons
  | 'backpack'
  | 'quiver'
  | 'staff'; // 张角

export interface HeroVisual {
  skin: string; // hex
  face?: string; // hex override (关羽 red face)
  hair: string;
  primary: string; // robe / main cloth
  secondary: string; // armor
  accent: string; // trims, gold etc.
  headgear: Headgear;
  beard: 'none' | 'short' | 'long' | 'wild';
  body: BodyType;
  extras: HeroExtra[];
  /** hero is always drawn riding this mount (马超 西凉战马, 吕布 赤兔). Absent = on foot. */
  mount?: 'horse' | 'redHare';
  /** for AI image / 3D model generation later */
  artPromptEn: string;
}

export interface AbilityDef {
  id: string; // globally unique, e.g. 'guanyu_wusheng'
  slot: AbilitySlot | 'passive';
  nameZh: string;
  nameEn: string;
  /** the original 三国杀 skill this adapts, e.g. '武圣' */
  sgsSkill: string;
  descZh: string;
  descEn: string;
  cooldown?: number; // seconds (active abilities)
  charges?: number;
  /** tunables consumed by the implementation (damage, radius, duration...) */
  params: Record<string, number>;
  /**
   * Damage type of every hit this ability deals (direct hits, blasts, fields,
   * ticks, reflected damage). Present iff the ability deals damage itself.
   * Ability damage is not a weapon hit (no weaponId) unless params.weaponHit = 1.
   */
  dtype?: DamageType;
  /** how the ability is aimed (for UI hints + bot AI) */
  targeting?: 'self' | 'direction' | 'point' | 'enemy' | 'ally' | 'any' | 'none';
  /** bot AI hint: when to use */
  aiHint?: 'offense' | 'defense' | 'heal' | 'mobility' | 'summon' | 'utility';
}

export interface HeroDef {
  id: string; // 'liubei'
  nameZh: string;
  nameEn: string;
  titleZh: string; // 称号 e.g. '乱世的枭雄'
  titleEn: string;
  kingdom: Kingdom;
  gender: Gender;
  sgsHp: 3 | 4;
  maxHp: number; // sgsHp * 100
  speedMul: number; // 0.9 .. 1.15
  lordCandidate: boolean;
  signatureWeapon: string; // WeaponDef id (starting primary)
  troopType: string; // TroopTypeDef id
  troopBonus: number; // extra soldiers over the base squad (刘备 +2)
  abilities: AbilityDef[]; // 1 passive + q + e (+ lord skill for lord candidates)
  visual: HeroVisual;
  bioZh: string;
  bioEn: string;
  playstyleZh: string;
  playstyleEn: string;
  difficulty: 1 | 2 | 3;
  quotesZh: string[]; // battle cries (text for bubbles / TTS)
  /** English translations of quotesZh (same order), for subtitles / the en UI. */
  quotesEn?: string[];
  series: 'standard' | 'wind' | 'fire' | 'forest' | 'mountain' | 'god' | 'extra';
}

// ── Weapons (三国杀 武器牌 → modern guns) ─────────────────────────────────────
export type WeaponClass =
  | 'pistol'
  | 'smg'
  | 'rifle'
  | 'shotgun'
  | 'dmr'
  | 'sniper'
  | 'lmg'
  | 'launcher'
  | 'flamer'
  | 'bow'
  | 'crossbow'
  | 'melee';

/** Weapon special effects, implemented in sim/combat.ts weaponSpecial hooks. */
export type WeaponSpecial =
  | 'none'
  | 'freeze' // 寒冰剑: hits apply freeze/slow
  | 'pierceArmor' // 青釭剑: ignores armor
  | 'followUp' // 青龙偃月刀: dodged/blocked shots refund + next shot bonus
  | 'genderBonus' // 雌雄双股剑: bonus vs opposite gender
  | 'noArmorBonus' // 古锭刀: bonus vs targets without armor
  | 'forceHit' // 贯石斧: explosive splash hits through dodge
  | 'fireConvert' // 朱雀羽扇: bullets become fire (burn)
  | 'multiTarget' // 方天画戟: 3 rockets / split
  | 'dismount' // 麒麟弓: knocks target off mount, huge range
  | 'rapid' // 诸葛连弩: no fire-rate cap ramp-up
  | 'chainLightning' // 张角 tesla
  | 'lifesteal';

export interface WeaponModelSpec {
  /** procedural gun builder hints */
  length: number; // meters
  bodyColor: string;
  accentColor: string;
  style:
    | 'pistol'
    | 'smg'
    | 'rifle'
    | 'shotgun'
    | 'sniper'
    | 'lmg'
    | 'launcher'
    | 'flamer'
    | 'bow'
    | 'crossbow'
    | 'glaive'
    | 'halberd'
    | 'sword'
    | 'spear';
  /** decorative ancient element fused onto the gun */
  ornament?: 'dragonHead' | 'blade' | 'bayonet' | 'tassel' | 'phoenixFeathers' | 'axeHead' | 'serpentBlade' | 'crescent' | 'none';
}

export interface WeaponDef {
  id: string;
  nameZh: string;
  nameEn: string;
  sgsCard: string; // '诸葛连弩' or '' for generic
  descZh: string;
  descEn: string;
  class: WeaponClass;
  rarity: Rarity;
  damage: number; // per bullet/pellet
  headshotMul: number;
  fireRate: number; // shots per second
  auto: boolean; // hold to fire
  magSize: number;
  reserveMags: number; // spawn reserve = magSize * reserveMags
  reloadTime: number;
  falloffStart: number; // m, full damage until
  maxRange: number; // m, damage 50% at max, none beyond
  spreadHip: number; // degrees
  spreadAds: number;
  pellets: number; // >1 for shotguns
  recoil: number; // degrees pitch kick
  adsZoom: number; // FOV divisor (1.3 = mild, 4 = scope)
  moveSpeedMul: number;
  dtype: DamageType;
  /** projectile weapons (launchers/bows/flamers); hitscan if absent */
  projectile?: {
    kind: string;
    speed: number;
    gravity: number;
    explodeRadius: number;
    explodeDamage: number;
    lifetime: number;
  };
  /** melee weapons */
  melee?: { range: number; arcDeg: number };
  special: WeaponSpecial;
  specialParams: Record<string, number>;
  /** can appear as loot */
  lootable: boolean;
  model: WeaponModelSpec;
}

// ── Items (三国杀 基本牌/锦囊牌 → consumables) ────────────────────────────────
export type ItemKind = 'basic' | 'trick' | 'delayTrick' | 'ammo' | 'utility';

export interface ItemDef {
  id: string;
  nameZh: string;
  nameEn: string;
  sgsCard: string;
  kind: ItemKind;
  descZh: string;
  descEn: string;
  rarity: Rarity;
  /** seconds to use (channel); 0 = instant */
  useTime: number;
  targeting: 'self' | 'ally' | 'enemy' | 'point' | 'direction' | 'none';
  range: number;
  maxStack: number;
  params: Record<string, number>;
  /** damage type of every hit the item deals (present iff it deals damage; never a weapon hit) */
  dtype?: DamageType;
  icon: string; // short glyph shown in UI (single Chinese char e.g. '桃')
  color: string;
  /** bot AI hint */
  aiHint: 'heal' | 'offense' | 'defense' | 'utility' | 'summon';
}

export interface ArmorDef {
  id: string;
  nameZh: string;
  nameEn: string;
  sgsCard: string;
  descZh: string;
  descEn: string;
  rarity: Rarity;
  /** flat damage reduction fraction vs bullets (0.2 = -20%) */
  bulletReduction: number;
  special: 'bagua' | 'renwang' | 'tengjia' | 'baiyin' | 'none';
  params: Record<string, number>;
  color: string;
}

export interface MountDef {
  id: string;
  nameZh: string;
  nameEn: string;
  sgsCard: string;
  descZh: string;
  descEn: string;
  rarity: Rarity;
  /** +1 horse = defensive, -1 horse = offensive */
  type: 'offense' | 'defense';
  speedMul: number;
  damageTakenMul: number;
  color: string;
}

// ── Troops / NPCs ────────────────────────────────────────────────────────────
export interface TroopTypeDef {
  id: string;
  nameZh: string;
  nameEn: string;
  kingdom: Kingdom | 'neutral';
  hp: number;
  speed: number;
  weapon: string; // WeaponDef id (troops use simplified firing with accuracy)
  accuracy: number; // 0..1 hit chance multiplier at mid range
  aggroRange: number;
  attackRange: number;
  melee: boolean;
  visual: {
    primary: string;
    secondary: string;
    headgear: Headgear;
    shield?: boolean;
    body: BodyType;
    mountedOn?: 'horse' | 'elephant';
  };
}

// ── Roles ────────────────────────────────────────────────────────────────────
export interface RoleDef {
  id: RoleId;
  nameZh: string;
  nameEn: string;
  faction: Faction;
  color: string;
  /** visible to everyone from the start */
  publicAtStart: boolean;
  goalZh: string;
  goalEn: string;
  tipsZh: string;
  tipsEn: string;
  chaosOnly: boolean;
}

/** per player count: one or more variants (a random variant is dealt). Index 0 = lord seat. */
export type RoleDistribution = Record<5 | 6 | 7 | 8, RoleId[][]>;

export interface StatusVisualHint {
  id: StatusId;
  nameZh: string;
  nameEn: string;
  color: string;
  icon: string;
  debuff: boolean;
}
