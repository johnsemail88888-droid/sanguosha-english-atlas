// Role-aware 三国杀 bot hero (wave 2). One instance per bot seat; produces an
// InputFrame per tick exactly like a human client would (movement, view,
// buttons, edge actions). It only knows what a human in its seat would know:
//   knowledge.ts (own role, public roles, the role table), sight.ts (where the
//   other heroes are: eyes + minimap), witness.ts (what it saw happen, the
//   kill feed, chat) and beliefs.ts (who is probably what) — and plays its
//   role (strategy.ts):
//   perceive (cadenced threat scan, LOS cache) → decide (mode: fight / retreat /
//   revive / loot / zone / role objective) → act (navigate, strafe, dodge,
//   cover, aim with human-like error, fire discipline, reload, weapon swaps,
//   interact) → abilities / items (aimed like a human: turn, settle, press when
//   on target) / squad orders / claims & quick-chat.
import type { Vec3 } from '../../core/math';
import { Rng } from '../../core/rng';
import type { BotDifficulty, Entity, EntityId, InputFrame, RoleId } from '../../core/types';
import { BTN_ADS, BTN_FIRE, BTN_INTERACT, BTN_SPRINT, emptyInput } from '../../core/types';
import type { WeaponDef } from '../../data/types';
import type { BotBrain, SimApi } from '../api';
import { WEAPON_BY_ID } from '../../data';
import { getAbility } from '../abilities/registry';
import { cameraRig } from '../aim';
import { ext } from '../ext';
import type { SimExt } from '../ext';
import { AbilityUser, groundPointOf } from './abilityUse';
import { Aimer } from './aimer';
import type { AimOut } from './aimer';
import { Beliefs } from './beliefs';
import type { AbilityPlan, BotMode, BotView, ItemPlan, Threat } from './botTypes';
import { findCover } from './cover';
import { difficultyProfile } from './difficulty';
import type { DifficultyProfile } from './difficulty';
import { lootValue, needsInteract } from './gear';
import { ItemUser } from './itemUse';
import { ownBountyTarget, ownRole, wearsCrown } from './knowledge';
import { Navigator } from './navigator';
import { observerFor } from './observer';
import type { ObsEvent } from './observer';
import { registerMind } from './registry';
import { Sight } from './sight';
import { UNIT_KINDS, aimPointOf, dist2d, hasLineOfSight, hazardEscape, isTargetable } from './perception';
import { RoleStrategy, clampIntoZone, pressure } from './strategy';
import { Witness } from './witness';

const DECIDE_EVERY = 0.25;
const LOS_EVERY = 0.12;
const LOOT_SCAN_EVERY = 1;
const LOOT_TIMEOUT = 22;
const FF_CHECK_EVERY = 0.2;
const COMMAND_GAP = 1.5;
const SEEN_MEMORY = 6;
const INTERACT_RANGE = 2.2;
const DEG = Math.PI / 180;
/** seconds of hiding (with nothing to heal and nobody hitting us) before re-engaging */
const RETREAT_MAX = 10;
/** how far the lord strays from his anchor (loyalists / squad) in a fight */
const LORD_LEASH = 12;
/** how far an escort chases an attacker away from the crown it guards */
const ESCORT_LEASH = 45;
/** seconds at an objective before drifting around it */
const IDLE_DRIFT_AFTER = 2.5;
/** non-hero units checked for line of sight per threat scan */
const UNIT_LOS_BUDGET = 6;
/** extra angular tolerance (beyond the target's own size) before pressing a lock-on cast */
const LOCK_TOL: Record<BotDifficulty, number> = { easy: 3 * DEG, normal: 2 * DEG, hard: 1.5 * DEG };
/** how close the crosshair must be to the intended point before pressing a point cast */
const POINT_TOL: Record<BotDifficulty, number> = { easy: 4 * DEG, normal: 3 * DEG, hard: 2 * DEG };
/** give up aiming a cast after this long */
const CAST_DEADLINE: Record<BotDifficulty, number> = { easy: 2.2, normal: 1.6, hard: 1.2 };
/** a squad order / mark / lock needs the target inside this cone (or its own angular size) */
const ORDER_CONE = 4 * DEG;

interface Seen {
  pos: Vec3;
  t: number;
}

interface CastState {
  kind: 'ability' | 'item';
  plan: AbilityPlan | ItemPlan;
  /** aim key (a fresh key = a fresh flick with the full initial error) */
  key: number;
  since: number;
  deadline: number;
  losOk: boolean;
  losAt: number;
}

/** Per-match counters (tests / metrics). */
export interface BotStats {
  abilities: number;
  items: number;
  shotsFired: number;
  revivesStarted: number;
  cratesOpened: number;
  claims: number;
  quickchats: number;
  stuckEvents: number;
  /** casts that needed aiming and were pressed / abandoned because the aim never settled */
  castsAimed: number;
  castTimeouts: number;
  /** abandoned casts per ability / item id */
  timeoutsById: Record<string, number>;
}

export class HeroBot implements BotBrain, BotView {
  readonly prof: DifficultyProfile;
  readonly rng: Rng;
  private seq = 0;
  private readonly aimer: Aimer;
  private readonly nav: Navigator;
  private readonly abilities = new AbilityUser();
  private readonly items = new ItemUser();
  private strategy: RoleStrategy | null = null;
  private beliefsObj: Beliefs | null = null;
  readonly sight = new Sight();
  private readonly witness = new Witness();

  // ── BotView (valid during think) ──
  sim!: SimApi;
  x!: SimExt;
  self!: Entity;
  now = 0;
  role: RoleId = 'opportunist';
  obs: Witness = this.witness;
  target: Entity | undefined;
  targetDist = Infinity;
  targetLos = false;
  threats: Threat[] = [];
  underFire = 0;
  lastHurtAt = -99;
  weapon: WeaponDef | undefined;
  mode: BotMode = 'wander';

  // ── internal state ──
  private hpLog: { t: number; hp: number }[] = [];
  private lastHp = -1;
  private nextScan = 0;
  private nextLosAt = 0;
  private targetSince = 0;
  private readonly seen = new Map<EntityId, Seen>();
  private nextDecide = 0;
  private goal: Vec3 | null = null;
  private arrive = 1;
  private sprintOk = false;
  private lootId: EntityId | undefined;
  private lootSince = 0;
  private lootNearSince = -1;
  private nextLootScan = 0;
  private readonly lootBlacklist = new Map<EntityId, number>();
  private reviveId: EntityId | undefined;
  private strafeSign = 1;
  private strafeUntil = 0;
  private nextDodgeAt = 0;
  private burstUntil = 0;
  private pauseUntil = 0;
  private nextClick = 0;
  private coverSpot: Vec3 | null = null;
  private coverAt = -99;
  private ffBlockedUntil = 0;
  private ffCheckAt = 0;
  private lastCmdKind: string = 'follow';
  private lastCmdTarget: EntityId | undefined;
  private lastCmdAt = -99;
  private markedId: EntityId | undefined;
  private nextAbilityAt: number;
  private nextItemAt = 0;
  private interactAt = 0;
  private wasDowned = false;
  private retreatUntil = 0;
  private retreatSince = 0;
  private noRetreatUntil = 0;
  private downedAt = 0;
  private lastStuck = 0;
  private swappedForRange = false;
  private splashBlockedUntil = 0;
  private hazardAt = 0;
  private attackersTick = -1;
  private memoAt = -1;
  private readonly hstMemo = new Map<EntityId, number>();
  private readonly allyMemo = new Map<EntityId, number>();
  private readonly attackersCache = new Set<EntityId>();
  private hazardDir: { x: number; z: number } | null = null;
  private dodgeQueued = false;
  private cast: CastState | null = null;
  private idleSince = -1;
  private jitterGoal: Vec3 | null = null;
  private jitterUntil = 0;
  private castSerial = 0;
  /** the last combat aim (weapon tracking) this tick */
  private lastAim: { errAngle: number; targetAngle: number; point: Vec3 } | null = null;
  /** 集火此人 from a believed ally: the unit it pointed at */
  private focus: { id: EntityId; until: number } | null = null;
  /** 需要桃 calls: hero → time */
  private readonly peachCalls = new Map<EntityId, number>();
  readonly stats: BotStats = { abilities: 0, items: 0, shotsFired: 0, revivesStarted: 0, cratesOpened: 0, claims: 0, quickchats: 0, stuckEvents: 0, castsAimed: 0, castTimeouts: 0, timeoutsById: {} };

  constructor(
    readonly seat: number,
    readonly difficulty: BotDifficulty,
    seed: number,
  ) {
    this.prof = difficultyProfile(difficulty);
    this.rng = new Rng(seed ^ 0x2545f491);
    this.aimer = new Aimer(this.prof, this.rng);
    this.nav = new Navigator(this.rng);
    this.nextAbilityAt = 1 + this.rng.next() * 2;
  }

  /** Rebel push metrics (tests). */
  pushStats(): { pushes: number; failed: number; probes: number } {
    return { pushes: this.strategy?.pushes ?? 0, failed: this.strategy?.failedPushes ?? 0, probes: this.strategy?.probes ?? 0 };
  }

  get beliefs(): Beliefs {
    if (!this.beliefsObj) this.beliefsObj = new Beliefs(this.prof);
    return this.beliefsObj;
  }

