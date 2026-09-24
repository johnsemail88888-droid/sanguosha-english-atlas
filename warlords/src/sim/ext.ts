// Sim-side extensions of the frozen SimApi / AbilityImpl / ItemImpl contracts.
//
// World implements SimExt (a superset of SimApi). Ability/item/AI code that
// needs these extras calls `ext(ctx.sim)`; everything here is additive and
// lives in SIM-CORE-owned files, so the frozen contracts stay untouched.
import type { Vec3 } from '../core/math';
import type { DamageType, Entity, EntityId, StatusId, WeaponInstance, ZoneView } from '../core/types';
import type { WeaponDef } from '../data/types';
import type { AbilityCtx, AbilityImpl, DamageHookCtx, ItemImpl, RayHit, SimApi } from './api';

/**
 * Aggregated per-hero modifiers. Abilities contribute through
 * AbilityImplEx.modifiers(); multiplicative fields multiply, additive fields
 * add, booleans OR together.
 */
export interface HeroModifiers {
  /** ×: movement speed */
  speedMul?: number;
  /** ×: reload time (0.6 = 40 % faster) */
  reloadMul?: number;
  /** ×: weapon fire rate */
  fireRateMul?: number;
  /** ×: ability cooldowns */
  cooldownMul?: number;
  /** ×: outgoing damage of this hero's troops (applied on top of statuses) */
  troopDmgMul?: number;
  /** ×: troop max HP at spawn */
  troopHpMul?: number;
  /** ×: healing received */
  healTakenMul?: number;
  /** ×: revive channel time */
  reviveTimeMul?: number;
  /** +: extra HP granted when this hero revives someone */
  reviveHpBonus?: number;
  /** +: dodge-roll charges on top of the default 2 */
  extraDodgeCharges?: number;
  /** ×: dodge recharge time */
  dodgeRechargeMul?: number;
  /** +: fraction (0..1) of the victim's shield ignored by this hero's damage */
  shieldPierce?: number;
  /** +: max HP bonus (recomputed every tick; 袁绍 血裔) */
  maxHpBonus?: number;
  /** immune to knockback / knock-up (许褚 虎痴) */
  knockbackImmune?: boolean;
  /** sprinting keeps ADS (夏侯渊 神速) */
  sprintAds?: boolean;
  /** weapon shots never consume ammo */
  infiniteAmmo?: boolean;
  /** NPC types that never attack this hero (孟获 vs barbarians) */
  npcImmune?: string[];
  /** +: extra squad soldiers at spawn (lord skills like 血裔) */
  squadBonus?: number;
  /**
   * always-on chance (0..1) to evade a dodgeable bullet entirely; folds with
   * 八卦 and 'dodgeChance' statuses as 1 − Π(1 − p), capped at BULLET_EVASION_CAP.
   * Conditional evasion (倾国 "while moving") uses AbilityImplEx.bulletEvadeChance.
   */
  evadeChance?: number;
}

/** Fully resolved modifiers (defaults filled in). */
export interface ResolvedModifiers {
  speedMul: number;
  reloadMul: number;
  fireRateMul: number;
  cooldownMul: number;
  troopDmgMul: number;
  troopHpMul: number;
  healTakenMul: number;
  reviveTimeMul: number;
  reviveHpBonus: number;
  extraDodgeCharges: number;
  dodgeRechargeMul: number;
  shieldPierce: number;
  maxHpBonus: number;
  knockbackImmune: boolean;
  sprintAds: boolean;
  infiniteAmmo: boolean;
  npcImmune: string[];
  squadBonus: number;
  evadeChance: number;
}

export const defaultModifiers = (): ResolvedModifiers => ({
  speedMul: 1,
  reloadMul: 1,
  fireRateMul: 1,
  cooldownMul: 1,
  troopDmgMul: 1,
  troopHpMul: 1,
  healTakenMul: 1,
  reviveTimeMul: 1,
  reviveHpBonus: 0,
  extraDodgeCharges: 0,
  dodgeRechargeMul: 1,
  shieldPierce: 0,
  maxHpBonus: 0,
  knockbackImmune: false,
  sprintAds: false,
  infiniteAmmo: false,
  npcImmune: [],
  squadBonus: 0,
  evadeChance: 0,
});

