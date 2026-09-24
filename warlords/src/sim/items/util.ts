// Shared helpers for item implementations (三国杀 cards as consumables):
// tunables, target resolution, thrown-grenade arcs, engine gates for
// 无懈可击 / 谦逊, and the bot-side "is this sensible now?" perception.
// Everything goes through SimApi / SimExt — items never import World.
import type { Vec3 } from '../../core/math';
import type { Entity, EntityId, EntityKind, StatusId } from '../../core/types';
import { ITEM_BY_ID } from '../../data/items';
import type { ItemCtx, SimApi } from '../api';
import { ext } from '../ext';

export const UNIT_KINDS: EntityKind[] = ['hero', 'troop', 'npc', 'turret'];

/** Item tunable with fallback (ItemDef.params). */
export function prm(ctx: ItemCtx, key: string, fallback: number): number {
  const v = ctx.def.params[key];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
}

/** Tunable of an item by id (bot hints run without an ItemCtx). */
export function itemParam(itemId: string, key: string, fallback: number): number {
  const v = ITEM_BY_ID[itemId]?.params[key];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
}

export const isAlive = (e: Entity | undefined): e is Entity => !!e && e.alive && !e.hero?.dead;
/** alive and not 濒死 */
export const isStanding = (e: Entity | undefined): e is Entity => isAlive(e) && !e.hero?.downed;

export const flatDist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export const centerOf = (e: Entity): Vec3 => ({ x: e.pos.x, y: e.pos.y + (e.hero?.downed ? 0.3 : e.height * 0.55), z: e.pos.z });

/** "Enemy" in the item sense: any unit not on the user's own side (data/items.ts header). */
export function isEnemyUnit(sim: SimApi, self: Entity, e: Entity): boolean {
  if (!isAlive(e) || e === self) return false;
  if (e.kind !== 'hero' && e.kind !== 'troop' && e.kind !== 'npc' && e.kind !== 'turret') return false;
  return !sim.isOwnSide(self, e);
}

// ── engine gates (World implements these; not on SimExt yet — docs/SIM_REQUESTS.md) ──
interface EngineGates {
  nullifies?(target: Entity, sourceId?: EntityId): boolean;
  canBeAffected?(target: Entity, status: StatusId | 'steal', sourceId?: EntityId): boolean;
  settings?: { troopsPerHero?: number };
  /** World.spawnLoot takes a pickup lock as its 4th argument (SimApi declares only two) */
  spawnLoot(pos: Vec3, what: { itemId?: string; weaponId?: string; count?: number }, ammo?: undefined, lock?: { heroId: EntityId; seconds: number }): Entity;
}

const gates = (sim: SimApi): EngineGates => sim as unknown as EngineGates;

/**
 * 无懈可击 gate for a hostile item effect on `target` that has no damage /
 * status of its own to carry the check (EMP strip, duel, hack): true = the
 * effect is cancelled (one nullify charge consumed, or the same enemy's burst
 * this tick was already nullified).
 */
export function nullified(sim: SimApi, target: Entity, sourceId: EntityId): boolean {
  const g = gates(sim);
  return typeof g.nullifies === 'function' ? g.nullifies(target, sourceId) === true : false;
}

/** 谦逊-style veto: true when `target` is immune to `status` from `sourceId`. */
export function vetoes(sim: SimApi, target: Entity, status: StatusId | 'steal', sourceId?: EntityId): boolean {
  const g = gates(sim);
  return typeof g.canBeAffected === 'function' ? g.canBeAffected(target, status, sourceId) === false : false;
}

/** Match setting troopsPerHero (default 4). */
export function troopsPerHero(sim: SimApi): number {
  const v = gates(sim).settings?.troopsPerHero;
  return typeof v === 'number' && Number.isFinite(v) ? v : 4;
}

