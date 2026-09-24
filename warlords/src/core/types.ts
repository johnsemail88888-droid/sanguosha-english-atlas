// ─────────────────────────────────────────────────────────────────────────────
// Shared runtime contracts. Every module (sim / net / render / ui / audio / ai)
// talks through these types. Change them only with care: several modules are
// developed in parallel against this file.
// Units: meters, seconds, radians. Sim runs at SIM_HZ fixed ticks on the host.
// ─────────────────────────────────────────────────────────────────────────────
import type { Vec3 } from './math';

export type { Vec3 } from './math';

export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 30;
/** Clients render remote entities this far in the past (seconds) for interpolation. */
export const INTERP_DELAY = 0.1;
export const PROTOCOL_VERSION = 1;

export type EntityId = number;
/** Network peer id for humans, 'bot-<n>' for bots, 'local' for single player human. */
export type PlayerId = string;

export type Kingdom = 'wei' | 'shu' | 'wu' | 'qun' | 'god';
export type Gender = 'male' | 'female';

/** 身份. 'double' 影武者, 'opportunist' 墙头草, 'bounty' 赏金猎人 are 乱世 (chaos-mode) roles. */
export type RoleId = 'lord' | 'loyalist' | 'rebel' | 'traitor' | 'double' | 'opportunist' | 'bounty';
/** Winning side. Each role belongs to one faction (see data/roles.ts). */
export type Faction = 'lord' | 'rebel' | 'traitor' | 'neutral';

export type DamageType =
  | 'normal' // bullets
  | 'melee'
  | 'fire'
  | 'thunder'
  | 'explosive'
  | 'pierce' // ignores armor
  | 'zone' // 烽火圈 damage, ignores everything but invuln
  | 'true'; // ignores armor/shields/dodge

export type EntityKind =
  | 'hero' // a player-controlled or bot-controlled 武将
  | 'troop' // soldier commanded by a hero (带兵)
  | 'npc' // neutral monsters: 黄巾 bandits, 南蛮 barbarians, beasts
  | 'projectile'
  | 'loot' // item/weapon lying on ground
  | 'crate' // 锦囊 loot chest (opened with F)
  | 'airdrop' // 天降锦囊 falling / landed supply drop
  | 'turret' // deployables (黄月英 木牛流马 turret, etc.)
  | 'hazard'; // area effects: fire field, lightning cloud, traps, smoke

// ── Status effects ───────────────────────────────────────────────────────────
// Semantics are implemented generically in sim/status.ts; abilities/items only
// apply them. `params` keys documented per id.
export type StatusId =
  | 'stun' // cannot move/act
  | 'root' // cannot move, can shoot
  | 'slow' // params.amount 0..1 speed reduction
  | 'haste' // params.amount speed bonus (0.3 = +30%)
  | 'burn' // params.dps fire damage over time
  | 'freeze' // heavy slow (60%) + no sprint/jump; visual ice
  | 'poison' // params.dps true damage over time
  | 'stealth' // invisible to others beyond ~6m, hidden on minimap; breaks on firing unless params.keep
  | 'invuln' // immune to all damage
  | 'untargetable' // cannot be hit by bullets/abilities (bullets pass through)
  | 'dmgBoost' // params.mul outgoing damage multiplier (1.5 = +50%)
  | 'dmgTakenUp' // params.mul incoming multiplier (>1)
  | 'dmgTakenDown' // params.mul incoming multiplier (<1)
  | 'noReload' // firing does not consume magazine
  | 'fireRateUp' // params.mul fire-rate multiplier
  | 'reveal' // shown on everyone's minimap / outline through walls
  | 'charm' // params.targetId: forced to attack that entity (players: aim dragged + auto-fire)
  | 'silence' // no abilities / items
  | 'disarm' // cannot shoot or melee
  | 'dance' // 乐不思蜀: cannot shoot/abilities, speed -50%, dancing anim
  | 'nullify' // 无懈可击: next hostile status or ability effect on you is cancelled (consumes)
  | 'chained' // 铁索连环: damage of type fire/thunder spreads to all chained units
  | 'marked' // marked by a commander; troops focus it
  | 'dodgeChance' // params.chance: chance to evade bullets entirely
  | 'regen' // params.hps heal per second
  | 'lifesteal' // params.frac of damage dealt healed
  | 'reflect' // params.frac of incoming bullet damage reflected to attacker
  | 'thorns' // params.frac of incoming damage dealt back to attacker (any type)
  | 'undodgeable' // outgoing attacks ignore dodge / 八卦 / dodgeChance
  | 'pierce' // outgoing damage ignores armor
  | 'shield' // params.amount absorb pool (also mirrored in Entity.shield)
  | 'drunk'; // 酒: next damaging hit ×params.mul (consumed on hit)

