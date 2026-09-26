// Generic status-effect semantics (see StatusId comments in core/types.ts).
// Abilities and items only *apply* statuses; everything they mean is
// implemented here or queried from here by movement/combat/AI.
//
// Storage: Entity.statuses may hold several instances of one StatusId.
//  - Instances are grouped by a *key*: the source (sourceId) for most ids, the
//    viewer (params.viewerId; undefined = public) for 'reveal', and a single
//    group for 'charm' (the latest charm wins).
//  - Within one key only non-dominated (magnitude, expiry) pairs survive: an
//    application that is at least as strong AND lasts at least as long replaces
//    the old instance (stacks carry over); one that is weaker AND shorter is
//    absorbed (only stacks grow); otherwise both are kept. A short heavy slow
//    therefore never inherits the duration of a long light one.
//  - Queries aggregate over the active instances (MAG rules below): slow,
//    haste, fireRateUp, drunk, stealth(keep) → strongest; dmgBoost/dmgTakenUp/
//    dmgTakenDown → product across sources (strongest per source, clamped);
//    dodgeChance → 1 − Π(1 − p); lifesteal/reflect/thorns → sum (≤ 1). DoTs and
//    HoTs tick per instance, each credited to its own source.
//  - 'status' on/off events are emitted per *route*: once when the first
//    active instance of an id appears / the last one goes. Private reveals
//    route per viewer (privateTo = viewerId).
//
// 无懈可击 (nullify): the next hostile status or ability effect credited to an
// enemy hero is cancelled and one nullify charge is consumed. Information
// statuses ('reveal', 'marked'), periodic area ticks and weapon hits never
// consume it. Every other effect of the same enemy on the same target in the
// same tick (the rest of that cast: its status, knockback, steal) is cancelled
// too, without consuming a second charge.
import type { Entity, EntityId, GameEvent, StatusId, StatusInstance } from '../core/types';
import { NULLIFY_EXEMPT, isDebuff } from './ext';
import type { World } from './world';

/** DoT / HoT period (seconds). */
export const STATUS_PERIOD = 0.5;
const MAX_STACKS = 99;
/** combined dmgTakenDown never goes below this unless a single source already does */
const DAMAGE_REDUCTION_FLOOR = 0.2;
/** combined dmgBoost / dmgTakenUp never exceeds this unless a single source already does */
const DAMAGE_MUL_CAP = 3;

type Combine = 'max' | 'mul' | 'prob' | 'sum';

interface MagRule {
  /** params key holding the magnitude */
  key: string;
  /** legacy alternative key (burn/poison/regen accepted `amount`) */
  alt?: string;
  /** magnitude when the key is absent */
  def: number;
  combine: Combine;
  /** a smaller value is the stronger effect (dmgTakenDown) */
  lower?: boolean;
  /** per-instance clamp */
  lo?: number;
  hi?: number;
}

const MAG: Partial<Record<StatusId, MagRule>> = {
  slow: { key: 'amount', def: 0.3, combine: 'max', lo: 0, hi: 0.9 },
  haste: { key: 'amount', def: 0.3, combine: 'max', lo: 0, hi: 3 },
  burn: { key: 'dps', alt: 'amount', def: 10, combine: 'sum', lo: 0 },
  poison: { key: 'dps', alt: 'amount', def: 10, combine: 'sum', lo: 0 },
  regen: { key: 'hps', alt: 'amount', def: 10, combine: 'sum', lo: 0 },
  dmgBoost: { key: 'mul', def: 1.3, combine: 'mul', lo: 0 },
  dmgTakenUp: { key: 'mul', def: 1.25, combine: 'mul', lo: 1 },
  dmgTakenDown: { key: 'mul', def: 0.75, combine: 'mul', lower: true, lo: 0, hi: 1 },
  fireRateUp: { key: 'mul', def: 1.3, combine: 'max', lo: 0.05 },
  dodgeChance: { key: 'chance', def: 0.25, combine: 'prob', lo: 0, hi: 1 },
  lifesteal: { key: 'frac', def: 0.2, combine: 'sum', lo: 0, hi: 1 },
  reflect: { key: 'frac', def: 1, combine: 'sum', lo: 0, hi: 1 },
  thorns: { key: 'frac', def: 0.3, combine: 'sum', lo: 0, hi: 1 },
  drunk: { key: 'mul', def: 2, combine: 'max', lo: 1 },
  stealth: { key: 'keep', def: 0, combine: 'max', lo: 0, hi: 1 },
};

