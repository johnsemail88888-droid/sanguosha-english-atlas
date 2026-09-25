// Role strategies (身份局): who a bot considers hostile, who it protects, and
// what it wants to do when it is not busy fighting / healing / looting.
//  主公 Lord      — camps near the palace with his squad early, gears up, fights
//                    revealed / suspected rebels, never executes likely loyalists,
//                    falls back behind loyalists when hurt.
//  忠臣 Loyalist  — gears up briefly, then escorts the lord and hunts whoever
//                    shoots him; claims 忠 when it helps.
//  影武者 Double  — escorts the real lord as a decoy crown.
//  反贼 Rebel     — loots, keeps away from the crowns, regroups at a rally point
//                    and pushes the lord together at a public-clock push window
//                    (sooner when the lord is weak); avoids dying first.
//  内奸 Traitor   — keeps the balance (helps the weaker side), never lets the lord
//                    die while rebels live, purges the loyal side once rebels are
//                    gone, then heals up and duels the lord. Lies with 忠 claims.
//  墙头草 Opportunist — survives: loots, hides far from fights, only shoots back.
//  赏金猎人 Bounty — gears up, then hunts its secret target when it is weak or
//                    isolated; otherwise plays safe.
import type { Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Entity, InputFrame, RoleId } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import type { BotMode, BotView } from './botTypes';
import type { DifficultyProfile } from './difficulty';
import { aliveCrowns, ownBountyTarget, realLordFor, roleKnownTo, wearsCrown } from './knowledge';

export interface Objective {
  mode: BotMode;
  goal: Vec3 | null;
  arrive: number;
  sprint: boolean;
}

const LORD_SIDE: ReadonlySet<RoleId> = new Set<RoleId>(['lord', 'loyalist', 'double']);
/** hostility toward whoever just shot me */
const RETALIATE = 0.93;
/** hostility (lord side) toward whoever just shot a crown */
const DEFEND = 0.97;
/** rebels move to the staging ring this long before the push */
const STAGE_TIME = 25;
/**
 * staging ring radius around the lord (m). Roles are hidden: nobody shoots a hero who has done
 * nothing, and a bot rebel's own soldiers hold fire until he opens up (troopBrain follows the
 * commander), so rebels can walk right up to the lord's escort and strike together.
 */
const STAGE_RADIUS = 24;
/** recent damage (decaying ~4 s) that counts as being attacked, not a stray bullet */
const PROVOKE_DMG = 22;
/** recent damage to a crown that makes the lord side retaliate */
const DEFEND_DMG = 15;

/**
 * Is `x` currently trading fire with a hero that is itself attacking a crown or
 * `self`'s side (so its hits on bystanders are probably collateral)?
 */
export function fightingOther(v: BotView, x: Entity, self: Entity): boolean {
  const { sim, obs } = v;
  for (const o of sim.heroes()) {
    if (o === x || o === self || !o.hero || o.hero.dead) continue;
    // x is shooting at someone else (the hero or its squad): hits on us are likely collateral
    if (obs.recentDamage(sim, x.id, o.id) >= 10) return true;
  }
  return false;
}

/** Is `x` pointing its weapon at `at` (within `deg`)? Facing is public (you see where people aim). */
export function facing(x: Entity, at: Entity, deg: number): boolean {
  const dx = at.pos.x - x.pos.x;
  const dz = at.pos.z - x.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 3) return true;
  const fx = -Math.sin(x.yaw);
  const fz = -Math.cos(x.yaw);
  return (fx * dx + fz * dz) / d >= Math.cos((deg * Math.PI) / 180);
}

/**
 * 0..1 end-game pressure: from ~5:30 the closing circle forces decisions, so
 * bots act on weaker suspicion (engage thresholds drop, evidence caps lift).
 */
export function pressure(now: number): number {
  return clamp((now - 330) / 90, 0, 1);
}

/**
 * Belief-only hostility: capped at `cap` without evidence about the hero,
 * except when the table leaves no doubt (posterior ≥ 0.97).
 */
function sure(p: number, cap: number): number {
  return p >= 0.97 ? 1 : Math.min(p, cap);
}

