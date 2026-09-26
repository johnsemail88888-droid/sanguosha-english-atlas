// The host-authoritative simulation: World implements SimApi (for abilities,
// items and AI), SimExt (sim-side extras) and SimHost (for the session/net).
//
// Fixed tick order (step):
//   inputs (humans: latest frame + queued actions; bots: BotBrain) →
//   hero actions (actions, movement, firing, channels, reload, pickups) →
//   ability ticks → troops / NPCs / turrets → projectiles → hazards →
//   scheduled callbacks → statuses → zone → airdrops → rules → events/history.
import type { MapData } from '../core/map';
import type { Vec3 } from '../core/math';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import type {
  AbilitySlot,
  DamageType,
  DeniedReason,
  Entity,
  EntityId,
  EntityKind,
  GameEvent,
  GameResult,
  InputAction,
  InputFrame,
  ItemStack,
  MatchSettings,
  PlayerId,
  PredictionMoveMods,
  RoleId,
  Snapshot,
  SquadOrder,
  SquadOrderKind,
  StatusId,
  StatusInstance,
  WeaponInstance,
  ZoneView,
} from '../core/types';
import { BTN_ADS, BTN_FIRE, SIM_DT, emptyInput } from '../core/types';
import type { GameMode } from '../core/types';
import { ROLE_BY_ID, isPassiveAbility } from '../data';
import type { AbilityDef, HeroDef, WeaponDef } from '../data/types';
import { NAV_MAIN, buildNavGrid, locateNode, findPath as navFindPath } from './map/nav';
import type { NavGrid } from './map/nav';
import { generateMap } from './map/generate';
import type {
  AbilityCtx,
  BotBrain,
  DamageRequest,
  DamageResult,
  ExplodeOptions,
  HazardSpec,
  ProjectileSpec,
  QueryFilter,
  RayHit,
} from './api';
import type { MatchInit, MatchSeatInit, SimHost } from './host';
import './abilities';
import { getAbility } from './abilities/registry';
import { aimAnglesFor, cameraRig } from './aim';
import { HookDispatcher } from './hooks';
import type { AbilityEntry } from './hooks';
import { createBasicBot } from './ai/basicBot';
import { BasicNpcBrain } from './ai/npcBrain';
import { forgetPath } from './ai/steer';
import { BasicTroopBrain } from './ai/troopBrain';
import type { BotBrainFactory, NpcBrain, TroopBrain } from './ai/types';
import {
  DOWNED_DAMAGE_TO_SECONDS,
  LAG_COMP_MAX_TICKS,
  LagHistory,
  dealDamage,
  explodeAt,
  fireHitscanShot,
  healEntity,
  heroFire,
  makeProjectileState,
  raycastAll,
  redirectDamage as redirectDamageImpl,
  startReload,
  tickReload,
  updateProjectiles,
} from './combat';
import type { ChainStrike, DamageFrame } from './combat';
import {
  heroDef,
  maxReserve,
  mountDef,
  setWarnSink,
  usesAmmo,
  warnOnce,
  weaponDef,
} from './defs';
import type { AbilityCast, HitscanOptions, ResolvedModifiers, SimExt, StripOptions } from './ext';
import { BASE_DODGE_CHARGES, DEBUFF_STATUSES, defaultModifiers } from './ext';

export { BASE_DODGE_CHARGES } from './ext';
import { hazardIsHarmful, hazardRuntimeFrom, updateHazards } from './hazards';
import type { HazardRuntime } from './hazards';
import { isHostile, knownRoleFor } from './hostility';
import './items';
import {
  AIRDROP_FALL_TIME,
  AIRDROP_HEIGHT,
  AirdropSchedule,
  rollGround,
  scatterAround,
} from './loot';
import * as inv from './inventory';
import { spawnNpcEntity, updateNpcs } from './npc';
import type { CollisionWorld, MoveMods, MoveState } from './physics';
import {
  CHAR_HEIGHT,
  CHAR_RADIUS,
  WALK_SPEED,
  brakeForcedEnd,
  buildCollisionWorld,
  findFreeSpot,
  findOpenGround,
  forcedMove,
  groundAt,
  lineOfSight as staticLos,
  predictMove,
} from './physics';
import {
  BLEED_OUT_TIME,
  HARD_CAP_TIME,
  checkWin,
  downHero,
  factionOf,
  killHero,
  pickBountyTarget,
  reviveHero,
  tickDowned,
} from './rules';
import { ViewCache, buildSnapshot } from './snapshot';
import { EntityGrid } from './spatial';
import {
  applyStatusTo,
  clearStatuses,
  controlState,
  findStatus,
  nullifyEffect,
  removeStatusFrom,
  removeStatusIf,
  revealedTo,
  statusParamOf,
  statusSpeedMul,
  tickStatuses,
} from './status';
import type { ControlState } from './status';
import { spawnSquad, updateTroops, updateTurrets } from './troops';
import { Zone, ZONE_DAMAGE_PERIOD } from './zone';

export interface CreateMatchOptions {
  /** override the generated map (tests) */
  map?: MapData;
  /** bot hero brain factory (wave 2 swaps in the role-aware AI) */
  botFactory?: BotBrainFactory;
  troopBrain?: TroopBrain;
  npcBrain?: NpcBrain;
  /** spawn map crates / ground loot / NPC camps (default true) */
  ambient?: boolean;
  /** run the shrinking zone (default true) */
  zone?: boolean;
  /** schedule airdrops (default true) */
  airdrops?: boolean;
  /** spawn hero squads (default true) */
  squads?: boolean;
  /** build the nav grid for AI pathfinding (default true) */
  nav?: boolean;
  /** route sim warnings (default console.warn) */
  onWarn?: (msg: string) => void;
}

/** Host-side per-hero runtime state that is not part of the network contract. */
export interface HeroRuntime {
  def: HeroDef;
  abilities: AbilityEntry[];
  /** effective input for this tick */
  input: InputFrame;
  /** actions to process this tick */
  actions: InputAction[];
  mods: ResolvedModifiers;
  prevFireHeld: boolean;
  lastFireAt: number;
  rampStart: number;
  followUpMul: number;
  followUpUntil: number;
  /** whatever the hero is shooting at (troops engage it) */
  focusId?: EntityId;
  focusAt: number;
  downedBy?: EntityId;
  downedBySource?: EntityId;
  /** the hero who downed us did it personally (not via troops / summons) — kept in case the source despawns */
  downedDirect?: boolean;
  bountyKills: number;
  baseMaxHp: number;
  appliedHpBonus: number;
  markId?: EntityId;
  deathAt?: number;
  lastMoveMods?: PredictionMoveMods;
  lastArmor: string | null;
  lastMount: string | null;
  /** item being channelled (id + target point; revive = started on a downed hero) */
  channelItem?: { id: string; point?: Vec3; revive: boolean };
  /** locomotion state wrapper (shares pos/vel with the entity) */
  move: MoveState;
  /** tick of the last movement step (dashes / knockbacks started later in a tick begin next tick) */
  movedTick: number;
}

export interface PlayerSlot {
  seat: number;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  entityId: EntityId;
  latest: InputFrame;
  queue: InputAction[];
  lastSeq: number;
  ackSeq: number;
  brain?: BotBrain;
}

interface Scheduled {
  at: number;
  seq: number;
  fn: () => void;
  /** acting hero when the callback was scheduled (restored while it runs) */
  actor?: EntityId;
}

const UNIT_KINDS: EntityKind[] = ['hero', 'troop', 'npc', 'turret'];
const MAX_ACTIONS_PER_TICK = 24;
/** public events kept for SimExt.publicEventsSince (AI-1) */
export const PUBLIC_EVENT_LOG = 2048;
const DODGE_RECHARGE = 8;
const DODGE_DISTANCE = 4.5;
const DODGE_TIME = 0.35;
const WEAPON_SWAP_TIME = 0.25;
const ATTACK_MEMORY = 10;
const MARK_TIME = 12;
const AIRDROP_RADIUS = 1.0;
/** airdrops stay this far from the map edge */
const AIRDROP_EDGE_MARGIN = 25;
/** A* searches started per tick (more are refused; callers retry later) */
const PATH_BUDGET_PER_TICK = 1;
/** A* node expansions per search (caps the worst single search at ~1–2 ms) */
const PATH_MAX_ITER = 3000;
/**
 * Deterministic amortisation (no wall clock, so the host stays reproducible):
 * a failed search is charged the full PATH_MAX_ITER, a found path about a third
 * of it; the allowance refills PATH_ITER_PER_TICK per tick and searches wait
 * while it is overdrawn.
 */
const PATH_ITER_PER_TICK = 1000;
const PATH_COST_FOUND = 1000;
/** paths are shared per (start cell, goal cell) for this long (squadmates, repeated queries) */
const PATH_CACHE_TTL = 4;
const PATH_CACHE_CELL = 4;
const PATH_CACHE_MAX = 768;
const EMPTY_INPUT = emptyInput();

const KIND_ORDER: EntityKind[] = ['hero', 'troop', 'npc', 'projectile', 'loot', 'crate', 'airdrop', 'turret', 'hazard'];

export class World implements SimExt, SimHost {
  readonly map: MapData;
  readonly cw: CollisionWorld;
  readonly rng: Rng;
  readonly settings: MatchSettings;
  tick = 0;
  time = 0;

  readonly ents = new Map<EntityId, Entity>();
  readonly grid: EntityGrid;
  readonly history = new LagHistory();
  readonly zone: Zone;
  readonly airdropSchedule = new AirdropSchedule();
  readonly hooks: HookDispatcher;
  readonly slots: PlayerSlot[] = [];
  readonly hazardRt = new Map<EntityId, HazardRuntime>();
  readonly projPierced = new Map<EntityId, Set<EntityId>>();
  /** projectiles whose kind's onDetonate already ran (combat.ts registerProjectileKind) */
  readonly projDetonated = new Set<EntityId>();
  /** hits being resolved right now: dmgStack[0 … dmgDepth − 1] (combat.ts dealDamage; SimExt.redirectDamage) */
  readonly dmgStack: DamageFrame[] = [];
  dmgDepth = 0;
  readonly projHoming = new Map<EntityId, { targetId: EntityId; turnRate: number }>();
  readonly freezeStacks = new Map<EntityId, { stacks: number; until: number; immuneUntil: number }>();
  readonly scratchHits = new Map<EntityId, { amount: number; head: boolean; pos: Vec3; dist: number }>();
  chainSpreading = false;
  /** 铁索连环 dedupe (QUN-7): strike key → units that took that strike this tick, directly / through the chain */
  private readonly chainHits = new Map<string, ChainStrike>();
  private chainHitsTick = -1;
  viewDirty = false;
  /**
   * Hero whose ability / item / scheduled code is running right now. Effects
   * that carry no explicit source (knockback, teleport, takeRandomItem, a
   * status without sourceId) are attributed to it for nullify and vetoes.
   */
  actorId: EntityId | undefined = undefined;
  /** > 0 while periodic area effects tick (hazard fields): they never consume 无懈可击 */
  periodicDepth = 0;
  /** target → the enemy whose effect burst was nullified this tick (see status.ts nullifyEffect) */
  readonly nullifyEcho = new Map<EntityId, { creditId: EntityId; tick: number }>();

