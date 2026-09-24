// Maps content ids (weapons, items, abilities, entities) to sound families.
// Looks ids up in the data tables first and falls back to name heuristics so
// new content added by DATA still gets a sensible sound.
import type { EntityKind, Kingdom } from '../core/types';
import { ABILITY_BY_ID, ABILITY_HERO, ARMOR_BY_ID, HERO_BY_ID, ITEM_BY_ID, MOUNT_BY_ID, TROOP_BY_ID, WEAPON_BY_ID } from '../data';
import type { WeaponClass } from '../data/types';

export type GunSound = WeaponClass | 'tesla';

export const GUN_SOUNDS: readonly GunSound[] = [
  'pistol',
  'smg',
  'rifle',
  'shotgun',
  'dmr',
  'sniper',
  'lmg',
  'launcher',
  'flamer',
  'bow',
  'crossbow',
  'melee',
  'tesla',
];

const GUN_NAME_RULES: readonly [RegExp, GunSound][] = [
  [/tesla|taiping|lightning|thunder|zap/, 'tesla'],
  [/flame|zhuque|napalm|incendiar/, 'flamer'],
  [/rocket|launcher|fangtian|guanshi|grenade|rpg|mortar|bazooka/, 'launcher'],
  [/crossbow|repeater_bow/, 'crossbow'],
  [/bow|liegong|xiaoji|arrow/, 'bow'],
  [/sniper|qilin|antimateriel|anti_materiel/, 'sniper'],
  [/dmr|qinggang|marksman/, 'dmr'],
  [/shotgun|guding|zhangba|scatter/, 'shotgun'],
  [/lmg|huben|machinegun|machine_gun|minigun/, 'lmg'],
  [/smg|zhuge|jinfan|uzi|turret/, 'smg'],
  [/pistol|cixiong|qingnang|dart|revolver|handgun/, 'pistol'],
  [/melee|blade|sword|spear|glaive|halberd|axe|knife|fist|club/, 'melee'],
  [/rifle|carbine|qinglong|hanbing|wushuang|longdan|assault/, 'rifle'],
];

const gunCache = new Map<string, GunSound>();

/** Sound family for a weapon id (data table first, then name heuristics, default rifle). */
export function gunSoundOf(weaponId: string | undefined): GunSound {
  if (!weaponId) return 'rifle';
  const hit = gunCache.get(weaponId);
  if (hit) return hit;
  let res: GunSound | undefined;
  const def = WEAPON_BY_ID[weaponId];
  if (def) {
    res = def.special === 'chainLightning' ? 'tesla' : def.class;
  } else {
    const id = weaponId.toLowerCase();
    for (const [re, cls] of GUN_NAME_RULES) {
      if (re.test(id)) {
        res = cls;
        break;
      }
    }
  }
  res ??= 'rifle';
  gunCache.set(weaponId, res);
  return res;
}

/** Weapon whose hits arc to extra targets (the sim emits one extra `shot` per jump). */
export function isChainWeapon(weaponId: string | undefined): boolean {
  if (!weaponId) return false;
  const def = WEAPON_BY_ID[weaponId];
  return def ? def.special === 'chainLightning' : gunSoundOf(weaponId) === 'tesla';
}

/**
 * Weapon that fires a travelling projectile: its `shot` event ends at the aim
 * point, not at an impact (the projectile's own hit / explosion comes later).
 */
export function isProjectileWeapon(weaponId: string | undefined): boolean {
  if (!weaponId) return false;
  const def = WEAPON_BY_ID[weaponId];
  if (def) return !!def.projectile;
  const g = gunSoundOf(weaponId);
  return g === 'launcher' || g === 'bow' || g === 'crossbow';
}

/** True when a gun family should play as a continuous loop (flamethrower). */
export const isLoopingGun = (g: GunSound): boolean => g === 'flamer';

