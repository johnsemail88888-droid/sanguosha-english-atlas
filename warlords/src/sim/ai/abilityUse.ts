// Generic ability use for every hero, driven by AbilityDef.targeting + aiHint
// + params (range / dash / radius …), with cooldown / charge awareness and a
// back-off when an activation fails (no valid target, not implemented yet).
//  offense  → on the target when it is in range / line of sight
//  defense  → when under fire (or enemies inside the ability radius)
//  heal     → when hurt (self) or on a hurt believed ally
//  mobility → dash in to engage a fleeing / distant target, or away to escape
//  summon   → when a fight is on
//  utility  → when safe (item draws) or when it fixes a problem (reload/dodges)
import type { Vec3 } from '../../core/math';
import type { AbilitySlot, Entity } from '../../core/types';
import { isPassiveAbility } from '../../data';
import type { AbilityDef } from '../../data/types';
import { getAbility } from '../abilities/registry';
import { aimAnglesFor } from '../aim';
import type { AbilityPlan, BotView } from './botTypes';
import { ownRole } from './knowledge';
import { aimPointOf, dist2d, hasLineOfSight } from './perception';

const SLOTS: AbilitySlot[] = ['q', 'e', 'lord'];
const FAIL_BACKOFF = 5;

interface Pending {
  id: string;
  at: number;
  cdBefore: number;
  chargesBefore: number;
  /** own summoned NPCs around us before the cast (to learn which abilities summon NPC hordes) */
  npcsBefore: number;
}

/** Longest distance at which the ability does something useful. */
export function abilityReach(def: AbilityDef): number {
  const p = def.params;
  if (p.length !== undefined) return p.length;
  if (p.distance !== undefined) return p.distance;
  if (p.count !== undefined && p.spacing !== undefined) return (p.start ?? 3) + p.count * p.spacing;
  if (p.dash !== undefined) return p.dash + (p.range ?? p.width ?? 3);
  if (p.blink !== undefined) return p.blink;
  if (p.leap !== undefined) return p.leap + (p.radius ?? 2);
  if (p.range !== undefined) return p.range;
  if (p.speed !== undefined && p.lifetime !== undefined) return p.speed * p.lifetime;
  if (p.speed !== undefined) return Math.min(90, p.speed * 0.8);
  if (p.volleyRange !== undefined) return p.volleyRange;
  if (p.radius !== undefined) return p.radius;
  return 25;
}

export class AbilityUser {
  private readonly backoff = new Map<string, number>();
  /** abilities observed to summon NPCs that attack everything not ours */
  private readonly wild = new Set<string>();
  private pending: Pending | null = null;
  /** abilities fired this match (metrics) */
  used = 0;

  /** Pick at most one ability to fire now. */
  consider(v: BotView): AbilityPlan | null {
    const { sim, self, now } = v;
    const h = self.hero!;
    this.checkPending(v);
    if (h.downed || h.channel) return null;
    if (sim.hasStatus(self.id, 'silence') || sim.hasStatus(self.id, 'dance') || sim.hasStatus(self.id, 'stun')) return null;
    const hero = sim.heroDef(self);
    if (!hero) return null;
    for (const slot of SLOTS) {
      const def = hero.abilities.find((a) => a.slot === slot);
      if (!def || isPassiveAbility(def)) continue;
      if (slot === 'lord' && ownRole(self) !== 'lord') continue;
      const impl = getAbility(def.id);
      if (!impl?.activate) continue;
      if ((this.backoff.get(def.id) ?? 0) > now) continue;
      if (!this.ready(v, def)) continue;
      const plan = this.plan(v, def, slot);
      if (plan && !this.safeForFriends(v, def, plan)) continue;
      if (plan) {
        this.pending = { id: def.id, at: now, cdBefore: sim.cooldownLeft(self.id, def.id), chargesBefore: h.charges[def.id] ?? 0, npcsBefore: ownNpcs(v) };
        return plan;
      }
    }
    return null;
  }

  private ready(v: BotView, def: AbilityDef): boolean {
    const h = v.self.hero!;
    if (def.charges) return (h.charges[def.id] ?? 0) > 0;
    return v.sim.cooldownLeft(v.self.id, def.id) <= 0;
  }

  /** Did the last press start a cooldown / spend a charge? If not, back off. */
  private checkPending(v: BotView): void {
    const p = this.pending;
    if (!p || v.now - p.at < 0.1) return;
    this.pending = null;
    const h = v.self.hero!;
    const cd = v.sim.cooldownLeft(v.self.id, p.id);
    const charges = h.charges[p.id] ?? 0;
    const fired = cd > p.cdBefore + 0.05 || charges < p.chargesBefore;
    if (fired) {
      this.used++;
      if (ownNpcs(v) > p.npcsBefore) this.wild.add(p.id);
    }
    else this.backoff.set(p.id, v.now + FAIL_BACKOFF * (0.7 + v.rng.next() * 0.6));
  }