export interface StatusInstance {
  id: StatusId;
  /** sim time (s) when it expires. Infinity for until-consumed. */
  until: number;
  sourceId?: EntityId;
  stacks?: number;
  params?: Record<string, number>;
}

// ── Heroes / units state (host-side, authoritative) ─────────────────────────
export interface WeaponInstance {
  id: string; // WeaponDef id
  mag: number;
  reserve: number;
}

export interface ItemStack {
  id: string; // ItemDef id
  count: number;
}

export type SquadOrderKind = 'follow' | 'hold' | 'attack' | 'charge';
export interface SquadOrder {
  kind: SquadOrderKind;
  point?: Vec3;
  targetId?: EntityId;
}

export interface ChannelState {
  kind: 'item' | 'revive' | 'open' | 'ability' | 'recruit';
  start: number;
  until: number;
  targetId?: EntityId;
  itemSlot?: number;
  abilityId?: string;
}

export interface HeroState {
  heroId: string;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  seat: number;
  role: RoleId;
  roleRevealed: boolean;
  /** 跳身份: publicly claimed role (may be a lie). */
  claim: RoleId | null;
  weapons: (WeaponInstance | null)[]; // [primary, secondary]
  activeSlot: number;
  items: (ItemStack | null)[]; // ITEM_SLOTS
  armor: string | null; // ArmorDef id
  mount: string | null; // MountDef id
  /** abilityId -> sim time when ready. */
  cooldowns: Record<string, number>;
  /** abilityId -> remaining charges (for charge-based abilities). */
  charges: Record<string, number>;
  /** free-form per-ability state (stacks, toggles). */
  abilityState: Record<string, number>;
  dodgeCharges: number;
  dodgeRechargeAt: number;
  dodgingUntil: number;
  downed: boolean;
  downedUntil: number; // bleed-out time
  dead: boolean;
  killerId?: EntityId;
  squad: EntityId[];
  order: SquadOrder;
  ads: boolean;
  sprinting: boolean;
  reloadUntil: number;
  nextFireAt: number;
  /** consecutive shots for spread bloom / recoil */
  burst: number;
  channel: ChannelState | null;
  bountyTargetId?: EntityId;
  stats: { kills: number; damage: number; healing: number; rescues: number };
}

export interface TroopState {
  troopType: string; // TroopTypeDef id
  commanderId: EntityId;
  slot: number; // formation slot index
  targetId?: EntityId;
  nextFireAt: number;
  mag: number;
  reloadUntil: number;
  /** AI scratch state */
  ai: Record<string, number>;
}

export interface NpcState {
  npcType: string; // TroopTypeDef id (npc kinds reuse troop defs)
  home: Vec3;
  leash: number;
  targetId?: EntityId;
  nextFireAt: number;
  /** summoned by (e.g. 南蛮入侵): never attacks summoner */
  summonerId?: EntityId;
  expiresAt?: number;
  ai: Record<string, number>;
}

export interface ProjectileState {
  kind: string; // 'rocket' | 'grenade' | 'arrow' | 'fireball' | 'bolt' | ...
  weaponId?: string;
  abilityId?: string;
  damage: number;
  dtype: DamageType;
  gravity: number;
  explodeRadius: number;
  explodeDamage: number;
  expiresAt: number;
  pierce: number; // remaining pierce-through count
  canDodge: boolean;
  onHitStatus?: { id: StatusId; duration: number; params?: Record<string, number> };
}

export interface LootState {
  itemId?: string; // ItemDef/ArmorDef/MountDef id
  weaponId?: string;
  count: number;
  /** WeaponInstance ammo when a used weapon is dropped */
  mag?: number;
  reserve?: number;
}

