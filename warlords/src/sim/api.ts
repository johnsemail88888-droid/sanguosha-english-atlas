// ─────────────────────────────────────────────────────────────────────────────
// The API that hero abilities, items, weapon specials and AI brains program
// against. Implemented by sim/world.ts (World implements SimApi).
// Abilities/items are registered by id (sim/abilities/registry.ts,
// sim/items/registry.ts) and never import World directly.
// ─────────────────────────────────────────────────────────────────────────────
import type { Rng } from '../core/rng';
import type { MapData } from '../core/map';
import type { Vec3 } from '../core/math';
import type {
  DamageType,
  Entity,
  EntityId,
  GameEvent,
  InputFrame,
  RoleId,
  StatusId,
  SquadOrder,
} from '../core/types';
import type { AbilityDef, HeroDef, ItemDef } from '../data/types';

export interface DamageRequest {
  targetId: EntityId;
  sourceId?: EntityId;
  amount: number;
  type: DamageType;
  weaponId?: string;
  abilityId?: string;
  /** impact point (for hit markers / knockback direction) */
  pos?: Vec3;
  head?: boolean;
  /** default true. false = 不可闪避 (ignores dodge i-frames, 八卦, dodgeChance) */
  canDodge?: boolean;
  ignoreArmor?: boolean;
  /** prevents reflect/thorns loops */
  noReflect?: boolean;
  knockback?: number;
  /** internal: damage already redirected once (流离) */
  redirected?: boolean;
}

export interface DamageResult {
  dealt: number; // hp lost
  absorbed: number; // shield absorbed
  blocked?: 'dodge' | 'armor' | 'invuln' | 'shield' | 'nullify';
  killed: boolean; // downed or died
}

export interface RayHit {
  point: Vec3;
  normal: Vec3;
  dist: number;
  entityId?: EntityId; // undefined = world geometry / terrain
  head?: boolean;
}

export interface ProjectileSpec {
  kind: string;
  ownerId: EntityId;
  pos: Vec3;
  vel: Vec3;
  damage: number;
  dtype: DamageType;
  gravity?: number;
  explodeRadius?: number;
  explodeDamage?: number;
  lifetime?: number;
  pierce?: number;
  canDodge?: boolean;
  weaponId?: string;
  abilityId?: string;
  onHitStatus?: { id: StatusId; duration: number; params?: Record<string, number> };
  radius?: number;
}

export interface HazardSpec {
  kind: string; // 'fire' | 'lightningCloud' | 'trapDance' | 'trapRoot' | 'smoke' | 'healZone' | 'arrowRain' | 'napalm' | ...
  ownerId?: EntityId;
  pos: Vec3;
  radius: number;
  duration: number;
  tickEvery: number;
  /** damage per tick (dtype) / heal per tick / status to apply, etc. */
  params: Record<string, number>;
  dtype?: DamageType;
  status?: { id: StatusId; duration: number; params?: Record<string, number> };
  /** does it hurt/affect the owner and owner's squad? default false */
  affectsOwner?: boolean;
  followId?: EntityId;
  /** triggered once when an enemy steps in, then expires (traps) */
  triggerOnce?: boolean;
}

export interface ExplodeOptions {
  kind?: string; // vfx kind: 'fire' | 'thunder' | 'frag' | 'rocket' | 'ice' | 'holy'
  falloff?: boolean; // default true
  knockback?: number;
  selfDamage?: boolean; // default false (owner immune to own blasts)
  canDodge?: boolean; // default true
  status?: { id: StatusId; duration: number; params?: Record<string, number> };
  abilityId?: string;
  weaponId?: string;
}

export interface QueryFilter {
  kinds?: Entity['kind'][];
  aliveOnly?: boolean; // default true
  exclude?: EntityId[];
  /** exclude the given commander's own squad + the commander */
  notFriendlyTo?: EntityId;
}

/** Context passed to every ability hook. */
export interface AbilityCtx {
  sim: SimApi;
  self: Entity; // the hero entity (self.hero is defined)
  def: AbilityDef;
  hero: HeroDef;
  input: InputFrame; // latest input (aimPoint / aimTargetId / yaw / pitch)
}

export interface DamageHookCtx extends AbilityCtx {
  req: DamageRequest;
  /** the other party (attacker for *Taken hooks, victim for *Dealt hooks) */
  other?: Entity;
}

/**
 * Hero ability implementation. Only `id` is required; implement whichever
 * hooks the design needs. Active abilities implement `activate`, which returns
 * true when it fired (the world then starts the cooldown from AbilityDef).
 */
export interface AbilityImpl {
  id: string;
  activate?(ctx: AbilityCtx): boolean;
  /** called every tick while alive (passives, channel updates) */
  tick?(ctx: AbilityCtx, dt: number): void;
  /** modify outgoing damage before mitigation; return new amount */
  modifyOutgoing?(ctx: DamageHookCtx, amount: number): number;
  /** modify incoming damage before mitigation; return new amount (0 = negated) */
  modifyIncoming?(ctx: DamageHookCtx, amount: number): number;
  onDamageTaken?(ctx: DamageHookCtx, dealt: number): void;
  onDamageDealt?(ctx: DamageHookCtx, dealt: number): void;
  onKill?(ctx: AbilityCtx, victim: Entity): void;
  onFire?(ctx: AbilityCtx, weaponId: string): void;
  /** magazine just hit 0 */
  onMagEmpty?(ctx: AbilityCtx, weaponId: string): void;
  onItemUsed?(ctx: AbilityCtx, itemId: string): void;
  /** hero entered 濒死 (downed); return true to prevent (e.g. self-save) */
  onDowned?(ctx: AbilityCtx): boolean | void;
  /** another hero within range got downed (华佗 急救 etc.) */
  onOtherDowned?(ctx: AbilityCtx, victim: Entity): void;
  /** can this hero be targeted by an enemy status/steal? (陆逊 谦逊) return false to block */
  canBeAffected?(ctx: AbilityCtx, status: StatusId | 'steal', sourceId?: EntityId): boolean;
  /** movement speed multiplier */
  speedMul?(ctx: AbilityCtx): number;
}