  private plan(v: BotView, def: AbilityDef, slot: AbilitySlot): AbilityPlan | null {
    const { self, prof } = v;
    const p = def.params;
    const reach = abilityReach(def);
    const t = v.target;
    const tHero = t && t.kind === 'hero' ? t : undefined;
    const d = v.targetDist;
    const los = v.targetLos;
    const hpFrac = self.hp / Math.max(1, self.maxHp);
    const fighting = !!t && los && d < 45;
    const skill = prof.abilitySkill;
    const threatNear = v.threats.find((x) => x.hostility >= 0.5 && x.dist < 20);
    const enemiesWithin = (r: number): number => v.threats.filter((x) => x.hostility >= 0.45 && x.dist <= r).reduce((s, x) => s + (x.e.kind === 'hero' ? 2 : 1), 0);
    const base: AbilityPlan = { slot, abilityId: def.id };
    const at = (e: Entity): AbilityPlan => this.aimAt(v, base, e);
    const hint = def.aiHint ?? 'utility';
    const targeting = def.targeting ?? 'none';
    switch (hint) {
      case 'offense': {
        if (!t || !los) return null;
        if (targeting === 'self' || targeting === 'none') {
          if (p.radius !== undefined && p.radius <= 12 && !p.fireRateMul && !p.mul) return enemiesWithin(p.radius) >= 2 ? base : null;
          return d < Math.min(35, reach + 20) && (tHero || v.threats.length >= 3) ? base : null;
        }
        if (targeting === 'enemy') return d <= reach && (tHero || skill < 0.5) ? at(t) : null;
        if (targeting === 'point') return d <= reach + (p.radius ?? 0) * 0.5 ? this.aimPoint(v, base, groundPointOf(v, t)) : null;
        // direction: dashes / lines / cones / projectiles
        if (d > reach) return null;
        if (p.dash !== undefined && d < 3) return null;
        return at(t);
      }
      case 'defense': {
        const pressed = v.underFire > 0.1 || (hpFrac < 0.5 && !!threatNear);
        if (targeting === 'self' || targeting === 'none') {
          if (p.radius !== undefined && p.radius <= 16) return enemiesWithin(p.radius) >= 2 || (pressed && enemiesWithin(p.radius) >= 1) ? base : null;
          return pressed ? base : null;
        }
        if (targeting === 'direction') return t && los && d <= reach && (pressed || d < reach * 0.7) ? at(t) : null;
        if (targeting === 'point') {
          if (!t || !los || d > reach) return null;
          return pressed || d < 14 ? this.aimPoint(v, base, groundPointOf(v, t)) : null;
        }
        if (targeting === 'enemy') return t && los && d <= reach && pressed ? at(t) : null;
        if (targeting === 'ally') {
          const ally = this.allyInNeed(v, reach, 0.5, true);
          if (ally) return at(ally);
          return pressed ? { ...base, aimTargetId: undefined } : null;
        }
        return pressed ? base : null;
      }
      case 'heal': {
        if (targeting === 'ally') {
          const ally = this.allyInNeed(v, reach, 0.7, false);
          if (ally) return at(ally);
          return hpFrac < 0.65 ? this.selfTarget(v, base) : null;
        }
        if (p.radius !== undefined && !p.selfHeal && !p.healFrac && !p.missingFrac) {
          // area heals (安娴 / banners) — worth it when I or allies nearby are hurt
          const hurtAllies = v.allies().filter((a) => a.hp < a.maxHp * 0.75 && dist2d(a.pos, self.pos) <= p.radius!).length;
          return hpFrac < 0.7 || hurtAllies >= 1 ? base : null;
        }
        return hpFrac < 0.6 || (hpFrac < 0.75 && fighting && skill > 0.7) ? base : null;
      }
      case 'mobility': {
        const escape = hpFrac < 0.35 && !!threatNear;
        const ideal = idealMax(v);
        if (targeting === 'self' || targeting === 'none') {
          if (escape) return base;
          if (t && d > ideal + 10 && d < 60 && hpFrac > 0.5) return base;
          if (v.mode === 'zone' && !t) return base;
          return null;
        }
        if (targeting === 'enemy') return t && los && d <= reach && d > 4 && hpFrac > 0.45 ? at(t) : null;
        if (escape && threatNear) {
          // dash / blink away from the closest threat
          const away = { x: self.pos.x * 2 - threatNear.e.pos.x, y: self.pos.y + 1, z: self.pos.z * 2 - threatNear.e.pos.z };
          const dir = norm2(away.x - self.pos.x, away.z - self.pos.z);
          const pt = { x: self.pos.x + dir.x * Math.min(reach, 12), y: self.pos.y + 1, z: self.pos.z + dir.z * Math.min(reach, 12) };
          return this.aimPoint(v, base, pt);
        }
        if (!t || !los || hpFrac < 0.5) return null;
        if (d < ideal + 3 || d > reach + ideal) return null;
        if (targeting === 'point') {
          const dir = norm2(t.pos.x - self.pos.x, t.pos.z - self.pos.z);
          const step = Math.min(reach, Math.max(0, d - Math.max(6, ideal * 0.6)));
          return this.aimPoint(v, base, { x: self.pos.x + dir.x * step, y: t.pos.y, z: self.pos.z + dir.z * step });
        }
        // dash with damage on the way (七进七出 / 西凉冲锋) or plain dash: toward the target
        return at(t);
      }
      case 'summon': {
        const busy = (!!t && d < 45) || !!threatNear;
        if (!busy) return null;
        if (targeting === 'point') return t && los && d <= reach ? this.aimPoint(v, base, groundPointOf(v, t)) : null;
        if (targeting === 'direction') return t && los && d <= reach ? at(t) : null;
        if (targeting === 'enemy') return t && los && d <= reach ? at(t) : null;
        return base;
      }
      default: {
        // utility
        const h = self.hero!;
        const freeSlots = h.items.filter((s) => !s).length;
        if (p.hpCost !== undefined && self.hp < self.maxHp * 0.6 + p.hpCost) return null;
        if (targeting === 'point') {
          if (fighting) return null;
          const f = { x: -Math.sin(self.yaw), z: -Math.cos(self.yaw) };
          return this.aimPoint(v, base, { x: self.pos.x + f.x * 4, y: self.pos.y, z: self.pos.z + f.z * 4 });
        }
        if (fighting) {
          const w = v.x.activeWeapon(self.id);
          const dry = !!w && w.def.magSize > 0 && w.inst.mag < w.def.magSize * 0.2;
          if (p.fireRateMul !== undefined) return base;
          if (dry || h.dodgeCharges === 0) return p.extra !== undefined ? base : null;
          return null;
        }
        return freeSlots >= 1 || p.extra !== undefined ? base : null;
      }
    }
  }