/**
 * Drop loot that `lock.heroId` cannot pick up for `lock.seconds` (过河拆桥 knocks
 * gear out of reach of its owner). World.spawnLoot already takes the lock; it is
 * not on SimApi yet (docs/SIM_REQUESTS.md ITEMS-9) — without it the loot is
 * simply unlocked.
 */
export function spawnLockedLoot(sim: SimApi, pos: Vec3, what: { itemId?: string; count?: number }, lock: { heroId: EntityId; seconds: number }): Entity {
  return gates(sim).spawnLoot(pos, what, undefined, lock);
}

/**
 * Is `e`'s position public knowledge? False while it is in stealth and not
 * revealed to everyone — public entities (storm clouds, squad orders) must not
 * follow or point at such a unit, or they would give it away.
 */
export function publiclyVisible(sim: SimApi, e: Entity): boolean {
  const now = sim.time;
  let stealth = false;
  for (const s of e.statuses) {
    if (s.until <= now) continue;
    if (s.id === 'reveal' && s.params?.viewerId === undefined) return true;
    if (s.id === 'stealth') stealth = true;
  }
  return !stealth;
}

/** Total stacks of an active status (无懈可击 charges). */
export function statusStacks(e: Entity, id: StatusId, now: number): number {
  let n = 0;
  for (const s of e.statuses) if (s.id === id && s.until > now) n += s.stacks ?? 1;
  return n;
}

// ── targeting ───────────────────────────────────────────────────────────────
/**
 * The enemy hero an 'enemy'-targeted item acts on: the resolved crosshair
 * target if it is a hero (a troop/turret/summon resolves to its commander when
 * `viaCommander`), else the enemy hero nearest the crosshair ray within
 * `coneDeg` and range, with line of sight.
 */
export function resolveEnemyHero(
  ctx: ItemCtx,
  range: number,
  o: { allowDowned?: boolean; viaCommander?: boolean; coneDeg?: number } = {},
): Entity | undefined {
  const { sim, self } = ctx;
  const eye = sim.eyePos(self);
  const ok = (e: Entity | undefined): e is Entity =>
    !!e && e.kind === 'hero' && isAlive(e) && (o.allowDowned || !e.hero!.downed) && !sim.isOwnSide(self, e) && flatDist(e.pos, self.pos) <= range + e.radius + 0.5;
  let t = ctx.target;
  if (t && t.kind !== 'hero' && o.viaCommander) t = ext(sim).commanderOf(t);
  if (ok(t)) return t;
  // fallback: nearest enemy hero around the crosshair
  const ray = sim.aimRay(self);
  const cone = ((o.coneDeg ?? 12) * Math.PI) / 180;
  let best: Entity | undefined;
  let bestA = cone;
  for (const e of sim.queryRadius(self.pos, range + 1, { kinds: ['hero'], exclude: [self.id] })) {
    if (!ok(e) || !ext(sim).canSee(self, e)) continue;
    const c = centerOf(e);
    const vx = c.x - ray.origin.x;
    const vy = c.y - ray.origin.y;
    const vz = c.z - ray.origin.z;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const a = Math.acos(Math.max(-1, Math.min(1, (vx * ray.dir.x + vy * ray.dir.y + vz * ray.dir.z) / vl)));
    if (a < bestA && sim.lineOfSight(eye, c)) {
      bestA = a;
      best = e;
    }
  }
  return best;
}

// ── thrown items ────────────────────────────────────────────────────────────
export const GRENADE_GRAVITY = 14;
const THROW_SPEED = 16;
const ARC_STEPS = 10;

export interface ThrowPlan {
  /** where the item comes to rest (on the ground) */
  land: Vec3;
  /** seconds from the throw until it lands */
  flight: number;
}

/**
 * Lob from the user's hand toward `aim` along a ballistic arc; the item stops
 * at the first wall / roof / unit on the way (then drops to the ground below)
 * and spawns a purely visual projectile of `kind`.
 */