// ── instance helpers ────────────────────────────────────────────────────────
function magOf(rule: MagRule, params: Record<string, number> | undefined, fallback = rule.def): number {
  let v = params?.[rule.key];
  if (v === undefined && rule.alt) v = params?.[rule.alt];
  if (v === undefined || !Number.isFinite(v)) v = fallback;
  if (rule.lo !== undefined && v < rule.lo) v = rule.lo;
  if (rule.hi !== undefined && v > rule.hi) v = rule.hi;
  return v;
}

/** a is at least as strong as b */
const atLeast = (rule: MagRule | undefined, a: number, b: number): boolean => (!rule ? true : rule.lower ? a <= b : a >= b);
const stronger = (rule: MagRule, a: number, b: number): boolean => (rule.lower ? a < b : a > b);

/** Grouping key of an instance (see header). */
function keyOf(id: StatusId, sourceId: EntityId | undefined, params: Record<string, number> | undefined): number {
  if (id === 'reveal') return params?.viewerId ?? -1;
  if (id === 'charm') return 0;
  return sourceId ?? -1;
}

const instKey = (s: StatusInstance): number => keyOf(s.id, s.sourceId, s.params);

/** Event route of an instance: private reveals route to their viewer. */
const routeOf = (s: StatusInstance): number | undefined => (s.id === 'reveal' ? s.params?.viewerId : undefined);

function sanitizeParams(p: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!p) return undefined;
  const out: Record<string, number> = {};
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (typeof v === 'number' && !Number.isNaN(v)) out[k] = v;
  }
  return out;
}

// ── queries ─────────────────────────────────────────────────────────────────
/**
 * First active instance of `id` (presence checks and non-magnitude params such
 * as charm's targetId). Use statusValue() for magnitudes: several instances
 * from different sources may be active at once.
 */
export function findStatus(e: Entity, id: StatusId, now: number): StatusInstance | undefined {
  const list = e.statuses;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id === id && s.until > now) return s;
  }
  return undefined;
}

export const hasStatusOn = (e: Entity, id: StatusId, now: number): boolean => findStatus(e, id, now) !== undefined;

/** Is an instance of `id` applied by `sourceId` active on `e`? (a commander's own squad mark) */
export function hasStatusFrom(e: Entity, id: StatusId, sourceId: EntityId, now: number): boolean {
  const list = e.statuses;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id === id && s.until > now && s.sourceId === sourceId) return true;
  }
  return false;
}

/** Is instance i the strongest active one of its key (ties: the first)? */
function strongestOfKey(list: StatusInstance[], i: number, rule: MagRule, m: number, fallback: number, now: number): boolean {
  const s = list[i];
  const k = instKey(s);
  for (let j = 0; j < list.length; j++) {
    if (j === i) continue;
    const o = list[j];
    if (o.id !== s.id || o.until <= now || instKey(o) !== k) continue;
    const mo = magOf(rule, o.params, fallback);
    if (stronger(rule, mo, m) || (mo === m && j < i)) return false;
  }
  return true;
}

/**
 * Combined magnitude of every active instance of `id` (per the MAG rule), or
 * `none` when no instance is active. `instanceDefault` replaces the rule's
 * default for instances that lack the magnitude param.
 */