/** Extra tonal layer for weapon specials (cryo shimmer, fire hiss, ...). */
export function gunFlavorOf(weaponId: string | undefined): '' | 'ice' | 'fire' | 'heavy' | 'light' {
  if (!weaponId) return '';
  const def = WEAPON_BY_ID[weaponId];
  if (def) {
    if (def.special === 'freeze') return 'ice';
    if (def.special === 'fireConvert' || def.dtype === 'fire') return 'fire';
    if (def.rarity === 'legendary' || def.damage >= 60) return 'heavy';
  }
  if (/troop|turret/.test(weaponId)) return 'light';
  if (/hanbing|cryo|ice|frost/.test(weaponId)) return 'ice';
  return '';
}

/** Deterministic 0..1 hash (per-weapon voicing so different guns sound distinct). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
}

export function reloadTimeOf(weaponId: string | undefined): number {
  const def = weaponId ? WEAPON_BY_ID[weaponId] : undefined;
  return def && Number.isFinite(def.reloadTime) && def.reloadTime > 0 ? def.reloadTime : 2;
}

export function fireRateOf(weaponId: string | undefined): number {
  const def = weaponId ? WEAPON_BY_ID[weaponId] : undefined;
  if (def && def.fireRate > 0) return def.fireRate;
  switch (gunSoundOf(weaponId)) {
    case 'smg':
    case 'lmg':
      return 12;
    case 'rifle':
      return 9;
    case 'flamer':
      return 15;
    case 'pistol':
      return 5;
    default:
      return 2;
  }
}

// ── Items ────────────────────────────────────────────────────────────────────
export type ItemSound =
  | 'peach'
  | 'wine'
  | 'ammo'
  | 'dodge'
  | 'trick'
  | 'fire'
  | 'thunder'
  | 'summon'
  | 'arrows'
  | 'bigHeal'
  | 'draw'
  | 'trap'
  | 'recruit'
  | 'steal'
  | 'emp'
  | 'duel'
  | 'chain'
  | 'nullify'
  | 'basic';

export const ITEM_SOUNDS: readonly ItemSound[] = [
  'peach',
  'wine',
  'ammo',
  'dodge',
  'trick',
  'fire',
  'thunder',
  'summon',
  'arrows',
  'bigHeal',
  'draw',
  'trap',
  'recruit',
  'steal',
  'emp',
  'duel',
  'chain',
  'nullify',
  'basic',
];

// ordered: longer / more specific ids first (taoyuan before tao, shandian before shan/sha)
const ITEM_ID_RULES: readonly [RegExp, ItemSound][] = [
  [/taoyuan|peach_garden/, 'bigHeal'],
  [/shandian|lightning/, 'thunder'],
  [/huogong|fire_attack|incendiary/, 'fire'],
  [/nanman|barbarian/, 'summon'],
  [/wanjian|arrow/, 'arrows'],
  [/wuzhong|wugu|harvest|something_from_nothing/, 'draw'],
  [/lebu|bingliang|trap|supply_shortage/, 'trap'],
  [/zhengbing|recruit|conscript/, 'recruit'],
  [/shunshou|steal/, 'steal'],
  [/guohe|dismantle|emp/, 'emp'],
  [/juedou|duel/, 'duel'],
  [/jiedao|borrow/, 'duel'],
  [/tiesuo|chain/, 'chain'],
  [/wuxie|nullif/, 'nullify'],
  [/^tao(\b|_|$)|medkit|peach/, 'peach'],
  [/^jiu(\b|_|$)|wine|analeptic/, 'wine'],
  [/^shan(\b|_|$)|dodge/, 'dodge'],
  [/^sha(\b|_|$)|ammo|strike/, 'ammo'],
];

export function itemSoundOf(itemId: string | undefined): ItemSound {
  if (!itemId) return 'basic';
  const id = itemId.toLowerCase();
  for (const [re, s] of ITEM_ID_RULES) if (re.test(id)) return s;
  const def = ITEM_BY_ID[itemId];
  if (def) {
    switch (def.kind) {
      case 'ammo':
        return 'ammo';
      case 'trick':
        return 'trick';
      case 'delayTrick':
        return 'trap';
      case 'utility':
        return 'recruit';
      case 'basic':
        return def.aiHint === 'heal' ? 'peach' : 'basic';
    }
  }
  return 'basic';
}

export type PickupSound = 'weapon' | 'armor' | 'mount' | 'ammo' | 'item';

export function pickupSoundOf(id: string | undefined): PickupSound {
  if (!id) return 'item';
  if (WEAPON_BY_ID[id]) return 'weapon';
  if (ARMOR_BY_ID[id]) return 'armor';
  if (MOUNT_BY_ID[id]) return 'mount';
  const item = ITEM_BY_ID[id];
  if (item?.kind === 'ammo' || /ammo|^sha(\b|_|$)/.test(id)) return 'ammo';
  return 'item';
}

// ── Abilities ────────────────────────────────────────────────────────────────
export type AbilityFlavor = 'thunder' | 'fire' | 'ice' | 'heal' | 'summon' | 'dash' | 'guqin' | 'shout' | 'shield' | 'stealth' | 'generic';

/**
 * Hand-picked flavors for the shipped heroes' abilities (reviewed against the
 * ability descriptions). New content falls back to the name rules below and
 * then to the ability's data (damage type / AI hint).
 */
