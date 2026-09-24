// Shared helpers for the 吴 Wu ability implementations (abilities/wu/*.ts).
// Everything goes through SimApi / SimExt (never World), stays deterministic
// (host RNG, sim time) and tolerates dead / downed / vanished entities.
import type { Vec3 } from '../../../core/math';
import type { DamageType, Entity, EntityId, EntityKind, StatusId } from '../../../core/types';
import { rollRewardItems } from '../../../data/loot';
import type { AbilityCtx, SimApi } from '../../api';
import { maxReserve, usesAmmo, weaponDef } from '../../defs';
import { ext } from '../../ext';
import { registerHazardKind } from '../../hazards';
import { UNIT_KINDS, alive } from '../common';

/** Default dodge-roll charges (world.ts BASE_DODGE_CHARGES). */
export const BASE_DODGE_CHARGES = 2;

/** Alive, not dead and not downed (濒死): able to act / be buffed meaningfully. */
export const isUp = (e: Entity | undefined): boolean => alive(e) && !e.hero?.downed;

/** Chest-height point of an entity (SimApi has eyePos only). */
export function centerOf(e: Entity): Vec3 {
  const h = e.hero?.downed ? 0.3 : e.height * 0.55;
  return { x: e.pos.x, y: e.pos.y + h, z: e.pos.z };
}

/** Per-world scratch state for module-level bookkeeping (never shared between worlds). */
export function perSim<T>(store: WeakMap<SimApi, T>, sim: SimApi, make: () => T): T {
  let v = store.get(sim);
  if (v === undefined) {
    v = make();
    store.set(sim, v);
  }
  return v;
}

/** State written by another ability of the same hero (e.g. 燎原 read from 火烧连营). */
export function otherAbilityState(self: Entity, abilityId: string, key: string, fallback = 0): number {
  const v = self.hero?.abilityState[`${abilityId}:${key}`];
  return v === undefined ? fallback : v;
}

/** Params of another ability of the caster's hero (data-driven fallbacks). */
export function otherAbilityParam(ctx: AbilityCtx, abilityId: string, key: string, fallback: number): number {
  const v = ctx.hero.abilities.find((a) => a.id === abilityId)?.params[key];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
}

// ── 无懈可击 / 谦逊 aware debuffs ─────────────────────────────────────────────
function nullifyCharges(sim: SimApi, e: Entity): number {
  let n = 0;
  for (const s of e.statuses) if (s.id === 'nullify' && s.until > sim.time) n += s.stacks ?? 1;
  return n;
}

/**
 * landed    — the status is on the target;
 * nullified — 无懈可击 cancelled the effect (the card is spent: start the cooldown);
 * resisted  — the target is immune (陆逊 谦逊) or otherwise not affectable: like 三国杀,
 *             such a target cannot be chosen, so the caster keeps the ability.
 */
export type DebuffOutcome = 'landed' | 'nullified' | 'resisted';

export function applyDebuff(ctx: AbilityCtx, target: Entity, id: StatusId, duration: number, params?: Record<string, number>): DebuffOutcome {
  const { sim, self } = ctx;
  if (!alive(target)) return 'resisted';
  const before = nullifyCharges(sim, target);
  if (sim.applyStatus(target.id, id, duration, { sourceId: self.id, params })) return 'landed';
  return nullifyCharges(sim, target) < before ? 'nullified' : 'resisted';
}

// ── targeting ───────────────────────────────────────────────────────────────
/**
 * Enemy (not own side) under the crosshair that is standing (not downed):
 * heroes first (the crosshair looks through soldiers for a hero), then any
 * unit of `kinds`. Downed units are skipped so a crawling body never eats the cast.
 */
export function crosshairFoe(ctx: AbilityCtx, range: number, kinds: EntityKind[] = UNIT_KINDS): Entity | undefined {
  const { sim, self } = ctx;
  const heroFirst = kinds.includes('hero') && kinds.length > 1;
  const passes: EntityKind[][] = heroFirst ? [['hero'], kinds] : [kinds];
  for (const k of passes) {
    const exclude: EntityId[] = [];
    for (let i = 0; i < 3; i++) {
      const t = sim.aimTarget(self, range, { kinds: k, notFriendlyTo: self.id, exclude });
      if (!t) break;
      if (isUp(t)) return t;
      exclude.push(t.id);
    }
  }
  return undefined;
}

// ── items / ammo ────────────────────────────────────────────────────────────
/**
 * "Gain N random items": reward-table items into the hero's slots (overflow
 * drops at the feet). Each gain is announced privately (a drawn card is hidden).
 */
export function grantItems(sim: SimApi, hero: Entity, n: number): string[] {
  const count = Math.max(0, Math.floor(n));
  if (count <= 0 || !hero.hero || hero.hero.dead) return [];
  const ids = rollRewardItems(sim.rng, count);
  for (const id of ids) {
    if (!sim.giveItem(hero.id, id, 1)) sim.spawnLoot(hero.pos, { itemId: id, count: 1 });
    sim.emit({ t: 'pickup', who: hero.id, item: id, privateTo: hero.id });
  }
  return ids;
}

/** Instant reload of every weapon: reserve → magazine, cancelling a reload in progress. */
export function reloadAllFromReserve(hero: Entity): void {
  const h = hero.hero;
  if (!h) return;
  for (const wi of h.weapons) {
    if (!wi) continue;
    const def = weaponDef(wi.id);
    if (!usesAmmo(def)) continue;
    const take = Math.max(0, Math.min(def.magSize - wi.mag, wi.reserve));
    wi.mag += take;
    wi.reserve -= take;
  }
  h.reloadUntil = 0;
}

