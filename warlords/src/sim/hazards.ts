// Area hazards (fire fields, lightning clouds, traps, heal zones, arrow rain…).
//
// Generic behaviour, driven by HazardSpec.params (all per tick of `tickEvery`):
//   damage   damage to every affected unit (HazardSpec.dtype, default 'fire')
//   strike   damage to ONE random affected unit + a 'thunder' explosion event
//   heal     heal every non-hostile unit (owner side + heroes the owner has no
//            known hostility to); healAll=1 heals everyone in range
//   slow     apply `slow` (amount) for a little longer than one tick
//   seek     m/s: drift toward the nearest living hero (闪电 storm cloud)
//   HazardSpec.status  status applied to every affected unit
//   HazardSpec.triggerOnce  first enemy unit inside triggers everything once, then it expires
//   HazardSpec.followId     hazard follows that entity
//   group    fields of one cast that share (owner, group) do not stack: a unit
//            standing where several overlap is damaged by one of them per tick
// Owner-side units are unaffected by damage/status unless affectsOwner.
// A field only reaches units on its own floor: nobody under a roof it burns on,
// nobody on a roof above it (see onFieldFloor).
// Wave-2 code can register custom per-kind logic with registerHazardKind().
// 无懈可击: lingering field ticks (damage / slow / status, custom kind ticks)
// neither consume nor are blocked by nullify; discrete effects — a trap
// springing (triggerOnce) or a lightning strike — are ability effects and do.
import type { DamageType, Entity, StatusId } from '../core/types';
import type { HazardSpec, SimApi } from './api';
import { warnOnce } from './defs';
import { isDebuff } from './ext';
import { groundAt } from './physics';
import type { World } from './world';

export interface HazardRuntime {
  dtype: DamageType;
  status?: { id: StatusId; duration: number; params?: Record<string, number> };
  affectsOwner: boolean;
  triggerOnce: boolean;
}

/** What a custom kind's tick may need from the hazard's spec (private runtime otherwise). */
export interface HazardTickInfo {
  dtype: DamageType;
  status?: { id: StatusId; duration: number; params?: Record<string, number> };
  affectsOwner: boolean;
  triggerOnce: boolean;
}

export interface HazardKindImpl {
  kind: string;
  /**
   * called each hazard tick with the units inside (on the field's floor); return
   * true to skip the generic behaviour. Runs as a periodic area tick (never
   * consumes 无懈可击) unless `discrete`.
   */
  tick?(sim: SimApi, hazard: Entity, affected: Entity[], rt: HazardTickInfo): boolean | void;
  /**
   * the tick is a discrete trick (a trap springing, a lightning bolt): its hostile
   * effects consume / are cancelled by 无懈可击 like an ability's
   */
  discrete?: boolean;
  /** units stepping in are hurt / hindered (HazardState.harmful for brains) even without generic params */
  harmful?: boolean;
  /** called every sim tick (movement etc.) */
  update?(sim: SimApi, hazard: Entity, dt: number): void;
  onExpire?(sim: SimApi, hazard: Entity): void;
}

const KINDS = new Map<string, HazardKindImpl>();

export function registerHazardKind(impl: HazardKindImpl): void {
  KINDS.set(impl.kind, impl);
}

export function getHazardKind(kind: string): HazardKindImpl | undefined {
  return KINDS.get(kind);
}

const UNIT_KINDS: Entity['kind'][] = ['hero', 'troop', 'npc', 'turret'];

/**
 * Does a field of this spec hurt / hinder units (HazardState.harmful, AI-3)?
 * damage / strike / slow params, a debuff status, or a custom kind flagged harmful.
 */
export function hazardIsHarmful(spec: HazardSpec): boolean {
  const p = spec.params ?? {};
  if ((p.damage ?? 0) > 0 || (p.strike ?? 0) > 0 || (p.slow ?? 0) > 0 || (p.dps ?? 0) > 0) return true;
  if (spec.status && isDebuff(spec.status.id)) return true;
  return KINDS.get(spec.kind)?.harmful === true;
}

