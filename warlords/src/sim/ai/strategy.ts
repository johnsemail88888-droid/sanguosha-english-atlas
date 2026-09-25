// Role strategies (身份局): who a bot considers hostile, who it protects, and
// what it wants to do when it is not busy fighting / healing / looting.
//  主公 Lord      — camps near the palace with his squad early, gears up, fights
//                    revealed / suspected rebels, never executes likely loyalists,
//                    falls back behind loyalists when hurt, keeps moving; marks
//                    and calls out (集火此人 / 救我) whoever attacks him.
//  忠臣 Loyalist  — gears up briefly, then escorts the lord; answers his calls,
//                    hunts suspected rebels seen near him, fights over airdrops
//                    with likely rebels; claims 忠 when it helps.
//  影武者 Double  — escorts the real lord as a decoy crown.
//  反贼 Rebel     — loots, keeps away from the crowns, picks off isolated
//                    suspected loyalists and fights over airdrops; some probe the
//                    lord early (hit and run). Each rebel has its own seeded push
//                    time; the first to reach it calls 跟我来 and every rebel who
//                    hears it stages around the lord and strikes together at the
//                    same moment. With two crowns the push focuses ONE agreed crown
//                    (the one seen casting a lord skill, the one pinned / being hit
//                    / lowest). A push that fails breaks off, regroups and comes
//                    back. Avoids dying first.
//  内奸 Traitor   — keeps the balance (helps the weaker side), never lets the lord
//                    die while rebels live, purges the loyal side once rebels are
//                    gone, then heals up and duels the lord. Lies with 忠 claims.
//  墙头草 Opportunist — survives: loots, hides far from fights, only shoots back.
//  赏金猎人 Bounty — gears up, then hunts its secret target while it is seen (or
//                    was seen recently) and weak or isolated; otherwise plays safe.
// Everything about other heroes' positions / HP comes from the bot's own sight
// memory (BotView.posOf / hpFrac / seesNow) and what it witnessed (BotView.obs).
import type { Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Entity, EntityId, InputFrame, RoleId } from '../../core/types';
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
/** hostility in a fight over an airdrop / good crate */
const CONTEST = 0.88;
/** rebels move to the staging ring this long before the push */
const STAGE_TIME = 22;
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
/** a probe lasts at most this long (s) */
const PROBE_TIME = 13;
/** a prober breaks off after losing this fraction of its HP */
const PROBE_HURT = 0.15;
/** how long a broken-off probe keeps away from the lord (s) */
const PROBE_COOLDOWN = 14;
/** a push that goes nowhere for this long (s) with too few rebels around the lord is a failure */
const PUSH_FAIL_AFTER = 25;
/** regrouping after a failed push (s, plus up to 20 s) */
const REGROUP_TIME = 35;
/** a 跟我来 heard this long ago (s) still counts as the push call */
const CALL_MEMORY = STAGE_TIME + 5;

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
export function facing(x: Entity, at: Vec3, deg: number): boolean {
  const dx = at.x - x.pos.x;
  const dz = at.z - x.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 3) return true;
  const fx = -Math.sin(x.yaw);
  const fz = -Math.cos(x.yaw);
  return (fx * dx + fz * dz) / d >= Math.cos((deg * Math.PI) / 180);
}

/**
 * 0..1 end-game pressure: from ~5:10 the closing circle forces decisions, so
 * bots act on weaker suspicion (engage thresholds drop, evidence caps lift).
 */
export function pressure(now: number): number {
  return clamp((now - 310) / 90, 0, 1);
}

/**
 * Belief-only hostility: capped at `cap` without evidence about the hero,
 * except when the table leaves no doubt (posterior ≥ 0.97).
 */
function sure(p: number, cap: number): number {
  return p >= 0.97 ? 1 : Math.min(p, cap);
}