  // ── BotBrain ────────────────────────────────────────────────────────────
  think(sim: SimApi, self: Entity, dt: number): InputFrame {
    const f = emptyInput(++this.seq);
    f.yaw = self.yaw;
    f.pitch = self.pitch;
    const h = self.hero;
    if (!h || h.dead) return f;
    this.sim = sim;
    this.x = ext(sim);
    this.self = self;
    this.now = sim.time;
    this.role = ownRole(self);
    if (!this.strategy) this.strategy = new RoleStrategy(this.seat, this.prof, this.rng);
    const world = observerFor(sim);
    world.update(sim);
    registerMind(sim, self.id, this);
    this.sight.refresh(sim, self, this.prof.visionRange, this.prof.scanEvery);
    const heard = this.witness.consume(sim, self.id, world, this.sight);
    this.beliefs.update(sim, self, heard, this.witness, this.sight);
    this.hearChats(heard);
    this.trackHp();
    const aw = this.x.activeWeapon(self.id);
    this.weapon = aw?.def;

    if (h.downed) {
      this.cast = null;
      this.downedThink(f, dt);
      this.wasDowned = true;
      this.strategy.comms(this, f);
      this.countActions(f);
      return f;
    }
    if (this.wasDowned) {
      this.wasDowned = false;
      this.strategy.noteRevived(this.now);
      this.nav.reset();
    }
    this.perceive();
    this.strategy.update(this);
    if (this.now >= this.nextDecide) {
      this.nextDecide = this.now + DECIDE_EVERY * (0.8 + this.rng.next() * 0.4);
      this.decide();
    }
    this.act(f, dt);
    // one thing at a time for the view: a revive / pickup in progress keeps the crosshair
    const busy = f.actions.some((a) => a.a === 'item' || a.a === 'interact' || a.a === 'ability') || this.mode === 'revive';
    if (!busy && !this.cast) this.maybeAbility(f);
    if (!busy && !this.cast && !f.actions.some((a) => a.a === 'ability')) this.maybeItem(f);
    this.squad(f);
    this.strategy.comms(this, f);
    this.countActions(f);
    return f;
  }

  private countActions(f: InputFrame): void {
    for (const a of f.actions) {
      if (a.a === 'claim') this.stats.claims++;
      else if (a.a === 'quickchat') this.stats.quickchats++;
    }
    this.stats.abilities = this.abilities.used;
    this.stats.items = this.items.used;
  }

  // ── BotView helpers ─────────────────────────────────────────────────────
  hostility(e: Entity): number {
    if (e.kind !== 'hero') return this.unitHostility(e);
    // memoised per tick: scans, soldiers' target filters and area checks ask about the same heroes
    this.memoTick();
    let v = this.hstMemo.get(e.id);
    if (v === undefined) {
      v = this.strategy!.heroHostility(this, e);
      // 集火此人 from a believed ally: lean in (never for the 主公 — he must not execute a loyalist)
      if (this.focus && this.focus.id === e.id && this.now < this.focus.until && this.role !== 'lord' && v > 0.3) v = Math.max(v, Math.min(0.9, v + 0.25));
      this.hstMemo.set(e.id, v);
    }
    return v;
  }

  allyScore(e: Entity): number {
    this.memoTick();
    let v = this.allyMemo.get(e.id);
    if (v === undefined) {
      v = this.strategy!.allyScore(this, e);
      this.allyMemo.set(e.id, v);
    }
    return v;
  }

  private memoTick(): void {
    const t = this.sim.tick;
    if (t !== this.memoAt) {
      this.memoAt = t;
      this.hstMemo.clear();
      this.allyMemo.clear();
    }
  }

  wouldEngage(e: Entity): boolean {
    return this.hostility(e) >= this.engageAt(e);
  }

  allies(includeDowned = false, maxAge = 2): Entity[] {
    const out: Entity[] = [];
    for (const e of this.sim.heroes()) {
      if (e === this.self || !e.hero || e.hero.dead) continue;
      if (e.hero.downed && !includeDowned) continue;
      if (this.sight.posAge(e.id) > maxAge) continue;
      if (this.allyScore(e) >= 0.55) out.push(e);
    }
    return out;
  }

  posOf(e: Entity, maxAge = Infinity): Vec3 | undefined {
    if (e === this.self) return e.pos;
    return this.sight.lastPos(e.id, maxAge);
  }

  hpFrac(e: Entity): number {
    if (e === this.self) return e.hp / Math.max(1, e.maxHp);
    return this.sight.hpFrac(e.id);
  }

  seesNow(e: Entity): boolean {
    return e === this.self || this.sight.seesNow(e.id);
  }

  get lootTarget(): Entity | undefined {
    return this.mode === 'loot' && this.lootId !== undefined ? this.sim.get(this.lootId) : undefined;
  }

  zoneGoal(): Vec3 | null {
    const z = this.x.zoneView();
    const p = this.self.pos;
    const now = this.now;
    const dCur = dist2d(p, z.center);
    if (z.radius > 1 && dCur > z.radius - 4) return this.inside(z.center, z.radius, 0.55);
    if (z.radius <= 1) return { x: z.center.x, y: p.y, z: z.center.z };
    if (z.targetRadius < z.radius - 0.5) {
      const dt = dist2d(p, z.targetCenter);
      // the last circle closes to a point: be near it, then keep fighting / moving around it
      if (z.targetRadius < 5) return dt > 7 ? { x: z.targetCenter.x, y: p.y, z: z.targetCenter.z } : null;
      const need = Math.max(0, dt - z.targetRadius * 0.7) / 5.2;
      const soon = z.shrinkStart - now < need + 28 || now >= z.shrinkStart;
      if (soon && dt > z.targetRadius * (z.targetRadius < 40 ? 0.7 : 0.85)) return this.inside(z.targetCenter, z.targetRadius, z.targetRadius < 40 ? 0.35 : 0.55);
    }
    return null;
  }

  private inside(c: Vec3, r: number, k: number): Vec3 {
    const p = this.self.pos;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return { x: c.x, y: p.y, z: c.z };
    const rr = Math.min(d, r * k);
    return { x: c.x + (dx / d) * rr, y: p.y, z: c.z + (dz / d) * rr };
  }

  private outsideZone(margin = 2): boolean {
    const z = this.x.zoneView();
    return dist2d(this.self.pos, z.center) > z.radius - margin;
  }

  // ── chat ────────────────────────────────────────────────────────────────
  /** React to quick-chat heard this tick (humans' and bots' alike). */
  private hearChats(heard: readonly ObsEvent[]): void {
    const { sim, self, now } = this;
    for (const ev of heard) {
      if (ev.kind !== 'quickchat' || ev.actor === undefined || ev.actor === self.id) continue;
      const who = sim.get(ev.actor);
      if (!who?.hero || who.hero.dead) continue;
      if (ev.chat === 'needPeach') {
        this.peachCalls.set(who.id, now);
      } else if (ev.chat === 'focus' && this.allyScore(who) >= 0.55 && this.seesNow(who)) {
        // 集火此人: whatever the caller is pointing at (facing is public)
        const t = this.facedUnit(who);
        if (t && t !== self && this.allyScore(t) < 0.55) this.focus = { id: t.id, until: now + 10 };
      }
    }
    if (this.focus && now >= this.focus.until) this.focus = null;
  }

  /** The unit `who` is pointing its crosshair at, among those this bot can see. */
  private facedUnit(who: Entity): Entity | undefined {
    const { sim, self } = this;
    const ray = sim.aimRay(who);
    let best: Entity | undefined;
    let ba = 10 * DEG;
    for (const e of sim.queryCone(ray.origin, ray.dir, 90, 10 * DEG, { kinds: UNIT_KINDS, exclude: [who.id] })) {
      if (!isTargetable(sim, self, e)) continue;
      if (e.kind === 'hero' ? !this.seesNow(e) : !hasLineOfSight(sim, self, e)) continue;
      const c = aimPointOf(e);
      const vx = c.x - ray.origin.x;
      const vy = c.y - ray.origin.y;
      const vz = c.z - ray.origin.z;
      const a = Math.acos(Math.max(-1, Math.min(1, (vx * ray.dir.x + vy * ray.dir.y + vz * ray.dir.z) / (Math.hypot(vx, vy, vz) || 1))));
      if (a < ba) {
        ba = a;
        best = e;
      }
    }
    return best;
  }

  // ── HP tracking ─────────────────────────────────────────────────────────
  private trackHp(): void {
    const now = this.now;
    const hp = this.self.hp + this.self.shield;
    if (this.lastHp >= 0 && hp < this.lastHp - 0.5) this.lastHurtAt = now;
    this.lastHp = hp;
    const log = this.hpLog;
    log.push({ t: now, hp });
    while (log.length > 0 && now - log[0].t > 2) log.shift();
    let max = hp;
    for (const s of log) if (s.hp > max) max = s.hp;
    this.underFire = Math.max(0, max - hp) / Math.max(1, this.self.maxHp);
  }

  // ── perception ──────────────────────────────────────────────────────────
  private unitHostility(c: Entity): number {
    const { sim, x, self } = this;
    const d = dist2d(self.pos, c.pos);
    const attackedMe = this.recentAttackerIds().has(c.id);
    if (c.kind === 'npc') {
      const npc = c.npc!;
      if (attackedMe) return 0.95;
      const tgt = npc.targetId !== undefined ? x.creditOf(npc.targetId) : undefined;
      if (tgt === self.id) return 0.9;
      if (npc.summonerId !== undefined) return sim.isHostileTo(c, self) ? (d < 25 ? 0.8 : 0.45) : 0;
      if ((npc.ai.flee ?? 0) > 0) return 0;
      return d < 18 ? 0.7 : 0.35;
    }
    const cmd = x.commanderOf(c);
    if (!cmd || cmd === self) return attackedMe ? 0.85 : 0.3;
    // soldiers of a believed ally shooting at us: a misunderstanding, not a war
    if (cmd.hero && this.allyScore(cmd) >= 0.5) return attackedMe && this.obs.recentDamage(sim, cmd.id, self.id) > 70 ? 0.6 : 0.15;
    if (attackedMe) return 0.85;
    const hc = this.hostility(cmd);
    const engaged = c.troop?.targetId ?? c.turret?.targetId;
    const engagedCredit = engaged !== undefined ? x.creditOf(engaged) : undefined;
    const engagingUs = engagedCredit !== undefined && (engagedCredit === self.id || (sim.get(engagedCredit) && this.allyScore(sim.get(engagedCredit)!) > 0.5));
    return engagingUs ? Math.max(0.75, hc * 0.9) : hc * 0.55;
  }