  private nextId = 1;
  private gridDirty = true;
  private kindLists: Map<EntityKind, Entity[]> | null = null;
  private hittableList: Entity[] | null = null;
  private events: GameEvent[] = [];
  /** ring buffer of public events (SimExt.publicEventsSince): event + its seq per slot */
  private readonly pubLog: (GameEvent | undefined)[] = new Array<GameEvent | undefined>(PUBLIC_EVENT_LOG);
  private readonly pubLogSeq = new Float64Array(PUBLIC_EVENT_LOG);
  private pubSeq = 0;
  private slotByPlayer = new Map<PlayerId, PlayerSlot>();
  private slotByEntity = new Map<EntityId, PlayerSlot>();
  private heroRts = new Map<EntityId, HeroRuntime>();
  private scheduled: Scheduled[] = [];
  private schedSeq = 0;
  private attackLog = new Map<EntityId, Map<EntityId, number>>();
  private expiries = new Map<EntityId, number>();
  private removals = new Map<EntityId, number>();
  private turretAis = new Map<EntityId, { nextScan: number }>();
  /** loot that a given hero may not auto/F pick up until a time (voluntary drops, penalties) */
  readonly lootLocks = new Map<EntityId, { heroId: EntityId; until: number }>();
  private resultValue: GameResult | null = null;
  private winCheckRequested = true;
  private readonly troopBrain: TroopBrain;
  private readonly npcBrain: NpcBrain;
  private readonly botFactory: BotBrainFactory;
  private readonly opts: CreateMatchOptions;
  private readonly viewCache = new ViewCache();
  private nav: NavGrid | null = null;
  private navFailed = false;
  private pathBudget = PATH_BUDGET_PER_TICK;
  private pathDebt = 0;
  private readonly pathCache = new Map<string, { path: Vec3[] | null; at: number }>();
  private zoneDamageAt = ZONE_DAMAGE_PERIOD;
  /** troops / NPCs: tick in which each already ran its movement step (troops.ts driveUnit) */
  private readonly unitMovedTick = new Map<EntityId, number>();
  private readonly cs: ControlState = { stunned: false, rooted: false, silenced: false, disarmed: false, dancing: false, frozen: false };
  private readonly moveMods: MoveMods = { speedMul: 1, canSprint: true, canJump: true, rooted: false, ads: false, downed: false };

  constructor(readonly init: MatchInit, opts: CreateMatchOptions = {}) {
    this.opts = opts;
    if (opts.onWarn) setWarnSink(opts.onWarn);
    this.settings = init.settings;
    this.map = opts.map ?? generateMap(init.settings.mapSeed);
    this.cw = buildCollisionWorld(this.map);
    this.rng = new Rng(init.seed);
    this.grid = new EntityGrid(this.map.size, 8);
    this.zone = new Zone(new Rng((init.seed ^ 0x5a17) >>> 0), HARD_CAP_TIME);
    this.hooks = new HookDispatcher(this);
    this.troopBrain = opts.troopBrain ?? new BasicTroopBrain();
    this.npcBrain = opts.npcBrain ?? new BasicNpcBrain();
    this.botFactory = opts.botFactory ?? createBasicBot;
    if (opts.nav !== false) {
      try {
        this.nav = buildNavGrid(this.map);
      } catch (err) {
        this.navFailed = true;
        warnOnce('nav', `nav grid unavailable, AI falls back to steering: ${String(err)}`);
      }
    }
    this.spawnHeroes();
    if (opts.ambient !== false) this.spawnAmbient();
    const z = this.zone.view();
    this.emit({ t: 'zone', phase: 0, center: z.center, radius: z.radius, targetRadius: z.targetRadius, shrinkStart: z.shrinkStart, shrinkEnd: z.shrinkEnd });
    this.announce('烽火已燃，群雄逐鹿！', 'The beacons are lit — let the battle begin!', 'big');
    this.rebuildGrid();
    for (const e of this.hittables()) this.history.record(e, 0);
  }