export function throwItem(sim: SimApi, self: Entity, aim: Vec3, kind: string, maxFlight: number): ThrowPlan {
  const eye = sim.eyePos(self);
  const origin = { x: eye.x, y: eye.y - 0.15, z: eye.z };
  const dx = aim.x - origin.x;
  const dy = aim.y - origin.y;
  const dz = aim.z - origin.z;
  const horiz = Math.hypot(dx, dz);
  const T = Math.max(0.25, Math.min(maxFlight, horiz / THROW_SPEED + 0.2));
  const g = GRENADE_GRAVITY;
  const v = { x: dx / T, y: (dy + 0.5 * g * T * T) / T, z: dz / T };
  const ignore = [self.id, ...(self.hero?.squad ?? [])];
  let prev = origin;
  let land: Vec3 = { ...aim };
  let flight = T;
  for (let i = 1; i <= ARC_STEPS; i++) {
    const t = (T * i) / ARC_STEPS;
    const cur = { x: origin.x + v.x * t, y: origin.y + v.y * t - 0.5 * g * t * t, z: origin.z + v.z * t };
    const sx = cur.x - prev.x;
    const sy = cur.y - prev.y;
    const sz = cur.z - prev.z;
    const len = Math.hypot(sx, sy, sz);
    if (len > 1e-6) {
      const hit = sim.raycast(prev, { x: sx, y: sy, z: sz }, len, { ignore, entities: true });
      if (hit && (i < ARC_STEPS || hit.dist < len - 0.05)) {
        const back = Math.min(0.35, hit.dist);
        land = { x: hit.point.x - (sx / len) * back, y: hit.point.y, z: hit.point.z - (sz / len) * back };
        flight = (T * (i - 1)) / ARC_STEPS + (hit.dist / len) * (T / ARC_STEPS);
        break;
      }
    }
    prev = cur;
  }
  land = dropToGround(sim, land);
  sim.spawnProjectile({
    kind,
    ownerId: self.id,
    pos: origin,
    vel: v,
    damage: 0,
    dtype: 'normal',
    gravity: g,
    lifetime: Math.max(0.05, flight),
    canDodge: false,
    radius: 0.08,
  });
  return { land, flight: Math.max(0.05, flight) };
}

/** The walkable surface right below `p` (roofs and decks count). */
export function dropToGround(sim: SimApi, p: Vec3): Vec3 {
  const from = { x: p.x, y: p.y + 0.4, z: p.z };
  const hit = sim.raycast(from, { x: 0, y: -1, z: 0 }, 80, { entities: false });
  const y = hit ? hit.point.y : sim.groundHeight(p.x, p.z);
  return { x: p.x, y, z: p.z };
}

/** Units inside a blast around `pos` that the blast can reach (walls block it, like explosions). */
export function unitsInBlast(sim: SimApi, pos: Vec3, radius: number, pred: (e: Entity) => boolean): Entity[] {
  const origin = { x: pos.x, y: pos.y + 0.3, z: pos.z };
  return sim.queryRadius(pos, radius, { kinds: UNIT_KINDS }).filter((e) => {
    if (!isAlive(e) || !pred(e)) return false;
    const c = centerOf(e);
    return sim.lineOfSight(origin, c) || sim.lineOfSight(origin, { x: c.x, y: e.pos.y + e.height - 0.1, z: c.z });
  });
}

/** The point `radius` from `center` at flat angle `a`, pulled in where a wall is in the way. */
export function spotAround(sim: SimApi, center: Vec3, a: number, radius: number): Vec3 {
  const chest = { x: center.x, y: center.y + 1, z: center.z };
  let r = radius;
  let p = { x: center.x + Math.cos(a) * r, y: center.y, z: center.z + Math.sin(a) * r };
  for (let k = 0; k < 3 && !sim.lineOfSight(chest, { x: p.x, y: center.y + 0.6, z: p.z }); k++) {
    r *= 0.5;
    p = { x: center.x + Math.cos(a) * r, y: center.y, z: center.z + Math.sin(a) * r };
  }
  return p;
}