  /** Ids (sources and credited heroes) that hurt this bot in the last 4 s — cached per tick. */
  private recentAttackerIds(): Set<EntityId> {
    if (this.attackersTick !== this.sim.tick) {
      this.attackersTick = this.sim.tick;
      this.attackersCache.clear();
      for (const a of this.x.recentAttackers(this.self.id, 4)) this.attackersCache.add(a);
    }
    return this.attackersCache;
  }

  private engageAt(e: Entity): number {
    if (e.kind !== 'hero') return 0.5;
    if (this.role === 'lord') return Math.max(0.78, this.prof.engageThreshold);
    return Math.max(0.49, this.prof.engageThreshold - 0.36 * pressure(this.now));
  }

  private perceive(): void {
    const { sim, self, now } = this;
    const cur = this.target;
    const lost = !!cur && (!cur.alive || !!cur.hero?.dead || !isTargetable(sim, self, cur));
    const hurtBlind = !cur && now - this.lastHurtAt < 0.3;
    if (now >= this.nextScan || lost || hurtBlind) {
      this.nextScan = now + this.prof.scanEvery * (0.8 + this.rng.next() * 0.4);
      this.scan();
    }
    const t = this.target;
    if (t) {
      if (now >= this.nextLosAt) {
        this.nextLosAt = now + LOS_EVERY;
        this.targetLos = hasLineOfSight(sim, self, t);
      }
      if (this.targetLos) {
        this.seen.set(t.id, { pos: { ...t.pos }, t: now });
        if (t.kind === 'hero') this.sight.noteEye(t, now);
        this.targetDist = dist2d(self.pos, t.pos);
      } else {
        // out of sight: only where we last saw it
        const s = this.seen.get(t.id);
        this.targetDist = s ? dist2d(self.pos, s.pos) : Infinity;
      }
    } else {
      this.targetDist = Infinity;
      this.targetLos = false;
    }
  }

  private scan(): void {
    const { sim, x, self, now, prof } = this;
    const attackers = new Set<EntityId>();
    for (const a of x.recentAttackers(self.id, 3)) {
      attackers.add(a);
      const c = x.creditOf(a);
      if (c !== undefined) attackers.add(c);
    }
    const lordSide = this.role === 'lord' || this.role === 'loyalist' || this.role === 'double';
    const bounty = ownBountyTarget(self);
    const range = prof.visionRange;
    const cands = sim.queryRadius(self.pos, range, { kinds: UNIT_KINDS, exclude: [self.id] });
    const list: Threat[] = [];
    const wRange = this.weapon ? this.weapon.maxRange : 60;
    const pushing = this.role === 'rebel' && this.strategy!.pushing(this);
    const focusCrown = pushing ? this.strategy!.focusCrown(this) : undefined;
    const crownInReach = this.role === 'rebel' && this.crownsNear(50).length > 0;
    let unitLos = 0;
    // non-hero units: nearest first, so the LOS budget goes to the ones that matter
    cands.sort((a, b) => dist2d(self.pos, a.pos) - dist2d(self.pos, b.pos));
    for (const c of cands) {
      if (!c.alive || c.hero?.dead) continue;
      if (sim.isOwnSide(self, c)) continue;
      if (!isTargetable(sim, self, c)) continue;
      // only what this seat can perceive: heroes in sight (or remembered), units in LOS
      let visible: boolean;
      if (c.kind === 'hero') visible = this.sight.seesNow(c.id);
      else if (unitLos < UNIT_LOS_BUDGET) {
        unitLos++;
        visible = hasLineOfSight(sim, self, c);
      } else visible = false;
      const recentlySeen = (this.seen.get(c.id)?.t ?? -99) > now - SEEN_MEMORY || (c.kind === 'hero' && this.sight.seenWithin(c.id, SEEN_MEMORY));
      if (!visible && !recentlySeen && !attackers.has(c.id)) continue;
      const hst = this.hostility(c);
      if (hst < 0.3) continue;
      const pos = visible ? c.pos : (this.seen.get(c.id)?.pos ?? this.posOf(c) ?? c.pos);
      const d = dist2d(self.pos, pos);
      const kindW = c.kind === 'hero' ? 1 : c.kind === 'turret' ? 0.6 : c.kind === 'npc' ? 0.5 : 0.45;
      const hpFrac = c.kind === 'hero' ? this.hpFrac(c) : c.hp / Math.max(1, c.maxHp);
      let s = hst * kindW * (1 + 0.6 * (1 - hpFrac)) * (1 / (1 + d / 30));
      if (attackers.has(c.id)) s *= 1.5;
      if (c.hero?.downed) s *= hst >= 0.7 ? 1.25 : 0.2;
      if (c === this.target) s *= 1.3;
      if (bounty !== undefined && c.id === bounty) s *= 1.4;
      if (this.focus && this.focus.id === c.id) s *= 1.8;
      // the rebels' push focuses ONE crown (the agreed one) and ignores soldiers when it is in reach
      if (pushing) {
        if (c.kind === 'hero' && wearsCrown(sim, c)) s *= c === focusCrown ? 2.2 : 0.4;
        else if (c.kind !== 'hero' && crownInReach) s *= 0.35;
      }
      if (lordSide && c.kind === 'hero') {
        for (const cr of sim.heroes()) {
          if (cr !== c && cr.hero && !cr.hero.dead && wearsCrown(sim, cr) && this.obs.sinceAttack(sim, c.id, cr.id) < 6) {
            s *= 1.4;
            break;
          }
        }
      }
      if (d > wRange) s *= 0.6;
      list.push({ e: c, hostility: hst, score: s, dist: d, los: visible });
    }
    list.sort((a, b) => b.score - a.score);
    this.threats = list.length > 8 ? list.slice(0, 8) : list;
    // choose the target
    let best: Threat | undefined;
    for (const t of this.threats) {
      if (t.hostility < this.engageAt(t.e)) continue;
      const s = t.los ? t.score : t.score * 0.5;
      if (!best || s > (best.los ? best.score : best.score * 0.5)) best = t;
    }
    const prev = this.target;
    if (prev && best && best.e !== prev) {
      const keep = this.threats.find((t) => t.e === prev);
      if (keep && keep.hostility >= this.engageAt(prev) && keep.los && keep.score >= best.score * 0.75) best = keep;
    }
    const next = best?.e;
    if (next !== prev) {
      this.target = next;
      this.targetSince = now;
      this.nextLosAt = 0;
      this.targetLos = best?.los ?? false;
      if (next && best!.los) this.seen.set(next.id, { pos: { ...next.pos }, t: now });
    }
  }

  // ── decisions ───────────────────────────────────────────────────────────
  private decide(): void {
    const { self, now } = this;
    const h = self.hero!;
    const hpFrac = self.hp / Math.max(1, self.maxHp);
    const strat = this.strategy!;
    const t = this.target;
    const pushing = strat.pushing(this);
    let retreatHp = this.prof.retreatHp;
    if (this.role === 'rebel' && !pushing) retreatHp += 0.1;
    // a push commits only for the kill (the lord low): otherwise a hurt rebel backs off and heals
    // rather than feeding the lord a rebel-kill reward
    if (this.role === 'rebel' && pushing && t && wearsCrown(this.sim, t) && this.hpFrac(t) < 0.35) retreatHp -= 0.12;
    if (this.role === 'lord' || this.role === 'traitor' || this.role === 'opportunist') retreatHp += 0.08;
    if (this.role === 'lord' && this.threats.filter((x) => x.e.kind === 'hero' && x.hostility >= 0.8 && x.dist < 40).length >= 2) retreatHp += 0.06;
    const closeThreat = this.threats.find((x) => x.hostility >= 0.5 && x.dist < 32 && (x.los || x.e.kind === 'hero'));
    // zone emergencies first
    const zg = this.zoneGoal();
    const out = this.outsideZone(1);
    // a close duel may finish at the edge of a weak circle — never for the lord
    const fightingClose = this.role !== 'lord' && !!t && this.targetLos && this.targetDist < 15 && hpFrac > 0.6 && this.x.zoneView().dps <= 4;
    if (zg && out && !fightingClose) return this.setMode('zone', zg, 3, true);
    // a probe that has done its job / a push that failed: break off to the rally point at a run
    // (no shooting over the shoulder unless someone is right on us)
    const fallback = strat.disengage(this);
    if (fallback && !(closeThreat && closeThreat.dist < 12)) return this.setMode('regroup', fallback, 4, true);
    if (fallback) return this.setMode('retreat', fallback, 4, true);
    // disengage when hurt — but hiding forever at low HP with nothing to heal is a stalemate:
    // after a while without being hit, get back into it
    const canRetreat = now >= this.noRetreatUntil;
    if (canRetreat && ((hpFrac < retreatHp && closeThreat) || now < this.retreatUntil)) {
      if (this.mode !== 'retreat') this.retreatSince = now;
      if (hpFrac < retreatHp && closeThreat) this.retreatUntil = now + 3;
      if (hpFrac >= retreatHp + 0.18 || !closeThreat) this.retreatUntil = 0;
      const healing = h.channel !== null || this.hasTao();
      if (!healing && now - this.retreatSince > RETREAT_MAX && now - this.lastHurtAt > 3) {
        this.noRetreatUntil = now + 15;
        this.retreatUntil = 0;
      } else {
        const g = this.retreatGoal(closeThreat?.e ?? t);
        if (g) return this.setMode('retreat', g, 1.2, false);
      }
    }
    // revive a believed ally
    const rv = this.reviveCandidate();
    if (rv) {
      this.reviveId = rv.e.id;
      return this.setMode('revive', rv.p, 1.3, dist2d(self.pos, rv.p) > 8);
    }
    this.reviveId = undefined;
    // fight
    if (t) {
      this.mode = 'fight';
      this.goal = null;
      return;
    }
    // loot
    const loot = this.lootChoice();
    if (loot) {
      const needF = needsInteract(loot);
      return this.setMode('loot', loot.pos, needF ? 1.4 : 0.35, dist2d(self.pos, loot.pos) > 12);
    }
    // role objective
    const obj = strat.objective(this);
    if (obj.goal) {
      // arrived and nothing happening: never freeze on the spot (a still hero is an easy target)
      const g = this.antiIdle(obj.goal, obj.arrive);
      if (g) return this.setMode(obj.mode, g, 1, false);
      return this.setMode(obj.mode, obj.goal, obj.arrive, obj.sprint);
    }
    this.idleSince = -1;
    this.mode = obj.mode;
    this.goal = null;
  }