export class RoleStrategy {
  /** rebels: when the coordinated push on the lord starts */
  readonly pushAt: number;
  /** loyalists / double: gear-up window before escorting */
  readonly gearUntil: number;
  /** lord: camping at the palace until */
  readonly campUntil: number;
  /** escort slot angle around the lord */
  private readonly escortAngle: number;
  private rally: Vec3 | null = null;
  private rallyAt = -99;
  private hidePoint: Vec3 | null = null;
  private hideAt = -99;
  private wanderGoal: Vec3 | null = null;
  private wanderUntil = 0;
  private claimed = 0;
  private nextClaimAt: number;
  private lastChatAt = -99;
  private downedChat = false;
  private lastRevivedAt = -99;
  private pushAnnounced = false;
  private spawn: Vec3 | null = null;
  private readonly fakeLoyal: boolean;
  private readonly claimRebelAtPush: boolean;

  constructor(
    seat: number,
    private readonly prof: DifficultyProfile,
    private readonly rng: Rng,
  ) {
    // the push window is on the public clock (every rebel reads the same zone timer), so the
    // rebels converge on the lord together without knowing each other
    this.pushAt = prof.lootPhase + 115 + rng.next() * 5;
    this.gearUntil = Math.min(prof.lootPhase - 35, 80) + rng.next() * 12;
    this.campUntil = prof.lootPhase + 55;
    this.escortAngle = ((seat * 2.39996) % (Math.PI * 2)) + rng.next() * 0.4;
    this.nextClaimAt = 35 + rng.next() * 60;
    this.fakeLoyal = rng.next() < 0.5;
    this.claimRebelAtPush = rng.next() < 0.5;
  }

