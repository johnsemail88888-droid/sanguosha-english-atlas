// Reusable building blocks for hero abilities (wave-2 ability engineers use
// these instead of re-implementing targeting, sweeps, dashes and summons).
// Everything goes through SimApi / SimExt, never through World directly.
import type { Vec3 } from '../../core/math';
import type { DamageType, Entity, EntityId, EntityKind, StatusId } from '../../core/types';
import type { AbilityCtx, QueryFilter, SimApi } from '../api';
import { ext } from '../ext';

export const UNIT_KINDS: EntityKind[] = ['hero', 'troop', 'npc', 'turret'];

export interface StatusSpec {
  id: StatusId;
  duration: number;
  params?: Record<string, number>;
}

export interface StrikeOpts {
  damage: number;
  dtype?: DamageType;
  abilityId?: string;
  knockback?: number;
  status?: StatusSpec;
  canDodge?: boolean;
  ignoreArmor?: boolean;
  kinds?: EntityKind[];
  exclude?: EntityId[];
  /** only heroes (e.g. stun heroes differently from troops) */
  heroesOnly?: boolean;
}

// ── state helpers ───────────────────────────────────────────────────────────
/** Namespaced numeric per-ability state on the hero (visible in the HUD's abilityState). */
export function getState(ctx: AbilityCtx, key: string, fallback = 0): number {
  const v = ctx.self.hero?.abilityState[`${ctx.def.id}:${key}`];
  return v === undefined ? fallback : v;
}

export function setState(ctx: AbilityCtx, key: string, value: number): void {
  if (ctx.self.hero) ctx.self.hero.abilityState[`${ctx.def.id}:${key}`] = value;
}

/** Ability tunable with fallback (AbilityDef.params). */
export const param = (ctx: AbilityCtx, key: string, fallback: number): number => {
  const v = ctx.def.params[key];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
};

export const alive = (e: Entity | undefined): e is Entity => !!e && e.alive && !e.hero?.dead;

// ── aiming ──────────────────────────────────────────────────────────────────
/** World point under the crosshair (clamped to range). */
export function crosshairPoint(ctx: AbilityCtx, range: number): Vec3 {
  return ctx.sim.aimPoint(ctx.self, range);
}

/** Normalised direction from the hero's eye toward the crosshair point. */
export function aimDir(ctx: AbilityCtx, range = 80): Vec3 {
  const eye = ctx.sim.eyePos(ctx.self);
  const p = ctx.sim.aimPoint(ctx.self, range);
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  const dz = p.z - eye.z;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-3) return ctx.sim.aimRay(ctx.self).dir;
  return { x: dx / l, y: dy / l, z: dz / l };
}

/** Horizontal aim direction (for dashes, sweeps, lines). */
export function flatAimDir(ctx: AbilityCtx): Vec3 {
  const yaw = ctx.input.yaw;
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  return { x, y: 0, z };
}

/** Enemy (anything not on your own side) under the crosshair. */
export function crosshairEnemy(ctx: AbilityCtx, range: number, kinds: EntityKind[] = UNIT_KINDS): Entity | undefined {
  return ctx.sim.aimTarget(ctx.self, range, { kinds, notFriendlyTo: ctx.self.id });
}

export function crosshairEnemyHero(ctx: AbilityCtx, range: number): Entity | undefined {
  return crosshairEnemy(ctx, range, ['hero']);
}

/**
 * Ally under the crosshair: a hero/troop that is not known-hostile, else
 * yourself when `fallbackSelf`.
 */
export function crosshairAlly(ctx: AbilityCtx, range: number, fallbackSelf = true, kinds: EntityKind[] = ['hero', 'troop']): Entity | undefined {
  const t = ctx.sim.aimTarget(ctx.self, range, { kinds, exclude: [ctx.self.id] });
  if (t && (ctx.sim.isOwnSide(ctx.self, t) || !ctx.sim.isHostileTo(ctx.self, t))) return t;
  return fallbackSelf ? ctx.self : undefined;
}

// ── area queries ────────────────────────────────────────────────────────────
export function enemiesInRadius(sim: SimApi, self: Entity, center: Vec3, r: number, kinds: EntityKind[] = UNIT_KINDS): Entity[] {
  return sim.queryRadius(center, r, { kinds, notFriendlyTo: self.id }).filter((e) => !e.hero?.dead);
}