  /** After a few seconds at an objective, drift around it (returns the drift goal) instead of standing still. */
  private antiIdle(goal: Vec3, arrive: number): Vec3 | null {
    const { self, now } = this;
    if (dist2d(self.pos, goal) > arrive + 0.8 && !(this.jitterGoal && dist2d(this.jitterGoal, goal) < 8)) {
      this.idleSince = -1;
      this.jitterGoal = null;
      return null;
    }
    if (this.idleSince < 0) this.idleSince = now;
    if (now - this.idleSince < IDLE_DRIFT_AFTER) return null;
    if (!this.jitterGoal || now >= this.jitterUntil || dist2d(this.jitterGoal, self.pos) < 1.2 || dist2d(this.jitterGoal, goal) > 8) {
      const a = this.rng.next() * Math.PI * 2;
      const r = 3 + this.rng.next() * 3.5;
      this.jitterGoal = clampIntoZone(this.sim, { x: goal.x + Math.cos(a) * r, y: goal.y, z: goal.z + Math.sin(a) * r }, now);
      this.jitterUntil = now + 3 + this.rng.next() * 2;
    }
    return this.jitterGoal;
  }

  private setMode(mode: BotMode, goal: Vec3, arrive: number, sprint: boolean): void {
    this.mode = mode;
    this.goal = goal;
    this.arrive = arrive;
    this.sprintOk = sprint;
  }

  private retreatGoal(threat: Entity | undefined): Vec3 | null {
    const { sim, self, now } = this;
    if (!threat) return null;
    const tp = threat.kind === 'hero' ? (this.posOf(threat, SEEN_MEMORY) ?? this.seen.get(threat.id)?.pos) : threat.pos;
    if (!tp) return null;
    // cover first (if this bot plays with cover)
    if (this.prof.coverUse > 0 && (this.coverSpot === null || now - this.coverAt > 1.5)) {
      this.coverAt = now;
      this.coverSpot = this.rng.next() < this.prof.coverUse ? findCover(sim, self, { threats: [{ x: tp.x, y: tp.y + 1.6, z: tp.z }], maxDist: 16, budget: 8, maxAdvance: 2 }) : null;
    }
    if (this.coverSpot && dist2d(this.coverSpot, self.pos) < 20) return this.coverSpot;
    // fall back behind believed allies (lord: behind the loyalists)
    let best: Vec3 | undefined;
    let bd = 45;
    for (const a of this.allies()) {
      const ap = this.posOf(a)!;
      const d = dist2d(ap, self.pos);
      if (d < bd && dist2d(ap, tp) > 6) {
        bd = d;
        best = ap;
      }
    }
    if (best) {
      const dx = best.x - tp.x;
      const dz = best.z - tp.z;
      const l = Math.hypot(dx, dz) || 1;
      return clampIntoZone(sim, { x: best.x + (dx / l) * 5, y: best.y, z: best.z + (dz / l) * 5 }, now);
    }
    const dx = self.pos.x - tp.x;
    const dz = self.pos.z - tp.z;
    const l = Math.hypot(dx, dz) || 1;
    return clampIntoZone(sim, { x: self.pos.x + (dx / l) * 20, y: self.pos.y, z: self.pos.z + (dz / l) * 20 }, now);
  }

  private hasTao(): boolean {
    return this.self.hero!.items.some((s) => s?.id === 'tao');
  }

  /** A free revive (华佗 急救) that is ready right now — asks the ability's own hook. */
  private canReviveFree(): boolean {
    const { sim, self } = this;
    const hero = sim.heroDef(self);
    if (!hero) return false;
    for (const a of hero.abilities) {
      const impl = getAbility(a.id);
      if (a.slot !== 'passive' || !impl?.canReviveFree) continue;
      try {
        if (impl.canReviveFree({ sim, self, def: a, hero, input: sim.inputOf(self) }) === true) return true;
      } catch {
        // a throwing hook counts as "not ready"
      }
    }
    return false;
  }

