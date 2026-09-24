// Shared helpers for the 蜀 Shu ability implementations (sim/abilities/shu/*).
// Everything goes through SimApi / SimExt; no World import, no randomness
// outside sim.rng, no wall clock.
import type { Vec3 } from '../../../core/math';
import type { Entity, EntityId, EntityKind } from '../../../core/types';
import { SIM_DT } from '../../../core/types';
import type { AbilityCtx, DamageRequest, SimApi } from '../../api';
import { ext } from '../../ext';
import { WALK_SPEED } from '../../physics';
import { alive, UNIT_KINDS, unitsAlongLine } from '../common';
import type { StrikeOpts } from '../common';

/** Units that fight (turrets excluded): the targets of slows / shouts. */
export const FIGHTER_KINDS: EntityKind[] = ['hero', 'troop', 'npc'];

/** Delay that lands a scheduled callback on the next sim tick. */
const NEXT_TICK = 0.001;

/** Alive, not dead and not downed. */
export const isUp = (e: Entity | undefined): e is Entity => alive(e) && !e.hero?.downed;

/** Horizontal distance. */
export const flatDist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Rooted (or stunned) heroes cannot use the movement part of an ability. */
export const isRooted = (sim: SimApi, e: Entity): boolean => sim.hasStatus(e.id, 'root') || sim.hasStatus(e.id, 'stun');

/**
 * A direct hit of the attacker (weapon shot or ability strike), as opposed to
 * a damage-over-time tick, reflect or thorns ('status:*' ability ids).
 */
export const isDirectHit = (req: DamageRequest): boolean => !(req.abilityId?.startsWith('status:') ?? false);

// ── the world's { t: 'ability' } event ──────────────────────────────────────
/** Where / at whom an activation really happened (for renderer + audio). */
export interface CastInfo {
  pos?: Vec3;
  target?: EntityId;
  dir?: Vec3;
}

/**
 * Record the real cast point / target / direction of this activation on the
 * ability context. The world emits the { t: 'ability' } event after
 * activate() returns true; with the SIM_REQUESTS "ability cast info" change it
 * uses ctx.cast instead of the raw crosshair (e.g. 八阵图 clamped to 30 m, the
 * ally 济民 actually resolved to). Harmless before that change lands.
 */
export function setCast(ctx: AbilityCtx, info: CastInfo): void {
  const c = ctx as AbilityCtx & { cast?: CastInfo };
  c.cast = { ...(c.cast ?? {}), ...copyCast(info) };
}

function copyCast(info: CastInfo): CastInfo {
  const out: CastInfo = {};
  if (info.pos) out.pos = { x: info.pos.x, y: info.pos.y, z: info.pos.z };
  if (info.target !== undefined) out.target = info.target;
  if (info.dir) out.dir = { x: info.dir.x, y: info.dir.y, z: info.dir.z };
  return out;
}

/**
 * Follow-up / passive trigger event (观星 pulse, 龙胆 empowered, 集智 refresh).
 * `privateTo` keeps hidden information to the caster's own client.
 */
export function emitAbility(sim: SimApi, src: Entity, ability: string, info: CastInfo & { privateTo?: EntityId } = {}): void {
  const ev = { t: 'ability' as const, src: src.id, ability, ...copyCast(info) };
  sim.emit(info.privateTo !== undefined ? { ...ev, privateTo: info.privateTo } : ev);
}

// ── targeting ───────────────────────────────────────────────────────────────
/**
 * The hero under the crosshair that you may support: your own side, or a hero
 * you have no known hostility with (hidden roles). Heroes you are fighting —
 * they hurt you recently, you are shooting them, or their role is known to be
 * hostile — never qualify, so bots aiming at their enemy fall back correctly.
 */
export function crosshairFriend(ctx: AbilityCtx, range: number, allowDowned: boolean): Entity | undefined {
  const { sim, self } = ctx;
  const t = sim.aimTarget(self, range, { kinds: ['hero'], exclude: [self.id] });
  if (!t || !t.hero || t.hero.dead || !t.alive) return undefined;
  if (!allowDowned && t.hero.downed) return undefined;
  if (sim.isOwnSide(self, t) || !sim.isHostileTo(self, t)) return t;
  return undefined;
}

/** Point `dist` m ahead of `from` along a flat direction. */
export function ahead(from: Vec3, dir: Vec3, dist: number): Vec3 {
  const l = Math.hypot(dir.x, dir.z) || 1;
  return { x: from.x + (dir.x / l) * dist, y: from.y, z: from.z + (dir.z / l) * dist };
}

