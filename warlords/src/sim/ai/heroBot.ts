// Role-aware 三国杀 bot hero (wave 2). One instance per bot seat; produces an
// InputFrame per tick exactly like a human client would (movement, view,
// buttons, edge actions). It only knows what a human in its seat would know
// (knowledge.ts / observer.ts / beliefs.ts) and plays its role (strategy.ts):
//   perceive (cadenced threat scan, LOS cache) → decide (mode: fight / retreat /
//   revive / loot / zone / role objective) → act (navigate, strafe, dodge,
//   cover, aim with human-like error, fire discipline, reload, weapon swaps,
//   interact) → abilities / items / squad orders / claims & quick-chat.
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
import { AbilityUser } from './abilityUse';
import { Aimer } from './aimer';
import { Beliefs } from './beliefs';
import type { BotMode, BotView, Threat } from './botTypes';
import { findCover } from './cover';
import { difficultyProfile } from './difficulty';
import type { DifficultyProfile } from './difficulty';
import { lootValue, needsInteract } from './gear';
import { ItemUser } from './itemUse';
import { ownBountyTarget, ownRole, wearsCrown } from './knowledge';
import { Navigator } from './navigator';
import { observerFor } from './observer';
import { registerMind } from './registry';
import type { WorldObserver } from './observer';
import { UNIT_KINDS, aimPointOf, dist2d, hasLineOfSight, hazardEscape, isTargetable } from './perception';
import { RoleStrategy, clampIntoZone, pressure } from './strategy';

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

interface Seen {
  pos: Vec3;
  t: number;
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

  // ── BotView (valid during think) ──
  sim!: SimApi;
  x!: SimExt;
  self!: Entity;
  now = 0;
  role: RoleId = 'opportunist';
  obs!: WorldObserver;
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
  readonly stats: BotStats = { abilities: 0, items: 0, shotsFired: 0, revivesStarted: 0, cratesOpened: 0, claims: 0, quickchats: 0, stuckEvents: 0 };

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
    this.obs = observerFor(sim);
    this.obs.update(sim);
    registerMind(sim, self.id, this);
    this.beliefs.update(sim, self, this.obs);
    this.trackHp();
    const aw = this.x.activeWeapon(self.id);
    this.weapon = aw?.def;

