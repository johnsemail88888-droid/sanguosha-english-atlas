// Public-event observer shared by all bots of one world. Humans learn who shot
// whom, who healed / revived whom, who went down, who died (with the revealed
// role) and who claimed what from hit markers, tracers, heal numbers, the kill
// feed and nameplates — all of it public GameEvents. The sim offers no event
// tap to brains (see docs/SIM_REQUESTS.md), so the observer reconstructs the
// same information once per tick from public state: the attack log
// (recentAttackers), HP deltas, heal/rescue counters, downed/dead flags and
// claims. Every bot then reads the shared log through its own cursor.
import type { Entity, EntityId, RoleId } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { publicRole } from './knowledge';

export type ObsKind = 'attack' | 'heal' | 'revive' | 'downed' | 'death' | 'claim' | 'squadGrow';

export interface ObsEvent {
  seq: number;
  time: number;
  kind: ObsKind;
  /** acting hero (attacker, healer, reviver, killer, claimant) */
  actor?: EntityId;
  /** affected hero */
  target: EntityId;
  /** damage / healing amount (hp), squad growth */
  amount: number;
  /** attack on a unit of the target's squad rather than the hero itself */
  viaSquad?: boolean;
  /** damage from a lingering field (hazard) only — someone may just have walked into it */
  field?: boolean;
  /** public role revealed on death, or the role claimed */
  role?: RoleId;
}

interface HeroMem {
  hp: number;
  downed: boolean;
  dead: boolean;
  claim: RoleId | null;
  healing: number;
  rescues: number;
  squad: number;
  squadMax: number;
}

const LOG_CAP = 4096;
const SQUAD_POLL_TICKS = 6;
const PAIR_DECAY = 4;

export class WorldObserver {
  private lastTick = -1;
  private lastTime = 0;
  private seq = 0;
  private readonly log: ObsEvent[] = [];
  private readonly mem = new Map<EntityId, HeroMem>();
  /** who attacked whom last (actor → target → time), for retaliation checks */
  private readonly lastAttack = new Map<EntityId, Map<EntityId, number>>();
  /** decaying damage sums per (actor, target) pair: key actor * 65536 + target */
  private readonly pairDmg = new Map<number, { v: number; n: number; t: number }>();

  /** Advance to the current tick (idempotent within a tick). */
  update(sim: SimApi): void {
    if (sim.tick === this.lastTick) return;
    const first = this.lastTick < 0;
    const window = first ? 0.05 : Math.max(1e-3, sim.time - this.lastTime) + 1e-6;
    this.lastTick = sim.tick;
    this.lastTime = sim.time;
    const x = ext(sim);
    const heroes = sim.heroes();
    const healers: { e: Entity; amount: number }[] = [];
    const healed: { e: Entity; amount: number }[] = [];
    const rescuers: Entity[] = [];
    for (const e of heroes) {
      const h = e.hero;
      if (!h) continue;
      let m = this.mem.get(e.id);
      if (!m) {
        m = { hp: e.hp, downed: h.downed, dead: h.dead, claim: h.claim, healing: h.stats.healing, rescues: h.stats.rescues, squad: h.squad.length, squadMax: h.squad.length };
        this.mem.set(e.id, m);
        if (first) continue;
      }
      // attacks on this hero during the last tick (credited to heroes)
      if (!h.dead || !m.dead) {
        const attackers = x.recentAttackers(e.id, window);
        const drop = Math.max(0, m.hp - e.hp);
        // group the attack-log ids by credited hero; the other ids are the sources used
        // (the log holds the credited hero AND the source entity of every hit)
        const heroAttackers: EntityId[] = [];
        const via = new Map<EntityId, number>(); // bit 1 direct/projectile, 2 squad, 4 field
        for (const a of attackers) {
          const c = x.creditOf(a);
          if (c === undefined || c === e.id) continue;
          const ce = sim.get(c);
          if (!ce?.hero) continue;
          if (!heroAttackers.includes(c)) heroAttackers.push(c);
          if (a === c) continue;
          const k = sim.get(a)?.kind;
          const bit = k === 'hazard' ? 4 : k === 'troop' || k === 'npc' || k === 'turret' ? 2 : 1;
          via.set(c, (via.get(c) ?? 0) | bit);
        }
        const share = heroAttackers.length > 0 ? drop / heroAttackers.length : 0;
        for (const a of heroAttackers) {
          const bits = via.get(a) ?? 1;
          const direct = (bits & 1) !== 0 || bits === 0;
          this.push(sim, 'attack', a, e.id, Math.max(4, share), undefined, !direct && (bits & 2) !== 0, !direct && (bits & 2) === 0 && (bits & 4) !== 0);
        }
      }
      if (h.stats.healing > m.healing + 0.01) healers.push({ e, amount: h.stats.healing - m.healing });
      if (e.hp > m.hp + 0.01 && !h.dead && !(m.downed && !h.downed)) healed.push({ e, amount: e.hp - m.hp });
      if (h.stats.rescues > m.rescues) rescuers.push(e);
      // downed / revived / died
      if (h.downed && !m.downed && !h.dead) {
        const by = x.recentAttackers(e.id, window + 0.5).map((a) => x.creditOf(a)).find((c) => c !== undefined && c !== e.id && !!sim.get(c)?.hero);
        this.push(sim, 'downed', by, e.id, 0);
      }
      if (!h.downed && m.downed && !h.dead) {
        const by = rescuers.length > 0 ? rescuers[0] : heroes.find((o) => o !== e && o.hero && o.hero.stats.rescues > (this.mem.get(o.id)?.rescues ?? o.hero.stats.rescues));
        this.push(sim, 'revive', by?.id, e.id, e.hp);
      }
      if (h.dead && !m.dead) {
        this.push(sim, 'death', h.killerId, e.id, 0, publicRole(sim, e));
      }
      if (h.claim && h.claim !== m.claim) this.push(sim, 'claim', e.id, e.id, 0, h.claim);
      m.hp = e.hp;
      m.downed = h.downed;
      m.dead = h.dead;
      m.claim = h.claim;
    }
    // heal attribution: a healer whose counter rose healed the heroes whose HP rose (not himself)
    for (const hl of healers) {
      let rest = hl.amount;
      const selfGain = healed.find((x2) => x2.e === hl.e)?.amount ?? 0;
      rest -= Math.min(rest, selfGain);
      if (rest < 1) continue;
      for (const t of healed) {
        if (t.e === hl.e) continue;
        this.push(sim, 'heal', hl.e.id, t.e.id, Math.min(rest, t.amount));
      }
    }
    // counters after attribution
    for (const e of heroes) {
      const m = this.mem.get(e.id);
      if (!m || !e.hero) continue;
      m.healing = e.hero.stats.healing;
      m.rescues = e.hero.stats.rescues;
    }
    // squads: attacks on soldiers, and squads growing (summons — the 主公's lord skill is one tell)
    if (sim.tick % SQUAD_POLL_TICKS === 0 && !first) this.pollSquads(sim);
  }