  /**
   * A downed believed ally worth a 桃, at the spot this bot last saw it (downed
   * is public on the scoreboard; where they lie is not). A 需要桃 call widens
   * the search.
   */
  private reviveCandidate(): { e: Entity; p: Vec3 } | undefined {
    const { sim, self, now } = this;
    if (!this.hasTao() && !this.canReviveFree()) return undefined;
    let best: { e: Entity; p: Vec3 } | undefined;
    let bs = Infinity;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || !e.hero.downed || e.hero.dead) continue;
      const called = now - (this.peachCalls.get(e.id) ?? -99) < 12;
      const p = this.posOf(e, called ? 20 : 8);
      if (!p) continue;
      const d = dist2d(p, self.pos);
      if (d > (called ? 50 : 35) || Math.abs(p.y - self.pos.y) > 3) continue;
      if (!this.strategy!.wantsRevive(this, e)) continue;
      const left = e.hero.downedUntil - now;
      if (left < d / 5 + 1.8) continue;
      // too dangerous? count hostile heroes close to the downed ally
      let danger = 0;
      for (const t of this.threats) if (t.e.kind === 'hero' && t.hostility >= 0.5 && dist2d(t.e.pos, p) < 18) danger++;
      if (danger >= 2 || (danger >= 1 && self.hp < self.maxHp * 0.4)) continue;
      const s = d - (wearsCrown(sim, e) ? 20 : 0) - (called ? 8 : 0);
      if (s < bs) {
        bs = s;
        best = { e, p };
      }
    }
    return best;
  }

  private lootChoice(): Entity | undefined {
    const { sim, self, now } = this;
    const radius = this.strategy!.lootRadius(this);
    let cur = this.lootId !== undefined ? sim.get(this.lootId) : undefined;
    if (cur && lootValue(cur, self, this.role) <= 0) cur = undefined;
    if (cur) {
      // standing on it without getting it (locked drop, no room after all…): give up quickly
      const near = dist2d(cur.pos, self.pos) < (needsInteract(cur) ? INTERACT_RANGE : 1.6);
      if (!near) this.lootNearSince = -1;
      else if (this.lootNearSince < 0) this.lootNearSince = now;
      const stuck = this.nav.unreachable || now - this.lootSince > LOOT_TIMEOUT || (this.lootNearSince >= 0 && now - this.lootNearSince > 3.5);
      const above = dist2d(cur.pos, self.pos) < 3 && Math.abs(cur.pos.y - self.pos.y) > 1.7;
      if (stuck || (above && now - this.lootSince > 3)) {
        this.lootBlacklist.set(cur.id, now + 60);
        cur = undefined;
        this.lootNearSince = -1;
        this.nav.reset();
      }
    }
    if (cur) return cur;
    this.lootId = undefined;
    if (radius <= 0 || now < this.nextLootScan) return undefined;
    this.nextLootScan = now + LOOT_SCAN_EVERY * (0.8 + this.rng.next() * 0.4);
    let best: Entity | undefined;
    let bs = 0;
    // rebels keep away from the crowns (and their squads) until the push
    const avoid = this.role === 'rebel' && !this.strategy!.pushing(this) ? this.crownsNear(140) : [];
    const consider = (e: Entity, maxD: number): void => {
      if ((this.lootBlacklist.get(e.id) ?? 0) > now) return;
      for (const c of avoid) if (dist2d(c, e.pos) < 62) return;
      const d = dist2d(e.pos, self.pos);
      if (d > maxD || Math.abs(e.pos.y - self.pos.y) > 4) return;
      const v = lootValue(e, self, this.role);
      if (v <= 0) return;
      // hostile heroes near the loot make it less attractive
      let danger = 0;
      for (const t of this.threats) if (t.hostility >= 0.5 && dist2d(t.e.pos, e.pos) < 15) danger += t.e.kind === 'hero' ? 1 : 0.3;
      const s = v / (1 + d / 18) - danger * 6;
      if (s > bs) {
        bs = s;
        best = e;
      }
    };
    for (const e of sim.queryRadius(self.pos, radius, { kinds: ['loot', 'crate'] })) consider(e, radius);
    // airdrops are announced and marked on the map: worth a longer trip when safe
    const airR = this.strategy!.airdropRadius(this, radius);
    for (const e of sim.queryRadius(self.pos, airR, { kinds: ['airdrop'] })) consider(e, airR);
    if (best && bs > 1.2) {
      this.lootId = best.id;
      this.lootSince = now;
      this.lootNearSince = -1;
      return best;
    }
    return undefined;
  }

  // ── acting ──────────────────────────────────────────────────────────────
  private act(f: InputFrame, dt: number): void {
    const { self, now } = this;
    const h = self.hero!;
    let mv: { x: number; z: number } = { x: 0, z: 0 };
    let jump = false;
    let sprint = false;
    let aimed = false;
    const t = this.target;
    this.lastAim = null;

    switch (this.mode) {
      case 'fight': {
        if (t) {
          const r = this.fightMove();
          mv = r;
          jump = r.jump;
          sprint = r.sprint;
        }
        break;
      }
      case 'revive': {
        const e = this.reviveId !== undefined ? this.sim.get(this.reviveId) : undefined;
        if (e && e.hero?.downed && !e.hero.dead) {
          const p = this.seesNow(e) ? e.pos : (this.posOf(e) ?? this.goal ?? e.pos);
          const d = dist2d(p, self.pos);
          if (d > 1.6) {
            const n = this.nav.steer(this.sim, self, p, 1.2);
            mv = n;
            jump = n.jump;
            sprint = d > 8;
          }
          if (d < INTERACT_RANGE && this.seesNow(e)) {
            this.aimer.lookAt(self, aimPointOf(e), dt, 0.1);
            aimed = true;
            f.aimTargetId = e.id;
            f.aimPoint = aimPointOf(e);
            this.startRevive(f, e);
          }
        }
        break;
      }
      case 'loot': {
        const e = this.lootId !== undefined ? this.sim.get(this.lootId) : undefined;
        if (e && this.goal) {
          const d = dist2d(e.pos, self.pos);
          const n = this.nav.steer(this.sim, self, e.pos, this.arrive);
          mv = n;
          jump = n.jump;
          sprint = this.sprintOk && n.straight;
          if (needsInteract(e) && d < INTERACT_RANGE && Math.abs(e.pos.y - self.pos.y) < 1.6) {
            mv = { x: 0, z: 0 };
            this.aimer.lookAt(self, e.pos, dt, 0.12);
            aimed = true;
            if (!h.channel && now >= this.interactAt) {
              this.interactAt = now + 0.8;
              f.actions.push({ a: 'interact' });
              if (e.kind === 'crate' || e.kind === 'airdrop') this.stats.cratesOpened++;
            }
          }
        }
        break;
      }
      default: {
        if (this.goal) {
          const n = this.nav.steer(this.sim, self, this.goal, this.arrive);
          mv = n;
          jump = n.jump;
          sprint = this.sprintOk && n.straight && n.dist > 10;
        }
        break;
      }
    }
    // step out of harmful fields (fire, storm clouds, frost) unless busy reviving
    if (this.mode !== 'revive' && now >= this.hazardAt) {
      this.hazardAt = now + 0.3;
      this.hazardDir = hazardEscape(this.sim, self);
    }
    if (this.hazardDir && this.mode !== 'revive') {
      mv = { x: mv.x * 0.3 + this.hazardDir.x, z: mv.z * 0.3 + this.hazardDir.z };
      const l = Math.hypot(mv.x, mv.z) || 1;
      mv = { x: mv.x / l, z: mv.z / l };
    }
    if (this.nav.stuck > this.lastStuck) this.stats.stuckEvents++;
    this.lastStuck = this.nav.stuck;

    // view: a revive / pickup keeps it, then an aimed cast, then combat aiming
    if (aimed || this.mode === 'revive' || (this.mode === 'loot' && aimed)) this.cast = null;
    let shooting = false;
    let viewSet = false;
    if (!aimed && this.cast) viewSet = this.castAim(f, dt);
    if (!viewSet) shooting = this.aimAndFire(f, dt, aimed);
    else shooting = this.lastAim !== null;
    if (!shooting && !aimed && !viewSet) {
      // face where we are going (or glance at a nearby threat)
      const look = this.threats.find((x) => x.los && x.dist < 40);
      if (look && this.mode !== 'zone') this.aimer.lookAt(self, aimPointOf(look.e), dt, 0.3);
      else if (Math.hypot(mv.x, mv.z) > 0.1) this.aimer.face(self, Math.atan2(-mv.x, -mv.z), dt, 0.15);
    }
    if (!shooting && !viewSet) {
      f.yaw = this.aimer.yaw;
      f.pitch = this.aimer.pitch;
      if (!f.aimPoint) f.aimPoint = crosshairAhead(self, this.aimer.yaw, this.aimer.pitch);
    }
    if (shooting || viewSet) sprint = false;
    if (this.dodgeQueued) {
      this.dodgeQueued = false;
      f.actions.push({ a: 'dodge' });
    }
    // local movement
    const loc = toLocal(f.yaw, mv.x, mv.z);
    f.moveX = clampUnit(loc.mx);
    f.moveZ = clampUnit(loc.mz);
    if (sprint && f.moveZ > 0.6 && !h.channel) f.buttons |= BTN_SPRINT;
    if (jump) f.actions.push({ a: 'jump' });
    this.reloadLogic(f);
  }

  private startRevive(f: InputFrame, e: Entity): void {
    const h = this.self.hero!;
    if (h.channel) {
      if (h.channel.kind === 'revive') f.buttons |= BTN_INTERACT;
      return;
    }
    if (this.now < this.interactAt) return;
    this.interactAt = this.now + 0.6;
    const slot = h.items.findIndex((s) => s?.id === 'tao');
    this.stats.revivesStarted++;
    if (slot >= 0) {
      f.aimTargetId = e.id;
      f.actions.push({ a: 'item', slot });
    } else {
      f.buttons |= BTN_INTERACT;
      f.actions.push({ a: 'interact' });
    }
  }

  /** Combat movement: range keeping, strafing, dodging, cover to reload. */
  private fightMove(): { x: number; z: number; jump: boolean; sprint: boolean } {
    const { sim, self, now, prof } = this;
    const h = self.hero!;
    const t = this.target!;
    const d = this.targetDist;
    let [lo, hi] = idealRange(this.weapon);
    // a probe is hit and run: stay at long range from the crown; a push fights him from the edge
    // of the weapon's reach (his soldiers shred whoever walks into the escort)
    if (t.kind === 'hero' && wearsCrown(sim, t) && this.role === 'rebel' && this.weapon && !this.weapon.melee) {
      if (this.strategy!.probing(this)) {
        lo = Math.max(lo, 54);
        hi = Math.max(hi, 64);
      } else if (this.weapon.class !== 'shotgun' && this.weapon.class !== 'flamer' && this.hpFrac(t) > 0.3) {
        hi = Math.max(hi, Math.min(this.weapon.maxRange * 0.6, 38));
      }
    }
    // WEI-11: an enemy-targeted dash (张辽 突袭) is ready: step inside its reach (wins over the above)
    const cap = t.kind === 'hero' ? this.abilities.engageCap(this) : undefined;
    if (cap !== undefined && cap < hi) {
      hi = Math.max(3, cap);
      lo = Math.min(lo, hi * 0.5);
    }
    let mx = 0;
    let mz = 0;
    let jump = false;
    let sprint = false;
    // reload behind cover
    const reloading = h.reloadUntil > now;
    if (reloading && prof.coverUse > 0 && d < 45 && this.targetLos) {
      if (this.coverSpot === null || now - this.coverAt > 2) {
        this.coverAt = now;
        this.coverSpot = this.rng.next() < prof.coverUse ? findCover(sim, self, { threats: [sim.eyePos(t)], maxDist: 9, budget: 6, maxAdvance: 1 }) : null;
      }
      if (this.coverSpot && dist2d(this.coverSpot, self.pos) > 0.6) {
        const n = this.nav.steer(sim, self, this.coverSpot, 0.5);
        return { x: n.x, z: n.z, jump: n.jump, sprint: false };
      }
    }
    if (!this.targetLos) {
      // hunt the last place it was seen / felt from (never where it really is)
      const seen = this.seen.get(t.id);
      let goal: Vec3 | undefined = seen && now - seen.t <= SEEN_MEMORY ? seen.pos : undefined;
      if (!goal && t.kind === 'hero') goal = this.posOf(t, SEEN_MEMORY);
      if (goal && dist2d(goal, self.pos) > 2.5) {
        const n = this.nav.steer(sim, self, goal, 2);
        return { x: n.x, z: n.z, jump: n.jump, sprint: d > 25 && n.straight };
      }
      // nothing to go on (hit from an unseen spot, or the trail went cold): don't stand still
      if (now >= this.strafeUntil) {
        this.strafeSign = this.rng.next() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 0.8 + this.rng.next();
      }
      const fx = -Math.sin(self.yaw);
      const fz = -Math.cos(self.yaw);
      return { x: -fz * this.strafeSign * 0.8, z: fx * this.strafeSign * 0.8, jump: false, sprint: false };
    }
    const dx = (t.pos.x - self.pos.x) / Math.max(1e-3, d);
    const dz = (t.pos.z - self.pos.z) / Math.max(1e-3, d);
    const anchor = this.role === 'lord' ? this.lordAnchor() : null;
    const escortOf = this.role === 'loyalist' || this.role === 'double' ? this.escortAnchor() : null;
    if (escortOf && dist2d(self.pos, escortOf) > ESCORT_LEASH && dist2d(t.pos, escortOf) > ESCORT_LEASH) {
      // an escort does not chase a fleeing attacker across the map: back to the lord
      const n = this.nav.steer(sim, self, escortOf, ESCORT_LEASH * 0.5);
      mx = n.x;
      mz = n.z;
      jump = n.jump;
    } else if (anchor && dist2d(self.pos, anchor) > LORD_LEASH) {
      // 主公 never charges off alone: fall back toward his loyalists / squad while fighting
      const n = this.nav.steer(sim, self, anchor, LORD_LEASH * 0.5);
      mx = n.x;
      mz = n.z;
      jump = n.jump;
    } else if (d > hi && (!anchor || dist2d(t.pos, anchor) < hi + LORD_LEASH)) {
      const n = this.nav.steer(sim, self, t.pos, hi * 0.8);
      mx = n.x;
      mz = n.z;
      jump = n.jump;
      sprint = d > hi + 25 && n.straight;
    } else if (d < lo) {
      // back off if there is room behind
      const back = { x: self.pos.x - dx * 2.5, y: self.pos.y + 0.8, z: self.pos.z - dz * 2.5 };
      if (sim.lineOfSight({ x: self.pos.x, y: self.pos.y + 0.8, z: self.pos.z }, back)) {
        mx = -dx;
        mz = -dz;
      }
    }
    // strafe
    if (prof.strafe > 0 || now < this.ffBlockedUntil) {
      if (now >= this.strafeUntil) {
        this.strafeSign = this.rng.next() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 0.45 + this.rng.next() * (1.3 - prof.strafe * 0.5);
      }
      const px = -dz * this.strafeSign;
      const pz = dx * this.strafeSign;
      const side = { x: self.pos.x + px * 1.8, y: self.pos.y + 0.8, z: self.pos.z + pz * 1.8 };
      if (!sim.lineOfSight({ x: self.pos.x, y: self.pos.y + 0.8, z: self.pos.z }, side)) {
        this.strafeSign = -this.strafeSign;
        this.strafeUntil = now + 0.6;
      }
      // a friend in the line of fire: side-step decisively to open a new angle
      const amp = now < this.ffBlockedUntil ? 1 : prof.strafe * (h.ads ? 0.7 : 1);
      mx += -dz * this.strafeSign * amp;
      mz += dx * this.strafeSign * amp;
    }
    // dodge roll when bursted / something big is flying at us
    if (h.dodgeCharges > 0 && now >= this.nextDodgeAt) {
      const burst = this.underFire > 0.1 && now - this.lastHurtAt < 0.25;
      const incoming = prof.dodgeProjectiles && this.incomingProjectile();
      if ((burst || incoming) && this.rng.next() < prof.dodgeChance) {
        this.nextDodgeAt = now + 1.6;
        this.dodgeQueued = true;
      } else if (burst || incoming) {
        this.nextDodgeAt = now + 0.8;
      }
    }
    // hard bots hop occasionally under fire
    if (prof.name === 'hard' && now - this.lastHurtAt < 0.4 && this.rng.next() < 0.04) jump = true;
    const l = Math.hypot(mx, mz);
    if (l > 1) {
      mx /= l;
      mz /= l;
    }
    return { x: mx, z: mz, jump, sprint };
  }

  private incomingProjectile(): boolean {
    const { sim, self } = this;
    for (const p of sim.queryRadius(self.pos, 14, { kinds: ['projectile'] })) {
      if (!p.proj || this.x.creditOf(p.id) === self.id) continue;
      const rx = self.pos.x - p.pos.x;
      const rz = self.pos.z - p.pos.z;
      const vl = Math.hypot(p.vel.x, p.vel.z);
      if (vl < 1) continue;
      const along = (rx * p.vel.x + rz * p.vel.z) / vl;
      if (along <= 0) continue;
      const lat = Math.abs(rx * p.vel.z - rz * p.vel.x) / vl;
      if (lat < 2.5 + (p.proj.explodeRadius ?? 0) * 0.5 && along / vl < 0.6) return true;
    }
    return false;
  }

  /** Returns true when the view is driven by combat aiming this tick. */
  private aimAndFire(f: InputFrame, dt: number, aimedElsewhere: boolean): boolean {
    const { sim, self, now, prof } = this;
    const h = self.hero!;
    const t = this.target;
    if (aimedElsewhere) {
      f.yaw = this.aimer.yaw;
      f.pitch = this.aimer.pitch;
      return false;
    }
    const combatModes = this.mode === 'fight' || this.mode === 'retreat' || this.mode === 'zone' || this.mode === 'escort' || this.mode === 'hunt';
    if (!t || !this.targetLos || !combatModes) {
      if (t && !this.targetLos && this.mode === 'fight') {
        const seen = this.seen.get(t.id);
        if (!seen) return false;
        const o = this.aimer.lookAt(self, { x: seen.pos.x, y: seen.pos.y + 1.2, z: seen.pos.z }, dt, prof.trackTau * 2);
        f.yaw = o.yaw;
        f.pitch = o.pitch;
        f.aimPoint = o.point;
        return true;
      }
      return false;
    }
    let w = this.x.activeWeapon(self.id);
    this.weaponSwitch(f, w?.def, h);
    w = this.x.activeWeapon(self.id);
    const def = w?.def;
    const d = this.targetDist;
    const ads = this.wantsAds(def, d);
    const o = this.aimer.track(sim, self, t, def, dt, ads);
    this.lastAim = { errAngle: o.errAngle, targetAngle: o.targetAngle, point: o.point };
    f.yaw = o.yaw;
    f.pitch = o.pitch;
    f.aimPoint = o.point;
    // the target counts as "under the crosshair" (squad orders, marks) only when it is
    if (o.errAngle <= Math.max(o.targetAngle * 1.5, ORDER_CONE)) f.aimTargetId = t.id;
    if (ads) f.buttons |= BTN_ADS;
    if (!def) return true;
    // don't shoot while channelling an item / revive / crate (it would cancel it)
    if (h.channel) return true;
    if (now - this.targetSince < prof.reaction) return true;
    const inRange = def.melee ? d <= (def.melee.range ?? 2) + 0.8 : d <= def.maxRange * 0.97;
    if (!inRange) return true;
    if (t.hero?.downed && this.hostility(t) < 0.7) return true;
    if (this.mercy(t)) return true;
    const spread = ((ads ? def.spreadAds : def.spreadHip) * DEG) / 2;
    const tol = (o.targetAngle * 1.25 + spread * (def.pellets > 1 ? 1.2 : 0.4)) * (prof.name === 'easy' ? 1.6 : 1);
    if (o.errAngle > tol) return true;
    if (this.friendlyInLine(t, o.point)) return true;
    // burst control on autos at range
    if (def.auto) {
      if (prof.burstControl && d > def.falloffStart * 1.1 && def.class !== 'lmg') {
        if (now < this.pauseUntil) return true;
        if (now >= this.burstUntil) {
          this.burstUntil = now + 0.25 + this.rng.next() * 0.35;
          this.pauseUntil = this.burstUntil + 0.15 + this.rng.next() * 0.25;
        }
      }
      f.buttons |= BTN_FIRE;
      this.stats.shotsFired++;
    } else if (now >= this.nextClick) {
      const rate = Math.min(def.fireRate, prof.clickRate);
      this.nextClick = now + 1 / Math.max(0.3, rate) + this.rng.next() * 0.05;
      f.buttons |= BTN_FIRE;
      this.stats.shotsFired++;
    }
    return true;
  }

  /** Loyalist / 影武者: where the crown it escorts is (known position), once the gear-up is over. */
  private escortAnchor(): Vec3 | null {
    const lord = this.strategy!.crownRef(this);
    if (!lord || lord === this.self || this.now < this.strategy!.gearUntil) return null;
    return this.posOf(lord, 5) ?? null;
  }

  /** Where the lord's fight is anchored: his believed loyalists, else his squad, else null. */
  private lordAnchor(): Vec3 | null {
    const { sim, self } = this;
    const friends: Vec3[] = [];
    for (const a of this.allies()) {
      const p = this.posOf(a)!;
      if (dist2d(p, self.pos) < 45) friends.push(p);
    }
    if (friends.length > 0) return centroidOfPoints(friends);
    const squad = self.hero!.squad.map((id) => sim.get(id)).filter((e): e is Entity => !!e && e.alive && dist2d(e.pos, self.pos) < 30);
    if (squad.length >= 2) return centroidOfPoints(squad.map((e) => e.pos));
    return null;
  }

  /**
   * 主公 mercy: a hero we are not sure about is left alive when nearly beaten
   * (killing — or downing — a loyalist costs the lord all his gear).
   */
  private mercy(t: Entity): boolean {
    if (this.role !== 'lord' || t.kind !== 'hero') return false;
    if (!t.hero?.downed && t.hp > t.maxHp * 0.35) return false;
    const { sim, self } = this;
    const hostile = this.beliefs.p(sim, self, t, 'rebel') + this.beliefs.p(sim, self, t, 'traitor');
    return hostile < 0.85;
  }

  private wantsAds(def: WeaponDef | undefined, d: number): boolean {
    if (!def || def.melee) return false;
    const scoped = def.class === 'sniper' || def.class === 'bow' || def.class === 'dmr';
    if (this.prof.name === 'easy') return scoped && d > 25;
    if (scoped) return d > 12;
    if (def.class === 'shotgun' || def.class === 'flamer') return false;
    return d > (this.prof.name === 'hard' ? 16 : 22);
  }

  private weaponSwitch(f: InputFrame, def: WeaponDef | undefined, h: NonNullable<Entity['hero']>): void {
    const other = h.activeSlot === 0 ? 1 : 0;
    const ow = h.weapons[other];
    const cur = h.weapons[h.activeSlot];
    if (!ow) return;
    const empty = !cur || (def && def.magSize > 0 && !def.melee && cur.mag <= 0 && cur.reserve <= 0);
    const otherHasAmmo = ow.mag > 0 || ow.reserve > 0;
    if (empty && otherHasAmmo) {
      f.actions.push({ a: 'weapon', slot: other });
      return;
    }
    // splash weapon next to friends: use the sidearm for a while
    if (h.activeSlot === 0 && this.now < this.splashBlockedUntil && otherHasAmmo) {
      const sdef = weaponDefOf(ow.id);
      if (sdef && splashRadius(sdef) === 0) {
        this.swappedForRange = true;
        f.actions.push({ a: 'weapon', slot: 1 });
        return;
      }
    }
    // out of the primary's range: pull the sidearm; switch back when close again
    const d = this.targetDist;
    if (h.activeSlot === 0 && def && d > def.maxRange * 0.95 && otherHasAmmo) {
      const sdef = weaponDefOf(ow.id);
      if (sdef && d < sdef.maxRange * 0.9) {
        this.swappedForRange = true;
        f.actions.push({ a: 'weapon', slot: 1 });
      }
      return;
    }
    if (h.activeSlot === 1 && h.weapons[0] && (h.weapons[0].mag > 0 || h.weapons[0].reserve > 0)) {
      const pdef = weaponDefOf(h.weapons[0].id);
      const splashOk = !pdef || splashRadius(pdef) === 0 || this.now >= this.splashBlockedUntil;
      if (!this.swappedForRange || !pdef || (d < pdef.maxRange * 0.75 && splashOk) || (cur && cur.mag <= 0 && cur.reserve <= 0)) {
        this.swappedForRange = false;
        f.actions.push({ a: 'weapon', slot: 0 });
      }
    }
  }

  /**
   * Would this burst hit a believed ally or a bystander hero this bot can see?
   * Checked on a cadence (result cached): a raycast for whatever is first on
   * the line, plus a corridor test for visible heroes standing next to the
   * line (spread, pellets).
   */
  private friendlyInLine(t: Entity, aim: Vec3): boolean {
    const { sim, self, now } = this;
    if (!this.prof.friendlyFireCheck) return false;
    if (now < this.ffBlockedUntil) return true;
    // splash weapons re-check every trigger pull (a grenade is one big decision), others on a cadence
    const splashy = !!this.weapon && splashRadius(this.weapon) > 0;
    if (now < this.ffCheckAt && !splashy) return false;
    this.ffCheckAt = now + FF_CHECK_EVERY;
    const eye = sim.eyePos(self);
    const dx = aim.x - eye.x;
    const dy = aim.y - eye.y;
    const dz = aim.z - eye.z;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1) return false;
    const tOwner = this.x.commanderOf(t);
    const protectedHero = (owner: Entity | undefined): boolean =>
      !!owner && owner !== self && owner !== t && owner !== tOwner && (this.allyScore(owner) >= 0.55 || this.hostility(owner) < this.engageAt(owner));
    let blocked = false;
    const w = this.weapon;
    const hit = sim.raycast(eye, { x: dx / l, y: dy / l, z: dz / l }, Math.min(l, this.targetDist + 2), { ignore: [self.id], entities: true });
    if (hit && hit.entityId !== undefined && hit.entityId !== t.id) {
      const e = sim.get(hit.entityId);
      // something visible stands in the way (a stealthed hero is not "seen" in the way)
      if (e && isTargetable(sim, self, e)) blocked = protectedHero(this.x.commanderOf(e));
    }
    if (!blocked) {
      // visible heroes close to the line of fire (spread / pellets / splash)
      const td = this.targetDist;
      const width = w ? (w.projectile && w.projectile.explodeRadius > 0 ? w.projectile.explodeRadius + 1 : w.pellets > 1 || w.projectile ? 1.8 : 0.9) : 0.9;
      const ux = dx / l;
      const uz = dz / l;
      for (const e of sim.heroes()) {
        if (e === self || e === t || !e.hero || e.hero.dead || !this.seesNow(e)) continue;
        const rx = e.pos.x - eye.x;
        const rz = e.pos.z - eye.z;
        const along = rx * ux + rz * uz;
        if (along < 0.5 || along > td + 1) continue;
        const lat = Math.abs(rx * uz - rz * ux);
        if (lat < width && protectedHero(e)) {
          blocked = true;
          break;
        }
      }
    }
    if (!blocked && w) {
      // chain lightning / lock-on rockets / explosive rounds also hit whoever stands near the target
      const splash = splashRadius(w);
      if (splash > 0) {
        for (const e of sim.heroes()) {
          if (e === self || e === t || !e.hero || e.hero.dead || !this.seesNow(e)) continue;
          if (dist2d(e.pos, t.pos) <= splash && protectedHero(e)) {
            blocked = true;
            this.splashBlockedUntil = now + 5;
            break;
          }
        }
      }
    }
    if (blocked) {
      this.ffBlockedUntil = now + 0.35;
      // commit to the current side-step for a moment to open a new angle
      this.strafeUntil = Math.max(this.strafeUntil, now + 0.8);
    }
    return blocked;
  }

  private reloadLogic(f: InputFrame): void {
    const { self, now } = this;
    const h = self.hero!;
    if (h.channel || h.reloadUntil > now) return;
    const w = this.x.activeWeapon(self.id);
    if (!w || w.def.magSize <= 0 || w.def.melee || w.inst.reserve <= 0) return;
    const frac = w.inst.mag / w.def.magSize;
    const calm = !this.target || !this.targetLos;
    if (w.inst.mag <= 0 || (calm && frac < 0.6 && now - this.lastHurtAt > 1)) f.actions.push({ a: 'reload' });
  }

  // ── abilities / items: planned, then aimed like a human ─────────────────
  private maybeAbility(f: InputFrame): void {
    const now = this.now;
    if (now < this.nextAbilityAt) return;
    this.nextAbilityAt = now + this.prof.abilityEvery * (0.7 + this.rng.next() * 0.6);
    const plan = this.abilities.consider(this);
    if (plan) this.startCast(f, 'ability', plan);
  }

  private maybeItem(f: InputFrame): void {
    const now = this.now;
    if (now < this.nextItemAt) return;
    this.nextItemAt = now + this.prof.itemEvery * (0.7 + this.rng.next() * 0.6);
    const lordSide = this.role === 'loyalist' || this.role === 'double';
    // rebels top up while staging for the push (a lull, and the fight of the match is coming)
    const healAt = this.role === 'lord' ? 0.55 : this.strategy!.staging(this) ? 0.8 : this.prof.name === 'easy' ? 0.4 : 0.5;
    const plan = this.items.consider(this, { reserveTao: lordSide && this.strategy!.crownRef(this) !== undefined, healAt });
    if (plan) this.startCast(f, 'item', plan);
  }

  /** Self casts are pressed at once; aimed casts start turning the view (pressed in castAim). */
  private startCast(f: InputFrame, kind: 'ability' | 'item', plan: AbilityPlan | ItemPlan): void {
    const state: CastState = {
      kind,
      plan,
      key: -1 - (this.castSerial++ % 1_000_000),
      since: this.now,
      deadline: this.now + CAST_DEADLINE[this.prof.name],
      losOk: true,
      losAt: this.now,
    };
    if (plan.mode === 'none') {
      // no crosshair lock: never hand the world a target by accident (a 桃 on a downed enemy…)
      f.aimTargetId = undefined;
      this.press(f, state);
      return;
    }
    this.cast = state;
  }

  private press(f: InputFrame, c: CastState): void {
    if (c.kind === 'ability') {
      const p = c.plan as AbilityPlan;
      f.actions.push({ a: 'ability', slot: p.slot });
      this.abilities.pressed(this, p);
    } else {
      const p = c.plan as ItemPlan;
      f.actions.push({ a: 'item', slot: p.slot });
      this.items.pressed(this, p);
    }
    if (c.plan.mode !== 'none') this.stats.castsAimed++;
    this.cast = null;
  }

  private dropCast(timedOut: boolean): void {
    const c = this.cast;
    if (!c) return;
    this.cast = null;
    if (!timedOut) return;
    this.stats.castTimeouts++;
    const id = c.kind === 'ability' ? (c.plan as AbilityPlan).abilityId : (c.plan as ItemPlan).itemId;
    this.stats.timeoutsById[id] = (this.stats.timeoutsById[id] ?? 0) + 1;
    if (c.kind === 'ability') this.abilities.aimFailed(this, (c.plan as AbilityPlan).abilityId);
    else this.items.aimFailed(this, (c.plan as ItemPlan).itemId);
  }

  /**
   * Drive the view for the cast in progress: turn with lag and error, press
   * once the crosshair is on target and the reaction time has passed. Returns
   * true when it set the frame's view.
   */
  private castAim(f: InputFrame, dt: number): boolean {
    const c = this.cast!;
    const { sim, self, now, prof } = this;
    const h = self.hero!;
    const plan = c.plan;
    if (h.channel || h.downed) {
      this.dropCast(false);
      return false;
    }
    if (now > c.deadline) {
      this.dropCast(true);
      return false;
    }
    if (c.kind === 'ability' ? !this.abilities.stillReady(this, (plan as AbilityPlan).abilityId) : h.items[(plan as ItemPlan).slot]?.id !== (plan as ItemPlan).itemId) {
      this.dropCast(false);
      return false;
    }
    const tgt = plan.targetId !== undefined ? sim.get(plan.targetId) : undefined;
    if (plan.targetId !== undefined) {
      if (!tgt || !isTargetable(sim, self, tgt)) {
        this.dropCast(false);
        return false;
      }
      if (now - c.losAt >= LOS_EVERY) {
        c.losAt = now;
        c.losOk = tgt === this.target ? this.targetLos : hasLineOfSight(sim, self, tgt);
      }
    }
    const combatTarget = !!tgt && tgt === this.target;
    const reacted = combatTarget ? now - this.targetSince >= prof.reaction : now - c.since >= prof.reaction * 0.6;
    if (plan.mode === 'lock' && tgt) {
      let o: { errAngle: number; targetAngle: number; point: Vec3 };
      if (combatTarget && this.targetLos && this.aimAndFire(f, dt, false) && this.lastAim) {
        // same target as the gun: keep shooting while the crosshair settles
        o = this.lastAim;
      } else {
        const a: AimOut = this.aimer.track(sim, self, tgt, undefined, dt, false);
        o = { errAngle: a.errAngle, targetAngle: a.targetAngle, point: a.point };
        f.yaw = a.yaw;
        f.pitch = a.pitch;
        f.aimPoint = a.point;
      }
      if (c.losOk && reacted && o.errAngle <= o.targetAngle * 1.2 + LOCK_TOL[prof.name]) {
        f.aimTargetId = tgt.id;
        f.aimPoint = o.point;
        this.press(f, c);
      }
      return true;
    }
    // point: a static spot, a spot at the target's feet, or the target itself (skillshots)
    let pt: Vec3 | undefined = plan.point;
    if (pt && !tgt) {
      // a spot picked right in front of us that we walked up to: keep it comfortably ahead
      const dx = pt.x - self.pos.x;
      const dz = pt.z - self.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 6) {
        const ux = d > 0.5 ? dx / d : -Math.sin(self.yaw);
        const uz = d > 0.5 ? dz / d : -Math.cos(self.yaw);
        const px = self.pos.x + ux * 8;
        const pz = self.pos.z + uz * 8;
        pt = { x: px, y: sim.groundHeight(px, pz), z: pz };
        c.plan.point = pt;
      }
    }
    if (!pt && tgt) pt = plan.ground ? groundPointOf(this, tgt) : this.leadPoint(tgt, plan.leadSpeed);
    if (!pt) {
      this.dropCast(false);
      return false;
    }
    const a = this.aimer.aimAtPoint(sim, self, pt, dt, c.key);
    f.yaw = a.yaw;
    f.pitch = a.pitch;
    f.aimPoint = a.point;
    if ((tgt ? c.losOk : true) && reacted && a.errAngle <= POINT_TOL[prof.name]) {
      // the lock id only when the crosshair really is on the target
      if (tgt) {
        const tc = aimPointOf(tgt);
        const eye = sim.eyePos(self);
        const half = Math.atan2(Math.max(tgt.radius, 0.6), Math.max(0.5, Math.hypot(tc.x - eye.x, tc.y - eye.y, tc.z - eye.z)));
        f.aimTargetId = this.aimer.crosshairAngleTo(self, tc) <= Math.max(half * 1.5, ORDER_CONE) ? tgt.id : undefined;
      } else f.aimTargetId = undefined;
      this.press(f, c);
    }
    return true;
  }

  /** Where to aim a skillshot at `t`: its centre, led by the flight time (difficulty lead skill). */
  private leadPoint(t: Entity, speed: number | undefined): Vec3 {
    const c = aimPointOf(t);
    const d = dist2d(this.self.pos, t.pos);
    const ft = (speed && speed > 0 ? d / speed : 0) + this.prof.trackTau * 0.8;
    const k = ft * this.prof.leadSkill;
    return { x: c.x + t.vel.x * k, y: c.y, z: c.z + t.vel.z * k };
  }

  private squad(f: InputFrame): void {
    const { self, now } = this;
    const h = self.hero!;
    if (now - this.lastCmdAt < COMMAND_GAP) return;
    const t = this.target;
    if (this.mode === 'fight' && t && this.targetLos) {
      // marks are public minimap pins: hard bots mark their target, the 主公 marks whoever
      // attacks him, rebels mark the crown they push (normal / hard)
      const markIt =
        t.kind === 'hero' &&
        this.markedId !== t.id &&
        f.aimTargetId === t.id &&
        (this.prof.name === 'hard' ||
          (this.prof.name === 'normal' && ((this.role === 'lord' && this.obs.sinceAttack(this.sim, t.id, self.id) < 4) || (this.role === 'rebel' && t === this.strategy!.focusCrown(this)))));
      if (markIt) {
        f.actions.push({ a: 'mark' });
        this.markedId = t.id;
        this.lastCmdAt = now;
      }
      if (h.squad.length === 0) return;
      if (this.lastCmdKind !== 'attack' || this.lastCmdTarget !== t.id) {
        if (f.aimTargetId !== t.id) return; // the order needs the target under the crosshair
        f.actions.push({ a: 'command', order: 'attack' });
        this.lastCmdKind = 'attack';
        this.lastCmdTarget = t.id;
        this.lastCmdAt = now;
      }
      return;
    }
    if (h.squad.length === 0) return;
    if (this.mode === 'escort') {
      const lord = this.strategy!.crownRef(this);
      const lp = lord ? this.posOf(lord, 3) : undefined;
      // the lord visibly under fire nearby: the squad holds around him
      const lordHit = !!lord && !!lp && this.seesNow(lord) && this.x.sinceDamaged(lord.id) < 3 && dist2d(lp, self.pos) < 25;
      if (lordHit && this.lastCmdKind !== 'hold') {
        f.aimPoint = { ...lp! };
        f.actions.push({ a: 'command', order: 'hold' });
        this.lastCmdKind = 'hold';
        this.lastCmdAt = now;
        return;
      }
      if (this.lastCmdKind === 'hold' && lord && lp && this.seesNow(lord) && this.x.sinceDamaged(lord.id) < 10 && dist2d(lp, self.pos) < 25) return;
    }
    if (this.lastCmdKind !== 'follow') {
      f.actions.push({ a: 'command', order: 'follow' });
      this.lastCmdKind = 'follow';
      this.lastCmdTarget = undefined;
      this.lastCmdAt = now;
    }
  }

  // ── downed ──────────────────────────────────────────────────────────────
  private downedThink(f: InputFrame, dt: number): void {
    const { sim, self } = this;
    // 酒 / anything usable while downed — give a believed ally right next to us a moment to revive us first
    if (!this.wasDowned) this.downedAt = this.now;
    const allies = this.allies();
    const helper = allies.some((a) => dist2d(this.posOf(a)!, self.pos) < 6);
    if (!helper || this.now - this.downedAt > 3) {
      const plan = this.items.consider(this, { reserveTao: false, healAt: 0 });
      if (plan) {
        f.actions.push({ a: 'item', slot: plan.slot });
        this.items.pressed(this, plan);
      }
    }
    // crawl toward a believed ally, or away from the nearest visible hostile
    let goal: Vec3 | null = null;
    let bd = 30;
    for (const a of allies) {
      const p = this.posOf(a)!;
      const d = dist2d(p, self.pos);
      if (d < bd) {
        bd = d;
        goal = p;
      }
    }
    let dirx = 0;
    let dirz = 0;
    if (goal && bd > 1.5) {
      dirx = goal.x - self.pos.x;
      dirz = goal.z - self.pos.z;
    } else {
      let threat: Entity | undefined;
      let td = 30;
      for (const e of sim.heroes()) {
        if (e === self || !e.hero || e.hero.dead || e.hero.downed || !this.seesNow(e)) continue;
        const d = dist2d(e.pos, self.pos);
        if (d < td && this.hostility(e) >= 0.5) {
          td = d;
          threat = e;
        }
      }
      if (threat) {
        dirx = self.pos.x - threat.pos.x;
        dirz = self.pos.z - threat.pos.z;
      }
    }
    const l = Math.hypot(dirx, dirz);
    if (l > 0.1) {
      this.aimer.face(self, Math.atan2(-dirx / l, -dirz / l), dt, 0.2);
      f.moveZ = 1;
    }
    f.yaw = this.aimer.yaw;
    f.pitch = 0;
  }

  /** Last known positions of the living crowns (other than us) within `r` m. */
  private crownsNear(r: number): Vec3[] {
    const out: Vec3[] = [];
    for (const e of this.sim.heroes()) {
      if (e === this.self || !e.hero || e.hero.dead || !wearsCrown(this.sim, e)) continue;
      const p = this.posOf(e, 10);
      if (p && dist2d(p, this.self.pos) < r) out.push(p);
    }
    return out;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────
/** Preferred engagement band [min, max] (m) for a weapon. */
export function idealRange(def: WeaponDef | undefined): [number, number] {
  if (!def) return [8, 25];
  if (def.melee) return [0, 1.6];
  switch (def.class) {
    case 'shotgun':
      return [3, Math.min(10, def.falloffStart * 1.3)];
    case 'flamer':
      return [4, Math.min(11, def.maxRange * 0.7)];
    case 'smg':
      return [6, Math.max(14, def.falloffStart * 1.3)];
    case 'pistol':
      return [7, Math.max(16, def.falloffStart * 1.2)];
    case 'sniper':
    case 'bow':
      return [30, 75];
    case 'dmr':
      return [18, 50];
    case 'launcher':
      return [14, 40];
    default:
      return [10, Math.max(26, def.falloffStart)];
  }
}

function toLocal(yaw: number, dx: number, dz: number): { mx: number; mz: number } {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return { mx: dx * rx + dz * rz, mz: dx * fx + dz * fz };
}

const clampUnit = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : Number.isFinite(v) ? v : 0);