  // ── setup ────────────────────────────────────────────────────────────────
  /**
   * Spawn points for `n` non-lord heroes, as far apart as the map allows (APP-8): a greedy
   * farthest-point pick seeded with the lord's spawn (the first pick is a random ring spawn,
   * each next one the spawn farthest from every spot already taken). The seats then take them in
   * a shuffled order, so which hero lands where stays random.
   */
  private spawnOrder(n: number): Vec3[] {
    const pool = this.rng.shuffle([...this.map.spawns]);
    if (pool.length === 0 || n <= 0) return pool;
    const taken: Vec3[] = [this.map.lordSpawn];
    const picked: Vec3[] = [];
    const d2 = (a: Vec3, b: Vec3): number => (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
    while (picked.length < Math.min(n, pool.length)) {
      let best = -1;
      let bestD = -1;
      for (let i = 0; i < pool.length; i++) {
        let m = Infinity;
        for (const t of taken) m = Math.min(m, d2(pool[i], t));
        // the first ring pick: every spawn is ~110 m from the palace — take the shuffled first
        if (picked.length === 0) m = i === 0 ? Infinity : 0;
        if (m > bestD) {
          bestD = m;
          best = i;
        }
      }
      picked.push(pool[best]);
      taken.push(pool[best]);
      pool.splice(best, 1);
    }
    return [...this.rng.shuffle(picked), ...pool];
  }

  private spawnHeroes(): void {
    const seats = [...this.init.seats].sort((a, b) => a.seat - b.seat);
    const order = this.spawnOrder(seats.filter((s) => s.role !== 'lord').length);
    let spawnIdx = 0;
    const heroes: Entity[] = [];
    for (const seat of seats) {
      const def = heroDef(seat.heroId);
      const isLordLike = seat.role === 'lord' || seat.role === 'double';
      let base: Vec3;
      if (seat.role === 'lord') base = this.map.lordSpawn;
      else if (order.length > 0) base = order[spawnIdx++ % order.length];
      else base = { x: 0, y: 0, z: 0 };
      if (seat.role !== 'lord' && order.length > 0 && spawnIdx > order.length) {
        const a = this.rng.next() * Math.PI * 2;
        base = { x: base.x + Math.cos(a) * 4, y: base.y, z: base.z + Math.sin(a) * 4 };
      }
      const pos = findFreeSpot(this.cw, base, CHAR_RADIUS, CHAR_HEIGHT, 16);
      const maxHp = def.maxHp + (isLordLike ? 100 : 0);
      const yaw = Math.atan2(pos.x, pos.z); // face the map center
      const e = this.createEntity('hero', pos, { radius: CHAR_RADIUS, height: CHAR_HEIGHT, hp: maxHp, kingdom: def.kingdom, yaw });
      const abilities: AbilityEntry[] = def.abilities
        .filter((a) => a.slot !== 'lord' || seat.role === 'lord')
        .map((a) => {
          const impl = getAbility(a.id);
          if (!impl) warnOnce(`ability:${a.id}`, `no implementation registered for ability '${a.id}' (${def.id})`);
          return { def: a, impl };
        });
      const charges: Record<string, number> = {};
      for (const a of abilities) if (a.def.charges) charges[a.def.id] = a.def.charges;
      e.hero = {
        heroId: def.id,
        playerId: seat.playerId,
        name: seat.name,
        isBot: seat.isBot,
        seat: seat.seat,
        role: seat.role,
        roleRevealed: false,
        claim: null,
        weapons: [this.newWeapon(def.signatureWeapon), def.signatureWeapon === 'pistol' ? null : this.newWeapon('pistol')],
        activeSlot: 0,
        items: [{ id: 'tao', count: 1 }, null, null, null],
        armor: null,
        mount: null,
        cooldowns: {},
        charges,
        abilityState: {},
        dodgeCharges: BASE_DODGE_CHARGES,
        dodgeRechargeAt: 0,
        dodgingUntil: 0,
        downed: false,
        downedUntil: 0,
        dead: false,
        squad: [],
        order: { kind: 'follow' },
        ads: false,
        sprinting: false,
        reloadUntil: 0,
        nextFireAt: 0,
        burst: 0,
        channel: null,
        stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
      };
      const rt: HeroRuntime = {
        def,
        abilities,
        input: { ...emptyInput(), yaw },
        actions: [],
        mods: defaultModifiers(),
        prevFireHeld: false,
        lastFireAt: -99,
        rampStart: 0,
        followUpMul: 1,
        followUpUntil: 0,
        focusAt: -99,
        bountyKills: 0,
        baseMaxHp: maxHp,
        appliedHpBonus: 0,
        lastArmor: null,
        lastMount: null,
        move: { pos: e.pos, vel: e.vel, onGround: true },
        movedTick: -1,
      };
      this.heroRts.set(e.id, rt);
      const slot: PlayerSlot = {
        seat: seat.seat,
        playerId: seat.playerId,
        name: seat.name,
        isBot: seat.isBot,
        entityId: e.id,
        latest: { ...emptyInput(), yaw },
        queue: [],
        lastSeq: -1,
        ackSeq: 0,
      };
      if (seat.isBot) slot.brain = this.makeBot(seat.seat);
      this.slots.push(slot);
      this.slotByPlayer.set(seat.playerId, slot);
      this.slotByEntity.set(e.id, slot);
      heroes.push(e);
    }
    // modifiers (for squad bonuses / troop hp), squads, bounty targets
    for (const e of heroes) this.refreshModifiers(e);
    for (const e of heroes) {
      const seat = seats.find((s) => s.seat === e.hero!.seat)!;
      const def = this.heroRts.get(e.id)!.def;
      if (this.opts.squads !== false) spawnSquad(this, e, def.troopType, this.squadCap(e.id));
      if (seat.role === 'bounty') this.assignInitialBounty(e, seat, heroes);
    }
  }

  private assignInitialBounty(hunter: Entity, seat: MatchSeatInit, heroes: Entity[]): void {
    if (seat.bountyTargetSeat !== undefined) {
      const t = heroes.find((h) => h.hero!.seat === seat.bountyTargetSeat);
      if (t && t !== hunter && t.hero!.role !== 'lord') {
        hunter.hero!.bountyTargetId = t.id;
        return;
      }
    }
    hunter.hero!.bountyTargetId = pickBountyTarget(this, hunter);
  }

  private spawnAmbient(): void {
    for (const c of this.map.crateSpots) this.spawnCrate(c.pos, c.tier);
    for (const camp of this.map.camps) {
      for (let i = 0; i < camp.count; i++) {
        const a = (i / Math.max(1, camp.count)) * Math.PI * 2;
        const r = 3 + (i % 2) * 2;
        this.spawnNpc(camp.npcType, { x: camp.pos.x + Math.cos(a) * r, y: camp.pos.y, z: camp.pos.z + Math.sin(a) * r });
      }
      const near = this.map.crateSpots.some((c) => Math.hypot(c.pos.x - camp.pos.x, c.pos.z - camp.pos.z) < 6);
      if (!near) this.spawnCrate(camp.pos, camp.crateTier);
    }
    for (const spot of this.map.lootSpots) {
      const rolls = rollGround(this.rng);
      rolls.forEach((r, i) => inv.spawnLootRoll(this, scatterAround(spot, i, rolls.length, 0.8), r));
    }
  }

  private spawnCrate(pos: Vec3, tier: 1 | 2 | 3): Entity {
    const y = groundAt(this.cw, pos.x, pos.z, pos.y + 1.5);
    const e = this.createEntity('crate', { x: pos.x, y, z: pos.z }, { radius: 0.7, height: 0.9, hp: 1, yaw: this.rng.next() * Math.PI * 2 });
    e.crate = { tier, opened: false };
    return e;
  }

  private makeBot(seat: number): BotBrain {
    return this.botFactory(seat, this.settings.botDifficulty, (this.init.seed + seat * 7919) >>> 0);
  }

  newWeapon(id: string): WeaponInstance {
    const def = weaponDef(id);
    return { id, mag: usesAmmo(def) ? def.magSize : 0, reserve: usesAmmo(def) ? maxReserve(def) : 0 };
  }

  // ── entity management ───────────────────────────────────────────────────
  createEntity(
    kind: EntityKind,
    pos: Vec3,
    o: { radius?: number; height?: number; hp?: number; kingdom?: Entity['kingdom']; ownerId?: EntityId; yaw?: number } = {},
  ): Entity {
    const e: Entity = {
      id: this.nextId++,
      kind,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: o.yaw ?? 0,
      pitch: 0,
      radius: o.radius ?? 0.4,
      height: o.height ?? 1.8,
      hp: o.hp ?? 1,
      maxHp: o.hp ?? 1,
      shield: 0,
      alive: true,
      onGround: true,
      statuses: [],
    };
    if (o.kingdom) e.kingdom = o.kingdom;
    if (o.ownerId !== undefined) e.ownerId = o.ownerId;
    this.ents.set(e.id, e);
    this.markKindsDirty();
    this.gridDirty = true;
    return e;
  }

  markKindsDirty(): void {
    this.kindLists = null;
    this.hittableList = null;
    this.viewDirty = true;
  }

  kindList(kind: EntityKind): Entity[] {
    if (!this.kindLists) {
      const m = new Map<EntityKind, Entity[]>();
      for (const k of KIND_ORDER) m.set(k, []);
      for (const e of this.ents.values()) m.get(e.kind)!.push(e);
      this.kindLists = m;
    }
    return this.kindLists.get(kind)!;
  }

  heroList(): Entity[] {
    return this.kindList('hero');
  }

  /** Units that bullets can hit (heroes, troops, NPCs, turrets). */
  hittables(): Entity[] {
    if (!this.hittableList) {
      this.hittableList = [...this.kindList('hero'), ...this.kindList('troop'), ...this.kindList('npc'), ...this.kindList('turret')];
    }
    return this.hittableList;
  }

  unitsWithStatus(id: StatusId): Entity[] {
    return this.hittables().filter((e) => e.alive && findStatus(e, id, this.time));
  }

  heroRt(id: EntityId): HeroRuntime | undefined {
    return this.heroRts.get(id);
  }

  slotOf(playerId: PlayerId): PlayerSlot | undefined {
    return this.slotByPlayer.get(playerId);
  }

  isBotHero(e: Entity): boolean {
    return this.slotByEntity.get(e.id)?.isBot ?? true;
  }

  setExpiry(id: EntityId, at: number): void {
    this.expiries.set(id, at);
  }

  turretAi(id: EntityId): { nextScan: number } {
    let a = this.turretAis.get(id);
    if (!a) {
      a = { nextScan: 0 };
      this.turretAis.set(id, a);
    }
    return a;
  }

  warn(key: string, msg: string): void {
    warnOnce(key, msg);
  }

  private rebuildGrid(): void {
    this.grid.rebuild(this.ents.values());
    this.gridDirty = false;
  }

  /** Positions changed discontinuously (teleports, spawns): rebuild the broadphase before the next query. */
  markGridDirty(): void {
    this.gridDirty = true;
  }

  /** Broadphase, rebuilt lazily after spawns / teleports. */
  unitGrid(): EntityGrid {
    if (this.gridDirty) this.rebuildGrid();
    return this.grid;
  }

  // ── SimHost ─────────────────────────────────────────────────────────────
  /** Optional per-phase timing (ms, accumulated) for profiling; null = off. */
  profile: Record<string, number> | null = null;

  private lap(name: string, t0: number): number {
    const t1 = performance.now();
    if (this.profile) this.profile[name] = (this.profile[name] ?? 0) + (t1 - t0);
    return t1;
  }

  step(): void {
    if (this.resultValue) return;
    this.tick++;
    this.time = this.tick * SIM_DT;
    const dt = SIM_DT;
    this.pathBudget = PATH_BUDGET_PER_TICK;
    this.pathDebt = Math.max(0, this.pathDebt - PATH_ITER_PER_TICK);
    const prof = this.profile !== null;
    let t = prof ? performance.now() : 0;
    this.rebuildGrid();

    // 1. inputs
    this.gatherInputs(dt);
    if (prof) t = this.lap('inputs', t);
    // 2. hero actions (heroList is in spawn order = seat order)
    const heroes = this.heroList();
    for (const e of heroes) this.refreshModifiers(e);
    for (const e of heroes) this.updateHero(e, dt);
    if (prof) t = this.lap('heroes', t);
    // 3. abilities
    for (const e of heroes) if (!e.hero!.dead) this.hooks.tick(e, dt);
    this.rebuildGrid();
    if (prof) t = this.lap('abilities', t);
    // 4. troops / NPCs / turrets
    updateTroops(this, this.kindList('troop'), this.troopBrain, dt);
    if (prof) t = this.lap('troops', t);
    updateNpcs(this, this.kindList('npc'), this.npcBrain, dt);
    if (prof) t = this.lap('npcs', t);
    updateTurrets(this, this.kindList('turret'), dt);
    this.rebuildGrid();
    // 5. projectiles
    updateProjectiles(this, this.kindList('projectile'), dt);
    if (prof) t = this.lap('projectiles', t);
    // 6. hazards
    updateHazards(this, this.kindList('hazard'), dt);
    // scheduled callbacks (ability follow-ups)
    this.runScheduled();
    // 7. statuses
    tickStatuses(this, this.hittables());
    if (prof) t = this.lap('hazards+statuses', t);
    // 8. zone
    this.updateZone();
    // 9. airdrops
    this.updateAirdrops(dt);
    // 10. rules
    tickDowned(this, heroes);
    this.processTimers();
    if (this.winCheckRequested || this.tick % 15 === 0) {
      this.winCheckRequested = false;
      const res = checkWin(this);
      if (res) this.finish(res);
    }
    // 11. sanity + history for lag compensation
    for (const e of this.hittables()) {
      if (!Number.isFinite(e.pos.x + e.pos.y + e.pos.z)) this.recoverPosition(e);
      this.history.record(e, this.tick);
    }
    if (prof) this.lap('rules+history', t);
  }

  /** Safety net: a buggy effect produced a non-finite position — put the unit back where it was. */
  private recoverPosition(e: Entity): void {
    warnOnce(`nan-pos:${e.kind}`, `non-finite position on a ${e.kind}; restored from history`);
    const p = this.history.posAt(e, this.tick - 1, { x: 0, y: 0, z: 0 });
    const base = Number.isFinite(p.x + p.y + p.z) ? p : this.map.lordSpawn;
    const safe = findFreeSpot(this.cw, base, e.radius, e.height, 12);
    e.pos.x = safe.x;
    e.pos.y = safe.y;
    e.pos.z = safe.z;
    e.vel.x = 0;
    e.vel.y = 0;
    e.vel.z = 0;
    e.forced = undefined;
    this.gridDirty = true;
  }

  setInput(playerId: PlayerId, frame: InputFrame): void {
    const slot = this.slotByPlayer.get(playerId);
    if (!slot) return;
    if (frame.seq !== 0 && frame.seq <= slot.lastSeq) return; // stale / duplicate
    slot.lastSeq = Math.max(slot.lastSeq, frame.seq);
    slot.latest = {
      seq: frame.seq,
      moveX: finiteOr(frame.moveX, 0),
      moveZ: finiteOr(frame.moveZ, 0),
      yaw: finiteOr(frame.yaw, slot.latest.yaw),
      pitch: clamp(finiteOr(frame.pitch, 0), -1.45, 1.45),
      buttons: frame.buttons | 0,
      actions: [],
      aimPoint: frame.aimPoint && isFiniteVec(frame.aimPoint) ? { ...frame.aimPoint } : undefined,
      aimTargetId: Number.isInteger(frame.aimTargetId) ? frame.aimTargetId : undefined,
      viewTick: Number.isFinite(frame.viewTick) ? frame.viewTick : undefined,
    };
    const actions = Array.isArray(frame.actions) ? frame.actions : [];
    for (const a of actions) if (a && typeof a === 'object' && slot.queue.length < 64) slot.queue.push(a);
  }

  snapshotFor(playerId: PlayerId): Snapshot {
    return buildSnapshot(this, playerId, this.viewCache);
  }

  drainEvents(): GameEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  result(): GameResult | null {
    return this.resultValue;
  }

  entityOf(playerId: PlayerId): EntityId | null {
    return this.slotByPlayer.get(playerId)?.entityId ?? null;
  }

  convertToBot(playerId: PlayerId): void {
    const slot = this.slotByPlayer.get(playerId);
    if (!slot || slot.isBot) return;
    slot.isBot = true;
    slot.brain = this.makeBot(slot.seat);
    slot.queue = [];
    const e = this.get(slot.entityId);
    if (e?.hero) {
      e.hero.isBot = true;
      try {
        slot.brain.takeOver?.(this, e);
      } catch (err) {
        warnOnce(`bot-takeover:${slot.seat}`, `bot takeOver threw: ${String(err)}`);
      }
    }
    this.viewDirty = true;
  }

  convertToHuman(seat: number, playerId: PlayerId, name: string): void {
    const slot = this.slots.find((s) => s.seat === seat);
    if (!slot) return;
    if (slot.playerId !== playerId) {
      this.slotByPlayer.delete(slot.playerId);
      slot.playerId = playerId;
      this.slotByPlayer.set(playerId, slot);
    }
    slot.name = name;
    slot.isBot = false;
    slot.brain = undefined;
    slot.queue = [];
    slot.lastSeq = -1;
    slot.ackSeq = 0;
    const e = this.get(slot.entityId);
    if (e?.hero) {
      e.hero.isBot = false;
      e.hero.playerId = playerId;
      e.hero.name = name;
      slot.latest = { ...emptyInput(), yaw: e.yaw, pitch: e.pitch };
    }
    this.viewDirty = true;
  }

  private finish(res: GameResult): void {
    this.resultValue = res;
    for (const e of this.heroList()) e.hero!.roleRevealed = true;
    this.viewDirty = true;
    this.emit({ t: 'gameOver', result: res });
    this.announce(res.reasonZh, res.reasonEn, 'big');
  }

  requestWinCheck(): void {
    this.winCheckRequested = true;
  }

  // ── inputs ──────────────────────────────────────────────────────────────
  private gatherInputs(dt: number): void {
    for (const slot of this.slots) {
      const e = this.get(slot.entityId);
      const rt = this.heroRts.get(slot.entityId);
      if (!e?.hero || !rt) continue;
      let frame: InputFrame;
      let actions: InputAction[];
      if (slot.isBot) {
        if (!slot.brain) slot.brain = this.makeBot(slot.seat);
        if (e.hero.dead) {
          frame = { ...EMPTY_INPUT, yaw: e.yaw, actions: [] };
        } else {
          try {
            frame = slot.brain.think(this, e, dt);
          } catch (err) {
            warnOnce(`bot:${slot.seat}`, `bot brain threw: ${String(err)}`);
            frame = { ...EMPTY_INPUT, yaw: e.yaw, actions: [] };
          }
        }
        actions = frame.actions ?? [];
      } else {
        frame = slot.latest;
        actions = slot.queue.length > MAX_ACTIONS_PER_TICK ? slot.queue.splice(0, MAX_ACTIONS_PER_TICK) : slot.queue.splice(0);
        slot.ackSeq = slot.latest.seq;
      }
      // charm: forced to attack the charm target (aim dragged + auto-fire)
      const charm = findStatus(e, 'charm', this.time);
      if (charm && !e.hero.dead && !e.hero.downed) {
        const tgt = this.get(charm.params?.targetId);
        if (tgt && tgt.alive && !tgt.hero?.dead) {
          const c = this.centerOf(tgt);
          const ang = aimAnglesFor(e.pos, c);
          const d = Math.hypot(tgt.pos.x - e.pos.x, tgt.pos.z - e.pos.z);
          frame = {
            ...frame,
            yaw: ang.yaw,
            pitch: ang.pitch,
            moveX: 0,
            moveZ: d > 12 ? 1 : 0,
            buttons: (frame.buttons & ~BTN_ADS) | BTN_FIRE,
            aimPoint: c,
            aimTargetId: tgt.id,
          };
          actions = actions.filter((a) => a.a === 'claim' || a.a === 'quickchat' || a.a === 'reload');
        }
      }
      rt.input = frame;
      rt.actions = actions;
    }
  }

  // ── heroes ──────────────────────────────────────────────────────────────
  private refreshModifiers(e: Entity): void {
    const rt = this.heroRts.get(e.id);
    const h = e.hero;
    if (!rt || !h) return;
    rt.mods = this.hooks.modifiers(e);
    // dynamic max HP bonus (血裔)
    const bonus = h.dead ? rt.appliedHpBonus : rt.mods.maxHpBonus;
    if (bonus !== rt.appliedHpBonus) {
      const delta = bonus - rt.appliedHpBonus;
      rt.appliedHpBonus = bonus;
      e.maxHp = Math.max(1, rt.baseMaxHp + bonus);
      if (!h.downed && !h.dead) e.hp = clamp(e.hp + Math.max(0, delta), 1, e.maxHp);
    }
  }

  private updateHero(e: Entity, dt: number): void {
    const h = e.hero!;
    const rt = this.heroRts.get(e.id)!;
    const now = this.time;
    if (h.dead) {
      rt.actions = [];
      e.vel.x = 0;
      e.vel.z = 0;
      return;
    }
    const input = rt.input;
    const cs = controlState(e, now, this.cs);

    // edge actions
    let jump = false;
    for (const a of rt.actions) {
      if (a.a === 'jump') jump = true;
      else this.processAction(e, rt, a, cs);
      if (h.dead) return;
    }
    rt.actions = [];

    // charges / dodge recharge
    this.rechargeAbilities(e, rt);
    const maxDodge = BASE_DODGE_CHARGES + rt.mods.extraDodgeCharges;
    if (h.dodgeCharges < maxDodge) {
      if (h.dodgeRechargeAt <= 0) h.dodgeRechargeAt = now + DODGE_RECHARGE * rt.mods.dodgeRechargeMul;
      else if (now >= h.dodgeRechargeAt) {
        h.dodgeCharges++;
        h.dodgeRechargeAt = h.dodgeCharges < maxDodge ? now + DODGE_RECHARGE * rt.mods.dodgeRechargeMul : 0;
      }
    } else {
      h.dodgeRechargeAt = 0;
    }

    tickReload(this, e);

    // movement. Sprint vs ADS is decided inside predictMove from the raw
    // BTN_ADS + mods only (holding ADS cancels sprint unless sprintAds), exactly
    // as the client predicts it — never from host-only state such as last
    // tick's sprint flag.
    const wantAds = (input.buttons & BTN_ADS) !== 0;
    const st = rt.move;
    st.pos = e.pos;
    st.vel = e.vel;
    st.onGround = e.onGround;
    if (e.forced && now < e.forced.until) {
      forcedMove(this.cw, st, e.forced.vel.x, e.forced.vel.z, dt, e.radius, e.height);
      e.onGround = st.onGround;
      h.sprinting = false;
    } else {
      if (e.forced) {
        // forced movement over: stop at walking speed instead of sliding on (SHU-1);
        // net/clientView brakes on the same tick (you.forced remaining 0 = brake pending)
        e.forced = undefined;
        brakeForcedEnd(e.vel, WALK_SPEED);
      }
      const mm = this.heroMoveMods(e, rt, cs, wantAds);
      const mv = jump ? { ...input, actions: [{ a: 'jump' } as InputAction] } : input;
      predictMove(this.cw, st, mv, dt, mm);
      e.onGround = st.onGround;
      h.sprinting = st.sprinting === true;
      rt.lastMoveMods = { speedMul: mm.speedMul, canSprint: mm.canSprint, canJump: mm.canJump, rooted: mm.rooted, sprintAds: mm.sprintAds === true };
    }
    rt.movedTick = this.tick;
    // aiming state (spread, VF_ADS): same precedence rule as predictMove
    h.ads = wantAds && !h.downed && !cs.stunned && !cs.dancing && (!h.sprinting || rt.mods.sprintAds);
    if (!cs.stunned) {
      e.yaw = finiteOr(input.yaw, e.yaw);
      e.pitch = clamp(finiteOr(input.pitch, 0), -1.45, 1.45);
    }

    // firing
    const canShoot = !h.downed && !cs.stunned && !cs.disarmed && !cs.dancing;
    heroFire(this, e, rt, input, canShoot);
    if (h.dead) return;

    // channels, pickups
    inv.updateChannel(this, e, rt, cs);
    if (!h.downed) inv.autoPickup(this, e);
    // equipment-loss hook
    if (rt.lastArmor && h.armor !== rt.lastArmor) this.hooks.onEquipmentLost(e, 'armor', rt.lastArmor);
    if (rt.lastMount && h.mount !== rt.lastMount) this.hooks.onEquipmentLost(e, 'mount', rt.lastMount);
    rt.lastArmor = h.armor;
    rt.lastMount = h.mount;
  }

  private heroMoveMods(e: Entity, rt: HeroRuntime, cs: ControlState, wantAds: boolean): MoveMods {
    const h = e.hero!;
    const wi = h.weapons[h.activeSlot];
    const wdef = wi ? weaponDef(wi.id) : undefined;
    let speed = rt.def.speedMul * (wdef?.moveSpeedMul ?? 1) * statusSpeedMul(e, this.time) * rt.mods.speedMul * this.hooks.speedMul(e);
    const mount = mountDef(h.mount);
    if (mount) speed *= mount.speedMul;
    if (h.channel) speed *= 0.5;
    const m = this.moveMods;
    m.speedMul = speed;
    m.canSprint = !cs.frozen && !h.channel && !h.downed && !cs.dancing;
    m.canJump = !cs.frozen && !h.downed && !cs.dancing;
    m.rooted = cs.stunned || cs.rooted;
    m.ads = wantAds; // raw button, as the client passes it (see updateHero)
    m.downed = h.downed;
    m.sprintAds = rt.mods.sprintAds;
    return m;
  }

  private rechargeAbilities(e: Entity, rt: HeroRuntime): void {
    const h = e.hero!;
    for (const a of rt.abilities) {
      const max = a.def.charges;
      if (!max) continue;
      const cur = h.charges[a.def.id] ?? max;
      if (cur >= max) continue;
      const cd = this.cooldownFor(rt, a.def);
      const at = h.cooldowns[a.def.id] ?? 0;
      if (at <= 0) h.cooldowns[a.def.id] = this.time + cd;
      else if (this.time >= at) {
        h.charges[a.def.id] = cur + 1;
        h.cooldowns[a.def.id] = cur + 1 < max ? this.time + cd : 0;
      }
    }
  }

  private cooldownFor(rt: HeroRuntime, def: AbilityDef): number {
    return Math.max(0, (def.cooldown ?? 0) * rt.mods.cooldownMul);
  }

  private processAction(e: Entity, rt: HeroRuntime, a: InputAction, cs: ControlState): void {
    const h = e.hero!;
    // communication works in any state
    switch (a.a) {
      case 'claim':
        if (a.role && ROLE_BY_ID[a.role] && a.role !== h.claim) {
          h.claim = a.role;
          this.emit({ t: 'claim', who: e.id, role: a.role });
        }
        return;
      case 'quickchat':
        if (typeof a.id === 'string' && a.id.length <= 32) this.emit({ t: 'quickchat', who: e.id, id: a.id });
        return;
      case 'command':
        if (!h.downed) this.commandSquad(e, a.order);
        return;
      case 'mark':
        if (!h.downed) this.markTarget(e, rt);
        return;
      default:
        break;
    }
    if (h.downed) {
      if (a.a === 'item') inv.useItemSlot(this, e, rt, a.slot, cs);
      return;
    }
    if (cs.stunned) return;
    switch (a.a) {
      case 'dodge':
        this.dodge(e, rt, cs);
        break;
      case 'reload':
        startReload(this, e);
        break;
      case 'ability':
        this.activateAbility(e, rt, a.slot, cs);
        break;
      case 'interact':
        inv.interact(this, e, rt);
        break;
      case 'weapon':
        this.switchWeapon(e, a.slot);
        break;
      case 'item':
        inv.useItemSlot(this, e, rt, a.slot, cs);
        break;
      case 'drop':
        inv.dropSlot(this, e, a.slot, a.what);
        break;
      default:
        break;
    }
  }

  private dodge(e: Entity, rt: HeroRuntime, cs: ControlState): void {
    const h = e.hero!;
    if (h.dodgeCharges <= 0 || cs.rooted || cs.frozen || (e.forced && this.time < e.forced.until)) return;
    const input = rt.input;
    const sy = Math.sin(input.yaw);
    const cy = Math.cos(input.yaw);
    let dx = -sy * input.moveZ + cy * input.moveX;
    let dz = -cy * input.moveZ - sy * input.moveX;
    if (Math.hypot(dx, dz) < 0.1) {
      dx = sy; // backwards
      dz = cy;
    }
    this.cancelChannel(e.id);
    this.dash(e.id, { x: dx, y: 0, z: dz }, DODGE_DISTANCE, DODGE_TIME, { invuln: true });
    h.dodgingUntil = this.time + DODGE_TIME;
    h.dodgeCharges--;
    if (h.dodgeRechargeAt <= 0) h.dodgeRechargeAt = this.time + DODGE_RECHARGE * rt.mods.dodgeRechargeMul;
    this.hooks.onDodge(e);
  }

  private activateAbility(e: Entity, rt: HeroRuntime, slot: AbilitySlot, cs: ControlState): void {
    const h = e.hero!;
    const entry = rt.abilities.find((a) => a.def.slot === slot);
    if (!entry) return;
    const id = entry.def.id;
    if (cs.silenced || cs.dancing) {
      // an active pressed while silenced / dancing: tell the (human) caster why nothing happened
      if (entry.impl?.activate) this.abilityDenied(e, id, 'silenced');
      return;
    }
    if (!entry.impl?.activate) {
      if (!isPassiveAbility(entry.def)) warnOnce(`ability-activate:${id}`, `ability '${id}' has no activate() implementation`);
      return;
    }
    if (entry.def.charges) {
      if ((h.charges[id] ?? 0) <= 0) return;
    } else if ((h.cooldowns[id] ?? 0) > this.time) {
      return;
    }
    const before = h.cooldowns[id];
    const ctx: AbilityCtx & { cast?: AbilityCast } = this.abilityCtx(e, entry.def);
    const impl = entry.impl;
    // decided before the cast: casting 白衣渡江 from plain sight stays public (the puff where he vanished)
    const hidden = findStatus(e, 'stealth', this.time) !== undefined && !revealedTo(e, undefined, this.time);
    let ok = false;
    const prevActor = this.actorId;
    this.actorId = e.id;
    try {
      ok = impl.activate!(ctx) === true;
    } catch (err) {
      warnOnce(`ability-throw:${id}`, `ability '${id}' activate threw: ${String(err)}`);
      ok = false;
    } finally {
      this.actorId = prevActor;
    }
    if (!ok) {
      // the press did nothing (no target, nobody for the second half, blocked…): the cooldown
      // is kept, and a human caster gets a private cue saying why (APP-5)
      this.abilityDenied(e, id, ctx.deniedReason);
      return;
    }
    const cd = this.cooldownFor(rt, entry.def);
    if (entry.def.charges) {
      h.charges[id] = Math.max(0, (h.charges[id] ?? 1) - 1);
      if ((h.cooldowns[id] ?? 0) <= this.time) h.cooldowns[id] = this.time + cd;
    } else if (h.cooldowns[id] === before) {
      h.cooldowns[id] = this.time + cd;
    }
    // where the cast really happened (ctx.cast, SHU-3): copied verbatim, defaults for the rest
    const c = ctx.cast;
    const ev: GameEvent = {
      t: 'ability',
      src: e.id,
      ability: id,
      pos: c?.pos ? { x: c.pos.x, y: c.pos.y, z: c.pos.z } : this.aimPoint(e, 60),
      target: c?.target ?? rt.input.aimTargetId,
      dir: c?.dir ? { x: c.dir.x, y: c.dir.y, z: c.dir.z } : this.aimRay(e).dir,
    };
    // a stealthed caster's cast must not give its position away (WU-2)
    this.emit(hidden ? { ...ev, privateTo: e.id } : ev);
  }

  /** Private "that did nothing" cue for a human caster ({ t:'sfx', name:'abilityDenied' }); bots get none. */
  private abilityDenied(e: Entity, ability: string, reason: DeniedReason | undefined): void {
    if (this.isBotHero(e)) return;
    const ev: GameEvent = { t: 'sfx', name: 'abilityDenied', pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, privateTo: e.id, ability };
    if (reason) ev.reason = reason;
    this.emit(ev);
  }

  private switchWeapon(e: Entity, slot: number): void {
    const h = e.hero!;
    if (slot < 0 || slot >= h.weapons.length || !h.weapons[slot] || slot === h.activeSlot) return;
    h.activeSlot = slot;
    h.reloadUntil = 0;
    h.burst = 0;
    h.nextFireAt = Math.max(h.nextFireAt, this.time + WEAPON_SWAP_TIME);
  }

  // ── inventory (see inventory.ts) ────────────────────────────────────────
  /** add to an existing stack or the first free slot; false when full */
  giveItem(heroId: EntityId, itemId: string, count = 1): boolean {
    return inv.giveItem(this, heroId, itemId, count);
  }

  /** giveItem, or drop at the hero's feet when the slots are full. */
  giveOrDrop(e: Entity, itemId: string): void {
    inv.giveOrDrop(this, e, itemId);
  }

  rollRewardItems(n: number, minRarity?: 'common' | 'rare' | 'epic' | 'legendary'): string[] {
    return inv.rollRewardItems(this, n, minRarity);
  }

  takeRandomItem(heroId: EntityId, includeEquipment = false): string | null {
    return inv.takeRandomItem(this, heroId, includeEquipment);
  }

  stealItem(thiefId: EntityId, victimId: EntityId, includeEquipment = false): string | null {
    return inv.stealItem(this, thiefId, victimId, includeEquipment);
  }

  giveWeapon(heroId: EntityId, weaponId: string): void {
    inv.giveWeapon(this, heroId, weaponId);
  }

  refillAmmo(heroId: EntityId, fractionOfMax: number): void {
    inv.refillAmmo(this, heroId, fractionOfMax);
  }

  refillMag(heroId: EntityId, slot?: number): void {
    inv.refillMag(this, heroId, slot);
  }

  equip(heroId: EntityId, armorOrMountId: string): void {
    inv.equip(this, heroId, armorOrMountId);
  }

  /** Change armor, applying 白银狮子's heal-on-removal. */
  setArmor(heroId: EntityId, id: string | null): void {
    inv.setArmor(this, heroId, id);
  }

  /** SimExt.dismount: with opts.sourceId an enemy's strip is gated by 无懈可击 (WU-4). */
  dismount(heroId: EntityId, opts?: StripOptions): boolean {
    return inv.dismount(this, heroId, opts);
  }

  /** SimExt.stripArmor: with opts.sourceId an enemy's strip is gated by 无懈可击 (WU-4). */
  stripArmor(heroId: EntityId, drop = true, opts?: StripOptions): boolean {
    return inv.stripArmor(this, heroId, drop, opts);
  }

  /** 主公误杀忠臣: drop every item, armor, mount and the secondary weapon. */
  dropEverything(e: Entity): string[] {
    return inv.dropEverything(this, e);
  }

  cancelChannel(heroId: EntityId): void {
    const e = this.get(heroId);
    if (e?.hero?.channel) {
      e.hero.channel = null;
      const rt = this.heroRts.get(heroId);
      if (rt) rt.channelItem = undefined;
    }
  }

  // ── squad ───────────────────────────────────────────────────────────────
  private commandSquad(e: Entity, kind: SquadOrderKind): void {
    let order: SquadOrder;
    switch (kind) {
      case 'hold':
        order = { kind, point: this.aimPoint(e, 60) };
        break;
      case 'attack': {
        const t = this.aimTarget(e, 90, { kinds: UNIT_KINDS, notFriendlyTo: e.id });
        order = t ? { kind, targetId: t.id, point: { ...t.pos } } : { kind, point: this.aimPoint(e, 90) };
        break;
      }
      case 'charge':
        order = { kind };
        break;
      default:
        order = { kind: 'follow' };
        break;
    }
    this.setSquadOrder(e.id, order);
  }

  private markTarget(e: Entity, rt: HeroRuntime): void {
    const t = this.aimTarget(e, 150, { kinds: UNIT_KINDS, notFriendlyTo: e.id });
    if (!t) return;
    if (rt.markId !== undefined && rt.markId !== t.id) {
      const old = this.get(rt.markId);
      if (old) removeStatusFrom(this, old, 'marked', e.id);
    }
    rt.markId = t.id;
    // a squad mark is information, not a hostile effect: bypass nullify / vetoes.
    // One mark per commander (several commanders can mark the same unit).
    const now = this.time;
    const mine = t.statuses.find((s) => s.id === 'marked' && s.sourceId === e.id && s.until > now);
    if (mine) {
      mine.until = now + MARK_TIME;
    } else {
      const had = findStatus(t, 'marked', now) !== undefined;
      t.statuses.push({ id: 'marked', until: now + MARK_TIME, sourceId: e.id, stacks: 1 });
      if (!had) this.emit({ t: 'status', target: t.id, status: 'marked', on: true });
    }
  }

  setSquadOrder(heroId: EntityId, order: SquadOrder): void {
    const e = this.get(heroId);
    if (!e?.hero) return;
    e.hero.order = { ...order };
    this.emit({ t: 'command', who: heroId, order: order.kind, point: order.point, target: order.targetId });
  }

  // ── zone / airdrops / timers ────────────────────────────────────────────
  private updateZone(): void {
    if (this.opts.zone === false) return;
    const ch = this.zone.update(this.time);
    if (ch) {
      this.emit({ t: 'zone', phase: ch.phase, center: ch.center, radius: ch.radius, targetRadius: ch.targetRadius, shrinkStart: ch.shrinkStart, shrinkEnd: ch.shrinkEnd });
      const secs = Math.max(0, Math.round(ch.shrinkStart - this.time));
      if (this.zone.capped) this.announce('烽火燎原，决战时刻！', 'The beacon fire consumes everything — final showdown!', 'big');
      else if (secs > 0) this.announce(`烽火圈将在 ${secs} 秒后收缩`, `The beacon ring closes in ${secs} s`, 'warn');
      else this.announce('烽火圈正在收缩！', 'The beacon ring is closing!', 'warn');
    }
    if (this.time + 1e-9 < this.zoneDamageAt) return;
    this.zoneDamageAt += ZONE_DAMAGE_PERIOD;
    const dps = this.zone.dps;
    if (dps <= 0) return;
    for (const u of this.hittables()) {
      if (!u.alive || u.hero?.dead || u.kind === 'turret') continue;
      if (this.zone.isOutside(u.pos)) {
        this.dealDamage({ targetId: u.id, amount: dps * ZONE_DAMAGE_PERIOD, type: 'zone', canDodge: false, noReflect: true, pos: this.centerOf(u) });
      }
    }
  }

  private updateAirdrops(dt: number): void {
    if (this.opts.airdrops !== false && this.airdropSchedule.due(this.time)) this.spawnAirdrop();
    for (const a of this.kindList('airdrop')) {
      if (a.onGround) continue;
      const g = groundAt(this.cw, a.pos.x, a.pos.z, a.pos.y);
      a.pos.y += a.vel.y * dt;
      if (a.pos.y <= g) {
        a.pos.y = g;
        a.vel.y = 0;
        a.onGround = true;
        this.emit({ t: 'sfx', name: 'airdropLand', pos: { ...a.pos } });
      }
    }
  }

  /**
   * Where the next airdrop lands: open dry ground (no roof, tree, statue or
   * deck over the crate) inside the next zone when possible, so the best loot
   * is always reachable on foot.
   */
  airdropSpot(center: Vec3, radius: number): Vec3 {
    const margin = AIRDROP_EDGE_MARGIN;
    const lim = this.map.size / 2 - margin;
    const cx = clamp(center.x, -lim, lim);
    const cz = clamp(center.z, -lim, lim);
    const rand = (): number => this.rng.next();
    const nav = this.nav;
    // with a nav grid, also require a node of the main (reachable) component: no sealed courtyards
    const reachable = nav
      ? (p: Vec3): boolean => {
          const n = locateNode(nav, p, 1.2);
          return n >= 0 && (nav.flags[n] & NAV_MAIN) !== 0;
        }
      : undefined;
    const o = { radius: AIRDROP_RADIUS + 0.2, margin };
    const spot = findOpenGround(this.cw, cx, cz, Math.max(0, radius * 0.8), rand, { ...o, accept: reachable }) ?? findOpenGround(this.cw, cx, cz, Math.max(0, radius * 0.8), rand, o);
    if (spot) return spot;
    warnOnce('airdrop-spot', 'no open ground for an airdrop; dropping at the nearest free spot');
    return findFreeSpot(this.cw, { x: cx, y: groundAt(this.cw, cx, cz), z: cz }, AIRDROP_RADIUS, 1.2, 30);
  }

  private spawnAirdrop(): void {
    const z = this.zone.view();
    const pos = this.airdropSpot(z.targetCenter, z.targetRadius);
    const e = this.createEntity('airdrop', { x: pos.x, y: pos.y + AIRDROP_HEIGHT, z: pos.z }, { radius: AIRDROP_RADIUS, height: 1.2, hp: 1 });
    e.vel.y = -AIRDROP_HEIGHT / AIRDROP_FALL_TIME;
    e.onGround = false;
    e.crate = { tier: 3, opened: false };
    this.emit({ t: 'airdrop', pos: { ...pos }, id: e.id });
    this.announce('天降锦囊！空投正在降落', 'A heavenly supply drop is falling!', 'info');
  }

  private processTimers(): void {
    const now = this.time;
    for (const [id, at] of this.expiries) {
      if (now < at) continue;
      this.expiries.delete(id);
      const e = this.get(id);
      if (e && e.alive) {
        if (e.kind === 'troop') this.killUnit(e, undefined, true);
        else this.removeEntity(id);
      }
    }
    for (const [id, at] of this.removals) {
      if (now >= at) {
        this.removals.delete(id);
        this.removeEntity(id);
      }
    }
    // prune attack memory occasionally
    if (this.tick % 150 === 0) {
      for (const [victim, m] of this.attackLog) {
        for (const [att, t] of m) if (now - t > ATTACK_MEMORY) m.delete(att);
        if (m.size === 0) this.attackLog.delete(victim);
      }
      for (const [id, st] of this.freezeStacks) if (now > st.until && now > st.immuneUntil) this.freezeStacks.delete(id);
      for (const [id, echo] of this.nullifyEcho) if (echo.tick < this.tick) this.nullifyEcho.delete(id);
    }
  }

  private runScheduled(): void {
    if (this.scheduled.length === 0) return;
    const now = this.time + 1e-9;
    const due = this.scheduled.filter((s) => s.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (due.length === 0) return;
    this.scheduled = this.scheduled.filter((s) => s.at > now);
    for (const s of due) {
      const prev = this.actorId;
      this.actorId = s.actor;
      try {
        s.fn();
      } catch (err) {
        warnOnce(`sched:${String(err)}`, `scheduled callback threw: ${String(err)}`);
      } finally {
        this.actorId = prev;
      }
    }
  }

  // ── death of non-hero units ─────────────────────────────────────────────
  killUnit(e: Entity, creditId: EntityId | undefined, silent = false, sourceId?: EntityId): void {
    if (!e.alive) return;
    e.alive = false;
    e.hp = 0;
    e.vel.x = 0;
    e.vel.z = 0;
    e.forced = undefined;
    clearStatuses(e);
    this.viewDirty = true;
    if (!silent) this.emit({ t: 'death', target: e.id, killer: creditId, kind: e.kind });
    if (e.troop) {
      const cmd = this.get(e.troop.commanderId);
      if (cmd?.hero) cmd.hero.squad = cmd.hero.squad.filter((id) => id !== e.id);
    }
    const killer = creditId !== undefined ? this.get(creditId) : undefined;
    if (killer?.hero && !silent && this.isDirectSource(sourceId, killer)) this.hooks.onKill(killer, e);
    this.removals.set(e.id, this.time + (silent ? 0 : 2));
  }

  /**
   * Was the damage dealt by the hero "personally" (itself, its projectiles,
   * hazards or turrets) rather than by its troops / summons?
   */
  isDirectSource(sourceId: EntityId | undefined, hero: Entity): boolean {
    if (sourceId === undefined || sourceId === hero.id) return true;
    const src = this.get(sourceId);
    if (!src) return true;
    return src.kind !== 'troop' && src.kind !== 'npc';
  }

  downHero(e: Entity, creditId: EntityId | undefined, sourceId?: EntityId): void {
    downHero(this, e, creditId, sourceId);
  }

  killHero(e: Entity, creditId: EntityId | undefined, sourceId?: EntityId): void {
    killHero(this, e, creditId, sourceId);
  }

  onShotBlocked(src: Entity, req: DamageRequest, blocked: NonNullable<DamageResult['blocked']>): void {
    if (!req.weaponId || !src.hero) return;
    const def = weaponDef(req.weaponId);
    if (def.special !== 'followUp' || (blocked !== 'dodge' && blocked !== 'armor' && blocked !== 'shield')) return;
    const rt = this.heroRts.get(src.id);
    if (!rt) return;
    const wi = src.hero.weapons.find((x) => x?.id === req.weaponId);
    if (wi && (def.specialParams.refund ?? 1) > 0 && wi.mag < def.magSize) wi.mag++;
    rt.followUpMul = def.specialParams.nextMul ?? 1.5;
    rt.followUpUntil = this.time + (def.specialParams.window ?? 2);
  }

  recordAttack(victimId: EntityId, creditId: EntityId, sourceId?: EntityId): void {
    let m = this.attackLog.get(victimId);
    if (!m) {
      m = new Map();
      this.attackLog.set(victimId, m);
    }
    m.set(creditId, this.time);
    if (sourceId !== undefined && sourceId !== creditId) m.set(sourceId, this.time);
  }

  /** Drop what `a` and `b` remember of hurting each other (a charm's forced fight ended). */
  forgetAttacks(a: EntityId, b: EntityId): void {
    this.attackLog.get(a)?.delete(b);
    this.attackLog.get(b)?.delete(a);
  }

  /** did `attackerId` damage `victimId` within the memory window? */
  attackedRecently(victimId: EntityId, attackerId: EntityId, window = ATTACK_MEMORY): boolean {
    const t = this.attackLog.get(victimId)?.get(attackerId);
    return t !== undefined && this.time - t <= window;
  }

  recentAttackers(id: EntityId, window = ATTACK_MEMORY): EntityId[] {
    const m = this.attackLog.get(id);
    if (!m) return [];
    const out: EntityId[] = [];
    for (const [att, t] of m) if (this.time - t <= window) out.push(att);
    return out;
  }

  sinceDamaged(id: EntityId): number {
    const e = this.get(id);
    return e?.lastDamagedAt !== undefined ? this.time - e.lastDamagedAt : Infinity;
  }

  // ── SimApi: queries ─────────────────────────────────────────────────────
  get(id: EntityId | undefined): Entity | undefined {
    return id === undefined ? undefined : this.ents.get(id);
  }

  entities(): Iterable<Entity> {
    return this.ents.values();
  }

  heroes(): Entity[] {
    return this.heroList();
  }

  heroDef(e: Entity): HeroDef | undefined {
    return e.hero ? (this.heroRts.get(e.id)?.def ?? heroDef(e.hero.heroId)) : undefined;
  }

  inputOf(e: Entity): InputFrame {
    return this.heroRts.get(e.id)?.input ?? EMPTY_INPUT;
  }

  private passes(e: Entity, f: QueryFilter | undefined): boolean {
    if (!f) return e.alive && !e.hero?.dead;
    if (f.aliveOnly !== false && (!e.alive || e.hero?.dead)) return false;
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f.exclude && f.exclude.includes(e.id)) return false;
    if (f.notFriendlyTo !== undefined) {
      const c = this.get(f.notFriendlyTo);
      if (e.id === f.notFriendlyTo) return false;
      if (c && this.isOwnSide(c, e)) return false;
    }
    return true;
  }

  queryRadius(pos: Vec3, r: number, filter?: QueryFilter): Entity[] {
    const out: Entity[] = [];
    if (!(r >= 0)) return out;
    this.unitGrid().forEachNear(pos.x, pos.z, r + 3, (e) => {
      if (!this.passes(e, filter)) return;
      const dx = e.pos.x - pos.x;
      const dz = e.pos.z - pos.z;
      if (Math.hypot(dx, dz) - e.radius > r) return;
      if (e.pos.y + e.height < pos.y - r || e.pos.y > pos.y + r) return;
      out.push(e);
    });
    return out;
  }

  queryCone(pos: Vec3, dir: Vec3, range: number, halfAngle: number, filter?: QueryFilter): Entity[] {
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / dl;
    const dy = dir.y / dl;
    const dz = dir.z / dl;
    const out: Entity[] = [];
    for (const e of this.queryRadius(pos, range, filter)) {
      const cx = e.pos.x - pos.x;
      const cy = e.pos.y + e.height * 0.5 - pos.y;
      const cz = e.pos.z - pos.z;
      const d = Math.hypot(cx, cy, cz);
      if (d < e.radius + 0.3) {
        out.push(e);
        continue;
      }
      // horizontal angle for flat cones, 3D otherwise
      const flat = Math.abs(dy) < 1e-3;
      const len = flat ? Math.hypot(cx, cz) : d;
      const dot = flat ? (cx * dx + cz * dz) / (len || 1) : (cx * dx + cy * dy + cz * dz) / (len || 1);
      const ang = Math.acos(clamp(dot, -1, 1)) - Math.atan2(e.radius, len);
      if (ang <= halfAngle) out.push(e);
    }
    return out;
  }

  raycast(from: Vec3, dir: Vec3, maxDist: number, opts?: { ignore?: EntityId[]; entities?: boolean }): RayHit | null {
    const ignore = opts?.ignore;
    return raycastAll(this, from, dir, maxDist, ignore && ignore.length ? (e) => ignore.includes(e.id) : null, opts?.entities !== false);
  }

  lineOfSight(a: Vec3, b: Vec3): boolean {
    return staticLos(this.cw, a, b);
  }

  groundHeight(x: number, z: number): number {
    return groundAt(this.cw, x, z);
  }

  eyePos(e: Entity): Vec3 {
    const h = e.hero?.downed ? 0.5 : e.height * 0.9;
    return { x: e.pos.x, y: e.pos.y + h, z: e.pos.z };
  }

  centerOf(e: Entity): Vec3 {
    const h = e.hero?.downed ? 0.3 : e.height * 0.55;
    return { x: e.pos.x, y: e.pos.y + h, z: e.pos.z };
  }

  aimRay(e: Entity): { origin: Vec3; dir: Vec3 } {
    const input = this.inputOf(e);
    const rig = cameraRig(e.pos, finiteOr(input.yaw, e.yaw), finiteOr(input.pitch, e.pitch), e.hero?.downed === true);
    return { origin: rig.origin, dir: rig.dir };
  }

  /** Tick to rewind other entities to when resolving this human's shots. */
  rewindTickFor(e: Entity): number | undefined {
    const vt = this.inputOf(e).viewTick;
    if (vt === undefined || !Number.isFinite(vt)) return undefined;
    return Math.round(clamp(vt, this.tick - LAG_COMP_MAX_TICKS, this.tick));
  }

  /** Crosshair point (validated client aimPoint, or reconstructed third-person ray). */
  crosshairPoint(e: Entity, maxDist: number): Vec3 {
    return this.crosshair(e, maxDist).point;
  }

  /**
   * Crosshair point and whether it lies on something (false: the ray ran out
   * in the air — sky, over a ridge — and the point was clamped to maxDist).
   */
  private crosshair(e: Entity, maxDist: number): { point: Vec3; onSurface: boolean } {
    const input = this.inputOf(e);
    const rig = cameraRig(e.pos, finiteOr(input.yaw, e.yaw), finiteOr(input.pitch, e.pitch), e.hero?.downed === true);
    const eye = this.eyePos(e);
    const ap = input.aimPoint;
    if (ap && isFiniteVec(ap)) {
      const bot = this.isBotHero(e);
      const vx = ap.x - rig.origin.x;
      const vy = ap.y - rig.origin.y;
      const vz = ap.z - rig.origin.z;
      const vl = Math.hypot(vx, vy, vz);
      const cos = vl > 1e-3 ? (vx * rig.dir.x + vy * rig.dir.y + vz * rig.dir.z) / vl : 1;
      if (bot || cos >= Math.cos((4 * Math.PI) / 180)) {
        const dx = ap.x - eye.x;
        const dy = ap.y - eye.y;
        const dz = ap.z - eye.z;
        const dl = Math.hypot(dx, dy, dz);
        if (dl <= maxDist) return { point: { x: ap.x, y: ap.y, z: ap.z }, onSurface: true };
        return { point: { x: eye.x + (dx / dl) * maxDist, y: eye.y + (dy / dl) * maxDist, z: eye.z + (dz / dl) * maxDist }, onSurface: false };
      }
    }
    const start = {
      x: rig.origin.x + rig.dir.x * rig.nearClip,
      y: rig.origin.y + rig.dir.y * rig.nearClip,
      z: rig.origin.z + rig.dir.z * rig.nearClip,
    };
    const rewind = this.isBotHero(e) ? undefined : this.rewindTickFor(e);
    const hit = raycastAll(this, start, rig.dir, maxDist, (x) => x === e || this.creditOf(x.id) === e.id, true, rewind);
    if (hit) return { point: hit.point, onSurface: true };
    return { point: { x: start.x + rig.dir.x * maxDist, y: start.y + rig.dir.y * maxDist, z: start.z + rig.dir.z * maxDist }, onSurface: false };
  }

  /**
   * SimApi.aimPoint for abilities: the crosshair point within maxDist of the
   * hero. When the crosshair ray hits nothing (sky, over a ridge) or is clamped
   * horizontally, the point is dropped onto the ground below it, so
   * point-targeted effects never happen in mid-air.
   */
  aimPoint(e: Entity, maxDist: number): Vec3 {
    const c = this.crosshair(e, maxDist);
    const p = c.point;
    // clamp to maxDist from the hero
    const dx = p.x - e.pos.x;
    const dz = p.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDist && d > 1e-6) {
      const x = e.pos.x + (dx / d) * maxDist;
      const z = e.pos.z + (dz / d) * maxDist;
      return { x, y: groundAt(this.cw, x, z, p.y + 2), z };
    }
    if (!c.onSurface) return { x: p.x, y: groundAt(this.cw, p.x, p.z, p.y), z: p.z };
    return p;
  }