    if (h.downed) {
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
    if (this.now >= this.nextDecide) {
      this.nextDecide = this.now + DECIDE_EVERY * (0.8 + this.rng.next() * 0.4);
      this.decide();
    }
    this.act(f, dt);
    // one decision per frame for the view: a revive / pickup in progress keeps the crosshair
    const busy = f.actions.some((a) => a.a === 'item' || a.a === 'interact');
    if (!busy) this.maybeAbility(f);
    if (!busy && !f.actions.some((a) => a.a === 'ability')) this.maybeItem(f);
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

  allies(includeDowned = false): Entity[] {
    const out: Entity[] = [];
    for (const e of this.sim.heroes()) {
      if (e === this.self || !e.hero || e.hero.dead) continue;
      if (e.hero.downed && !includeDowned) continue;
      if (this.allyScore(e) >= 0.55) out.push(e);
    }
    return out;
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
      this.targetDist = dist2d(self.pos, t.pos);
      if (now >= this.nextLosAt) {
        this.nextLosAt = now + LOS_EVERY;
        this.targetLos = hasLineOfSight(sim, self, t);
      }
      if (this.targetLos) this.seen.set(t.id, { pos: { ...t.pos }, t: now });
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
    const crownInReach = this.role === 'rebel' && aliveCrownsNear(sim, self, 50).length > 0;
    for (const c of cands) {
      if (!c.alive || c.hero?.dead) continue;
      if (sim.isOwnSide(self, c)) continue;
      if (!isTargetable(sim, self, c)) continue;
      const hst = this.hostility(c);
      if (hst < 0.3) continue;
      const d = dist2d(self.pos, c.pos);
      const kindW = c.kind === 'hero' ? 1 : c.kind === 'turret' ? 0.6 : c.kind === 'npc' ? 0.5 : 0.45;
      const hpFrac = c.hp / Math.max(1, c.maxHp);
      let s = hst * kindW * (1 + 0.6 * (1 - hpFrac)) * (1 / (1 + d / 30));
      if (attackers.has(c.id)) s *= 1.5;
      if (c.hero?.downed) s *= hst >= 0.7 ? 1.25 : 0.2;
      if (c === this.target) s *= 1.3;
      if (bounty !== undefined && c.id === bounty) s *= 1.4;
      // the rebels' push focuses the crown and ignores his soldiers when he is in reach
      if (this.role === 'rebel' && this.strategy!.pushing(this)) {
        if (c.kind === 'hero' && wearsCrown(sim, c)) s *= 2.2;
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
      list.push({ e: c, hostility: hst, score: s, dist: d, los: false });
    }
    list.sort((a, b) => b.score - a.score);
    const n = Math.min(list.length, 5);
    for (let i = 0; i < n; i++) list[i].los = hasLineOfSight(sim, self, list[i].e);
    this.threats = list.length > 8 ? list.slice(0, 8) : list;
    // choose the target
    let best: Threat | undefined;
    for (const t of this.threats) {
      if (t.hostility < this.engageAt(t.e)) continue;
      const recentlySeen = (this.seen.get(t.e.id)?.t ?? -99) > now - SEEN_MEMORY;
      if (!t.los && !attackers.has(t.e.id) && !recentlySeen) continue;
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
    // committed push: rebels only break off when nearly dead, unless the lord is out of reach
    if (this.role === 'rebel' && pushing && t && wearsCrown(this.sim, t)) retreatHp -= 0.12;
    if (this.role === 'lord' || this.role === 'traitor' || this.role === 'opportunist') retreatHp += 0.08;
    if (this.role === 'lord' && this.threats.filter((x) => x.e.kind === 'hero' && x.hostility >= 0.8 && x.dist < 40).length >= 2) retreatHp += 0.06;
    const closeThreat = this.threats.find((x) => x.hostility >= 0.5 && x.dist < 32 && (x.los || x.e.kind === 'hero'));
    // zone emergencies first
    const zg = this.zoneGoal();
    const out = this.outsideZone(1);
    // a close duel may finish at the edge of a weak circle — never for the lord
    const fightingClose = this.role !== 'lord' && !!t && this.targetLos && this.targetDist < 15 && hpFrac > 0.6 && this.x.zoneView().dps <= 4;
    if (zg && out && !fightingClose) return this.setMode('zone', zg, 3, true);
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
      this.reviveId = rv.id;
      return this.setMode('revive', rv.pos, 1.3, dist2d(self.pos, rv.pos) > 8);
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
    if (obj.goal) return this.setMode(obj.mode, obj.goal, obj.arrive, obj.sprint);
    this.mode = obj.mode;
    this.goal = null;
    void h;
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
    // cover first (if this bot plays with cover)
    if (this.prof.coverUse > 0 && (this.coverSpot === null || now - this.coverAt > 1.5)) {
      this.coverAt = now;
      this.coverSpot = this.rng.next() < this.prof.coverUse ? findCover(sim, self, { threats: [sim.eyePos(threat)], maxDist: 16, budget: 8, maxAdvance: 2 }) : null;
    }
    if (this.coverSpot && dist2d(this.coverSpot, self.pos) < 20) return this.coverSpot;
    // fall back behind believed allies (lord: behind the loyalists)
    const allies = this.allies();
    let best: Entity | undefined;
    let bd = 45;
    for (const a of allies) {
      const d = dist2d(a.pos, self.pos);
      if (d < bd && dist2d(a.pos, threat.pos) > 6) {
        bd = d;
        best = a;
      }
    }
    if (best) {
      const dx = best.pos.x - threat.pos.x;
      const dz = best.pos.z - threat.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      return clampIntoZone(sim, { x: best.pos.x + (dx / l) * 5, y: best.pos.y, z: best.pos.z + (dz / l) * 5 }, now);
    }
    const dx = self.pos.x - threat.pos.x;
    const dz = self.pos.z - threat.pos.z;
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

  private reviveCandidate(): Entity | undefined {
    const { sim, self, now } = this;
    if (!this.hasTao() && !this.canReviveFree()) return undefined;
    let best: Entity | undefined;
    let bs = Infinity;
    for (const e of sim.heroes()) {
      if (e === self || !e.hero || !e.hero.downed || e.hero.dead) continue;
      const d = dist2d(e.pos, self.pos);
      if (d > 35 || Math.abs(e.pos.y - self.pos.y) > 3) continue;
      if (!this.strategy!.wantsRevive(this, e)) continue;
      const left = e.hero.downedUntil - now;
      if (left < d / 5 + 1.8) continue;
      // too dangerous? count hostile heroes close to the downed ally
      let danger = 0;
      for (const t of this.threats) if (t.e.kind === 'hero' && t.hostility >= 0.5 && dist2d(t.e.pos, e.pos) < 18) danger++;
      if (danger >= 2 || (danger >= 1 && self.hp < self.maxHp * 0.4)) continue;
      const s = d - (wearsCrown(sim, e) ? 20 : 0);
      if (s < bs) {
        bs = s;
        best = e;
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
    const avoid = this.role === 'rebel' && !this.strategy!.pushing(this) ? aliveCrownsNear(sim, self, 140) : [];
    const consider = (e: Entity, maxD: number): void => {
      if ((this.lootBlacklist.get(e.id) ?? 0) > now) return;
      for (const c of avoid) if (dist2d(c.pos, e.pos) < 62) return;
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
    const airR = this.role === 'loyalist' || this.role === 'lord' ? Math.min(radius + 15, 40) : 90;
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
          const d = dist2d(e.pos, self.pos);
          if (d > 1.6) {
            const n = this.nav.steer(this.sim, self, e.pos, 1.2);
            mv = n;
            jump = n.jump;
            sprint = d > 8;
          }
          if (d < INTERACT_RANGE) {
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

    // aim + fire
    const shooting = this.aimAndFire(f, dt, aimed);
    if (!shooting && !aimed) {
      // face where we are going (or glance at a nearby threat)
      const look = this.threats.find((x) => x.los && x.dist < 40);
      if (look && this.mode !== 'zone') this.aimer.lookAt(self, aimPointOf(look.e), dt, 0.3);
      else if (Math.hypot(mv.x, mv.z) > 0.1) this.aimer.face(self, Math.atan2(-mv.x, -mv.z), dt, 0.15);
    }
    if (!shooting) {
      f.yaw = this.aimer.yaw;
      f.pitch = this.aimer.pitch;
      if (!f.aimPoint) f.aimPoint = crosshairAhead(self, this.aimer.yaw, this.aimer.pitch);
    }
    if (shooting) sprint = false;
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
    const [lo, hi] = idealRange(this.weapon);
    let mx = 0;
    let mz = 0;
    let jump = false;
    let sprint = false;
    // reload behind cover
    const reloading = h.reloadUntil > now;
    if (reloading && prof.coverUse > 0 && d < 45) {
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
      const seen = this.seen.get(t.id);
      const goal = seen && now - seen.t < SEEN_MEMORY ? seen.pos : t.pos;
      const n = this.nav.steer(sim, self, goal, 2);
      return { x: n.x, z: n.z, jump: n.jump, sprint: d > 25 && n.straight };
    }
    const dx = (t.pos.x - self.pos.x) / Math.max(1e-3, d);
    const dz = (t.pos.z - self.pos.z) / Math.max(1e-3, d);
    const anchor = this.role === 'lord' ? this.lordAnchor() : null;
    if (anchor && dist2d(self.pos, anchor) > LORD_LEASH) {
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

  private dodgeQueued = false;

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
        const p = seen ? { x: seen.pos.x, y: seen.pos.y + 1.2, z: seen.pos.z } : aimPointOf(t);
        const o = this.aimer.lookAt(self, p, dt, prof.trackTau * 2);
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
    f.yaw = o.yaw;
    f.pitch = o.pitch;
    f.aimPoint = o.point;
    f.aimTargetId = t.id;
    if (ads) f.buttons |= BTN_ADS;
    if (this.dodgeQueued) {
      this.dodgeQueued = false;
      f.actions.push({ a: 'dodge' });
    }
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

  /** Where the lord's fight is anchored: his believed loyalists, else his squad, else null. */
  private lordAnchor(): Vec3 | null {
    const { sim, self } = this;
    const friends = this.allies().filter((a) => dist2d(a.pos, self.pos) < 45);
    if (friends.length > 0) return centroidOf(friends);
    const squad = self.hero!.squad.map((id) => sim.get(id)).filter((e): e is Entity => !!e && e.alive && dist2d(e.pos, self.pos) < 30);
    if (squad.length >= 2) return centroidOf(squad);
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
   * Would this burst hit a believed ally or a bystander hero? Checked on a
   * cadence (result cached): a raycast for whatever is first on the line, plus
   * a corridor test for heroes standing next to the line (spread, pellets).
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
      if (e) blocked = protectedHero(this.x.commanderOf(e));
    }
    if (!blocked) {
      // heroes standing close to the line of fire (spread / pellets / splash)
      const td = this.targetDist;
      const width = w ? (w.projectile && w.projectile.explodeRadius > 0 ? w.projectile.explodeRadius + 1 : w.pellets > 1 || w.projectile ? 1.8 : 0.9) : 0.9;
      const ux = dx / l;
      const uz = dz / l;
      for (const e of sim.heroes()) {
        if (e === self || e === t || !e.hero || e.hero.dead) continue;
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
          if (e === self || e === t || !e.hero || e.hero.dead) continue;
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

  // ── abilities / items / squad ───────────────────────────────────────────
  private maybeAbility(f: InputFrame): void {
    const now = this.now;
    if (now < this.nextAbilityAt) return;
    this.nextAbilityAt = now + this.prof.abilityEvery * (0.7 + this.rng.next() * 0.6);
    const plan = this.abilities.consider(this);
    if (!plan) return;
    const prevYaw = f.yaw;
    if (plan.yaw !== undefined && plan.pitch !== undefined) {
      f.yaw = plan.yaw;
      f.pitch = plan.pitch;
      this.aimer.snap(plan.yaw, plan.pitch);
    }
    if (plan.aimPoint) f.aimPoint = plan.aimPoint;
    f.aimTargetId = plan.aimTargetId;
    f.actions.push({ a: 'ability', slot: plan.slot });
    // re-express movement in the new view
    this.reframe(f, prevYaw);
  }

  private maybeItem(f: InputFrame): void {
    const now = this.now;
    if (now < this.nextItemAt) return;
    this.nextItemAt = now + this.prof.itemEvery * (0.7 + this.rng.next() * 0.6);
    const lordSide = this.role === 'loyalist' || this.role === 'double';
    const healAt = this.role === 'lord' ? 0.55 : this.prof.name === 'easy' ? 0.4 : 0.5;
    const plan = this.items.consider(this, { reserveTao: lordSide && this.strategy!.crownRef(this) !== undefined, healAt });
    if (!plan) return;
    const prevYaw = f.yaw;
    if (plan.yaw !== undefined && plan.pitch !== undefined) {
      f.yaw = plan.yaw;
      f.pitch = plan.pitch;
      this.aimer.snap(plan.yaw, plan.pitch);
    }
    if (plan.aimPoint) f.aimPoint = plan.aimPoint;
    f.aimTargetId = plan.aimTargetId;
    f.actions.push({ a: 'item', slot: plan.slot });
    this.reframe(f, prevYaw);
  }

  /** Movement was computed for `prevYaw`: keep the world direction after a view flick. */
  private reframe(f: InputFrame, prevYaw: number): void {
    if (prevYaw === f.yaw) return;
    const mv = fromLocal(prevYaw, f.moveX, f.moveZ);
    const loc = toLocal(f.yaw, mv.x, mv.z);
    f.moveX = clampUnit(loc.mx);
    f.moveZ = clampUnit(loc.mz);
    f.buttons &= ~BTN_SPRINT;
  }

  private squad(f: InputFrame): void {
    const { self, now } = this;
    const h = self.hero!;
    if (h.squad.length === 0 || now - this.lastCmdAt < COMMAND_GAP) return;
    const t = this.target;
    if (this.mode === 'fight' && t && this.targetLos) {
      if (this.lastCmdKind !== 'attack' || this.lastCmdTarget !== t.id) {
        if (f.aimTargetId !== t.id) return; // the order needs the target under the crosshair
        f.actions.push({ a: 'command', order: 'attack' });
        this.lastCmdKind = 'attack';
        this.lastCmdTarget = t.id;
        this.lastCmdAt = now;
        // hard bots also mark heroes for focus fire
        if (this.prof.name === 'hard' && t.kind === 'hero' && this.markedId !== t.id) {
          f.actions.push({ a: 'mark' });
          this.markedId = t.id;
        }
      }
      return;
    }
    if (this.mode === 'escort') {
      const lord = this.strategy!.crownRef(this);
      if (lord && this.x.sinceDamaged(lord.id) < 3 && dist2d(lord.pos, self.pos) < 25 && this.lastCmdKind !== 'hold') {
        // guard the lord: squad holds around him
        f.aimPoint = { ...lord.pos };
        f.actions.push({ a: 'command', order: 'hold' });
        this.lastCmdKind = 'hold';
        this.lastCmdAt = now;
        return;
      }
      if (this.lastCmdKind === 'hold' && lord && (this.x.sinceDamaged(lord.id) < 10 && dist2d(lord.pos, self.pos) < 25)) return;
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
    const helper = this.allies().some((a) => dist2d(a.pos, self.pos) < 6);
    if (!helper || this.now - this.downedAt > 3) {
      const plan = this.items.consider(this, { reserveTao: false, healAt: 0 });
      if (plan) f.actions.push({ a: 'item', slot: plan.slot });
    }
    // crawl toward a believed ally, or away from the nearest hostile
    let goal: Vec3 | null = null;
    let bd = 30;
    for (const a of this.allies()) {
      const d = dist2d(a.pos, self.pos);
      if (d < bd) {
        bd = d;
        goal = a.pos;
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
        if (e === self || !e.hero || e.hero.dead || e.hero.downed) continue;
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

function fromLocal(yaw: number, mx: number, mz: number): { x: number; z: number } {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return { x: mx * rx + mz * fx, z: mx * rz + mz * fz };
}

const clampUnit = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : Number.isFinite(v) ? v : 0);

/** A point 30 m down the third-person crosshair ray (the aimPoint while not aiming at anything). */
function crosshairAhead(self: Entity, yaw: number, pitch: number): Vec3 {
  const rig = cameraRig(self.pos, yaw, pitch, self.hero?.downed === true);
  return { x: rig.origin.x + rig.dir.x * 30, y: rig.origin.y + rig.dir.y * 30, z: rig.origin.z + rig.dir.z * 30 };
}

function aliveCrownsNear(sim: SimApi, self: Entity, r: number): Entity[] {
  return sim.heroes().filter((e) => e !== self && e.hero && !e.hero.dead && wearsCrown(sim, e) && dist2d(e.pos, self.pos) < r);
}

function centroidOf(list: readonly Entity[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const e of list) {
    x += e.pos.x;
    y += e.pos.y;
    z += e.pos.z;
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