/** Fold one contribution into an accumulator. */
export function foldModifiers(acc: ResolvedModifiers, m: HeroModifiers | undefined | void): void {
  if (!m) return;
  if (m.speedMul !== undefined) acc.speedMul *= m.speedMul;
  if (m.reloadMul !== undefined) acc.reloadMul *= m.reloadMul;
  if (m.fireRateMul !== undefined) acc.fireRateMul *= m.fireRateMul;
  if (m.cooldownMul !== undefined) acc.cooldownMul *= m.cooldownMul;
  if (m.troopDmgMul !== undefined) acc.troopDmgMul *= m.troopDmgMul;
  if (m.troopHpMul !== undefined) acc.troopHpMul *= m.troopHpMul;
  if (m.healTakenMul !== undefined) acc.healTakenMul *= m.healTakenMul;
  if (m.reviveTimeMul !== undefined) acc.reviveTimeMul *= m.reviveTimeMul;
  if (m.reviveHpBonus !== undefined) acc.reviveHpBonus += m.reviveHpBonus;
  if (m.extraDodgeCharges !== undefined) acc.extraDodgeCharges += m.extraDodgeCharges;
  if (m.dodgeRechargeMul !== undefined) acc.dodgeRechargeMul *= m.dodgeRechargeMul;
  if (m.shieldPierce !== undefined) acc.shieldPierce += m.shieldPierce;
  if (m.maxHpBonus !== undefined) acc.maxHpBonus += m.maxHpBonus;
  if (m.knockbackImmune) acc.knockbackImmune = true;
  if (m.sprintAds) acc.sprintAds = true;
  if (m.infiniteAmmo) acc.infiniteAmmo = true;
  if (m.npcImmune && m.npcImmune.length) acc.npcImmune = acc.npcImmune.concat(m.npcImmune);
  if (m.squadBonus !== undefined) acc.squadBonus += m.squadBonus;
  if (m.evadeChance !== undefined && m.evadeChance > 0) acc.evadeChance = 1 - (1 - acc.evadeChance) * (1 - Math.min(1, m.evadeChance));
}

/** Extra hooks the world dispatches in addition to AbilityImpl's. */
export interface AbilityImplEx extends AbilityImpl {
  /** passive modifiers, queried once per tick */
  modifiers?(ctx: AbilityCtx): HeroModifiers | undefined | void;
  /**
   * attacker side, before the damage pipeline runs (before dodge checks):
   * may mutate ctx.req (canDodge, ignoreArmor, amount...). 黄忠 烈弓.
   */
  beforeDamageDealt?(ctx: DamageHookCtx): void;
  /** this hero performed a dodge roll */
  onDodge?(ctx: AbilityCtx): void;
  /** this hero healed someone (after healing is applied) */
  onHealGiven?(ctx: AbilityCtx, target: Entity, amount: number): void;
  /** modify healing received; return the new amount */
  modifyHealTaken?(ctx: AbilityCtx, amount: number, sourceId?: EntityId): number;
  /** this hero may revive without spending a 桃 right now (华佗 急救) */
  canReviveFree?(ctx: AbilityCtx): boolean;
  /** this hero revived `target`; `free` = no 桃 was spent */
  onRevive?(ctx: AbilityCtx, target: Entity, free: boolean): void;
  /** this hero's armor or mount was removed (孙尚香 枭姬) */
  onEquipmentLost?(ctx: AbilityCtx, what: 'armor' | 'mount', id: string): void;
  /**
   * victim side: chance (0..1) to evade this dodgeable weapon bullet entirely
   * (甄姬 倾国 while moving). Combat folds it with 八卦, 'dodgeChance' statuses
   * and modifiers().evadeChance as 1 − Π(1 − p), capped at BULLET_EVASION_CAP,
   * and rolls once — do not roll inside the hook.
   */
  bulletEvadeChance?(ctx: DamageHookCtx): number;
}

export interface ItemImplEx extends ItemImpl {
  /** can be used while downed (酒) */
  usableWhileDowned?: boolean;
  /** optional bot hint: is using this item sensible right now? */
  botShouldUse?(sim: SimApi, self: Entity): boolean;
}