  aimTarget(e: Entity, maxDist: number, filter?: QueryFilter): Entity | undefined {
    const input = this.inputOf(e);
    const eye = this.eyePos(e);
    const rig = cameraRig(e.pos, finiteOr(input.yaw, e.yaw), finiteOr(input.pitch, e.pitch), e.hero?.downed === true);
    const f: QueryFilter = { ...(filter ?? {}), exclude: [...(filter?.exclude ?? []), e.id] };
    const ok = (t: Entity): boolean => this.passes(t, f) && !findStatus(t, 'untargetable', this.time) && this.canSee(e, t);
    const angleTo = (t: Entity): number => {
      const c = this.centerOf(t);
      const vx = c.x - rig.origin.x;
      const vy = c.y - rig.origin.y;
      const vz = c.z - rig.origin.z;
      const vl = Math.hypot(vx, vy, vz) || 1;
      return Math.acos(clamp((vx * rig.dir.x + vy * rig.dir.y + vz * rig.dir.z) / vl, -1, 1));
    };
    // 1. client-reported target, validated
    if (input.aimTargetId !== undefined) {
      const t = this.get(input.aimTargetId);
      if (t && ok(t) && dist3(t.pos, eye) <= maxDist + t.radius && (this.isBotHero(e) || angleTo(t) <= (14 * Math.PI) / 180)) {
        if (this.lineOfSight(eye, this.centerOf(t)) || this.lineOfSight(eye, this.eyePos(t))) return t;
      }
    }
    // 2. entity directly under the crosshair
    const start = {
      x: rig.origin.x + rig.dir.x * rig.nearClip,
      y: rig.origin.y + rig.dir.y * rig.nearClip,
      z: rig.origin.z + rig.dir.z * rig.nearClip,
    };
    const hit = raycastAll(this, start, rig.dir, maxDist + 3, (x) => x === e || !this.passes(x, f), true);
    if (hit?.entityId !== undefined) {
      const t = this.get(hit.entityId)!;
      if (dist3(t.pos, eye) <= maxDist + t.radius && ok(t)) return t;
    }
    // 3. sticky cone (5°) for forgiving ability targeting
    let best: Entity | undefined;
    let bestA = (5 * Math.PI) / 180;
    for (const t of this.queryRadius(e.pos, maxDist, f)) {
      if (!ok(t)) continue;
      const a = angleTo(t);
      if (a < bestA && this.lineOfSight(eye, this.centerOf(t))) {
        bestA = a;
        best = t;
      }
    }
    return best;
  }