const hyp = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export class RoleStrategy {
  /** rebels: when this rebel wants the coordinated push on the lord to start (seeded per match) */
  pushAt: number;
  /** loyalists / double: gear-up window before escorting */
  readonly gearUntil: number;
  /** lord: camping at the palace until */
  readonly campUntil: number;
  /** rebels: when this rebel probes the lord (hit and run); -1 = never */
  readonly probeAt: number;
  /** escort slot angle around the lord */
  private readonly escortAngle: number;
  private escortJitter = { x: 0, z: 0 };
  private escortJitterAt = 0;
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
  private spawn: Vec3 | null = null;
  private readonly fakeLoyal: boolean;
  private readonly claimRebelAtPush: boolean;
  // ── rebel push / probe state ──
  private probeState: 'waiting' | 'active' | 'done' = 'waiting';
  private probeStartHp = 0;
  private probeEndAt = -99;
  private pushSince = -1;
  private regroupUntil = -1;
  private calledAt = -99;
  private heardCallAt = -99;
  private agreedCrown: EntityId | undefined;
  private agreedAt = -99;
  private exposedAt = -99;
  private exposed = false;
  private lastFocusChatAt = -99;
  /** metrics / tests: pushes started and broken off */
  pushes = 0;
  failedPushes = 0;

  constructor(
    seat: number,
    private readonly prof: DifficultyProfile,
    private readonly rng: Rng,
  ) {
    // each rebel's own push time, seeded per match (the first to reach it calls the others)
    this.pushAt = prof.lootPhase + 95 + rng.next() * 80;
    this.gearUntil = Math.min(prof.lootPhase - 35, 80) + rng.next() * 12;
    this.campUntil = prof.lootPhase + 55;
    this.escortAngle = ((seat * 2.39996) % (Math.PI * 2)) + rng.next() * 0.4;
    this.nextClaimAt = 35 + rng.next() * 60;
    this.fakeLoyal = rng.next() < 0.5;
    this.claimRebelAtPush = rng.next() < 0.5;
    this.probeAt = rng.next() < 0.75 ? prof.lootPhase * 0.7 + rng.next() * 45 : -1;
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
    if (v.role === 'rebel') return this.focusCrown(v);
    let best = crowns[0];
    let bs = -Infinity;
    for (const c of crowns) {
      const p = v.posOf(c);
      const tell = this.prof.subtleReads ? v.beliefs.crownLordTell(c.id) : 0;
      const s = tell * 10 - (p ? hyp(p, self.pos) / 10 : 30) - c.id * 1e-4;
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    return best;
  }

  /**
   * Rebels: the ONE crown the push goes for. The real 主公 once seen casting a
   * lord skill (the 影武者 has none); otherwise the crown other rebels pinned
   * (marked) or are already hitting, then the weaker one — sticky, so a push
   * does not split between two crowns.
   */
  focusCrown(v: BotView): Entity | undefined {
    const { sim, self, now } = v;
    const crowns = aliveCrowns(sim, self);
    if (crowns.length <= 1) return crowns[0];
    if (this.agreedCrown !== undefined && now - this.agreedAt < 1) {
      const c = sim.get(this.agreedCrown);
      if (c && crowns.includes(c)) return c;
    }
    let best: Entity | undefined;
    let bs = -Infinity;
    for (const c of crowns) {
      let s = 0;
      if (v.beliefs.crownLordTell(c.id) > 0) s += 100;
      if (sim.hasStatus(c.id, 'marked')) s += 8;
      let hit = 0;
      for (const o of sim.heroes()) {
        if (o === c || !o.hero || o.hero.dead || wearsCrown(sim, o)) continue;
        if (o !== self && v.beliefs.rebelness(sim, self, o) < 0.45) continue;
        hit += v.obs.recentDamage(sim, o.id, c.id);
      }
      s += Math.min(hit / 20, 6);
      s += (1 - v.hpFrac(c)) * 6;
      const p = v.posOf(c);
      s -= p ? hyp(p, self.pos) / 40 : 3;
      if (c.id === this.agreedCrown) s += 4;
      s -= c.id * 1e-4;
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    this.agreedCrown = best?.id;
    this.agreedAt = now;
    return best;
  }

  /** Per-tick bookkeeping (rebel push calls, probes, failed pushes). */
  update(v: BotView): void {
    if (v.role !== 'rebel') return;
    const { sim, self, now } = v;
    // 跟我来 from a hero we do not believe loyal, after the loot phase: the push is on
    const call = v.obs.heard(sim, 'followMe', CALL_MEMORY);
    if (call && call.who !== self.id && call.time > this.heardCallAt && now >= this.prof.lootPhase * 0.7 && now >= this.regroupUntil) {
      const who = sim.get(call.who);
      if (who?.hero && !who.hero.dead && !wearsCrown(sim, who) && v.beliefs.lordSideness(sim, self, who) < 0.6) {
        this.heardCallAt = call.time;
        this.pushAt = Math.min(this.pushAt, call.time + STAGE_TIME);
      }
    }
    const lord = this.crownRef(v);
    // probe: a short hit-and-run on the lord well before the push
    if (this.probeState === 'waiting' && this.probeAt >= 0 && now >= this.probeAt) {
      const lp = lord ? v.posOf(lord, 10) : undefined;
      const healthy = self.hp >= self.maxHp * 0.7;
      // hit and run needs reach: close-range weapons don't probe
      const w = v.weapon;
      const ranged = !!w && !w.melee && w.class !== 'shotgun' && w.class !== 'flamer';
      if (now >= this.pushAt - STAGE_TIME - 5 || !lp || hyp(lp, self.pos) > 150 || !ranged) this.probeState = 'done';
      else if (healthy) {
        this.probeState = 'active';
        this.probeStartHp = self.hp;
        this.probeEndAt = now + PROBE_TIME;
      }
    }
    if (this.probeState === 'active' && (now >= this.probeEndAt || self.hp < this.probeStartHp - self.maxHp * PROBE_HURT || now >= this.pushAt - STAGE_TIME)) {
      this.probeState = 'done';
      this.probeEndAt = now;
    }
    // the push
    const pushing = this.pushing(v);
    if (pushing && this.pushSince < 0) {
      this.pushSince = now;
      this.pushes++;
    } else if (!pushing && this.pushSince >= 0 && now >= this.regroupUntil) {
      this.pushSince = -1;
    }
    if (pushing && this.pushSince >= 0 && lord) this.checkFailedPush(v, lord);
  }

  /** A push that goes nowhere (hurt without 桃, or alone at a healthy lord) breaks off and regroups. */
  private checkFailedPush(v: BotView, lord: Entity): void {
    const { sim, self, now } = v;
    const hp = self.hp / Math.max(1, self.maxHp);
    const hasTao = self.hero!.items.some((s) => s?.id === 'tao');
    const lordHp = v.hpFrac(lord);
    const lp = v.posOf(lord, 8);
    let friends = 0;
    if (lp) {
      if (hyp(lp, self.pos) < 40) friends++;
      for (const o of sim.heroes()) {
        if (o === self || o === lord || !o.hero || o.hero.dead || o.hero.downed || wearsCrown(sim, o)) continue;
        const op = v.posOf(o, 3);
        if (op && hyp(op, lp) < 40 && v.beliefs.rebelness(sim, self, o) >= 0.45) friends++;
      }
    }
    // lord-side heroes seen around the lord (the escort we are up against)
    let guards = 0;
    if (lp) {
      for (const o of sim.heroes()) {
        if (o === self || o === lord || !o.hero || o.hero.dead || o.hero.downed) continue;
        const op = v.posOf(o, 3);
        if (op && hyp(op, lp) < 30 && (wearsCrown(sim, o) || v.beliefs.lordSideness(sim, self, o) >= 0.5)) guards++;
      }
    }
    const beaten = hp < (hasTao ? 0.3 : 0.42) && lordHp > 0.45;
    const outnumbered = now - this.pushSince > 10 && lordHp > 0.6 && guards + 1 > friends + 1 && hp < 0.7;
    const stalled = now - this.pushSince > PUSH_FAIL_AFTER && lordHp > 0.7 && friends < 2;
    // the endgame circle leaves no time to regroup
    if ((beaten || stalled || outnumbered) && pressure(now) < 0.7) {
      this.failedPushes++;
      this.regroupUntil = now + REGROUP_TIME + this.rng.next() * 20;
      // come back with a fresh staging window (and a fresh 跟我来)
      this.pushAt = this.regroupUntil + STAGE_TIME;
      this.pushSince = -1;
      this.calledAt = -99;
      this.rally = null;
    }
  }

  /** Has the rebels' coordinated push started (own clock / the call, or the lord is weak)? */
  pushing(v: BotView): boolean {
    if (v.role !== 'rebel') return false;
    if (v.now < this.regroupUntil) return false;
    if (v.now >= this.pushAt) return true;
    const lord = this.crownRef(v);
    if (!lord || v.now < this.prof.lootPhase * 0.5) return false;
    // the lord is visibly weak: everybody in
    if (v.sight.seenWithin(lord.id, 10) && v.hpFrac(lord) < 0.6) return true;
    // the lord is caught without his escort and two of us are right here: strike now
    if (v.now >= this.prof.lootPhase && this.lordExposed(v, lord)) return true;
    // staging and the fight has started anyway (the lord is hit, or his side is shooting at
    // someone): no point waiting for the clock
    return v.now >= this.pushAt - STAGE_TIME && (this.lordUnderAttack(v, lord) || this.lordSideFiring(v, lord));
  }

  /**
   * The lord is in sight within 60 m, no hero this rebel believes loyal (or the
   * other crown) is known to be within 25 m of him, and another believed rebel
   * is close by — an opening worth taking before the planned push.
   */
  private lordExposed(v: BotView, lord: Entity): boolean {
    const { sim, self, now } = v;
    if (now - this.exposedAt < 0.5) return this.exposed;
    this.exposedAt = now;
    this.exposed = false;
    if (!v.seesNow(lord) || hyp(lord.pos, self.pos) > 60 || self.hp < self.maxHp * 0.6) return false;
    let mates = 0;
    for (const o of sim.heroes()) {
      if (o === self || o === lord || !o.hero || o.hero.dead || o.hero.downed) continue;
      const p = v.posOf(o, 4);
      if (!p) continue;
      if (wearsCrown(sim, o) || v.beliefs.lordSideness(sim, self, o) >= 0.5) {
        if (hyp(p, lord.pos) < 25) return false;
      } else if (v.beliefs.rebelness(sim, self, o) >= 0.5 && hyp(p, self.pos) < 40) mates++;
    }
    this.exposed = mates >= 1;
    return this.exposed;
  }

  /** Is this rebel on its hit-and-run probe right now? */
  probing(v: BotView): boolean {
    return v.role === 'rebel' && this.probeState === 'active' && !this.pushing(v);
  }

  /** The crown (or its squad, credited to him) is seen shooting at a non-crown hero right now. */
  private lordSideFiring(v: BotView, lord: Entity): boolean {
    for (const o of v.sim.heroes()) {
      if (o === lord || !o.hero || o.hero.dead || wearsCrown(v.sim, o)) continue;
      if (v.obs.recentDamage(v.sim, lord.id, o.id) >= 10) return true;
    }
    return false;
  }

  /** Staging: rebels close in on a ring around the lord shortly before the push, to arrive together. */
  staging(v: BotView): boolean {
    return v.role === 'rebel' && v.now >= this.pushAt - STAGE_TIME && v.now < this.pushAt && v.now >= this.regroupUntil;
  }

  /** Is anyone else (not a crown) seen hurting the lord right now? */
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

  /**
   * A fight over loot: this bot is going for an airdrop / good crate and `x`
   * (seen, not a crown) is right there too.
   */
  private contesting(v: BotView, x: Entity): boolean {
    const loot = v.lootTarget;
    // not in the opening minute: everybody is still spreading out and gearing up
    if (!loot || v.now < 60) return false;
    if (loot.kind !== 'airdrop' && !(loot.kind === 'crate' && (loot.crate?.tier ?? 1) >= 2)) return false;
    if (wearsCrown(v.sim, x) || !v.seesNow(x) || v.self.hp < v.self.maxHp * 0.55) return false;
    return hyp(x.pos, loot.pos) < 20 && hyp(v.self.pos, loot.pos) < 35;
  }

  /** `x` (seen) is on its own: no other known hero within 25 m, far from the crowns. */
  private isolated(v: BotView, x: Entity): boolean {
    const { sim, self } = v;
    for (const o of sim.heroes()) {
      if (o === x || o === self || !o.hero || o.hero.dead) continue;
      const p = v.posOf(o, 4);
      if (p && hyp(p, x.pos) < (wearsCrown(sim, o) ? 40 : 25)) return false;
    }
    return true;
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
    const xp = v.posOf(x);
    const xd = xp ? hyp(xp, self.pos) : Infinity;
    // real provocation (a burst of damage, not one stray pellet; much more when x is busy
    // fighting someone else near us — collateral)
    // x fighting someone else, or visibly pointing elsewhere when it hit us
    const busy = fightingOther(v, x, self) || (v.seesNow(x) && !facing(x, self.pos, 25));
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
    const healthy = self.hp >= self.maxHp * 0.6;
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
            const cp = v.posOf(c, 2);
            crownFaced = !!cp && v.seesNow(x) && facing(x, cp, 25);
          }
        }
        if (crownDmg >= (busy || !crownFaced ? DEFEND_DMG * 4 : DEFEND_DMG)) hst = Math.max(hst, ls > 0.75 ? 0.35 : DEFEND);
        if (provoked) hst = Math.max(hst, ls > 0.75 ? 0.3 : RETALIATE);
        // an airdrop is no place for a likely rebel
        if (ls < 0.6 && rb + tr >= 0.45 && this.contesting(v, x)) hst = Math.max(hst, CONTEST);
        break;
      }
      case 'rebel': {
        if (crownX) {
          if (this.pushing(v)) {
            // the push goes for ONE crown; the other is fought only when nothing better is around
            hst = x === this.focusCrown(v) ? 1 : 0.85;
          } else if (provoked) {
            hst = 1;
          } else if (this.probing(v) && x === this.crownRef(v)) {
            hst = 1;
          } else {
            // before the push, rebels leave the crowns alone unless one is visibly on its knees
            hst = xd < 25 && v.hpFrac(x) < 0.35 ? 0.9 : 0.3;
          }
        } else {
          hst = Math.min(ls + tr * 0.25 + neu * 0.05, sure(ls, cap));
          if (provoked) hst = Math.max(hst, rb > 0.7 ? 0.3 : RETALIATE);
          if (rb < 0.6) {
            // pick off a suspected loyalist caught alone, and fight strangers over airdrops
            if (ls >= 0.5 && healthy && v.seesNow(x) && xd < 45 && v.hpFrac(x) <= self.hp / self.maxHp && this.isolated(v, x)) hst = Math.max(hst, 0.92);
            if (ls + tr * 0.5 >= 0.3 && this.contesting(v, x)) hst = Math.max(hst, CONTEST);
          }
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
            hst = ready || v.hpFrac(x) < 0.3 ? 1 : 0.5;
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
          const hitLoyal = bal < 0.85 ? (busyWithRebels || v.hpFrac(x) < 0.5 ? 1 : 0.6) : bal < 1.1 ? 0.3 : 0;
          const hitRebels = bal > 1.2 ? 1 : bal > 0.85 ? 0.5 : 0.3;
          hst = Math.min(cap, Math.max(ls * hitLoyal, rb * hitRebels));
          // the lord is going down: save him from whoever is hitting him (rebels would win)
          for (const c of aliveCrowns(sim, self)) {
            if (v.hpFrac(c) < 0.35 && obs.recentDamage(sim, x.id, c.id) >= 10) hst = Math.max(hst, DEFEND);
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
   * Neutral third-party: a hero that is down (or nearly) close by and in sight,
   * with nobody else this bot knows of around who could punish the kill.
   */
  safeKill(v: BotView, x: Entity): boolean {
    const { sim, self } = v;
    if (wearsCrown(sim, x) || !v.seesNow(x)) return false;
    if (!x.hero?.downed && v.hpFrac(x) > 0.15) return false;
    if (hyp(x.pos, self.pos) > 22 || self.hp < self.maxHp * 0.5) return false;
    for (const o of sim.heroes()) {
      if (o === x || o === self || !o.hero || o.hero.dead || o.hero.downed) continue;
      const p = v.posOf(o, 6);
      if (p && hyp(p, x.pos) < 25) return false;
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

  /** Rebel strength / lord-side strength (from this bot's beliefs and last-seen HP). */
  balance(v: BotView): number {
    const { sim, self, beliefs } = v;
    let lord = 0;
    let rebel = 0;
    for (const e of sim.heroes()) {
      if (!e.hero || e.hero.dead || e === self) continue;
      const f = e.hero.downed ? 0.15 : v.hpFrac(e);
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
        return t < this.prof.lootPhase ? 55 : this.pushing(v) || this.staging(v) || this.probing(v) ? 10 : 30;
      case 'traitor':
        return this.traitorEndgame(v) ? 45 : 40;
      default:
        return 45;
    }
  }

  /** How far this bot travels for an announced airdrop. */
  airdropRadius(v: BotView, lootRadius: number): number {
    if (v.role === 'loyalist' || v.role === 'lord' || v.role === 'double') return Math.min(lootRadius + 15, 40);
    if (v.role === 'rebel' && (this.pushing(v) || this.staging(v))) return 0;
    return 90;
  }

  /**
   * A strategic break-off (overrides fighting): a probe that has done its job,
   * or a failed push regrouping. Returns where to go, or null.
   */
  disengage(v: BotView): Vec3 | null {
    if (v.role !== 'rebel') return null;
    const { now, self } = v;
    const lord = this.crownRef(v);
    const lp = lord ? v.posOf(lord, 15) : undefined;
    const breakingOff = (this.probeState === 'done' && now - this.probeEndAt < PROBE_COOLDOWN && this.probeEndAt > 0) || now < this.regroupUntil;
    if (!breakingOff || !lp || this.pushing(v)) return null;
    // only while still close to the lord's group; further out, the normal plan resumes
    if (hyp(lp, self.pos) > 70) return null;
    return this.rallyPoint(v, lord!, now < this.regroupUntil ? 85 : 70);
  }

  /** Where to be when nothing urgent is happening. */
  objective(v: BotView): Objective {
    const { sim, self, now } = v;
    if (!this.spawn) this.spawn = { ...self.pos };
    const lord = this.crownRef(v);
    const lp = lord ? v.posOf(lord, 20) : undefined;
    const zg = v.zoneGoal();
    const zone = ext(sim).zoneView();
    const clampZone = (p: Vec3): Vec3 => clampIntoZone(sim, p, now);
    switch (v.role) {
      case 'lord': {
        if (now < this.campUntil && !zg) {
          const home = sim.map.lordSpawn;
          if (hyp(self.pos, home) > 14) return { mode: 'guard', goal: { ...home }, arrive: 4, sprint: false };
          return this.wander(v, home, 10, 'guard');
        }
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        // stay with the believed loyal side, moving around them (a still lord is an easy target)
        const friends: Vec3[] = [];
        for (const a of v.allies()) if (!wearsCrown(sim, a) || roleKnownTo(sim, self, a) === 'double') friends.push(v.posOf(a)!);
        if (friends.length > 0) {
          const c = centroidOf(friends);
          if (hyp(c, self.pos) > 14) return { mode: 'guard', goal: clampZone(c), arrive: 6, sprint: false };
          return this.wander(v, c, 7, 'guard', 5);
        }
        return this.wander(v, zone.targetCenter, Math.max(6, zone.targetRadius * 0.35), 'guard');
      }
      case 'loyalist':
      case 'double': {
        if (zg && (!lord || now < this.gearUntil)) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        // the lord called for help: run to him
        const call = lord ? (v.obs.heard(sim, 'help', 10, lord.id) ?? v.obs.heard(sim, 'protectLord', 8, lord.id)) : undefined;
        if (lord && lp && (now >= this.gearUntil || call)) {
          const d = hyp(lp, self.pos);
          // hunt a suspected rebel seen near the lord (never while the lord is being hit)
          if (v.role === 'loyalist' && !call && now >= this.prof.lootPhase) {
            const s = this.suspectNear(v, lp);
            if (s) return { mode: 'hunt', goal: s, arrive: 8, sprint: hyp(s, self.pos) > 30 };
          }
          if (now >= this.escortJitterAt) {
            this.escortJitterAt = now + 3 + this.rng.next() * 3;
            const a = this.rng.next() * Math.PI * 2;
            const r = 1 + this.rng.next() * 3;
            this.escortJitter = { x: Math.cos(a) * r, z: Math.sin(a) * r };
          }
          const r = call ? 5 : v.role === 'double' ? 14 : 8;
          const g = { x: lp.x + Math.cos(this.escortAngle) * r + this.escortJitter.x, y: lp.y, z: lp.z + Math.sin(this.escortAngle) * r + this.escortJitter.z };
          return { mode: 'escort', goal: g, arrive: 2, sprint: d > 25 || !!call };
        }
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        return this.wander(v, this.spawn, 30, 'wander');
      }
      case 'rebel': {
        const pushing = this.pushing(v);
        if (zg && !pushing) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        if (lord && lp) {
          const d = hyp(lp, self.pos);
          if (pushing || this.probing(v)) return { mode: 'hunt', goal: { ...lp }, arrive: pushing ? 6 : this.probeRange(v), sprint: d > 35 };
          if (this.staging(v)) {
            // staging ring: close enough to arrive together, beyond the lord's soldiers' reach
            const ax = self.pos.x - lp.x;
            const az = self.pos.z - lp.z;
            const l = Math.hypot(ax, az) || 1;
            const g = clampZone({ x: lp.x + (ax / l) * STAGE_RADIUS, y: lp.y, z: lp.z + (az / l) * STAGE_RADIUS });
            return { mode: 'regroup', goal: g, arrive: 5, sprint: d > STAGE_RADIUS + 25 };
          }
          if (now >= this.prof.lootPhase) {
            const rally = this.rallyPoint(v, lord, now < this.regroupUntil ? 85 : 70);
            const far = hyp(rally, self.pos);
            // at the rally point: patrol around it while waiting for the push
            if (far < 12) return this.wander(v, rally, 14, 'regroup');
            return { mode: 'regroup', goal: rally, arrive: 6, sprint: far > 30 };
          }
          if (d < 62) {
            // too close to the crown before the push: back off
            const ax = self.pos.x - lp.x;
            const az = self.pos.z - lp.z;
            const l = Math.hypot(ax, az) || 1;
            return { mode: 'wander', goal: clampZone({ x: lp.x + (ax / l) * 75, y: self.pos.y, z: lp.z + (az / l) * 75 }), arrive: 5, sprint: false };
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
          if (prey) return { mode: 'hunt', goal: { ...prey }, arrive: 8, sprint: false };
        }
        if (lord && lp && now >= this.prof.lootPhase) {
          // shadow the lord at a distance: close enough to intervene, far enough to stay out of it
          const d = hyp(lp, self.pos);
          if (d > 50 || d < 25) {
            const ax = self.pos.x - lp.x;
            const az = self.pos.z - lp.z;
            const l = Math.hypot(ax, az) || 1;
            return { mode: 'shadow', goal: clampZone({ x: lp.x + (ax / l) * 36, y: self.pos.y, z: lp.z + (az / l) * 36 }), arrive: 6, sprint: d > 70 };
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
          // only what we know: chase while it is (recently) seen, drift toward its last spot otherwise
          const tp = v.posOf(t, 8);
          if (tp) {
            const d = hyp(tp, self.pos);
            if (this.bountyOpportunity(v, t, tp)) return { mode: 'hunt', goal: { ...tp }, arrive: 8, sprint: d > 40 };
            if (d > 55) return { mode: 'shadow', goal: clampZone({ ...tp }), arrive: 40, sprint: false };
          } else {
            const old = v.posOf(t, 45);
            if (old && hyp(old, self.pos) > 45) return { mode: 'shadow', goal: clampZone({ ...old }), arrive: 30, sprint: false };
          }
        }
        return this.hide(v);
      }
      default: {
        if (zg) return { mode: 'zone', goal: zg, arrive: 3, sprint: true };
        return this.hide(v);
      }
    }
  }

  /** How far from the lord a prober stays (its weapon's comfortable range). */
  private probeRange(v: BotView): number {
    const w = v.weapon;
    if (!w || w.melee) return 38;
    return clamp(w.maxRange * 0.6, 38, 60);
  }

  /**
   * Loyalist: the last known spot of a hero it would open fire on (suspected
   * rebel), seen recently within 55 m of the lord — when healthy.
   */
  private suspectNear(v: BotView, lp: Vec3): Vec3 | undefined {
    const { sim, self } = v;
    if (self.hp < self.maxHp * 0.6) return undefined;
    let best: Vec3 | undefined;
    let bs = -Infinity;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || e.hero.dead || e.hero.downed || wearsCrown(sim, e)) continue;
      const p = v.posOf(e, 12);
      if (!p || hyp(p, lp) > 55) continue;
      const hst = v.hostility(e);
      if (hst < 0.8 || v.beliefs.rebelness(sim, self, e) < 0.6) continue;
      const s = hst * 10 - hyp(p, self.pos) / 10 - v.hpFrac(e) * 3;
      if (s > bs) {
        bs = s;
        best = p;
      }
    }
    return best;
  }

  /** Traitor endgame: the most isolated believed-loyal hero it knows of, or the lord when he is alone. */
  private traitorPrey(v: BotView, lord: Entity): Vec3 | undefined {
    const { sim, self, beliefs } = v;
    if (this.traitorEndgame(v)) return v.posOf(lord, 30);
    let best: Vec3 | undefined;
    let bs = -Infinity;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || e.hero.dead || wearsCrown(sim, e)) continue;
      const ls = beliefs.lordSideness(sim, self, e);
      if (ls < 0.5) continue;
      const ep = v.posOf(e, 15);
      if (!ep) continue;
      let nearest = Infinity;
      for (const o of sim.heroes()) {
        if (o === e || o === self || !o.hero || o.hero.dead) continue;
        const op = v.posOf(o, 15);
        if (op) nearest = Math.min(nearest, hyp(op, ep));
      }
      const s = Math.min(nearest, 60) - v.hpFrac(e) * 20 - hyp(ep, self.pos) * 0.2;
      if (s > bs) {
        bs = s;
        best = ep;
      }
    }
    return best;
  }

  /** Bounty: target (at `tp`) weak or alone as far as we know, and we are healthy. */
  bountyOpportunity(v: BotView, t: Entity, tp: Vec3): boolean {
    if (v.self.hp < v.self.maxHp * 0.55) return false;
    if (v.hpFrac(t) < 0.7 || t.hero?.downed) return true;
    for (const e of v.sim.heroes()) {
      if (e === t || e === v.self || !e.hero || e.hero.dead) continue;
      const p = v.posOf(e, 8);
      if (p && hyp(p, tp) < 22) return false;
    }
    return true;
  }

  private rallyPoint(v: BotView, lord: Entity, r: number): Vec3 {
    const { sim, self, now } = v;
    if (this.rally && now - this.rallyAt < 6) return this.rally;
    this.rallyAt = now;
    const lp = v.posOf(lord) ?? self.pos;
    let sx = self.pos.x;
    let sz = self.pos.z;
    let n = 1;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || e.hero.dead || wearsCrown(sim, e)) continue;
      const p = v.posOf(e, 20);
      if (p && v.beliefs.rebelness(sim, self, e) > 0.55) {
        sx += p.x;
        sz += p.z;
        n++;
      }
    }
    sx /= n;
    sz /= n;
    let dx = sx - lp.x;
    let dz = sz - lp.z;
    const l = Math.hypot(dx, dz);
    if (l < 1) {
      dx = Math.cos(this.escortAngle);
      dz = Math.sin(this.escortAngle);
    } else {
      dx /= l;
      dz /= l;
    }
    this.rally = clampIntoZone(sim, { x: lp.x + dx * r, y: lp.y, z: lp.z + dz * r }, now);
    return this.rally;
  }

  /** A spot inside the next circle far from every hero this bot knows of (neutrals). */
  private hide(v: BotView): Objective {
    const { sim, self, now } = v;
    if (!this.hidePoint || now - this.hideAt > 12) {
      this.hideAt = now;
      const z = ext(sim).zoneView();
      const r = Math.max(4, z.targetRadius * 0.75);
      const known: Vec3[] = [];
      for (const e of sim.heroes()) {
        if (e === self || !e.hero || e.hero.dead) continue;
        const p = v.posOf(e, 30);
        if (p) known.push(p);
      }
      let best: Vec3 | null = null;
      let bs = -Infinity;
      for (let i = 0; i < 10; i++) {
        const a = this.rng.next() * Math.PI * 2;
        const d = r * Math.sqrt(this.rng.next());
        const p = { x: z.targetCenter.x + Math.cos(a) * d, y: self.pos.y, z: z.targetCenter.z + Math.sin(a) * d };
        let minD = Infinity;
        for (const k of known) minD = Math.min(minD, hyp(k, p));
        const s = Math.min(minD, 80) - hyp(p, self.pos) * 0.25;
        if (s > bs) {
          bs = s;
          best = p;
        }
      }
      this.hidePoint = best;
    }
    // keep moving around the hiding spot (a still target is an easy target)
    if (this.hidePoint && hyp(this.hidePoint, self.pos) < 8) return this.wander(v, this.hidePoint, 9, 'hide');
    return { mode: 'hide', goal: this.hidePoint, arrive: 5, sprint: false };
  }

  private wander(v: BotView, center: Vec3, radius: number, mode: BotMode, maxHold = 16): Objective {
    const { sim, self, now } = v;
    if (!this.wanderGoal || now >= this.wanderUntil || hyp(this.wanderGoal, self.pos) < 2.5 || hyp(this.wanderGoal, center) > radius + 3) {
      const a = this.rng.next() * Math.PI * 2;
      const d = Math.max(2.5, radius * Math.sqrt(this.rng.next()));
      this.wanderGoal = clampIntoZone(sim, { x: center.x + Math.cos(a) * d, y: center.y, z: center.z + Math.sin(a) * d }, now);
      this.wanderUntil = now + Math.min(maxHold, 8 + this.rng.next() * 8);
    }
    return { mode, goal: this.wanderGoal, arrive: 1.5, sprint: false };
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
    const lp = lord ? v.posOf(lord, 3) : undefined;
    // claims (跳身份)
    if (this.claimed < 2 && now >= this.nextClaimAt) {
      this.nextClaimAt = now + 20 + this.rng.next() * 25;
      let claim: RoleId | null = null;
      switch (v.role) {
        case 'loyalist': {
          const defending = !!target && target.hero && lord && v.obs.sinceAttack(sim, target.id, lord.id) < 8;
          const near = !!lp && hyp(lp, self.pos) < 30;
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
    if (v.role === 'rebel') {
      // the first rebel to reach its push time calls the others (跟我来) as staging begins
      const stagingNow = this.staging(v) || this.pushing(v);
      const someoneCalled = now - this.heardCallAt < CALL_MEMORY;
      if (stagingNow && this.calledAt < 0 && !someoneCalled) {
        if (chat('followMe', 3)) this.calledAt = now;
        return;
      }
      if (!stagingNow && now >= this.regroupUntil) this.calledAt = -99;
    }
    if (LORD_SIDE.has(v.role) && target?.hero && lord && lord !== self && v.obs.sinceAttack(sim, target.id, lord.id) < 4) {
      chat('protectLord', 25);
      return;
    }
    if (v.role === 'lord') {
      // point at whoever is shooting the lord: 集火此人 (the crosshair is on him)
      if (target?.hero && f.aimTargetId === target.id && v.obs.sinceAttack(sim, target.id, self.id) < 4 && now - this.lastFocusChatAt > 20) {
        if (chat('focus', 6)) this.lastFocusChatAt = now;
        return;
      }
      if (self.hp < self.maxHp * 0.45 && v.underFire > 0.05) {
        chat('help', 25);
        return;
      }
    }
    if (v.mode === 'retreat' && this.rng.next() < 0.02) chat('retreat', 30);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function centroidOf(list: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of list) {
    x += p.x;
    y += p.y;
    z += p.z;
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