export function statusValue(e: Entity, id: StatusId, now: number, none: number, instanceDefault?: number): number {
  const rule = MAG[id];
  const list = e.statuses;
  if (!rule) return findStatus(e, id, now) ? 1 : none;
  const fb = instanceDefault ?? rule.def;
  let n = 0;
  let acc = 0;
  let best = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id !== id || s.until <= now) continue;
    const m = magOf(rule, s.params, fb);
    if (n === 0 || stronger(rule, m, best)) best = m;
    if (rule.combine !== 'max' && !strongestOfKey(list, i, rule, m, fb, now)) continue;
    switch (rule.combine) {
      case 'mul':
        acc = n === 0 ? m : acc * m;
        break;
      case 'prob':
        acc = n === 0 ? m : 1 - (1 - acc) * (1 - m);
        break;
      case 'sum':
        acc += m;
        break;
      default:
        break;
    }
    n++;
  }
  if (n === 0) return none;
  switch (rule.combine) {
    case 'max':
      return best;
    case 'mul':
      if (rule.lower) return Math.max(acc, Math.min(DAMAGE_REDUCTION_FLOOR, best));
      return Math.min(acc, Math.max(DAMAGE_MUL_CAP, best));
    case 'prob':
      return Math.min(1, Math.max(0, acc));
    default:
      return rule.hi !== undefined ? Math.min(rule.hi, acc) : acc;
  }
}

/**
 * SimApi.statusParam: the combined magnitude when `key` is the id's magnitude
 * param (see MAG), otherwise the value from the first active instance that has
 * it; `fallback` when nothing applies.
 */
export function statusParamOf(e: Entity, id: StatusId, key: string, fallback: number, now: number): number {
  const rule = MAG[id];
  if (rule && (rule.key === key || rule.alt === key)) return statusValue(e, id, now, fallback, fallback);
  const list = e.statuses;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id !== id || s.until <= now) continue;
    const v = s.params?.[key];
    if (v !== undefined && Number.isFinite(v)) return v;
  }
  return fallback;
}

/**
 * Is `e` revealed to `viewerId`? Public reveals (no params.viewerId) count for
 * everyone; private ones (观星 / 狼顾) only for their viewer.
 */
export function revealedTo(e: Entity, viewerId: number | undefined, now: number): boolean {
  for (const s of e.statuses) {
    if (s.id !== 'reveal' || s.until <= now) continue;
    const v = s.params?.viewerId;
    if (v === undefined || v === viewerId) return true;
  }
  return false;
}

// ── events ──────────────────────────────────────────────────────────────────
function statusEvent(targetId: EntityId, id: StatusId, on: boolean, route: number | undefined): GameEvent {
  return route !== undefined ? { t: 'status', target: targetId, status: id, on, privateTo: route } : { t: 'status', target: targetId, status: id, on };
}

/** Does another instance (index ≠ skip) with the same id and route exist (active only when `activeOnly`)? */
function routeHasOther(list: StatusInstance[], s: StatusInstance, skip: number, now: number, activeOnly: boolean): boolean {
  const r = routeOf(s);
  for (let j = 0; j < list.length; j++) {
    if (j === skip) continue;
    const o = list[j];
    if (o.id !== s.id || routeOf(o) !== r) continue;
    if (activeOnly && o.until <= now) continue;
    return true;
  }
  return false;
}

// ── apply / remove ──────────────────────────────────────────────────────────
/**
 * Apply a status. Returns false when it was rejected: dead target, a
 * canBeAffected veto (陆逊 谦逊) or cancelled by nullify (无懈可击).
 */
