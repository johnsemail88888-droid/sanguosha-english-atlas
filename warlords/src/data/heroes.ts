// The 30-hero roster (docs/GAME_SPEC.md §5): 蜀 8 · 魏 8 · 吴 8 · 群 6.
// Per-kingdom definitions live in heroes-{shu,wei,wu,qun}.ts; this module
// aggregates them and provides lookups.
//
// ── Conventions for ability implementers (sim/abilities/*) ──────────────────
// The descriptions (descZh/descEn) are the player-facing contract and `params`
// carries every number they mention. Implement exactly that with SimApi.
//  - Units: meters, seconds, HP. `mul` 1.3 = +30 %; `frac`/`slow`/`haste`/`chance` are 0..1.
//  - "enemy"/敌人 = any unit NOT on your own side (!sim.isOwnSide(self, x)): other heroes
//    (roles are hidden), their troops, NPCs, turrets. "your soldiers/squad" = self.hero.squad
//    plus your temporary summons. "heroes"/武将 in area effects = every hero incl. enemies.
//  - targeting 'enemy' / 'ally': the hero/unit under the crosshair within params.range
//    (sim.aimTarget). No valid target ⇒ activate() returns false (no cooldown), unless the
//    description gives a fallback (e.g. "or yourself").
//  - targeting 'point': sim.aimPoint(self, params.range). 'direction': the aim ray yaw/pitch.
//  - range: max targeting distance. radius: effect radius. duration: effect time (s).
//  - dash/dashTime: sim.dash distance/time; blink: teleport distance; width: half-width (m) of
//    a dash's damage corridor; knockback / knockUp: force passed to sim.knockback (up for knockUp).
//  - Each unit is hit at most once per cast by corridor, sweep, slam or line damage (火烧赤壁's
//    `blasts` included). Only counted hits — bolts, arrows, shots, periodic ticks — hit repeatedly.
//  - Damage types: AbilityDef.dtype is the DamageType of EVERY hit the ability deals (direct, blast,
//    field/hazard ticks, reflected damage): pass it as DamageRequest.type / explode dtype /
//    HazardSpec.dtype. Abilities without dtype deal no damage themselves. Ability damage is NOT a
//    weapon hit: pass abilityId and no weaponId, so bullet-only rules (armor bulletReduction, 八卦,
//    仁王盾, 藤甲 troop immunity, 鬼才 reflect, 流离, 倾国, weapon specials/lifesteal, 酒) don't
//    apply to it. Exception: params.weaponHit = 1 means the shots are fired with the held weapon
//    (pass its weaponId; falloff and weapon specials apply). Type-based rules still apply: 藤甲
//    fire ×2, 白银狮子 cap (except dtype 'pierce', which skips armor entirely), 武圣, 赤胆, 鬼道.
//  - Burst: no single cast deals ≥ 300 to one target, including the owner's passive multipliers
//    (enforced by tests/unit/data). 酒 only doubles WEAPON hits (ITEM_BY_ID.jiu.params.weaponOnly).
//  - Private reveal: params.privateReveal = 1 ⇒ apply 'reveal' with params { viewerId: self.id }.
//    Only that hero's client sees the outline + minimap marker (SIM-CORE canSee / snapshotFor and
//    NET honour viewerId — see docs/CONTRACT_CHANGES.md). A reveal without viewerId is public.
//  - Bullet evasion (八卦, dodgeChance statuses such as 八阵图, 倾国) combines as 1 − Π(1 − p) and
//    is capped at BULLET_EVASION_CAP (data/items.ts).
//  - stun on heroes never exceeds 1.5 s; stunTroop-style params apply to troops/NPCs only.
//  - icd: internal cooldown of a passive, tracked in hero.abilityState.
//  - Passive `troopBonus` params only mirror HeroDef.troopBonus, which the world already adds at
//    spawn — never add them again. A lord skill's `squadBonus` IS extra and goes through
//    SimExt modifiers().squadBonus (sim/ext.ts).
//  - Stat modifiers (reloadMul, cdMul → cooldownMul, speedMul, fireRateMul, troopHpMul,
//    extra dodge charges, knockback immunity, shieldPierce, sprintAds, maxHpBonus, revive
//    tweaks) go through AbilityImplEx.modifiers() from sim/ext.ts, not per-tick hacks.
//  - summons: kingdom units via sim.spawnTroops(self.id, type, count, pos, { temporary: lifetime });
//    NPC-type summons via sim.spawnNpc(type, pos, { summonerId: self.id, lifetime }).
//  - "N random items": rollRewardItems(sim.rng, N) from data/loot.ts, then sim.giveItem.
//  - "steal": sim.takeRandomItem(target) then sim.giveItem(self). 陆逊 谦逊 blocks theft, so
//    SimApi.takeRandomItem must return null when the victim's canBeAffected('steal') is false.
//  - lord-slot abilities only work if the hero is the real Lord (world gates activation).
//  - A lord-slot ability WITHOUT a cooldown is a passive lord skill (袁绍 血裔): it has no
//    activate(), G does nothing, and UI / bots / world skip it — use isPassiveAbility().
import { QUN_HEROES } from './heroes-qun';
import { SHU_HEROES } from './heroes-shu';
import { WEI_HEROES } from './heroes-wei';
import { WU_HEROES } from './heroes-wu';
import type { AbilityDef, HeroDef } from './types';

export const HEROES: HeroDef[] = [...SHU_HEROES, ...WEI_HEROES, ...WU_HEROES, ...QUN_HEROES];

export const HERO_BY_ID: Record<string, HeroDef> = Object.fromEntries(HEROES.map((h) => [h.id, h]));

/** Every ability of every hero, by globally unique ability id. */
export const ABILITY_BY_ID: Record<string, AbilityDef> = Object.fromEntries(
  HEROES.flatMap((h) => h.abilities.map((a) => [a.id, a] as const)),
);

/** Ability id → owning hero id. */
export const ABILITY_HERO: Record<string, string> = Object.fromEntries(
  HEROES.flatMap((h) => h.abilities.map((a) => [a.id, h.id] as const)),
);

/** The five heroes offered to the Lord (★): 刘备 曹操 孙权 张角 袁绍. */
export const LORD_CANDIDATE_IDS: readonly string[] = HEROES.filter((h) => h.lordCandidate).map((h) => h.id);

/** The hero's ability in an input slot ('q' | 'e' | 'lord'), if any. */
export function heroAbility(heroId: string, slot: AbilityDef['slot']): AbilityDef | undefined {
  return HERO_BY_ID[heroId]?.abilities.find((a) => a.slot === slot);
}

/**
 * True for abilities that are never activated: passives and passive lord skills
 * (a 'lord'-slot ability without a cooldown, e.g. 袁绍 血裔).
 */
export function isPassiveAbility(a: AbilityDef): boolean {
  return a.slot === 'passive' || a.cooldown === undefined;
}

/** All passive abilities of a hero (some heroes have two). */
export function heroPassives(heroId: string): AbilityDef[] {
  return HERO_BY_ID[heroId]?.abilities.filter((a) => a.slot === 'passive') ?? [];
}
