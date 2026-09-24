// 跳身份 logic: each bot keeps its own suspicion model of every hero whose
// role it cannot see. Evidence comes only from public observations
// (observer.ts) and is interpreted from the bot's own seat (it knows its own
// role, so "someone shot me" means something different to a loyalist and to a
// rebel):
//  - hurting a crown bearer → rebel-ish (unless it was retaliation);
//  - hurting a believed loyalist / a believed rebel → rebel-ish / loyal-ish;
//  - healing or reviving a crown / an ally → aligned with them;
//  - killing a hero reveals the victim's role: killers of rebels look loyal,
//    killers of loyalists look rebel; subtle readers also re-read the dead
//    hero's past (whom it shot / healed);
//  - claims: 我是忠臣 is weak (traitors lie), 我是反贼 is an admission;
//  - escorting a crown for a long time without shooting it → loyal-ish.
// Evidence decays (half-life per difficulty). Probabilities combine the
// evidence likelihoods with the public role table and are made consistent
// with it by a few Sinkhorn iterations (rows = heroes, columns = roles).
import type { Entity, EntityId, RoleId } from '../../core/types';
import type { SimApi } from '../api';
import type { DifficultyProfile } from './difficulty';
import { HIDDEN_ROLES, ownRole, roleKnownTo, tableKnowledge, wearsCrown } from './knowledge';
import type { HiddenRole, RoleCounts, TableKnowledge } from './knowledge';
import type { ObsEvent, WorldObserver } from './observer';

interface Evidence {
  /** lord-side behaviour */
  pro: number;
  /** anti-lord behaviour */
  anti: number;
  /** traitor-specific evidence (claims) */
  trait: number;
}

interface Deed {
  time: number;
  kind: 'attack' | 'heal';
  target: EntityId;
  amount: number;
}

const RECOMPUTE_EVERY = 0.5;
const PROXIMITY_EVERY = 2;
const DEED_MEMORY = 90;
const SINKHORN_ITERS = 10;
const SCORE_CLAMP = 8;

const LORD_SIDE: ReadonlySet<RoleId> = new Set<RoleId>(['lord', 'loyalist', 'double']);

export class Beliefs {
  private readonly ev = new Map<EntityId, Evidence>();
  private readonly probs = new Map<EntityId, RoleCounts>();
  private readonly deeds = new Map<EntityId, Deed[]>();
  /** squad-growth tells per crown (the real lord can summon, the 影武者 cannot) */
  private readonly crownTell = new Map<EntityId, number>();
  private cursor = 0;
  private lastDecay = -1;
  private nextRecompute = 0;
  private nextProximity = 0;
  private dirty = true;
  table: TableKnowledge | null = null;
  /** table base rates of the hidden roles among the unknown heroes */
  private baseLoyal = 0.3;
  private baseRebel = 0.5;

  constructor(private readonly prof: DifficultyProfile) {}

  /** Consume new observations and refresh probabilities on a cadence. */
  update(sim: SimApi, self: Entity, obs: WorldObserver): void {
    const now = sim.time;
    const events = obs.since(this.cursor);
    if (events.length > 0) {
      this.cursor = events[events.length - 1].seq;
      for (const e of events) this.apply(sim, self, obs, e);
    }
    // decay
    if (this.lastDecay < 0) this.lastDecay = now;
    const dtDecay = now - this.lastDecay;
    if (dtDecay >= 1) {
      const k = Math.pow(0.5, dtDecay / this.prof.evidenceHalfLife);
      for (const e of this.ev.values()) {
        e.pro *= k;
        e.anti *= k;
        e.trait *= k;
      }
      this.lastDecay = now;
    }
    if (this.prof.subtleReads && now >= this.nextProximity) {
      this.nextProximity = now + PROXIMITY_EVERY;
      this.proximityReads(sim, self, obs);
    }
    if (this.dirty || now >= this.nextRecompute) {
      this.nextRecompute = now + RECOMPUTE_EVERY;
      this.dirty = false;
      this.recompute(sim, self);
    }
  }