export interface CrateState {
  tier: 1 | 2 | 3; // 1 wooden, 2 bronze, 3 airdrop/gold
  opened: boolean;
}

export interface TurretState {
  kind: string;
  weaponId: string;
  expiresAt: number;
  nextFireAt: number;
  targetId?: EntityId;
}

export interface HazardState {
  kind: string; // 'fire' | 'lightningCloud' | 'trapDance' | 'trapRoot' | 'smoke' | 'healZone' | 'arrowRain' | ...
  radius: number;
  expiresAt: number;
  nextTickAt: number;
  tickEvery: number;
  params: Record<string, number>;
  /** entity that follows (lightning cloud following a hero) */
  followId?: EntityId;
}

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  radius: number;
  height: number;
  hp: number;
  maxHp: number;
  shield: number;
  alive: boolean;
  onGround: boolean;
  kingdom?: Kingdom;
  ownerId?: EntityId;
  statuses: StatusInstance[];
  /** forced movement (dash/knockback) overrides input movement until `until` */
  forced?: { vel: Vec3; until: number; invuln?: boolean };
  lastDamagedBy?: EntityId;
  lastDamagedAt?: number;
  hero?: HeroState;
  troop?: TroopState;
  npc?: NpcState;
  proj?: ProjectileState;
  loot?: LootState;
  crate?: CrateState;
  turret?: TurretState;
  hazard?: HazardState;
}

export const ITEM_SLOTS = 4;
export const WEAPON_SLOTS = 2;

// ── Input (client → host) ───────────────────────────────────────────────────
export const BTN_FIRE = 1;
export const BTN_ADS = 2;
export const BTN_SPRINT = 4;
export const BTN_JUMP = 8;
export const BTN_CROUCH = 16;
export const BTN_INTERACT = 32; // F held (channels: revive/open)

export type AbilitySlot = 'q' | 'e' | 'lord';

export type InputAction =
  | { a: 'jump' }
  | { a: 'dodge' }
  | { a: 'reload' }
  | { a: 'ability'; slot: AbilitySlot }
  | { a: 'interact' }
  | { a: 'weapon'; slot: number }
  | { a: 'item'; slot: number }
  | { a: 'drop'; slot: number; what: 'item' | 'weapon' }
  | { a: 'command'; order: SquadOrderKind }
  | { a: 'mark' }
  | { a: 'claim'; role: RoleId }
  | { a: 'quickchat'; id: string };

export interface InputFrame {
  seq: number;
  /** Local movement intent, camera relative: x = strafe right, z = forward. Each in [-1, 1]. */
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** Edge-triggered actions since previous frame. */
  actions: InputAction[];
  /** World point under the crosshair (client raycast). Used for ability/command targeting. */
  aimPoint?: Vec3;
  /** Entity under the crosshair, if any. */
  aimTargetId?: EntityId;
  /** Host tick the client was rendering (lag compensation). */
  viewTick?: number;
}

export const emptyInput = (seq = 0): InputFrame => ({
  seq,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  actions: [],
});

// ── Events (host → everyone; drive VFX, audio, HUD, kill feed) ───────────────
/** Optional routing shared by every GameEvent. */
export interface EventRouting {
  /** hidden information: only this hero's player receives the event (private reveal, bounty reward). Absent = public. */
  privateTo?: EntityId;
}