  /**
   * Area / dash / cone effects hit everything not on our own side: skip the cast
   * when a believed ally or an uninvolved hero stands in the affected area.
   */
  private safeForFriends(v: BotView, def: AbilityDef, plan: AbilityPlan): boolean {
    const hint = def.aiHint ?? 'utility';
    if (hint === 'heal' || hint === 'utility') return true;
    const targeting = def.targeting ?? 'none';
    if (targeting === 'ally') return true;
    // NPC hordes rushing a point attack everything that is not ours: keep them far from friends
    if ((hint === 'summon' && targeting === 'point') || this.wild.has(def.id)) return wildSummonClear(v, plan.aimPoint, plan.aimTargetId);
    return areaClear(v, def.params, targeting, plan.aimPoint, plan.aimTargetId, abilityReach(def));
  }

  private aimAt(v: BotView, base: AbilityPlan, e: Entity): AbilityPlan {
    const pt = aimPointOf(e);
    const ang = aimAnglesFor(v.self.pos, pt, v.self.hero?.downed === true);
    return { ...base, yaw: ang.yaw, pitch: ang.pitch, aimPoint: pt, aimTargetId: e.id };
  }

  private aimPoint(v: BotView, base: AbilityPlan, pt: Vec3): AbilityPlan {
    const ang = aimAnglesFor(v.self.pos, pt, v.self.hero?.downed === true);
    return { ...base, yaw: ang.yaw, pitch: ang.pitch, aimPoint: pt, aimTargetId: undefined };
  }

  private selfTarget(v: BotView, base: AbilityPlan): AbilityPlan {
    // look slightly down at our own feet: no ally under the crosshair → self fallback
    const pt = { x: v.self.pos.x - Math.sin(v.self.yaw) * 2, y: v.self.pos.y, z: v.self.pos.z - Math.cos(v.self.yaw) * 2 };
    return { ...this.aimPoint(v, base, pt), aimTargetId: v.self.id };
  }