  canSee(viewer: Entity, e: Entity): boolean {
    if (viewer === e) return true;
    if (!findStatus(e, 'stealth', this.time)) return true;
    if (this.isOwnSide(viewer, e) || revealedTo(e, viewer.id, this.time)) return true;
    return dist3(viewer.pos, e.pos) <= 6;
  }

  // ── sides & roles ───────────────────────────────────────────────────────
  creditOf(sourceId: EntityId | undefined): EntityId | undefined {
    let id = sourceId;
    for (let depth = 0; depth < 4 && id !== undefined; depth++) {
      const e = this.ents.get(id);
      if (!e) return id;
      switch (e.kind) {
        case 'hero':
          return e.id;
        case 'troop':
          return e.troop?.commanderId ?? e.id;
        case 'npc':
          if (e.npc?.summonerId !== undefined) {
            id = e.npc.summonerId;
            continue;
          }
          return e.id;
        default:
          if (e.ownerId === undefined) return e.id;
          id = e.ownerId;
          continue;
      }
    }
    return id;
  }

  commanderOf(e: Entity): Entity | undefined {
    const c = this.get(this.creditOf(e.id));
    return c?.hero ? c : undefined;
  }

  isOwnSide(a: Entity, b: Entity): boolean {
    if (a === b) return true;
    const ca = this.creditOf(a.id);
    return ca !== undefined && ca === this.creditOf(b.id);
  }