export type GameEvent = EventRouting &
  (
    | { t: 'shot'; src: EntityId; weapon: string; from: Vec3; to: Vec3; hit?: EntityId }
    | {
        t: 'hit';
        target: EntityId;
        src?: EntityId;
        amount: number;
        dtype: DamageType;
        pos: Vec3;
        head?: boolean;
        blocked?: 'dodge' | 'armor' | 'invuln' | 'shield' | 'nullify';
      }
    | { t: 'explosion'; pos: Vec3; radius: number; kind: string }
    | { t: 'melee'; src: EntityId; pos: Vec3; dir: Vec3; range: number; arc: number }
    | { t: 'ability'; src: EntityId; ability: string; pos?: Vec3; target?: EntityId; dir?: Vec3 }
    | { t: 'status'; target: EntityId; status: StatusId; on: boolean }
    | { t: 'heal'; target: EntityId; amount: number; src?: EntityId }
    | { t: 'downed'; target: EntityId; src?: EntityId }
    | { t: 'revived'; target: EntityId; by?: EntityId }
    | { t: 'death'; target: EntityId; killer?: EntityId; kind: EntityKind; role?: RoleId; heroId?: string; name?: string }
    | { t: 'pickup'; who: EntityId; item: string }
    | { t: 'itemUse'; who: EntityId; item: string; pos?: Vec3; target?: EntityId }
    | { t: 'reward'; who: EntityId; kind: 'rebelKill' | 'lordPenalty' | 'bounty'; items?: string[] }
    | { t: 'zone'; phase: number; center: Vec3; radius: number; targetRadius: number; shrinkStart: number; shrinkEnd: number }
    | { t: 'airdrop'; pos: Vec3; id: EntityId }
    | { t: 'claim'; who: EntityId; role: RoleId }
    | { t: 'quickchat'; who: EntityId; id: string }
    | { t: 'chat'; from: string; text: string }
    | { t: 'command'; who: EntityId; order: SquadOrderKind; point?: Vec3; target?: EntityId }
    | { t: 'announce'; zh: string; en: string; kind?: 'info' | 'warn' | 'big' }
    | { t: 'sfx'; name: string; pos?: Vec3 }
    | { t: 'gameOver'; result: GameResult }
  );

export interface GameResult {
  winner: Faction | 'draw';
  /** entity ids of heroes that won (faction winners + extra winners like 墙头草/赏金) */
  winners: EntityId[];
  /** every hero's role, revealed at the end */
  roles: Record<EntityId, RoleId>;
  mvp?: EntityId;
  reasonZh: string;
  reasonEn: string;
  durationSec: number;
}

// ── Views (what render/UI see; also the network snapshot format) ────────────
// Bit flags for ViewEntity.flags
export const VF_DEAD = 1 << 0;
export const VF_DOWNED = 1 << 1;
export const VF_ADS = 1 << 2;
export const VF_FIRING = 1 << 3;
export const VF_RELOADING = 1 << 4;
export const VF_SPRINTING = 1 << 5;
export const VF_STEALTH = 1 << 6;
export const VF_INVULN = 1 << 7;
export const VF_STUNNED = 1 << 8;
export const VF_BURNING = 1 << 9;
export const VF_FROZEN = 1 << 10;
export const VF_DANCING = 1 << 11;
export const VF_CHARMED = 1 << 12;
export const VF_SHIELDED = 1 << 13;
export const VF_AIRBORNE = 1 << 14;
export const VF_DODGING = 1 << 15;
export const VF_CHANNELING = 1 << 16;
export const VF_LORD = 1 << 17; // show crown (true lord, or 影武者 disguise)
export const VF_REVEALED = 1 << 18; // role public (dead or lord)
export const VF_MARKED = 1 << 19;
export const VF_OPENED = 1 << 20; // crate opened
export const VF_MOUNTED = 1 << 21;
export const VF_HASTE = 1 << 22;
export const VF_ROOTED = 1 << 23;
export const VF_SLOWED = 1 << 24;
export const VF_BOOSTED = 1 << 25; // dmgBoost active (glow)
export const VF_EXPOSED = 1 << 26; // 'reveal' status: shown on the minimap / outlined through walls (public, or private to this viewer)

export interface ViewEntity {
  id: EntityId;
  kind: EntityKind;
  /** heroId | troopType | npcType | projectile kind | item/weapon id | crate tier | turret kind | hazard kind */
  sub: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** horizontal speed m/s (animation blend) */
  speed: number;
  hp: number;
  maxHp: number;
  shield: number;
  flags: number;
  kingdom?: Kingdom;
  owner?: EntityId;
  /** held weapon id (heroes/troops/turrets) */
  weapon?: string;
  armor?: string;
  mount?: string;
  /** hazard / explosion radius etc. */
  radius?: number;
  /** role, only when public (lord, revealed after death, or it's you) */
  role?: RoleId;
  /** public claim (跳身份) */
  claim?: RoleId;
  /** player display name for heroes */
  name?: string;
}