export function applyStatusTo(
  w: World,
  target: Entity,
  id: StatusId,
  duration: number,
  opts: { sourceId?: EntityId; params?: Record<string, number>; stacks?: number } = {},
): boolean {
  if (!target.alive || target.hero?.dead) return false;
  if (!(duration > 0)) return false;
  const src = opts.sourceId;
  if (id === 'shield') {
    w.addShield(target.id, opts.params?.amount ?? 0, duration);
    return true;
  }
  if (id === 'charm' && opts.params?.targetId === undefined) return false;
  if (isDebuff(id)) {
    // source-less statuses applied from ability/item code are attributed to the acting hero
    const actor = src ?? w.actorId;
    if (actor !== target.id) {
      if (!w.canBeAffected(target, id, actor)) return false;
      if (!NULLIFY_EXEMPT.has(id) && nullifyEffect(w, target, actor)) return false;
    }
  }
  const now = w.time;
  const list = target.statuses;
  // expired-but-not-yet-ticked instances of this id go first (with their off events)
  for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id && list[i].until <= now) removeAt(w, target, i);

  const until = duration === Infinity ? Infinity : now + duration;
  const params = sanitizeParams(opts.params);
  const addStacks = Math.max(1, Math.floor(opts.stacks ?? 1));
  const rule = MAG[id];
  const mNew = rule ? magOf(rule, params) : 0;

  if (id === 'charm') {
    // one charm at a time: the latest charmer picks the target, the longer duration stays
    const cur = findStatus(target, 'charm', now);
    if (cur) {
      cur.sourceId = src;
      cur.params = params;
      cur.until = Math.max(cur.until, until);
      cur.stacks = Math.min(MAX_STACKS, (cur.stacks ?? 1) + addStacks);
      onApplied(w, target, id);
      return true;
    }
  }

  const key = keyOf(id, src, params);
  const newInst: StatusInstance = { id, until, sourceId: src, stacks: Math.min(MAX_STACKS, addStacks), params };
  const hadRoute = routeHasOther(list, newInst, -1, now, true);
  let carryStacks = 0;
  let carryNext: number | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.id !== id || instKey(s) !== key) continue;
    const mOld = rule ? magOf(rule, s.params) : 0;
    if (atLeast(rule, mOld, mNew) && s.until >= until) {
      // dominated by what is already there: only the stack count grows
      s.stacks = Math.min(MAX_STACKS, (s.stacks ?? 1) + addStacks);
      onApplied(w, target, id);
      return true;
    }
    if (atLeast(rule, mNew, mOld) && until >= s.until) {
      // the new application dominates: replace silently (the route stays on)
      carryStacks += s.stacks ?? 1;
      if (s.params?._next !== undefined) carryNext = carryNext === undefined ? s.params._next : Math.min(carryNext, s.params._next);
      list.splice(i, 1);
    }
  }
  newInst.stacks = Math.min(MAX_STACKS, addStacks + carryStacks);
  if (id === 'burn' || id === 'poison' || id === 'regen') {
    newInst.params = { ...(newInst.params ?? {}), _next: carryNext ?? now + STATUS_PERIOD };
  }
  list.push(newInst);
  if (!hadRoute) w.emit(statusEvent(target.id, id, true, routeOf(newInst)));
  onApplied(w, target, id);
  return true;
}

function onApplied(w: World, target: Entity, id: StatusId): void {
  const h = target.hero;
  switch (id) {
    case 'stun':
      if (h) {
        w.cancelChannel(target.id);
        h.ads = false;
        h.sprinting = false;
      }
      break;
    case 'dance':
    case 'silence':
      if (h?.channel && (h.channel.kind === 'item' || h.channel.kind === 'ability' || id === 'dance')) w.cancelChannel(target.id);
      break;
    case 'freeze':
      if (h) h.sprinting = false;
      break;
    default:
      break;
  }
}

/** Remove every instance of `id` (only those applied by `sourceId` when given). */
export function removeStatusFrom(w: World, target: Entity, id: StatusId, sourceId?: EntityId): void {
  const list = target.statuses;
  for (let i = list.length - 1; i >= 0; i--) {
    if (i >= list.length) continue;
    const s = list[i];
    if (s.id === id && (sourceId === undefined || s.sourceId === sourceId)) removeAt(w, target, i);
  }
}

