// Generic ability use for every hero, driven by AbilityDef.targeting + aiHint
// + params (range / dash / radius …), with cooldown / charge awareness and a
// back-off when an activation fails (no valid target, not implemented yet).
//  offense  → on the target when it is in range / line of sight
//  defense  → when under fire (or enemies inside the ability radius)
//  heal     → when hurt (self) or on a hurt believed ally
//  mobility → dash in to engage a fleeing / distant target, or away to escape
//  summon   → when a fight is on
//  utility  → when safe (item draws) or when it fixes a problem (reload/dodges)
// A plan only says what to aim at (botTypes CastAim): HeroBot turns the view
// with the human aim model and presses when the crosshair is on it, then
// reports back (pressed / aimFailed).
import type { Vec3 } from '../../core/math';
import type { AbilitySlot, Entity } from '../../core/types';
import { isPassiveAbility } from '../../data';
import type { AbilityDef } from '../../data/types';
import { getAbility } from '../abilities/registry';
import type { AbilityPlan, BotView, CastAim } from './botTypes';
import { ownRole } from './knowledge';
import { aimPointOf, dist2d, hasLineOfSight } from './perception';

const SLOTS: AbilitySlot[] = ['q', 'e', 'lord'];
const FAIL_BACKOFF = 5;
/** could not get the crosshair onto the target in time: try again a little later */
const AIM_BACKOFF = 1.5;
/** params that make a self-centred area cast touch other units (damage, control, displacement) */
const HARMFUL_PARAMS = ['damage', 'dmg', 'dps', 'strike', 'knockback', 'stun', 'slow', 'root', 'freeze', 'burn', 'poison', 'charm', 'silence', 'disarm', 'pull', 'fear', 'dance', 'taunt', 'explodeRadius', 'fieldRadius', 'chain'];

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

  /** Pick at most one ability to cast now (HeroBot aims it, then calls pressed()). */
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
      if (plan) return plan;
    }
    return null;
  }

  /** Is the planned ability still ready (cooldown / charges), e.g. after aiming for a while? */
  stillReady(v: BotView, abilityId: string): boolean {
    const def = v.sim.heroDef(v.self)?.abilities.find((a) => a.id === abilityId);
    return !!def && this.ready(v, def);
  }

  /** The bot pressed the ability: watch whether it fired. */
  pressed(v: BotView, plan: AbilityPlan): void {
    const h = v.self.hero!;
    this.pending = { id: plan.abilityId, at: v.now, cdBefore: v.sim.cooldownLeft(v.self.id, plan.abilityId), chargesBefore: h.charges[plan.abilityId] ?? 0, npcsBefore: ownNpcs(v) };
  }

  /** The bot could not aim the ability in time. */
  aimFailed(v: BotView, abilityId: string): void {
    this.backoff.set(abilityId, v.now + AIM_BACKOFF * (0.7 + v.rng.next() * 0.6));
  }

  /**
   * WEI-11: while an enemy-targeted mobility ability (张辽 突袭…) is ready and
   * we are healthy, keep the fight inside its reach so it can be pressed.
   * Returns the capped preferred distance, or undefined.
   */
  engageCap(v: BotView): number | undefined {
    const { sim, self, now } = v;
    if (self.hp < self.maxHp * 0.45) return undefined;
    const hero = sim.heroDef(self);
    if (!hero) return undefined;
    let cap: number | undefined;
    for (const def of hero.abilities) {
      if (def.slot !== 'q' && def.slot !== 'e') continue;
      if ((def.aiHint ?? 'utility') !== 'mobility' || (def.targeting ?? 'none') !== 'enemy') continue;
      if (!getAbility(def.id)?.activate || (this.backoff.get(def.id) ?? 0) > now || !this.ready(v, def)) continue;
      const r = abilityReach(def) - 1.5;
      if (r > 3) cap = cap === undefined ? r : Math.min(cap, r);
    }
    return cap;
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
    const hint = def.aiHint ?? 'utility';
    const targeting = def.targeting ?? 'none';
    const enemiesWithin = (r: number): number => v.threats.filter((x) => x.hostility >= 0.45 && x.dist <= r).reduce((s, x) => s + (x.e.kind === 'hero' ? 2 : 1), 0);
    const base: AbilityPlan = { slot, abilityId: def.id, mode: 'none' };
    // lock-on (targeted) vs. aimed at the entity's position (dashes, lines, cones, projectiles)
    const at = (e: Entity): AbilityPlan => (targeting === 'enemy' || targeting === 'ally' ? lockOn(base, e) : { ...base, mode: 'point', targetId: e.id, leadSpeed: p.speed });
    const ground = (e: Entity): AbilityPlan => ({ ...base, mode: 'point', targetId: e.id, ground: true });
    switch (hint) {
      case 'offense': {
        if (!t || !los) return null;
        if (targeting === 'self' || targeting === 'none') {
          if (p.radius !== undefined && p.radius <= 12 && !p.fireRateMul && !p.mul) return enemiesWithin(p.radius) >= 2 ? base : null;
          return d < Math.min(35, reach + 20) && (tHero || v.threats.length >= 3) ? base : null;
        }
        if (targeting === 'enemy') return d <= reach && (tHero || skill < 0.5) ? at(t) : null;
        if (targeting === 'point') return d <= reach + (p.radius ?? 0) * 0.5 ? ground(t) : null;
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
          return pressed || d < 14 ? ground(t) : null;
        }
        if (targeting === 'enemy') return t && los && d <= reach && pressed ? at(t) : null;
        if (targeting === 'ally') {
          const ally = this.allyInNeed(v, def, reach, 0.5, true);
          if (ally) return at(ally);
          return pressed && !p.maleOnly ? base : null;
        }
        return pressed ? base : null;
      }
      case 'heal': {
        if (targeting === 'ally') {
          const ally = this.allyInNeed(v, def, reach, 0.7, false);
          if (ally) return at(ally);
          if (hpFrac >= 0.65) return null;
          // WU-9 结姻 heals only with a male hero under the crosshair (and never "self" alone):
          // any believed-ally man in reach will do — the heal on us is what counts
          if (p.maleOnly) {
            const man = this.allyInNeed(v, def, reach, 2, false);
            return man ? at(man) : null;
          }
          return this.selfTarget(v, base);
        }
        if (p.radius !== undefined && !p.selfHeal && !p.healFrac && !p.missingFrac) {
          // area heals (安娴 / banners) — worth it when I or allies nearby are hurt
          const hurtAllies = v.allies().filter((a) => v.hpFrac(a) < 0.75 && dist2d(v.posOf(a)!, self.pos) <= p.radius!).length;
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
          const dir = norm2(self.pos.x - threatNear.e.pos.x, self.pos.z - threatNear.e.pos.z);
          const pt = { x: self.pos.x + dir.x * Math.min(reach, 12), y: self.pos.y + 1, z: self.pos.z + dir.z * Math.min(reach, 12) };
          return { ...base, mode: 'point', point: pt };
        }
        if (!t || !los || hpFrac < 0.5) return null;
        if (d < ideal + 3 || d > reach + ideal) return null;
        if (targeting === 'point') {
          const dir = norm2(t.pos.x - self.pos.x, t.pos.z - self.pos.z);
          const step = Math.min(reach, Math.max(0, d - Math.max(6, ideal * 0.6)));
          return { ...base, mode: 'point', point: { x: self.pos.x + dir.x * step, y: t.pos.y, z: self.pos.z + dir.z * step } };
        }
        // dash with damage on the way (七进七出 / 西凉冲锋) or plain dash: toward the target
        return at(t);
      }
      case 'summon': {
        const busy = (!!t && d < 45) || !!threatNear;
        if (!busy) return null;
        if (targeting === 'point') return t && los && d <= reach ? ground(t) : null;
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
          // a drop / deployable right in front of us (far enough ahead to aim at comfortably)
          const f = { x: -Math.sin(self.yaw), z: -Math.cos(self.yaw) };
          const px = self.pos.x + f.x * 8;
          const pz = self.pos.z + f.z * 8;
          return { ...base, mode: 'point', point: { x: px, y: v.sim.groundHeight(px, pz), z: pz } };
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
    // WEI-11: a private reveal (狼顾) or a radius-only self buff touches nobody else
    if (def.params.privateReveal) return true;
    if ((targeting === 'self' || targeting === 'none') && !HARMFUL_PARAMS.some((k) => def.params[k] !== undefined)) return true;
    const aim = planPoint(v, plan);
    // NPC hordes rushing a point attack everything that is not ours: keep them far from friends
    if ((hint === 'summon' && targeting === 'point') || this.wild.has(def.id)) return wildSummonClear(v, aim, plan.targetId);
    return areaClear(v, def.params, targeting, aim, plan.targetId, abilityReach(def));
  }

  private selfTarget(v: BotView, base: AbilityPlan): AbilityPlan {
    // look at the ground ahead: no ally under the crosshair → the ability's self fallback
    const px = v.self.pos.x - Math.sin(v.self.yaw) * 6;
    const pz = v.self.pos.z - Math.cos(v.self.yaw) * 6;
    const pt = { x: px, y: v.sim.groundHeight(px, pz), z: pz };
    return { ...base, mode: 'point', point: pt };
  }

  /**
   * A believed-ally hero within range, in LOS, below `hpFrac` (or under fire when
   * `underFire`); male only for 结姻-style abilities (params.maleOnly, WU-9).
   */
  private allyInNeed(v: BotView, def: AbilityDef, range: number, hpFrac: number, underFire: boolean): Entity | undefined {
    const { sim, self } = v;
    let best: Entity | undefined;
    let bs = Infinity;
    for (const a of v.allies()) {
      if (a === self || a.hero?.downed) continue;
      if (def.params.maleOnly && sim.heroDef(a)?.gender !== 'male') continue;
      if (!v.seesNow(a)) continue;
      const d = dist2d(a.pos, self.pos);
      if (d > range) continue;
      const frac = v.hpFrac(a);
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

/**
 * The 主公 keeps a wider berth around his own side with area effects (m): a loyalist who steps
 * into an arrow rain or a lightning strike he called is his own defeat — and a lasting effect
 * (a rain, a storm cloud that follows its target) has seconds for his escort to walk into.
 */
function lordMargin(v: BotView, p: Record<string, number>): number {
  if (ownRole(v.self) !== 'lord') return 0;
  const lasting = (p.duration ?? p.lifetime ?? p.fieldTime ?? 0) > 1;
  return lasting ? 14 : 5;
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
  const heroes = knownHeroes(v);
  const margin = lordMargin(v, p);
  const radius = (p.radius ?? p.explodeRadius ?? p.fieldRadius ?? 0) + margin;
  if (targeting === 'self' || targeting === 'none') {
    if (radius <= 0) return true;
    for (const e of heroes) if (protectedHero(v, e.e, targetId) && dist2d(e.p, self.pos) <= radius + 1) return false;
    return true;
  }
  if (targeting === 'enemy') {
    const r = p.radius ?? 0;
    if (r <= 0 || !aim) return true;
    for (const e of heroes) if (protectedHero(v, e.e, targetId) && dist2d(e.p, aim) <= r * 0.6 + margin) return false;
    return true;
  }
  if (!aim) return true;
  if (targeting === 'point') {
    const r = Math.max(3, radius);
    for (const e of heroes) if (protectedHero(v, e.e, targetId) && dist2d(e.p, aim) <= r + 1) return false;
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
    if (!protectedHero(v, e.e, targetId)) continue;
    const rx = e.p.x - self.pos.x;
    const rz = e.p.z - self.pos.z;
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
  for (const e of knownHeroes(v)) {
    if (!protectedHero(v, e.e, targetId)) continue;
    if (dist2d(e.p, v.self.pos) < 25 || (aim && dist2d(e.p, aim) < 25)) return false;
  }
  return true;
}

/** Other living heroes whose position this seat knows right now (seen / minimap / recent). */
export function knownHeroes(v: BotView, maxAge = 1.5): { e: Entity; p: Vec3 }[] {
  const out: { e: Entity; p: Vec3 }[] = [];
  for (const e of v.sim.heroes()) {
    if (e === v.self || !e.hero || e.hero.dead) continue;
    const p = v.posOf(e, maxAge);
    if (p) out.push({ e, p });
  }
  return out;
}

/** Where a plan's effect will be centred (for the friendly-fire checks). */
export function planPoint(v: BotView, plan: CastAim): Vec3 | undefined {
  if (plan.point) return plan.point;
  if (plan.targetId === undefined) return undefined;
  const t = v.sim.get(plan.targetId);
  if (!t) return undefined;
  return plan.ground ? groundPointOf(v, t) : aimPointOf(t);
}

const lockOn = <P extends CastAim>(base: P, e: Entity): P => ({ ...base, mode: 'lock', targetId: e.id });

function norm2(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

export function groundPointOf(v: BotView, e: Entity): Vec3 {
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
