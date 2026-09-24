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
// Owner-side units are unaffected by damage/status unless affectsOwner.
// Wave-2 code can register custom per-kind logic with registerHazardKind().
// 无懈可击: lingering field ticks (damage / slow / status, custom kind ticks)
// neither consume nor are blocked by nullify; discrete effects — a trap
// springing (triggerOnce) or a lightning strike — are ability effects and do.
import type { DamageType, Entity, StatusId } from '../core/types';
import type { HazardSpec, SimApi } from './api';
import { warnOnce } from './defs';
import type { World } from './world';

export interface HazardRuntime {
  dtype: DamageType;
  status?: { id: StatusId; duration: number; params?: Record<string, number> };
  affectsOwner: boolean;
  triggerOnce: boolean;
}

export interface HazardKindImpl {
  kind: string;
  /** called each hazard tick with the units inside; return true to skip the generic behaviour */
  tick?(sim: SimApi, hazard: Entity, affected: Entity[]): boolean | void;
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
    const inside = w.queryRadius(h.pos, hz.radius, { kinds: UNIT_KINDS }).filter((u) => !u.hero?.dead);
    const enemies = inside.filter(
      (u) => rt.affectsOwner || ownerCredit === undefined || w.creditOf(u.id) !== ownerCredit,
    );
    if (impl?.tick) {
      let skip: boolean | void | undefined;
      periodic(w, () => {
        skip = safeKind(w, h, impl, () => impl.tick!(w, h, inside));
      });
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
    for (const u of enemies) {
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