/** Remove the instances of `id` that match `pred` (e.g. stealth without params.keep). */
export function removeStatusIf(w: World, target: Entity, id: StatusId, pred: (s: StatusInstance) => boolean): void {
  const list = target.statuses;
  for (let i = list.length - 1; i >= 0; i--) {
    if (i >= list.length) continue;
    const s = list[i];
    if (s.id === id && pred(s)) removeAt(w, target, i);
  }
}

function removeAt(w: World, target: Entity, index: number): void {
  const list = target.statuses;
  const s = list[index];
  list.splice(index, 1);
  if (s.id === 'shield') target.shield = 0;
  // a charm's forced fight is forgotten when it ends: neither side keeps shooting the other
  // just because it was hit (COMBAT-6)
  if (s.id === 'charm' && s.params?.targetId !== undefined) w.forgetAttacks(target.id, s.params.targetId);
  // off only when the last instance of this route is gone
  if (!routeHasOther(list, s, -1, w.time, false)) w.emit(statusEvent(target.id, s.id, false, routeOf(s)));
}

/** Clear every status silently (death / despawn). */
export function clearStatuses(target: Entity): void {
  target.statuses = [];
  target.shield = 0;
}

// ── 无懈可击 ────────────────────────────────────────────────────────────────
/** Consume one nullify charge (the soonest-expiring instance). */
function consumeNullify(w: World, target: Entity): boolean {
  const list = target.statuses;
  const now = w.time;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id !== 'nullify' || s.until <= now) continue;
    if (best < 0 || s.until < list[best].until) best = i;
  }
  if (best < 0) return false;
  const s = list[best];
  if ((s.stacks ?? 1) > 1) s.stacks = (s.stacks ?? 1) - 1;
  else removeAt(w, target, best);
  return true;
}

/**
 * 无懈可击 gate for a hostile status / ability effect on `target` from
 * `sourceId`. Returns true when the effect is cancelled: a nullify charge was
 * consumed now, or the same enemy's effect on this target was already
 * nullified this tick (the rest of that cast). Periodic area ticks, own-side
 * effects and effects not credited to a hero never consume it.
 */
export function nullifyEffect(w: World, target: Entity, sourceId: EntityId | undefined): boolean {
  if (sourceId === undefined || w.periodicDepth > 0) return false;
  if (sourceId === target.id || w.isOwnSideId(sourceId, target.id)) return false;
  const creditId = w.creditOf(sourceId) ?? sourceId;
  const credit = w.get(creditId);
  if (!credit?.hero) return false;
  const echo = w.nullifyEcho.get(target.id);
  if (echo && echo.creditId === creditId && echo.tick === w.tick) return true;
  if (!consumeNullify(w, target)) return false;
  w.nullifyEcho.set(target.id, { creditId, tick: w.tick });
  // hidden information: only the two parties learn about it (and the enemy only if it can see the target)
  const pos = w.centerOf(target);
  const base = { t: 'hit' as const, target: target.id, src: creditId, amount: 0, dtype: 'normal' as const, blocked: 'nullify' as const };
  if (target.hero) w.emit({ ...base, pos, privateTo: target.id });
  else {
    const cmd = w.commanderOf(target);
    if (cmd) w.emit({ ...base, pos, privateTo: cmd.id });
  }
  if (credit.id !== target.id && w.canSee(credit, target)) w.emit({ ...base, pos: { ...pos }, privateTo: credit.id });
  return true;
}