  isOwnSideId(a: EntityId, b: EntityId): boolean {
    if (a === b) return true;
    const ca = this.creditOf(a);
    return ca !== undefined && ca === this.creditOf(b);
  }

  isEnemyOf(a: Entity, b: Entity): boolean {
    return !this.isOwnSide(a, b);
  }

  /** both credited heroes belong to the same faction (friendly-fire off). */
  sameFaction(a: EntityId, b: EntityId): boolean {
    const ea = this.get(this.creditOf(a));
    const eb = this.get(this.creditOf(b));
    if (!ea?.hero || !eb?.hero) return false;
    const fa = factionOf(ea.hero.role);
    return fa !== 'neutral' && fa === factionOf(eb.hero.role);
  }

  isHostileTo(a: Entity, b: Entity): boolean {
    return isHostile(this, a, b);
  }

  roleOf(e: Entity): RoleId | undefined {
    return e.hero?.role;
  }

  knownRole(e: Entity): RoleId | undefined {
    return knownRoleFor(this, undefined, e);
  }

  canBeAffected(target: Entity, status: StatusId | 'steal', sourceId?: EntityId): boolean {
    return this.hooks.canBeAffected(target, status, sourceId);
  }

  focusOf(heroId: EntityId): { id?: EntityId; at: number } {
    const rt = this.heroRts.get(heroId);
    return { id: rt?.focusId, at: rt?.focusAt ?? -99 };
  }