/** Full private state of the receiving player's hero (HUD). */
export interface PrivateHeroView {
  entityId: EntityId;
  heroId: string;
  role: RoleId;
  hp: number;
  maxHp: number;
  shield: number;
  weapons: (WeaponInstance | null)[];
  activeSlot: number;
  items: (ItemStack | null)[];
  armor: string | null;
  mount: string | null;
  /** abilityId -> seconds remaining (0 = ready) */
  cooldowns: Record<string, number>;
  charges: Record<string, number>;
  abilityState: Record<string, number>;
  dodgeCharges: number;
  reloading: number; // seconds remaining (0 = not)
  channel: { kind: ChannelState['kind']; progress: number } | null;
  downed: boolean;
  downedRemaining: number;
  dead: boolean;
  statuses: { id: StatusId; remaining: number }[];
  squad: { id: EntityId; hp: number; maxHp: number }[];
  order: SquadOrder;
  bountyTargetId?: EntityId;
  /** for 影武者/主公: id of the other crown bearer, when known */
  knownAllies?: EntityId[];
  stats: HeroState['stats'];
  /** (optional, for client prediction) authoritative velocity of your hero */
  vel?: Vec3;
  /** (optional, for client prediction) your hero is standing on ground */
  onGround?: boolean;
  /** (optional, for client prediction) the exact MoveMods the host used for your hero this tick */
  moveMods?: PredictionMoveMods;
  /** (optional, for client prediction) active forced movement of your hero (dash / knockback): Entity.forced.vel and seconds until it ends */
  forced?: { vel: Vec3; remaining: number };
}

/** Mirror of sim/physics MoveMods (core must not import sim). Sent for the local hero only. */
export interface PredictionMoveMods {
  speedMul: number;
  canSprint: boolean;
  canJump: boolean;
  rooted: boolean;
}

export interface ZoneView {
  phase: number;
  center: Vec3;
  radius: number;
  targetCenter: Vec3;
  targetRadius: number;
  shrinkStart: number;
  shrinkEnd: number;
  dps: number;
}

export interface PublicPlayerView {
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  seat: number;
  entityId: EntityId;
  heroId: string;
  kingdom: Kingdom;
  alive: boolean;
  downed: boolean;
  /** only when public */
  role?: RoleId;
  claim?: RoleId;
  kills: number;
  ping?: number;
}

export interface Snapshot {
  tick: number;
  time: number;
  /** last InputFrame.seq processed for the receiving player */
  ackSeq: number;
  ents: ViewEntity[];
  zone: ZoneView;
  you: PrivateHeroView | null;
  players: PublicPlayerView[];
  /** seconds since match start */
  elapsed: number;
}

// ── Match / lobby ───────────────────────────────────────────────────────────
export type GameMode = 'standard' | 'chaos';
export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface MatchSettings {
  playerCount: 5 | 6 | 7 | 8;
  mode: GameMode;
  botDifficulty: BotDifficulty;
  /** heroes offered to non-lords during selection (3 = classic) */
  heroChoices: number;
  /** allow all heroes to be picked freely (casual) */
  freePick: boolean;
  mapSeed: number;
  friendlyFire: boolean;
  troopsPerHero: number; // base squad size (lord +2)
}

export const defaultSettings = (): MatchSettings => ({
  playerCount: 5,
  mode: 'standard',
  botDifficulty: 'normal',
  heroChoices: 3,
  freePick: false,
  mapSeed: 20260924,
  friendlyFire: true,
  troopsPerHero: 4,
});

export interface LobbySeat {
  seat: number;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  isHost: boolean;
  ready: boolean;
}

export interface LobbyState {
  roomCode: string;
  hostId: PlayerId;
  settings: MatchSettings;
  seats: LobbySeat[];
}

/** Pre-match flow phases, driven by the host. */
export type MatchPhase = 'lobby' | 'roles' | 'heroSelect' | 'loading' | 'playing' | 'gameOver';

export interface RoleDealView {
  /** your own role */
  yourRole: RoleId;
  /** seat -> publicly known role (the lord, and 影武者 shown as lord) */
  publicRoles: Record<number, RoleId>;
  /** for bounty hunter: target seat */
  bountySeat?: number;
}

export interface HeroSelectView {
  /** heroes you may choose from */
  options: string[];
  /** seconds remaining */
  deadline: number;
  /** seat -> picked heroId (lord's pick is public before others choose) */
  picks: Record<number, string>;
  lordSeat: number;
  /** true while only the lord is choosing */
  lordPhase: boolean;
}