/** Own side + heroes this hero has no known hostility with. */
export function alliesInRadius(sim: SimApi, self: Entity, center: Vec3, r: number, kinds: EntityKind[] = ['hero', 'troop']): Entity[] {
  return sim
    .queryRadius(center, r, { kinds })
    .filter((e) => !e.hero?.dead && (sim.isOwnSide(self, e) || (e.kind === 'hero' && !sim.isHostileTo(self, e))));
}

// ── strikes ─────────────────────────────────────────────────────────────────
function strikeOne(sim: SimApi, src: Entity, t: Entity, o: StrikeOpts, pos?: Vec3): boolean {
  if (o.heroesOnly && t.kind !== 'hero') return false;
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
      pos,
    });
    // dodged, immune or cancelled by 无懈可击: the strike's status / shove miss too
    if (r.blocked === 'dodge' || r.blocked === 'invuln' || r.blocked === 'nullify') return false;
  } else if (o.knockback && o.knockback > 0) {
    const dx = t.pos.x - src.pos.x;
    const dz = t.pos.z - src.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    sim.knockback(t.id, { x: dx / l, y: 0, z: dz / l }, o.knockback);
  }
  if (o.status && t.alive) sim.applyStatus(t.id, o.status.id, o.status.duration, { sourceId: src.id, params: o.status.params });
  return true;
}

function filterFor(src: Entity, o: StrikeOpts): QueryFilter {
  return { kinds: o.kinds ?? UNIT_KINDS, notFriendlyTo: src.id, exclude: [src.id, ...(o.exclude ?? [])] };
}

/** Melee-style cone sweep in front of `origin` (emits a 'melee' event). Returns units hit. */
export function coneAttack(sim: SimApi, src: Entity, origin: Vec3, dir: Vec3, range: number, arcDeg: number, o: StrikeOpts): Entity[] {
  const l = Math.hypot(dir.x, dir.z) || 1;
  const flat = { x: dir.x / l, y: 0, z: dir.z / l };
  sim.emit({ t: 'melee', src: src.id, pos: { ...origin }, dir: flat, range, arc: arcDeg });
  const hit: Entity[] = [];
  for (const t of sim.queryCone(origin, flat, range, ((arcDeg / 2) * Math.PI) / 180, filterFor(src, o))) {
    if (t.hero?.dead) continue;
    if (strikeOne(sim, src, t, o, sim.eyePos(t))) hit.push(t);
  }
  return hit;
}

/** Circle burst (no falloff, no LOS; emits an 'explosion' event of `vfx`). Returns units hit. */
export function circleAttack(sim: SimApi, src: Entity, center: Vec3, radius: number, o: StrikeOpts & { vfx?: string }): Entity[] {
  sim.emit({ t: 'explosion', pos: { ...center }, radius, kind: o.vfx ?? 'shockwave' });
  const hit: Entity[] = [];
  for (const t of sim.queryRadius(center, radius, filterFor(src, o))) {
    if (t.hero?.dead) continue;
    if (strikeOne(sim, src, t, o)) hit.push(t);
  }
  return hit;
}

/** Units within `width` of the segment from→to (charges, trampling, napalm lines). */
export function unitsAlongLine(sim: SimApi, src: Entity, from: Vec3, to: Vec3, width: number, o: Pick<StrikeOpts, 'kinds' | 'exclude'> = {}): Entity[] {
  const mx = (from.x + to.x) / 2;
  const mz = (from.z + to.z) / 2;
  const half = Math.hypot(to.x - from.x, to.z - from.z) / 2;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len2 = dx * dx + dz * dz || 1;
  return sim
    .queryRadius({ x: mx, y: (from.y + to.y) / 2, z: mz }, half + width + 1, { kinds: o.kinds ?? UNIT_KINDS, notFriendlyTo: src.id, exclude: [src.id, ...(o.exclude ?? [])] })
    .filter((t) => {
      if (t.hero?.dead) return false;
      const t0 = Math.max(0, Math.min(1, ((t.pos.x - from.x) * dx + (t.pos.z - from.z) * dz) / len2));
      const px = from.x + dx * t0;
      const pz = from.z + dz * t0;
      return Math.hypot(t.pos.x - px, t.pos.z - pz) <= width + t.radius;
    });
}

