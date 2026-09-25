// Helpers shared by the 魏 Wei ability implementations (sim-side only: no
// World import, everything goes through SimApi / SimExt).
import type { Vec3 } from '../../../core/math';
import type { Entity, EntityId, EntityKind, StatusId } from '../../../core/types';
import { SIM_DT } from '../../../core/types';
import type { AbilityCtx, DamageRequest, SimApi } from '../../api';
import { ext } from '../../ext';
import { rollRewardItems } from '../../loot';
import { WALK_SPEED } from '../../physics';
import { UNIT_KINDS, alive, blink } from '../common';

/** World default (sim/world.ts BASE_DODGE_CHARGES); a hero's full count is ext(sim).maxDodgeCharges(id). */
export { BASE_DODGE_CHARGES } from '../../world';

/** Units that carry a kingdom and can soak / deal damage. */
export const LIVING_KINDS: EntityKind[] = UNIT_KINDS;

export const flatDist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** The caster can use an active ability right now (alive, not downed). */
export function canAct(ctx: AbilityCtx): boolean {
  const h = ctx.self.hero;
  return !!h && ctx.self.alive && !h.dead && !h.downed;
}

/** Active instance of `id` on `e` (optionally from `sourceId`). */
export function statusFrom(sim: SimApi, e: Entity, id: StatusId, sourceId?: EntityId): boolean {
  const now = sim.time;
  for (const s of e.statuses) {
    if (s.id === id && s.until > now && (sourceId === undefined || s.sourceId === sourceId)) return true;
  }
  return false;
}

/** Rooted / frozen heroes cannot blink, dash or leap (the ability is not spent). */
export function immobile(sim: SimApi, self: Entity): boolean {
  return sim.hasStatus(self.id, 'root') || sim.hasStatus(self.id, 'freeze') || sim.hasStatus(self.id, 'stun');
}

/** A weapon bullet (the hits armor / 八卦 / 鬼才 / 倾国 care about): see combat.isBulletDamage. */
export const isBullet = (req: DamageRequest): boolean => req.weaponId !== undefined && (req.type === 'normal' || req.type === 'pierce');

/**
 * Reflected damage (鬼才, the engine's reflect / thorns — 刚烈): it is dealt with the reflecting
 * hero as source, so outgoing multipliers (狼顾, 辽来…) must leave it alone — a reflect returns
 * what came in. (The engine's own dmgBoost step: docs/SIM_REQUESTS.md WEI-8.)
 */
export const isReflected = (req: DamageRequest): boolean => req.abilityId === 'status:reflect' || req.abilityId === 'status:thorns';

/** Damage over time, reflects and the zone are not "hits" (天妒, 反馈…). */
export const isDirectHit = (req: DamageRequest): boolean =>
  req.type !== 'zone' && !(req.abilityId?.startsWith('status:') ?? false);

/**
 * The unit that dealt `req`: the source entity when it is a living unit
 * (hero / troop / NPC / turret), else the hero credited for it (projectiles,
 * hazards, removed entities).
 */
export function attackerUnit(sim: SimApi, req: DamageRequest): Entity | undefined {
  const src = sim.get(req.sourceId);
  if (src && LIVING_KINDS.includes(src.kind)) return alive(src) ? src : undefined;
  const credit = sim.get(ext(sim).creditOf(req.sourceId));
  return alive(credit) ? credit : undefined;
}

/**
 * The hero that damaged us *personally* (itself, its projectiles, hazards or
 * turrets — not its troops / summoned NPCs), or undefined.
 */
export function heroAttacker(sim: SimApi, req: DamageRequest): Entity | undefined {
  if (req.sourceId === undefined) return undefined;
  const src = sim.get(req.sourceId);
  if (src && (src.kind === 'troop' || src.kind === 'npc')) return undefined;
  const credit = sim.get(ext(sim).creditOf(req.sourceId));
  return credit?.hero && !credit.hero.dead ? credit : undefined;
}

/** Chest-height point of a unit (SimApi has eyePos only). */
export function chestOf(e: Entity): Vec3 {
  const h = e.hero?.downed ? 0.3 : e.height * 0.55;
  return { x: e.pos.x, y: e.pos.y + h, z: e.pos.z };
}

/** Horizontal facing of a unit (yaw 0 looks toward −z). */
export const facingOf = (e: Entity): Vec3 => ({ x: -Math.sin(e.yaw), y: 0, z: -Math.cos(e.yaw) });

/**
 * Give `n` random reward items (rollRewardItems) to a hero: into free slots,
 * the rest dropped at its feet. Emits a 'pickup' — private to the hero: what
 * you hold is hidden information — for the ones that went into slots. Returns
 * the rolled ids.
 */
export function grantRandomItems(sim: SimApi, hero: Entity, n: number): string[] {
  if (!(n > 0) || !hero.hero || hero.hero.dead) return [];
  const ids = rollRewardItems(sim.rng, Math.floor(n));
  ids.forEach((id, i) => {
    if (sim.giveItem(hero.id, id)) {
      sim.emit({ t: 'pickup', who: hero.id, item: id, privateTo: hero.id });
    } else {
      const a = (i / Math.max(1, ids.length)) * Math.PI * 2 + 0.7;
      sim.spawnLoot({ x: hero.pos.x + Math.cos(a) * 0.9, y: hero.pos.y, z: hero.pos.z + Math.sin(a) * 0.9 }, { itemId: id });
    }
  });
  return ids;
}