/** Pick an id by weight with the host RNG (weights ≤ 0 are skipped). */
export function pickWeighted(sim: SimApi, table: [string, number][]): string | undefined {
  let total = 0;
  for (const [, w] of table) if (w > 0) total += w;
  if (!(total > 0)) return undefined;
  let r = sim.rng.next() * total;
  for (const [id, w] of table) {
    if (!(w > 0)) continue;
    r -= w;
    if (r < 0) return id;
  }
  return table.filter(([, w]) => w > 0).pop()?.[0];
}

/** Give an item, or drop it at the hero's feet when the slots are full. */
export function giveOrDrop(sim: SimApi, e: Entity, itemId: string): void {
  if (!sim.giveItem(e.id, itemId, 1)) sim.spawnLoot({ ...e.pos }, { itemId, count: 1 });
}

/**
 * For "no ammo use" buffs: an empty or reloading active weapon is loaded at
 * once, so the buff can be used right away.
 */
export function ensureLoaded(sim: SimApi, self: Entity): void {
  const h = self.hero;
  const x = ext(sim);
  const w = x.activeWeapon(self.id);
  if (!h || !w || w.def.melee || w.def.magSize <= 0) return;
  if (w.inst.mag <= 0 || h.reloadUntil > sim.time) x.refillMag(self.id);
}

// ── strikes ─────────────────────────────────────────────────────────────────
/**
 * Hit one unit (same semantics as common.ts strikes): damage + knockback +
 * status. Returns false when the hit was dodged, immune or cancelled by 无懈可击
 * (then the status / shove miss too).
 */
export function strikeUnit(sim: SimApi, src: Entity, t: Entity, o: StrikeOpts): boolean {
  if (o.heroesOnly && t.kind !== 'hero') return false;
  if (!t.alive || t.hero?.dead) return false;
  const forcedBefore = t.forced;
  if (o.damage > 0) {
    const r = sim.dealDamage({
      targetId: t.id,
      sourceId: src.id,
      amount: o.damage,
      type: o.dtype ?? 'melee',
      abilityId: o.abilityId,
      knockback: o.knockback,
      canDodge: o.canDodge,
      ignoreArmor: o.ignoreArmor,
      pos: sim.eyePos(t),
    });
    if (r.blocked === 'dodge' || r.blocked === 'invuln' || r.blocked === 'nullify') return false;
  } else if (o.knockback && o.knockback > 0) {
    const dx = t.pos.x - src.pos.x;
    const dz = t.pos.z - src.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    sim.knockback(t.id, { x: dx / l, y: 0, z: dz / l }, o.knockback);
  }
  // the shove landed (a new forced movement): end it where the data says
  if (t.forced && t.forced !== forcedBefore) brakeAfterForced(sim, t);
  if (o.status && t.alive) sim.applyStatus(t.id, o.status.id, o.status.duration, { sourceId: src.id, params: o.status.params });
  return true;
}

/**
 * Melee-style cone sweep (emits the 'melee' event like common.ts coneAttack)
 * whose knockbacks end where they should (strikeUnit → brakeAfterForced).
 * Returns the units hit.
 */
export function coneStrike(sim: SimApi, src: Entity, origin: Vec3, dir: Vec3, range: number, arcDeg: number, o: StrikeOpts): Entity[] {
  const l = Math.hypot(dir.x, dir.z) || 1;
  const flat = { x: dir.x / l, y: 0, z: dir.z / l };
  sim.emit({ t: 'melee', src: src.id, pos: { ...origin }, dir: flat, range, arc: arcDeg });
  const hit: Entity[] = [];
  for (const t of unitsInCone(sim, src, origin, flat, range, arcDeg, o.kinds ?? UNIT_KINDS)) {
    if (strikeUnit(sim, src, t, o)) hit.push(t);
  }
  return hit;
}

/**
 * Units in a flat cone in front of `origin` (no 'melee' event: shouts use the
 * ability VFX instead of a weapon slash). Dead / downed-and-dead filtered.
 */
export function unitsInCone(sim: SimApi, src: Entity, origin: Vec3, dir: Vec3, range: number, arcDeg: number, kinds: EntityKind[] = UNIT_KINDS): Entity[] {
  const l = Math.hypot(dir.x, dir.z) || 1;
  const flat = { x: dir.x / l, y: 0, z: dir.z / l };
  return sim
    .queryCone(origin, flat, range, ((arcDeg / 2) * Math.PI) / 180, { kinds, notFriendlyTo: src.id, exclude: [src.id] })
    .filter((t) => !t.hero?.dead);
}