  private evOf(id: EntityId): Evidence {
    let e = this.ev.get(id);
    if (!e) {
      e = { pro: 0, anti: 0, trait: 0 };
      this.ev.set(id, e);
    }
    return e;
  }

  private remember(actor: EntityId, d: Deed): void {
    let list = this.deeds.get(actor);
    if (!list) {
      list = [];
      this.deeds.set(actor, list);
    }
    list.push(d);
    if (list.length > 64) list.splice(0, list.length - 64);
  }

  /** Is `id` a hero whose role this viewer does not know (so evidence matters)? */
  private hidden(sim: SimApi, self: Entity, id: EntityId | undefined): id is EntityId {
    if (id === undefined || id === self.id) return false;
    const e = sim.get(id);
    if (!e?.hero || e.hero.dead) return false;
    return roleKnownTo(sim, self, e) === undefined;
  }

  private apply(sim: SimApi, self: Entity, obs: WorldObserver, ev: ObsEvent): void {
    const g = this.prof.evidenceGain;
    const target = sim.get(ev.target);
    if (!target?.hero) return;
    switch (ev.kind) {
      case 'attack': {
        if (ev.actor === undefined) return;
        this.remember(ev.actor, { time: ev.time, kind: 'attack', target: ev.target, amount: ev.amount });
        const actor = sim.get(ev.actor);
        if (!actor?.hero) return;
        const w = g * (Math.min(ev.amount, 120) / 60 + 0.1) * (ev.viaSquad ? 0.35 : 1) * (ev.field ? 0.2 : 1);
        // the lord side shooting someone: a weak hint that the victim is suspected
        if (wearsCrown(sim, actor) && this.hidden(sim, self, ev.target)) this.evOf(ev.target).anti += 0.12 * w;
        if (!this.hidden(sim, self, ev.actor)) return;
        let retaliation = obs.sinceAttack(sim, ev.target, ev.actor) < 6 ? (wearsCrown(sim, target) ? 0.3 : 0.4) : 1;
        // collateral: the actor is trading fire with someone else (e.g. a loyalist fighting the
        // lord's attacker right next to him) — its hits on bystanders say little
        for (const o of sim.heroes()) {
          if (o.id === ev.actor || o.id === ev.target || !o.hero || o.hero.dead) continue;
          if (obs.recentDamage(sim, ev.actor, o.id) >= 10 && obs.recentDamage(sim, o.id, ev.actor) >= 10) {
            retaliation *= 0.2;
            break;
          }
        }
        const e = this.evOf(ev.actor);
        if (wearsCrown(sim, target) || (target === self && LORD_SIDE.has(ownRole(self)))) {
          e.anti += (target === self && !wearsCrown(sim, target) ? 1.4 : 2.2) * w * retaliation;
        } else {
          // shooting someone we know nothing about tells us nothing: only the victim's
          // deviation from the table's base rates is informative
          e.anti += w * Math.max(0, this.lordSideness(sim, self, target) - this.baseLoyal) * retaliation;
          e.pro += w * Math.max(0, this.rebelness(sim, self, target) - this.baseRebel) * retaliation;
        }
        this.dirty = true;
        return;
      }
      case 'heal':
      case 'revive': {
        if (ev.actor === undefined || ev.actor === ev.target) return;
        this.remember(ev.actor, { time: ev.time, kind: 'heal', target: ev.target, amount: ev.amount });
        if (!this.hidden(sim, self, ev.actor)) return;
        const e = this.evOf(ev.actor);
        const w = ev.kind === 'revive' ? 1.6 * g : g * Math.min(1, ev.amount / 80) * 0.8;
        if (wearsCrown(sim, target)) e.pro += 2 * w;
        else {
          e.pro += w * Math.max(0, this.lordSideness(sim, self, target) - this.baseLoyal);
          e.anti += w * Math.max(0, this.rebelness(sim, self, target) - this.baseRebel);
        }
        this.dirty = true;
        return;
      }
      case 'death': {
        const role = ev.role;
        this.ev.delete(ev.target);
        this.probs.delete(ev.target);
        this.dirty = true;
        if (!role) return;
        const rebel = role === 'rebel';
        const loyal = role === 'loyalist' || role === 'double';
        if (this.hidden(sim, self, ev.actor)) {
          const k = this.evOf(ev.actor);
          if (rebel) k.pro += 2.5 * g;
          else if (loyal) k.anti += 3 * g;
          else if (role === 'traitor') k.pro += 0.4 * g;
        }
        if (!this.prof.subtleReads) return;
        // re-read the history now that the victim's role is public
        const now = sim.time;
        for (const [actor, list] of this.deeds) {
          if (!this.hidden(sim, self, actor)) continue;
          for (const d of list) {
            if (d.target !== ev.target || now - d.time > DEED_MEMORY) continue;
            const w = 0.4 * g * Math.min(1, d.amount / 60);
            const k = this.evOf(actor);
            if (d.kind === 'attack') {
              if (rebel) k.pro += w;
              else if (loyal) k.anti += w;
            } else if (rebel) k.anti += 2 * w;
            else if (loyal) k.pro += 2 * w;
          }
        }
        const own = this.deeds.get(ev.target);
        if (own) {
          for (const d of own) {
            if (now - d.time > DEED_MEMORY || !this.hidden(sim, self, d.target)) continue;
            const w = 0.35 * g * Math.min(1, d.amount / 60);
            const k = this.evOf(d.target);
            if (d.kind === 'attack') {
              // rebels shoot the loyal side; loyalists shoot rebels
              if (rebel) k.pro += w;
              else if (loyal) k.anti += w;
            } else if (rebel) k.anti += 2 * w;
            else if (loyal) k.pro += 2 * w;
          }
          this.deeds.delete(ev.target);
        }
        return;
      }
      case 'claim': {
        if (!this.hidden(sim, self, ev.target)) return;
        const e = this.evOf(ev.target);
        if (ev.role === 'loyalist') e.pro += 0.35 * g;
        else if (ev.role === 'rebel') e.anti += 3 * g;
        else if (ev.role === 'traitor') e.trait += 3 * g;
        else if (ev.role === 'lord') e.anti += 0.4 * g;
        this.dirty = true;
        return;
      }
      case 'squadGrow':
        if (wearsCrown(sim, target)) this.crownTell.set(target.id, (this.crownTell.get(target.id) ?? 0) + ev.amount);
        return;
      default:
        return;
    }
  }