export interface ItemCtx {
  sim: SimApi;
  self: Entity;
  def: ItemDef;
  input: InputFrame;
  /** resolved target (for ally/enemy targeting) */
  target?: Entity;
  point?: Vec3;
}

export interface ItemImpl {
  id: string;
  /** return false if it could not be used (item not consumed) */
  use(ctx: ItemCtx): boolean;
  /** can be used on a downed ally (桃) */
  canRevive?: boolean;
}

export interface SimApi {
  readonly time: number;
  readonly tick: number;
  readonly rng: Rng;
  readonly map: MapData;

  get(id: EntityId | undefined): Entity | undefined;
  entities(): Iterable<Entity>;
  heroes(): Entity[]; // all hero entities (alive or not)
  heroDef(e: Entity): HeroDef | undefined;
  inputOf(e: Entity): InputFrame;

  queryRadius(pos: Vec3, r: number, filter?: QueryFilter): Entity[];
  queryCone(pos: Vec3, dir: Vec3, range: number, halfAngle: number, filter?: QueryFilter): Entity[];
  raycast(from: Vec3, dir: Vec3, maxDist: number, opts?: { ignore?: EntityId[]; entities?: boolean }): RayHit | null;
  lineOfSight(a: Vec3, b: Vec3): boolean;
  groundHeight(x: number, z: number): number;
  /** eye position of an entity */
  eyePos(e: Entity): Vec3;
  /** crosshair ray for a hero (reconstructed third-person camera ray) */
  aimRay(e: Entity): { origin: Vec3; dir: Vec3 };
  /** world point under crosshair, clamped to maxDist */
  aimPoint(e: Entity, maxDist: number): Vec3;
  /** entity under crosshair within maxDist (uses input.aimTargetId, validated) */
  aimTarget(e: Entity, maxDist: number, filter?: QueryFilter): Entity | undefined;

  /** true if `a` commands `b`, or b is a's own deployable/summon, or a === b */
  isOwnSide(a: Entity, b: Entity): boolean;
  /** best-knowledge hostility used by troops/turrets/AI (commander hostile marks + known roles). */
  isHostileTo(a: Entity, b: Entity): boolean;
  /** role of a hero entity (host knowledge — AI must use knownRole for fairness) */
  roleOf(e: Entity): RoleId | undefined;
  /** role as publicly known (lord, revealed dead, or undefined) */
  knownRole(e: Entity): RoleId | undefined;

  dealDamage(req: DamageRequest): DamageResult;
  heal(targetId: EntityId, amount: number, sourceId?: EntityId): number;
  addShield(targetId: EntityId, amount: number, duration: number): void;
  applyStatus(
    targetId: EntityId,
    id: StatusId,
    duration: number,
    opts?: { sourceId?: EntityId; params?: Record<string, number>; stacks?: number },
  ): boolean;
  removeStatus(targetId: EntityId, id: StatusId): void;
  hasStatus(targetId: EntityId, id: StatusId): boolean;
  statusParam(targetId: EntityId, id: StatusId, key: string, fallback: number): number;

  spawnProjectile(spec: ProjectileSpec): Entity;
  explode(pos: Vec3, radius: number, damage: number, dtype: DamageType, sourceId: EntityId | undefined, opts?: ExplodeOptions): void;
  spawnHazard(spec: HazardSpec): Entity;
  spawnTroops(commanderId: EntityId, troopType: string, count: number, pos?: Vec3, opts?: { temporary?: number }): Entity[];
  spawnNpc(npcType: string, pos: Vec3, opts?: { summonerId?: EntityId; lifetime?: number; leash?: number }): Entity;
  spawnTurret(ownerId: EntityId, pos: Vec3, kind: string, weaponId: string, lifetime: number, hp: number): Entity;
  spawnLoot(pos: Vec3, what: { itemId?: string; weaponId?: string; count?: number }): Entity;
  removeEntity(id: EntityId): void;

  /** add to first free item slot / stack; returns false if full (then drops as loot) */
  giveItem(heroId: EntityId, itemId: string, count?: number): boolean;
  /** remove one random item/equipment from hero; returns id taken */
  takeRandomItem(heroId: EntityId, includeEquipment?: boolean): string | null;
  giveWeapon(heroId: EntityId, weaponId: string): void;
  refillAmmo(heroId: EntityId, fractionOfMax: number): void;
  equip(heroId: EntityId, armorOrMountId: string): void;

  dash(id: EntityId, dir: Vec3, distance: number, duration: number, opts?: { invuln?: boolean }): void;
  knockback(id: EntityId, dir: Vec3, force: number): void;
  teleport(id: EntityId, pos: Vec3): void;

  setCooldown(heroId: EntityId, abilityId: string, seconds: number): void;
  cooldownLeft(heroId: EntityId, abilityId: string): number;
  setSquadOrder(heroId: EntityId, order: SquadOrder): void;

  emit(ev: GameEvent): void;
  announce(zh: string, en: string, kind?: 'info' | 'warn' | 'big'): void;
  /** run fn after delay seconds (sim time). Cancelled if the world ends. */
  schedule(delay: number, fn: () => void): void;
}

/** AI brain for bot heroes: produce an InputFrame each tick. */
export interface BotBrain {
  think(sim: SimApi, self: Entity, dt: number): InputFrame;
}