  // ── SimApi: effects ─────────────────────────────────────────────────────
  dealDamage(req: DamageRequest): DamageResult {
    return dealDamage(this, req);
  }

  heal(targetId: EntityId, amount: number, sourceId?: EntityId): number {
    return healEntity(this, targetId, amount, sourceId);
  }

  addShield(targetId: EntityId, amount: number, duration: number): void {
    const e = this.get(targetId);
    if (!e || !e.alive || e.hero?.dead || !(amount > 0) || !(duration > 0)) return;
    e.shield += amount;
    const until = this.time + duration;
    const s = findStatus(e, 'shield', this.time);
    if (s) {
      s.until = Math.max(s.until, until);
      s.params = { ...(s.params ?? {}), amount: e.shield };
    } else {
      e.statuses.push({ id: 'shield', until, stacks: 1, params: { amount: e.shield } });
      this.emit({ t: 'status', target: e.id, status: 'shield', on: true });
    }
  }

  applyStatus(
    targetId: EntityId,
    id: StatusId,
    duration: number,
    opts?: { sourceId?: EntityId; params?: Record<string, number>; stacks?: number },
  ): boolean {
    const e = this.get(targetId);
    if (!e) return false;
    return applyStatusTo(this, e, id, duration, opts);
  }

  removeStatus(targetId: EntityId, id: StatusId): void {
    const e = this.get(targetId);
    if (e) removeStatusFrom(this, e, id);
  }

  hasStatus(targetId: EntityId, id: StatusId): boolean {
    const e = this.get(targetId);
    return !!e && findStatus(e, id, this.time) !== undefined;
  }

  statusParam(targetId: EntityId, id: StatusId, key: string, fallback: number): number {
    const e = this.get(targetId);
    return e ? statusParamOf(e, id, key, fallback, this.time) : fallback;
  }

  cleanse(targetId: EntityId): void {
    const e = this.get(targetId);
    if (!e) return;
    for (const s of [...e.statuses]) if (DEBUFF_STATUSES.has(s.id)) removeStatusFrom(this, e, s.id);
  }

  spawnProjectile(spec: ProjectileSpec): Entity {
    const e = this.createEntity('projectile', spec.pos, { radius: spec.radius ?? 0.1, height: 0.2, hp: 1, ownerId: spec.ownerId });
    e.vel = { x: spec.vel.x, y: spec.vel.y, z: spec.vel.z };
    e.onGround = false;
    e.yaw = Math.atan2(-spec.vel.x, -spec.vel.z);
    e.pitch = Math.atan2(spec.vel.y, Math.hypot(spec.vel.x, spec.vel.z));
    e.proj = makeProjectileState(spec, this.time);
    return e;
  }

  explode(pos: Vec3, radius: number, damage: number, dtype: DamageType, sourceId: EntityId | undefined, opts?: ExplodeOptions): void {
    explodeAt(this, pos, radius, damage, dtype, sourceId, opts);
  }

  spawnHazard(spec: HazardSpec): Entity {
    const y = groundAt(this.cw, spec.pos.x, spec.pos.z, spec.pos.y + 2);
    const e = this.createEntity('hazard', { x: spec.pos.x, y, z: spec.pos.z }, { radius: spec.radius, height: 0.5, hp: 1, ownerId: spec.ownerId });
    e.hazard = {
      kind: spec.kind,
      radius: spec.radius,
      expiresAt: this.time + Math.max(0, spec.duration),
      nextTickAt: this.time,
      tickEvery: Math.max(0.05, spec.tickEvery),
      params: { ...spec.params },
      followId: spec.followId,
    };
    if (hazardIsHarmful(spec)) e.hazard.harmful = true;
    this.hazardRt.set(e.id, hazardRuntimeFrom(spec));
    return e;
  }

  spawnTroops(commanderId: EntityId, troopType: string, count: number, pos?: Vec3, opts?: { temporary?: number }): Entity[] {
    const c = this.get(commanderId);
    if (!c?.hero || c.hero.dead) return [];
    return spawnSquad(this, c, troopType, count, pos, opts?.temporary);
  }

  spawnNpc(npcType: string, pos: Vec3, opts?: { summonerId?: EntityId; lifetime?: number; leash?: number }): Entity {
    return spawnNpcEntity(this, npcType, pos, opts);
  }

  spawnTurret(ownerId: EntityId, pos: Vec3, kind: string, weaponId: string, lifetime: number, hp: number): Entity {
    const owner = this.get(ownerId);
    const p = findFreeSpot(this.cw, pos, 0.6, 1.2, 6);
    const e = this.createEntity('turret', p, { radius: 0.6, height: 1.2, hp: Math.max(1, hp), ownerId, kingdom: owner?.kingdom, yaw: owner?.yaw ?? 0 });
    e.turret = { kind, weaponId, expiresAt: this.time + Math.max(0.1, lifetime), nextFireAt: this.time + 0.5 };
    return e;
  }

  spawnLoot(
    pos: Vec3,
    what: { itemId?: string; weaponId?: string; count?: number },
    ammo?: WeaponInstance,
    lock?: { heroId: EntityId; seconds: number },
  ): Entity {
    const y = groundAt(this.cw, pos.x, pos.z, pos.y + 1.5);
    const e = this.createEntity('loot', { x: pos.x, y, z: pos.z }, { radius: 0.5, height: 0.4, hp: 1, yaw: this.rng.next() * Math.PI * 2 });
    e.loot = { itemId: what.itemId, weaponId: what.weaponId, count: Math.max(1, what.count ?? 1) };
    if (ammo) {
      e.loot.mag = ammo.mag;
      e.loot.reserve = ammo.reserve;
    }
    if (lock && lock.seconds > 0) this.lootLocks.set(e.id, { heroId: lock.heroId, until: this.time + lock.seconds });
    return e;
  }

  removeEntity(id: EntityId): void {
    const e = this.ents.get(id);
    if (!e) return;
    if (e.kind === 'hero') {
      warnOnce('remove-hero', 'removeEntity called on a hero: ignored (heroes stay in the world until the match ends)');
      return;
    }
    e.alive = false;
    this.ents.delete(id);
    this.markKindsDirty();
    this.gridDirty = true;
    this.history.remove(id);
    this.hazardRt.delete(id);
    this.projPierced.delete(id);
    this.projDetonated.delete(id);
    this.projHoming.delete(id);
    this.turretAis.delete(id);
    this.expiries.delete(id);
    this.removals.delete(id);
    this.freezeStacks.delete(id);
    this.lootLocks.delete(id);
    forgetPath(this, id);
    this.unitMovedTick.delete(id);
    if (e.troop) {
      const cmd = this.get(e.troop.commanderId);
      if (cmd?.hero) cmd.hero.squad = cmd.hero.squad.filter((x) => x !== id);
    }
  }

  // ── movement effects ────────────────────────────────────────────────────
  /**
   * Dash (forced movement). It moves on n = ⌈duration / SIM_DT⌉ whole ticks at
   * distance / (n·SIM_DT) — the same ticks a plain `until = time + duration`
   * would move on, but covering exactly `distance` (SHU-1): `until` sits half a
   * tick past the last movement tick, so float rounding can never add or drop
   * one. A dash started after the unit already moved this tick begins next tick.
   * When it ends, the unit keeps walking speed at most (no slide).
   */
  dash(id: EntityId, dir: Vec3, distance: number, duration: number, opts?: { invuln?: boolean }): void {
    const e = this.get(id);
    if (!e || !e.alive || e.hero?.dead || e.kind === 'projectile') return;
    if (this.nullifies(e)) return; // an enemy dragging you (pull) is an ability effect
    const l = Math.hypot(dir.x, dir.z);
    if (l < 1e-6 || !(duration > 0) || !Number.isFinite(distance)) return;
    const n = Math.max(1, Math.ceil(duration / SIM_DT - 1e-6));
    const speed = distance / (n * SIM_DT);
    const start = this.movedThisTick(e) ? this.time + SIM_DT : this.time;
    e.forced = { vel: { x: (dir.x / l) * speed, y: 0, z: (dir.z / l) * speed }, until: start + (n - 0.5) * SIM_DT, invuln: opts?.invuln, dash: true };
  }

  /** Has `e` already run its movement step this tick? (heroes: their updateHero; troops / NPCs: their driveUnit) */
  private movedThisTick(e: Entity): boolean {
    if (e.hero) return this.heroRts.get(e.id)?.movedTick === this.tick;
    return this.unitMovedTick.get(e.id) === this.tick;
  }

  /** troops.ts driveUnit: this troop / NPC has run its movement step for this tick. */
  markUnitMoved(id: EntityId): void {
    this.unitMovedTick.set(id, this.tick);
  }

  /** SimExt.endDash (WEI-6): stop the unit's own dash now, at walking speed at most. */
  endDash(id: EntityId): void {
    const e = this.get(id);
    if (!e?.forced || !e.forced.dash) return;
    e.forced = undefined;
    brakeForcedEnd(e.vel, WALK_SPEED);
  }

  /** SimExt.dropAggro (SHU-4, 空城): drop the unit's target and hold acquisition for `seconds`. */
  dropAggro(unitId: EntityId, seconds: number): void {
    const u = this.get(unitId);
    const st = u?.troop ?? u?.npc;
    if (!u || !st || !(seconds > 0)) return;
    st.targetId = undefined;
    st.ai.aggroHoldUntil = Math.max(st.ai.aggroHoldUntil ?? 0, this.time + seconds);
  }

