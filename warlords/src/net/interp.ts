// Interpolation helpers shared by LocalView and ClientView.
//
// Both views produce one ViewEntity per entity per render frame. To keep the
// render loop free of garbage (~170 entities × 60 fps), output objects are
// pooled per entity id and updated in place (ViewEntityPool). An object is
// dropped from the pool — never recycled for another id — when its entity
// disappears, so a consumer that keeps a reference to a removed entity (e.g.
// a corpse animation) keeps seeing its final state.
import { lerp, lerpAngle, wrapAngle } from '../core/math';
import type { EntityId, ViewEntity, ZoneView } from '../core/types';

/** Beyond this horizontal jump (m) between two states an entity snaps instead of sliding. */
export const TELEPORT_DISTANCE = 30;

// Exhaustive at compile time: adding a field to ViewEntity without handling it
// in copyEntityInto fails tsc here.
const VIEW_ENTITY_FIELDS: Record<keyof ViewEntity, true> = {
  id: true, kind: true, sub: true, x: true, y: true, z: true, yaw: true, pitch: true, speed: true,
  hp: true, maxHp: true, shield: true, flags: true, kingdom: true, owner: true, weapon: true, armor: true,
  mount: true, radius: true, role: true, claim: true, name: true,
};
export const VIEW_ENTITY_FIELD_COUNT = Object.keys(VIEW_ENTITY_FIELDS).length;

/** Copy every field of `src` into `out` in place; optional fields `src` lacks are removed. */
export function copyEntityInto(out: ViewEntity, src: ViewEntity): ViewEntity {
  out.id = src.id;
  out.kind = src.kind;
  out.sub = src.sub;
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  out.yaw = src.yaw;
  out.pitch = src.pitch;
  out.speed = src.speed;
  out.hp = src.hp;
  out.maxHp = src.maxHp;
  out.shield = src.shield;
  out.flags = src.flags;
  // optional fields: assign when present, delete only when they went away (rare)
  if (src.kingdom !== undefined) out.kingdom = src.kingdom;
  else if (out.kingdom !== undefined) delete out.kingdom;
  if (src.owner !== undefined) out.owner = src.owner;
  else if (out.owner !== undefined) delete out.owner;
  if (src.weapon !== undefined) out.weapon = src.weapon;
  else if (out.weapon !== undefined) delete out.weapon;
  if (src.armor !== undefined) out.armor = src.armor;
  else if (out.armor !== undefined) delete out.armor;
  if (src.mount !== undefined) out.mount = src.mount;
  else if (out.mount !== undefined) delete out.mount;
  if (src.radius !== undefined) out.radius = src.radius;
  else if (out.radius !== undefined) delete out.radius;
  if (src.role !== undefined) out.role = src.role;
  else if (out.role !== undefined) delete out.role;
  if (src.claim !== undefined) out.claim = src.claim;
  else if (out.claim !== undefined) delete out.claim;
  if (src.name !== undefined) out.name = src.name;
  else if (out.name !== undefined) delete out.name;
  return out;
}

/** `out` = entity `b` with its continuous fields blended from `a` (t = 0 → a, 1 → b). */
export function lerpEntityInto(out: ViewEntity, a: ViewEntity, b: ViewEntity, t: number): ViewEntity {
  copyEntityInto(out, b);
  // teleports / respawns: don't smear across the map
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (dx * dx + dz * dz > TELEPORT_DISTANCE * TELEPORT_DISTANCE) return out;
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  out.z = lerp(a.z, b.z, t);
  out.yaw = wrapAngle(lerpAngle(a.yaw, b.yaw, t));
  out.pitch = lerp(a.pitch, b.pitch, t);
  out.speed = lerp(a.speed, b.speed, t);
  return out;
}

/** Entity `b` with its continuous fields blended from `a` (allocating variant). */
export function lerpEntity(a: ViewEntity, b: ViewEntity, t: number): ViewEntity {
  return lerpEntityInto(blankEntity(b.id), a, b, t);
}

const blankEntity = (id: EntityId): ViewEntity => ({
  id,
  kind: 'hero',
  sub: '',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  speed: 0,
  hp: 0,
  maxHp: 0,
  shield: 0,
  flags: 0,
});

interface PoolSlot {
  v: ViewEntity;
  gen: number;
}

/**
 * Per-id pool of output ViewEntities. Per frame: begin(), take(id) for every
 * entity (in draw order), end(). `list` and get() then describe this frame.
 */
export class ViewEntityPool {
  /** this frame's entities, in take() order (the array itself is reused) */
  readonly list: ViewEntity[] = [];
  private readonly slots = new Map<EntityId, PoolSlot>();
  private gen = 0;

  begin(): void {
    this.gen++;
    this.list.length = 0;
  }

  /** The reusable output object for `id` (contents are stale until written). */
  take(id: EntityId): ViewEntity {
    let s = this.slots.get(id);
    if (!s) {
      s = { v: blankEntity(id), gen: this.gen };
      this.slots.set(id, s);
    } else if (s.gen === this.gen) {
      return s.v; // duplicate id in one frame: keep a single object
    }
    s.gen = this.gen;
    this.list.push(s.v);
    return s.v;
  }

  /** Drop the entities that were not taken this frame. */
  end(): void {
    for (const [id, s] of this.slots) if (s.gen !== this.gen) this.slots.delete(id);
  }

  get(id: EntityId): ViewEntity | undefined {
    const s = this.slots.get(id);
    return s && s.gen === this.gen ? s.v : undefined;
  }

  get size(): number {
    return this.slots.size;
  }

  clear(): void {
    this.slots.clear();
    this.list.length = 0;
  }
}

/** `out` = zone `b` with center/radius blended from `a` (in place). */
export function lerpZoneInto(out: ZoneView, a: ZoneView, b: ZoneView, t: number): ZoneView {
  out.phase = b.phase;
  out.targetCenter.x = b.targetCenter.x;
  out.targetCenter.y = b.targetCenter.y;
  out.targetCenter.z = b.targetCenter.z;
  out.targetRadius = b.targetRadius;
  out.shrinkStart = b.shrinkStart;
  out.shrinkEnd = b.shrinkEnd;
  out.dps = b.dps;
  if (a.phase !== b.phase) {
    out.center.x = b.center.x;
    out.center.y = b.center.y;
    out.center.z = b.center.z;
    out.radius = b.radius;
    return out;
  }
  out.center.x = lerp(a.center.x, b.center.x, t);
  out.center.y = lerp(a.center.y, b.center.y, t);
  out.center.z = lerp(a.center.z, b.center.z, t);
  out.radius = lerp(a.radius, b.radius, t);
  return out;
}

export function lerpZone(a: ZoneView, b: ZoneView, t: number): ZoneView {
  return lerpZoneInto(emptyZone(), a, b, t);
}

export const emptyZone = (): ZoneView => ({
  phase: 0,
  center: { x: 0, y: 0, z: 0 },
  radius: 1000,
  targetCenter: { x: 0, y: 0, z: 0 },
  targetRadius: 1000,
  shrinkStart: 0,
  shrinkEnd: 0,
  dps: 0,
});

/** Cap for undrained event queues (e.g. a background tab where nobody drains). */
export const MAX_QUEUED_EVENTS = 4000;