/** Evenly spread points on a ring around `center`, pulled in where a wall is in the way. */
export function ringSpots(sim: SimApi, center: Vec3, n: number, radius: number, phase: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) out.push(spotAround(sim, center, phase + (i / Math.max(1, n)) * Math.PI * 2, radius));
  return out;
}

// ── bot perception ──────────────────────────────────────────────────────────
export interface BotView {
  /** what the bot is fighting (its crosshair target), if hostile-looking */
  target?: Entity;
  /** flat distance to the target */
  dist: number;
  /** eye → target line of sight */
  los: boolean;
  /** seconds since the bot last took damage */
  since: number;
  hpFrac: number;
}

/**
 * The bot's current fight as seen through its last input frame (bots aim at
 * their target and set aimTargetId): the target if it is an alive unit that
 * is not on the bot's side and not a downed hero it is trying to save.
 * Cached per tick (treat the result as read-only).
 */
export function botView(sim: SimApi, self: Entity): BotView {
  // bots ask once per item slot per tick: compute it once per (world, tick, hero)
  let c = viewCache.get(sim);
  if (!c || c.tick !== sim.tick) {
    c = { tick: sim.tick, views: new Map() };
    viewCache.set(sim, c);
  }
  const aim = sim.inputOf(self).aimTargetId;
  const hit = c.views.get(self.id);
  if (hit && hit.aim === aim && hit.hp === self.hp && hit.hurtAt === self.lastDamagedAt) return hit.view;
  const view = computeBotView(sim, self);
  c.views.set(self.id, { aim, hp: self.hp, hurtAt: self.lastDamagedAt, view });
  return view;
}

interface CachedView {
  aim: EntityId | undefined;
  hp: number;
  hurtAt: number | undefined;
  view: Readonly<BotView>;
}

const viewCache = new WeakMap<SimApi, { tick: number; views: Map<EntityId, CachedView> }>();

function computeBotView(sim: SimApi, self: Entity): BotView {
  const input = sim.inputOf(self);
  let target: Entity | undefined = sim.get(input.aimTargetId);
  if (target && (!isEnemyUnit(sim, self, target) || (target.hero?.downed && !sim.isHostileTo(self, target)))) target = undefined;
  const dist = target ? flatDist(self.pos, target.pos) : Infinity;
  const los = target ? sim.lineOfSight(sim.eyePos(self), centerOf(target)) : false;
  return { target, dist, los, since: ext(sim).sinceDamaged(self.id), hpFrac: self.hp / Math.max(1, self.maxHp) };
}

/** Enemy units within `r` of `pos` that the bot would hit (weighted: heroes count `heroWeight`). */
export function clusterScore(sim: SimApi, self: Entity, pos: Vec3, r: number, heroWeight = 2): number {
  let s = 0;
  for (const e of sim.queryRadius(pos, r, { kinds: UNIT_KINDS, notFriendlyTo: self.id })) {
    if (!isAlive(e)) continue;
    // only units it has reason to fight, plus the one it is aiming at
    if (e.kind === 'hero') s += sim.isHostileTo(self, e) || e.id === sim.inputOf(self).aimTargetId ? heroWeight : 0;
    else s += sim.isHostileTo(self, e) ? 1 : 0;
  }
  return s;
}

/** Hostile-looking standing heroes within `r` of the bot. */
export function hostileHeroesNear(sim: SimApi, self: Entity, r: number): Entity[] {
  const aim = sim.inputOf(self).aimTargetId;
  return sim
    .queryRadius(self.pos, r, { kinds: ['hero'], exclude: [self.id] })
    .filter((e) => isStanding(e) && !sim.isOwnSide(self, e) && (e.id === aim || sim.isHostileTo(self, e)));
}