/** A point 30 m down the third-person crosshair ray (the aimPoint while not aiming at anything). */
function crosshairAhead(self: Entity, yaw: number, pitch: number): Vec3 {
  const rig = cameraRig(self.pos, yaw, pitch, self.hero?.downed === true);
  return { x: rig.origin.x + rig.dir.x * 30, y: rig.origin.y + rig.dir.y * 30, z: rig.origin.z + rig.dir.z * 30 };
}

function centroidOfPoints(list: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of list) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / list.length, y: y / list.length, z: z / list.length };
}

/** Radius around the target that a weapon's special / explosion also hits. */
export function splashRadius(def: WeaponDef): number {
  if (def.special === 'chainLightning') return (def.specialParams.radius ?? 7) * Math.max(1, def.specialParams.chains ?? 2);
  if (def.special === 'multiTarget') return def.specialParams.lockRadius ?? 10;
  if (def.projectile && def.projectile.explodeRadius > 0) return def.projectile.explodeRadius + 1;
  return 0;
}

function weaponDefOf(id: string): WeaponDef | undefined {
  return WEAPON_BY_ID[id];
}

/** Factory used by the world (settings.botDifficulty). */
export function createHeroBot(seat: number, difficulty: BotDifficulty, seed: number): HeroBot {
  return new HeroBot(seat, difficulty, seed);
}