const ABILITY_FLAVOR: Readonly<Record<string, AbilityFlavor>> = {
  liubei_jimin: 'heal',
  liubei_banner: 'heal',
  liubei_jijiang: 'summon',
  guanyu_qinglong: 'dash',
  guanyu_yijue: 'shout',
  zhangfei_paoxiao: 'shout',
  zhangfei_duanqiao: 'shout',
  zhugeliang_bazhen: 'guqin',
  zhugeliang_kongcheng: 'guqin',
  zhaoyun_qijin: 'dash',
  zhaoyun_jiuzhu: 'shield',
  machao_tieji: 'shout',
  machao_charge: 'dash',
  huangyueying_muniu: 'summon',
  huangyueying_qicai: 'generic',
  huangzhong_chuanyang: 'generic',
  huangzhong_laodang: 'heal',
  caocao_ningjiao: 'shout',
  caocao_wangmei: 'heal',
  caocao_hujia: 'summon',
  simayi_guicai: 'shield',
  simayi_langgu: 'guqin',
  xiahoudun_bashi: 'heal',
  xiahoudun_charge: 'dash',
  zhangliao_tuxi: 'dash',
  zhangliao_weizhen: 'shout',
  xuchu_luoyi: 'shout',
  xuchu_slam: 'shout',
  guojia_yiji: 'guqin',
  guojia_guimou: 'guqin',
  zhenji_luoshen: 'ice',
  zhenji_lingbo: 'ice',
  xiahouyuan_shensu: 'dash',
  xiahouyuan_hubu: 'dash',
  sunquan_zhiheng: 'guqin',
  sunquan_zuoduan: 'summon',
  sunquan_jiuyuan: 'heal',
  ganning_qixi: 'thunder',
  ganning_jieying: 'stealth',
  lumeng_baiyi: 'stealth',
  lumeng_gongxin: 'guqin',
  huanggai_kurou: 'fire',
  huanggai_huochuan: 'fire',
  zhouyu_fanjian: 'guqin',
  zhouyu_chibi: 'fire',
  daqiao_guose: 'guqin',
  daqiao_anxian: 'heal',
  luxun_huoshao: 'fire',
  luxun_liaoyuan: 'fire',
  sunshangxiang_jieyin: 'heal',
  sunshangxiang_gongyao: 'generic',
  huatuo_qingnang: 'heal',
  huatuo_mafei: 'generic',
  lubu_fangtian: 'shout',
  lubu_sheji: 'generic',
  diaochan_lijian: 'guqin',
  diaochan_lianhuan: 'guqin',
  zhangjiao_leiji: 'thunder',
  zhangjiao_taiping: 'thunder',
  zhangjiao_huangtian: 'summon',
  yuanshao_luanji: 'generic',
  yuanshao_sishi: 'summon',
  menghuo_nanman: 'summon',
  menghuo_xiangbing: 'summon',
};