// ── charges & forced movement ───────────────────────────────────────────────
export interface ChargeOpts {
  dir: Vec3;
  distance: number;
  /** nominal duration; rounded to whole sim ticks so `distance` is covered exactly */
  duration: number;
  /** i-frames during the dash (dodgeable hits) */
  invuln?: boolean;
  /** half-width of the damage corridor */
  width: number;
  /** damage every unit the charger passes (each at most once per cast) */
  strike?: StrikeOpts;
  onHit?: (sim: SimApi, self: Entity, t: Entity) => void;
  /** the charge completed (not interrupted by a knockback / teleport, caster still up) */
  onArrive?: (sim: SimApi, self: Entity) => void;
}

/**
 * The world leaves a unit with its forced velocity when a dash / knockback
 * ends, so it slides on for metres (GROUND_ACCEL braking; docs/SIM_REQUESTS.md
 * SHU-1). Called right after the last forced tick: cap the horizontal speed at
 * walking speed — exactly what SHU-1 does in the engine, so this becomes a
 * no-op once it lands.
 */
export function brake(e: Entity): void {
  const v = Math.hypot(e.vel.x, e.vel.z);
  if (v <= WALK_SPEED || v < 1e-6) return;
  e.vel.x *= WALK_SPEED / v;
  e.vel.z *= WALK_SPEED / v;
}

/** Sim time of the next tick, bit-identical to the world clock (tick × SIM_DT). */
const nextTickTime = (sim: SimApi): number => (sim.tick + 1) * SIM_DT;

/**
 * Was this tick the last one that moves a unit under `forced`? (the world
 * moves it on every tick with `time < forced.until`).
 */
const lastForcedTick = (sim: SimApi, forced: { until: number }): boolean => nextTickTime(sim) >= forced.until;

/**
 * SHU-1 workaround for victims: watch the unit's current forced movement (a
 * knockback that just landed) and brake it after its last tick. Stops watching
 * when that movement is replaced (another shove, a dash, a teleport) or the
 * unit dies. Scheduled callbacks run after every unit moved this tick.
 */
export function brakeAfterForced(sim: SimApi, e: Entity): void {
  const f = e.forced;
  if (!f) return;
  const check = (): void => {
    if (e.forced !== f || !e.alive || e.hero?.dead) return;
    if (lastForcedTick(sim, f)) brake(e);
    else sim.schedule(NEXT_TICK, check);
  };
  sim.schedule(0, check);
}

/**
 * Dash with a progressive damage corridor: every tick the segment travelled
 * since the last tick is swept, so units are hit as the charger passes them
 * (not only where they stand on arrival). The charge stops striking when the
 * caster goes down or its dash is overridden (knockback, teleport).
 *
 * Call it from activate(): the caster then moves on the cast tick already.
 * The duration is rounded to n whole ticks and handed to the world as
 * (n − ½) ticks (speed kept at distance / n ticks), so float rounding of
 * `until` can never add or drop a movement tick: the dash covers `distance`
 * exactly, then brakes. Returns the effective duration (n ticks).
 */
export function charge(ctx: AbilityCtx, o: ChargeOpts): number {
  const { sim, self } = ctx;
  const n = Math.max(1, Math.round(Math.max(SIM_DT, o.duration) / SIM_DT));
  const duration = (n - 0.5) * SIM_DT;
  const before = self.forced;
  if (o.distance > 0.05) sim.dash(self.id, o.dir, (o.distance * (n - 0.5)) / n, duration, { invuln: o.invuln });
  // undefined: no dash of ours is running (too short, or refused) — strike in place
  const dashState = self.forced !== before ? self.forced : undefined;
  const end = sim.time + duration;
  const hit = new Set<EntityId>([self.id]);
  let last = { ...self.pos };
  const step = (): void => {
    if (!isUp(self)) return;
    const running = dashState !== undefined && sim.time + 1e-6 < end;
    // overridden mid-way (knocked back, pulled, teleported): the charge is over
    if (running && self.forced !== dashState) return;
    const cur = { ...self.pos };
    if (o.strike) {
      for (const t of unitsAlongLine(sim, self, last, cur, o.width, { kinds: o.strike.kinds })) {
        if (hit.has(t.id)) continue;
        hit.add(t.id);
        if (strikeUnit(sim, self, t, o.strike)) o.onHit?.(sim, self, t);
      }
    }
    last = cur;
    if (running) {
      // the dash's last movement tick has run: stop the post-dash slide
      if (lastForcedTick(sim, dashState)) brake(self);
      sim.schedule(NEXT_TICK, step);
    } else {
      o.onArrive?.(sim, self);
    }
  };
  sim.schedule(0, step);
  return n * SIM_DT;
}