  private pollSquads(sim: SimApi): void {
    const x = ext(sim);
    const win = SQUAD_POLL_TICKS / 30 + 1e-6;
    for (const e of sim.heroes()) {
      const h = e.hero;
      if (!h || h.dead) continue;
      const m = this.mem.get(e.id);
      if (!m) continue;
      const seen = new Set<EntityId>();
      for (const tid of h.squad) {
        for (const a of x.recentAttackers(tid, win)) {
          const c = x.creditOf(a);
          if (c === undefined || c === e.id || seen.has(c) || !sim.get(c)?.hero) continue;
          seen.add(c);
          this.push(sim, 'attack', c, e.id, 6, undefined, true);
        }
      }
      const n = h.squad.length;
      if (n > m.squadMax) {
        this.push(sim, 'squadGrow', e.id, e.id, n - m.squadMax);
        m.squadMax = n;
      }
      m.squad = n;
    }
  }

  private push(sim: SimApi, kind: ObsKind, actor: EntityId | undefined, target: EntityId, amount: number, role?: RoleId, viaSquad?: boolean, field?: boolean): void {
    const ev: ObsEvent = { seq: ++this.seq, time: sim.time, kind, actor, target, amount, role, viaSquad, field };
    this.log.push(ev);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    if (kind === 'attack' && actor !== undefined && !field) {
      // squad fire counts half (soldiers pick fights through the world's hostility rules)
      if (viaSquad) amount *= 0.5;
      let m = this.lastAttack.get(actor);
      if (!m) {
        m = new Map();
        this.lastAttack.set(actor, m);
      }
      m.set(target, sim.time);
      const key = actor * 65536 + target;
      const p = this.pairDmg.get(key);
      if (p) {
        const k = Math.exp(-(sim.time - p.t) / PAIR_DECAY);
        p.v = p.v * k + amount;
        p.n = p.n * k + 1;
        p.t = sim.time;
      } else {
        this.pairDmg.set(key, { v: amount, n: 1, t: sim.time });
      }
    }
  }

  /** Recent number of separate hits (ticks with damage) `actor` landed on `target` (decaying like recentDamage). */
  recentHits(sim: SimApi, actor: EntityId, target: EntityId): number {
    const p = this.pairDmg.get(actor * 65536 + target);
    return p ? p.n * Math.exp(-(sim.time - p.t) / PAIR_DECAY) : 0;
  }

  /** Recent damage `actor` dealt to `target` (decaying, ~4 s memory). Public knowledge. */
  recentDamage(sim: SimApi, actor: EntityId, target: EntityId): number {
    const p = this.pairDmg.get(actor * 65536 + target);
    return p ? p.v * Math.exp(-(sim.time - p.t) / PAIR_DECAY) : 0;
  }

  /** Events with seq > `after` (oldest first). */
  since(after: number): ObsEvent[] {
    const log = this.log;
    if (log.length === 0 || log[log.length - 1].seq <= after) return [];
    // binary search the first event with seq > after
    let lo = 0;
    let hi = log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (log[mid].seq <= after) lo = mid + 1;
      else hi = mid;
    }
    return log.slice(lo);
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Seconds since `actor` last hurt `target` (Infinity if never). Public knowledge. */
  sinceAttack(sim: SimApi, actor: EntityId, target: EntityId): number {
    const t = this.lastAttack.get(actor)?.get(target);
    return t === undefined ? Infinity : sim.time - t;
  }
}

const observers = new WeakMap<SimApi, WorldObserver>();

/** The shared observer of a world (created on first use). */
export function observerFor(sim: SimApi): WorldObserver {
  let o = observers.get(sim);
  if (!o) {
    o = new WorldObserver();
    observers.set(sim, o);
  }
  return o;
}