  /** A believed-ally hero within range, in LOS, below `hpFrac` (or under fire when `underFire`). */
  private allyInNeed(v: BotView, range: number, hpFrac: number, underFire: boolean): Entity | undefined {
    const { sim, self } = v;
    let best: Entity | undefined;
    let bs = Infinity;
    for (const a of v.allies()) {
      if (a === self || a.hero?.downed) continue;
      const d = dist2d(a.pos, self.pos);
      if (d > range) continue;
      const frac = a.hp / Math.max(1, a.maxHp);
      const pressed = underFire && v.x.sinceDamaged(a.id) < 1.5;
      if (frac >= hpFrac && !pressed) continue;
      if (!hasLineOfSight(sim, self, a)) continue;
      const s = frac - v.allyScore(a) * 0.3;
      if (s < bs) {
        bs = s;
        best = a;
      }
    }
    return best;
  }
}

/** Heroes this bot must not hit with an area effect. */
export function protectedHero(v: BotView, e: Entity, targetId: number | undefined): boolean {
  if (e === v.self || !e.hero || e.hero.dead || e.id === targetId) return false;
  return v.allyScore(e) >= 0.5 || v.hostility(e) < 0.6;
}

/**
 * Is the area an effect would cover free of protected heroes? `targeting`
 * decides the shape: around self (radius), around the aim point (radius), or a
 * corridor / cone toward the aim point (length = reach).
 */
export function areaClear(
  v: BotView,
  p: Record<string, number>,
  targeting: string,
  aim: Vec3 | undefined,
  targetId: number | undefined,
  reach: number,
): boolean {
  const self = v.self;
  const heroes = v.sim.heroes();
  const radius = p.radius ?? p.explodeRadius ?? p.fieldRadius ?? 0;
  if (targeting === 'self' || targeting === 'none') {
    if (radius <= 0) return true;
    for (const e of heroes) if (protectedHero(v, e, targetId) && dist2d(e.pos, self.pos) <= radius + 1) return false;
    return true;
  }
  if (targeting === 'enemy') {
    const r = p.radius ?? 0;
    if (r <= 0 || !aim) return true;
    for (const e of heroes) if (protectedHero(v, e, targetId) && dist2d(e.pos, aim) <= r * 0.6) return false;
    return true;
  }
  if (!aim) return true;
  if (targeting === 'point') {
    const r = Math.max(3, radius);
    for (const e of heroes) if (protectedHero(v, e, targetId) && dist2d(e.pos, aim) <= r + 1) return false;
    return true;
  }
  // direction: corridor from self toward the aim, `reach` long
  const dx = aim.x - self.pos.x;
  const dz = aim.z - self.pos.z;
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l;
  const uz = dz / l;
  const width = Math.max(2, (p.width ?? 0) + 1, radius + 1, p.arc ? (p.range ?? 4) * 0.8 : 0);
  const len = reach + radius;
  for (const e of heroes) {
    if (!protectedHero(v, e, targetId)) continue;
    const rx = e.pos.x - self.pos.x;
    const rz = e.pos.z - self.pos.z;
    const along = rx * ux + rz * uz;
    if (along < -1 || along > len) continue;
    if (Math.abs(rx * uz - rz * ux) <= width) return false;
  }
  return true;
}

/** Own summoned NPCs around the bot. */
function ownNpcs(v: BotView): number {
  let n = 0;
  for (const e of v.sim.queryRadius(v.self.pos, 40, { kinds: ['npc'] })) if (e.npc?.summonerId === v.self.id) n++;
  return n;
}

/** No protected hero within 25 m of the rush point or of us (summoned NPC hordes). */
export function wildSummonClear(v: BotView, aim: Vec3 | undefined, targetId: number | undefined): boolean {
  for (const e of v.sim.heroes()) {
    if (!protectedHero(v, e, targetId)) continue;
    if (dist2d(e.pos, v.self.pos) < 25 || (aim && dist2d(e.pos, aim) < 25)) return false;
  }
  return true;
}

function norm2(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

function groundPointOf(v: BotView, e: Entity): Vec3 {
  // lead a little along the target's motion
  const lead = 0.4 * v.prof.leadSkill;
  return { x: e.pos.x + e.vel.x * lead, y: e.pos.y + 0.2, z: e.pos.z + e.vel.z * lead };
}

function idealMax(v: BotView): number {
  const w = v.weapon;
  if (!w) return 20;
  switch (w.class) {
    case 'shotgun':
    case 'flamer':
      return 9;
    case 'smg':
    case 'pistol':
      return 16;
    case 'sniper':
    case 'bow':
      return 70;
    case 'dmr':
      return 45;
    default:
      return 30;
  }
}