/**
 * Steal one item from `victim` into `thief` (respects 谦逊 and 无懈可击).
 * Victims without items are skipped *before* the nullify gate, so a pointless
 * steal never burns their 无懈可击. Emits a 'pickup' private to the thief (the
 * victim sees the gap in its own inventory; nobody else learns the item).
 */
export function stealOne(sim: SimApi, thief: Entity, victim: Entity): string | null {
  if (!victim.hero || victim.hero.dead || victim === thief) return null;
  if (!victim.hero.items.some((s) => !!s && s.count > 0)) return null;
  const id = ext(sim).stealItem(thief.id, victim.id, false);
  if (id) sim.emit({ t: 'pickup', who: thief.id, item: id, privateTo: thief.id });
  return id;
}

/**
 * Passive trigger feedback for the renderer / audio (the world only emits
 * 'ability' events for activations). Throttled per ability via abilityState.
 * Marked `proc` (WEI-10): clients play no cast gesture and a lighter cue.
 */
export function emitProc(ctx: AbilityCtx, minGap: number, extra: { target?: EntityId; pos?: Vec3 } = {}): void {
  const h = ctx.self.hero;
  if (!h) return;
  const key = `${ctx.def.id}:procAt`;
  const last = h.abilityState[key];
  if (last !== undefined && ctx.sim.time - last < minGap) return;
  h.abilityState[key] = ctx.sim.time;
  const ev = { t: 'ability' as const, src: ctx.self.id, ability: ctx.def.id, pos: extra.pos ?? chestOf(ctx.self), target: extra.target, proc: true };
  // a stealthed hero's proc must not give its position away (cf. docs/SIM_REQUESTS.md WU-2)
  ctx.sim.emit(ctx.sim.hasStatus(ctx.self.id, 'stealth') ? { ...ev, privateTo: ctx.self.id } : ev);
}

/** Line of sight between two units' chests (static geometry only). */
export const losBetween = (sim: SimApi, a: Entity, b: Entity): boolean => sim.lineOfSight(sim.eyePos(a), chestOf(b)) || sim.lineOfSight(sim.eyePos(a), sim.eyePos(b));

/**
 * common.blink plus a sanity check: the landing spot (after the world's
 * free-spot search) must still be in line of sight of the start, otherwise
 * the hero is put back and undefined is returned (never blink through walls).
 */
export function safeBlink(ctx: AbilityCtx, target: Vec3, maxDist: number): Vec3 | undefined {
  const { sim, self } = ctx;
  const start = { ...self.pos };
  const dest = blink(ctx, target, maxDist);
  if (flatDist(dest, start) > 0.05 && !sim.lineOfSight({ x: start.x, y: start.y + 1.1, z: start.z }, { x: dest.x, y: dest.y + 1.1, z: dest.z })) {
    sim.teleport(self.id, start);
    return undefined;
  }
  return dest;
}

// ── the world's { t: 'ability' } event ──────────────────────────────────────
/** Where / at whom an activation really happened (renderer + audio). */
export interface CastInfo {
  /**
   * The effect point. Blinks (突袭, 凌波微步, 神速) record where the blink STARTED —
   * the caster itself already stands at the landing when the event is shown, so
   * pos → caster is the path (render/vfx/abilities-wei.ts blinkPath). Dashes and
   * leaps (独目怒冲, 虎卫猛击) record the nominal end: the event plays at the start.
   */
  pos?: Vec3;
  target?: EntityId;
  dir?: Vec3;
}

/**
 * Record the real cast point / target / direction on the ability context — the
 * same `ctx.cast` property Shu / Qun use (docs/SIM_REQUESTS.md SHU-3): once the
 * world reads it, the activation event carries it instead of the raw
 * crosshair point. Harmless before that.
 */
export function setCast(ctx: AbilityCtx, info: CastInfo): void {
  const c = ctx as AbilityCtx & { cast?: CastInfo };
  const out: CastInfo = { ...(c.cast ?? {}) };
  if (info.pos) out.pos = { x: info.pos.x, y: info.pos.y, z: info.pos.z };
  if (info.target !== undefined) out.target = info.target;
  if (info.dir) out.dir = { x: info.dir.x, y: info.dir.y, z: info.dir.z };
  c.cast = out;
}

// ── dashes ──────────────────────────────────────────────────────────────────
/**
 * Call from an ability tick (after movement) while one of the hero's own dashes
 * runs: on the dash's last movement tick, cap the horizontal speed at walking
 * speed so the hero does not slide on for v²/120 m once `forced` expires
 * (docs/SIM_REQUESTS.md SHU-1; a no-op once that lands).
 */
export function brakeAtDashEnd(sim: SimApi, e: Entity, until: number): void {
  if (!e.forced || e.forced.until !== until || sim.time + SIM_DT + 1e-6 < until) return;
  const v = Math.hypot(e.vel.x, e.vel.z);
  if (v <= WALK_SPEED || v < 1e-6) return;
  e.vel.x *= WALK_SPEED / v;
  e.vel.z *= WALK_SPEED / v;
}