  // ── who is who ──────────────────────────────────────────────────────────
  /** The crown this bot escorts or hunts. */
  crownRef(v: BotView): Entity | undefined {
    const { sim, self } = v;
    const real = realLordFor(sim, self);
    if (real && real !== self && real.hero && !real.hero.dead) return real;
    const crowns = aliveCrowns(sim, self);
    if (crowns.length === 0) return undefined;
    if (crowns.length === 1) return crowns[0];
    let best = crowns[0];
    let bs = -Infinity;
    for (const c of crowns) {
      const tell = this.prof.subtleReads ? v.beliefs.crownLordTell(c.id) : 0;
      const s = tell * 10 - Math.hypot(c.pos.x - self.pos.x, c.pos.z - self.pos.z) / 10 - c.id * 1e-4;
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    return best;
  }

  /** Has the rebels' coordinated push started (public clock, or the lord is weak)? */
  pushing(v: BotView): boolean {
    if (v.role !== 'rebel') return false;
    if (v.now >= this.pushAt) return true;
    const lord = this.crownRef(v);
    if (!lord || v.now < this.prof.lootPhase * 0.5) return false;
    // the lord is weak, or someone is already hitting him: everybody in
    if (lord.hp < lord.maxHp * 0.6) return true;
    // staging and the fight has started anyway (the lord is hit, or his side is shooting at
    // someone): no point waiting for the clock
    return v.now >= this.pushAt - STAGE_TIME && (this.lordUnderAttack(v, lord) || this.lordSideFiring(v, lord));
  }

  /** The crown (or its squad, credited to him) is shooting at a non-crown hero right now. */
  private lordSideFiring(v: BotView, lord: Entity): boolean {
    for (const o of v.sim.heroes()) {
      if (o === lord || !o.hero || o.hero.dead || wearsCrown(v.sim, o)) continue;
      if (v.obs.recentDamage(v.sim, lord.id, o.id) >= 10) return true;
    }
    return false;
  }

  /** Rebels close in on a staging ring shortly before the push, so they arrive together. */
  staging(v: BotView): boolean {
    return v.role === 'rebel' && v.now >= this.pushAt - STAGE_TIME && v.now < this.pushAt;
  }

  /** Is anyone else (not a crown) hurting the lord right now? Public: hit markers / tracers. */
  private lordUnderAttack(v: BotView, lord: Entity): boolean {
    for (const o of v.sim.heroes()) {
      if (o === v.self || o === lord || !o.hero || o.hero.dead || wearsCrown(v.sim, o)) continue;
      if (v.obs.recentDamage(v.sim, o.id, lord.id) >= 10) return true;
    }
    return false;
  }

  /** Traitor: only crowns (and neutrals) are left besides me. */
  traitorEndgame(v: BotView): boolean {
    const tk = v.beliefs.table;
    if (!tk) return false;
    const crowns = aliveCrowns(v.sim, v.self).length;
    return tk.nonNeutralOthersAlive <= crowns + 0.25;
  }

  /** 0..1 hostility toward a hero from this bot's seat. */
  heroHostility(v: BotView, x: Entity): number {
    const { sim, self, beliefs, obs } = v;
    const h = x.hero;
    if (!h || h.dead || x === self) return 0;
    const role = v.role;
    const crownX = wearsCrown(sim, x);
    const known = roleKnownTo(sim, self, x);
    const ls = beliefs.lordSideness(sim, self, x);
    const rb = beliefs.rebelness(sim, self, x);
    const tr = beliefs.p(sim, self, x, 'traitor');
    const neu = beliefs.p(sim, self, x, 'opportunist') + beliefs.p(sim, self, x, 'bounty');
    // real provocation (a burst of damage, not one stray pellet; much more when x is busy
    // fighting someone else near us — collateral)
    // x fighting someone else, or visibly pointing elsewhere when it hit us
    const busy = fightingOther(v, x, self) || !facing(x, self, 25);
    // believed allies get the benefit of the doubt (stray fire), strangers much less
    const friendly = this.allyScore(v, x) >= 0.55;
    // …and more than one hit: a single grenade / blast next to us may have been meant for someone else
    const hurtBadly = self.hp < self.maxHp * 0.5;
    const provoked =
      obs.recentDamage(sim, x.id, self.id) >= PROVOKE_DMG * (busy ? 3 : 1) * (friendly ? 3 : 1) && (hurtBadly || obs.recentHits(sim, x.id, self.id) >= 1.8);
    const tk = beliefs.table;
    const rebelsLeft = tk ? tk.rebelsAlive : 1;
    // suspicion alone never outweighs a lack of evidence about this very hero (unless the table
    // forces it) — until the closing circle forces a decision
    const cap = known !== undefined ? 1 : beliefs.evidenceMagnitude(x.id) >= 0.6 ? 1 : 0.75 + 0.25 * pressure(v.now);
    let hst = 0;
    switch (role) {
      case 'lord': {
        if (known === 'double') return 0;
        hst = Math.min(rb + tr * (rebelsLeft > 0.5 ? 0.35 : 1) + neu * 0.05, sure(rb + tr, cap));
        if (provoked) hst = Math.max(hst, ls > 0.7 ? 0.25 : RETALIATE);
        // 主公 must never execute a likely loyalist (drops everything)
        if (ls > 0.45) hst = Math.min(hst, 0.3);
        break;
      }
      case 'loyalist':
      case 'double': {
        if (crownX) return 0;
        hst = Math.min(rb + tr * (rebelsLeft > 0.5 ? 0.35 : 1) + neu * 0.05, sure(rb + tr, cap));
        let crownDmg = 0;
        let crownFaced = false;
        for (const c of aliveCrowns(sim, self)) {
          if (c === x) continue;
          const dmg = obs.recentDamage(sim, x.id, c.id);
          if (dmg > crownDmg) {
            crownDmg = dmg;
            crownFaced = facing(x, c, 25);
          }
        }
        if (crownDmg >= (busy || !crownFaced ? DEFEND_DMG * 4 : DEFEND_DMG)) hst = Math.max(hst, ls > 0.75 ? 0.35 : DEFEND);
        if (provoked) hst = Math.max(hst, ls > 0.75 ? 0.3 : RETALIATE);
        break;
      }
      case 'rebel': {
        if (crownX) {
          // before the push, rebels leave the crowns alone unless cornered
          const dx = Math.hypot(x.pos.x - self.pos.x, x.pos.z - self.pos.z);
          hst = this.pushing(v) || provoked ? 1 : dx < 25 && x.hp < x.maxHp * 0.35 ? 0.9 : 0.3;
        } else {
          hst = Math.min(ls + tr * 0.25 + neu * 0.05, sure(ls, cap));
          if (provoked) hst = Math.max(hst, rb > 0.7 ? 0.3 : RETALIATE);
        }
        break;
      }
      case 'traitor': {
        const endgame = this.traitorEndgame(v);
        const ready = this.traitorReady(v);
        if (crownX) {
          // the lord must not fall while rebels live (they would win); at the end, duel him —
          // from strength (healed up), or when he is already on his knees
          if (!endgame) {
            hst = 0;
          } else if (aliveCrowns(sim, self).length >= 2) {
            // two crowns: the 影武者 must die first (killing the real lord while the decoy lives
            // hands the win to the rebels) — go for the crown that looks less like the lord
            hst = x === this.crownRef(v) ? 0.3 : ready ? 1 : 0.5;
          } else {
            hst = ready || x.hp < x.maxHp * 0.3 ? 1 : 0.5;
          }
          break;
        }
        if (rebelsLeft > 0.5) {
          const bal = this.balance(v);
          // keep the balance, third-party style: while the lord side is ahead, pick off loyalists
          // that are busy with (or weakened by) the rebels; while the rebels are ahead, hit rebels
          let busyWithRebels = false;
          for (const o of sim.heroes()) {
            if (o === x || o === self || !o.hero || o.hero.dead) continue;
            if (beliefs.rebelness(sim, self, o) > 0.6 && obs.recentDamage(sim, o.id, x.id) >= 10) {
              busyWithRebels = true;
              break;
            }
          }
          const hitLoyal = bal < 0.85 ? (busyWithRebels || x.hp < x.maxHp * 0.5 ? 1 : 0.6) : bal < 1.1 ? 0.3 : 0;
          const hitRebels = bal > 1.2 ? 1 : bal > 0.85 ? 0.5 : 0.3;
          hst = Math.min(cap, Math.max(ls * hitLoyal, rb * hitRebels));
          // the lord is going down: save him from whoever is hitting him (rebels would win)
          for (const c of aliveCrowns(sim, self)) {
            if (c.hp < c.maxHp * 0.35 && obs.recentDamage(sim, x.id, c.id) >= 10) hst = Math.max(hst, DEFEND);
          }
        } else {
          // rebels gone: purge the loyal side one by one, but only from strength
          hst = Math.min(cap, ls + neu * 0.1);
          if (!ready) hst = Math.min(hst, 0.5);
        }
        if (provoked) hst = Math.max(hst, RETALIATE);
        break;
      }
      case 'opportunist':
        hst = provoked ? RETALIATE : this.safeKill(v, x) ? 0.95 : 0;
        break;
      case 'bounty': {
        const tgt = ownBountyTarget(self);
        const hunting = v.now >= this.prof.lootPhase;
        hst = x.id === tgt ? (hunting ? 1 : 0.4) : 0;
        if (provoked) hst = Math.max(hst, RETALIATE);
        break;
      }
      default:
        hst = provoked ? RETALIATE : 0;
    }
    return clamp(hst, 0, 1);
  }

  /**
   * Neutral third-party: a hero that is down (or nearly) close by, with nobody
   * else around who could punish us for finishing it.
   */
  safeKill(v: BotView, x: Entity): boolean {
    const { sim, self } = v;
    if (wearsCrown(sim, x)) return false;
    if (!x.hero?.downed && x.hp > x.maxHp * 0.15) return false;
    if (Math.hypot(x.pos.x - self.pos.x, x.pos.z - self.pos.z) > 22 || self.hp < self.maxHp * 0.5) return false;
    for (const o of sim.heroes()) {
      if (o === x || o === self || !o.hero || o.hero.dead || o.hero.downed) continue;
      if (Math.hypot(o.pos.x - x.pos.x, o.pos.z - x.pos.z) < 25) return false;
    }
    return true;
  }

  /** Traitor: healthy enough to take on the lord side (or out of 桃 to heal with). */
  traitorReady(v: BotView): boolean {
    const self = v.self;
    const frac = self.hp / Math.max(1, self.maxHp);
    const hasTao = self.hero!.items.some((s) => s?.id === 'tao');
    // the closing circle will kill the smaller HP pool first: no more waiting
    if (pressure(v.now) >= 0.6) return true;
    return frac >= 0.75 || (!hasTao && frac >= 0.45);
  }

  /** Rebel strength / lord-side strength (from this bot's beliefs). */
  balance(v: BotView): number {
    const { sim, self, beliefs } = v;
    let lord = 0;
    let rebel = 0;
    for (const e of sim.heroes()) {
      if (!e.hero || e.hero.dead || e === self) continue;
      const f = e.hero.downed ? 0.15 : e.hp / Math.max(1, e.maxHp);
      if (wearsCrown(sim, e)) {
        lord += 1.3 * f;
        continue;
      }
      lord += beliefs.lordSideness(sim, self, e) * f;
      rebel += beliefs.rebelness(sim, self, e) * f;
    }
    return rebel / Math.max(0.2, lord);
  }

  /** 0..1 how much this bot treats hero `x` as a friend (friendly fire, revives, heals). */
  allyScore(v: BotView, x: Entity): number {
    const { sim, self, beliefs } = v;
    if (!x.hero || x === self) return 0;
    const crownX = wearsCrown(sim, x) && !x.hero.dead;
    switch (v.role) {
      case 'lord':
      case 'loyalist':
      case 'double':
        return crownX ? 1 : beliefs.lordSideness(sim, self, x);
      case 'rebel':
        return crownX ? 0 : beliefs.rebelness(sim, self, x);
      case 'traitor': {
        // keep the lord alive while rebels live
        const tk = beliefs.table;
        return crownX && (tk ? tk.rebelsAlive > 0.5 : true) ? 0.8 : 0;
      }
      default:
        return 0;
    }
  }

  /** Would this bot spend a 桃 to revive `x`? */
  wantsRevive(v: BotView, x: Entity): boolean {
    return this.allyScore(v, x) >= (wearsCrown(v.sim, x) ? 0.5 : 0.62);
  }

  // ── objectives ──────────────────────────────────────────────────────────
  /** Loot radius around the bot allowed right now (0 = don't loot). */
  lootRadius(v: BotView): number {
    const t = v.now;
    switch (v.role) {
      case 'lord':
        return t < this.campUntil ? 32 : 18;
      case 'loyalist':
      case 'double':
        return t < this.gearUntil ? 45 : 16;
      case 'rebel':
        return t < this.prof.lootPhase ? 55 : this.pushing(v) ? 10 : 30;
      case 'traitor':
        return this.traitorEndgame(v) ? 45 : 40;
      default:
        return 45;
    }
  }

  /** Where to be when nothing urgent is happening. */
  objective(v: BotView): Objective {
    const { sim, self, now } = v;
    if (!this.spawn) this.spawn = { ...self.pos };
    const lord = this.crownRef(v);
    const zg = v.zoneGoal();
    const zone = ext(sim).zoneView();
    const clampZone = (p: Vec3): Vec3 => clampIntoZone(sim, p, now);
    switch (v.role) {
      case 'lord': {
        if (now < this.campUntil && !zg) {
          const home = sim.map.lordSpawn;
          if (Math.hypot(self.pos.x - home.x, self.pos.z - home.z) > 14) return { mode: 'guard', goal: { ...home }, arrive: 4, sprint: false };
          return this.wander(v, home, 10, 'guard');
        }
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        // stay with the believed loyal side
        const friends = v.allies().filter((a) => !wearsCrown(sim, a) || roleKnownTo(sim, self, a) === 'double');
        if (friends.length > 0) {
          const c = centroid(friends);
          if (Math.hypot(c.x - self.pos.x, c.z - self.pos.z) > 14) return { mode: 'guard', goal: clampZone(c), arrive: 6, sprint: false };
        }
        return this.wander(v, zone.targetCenter, Math.max(6, zone.targetRadius * 0.35), 'guard');
      }
      case 'loyalist':
      case 'double': {
        if (zg && (!lord || now < this.gearUntil)) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        if (lord && now >= this.gearUntil) {
          const r = v.role === 'double' ? 14 : 8;
          const g = { x: lord.pos.x + Math.cos(this.escortAngle) * r, y: lord.pos.y, z: lord.pos.z + Math.sin(this.escortAngle) * r };
          const d = Math.hypot(lord.pos.x - self.pos.x, lord.pos.z - self.pos.z);
          return { mode: 'escort', goal: g, arrive: 3, sprint: d > 25 };
        }
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        return this.wander(v, this.spawn, 30, 'wander');
      }
      case 'rebel': {
        if (zg && !this.pushing(v)) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        if (lord) {
          const d = Math.hypot(lord.pos.x - self.pos.x, lord.pos.z - self.pos.z);
          if (this.pushing(v)) return { mode: 'hunt', goal: { ...lord.pos }, arrive: 6, sprint: d > 35 };
          if (this.staging(v)) {
            // staging ring: close enough to arrive together, beyond the lord's soldiers' reach
            const ax = self.pos.x - lord.pos.x;
            const az = self.pos.z - lord.pos.z;
            const l = Math.hypot(ax, az) || 1;
            const g = clampZone({ x: lord.pos.x + (ax / l) * STAGE_RADIUS, y: lord.pos.y, z: lord.pos.z + (az / l) * STAGE_RADIUS });
            return { mode: 'regroup', goal: g, arrive: 5, sprint: d > STAGE_RADIUS + 25 };
          }
          if (now >= this.prof.lootPhase) {
            const rally = this.rallyPoint(v, lord);
            const far = Math.hypot(rally.x - self.pos.x, rally.z - self.pos.z);
            // at the rally point: patrol around it while waiting for the push
            if (far < 12) return this.wander(v, rally, 14, 'regroup');
            return { mode: 'regroup', goal: rally, arrive: 6, sprint: far > 30 };
          }
          if (d < 62) {
            // too close to the crown before the push: back off
            const ax = self.pos.x - lord.pos.x;
            const az = self.pos.z - lord.pos.z;
            const l = Math.hypot(ax, az) || 1;
            return { mode: 'wander', goal: clampZone({ x: lord.pos.x + (ax / l) * 75, y: self.pos.y, z: lord.pos.z + (az / l) * 75 }), arrive: 5, sprint: false };
          }
        }
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        return this.wander(v, zone.targetCenter, zone.targetRadius * 0.7, 'wander');
      }
      case 'traitor': {
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        const tk = v.beliefs.table;
        const rebelsLeft = tk ? tk.rebelsAlive : 1;
        if (rebelsLeft < 1.2 && lord) {
          // the endgame is coming and we are the obvious suspect: heal up out of reach first
          if (!this.traitorReady(v)) return this.hide(v);
          // then pick off the loyal side (the most isolated first), the lord last
          const prey = this.traitorPrey(v, lord);
          if (prey) return { mode: 'hunt', goal: { ...prey.pos }, arrive: 8, sprint: false };
        }
        if (lord && now >= this.prof.lootPhase) {
          // shadow the lord at a distance: close enough to intervene, far enough to stay out of it
          const d = Math.hypot(lord.pos.x - self.pos.x, lord.pos.z - self.pos.z);
          if (d > 50 || d < 25) {
            const ax = self.pos.x - lord.pos.x;
            const az = self.pos.z - lord.pos.z;
            const l = Math.hypot(ax, az) || 1;
            return { mode: 'shadow', goal: clampZone({ x: lord.pos.x + (ax / l) * 36, y: self.pos.y, z: lord.pos.z + (az / l) * 36 }), arrive: 6, sprint: d > 70 };
          }
          return this.wander(v, self.pos, 8, 'shadow');
        }
        return this.wander(v, zone.targetCenter, zone.targetRadius * 0.7, 'wander');
      }
      case 'bounty': {
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        const tid = ownBountyTarget(self);
        const t = tid !== undefined ? sim.get(tid) : undefined;
        if (t?.hero && !t.hero.dead && now >= this.prof.lootPhase) {
          const d = Math.hypot(t.pos.x - self.pos.x, t.pos.z - self.pos.z);
          if (this.bountyOpportunity(v, t)) return { mode: 'hunt', goal: { ...t.pos }, arrive: 8, sprint: d > 40 };
          if (d > 55) return { mode: 'shadow', goal: clampZone({ ...t.pos }), arrive: 40, sprint: false };
        }
        return this.hide(v);
      }
      default: {
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        return this.hide(v);
      }
    }
  }

  /** Traitor endgame: the most isolated believed-loyal hero, or the lord when he is alone. */
  private traitorPrey(v: BotView, lord: Entity): Entity | undefined {
    const { sim, self, beliefs } = v;
    if (this.traitorEndgame(v)) return lord;
    let best: Entity | undefined;
    let bs = -Infinity;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || e.hero.dead || wearsCrown(sim, e)) continue;
      const ls = beliefs.lordSideness(sim, self, e);
      if (ls < 0.5) continue;
      let nearest = Infinity;
      for (const o of sim.heroes()) {
        if (o === e || o === self || !o.hero || o.hero.dead) continue;
        nearest = Math.min(nearest, Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z));
      }
      const s = Math.min(nearest, 60) - (e.hp / Math.max(1, e.maxHp)) * 20 - Math.hypot(e.pos.x - self.pos.x, e.pos.z - self.pos.z) * 0.2;
      if (s > bs) {
        bs = s;
        best = e;
      }
    }
    return best;
  }

  /** Bounty: target weak or alone, and we are healthy. */
  bountyOpportunity(v: BotView, t: Entity): boolean {
    if (v.self.hp < v.self.maxHp * 0.55) return false;
    if (t.hp < t.maxHp * 0.7 || t.hero?.downed) return true;
    for (const e of v.sim.heroes()) {
      if (e === t || e === v.self || !e.hero || e.hero.dead) continue;
      if (Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z) < 22) return false;
    }
    return true;
  }

  private rallyPoint(v: BotView, lord: Entity): Vec3 {
    const { sim, self, now } = v;
    if (this.rally && now - this.rallyAt < 6) return this.rally;
    this.rallyAt = now;
    let sx = self.pos.x;
    let sz = self.pos.z;
    let n = 1;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || e.hero.dead || wearsCrown(sim, e)) continue;
      if (v.beliefs.rebelness(sim, self, e) > 0.55) {
        sx += e.pos.x;
        sz += e.pos.z;
        n++;
      }
    }
    sx /= n;
    sz /= n;
    let dx = sx - lord.pos.x;
    let dz = sz - lord.pos.z;
    const l = Math.hypot(dx, dz);
    if (l < 1) {
      dx = Math.cos(this.escortAngle);
      dz = Math.sin(this.escortAngle);
    } else {
      dx /= l;
      dz /= l;
    }
    const r = 70;
    this.rally = clampIntoZone(sim, { x: lord.pos.x + dx * r, y: lord.pos.y, z: lord.pos.z + dz * r }, now);
    return this.rally;
  }

  /** A spot inside the next circle far from every other hero (neutrals). */
  private hide(v: BotView): Objective {
    const { sim, self, now } = v;
    if (!this.hidePoint || now - this.hideAt > 12) {
      this.hideAt = now;
      const z = ext(sim).zoneView();
      const r = Math.max(4, z.targetRadius * 0.75);
      let best: Vec3 | null = null;
      let bs = -Infinity;
      for (let i = 0; i < 10; i++) {
        const a = this.rng.next() * Math.PI * 2;
        const d = r * Math.sqrt(this.rng.next());
        const p = { x: z.targetCenter.x + Math.cos(a) * d, y: self.pos.y, z: z.targetCenter.z + Math.sin(a) * d };
        let minD = Infinity;
        for (const e of sim.heroes()) {
          if (e === self || !e.hero || e.hero.dead) continue;
          minD = Math.min(minD, Math.hypot(e.pos.x - p.x, e.pos.z - p.z));
        }
        const s = Math.min(minD, 80) - Math.hypot(p.x - self.pos.x, p.z - self.pos.z) * 0.25;
        if (s > bs) {
          bs = s;
          best = p;
        }
      }
      this.hidePoint = best;
    }
    // keep moving around the hiding spot (a still target is an easy target)
    if (this.hidePoint && Math.hypot(this.hidePoint.x - self.pos.x, this.hidePoint.z - self.pos.z) < 8) return this.wander(v, this.hidePoint, 9, 'hide');
    return { mode: 'hide', goal: this.hidePoint, arrive: 5, sprint: false };
  }

  private wander(v: BotView, center: Vec3, radius: number, mode: BotMode): Objective {
    const { sim, self, now } = v;
    if (!this.wanderGoal || now >= this.wanderUntil || Math.hypot(this.wanderGoal.x - self.pos.x, this.wanderGoal.z - self.pos.z) < 2.5) {
      const a = this.rng.next() * Math.PI * 2;
      const d = radius * Math.sqrt(this.rng.next());
      this.wanderGoal = clampIntoZone(sim, { x: center.x + Math.cos(a) * d, y: center.y, z: center.z + Math.sin(a) * d }, now);
      this.wanderUntil = now + 8 + this.rng.next() * 8;
    }
    return { mode, goal: this.wanderGoal, arrive: 2, sprint: false };
  }

  // ── claims & quick-chat ─────────────────────────────────────────────────
  noteRevived(now: number): void {
    this.lastRevivedAt = now;
  }

  /** Emit occasional claims / quick-chat into the frame. */
  comms(v: BotView, f: InputFrame): void {
    const { self, now, sim } = v;
    const h = self.hero!;
    const chat = (id: string, minGap = 14): boolean => {
      if (now - this.lastChatAt < minGap) return false;
      this.lastChatAt = now;
      f.actions.push({ a: 'quickchat', id });
      return true;
    };
    if (h.downed) {
      if (!this.downedChat) {
        this.downedChat = chat('needPeach', 3);
      }
      return;
    }
    this.downedChat = false;
    if (this.lastRevivedAt > 0 && now - this.lastRevivedAt < 3) {
      if (chat('thanks', 5)) this.lastRevivedAt = -99;
    }
    const target = v.target;
    const lord = this.crownRef(v);
    // claims (跳身份)
    if (this.claimed < 2 && now >= this.nextClaimAt) {
      this.nextClaimAt = now + 20 + this.rng.next() * 25;
      let claim: RoleId | null = null;
      switch (v.role) {
        case 'loyalist': {
          const defending = !!target && target.hero && lord && v.obs.sinceAttack(sim, target.id, lord.id) < 8;
          const near = !!lord && Math.hypot(lord.pos.x - self.pos.x, lord.pos.z - self.pos.z) < 30;
          if (defending || (near && this.rng.next() < 0.7)) claim = 'loyalist';
          break;
        }
        case 'traitor':
          if (now > 60 && this.rng.next() < 0.7) claim = 'loyalist';
          break;
        case 'rebel':
          if (this.pushing(v) && this.claimRebelAtPush) claim = 'rebel';
          else if (!this.pushing(v) && this.fakeLoyal && now > 50) claim = 'loyalist';
          break;
        case 'opportunist':
        case 'bounty':
          if (now > 90 && this.rng.next() < 0.4) claim = 'loyalist';
          break;
        default:
          break;
      }
      if (claim && claim !== h.claim) {
        f.actions.push({ a: 'claim', role: claim });
        this.claimed++;
      }
    }
    // quick-chat
    if (v.role === 'rebel' && this.pushing(v) && !this.pushAnnounced) {
      if (chat('followMe', 5)) this.pushAnnounced = true;
      return;
    }
    if (LORD_SIDE.has(v.role) && target?.hero && lord && lord !== self && v.obs.sinceAttack(sim, target.id, lord.id) < 4) {
      chat('protectLord', 25);
      return;
    }
    if (v.role === 'lord' && self.hp < self.maxHp * 0.45 && v.underFire > 0.05) {
      chat('help', 25);
      return;
    }
    if (v.mode === 'retreat' && this.rng.next() < 0.02) chat('retreat', 30);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function centroid(list: readonly Entity[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const e of list) {
    x += e.pos.x;
    y += e.pos.y;
    z += e.pos.z;
  }
  const n = Math.max(1, list.length);
  return { x: x / n, y: y / n, z: z / n };
}

/** Pull a point inside the circle that will be safe soon. */
export function clampIntoZone(sim: SimApi, p: Vec3, now: number): Vec3 {
  const z = ext(sim).zoneView();
  const soon = z.shrinkStart - now < 40;
  const c = soon ? z.targetCenter : z.center;
  const r = Math.max(2, (soon ? z.targetRadius : z.radius) * 0.85 - 2);
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  const d = Math.hypot(dx, dz);
  if (d <= r) return p;
  return { x: c.x + (dx / d) * r, y: p.y, z: c.z + (dz / d) * r };
}