// Matched against the skill part of the id (hero prefix stripped), anchored at
// its start so e.g. 'menghuo_' never reads as 火 or 'jieying' as 结姻.
const ABILITY_RULES: readonly [RegExp, AbilityFlavor][] = [
  [/^(?:lei|thunder|lightning|taiping|shandian|storm)/, 'thunder'],
  [/^(?:huo(?:gong|shao|chuan|jian)|fire|chibi|napalm|liaoyuan|lianying|zhaxiang|kurou)/, 'fire'],
  [/^(?:lingbo|frost|ice|hanbing|luoshen)/, 'ice'],
  [/^(?:qingnang|anxian|jieyin|jimin|rende|heal|wangmei|laodang|jiuyuan|jijiu|bashi)$/, 'heal'],
  [/^(?:jijiang|hujia|huangtian|nanman|xiangbing|sishi|summon|zuoduan|recruit|muniu)/, 'summon'],
  [/^(?:kongcheng|bazhen|guanxing|guqin|yiji|guimou|zhiheng|fanjian|lijian)/, 'guqin'],
  [/^(?:qijin|chongfeng|tuxi|shensu|dash|charge|blink|changban|qixi|hubu|qinglong)/, 'dash'],
  [/^(?:paoxiao|duanqiao|weizhen|shout|luoyi|tieji|roar)/, 'shout'],
  [/^(?:shield|guicai|renwang|jiuzhu|bagua)/, 'shield'],
  [/^(?:baiyi|stealth|jieying|keji|yinshen)/, 'stealth'],
];

/** The skill part of an ability id (`${heroId}_${skill}`): `guanyu_qinglong` -> `qinglong`. */
function skillPart(abilityId: string): string {
  const id = abilityId.toLowerCase();
  const heroId = ABILITY_HERO[abilityId];
  if (heroId && id.startsWith(`${heroId.toLowerCase()}_`)) return id.slice(heroId.length + 1);
  const us = id.indexOf('_');
  return us > 0 ? id.slice(us + 1) : id;
}

const flavorCache = new Map<string, AbilityFlavor>();

/** Tonal flavor layered over an ability's kingdom stinger. */
export function abilityFlavorOf(abilityId: string | undefined): AbilityFlavor {
  if (!abilityId) return 'generic';
  const hit = ABILITY_FLAVOR[abilityId] ?? flavorCache.get(abilityId);
  if (hit) return hit;
  let res: AbilityFlavor | undefined;
  const skill = skillPart(abilityId);
  for (const [re, f] of ABILITY_RULES) {
    if (re.test(skill)) {
      res = f;
      break;
    }
  }
  if (!res) {
    const def = ABILITY_BY_ID[abilityId];
    if (def?.dtype === 'fire') res = 'fire';
    else if (def?.dtype === 'thunder') res = 'thunder';
    else if (def?.aiHint === 'heal') res = 'heal';
    else if (def?.aiHint === 'summon') res = 'summon';
    else if (def?.aiHint === 'mobility') res = 'dash';
  }
  res ??= 'generic';
  flavorCache.set(abilityId, res);
  return res;
}

/** True when `abilityId` is a lord skill of `heroId` (bigger stinger). */
export function isLordAbility(heroId: string | undefined, abilityId: string): boolean {
  const hero = heroId ? HERO_BY_ID[heroId] : undefined;
  return !!hero?.abilities.some((a) => a.id === abilityId && a.slot === 'lord');
}

export function kingdomOfHero(heroId: string | undefined): Kingdom | undefined {
  return heroId ? HERO_BY_ID[heroId]?.kingdom : undefined;
}

// ── Units ────────────────────────────────────────────────────────────────────
export type StepSound = 'foot' | 'hoof' | 'stomp';

/** Footstep family for a moving unit. */
export function stepSoundOf(kind: EntityKind, sub: string, mounted: boolean): StepSound {
  if (kind === 'hero') return mounted ? 'hoof' : 'foot';
  const troop = TROOP_BY_ID[sub];
  const mount = troop?.visual.mountedOn;
  if (mount === 'elephant' || /elephant|xiang/.test(sub)) return 'stomp';
  if (mount === 'horse' || mounted) return 'hoof';
  return 'foot';
}