/** Full ammo: every weapon's magazine and reserve topped up (free ammo). */
export function fillAllAmmo(sim: SimApi, hero: Entity): void {
  const h = hero.hero;
  if (!h) return;
  for (const wi of h.weapons) {
    if (!wi) continue;
    const def = weaponDef(wi.id);
    if (!usesAmmo(def)) continue;
    wi.mag = def.magSize;
    wi.reserve = Math.max(wi.reserve, maxReserve(def));
  }
  h.reloadUntil = 0;
  void sim;
}

/** Refill the dodge-roll charges to the hero's normal maximum (never lowers a 闪 surplus). */
export function refillDodges(sim: SimApi, hero: Entity): void {
  const h = hero.hero;
  if (!h) return;
  const max = BASE_DODGE_CHARGES + ext(sim).modifiers(hero.id).extraDodgeCharges;
  if (h.dodgeCharges < max) h.dodgeCharges = max;
  h.dodgeRechargeAt = 0;
}

// ── scheduling ──────────────────────────────────────────────────────────────
/**
 * Poll every tick until `proj` is gone (contact, wall, expiry), then call
 * `onGone` with its last position. Runs even if the owner died meanwhile.
 * A projectile that outlives `maxLife` (+ slack) is removed first.
 */
export function whenProjectileGone(sim: SimApi, proj: Entity, maxLife: number, onGone: (pos: Vec3) => void): void {
  const deadline = sim.time + Math.max(0, maxLife) + 0.5;
  const poll = (): void => {
    const live = proj.alive && sim.get(proj.id) === proj;
    if (live && sim.time < deadline) {
      sim.schedule(0, poll);
      return;
    }
    if (live) sim.removeEntity(proj.id);
    onGone({ x: proj.pos.x, y: proj.pos.y, z: proj.pos.z });
  };
  sim.schedule(0, poll);
}

// ── events ──────────────────────────────────────────────────────────────────
export interface CastInfo {
  pos?: Vec3;
  target?: EntityId;
  dir?: Vec3;
}

/**
 * Where the cast really happened, for the world's { t: 'ability' } event (same
 * `ctx.cast` convention as Shu/Qun — docs/SIM_REQUESTS.md SHU-3). Until the
 * world reads it the event keeps its defaults (aim point / aim id / aim ray).
 */
export function setCast(ctx: AbilityCtx, info: CastInfo): void {
  const c = ctx as AbilityCtx & { cast?: CastInfo };
  const next: CastInfo = { ...(c.cast ?? {}) };
  if (info.pos) next.pos = { x: info.pos.x, y: info.pos.y, z: info.pos.z };
  if (info.target !== undefined) next.target = info.target;
  if (info.dir) next.dir = { x: info.dir.x, y: info.dir.y, z: info.dir.z };
  c.cast = next;
}

/**
 * 'ability' event for a passive trigger (activations are emitted by the world).
 * Hidden information stays with its owner: `privateTo`, and always while the
 * hero is stealthed (a public flourish would give his position away).
 */
export function emitTrigger(ctx: AbilityCtx, o: { target?: EntityId; pos?: Vec3; privateTo?: EntityId } = {}): void {
  const { sim, self } = ctx;
  const ev = { t: 'ability' as const, src: self.id, ability: ctx.def.id, pos: o.pos ?? centerOf(self), target: o.target };
  const to = o.privateTo ?? (sim.hasStatus(self.id, 'stealth') ? self.id : undefined);
  sim.emit(to !== undefined ? { ...ev, privateTo: to } : ev);
}

// ── burning fields ──────────────────────────────────────────────────────────
const burnedAt = new WeakMap<SimApi, Map<string, number>>();

/**
 * Register a damage-field hazard kind (params.damage per tick, `dtype`) whose
 * fields of one owner don't stack: a unit standing where several of them
 * overlap (a line of fields laid by one cast) burns once per tick. Owner-side
 * units, and units on another floor (fields on a roof), are never hurt. Ticks are periodic (never consume 无懈可击). Kind names
 * contain 'fire' / 'napalm' so the renderer draws them as fire.
 */
export function registerFieldKind(kind: string, dtype: DamageType): void {
  registerHazardKind({
    kind,
    tick(sim, hz, affected) {
      const dmg = hz.hazard?.params.damage ?? 0;
      if (!(dmg > 0)) return true;
      const x = ext(sim);
      const owner = x.creditOf(hz.ownerId);
      const seen = perSim(burnedAt, sim, () => new Map<string, number>());
      if (seen.size > 1024) for (const [k, t] of seen) if (t < sim.tick) seen.delete(k);
      const fy = hz.pos.y;
      for (const u of affected) {
        if (!u.alive || u.hero?.dead) continue;
        if (owner !== undefined && x.creditOf(u.id) === owner) continue;
        // a ground fire: nobody on the floor below (napalm on a roof) or high above it burns
        if (u.pos.y > fy + 2 || u.pos.y + u.height < fy - 0.5) continue;
        const key = `${kind}:${hz.ownerId ?? -1}:${u.id}`;
        if (seen.get(key) === sim.tick) continue;
        seen.set(key, sim.tick);
        sim.dealDamage({ targetId: u.id, sourceId: hz.ownerId, amount: dmg, type: dtype, canDodge: false, abilityId: kind, pos: centerOf(u) });
      }
      return true;
    },
  });
}