  /** SimApi.knockback (ability code): cancelled by 无懈可击 when the acting hero is an enemy. */
  knockback(id: EntityId, dir: Vec3, force: number): void {
    const e = this.get(id);
    if (!e || !(force > 0)) return;
    if (this.nullifies(e)) return;
    this.applyKnockback(e, dir, force);
  }

  /** Knockback without the nullify gate (damage pipeline / explosions already gated it). */
  applyKnockback(e: Entity, dir: Vec3, force: number): void {
    if (!e.alive || e.hero?.dead || e.hero?.downed || !(force > 0)) return;
    if (e.kind === 'turret' || e.kind === 'crate' || e.kind === 'loot' || e.kind === 'hazard' || e.kind === 'airdrop') return;
    if (e.hero && this.modifiers(e.id).knockbackImmune) return;
    if (e.kind === 'npc' && e.radius >= 1.2) force *= 0.3; // elephants barely budge
    const l = Math.hypot(dir.x, dir.z);
    const t = 0.3;
    const up = dir.y > 0.5 ? force * 1.6 : Math.min(4, force * 0.5);
    const hx = l > 1e-6 ? dir.x / l : 0;
    const hz = l > 1e-6 ? dir.z / l : 0;
    const hs = dir.y > 0.5 ? force * 0.3 : force;
    // a knockback of `force` travels `force` m (then stops at walking speed, SHU-1)
    const n = Math.max(1, Math.ceil(t / SIM_DT - 1e-6));
    const start = this.movedThisTick(e) ? this.time + SIM_DT : this.time;
    e.forced = { vel: { x: (hx * hs) / (n * SIM_DT), y: 0, z: (hz * hs) / (n * SIM_DT) }, until: start + (n - 0.5) * SIM_DT };
    e.vel.y = Math.max(e.vel.y, up);
    e.onGround = false;
  }

  teleport(id: EntityId, pos: Vec3): void {
    const e = this.get(id);
    if (!e) return;
    if (this.nullifies(e)) return; // an enemy displacing you is an ability effect
    const p = findFreeSpot(this.cw, pos, e.radius, e.height, 6);
    e.pos.x = p.x;
    e.pos.y = p.y;
    e.pos.z = p.z;
    e.vel.x = 0;
    e.vel.y = 0;
    e.vel.z = 0;
    e.forced = undefined;
    e.onGround = true;
    this.gridDirty = true;
  }

  setCooldown(heroId: EntityId, abilityId: string, seconds: number): void {
    const h = this.get(heroId)?.hero;
    if (h) h.cooldowns[abilityId] = this.time + Math.max(0, seconds);
  }

  cooldownLeft(heroId: EntityId, abilityId: string): number {
    const h = this.get(heroId)?.hero;
    return h ? Math.max(0, (h.cooldowns[abilityId] ?? 0) - this.time) : 0;
  }

  emit(ev: GameEvent): void {
    this.viewDirty = true; // state changed: invalidate the cached public views
    // a bounty reward reveals who the 赏金猎人 is: it is only ever the hunter's (net/eventFilter.ts)
    if (ev.t === 'reward' && ev.kind === 'bounty' && ev.privateTo === undefined) ev.privateTo = ev.who;
    this.events.push(ev);
    if (this.events.length > 20000) this.events.splice(0, this.events.length - 20000);
    if (ev.privateTo === undefined) {
      const seq = ++this.pubSeq;
      const i = seq % PUBLIC_EVENT_LOG;
      this.pubLog[i] = ev;
      this.pubLogSeq[i] = seq;
    }
  }

  /** SimExt.publicEventsSince (AI-1): public events newer than `seq`, oldest first. */
  publicEventsSince(seq: number): { seq: number; events: readonly GameEvent[] } {
    const newest = this.pubSeq;
    const from = Math.max((Number.isFinite(seq) ? Math.floor(seq) : 0) + 1, newest - PUBLIC_EVENT_LOG + 1, 1);
    const events: GameEvent[] = [];
    for (let q = from; q <= newest; q++) {
      const i = q % PUBLIC_EVENT_LOG;
      const ev = this.pubLog[i];
      if (ev && this.pubLogSeq[i] === q) events.push(ev);
    }
    return { seq: newest, events };
  }

  /** SimExt.matchInfo (AI-2): the public match facts. */
  matchInfo(): { playerCount: number; mode: GameMode } {
    return { playerCount: this.slots.length, mode: this.settings.mode };
  }

  announce(zh: string, en: string, kind?: 'info' | 'warn' | 'big'): void {
    this.emit({ t: 'announce', zh, en, kind });
  }

  schedule(delay: number, fn: () => void): void {
    this.scheduled.push({ at: this.time + Math.max(0, delay), seq: this.schedSeq++, fn, actor: this.actorId });
  }

  /** Run `fn` with `actorId` as the acting hero (ability / item code). */
  runAs<T>(actorId: EntityId | undefined, fn: () => T): T {
    const prev = this.actorId;
    this.actorId = actorId;
    try {
      return fn();
    } finally {
      this.actorId = prev;
    }
  }

  /**
   * 无懈可击 gate for a source-less hostile effect on `target` (knockback,
   * teleport, steal): attributed to `sourceId` or the acting hero.
   */
  nullifies(target: Entity, sourceId?: EntityId): boolean {
    const src = sourceId ?? this.actorId;
    return src !== undefined && src !== target.id && nullifyEffect(this, target, src);
  }

  // ── SimExt extras ───────────────────────────────────────────────────────
  /** Revive a downed hero; `free` = no 桃 was spent (华佗 急救). Fires the reviver's onRevive hooks. */
  revive(targetId: EntityId, hp: number, byId?: EntityId, free = false): boolean {
    const e = this.get(targetId);
    if (!e || !reviveHero(this, e, hp, byId)) return false;
    const by = byId !== undefined && byId !== targetId ? this.get(byId) : undefined;
    if (by?.hero) this.hooks.onRevive(by, e, free);
    return true;
  }

  fireHitscan(srcId: EntityId, origin: Vec3, dir: Vec3, opts: HitscanOptions): RayHit | null {
    return fireHitscanShot(this, srcId, origin, dir, opts);
  }

  modifiers(heroId: EntityId): ResolvedModifiers {
    return this.heroRts.get(heroId)?.mods ?? DEFAULT_MODS;
  }

  activeWeapon(heroId: EntityId): { inst: WeaponInstance; def: WeaponDef } | undefined {
    const h = this.get(heroId)?.hero;
    const inst = h?.weapons[h.activeSlot];
    return inst ? { inst, def: weaponDef(inst.id) } : undefined;
  }

  /** SimExt.squadCap (ITEMS-2 / WU-6): the squad size a hero is entitled to — also the spawn rule. */
  squadCap(heroId: EntityId): number {
    const e = this.get(heroId);
    const rt = this.heroRts.get(heroId);
    if (!e?.hero || !rt) return 0;
    // 影武者 also gets the lord's +2 so the disguise holds (its tell is the missing lord skill)
    const lordBonus = e.hero.role === 'lord' || e.hero.role === 'double' ? 2 : 0;
    return Math.max(0, Math.round(this.settings.troopsPerHero + rt.def.troopBonus + lordBonus + rt.mods.squadBonus));
  }

  /** SimExt.maxDodgeCharges (WEI-5). */
  maxDodgeCharges(heroId: EntityId): number {
    return BASE_DODGE_CHARGES + this.modifiers(heroId).extraDodgeCharges;
  }

  /** SimExt.removeStatusFrom (ITEMS-5): only the instances applied by `sourceId`. */
  removeStatusFrom(targetId: EntityId, id: StatusId, sourceId: EntityId): void {
    const e = this.get(targetId);
    if (e) removeStatusFrom(this, e, id, sourceId);
  }

  /** SimExt.removeStatusWhere (WU-3): only the instances matching `pred`. */
  removeStatusWhere(targetId: EntityId, id: StatusId, pred: (s: StatusInstance) => boolean): void {
    const e = this.get(targetId);
    if (e) removeStatusIf(this, e, id, pred);
  }

  /** SimExt.redirectDamage (WU-10, 流离): see combat.ts redirectDamage. */
  redirectDamage(req: DamageRequest, newTargetId: EntityId): DamageResult {
    return redirectDamageImpl(this, req, newTargetId);
  }

  /** 铁索连环 record of a strike this tick (combat.ts, QUN-7); undefined when none. */
  chainStrikeThisTick(key: string): ChainStrike | undefined {
    if (this.chainHitsTick !== this.tick) return undefined;
    return this.chainHits.get(key);
  }

  /** The record of a strike this tick, created on demand (cleared every tick). */
  chainStrike(key: string): ChainStrike {
    if (this.chainHitsTick !== this.tick) {
      this.chainHits.clear();
      this.chainHitsTick = this.tick;
    }
    let rec = this.chainHits.get(key);
    if (!rec) {
      rec = { direct: new Set(), spread: new Set() };
      this.chainHits.set(key, rec);
    }
    return rec;
  }

  findPath(from: Vec3, to: Vec3, requesterId?: EntityId): Vec3[] | null {
    void requesterId;
    if (!this.nav || this.navFailed) return null;
    const key = pathCacheKey(from, to);
    const cached = this.pathCache.get(key);
    if (cached && this.time - cached.at <= PATH_CACHE_TTL) return cached.path ? rebasePath(cached.path, from) : null;
    if (this.pathBudget <= 0 || this.pathDebt > 0) return null;
    this.pathBudget--;
    let path: Vec3[] | null = null;
    try {
      path = navFindPath(this.nav, from, to, PATH_MAX_ITER);
    } catch (err) {
      warnOnce('nav-find', `findPath threw: ${String(err)}`);
      path = null;
    }
    this.pathDebt += path ? PATH_COST_FOUND : PATH_MAX_ITER;
    if (this.pathCache.size >= PATH_CACHE_MAX) {
      for (const [k, v] of this.pathCache) if (this.time - v.at > PATH_CACHE_TTL) this.pathCache.delete(k);
      if (this.pathCache.size >= PATH_CACHE_MAX) this.pathCache.clear();
    }
    this.pathCache.set(key, { path, at: this.time });
    return path ? rebasePath(path, from) : null;
  }

  zoneView(): ZoneView {
    return this.zone.view();
  }

  abilityCtx(e: Entity, def: AbilityDef): AbilityCtx {
    const rt = this.heroRts.get(e.id);
    return { sim: this, self: e, def, hero: rt?.def ?? heroDef(e.hero?.heroId ?? ''), input: rt?.input ?? EMPTY_INPUT };
  }

  /** Bleed-out seconds removed per point of damage while downed (exposed for UI/tests). */
  static readonly downedDamageToSeconds = DOWNED_DAMAGE_TO_SECONDS;
  static readonly bleedOutTime = BLEED_OUT_TIME;
}

const DEFAULT_MODS = defaultModifiers();

// ── helpers ─────────────────────────────────────────────────────────────────
function finiteOr(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Path cache key: start and goal quantised to PATH_CACHE_CELL m cells (and 3 m levels). */
function pathCacheKey(from: Vec3, to: Vec3): string {
  const q = (v: number): number => Math.floor(v / PATH_CACHE_CELL);
  const lv = (v: number): number => Math.floor(v / 3);
  return `${q(from.x)},${q(from.z)},${lv(from.y)}>${q(to.x)},${q(to.z)},${lv(to.y)}`;
}

/** A shared path for a caller: fresh arrays, first waypoint replaced by the caller's own start. */
function rebasePath(path: Vec3[], from: Vec3): Vec3[] {
  const out = new Array<Vec3>(path.length);
  for (let i = 0; i < path.length; i++) out[i] = { x: path[i].x, y: path[i].y, z: path[i].z };
  if (out.length > 0) out[0] = { x: from.x, y: out[0].y, z: from.z };
  return out;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Create the authoritative match (the World). */
export function createMatch(init: MatchInit, opts?: CreateMatchOptions): SimHost {
  return new World(init, opts);
}

/** Same as createMatch but typed as the concrete World (tests / tools). */
export function createWorld(init: MatchInit, opts?: CreateMatchOptions): World {
  return new World(init, opts);
}

export type { ItemStack };