/**
 * Is `u` on the field's own floor? The surface the field would lie on at the
 * unit's spot (terrain, or a roof / deck no higher than the field + 2 m) must be
 * under the unit's feet: nobody under a burning roof, nobody on a roof above a
 * ground fire, while hillsides and low crates stay inside.
 */
function onFieldFloor(w: World, h: Entity, u: Entity): boolean {
  const surf = groundAt(w.cw, u.pos.x, u.pos.z, h.pos.y + 2);
  return u.pos.y >= surf - 0.6 && u.pos.y <= surf + 2.5;
}

/** Per world: units already damaged this tick by a field of (owner, group). */
const groupHits = new WeakMap<World, { tick: number; hit: Set<string> }>();

function groupHitSet(w: World): Set<string> {
  let g = groupHits.get(w);
  if (!g) {
    g = { tick: w.tick, hit: new Set() };
    groupHits.set(w, g);
  }
  if (g.tick !== w.tick) {
    g.tick = w.tick;
    g.hit.clear();
  }
  return g.hit;
}

export function hazardRuntimeFrom(spec: HazardSpec): HazardRuntime {
  return {
    dtype: spec.dtype ?? (spec.kind === 'lightningCloud' || spec.kind === 'shandian' ? 'thunder' : 'fire'),
    status: spec.status,
    affectsOwner: spec.affectsOwner === true,
    triggerOnce: spec.triggerOnce === true,
  };
}

/** Run a custom kind hook, isolated, with the hazard's owner as the acting hero. */
function safeKind<T>(w: World, h: Entity, impl: HazardKindImpl, fn: () => T): T | undefined {
  const prev = w.actorId;
  w.actorId = w.creditOf(h.ownerId);
  try {
    return fn();
  } catch (err) {
    warnOnce(`hazard:${impl.kind}`, `hazard kind '${impl.kind}' threw: ${String(err)}`);
    return undefined;
  } finally {
    w.actorId = prev;
  }
}

/** Periodic area effects: never consume 无懈可击 (see header). */
function periodic(w: World, fn: () => void): void {
  w.periodicDepth++;
  try {
    fn();
  } finally {
    w.periodicDepth--;
  }
}

export function updateHazards(w: World, list: readonly Entity[], dt: number): void {
  const now = w.time;
  for (const h of list) {
    const hz = h.hazard;
    if (!h.alive || !hz) continue;
    const impl = KINDS.get(hz.kind);
    if (now + 1e-9 >= hz.expiresAt) {
      if (impl?.onExpire) safeKind(w, h, impl, () => impl.onExpire!(w, h));
      w.removeEntity(h.id);
      continue;
    }
    // follow / seek
    if (hz.followId !== undefined) {
      const f = w.get(hz.followId);
      if (f && f.alive && !f.hero?.dead) {
        h.pos.x = f.pos.x;
        h.pos.y = f.pos.y;
        h.pos.z = f.pos.z;
      }
    }
    const seek = hz.params.seek ?? 0;
    if (seek > 0) seekNearestHero(w, h, seek, dt);
    if (impl?.update) safeKind(w, h, impl, () => impl.update!(w, h, dt));
    if (now + 1e-9 < hz.nextTickAt) continue;
    hz.nextTickAt += Math.max(0.05, hz.tickEvery);
    const rt = w.hazardRt.get(h.id) ?? { dtype: 'fire' as DamageType, affectsOwner: false, triggerOnce: false };
    const owner = h.ownerId;
    const ownerCredit = w.creditOf(owner);
    const inside = w.queryRadius(h.pos, hz.radius, { kinds: UNIT_KINDS }).filter((u) => !u.hero?.dead && onFieldFloor(w, h, u));
    const enemies = inside.filter(
      (u) => rt.affectsOwner || ownerCredit === undefined || w.creditOf(u.id) !== ownerCredit,
    );
    if (impl?.tick) {
      let skip: boolean | void | undefined;
      const info: HazardTickInfo = { dtype: rt.dtype, status: rt.status, affectsOwner: rt.affectsOwner, triggerOnce: rt.triggerOnce };
      const run = (): void => {
        skip = safeKind(w, h, impl, () => impl.tick!(w, h, inside, info));
      };
      if (impl.discrete) run();
      else periodic(w, run);
      if (skip) continue;
    }
    if (rt.triggerOnce) {
      if (enemies.length === 0) continue;
      applyHazardEffects(w, h, rt, enemies, inside);
      w.removeEntity(h.id);
      continue;
    }
    applyHazardEffects(w, h, rt, enemies, inside);
  }
}