export function lineAttack(sim: SimApi, src: Entity, from: Vec3, to: Vec3, width: number, o: StrikeOpts): Entity[] {
  const hit: Entity[] = [];
  for (const t of unitsAlongLine(sim, src, from, to, width, o)) if (strikeOne(sim, src, t, o)) hit.push(t);
  return hit;
}

// ── movement ────────────────────────────────────────────────────────────────
export interface DashOpts {
  distance: number;
  /** seconds (default distance / 26 m/s) */
  duration?: number;
  invuln?: boolean;
  /** default: flat aim direction */
  dir?: Vec3;
  /** damage everything along the travelled path on arrival */
  pathStrike?: StrikeOpts & { width: number };
  onArrive?: (sim: SimApi, self: Entity, start: Vec3) => void;
}

/** Dash (forced movement, slides along walls) with optional path strike / arrival callback. */
export function dashStrike(ctx: AbilityCtx, o: DashOpts): void {
  const { sim, self } = ctx;
  const dir = o.dir ?? flatAimDir(ctx);
  const duration = o.duration ?? Math.max(0.12, o.distance / 26);
  const start = { ...self.pos };
  sim.dash(self.id, dir, o.distance, duration, { invuln: o.invuln });
  sim.schedule(duration, () => {
    if (!alive(self) || self.hero?.downed) return;
    if (o.pathStrike) lineAttack(sim, self, start, self.pos, o.pathStrike.width, o.pathStrike);
    o.onArrive?.(sim, self, start);
  });
}

/**
 * Blink toward a point, up to maxDist, stopping before walls (checks static
 * LOS at chest height and backs off until a free spot is found).
 */
export function blink(ctx: AbilityCtx, target: Vec3, maxDist: number): Vec3 {
  const { sim, self } = ctx;
  let dx = target.x - self.pos.x;
  let dz = target.z - self.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return { ...self.pos };
  dx /= d;
  dz /= d;
  let dist = Math.min(d, maxDist);
  const chest = { x: self.pos.x, y: self.pos.y + 1.1, z: self.pos.z };
  const margin = self.radius + 0.15;
  for (; dist > 0.5; dist -= 0.5) {
    // the body must fit: check a little beyond the destination
    const p = { x: self.pos.x + dx * (dist + margin), y: 0, z: self.pos.z + dz * (dist + margin) };
    p.y = Math.max(sim.groundHeight(p.x, p.z), self.pos.y) + 1.1;
    if (sim.lineOfSight(chest, p)) break;
  }
  const dest = { x: self.pos.x + dx * Math.max(0, dist), y: self.pos.y, z: self.pos.z + dz * Math.max(0, dist) };
  sim.teleport(self.id, dest);
  return { ...self.pos };
}

// ── summons / deployables ───────────────────────────────────────────────────
export function summonTroops(ctx: AbilityCtx, troopType: string, count: number, lifetime: number, pos?: Vec3): Entity[] {
  return ctx.sim.spawnTroops(ctx.self.id, troopType, count, pos, { temporary: lifetime });
}

/** Summon NPCs that attack everything not on your side; optionally rush a point first. */
export function summonNpcs(ctx: AbilityCtx, npcType: string, count: number, lifetime: number, pos: Vec3, rushTo?: Vec3): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / Math.max(1, count)) * Math.PI * 2;
    const p = { x: pos.x + Math.cos(a) * 1.8, y: pos.y, z: pos.z + Math.sin(a) * 1.8 };
    const e = ctx.sim.spawnNpc(npcType, p, { summonerId: ctx.self.id, lifetime });
    if (rushTo && e.npc) {
      e.npc.ai.goalX = rushTo.x;
      e.npc.ai.goalZ = rushTo.z;
    }
    out.push(e);
  }
  return out;
}

export interface FieldLineOpts {
  kind: string;
  count: number;
  spacing: number;
  /** distance of the first field from the hero */
  start?: number;
  radius: number;
  duration: number;
  tickEvery: number;
  params: Record<string, number>;
  dtype?: DamageType;
  status?: StatusSpec;
  /** seconds between consecutive fields (0 = all at once) */
  delayEach?: number;
  dir?: Vec3;
}