// ── per tick ────────────────────────────────────────────────────────────────
/** Per-tick: expiry, DoT/HoT, invalid charm targets. */
export function tickStatuses(w: World, units: readonly Entity[]): void {
  const now = w.time;
  for (let u = 0; u < units.length; u++) {
    const e = units[u];
    const list = e.statuses;
    if (list.length === 0) continue;
    if (!e.alive) {
      clearStatuses(e);
      continue;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (i >= list.length) continue;
      const s = list[i];
      if (s.id === 'burn' || s.id === 'poison' || s.id === 'regen') {
        // periodic effect first, so the tick landing exactly on expiry still applies (dps × duration)
        const p = s.params ?? (s.params = {});
        const next = p._next ?? now;
        if (now + 1e-9 >= next && next <= s.until + 1e-9) {
          p._next = next + STATUS_PERIOD;
          const rule = MAG[s.id]!;
          const rate = magOf(rule, p);
          if (s.id === 'regen') {
            if (!e.hero?.downed) w.heal(e.id, rate * STATUS_PERIOD, s.sourceId);
          } else {
            w.dealDamage({
              targetId: e.id,
              sourceId: s.sourceId,
              amount: rate * STATUS_PERIOD,
              type: s.id === 'burn' ? 'fire' : 'true',
              canDodge: false,
              noReflect: true,
              abilityId: `status:${s.id}`,
            });
            if (!e.alive || e.statuses !== list) break;
          }
        }
      } else if (s.id === 'charm') {
        const tgt = w.get(s.params?.targetId);
        if (!tgt || !tgt.alive || tgt.hero?.dead) {
          removeAt(w, e, i);
          continue;
        }
      }
      if (i < list.length && list[i] === s && now >= s.until) removeAt(w, e, i);
    }
  }
}

/** Movement multiplier from statuses: strongest slow × strongest haste × freeze × dance. */
export function statusSpeedMul(e: Entity, now: number): number {
  let slow = 0;
  let haste = 0;
  let freeze = false;
  let dance = false;
  const list = e.statuses;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.until <= now) continue;
    switch (s.id) {
      case 'slow': {
        const v = magOf(MAG.slow!, s.params);
        if (v > slow) slow = v;
        break;
      }
      case 'haste': {
        const v = magOf(MAG.haste!, s.params);
        if (v > haste) haste = v;
        break;
      }
      case 'freeze':
        freeze = true;
        break;
      case 'dance':
        dance = true;
        break;
      default:
        break;
    }
  }
  return (1 - slow) * (1 + haste) * (freeze ? 0.4 : 1) * (dance ? 0.5 : 1);
}

/** Per-id view of the active statuses for a HUD: one row per id, the longest remaining time (-1 = until consumed). */
export function statusRows(e: Entity, now: number, viewerId: EntityId): { id: StatusId; remaining: number }[] {
  const out: { id: StatusId; remaining: number }[] = [];
  for (const s of e.statuses) {
    if (s.until <= now) continue;
    // someone else's private reveal of you is their secret
    if (s.id === 'reveal' && s.params?.viewerId !== undefined && s.params.viewerId !== viewerId) continue;
    const rem = s.until === Infinity ? -1 : Math.round((s.until - now) * 10) / 10;
    const row = out.find((r) => r.id === s.id);
    if (!row) out.push({ id: s.id, remaining: rem });
    else if (row.remaining !== -1 && (rem === -1 || rem > row.remaining)) row.remaining = rem;
  }
  return out;
}

/** Summary of control states used by input processing and AI. */
export interface ControlState {
  stunned: boolean;
  rooted: boolean;
  silenced: boolean;
  disarmed: boolean;
  dancing: boolean;
  frozen: boolean;
  charmedBy?: number;
  charmTarget?: number;
}

export function controlState(e: Entity, now: number, out: ControlState): ControlState {
  out.stunned = false;
  out.rooted = false;
  out.silenced = false;
  out.disarmed = false;
  out.dancing = false;
  out.frozen = false;
  out.charmedBy = undefined;
  out.charmTarget = undefined;
  const list = e.statuses;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.until <= now) continue;
    switch (s.id) {
      case 'stun':
        out.stunned = true;
        break;
      case 'root':
        out.rooted = true;
        break;
      case 'silence':
        out.silenced = true;
        break;
      case 'disarm':
        out.disarmed = true;
        break;
      case 'dance':
        out.dancing = true;
        break;
      case 'freeze':
        out.frozen = true;
        break;
      case 'charm':
        out.charmedBy = s.sourceId;
        out.charmTarget = s.params?.targetId;
        break;
      default:
        break;
    }
  }
  return out;
}