function applyHazardEffects(w: World, h: Entity, rt: HazardRuntime, enemies: Entity[], inside: Entity[]): void {
  const hz = h.hazard!;
  const p = hz.params;
  const owner = h.ownerId;
  // a trap springing once is a discrete trick (nullify applies); a lingering field is not
  if (rt.triggerOnce) fieldEffects(w, h, rt, enemies, inside);
  else periodic(w, () => fieldEffects(w, h, rt, enemies, inside));
  if ((p.strike ?? 0) > 0 && enemies.length > 0) {
    const victim = enemies[Math.floor(w.rng.next() * enemies.length)];
    if (victim.alive) {
      w.emit({ t: 'explosion', pos: { x: victim.pos.x, y: victim.pos.y, z: victim.pos.z }, radius: 1.5, kind: 'thunder' });
      w.dealDamage({ targetId: victim.id, sourceId: owner, amount: p.strike, type: 'thunder', canDodge: false, abilityId: hz.kind, pos: w.centerOf(victim) });
      if ((p.stun ?? 0) > 0 && victim.alive) w.applyStatus(victim.id, 'stun', p.stun, { sourceId: owner });
    }
  }
}

/** damage / heal / slow / status to everything inside (see applyHazardEffects). */
function fieldEffects(w: World, h: Entity, rt: HazardRuntime, enemies: Entity[], inside: Entity[]): void {
  const hz = h.hazard!;
  const p = hz.params;
  const owner = h.ownerId;
  if ((p.damage ?? 0) > 0) {
    // fields of one cast (same owner + params.group) don't stack where they overlap
    const group = p.group;
    const seen = group !== undefined ? groupHitSet(w) : undefined;
    const gk = seen ? `${owner ?? -1}|${group}|` : '';
    for (const u of enemies) {
      if (seen) {
        const k = gk + u.id;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      w.dealDamage({ targetId: u.id, sourceId: owner, amount: p.damage, type: rt.dtype, canDodge: false, abilityId: hz.kind, pos: w.centerOf(u) });
    }
  }
  if ((p.heal ?? 0) > 0) {
    const ownerEnt = owner !== undefined ? w.get(owner) : undefined;
    for (const u of inside) {
      if (!u.alive) continue;
      const ok = (p.healAll ?? 0) > 0 || !ownerEnt || w.isOwnSide(ownerEnt, u) || !w.isHostileTo(ownerEnt, u);
      if (ok) w.heal(u.id, p.heal, owner);
    }
  }
  if ((p.slow ?? 0) > 0) {
    for (const u of enemies) if (u.alive) w.applyStatus(u.id, 'slow', hz.tickEvery + 0.3, { sourceId: owner, params: { amount: p.slow } });
  }
  if (rt.status) {
    for (const u of enemies) {
      if (u.alive) w.applyStatus(u.id, rt.status.id, rt.status.duration, { sourceId: owner, params: rt.status.params });
    }
  }
}

function seekNearestHero(w: World, h: Entity, speed: number, dt: number): void {
  let best: Entity | undefined;
  let bd = 80;
  for (const e of w.heroList()) {
    if (e.hero!.dead) continue;
    const d = Math.hypot(e.pos.x - h.pos.x, e.pos.z - h.pos.z);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  if (!best || bd < 0.3) return;
  const step = Math.min(bd, speed * dt);
  h.pos.x += ((best.pos.x - h.pos.x) / bd) * step;
  h.pos.z += ((best.pos.z - h.pos.z) / bd) * step;
  h.pos.y = w.groundHeight(h.pos.x, h.pos.z);
}