  /** Heroes that stay near a crown without shooting it look like escorts. */
  private proximityReads(sim: SimApi, self: Entity, obs: WorldObserver): void {
    const crowns = sim.heroes().filter((e) => e.hero && !e.hero.dead && wearsCrown(sim, e));
    if (crowns.length === 0) return;
    for (const e of sim.heroes()) {
      if (!this.hidden(sim, self, e.id)) continue;
      for (const c of crowns) {
        if (c === e) continue;
        const d = Math.hypot(c.pos.x - e.pos.x, c.pos.z - e.pos.z);
        if (d < 14 && obs.sinceAttack(sim, e.id, c.id) > 25) {
          this.evOf(e.id).pro += 0.06 * this.prof.evidenceGain;
          break;
        }
      }
    }
  }

  private recompute(sim: SimApi, self: Entity): void {
    const tk = tableKnowledge(sim, self);
    this.table = tk;
    const ids = tk.unknownIds;
    this.probs.clear();
    if (ids.length === 0) return;
    this.baseLoyal = tk.unknown.loyalist / ids.length;
    this.baseRebel = tk.unknown.rebel / ids.length;
    const roles = HIDDEN_ROLES.filter((r) => tk.unknown[r] > 1e-6);
    if (roles.length === 0) return;
    const m: number[][] = ids.map((id) => {
      const e = this.ev.get(id) ?? { pro: 0, anti: 0, trait: 0 };
      return roles.map((r) => Math.exp(clampScore(score(r, e))));
    });
    // Sinkhorn: columns sum to the expected role counts, rows to 1
    for (let it = 0; it < SINKHORN_ITERS; it++) {
      for (let c = 0; c < roles.length; c++) {
        let s = 0;
        for (let r = 0; r < ids.length; r++) s += m[r][c];
        const k = s > 1e-12 ? tk.unknown[roles[c]] / s : 0;
        for (let r = 0; r < ids.length; r++) m[r][c] *= k;
      }
      for (let r = 0; r < ids.length; r++) {
        let s = 0;
        for (let c = 0; c < roles.length; c++) s += m[r][c];
        const k = s > 1e-12 ? 1 / s : 0;
        for (let c = 0; c < roles.length; c++) m[r][c] *= k;
      }
    }
    for (let r = 0; r < ids.length; r++) {
      const p: RoleCounts = { loyalist: 0, rebel: 0, traitor: 0, opportunist: 0, bounty: 0 };
      for (let c = 0; c < roles.length; c++) p[roles[c]] = m[r][c];
      this.probs.set(ids[r], p);
    }
  }