/** Hazards laid in a line along the aim direction (火烧连营, 火烧赤壁…). */
export function lineOfFields(ctx: AbilityCtx, o: FieldLineOpts): void {
  const { sim, self } = ctx;
  const dir = o.dir ?? flatAimDir(ctx);
  const l = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / l;
  const fz = dir.z / l;
  const origin = { ...self.pos };
  for (let i = 0; i < o.count; i++) {
    const d = (o.start ?? 3) + i * o.spacing;
    const pos = { x: origin.x + fx * d, y: origin.y, z: origin.z + fz * d };
    const spawn = (): void => {
      pos.y = sim.groundHeight(pos.x, pos.z);
      sim.spawnHazard({
        kind: o.kind,
        ownerId: self.id,
        pos,
        radius: o.radius,
        duration: o.duration,
        tickEvery: o.tickEvery,
        params: { ...o.params },
        dtype: o.dtype,
        status: o.status,
      });
    };
    const delay = (o.delayEach ?? 0) * i;
    if (delay > 0) sim.schedule(delay, spawn);
    else spawn();
  }
}

export interface VolleyOpts {
  kind: string;
  count: number;
  fanDeg: number;
  speed: number;
  damage: number;
  dtype: DamageType;
  gravity?: number;
  explodeRadius?: number;
  explodeDamage?: number;
  lifetime?: number;
  pierce?: number;
  canDodge?: boolean;
  onHitStatus?: StatusSpec;
  abilityId?: string;
}

/** Fan of projectiles from the eye toward the crosshair (弓腰姬, 神速 volley…). */
export function projectileVolley(ctx: AbilityCtx, o: VolleyOpts): Entity[] {
  const { sim, self } = ctx;
  const eye = sim.eyePos(self);
  const d = aimDir(ctx);
  const out: Entity[] = [];
  for (let i = 0; i < o.count; i++) {
    const a = o.count > 1 ? ((i / (o.count - 1)) - 0.5) * ((o.fanDeg * Math.PI) / 180) : 0;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dir = { x: d.x * c + d.z * s, y: d.y, z: -d.x * s + d.z * c };
    out.push(
      sim.spawnProjectile({
        kind: o.kind,
        ownerId: self.id,
        pos: { x: eye.x + dir.x * 0.6, y: eye.y + dir.y * 0.6, z: eye.z + dir.z * 0.6 },
        vel: { x: dir.x * o.speed, y: dir.y * o.speed, z: dir.z * o.speed },
        damage: o.damage,
        dtype: o.dtype,
        gravity: o.gravity,
        explodeRadius: o.explodeRadius,
        explodeDamage: o.explodeDamage,
        lifetime: o.lifetime,
        pierce: o.pierce,
        canDodge: o.canDodge,
        onHitStatus: o.onHitStatus,
        abilityId: o.abilityId ?? ctx.def.id,
      }),
    );
  }
  return out;
}

// ── buffs ───────────────────────────────────────────────────────────────────
export function buff(sim: SimApi, targetId: EntityId, id: StatusId, duration: number, params?: Record<string, number>, sourceId?: EntityId): boolean {
  return sim.applyStatus(targetId, id, duration, { sourceId: sourceId ?? targetId, params });
}

/** Heal `total` over `duration` seconds via the regen status. */
export function healOverTime(sim: SimApi, targetId: EntityId, total: number, duration: number, sourceId?: EntityId): boolean {
  if (!(duration > 0)) return sim.heal(targetId, total, sourceId) > 0;
  return sim.applyStatus(targetId, 'regen', duration, { sourceId, params: { hps: total / duration } });
}

/** Steal one item (respects 谦逊). */
export function stealFrom(sim: SimApi, thief: Entity, victim: Entity, includeEquipment = false): string | null {
  return ext(sim).stealItem(thief.id, victim.id, includeEquipment);
}

/** Random point within `r` of `center` (host RNG). */
export function randomPointNear(sim: SimApi, center: Vec3, r: number): Vec3 {
  const a = sim.rng.next() * Math.PI * 2;
  const d = r * Math.sqrt(sim.rng.next());
  const x = center.x + Math.cos(a) * d;
  const z = center.z + Math.sin(a) * d;
  return { x, y: sim.groundHeight(x, z), z };
}