export interface HitscanOptions {
  damage: number;
  range: number;
  dtype: DamageType;
  weaponId?: string;
  abilityId?: string;
  /** additional targets the round passes through */
  pierce?: number;
  canDodge?: boolean;
  ignoreArmor?: boolean;
  /** apply the weapon falloff curve (needs weaponId) */
  falloff?: boolean;
  knockback?: number;
  headshotMul?: number;
  status?: { id: StatusId; duration: number; params?: Record<string, number> };
  /** emit a 'shot' event (default true) */
  emitShot?: boolean;
}

/** SimApi + helpers the world offers to abilities, items and AI. */
export interface SimExt extends SimApi {
  /** revive a downed hero with `hp` HP */
  revive(targetId: EntityId, hp: number, byId?: EntityId): boolean;
  /** resolve a hitscan shot from `origin` along `dir` with full damage pipeline */
  fireHitscan(srcId: EntityId, origin: Vec3, dir: Vec3, opts: HitscanOptions): RayHit | null;
  /** aggregated modifiers of a hero (defaults for non-heroes) */
  modifiers(heroId: EntityId): ResolvedModifiers;
  /** active weapon instance + def */
  activeWeapon(heroId: EntityId): { inst: WeaponInstance; def: WeaponDef } | undefined;
  /** fill the active (or given) weapon's magazine from nothing (free ammo) */
  refillMag(heroId: EntityId, slot?: number): void;
  /** the hero that commands/owns `e` (itself for heroes) */
  commanderOf(e: Entity): Entity | undefined;
  /** entity id that gets credit for damage done by `sourceId` */
  creditOf(sourceId: EntityId | undefined): EntityId | undefined;
  /** "not on my side" (friendly fire is on): used for AoE/abilities */
  isEnemyOf(a: Entity, b: Entity): boolean;
  /** remove every debuff */
  cleanse(targetId: EntityId): void;
  /** entities that damaged `id` within `window` seconds (credited ids) */
  recentAttackers(id: EntityId, window?: number): EntityId[];
  /** steal one random item from victim into thief (respects canBeAffected 'steal'); returns id */
  stealItem(thiefId: EntityId, victimId: EntityId, includeEquipment?: boolean): string | null;
  /** drop the hero's mount as loot (麒麟弓 / 奇袭) */
  dismount(heroId: EntityId): void;
  /** remove the hero's armor (drops it as loot when `drop`) */
  stripArmor(heroId: EntityId, drop?: boolean): void;
  /** force the channel (if any) to stop */
  cancelChannel(heroId: EntityId): void;
  /** seconds since the entity last took damage (Infinity if never) */
  sinceDamaged(id: EntityId): number;
  /**
   * Nav-grid path (waypoints incl. start/end) or null when unreachable / the
   * per-tick path budget is spent (callers retry later).
   */
  findPath(from: Vec3, to: Vec3, requesterId?: EntityId): Vec3[] | null;
  /** is `e` visible to `viewer` (stealth beyond 6 m hides it unless revealed) */
  canSee(viewer: Entity, e: Entity): boolean;
  /** current 烽火圈 state */
  zoneView(): ZoneView;
}

export const ext = (sim: SimApi): SimExt => sim as SimExt;

/**
 * Status ids that are debuffs: vetoable by canBeAffected (陆逊 谦逊), cancelled by
 * nullify when applied by an enemy (except NULLIFY_EXEMPT), cleansed by 青囊.
 */
export const DEBUFF_STATUSES: ReadonlySet<StatusId> = new Set<StatusId>([
  'stun',
  'root',
  'slow',
  'burn',
  'freeze',
  'poison',
  'charm',
  'silence',
  'disarm',
  'dance',
  'chained',
  'marked',
  'dmgTakenUp',
  'reveal',
]);

export const isDebuff = (id: StatusId): boolean => DEBUFF_STATUSES.has(id);

/** Information statuses: never cancelled by (and never consume) 无懈可击. */
export const NULLIFY_EXEMPT: ReadonlySet<StatusId> = new Set<StatusId>(['reveal', 'marked']);