  // ── queries ─────────────────────────────────────────────────────────────
  /** Probability that `e` has hidden role `role` (known roles give 0/1). */
  p(sim: SimApi, self: Entity, e: Entity, role: HiddenRole): number {
    const known = roleKnownTo(sim, self, e);
    if (known !== undefined) return known === role ? 1 : 0;
    const pr = this.probs.get(e.id);
    if (pr) return pr[role];
    // not yet computed: fall back to the table prior
    const tk = this.table;
    if (!tk || tk.unknownIds.length === 0) return 0;
    return tk.unknown[role] / tk.unknownIds.length;
  }

  /** 0..1: how lord-side `e` is from this viewer's seat (crowns = 1). */
  lordSideness(sim: SimApi, self: Entity, e: Entity): number {
    if (e === self) {
      const r = ownRole(self);
      return LORD_SIDE.has(r) ? 1 : r === 'traitor' ? 0.4 : r === 'rebel' ? 0 : 0.2;
    }
    const known = roleKnownTo(sim, self, e);
    if (known !== undefined) return LORD_SIDE.has(known) ? 1 : 0;
    return this.p(sim, self, e, 'loyalist');
  }

  /** 0..1: how rebel `e` is from this viewer's seat. */
  rebelness(sim: SimApi, self: Entity, e: Entity): number {
    if (e === self) {
      const r = ownRole(self);
      return r === 'rebel' ? 1 : r === 'traitor' ? 0.3 : 0;
    }
    const known = roleKnownTo(sim, self, e);
    if (known !== undefined) return known === 'rebel' ? 1 : 0;
    return this.p(sim, self, e, 'rebel');
  }

  /** Raw evidence (debug / tests). */
  evidence(id: EntityId): Readonly<Evidence> {
    return this.ev.get(id) ?? { pro: 0, anti: 0, trait: 0 };
  }

  /** Total evidence gathered about a hero (how much its own deeds say). */
  evidenceMagnitude(id: EntityId): number {
    const e = this.ev.get(id);
    return e ? e.pro + e.anti + e.trait : 0;
  }

  /** Squad-growth tell for a crown (higher = more likely the real lord). */
  crownLordTell(id: EntityId): number {
    return this.crownTell.get(id) ?? 0;
  }

  /** Force a recompute on the next update (tests). */
  invalidate(): void {
    this.dirty = true;
  }
}

function score(role: HiddenRole, e: Evidence): number {
  const p = e.pro;
  const a = e.anti;
  switch (role) {
    case 'loyalist':
      return p - 1.2 * a;
    case 'rebel':
      return a - 1.2 * p;
    case 'traitor':
      return 0.8 * Math.min(p, a) + e.trait - 0.25 * Math.abs(p - a);
    case 'opportunist':
      return -0.35 * (p + a);
    case 'bounty':
      return -0.3 * (p + a);
    default:
      return 0;
  }
}

const clampScore = (s: number): number => (s > SCORE_CLAMP ? SCORE_CLAMP : s < -SCORE_CLAMP ? -SCORE_CLAMP : s);
