// Public-event observer shared by all bots of one world. It turns the world's
// public event feed (SimExt.publicEventsSince — only events WITHOUT privateTo)
// into a compact log of hero-level observations: who hit whom (directly, with
// troops / summons, or with a lingering field), who healed / revived whom, who
// went down, who died (with the revealed role), claims, quick-chat and lord
// skill casts. It knows nothing about any particular seat: each bot reads the
// log through its own Witness (witness.ts), which keeps only what that seat
// actually perceived (its own fights, heroes it saw act, the kill feed, chat).
// Worlds without the event tap fall back to reconstructing the same log by
// polling public state (attack log, HP deltas, heal / rescue counters).
import type { Vec3 } from '../../core/math';
import type { Entity, EntityId, GameEvent, RoleId } from '../../core/types';
import { ABILITY_BY_ID } from '../../data';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { publicRole } from './knowledge';

export type ObsKind = 'attack' | 'heal' | 'revive' | 'downed' | 'death' | 'claim' | 'quickchat' | 'lordSkill';

export interface ObsEvent {
  seq: number;
  time: number;
  kind: ObsKind;
  /** acting hero (attacker, healer, reviver, killer, claimant, chatter, caster) */
  actor?: EntityId;
  /** affected hero (the commander when a soldier / summon was hit) */
  target: EntityId;
  /** damage / healing amount (hp); 0 for a blocked hit */
  amount: number;
  /** a troop / turret / summon was involved on either side (not hero on hero) */
  viaSquad?: boolean;
  /** damage from a lingering field (hazard) only — someone may just have walked into it */
  field?: boolean;
  /** the hit was dodged / nullified / made invulnerable / handed on: intent without effect */
  blocked?: boolean;
  /** public role revealed on death, or the role claimed */
  role?: RoleId;
  /** quick-chat line id */
  chat?: string;
  /** where it happened (hit point / cast point), when known */
  pos?: Vec3;
  /** known to everyone at once (kill feed, chat, claims): no line of sight needed */
  public?: boolean;
}

interface HeroMem {
  hp: number;
  downed: boolean;
  dead: boolean;
  claim: RoleId | null;
  healing: number;
  rescues: number;
}

const LOG_CAP = 4096;
const SQUAD_POLL_TICKS = 6;
/** seconds of the world's attack log used to tell how a hit was dealt (weapon / squad / field) */
const VIA_WINDOW = 0.12;

/**
 * A hit `actor` was forced into by a charm (离间 / 反间) on that very unit: not the hero's
 * intent, so no evidence about its side (the charm itself is public).
 */
function forcedHit(sim: SimApi, actor: Entity, unitId: EntityId): boolean {
  const now = sim.time;
  for (const s of actor.statuses) if (s.id === 'charm' && s.until > now && s.params?.targetId === unitId) return true;
  return false;
}

export class WorldObserver {
  private lastTick = -1;
  private lastTime = 0;
  private seq = 0;
  private feedSeq = 0;
  private readonly log: ObsEvent[] = [];
  private readonly mem = new Map<EntityId, HeroMem>();

  /** Advance to the current tick (idempotent within a tick). */
  update(sim: SimApi): void {
    if (sim.tick === this.lastTick) return;
    const first = this.lastTick < 0;
    const window = first ? 0.05 : Math.max(1e-3, sim.time - this.lastTime) + 1e-6;
    this.lastTick = sim.tick;
    this.lastTime = sim.time;
    const x = ext(sim);
    if (typeof x.publicEventsSince === 'function') this.readFeed(sim);
    else this.poll(sim, first, window);
  }

  // ── event feed (AI-1) ─────────────────────────────────────────────────────
  private readFeed(sim: SimApi): void {
    const x = ext(sim);
    const { seq, events } = x.publicEventsSince(this.feedSeq);
    this.feedSeq = seq;
    for (const ev of events) {
      if (ev.privateTo !== undefined) continue; // never hidden information
      this.convert(sim, ev);
    }
  }

  private convert(sim: SimApi, ev: GameEvent): void {
    const x = ext(sim);
    switch (ev.t) {
      case 'hit': {
        if (ev.src === undefined) return;
        const actor = sim.get(ev.src);
        if (!actor?.hero) return;
        const unit = sim.get(ev.target);
        if (!unit || forcedHit(sim, actor, unit.id)) return;
        let target: Entity | undefined = unit;
        let viaSquad = false;
        if (!unit.hero) {
          target = x.commanderOf(unit);
          if (!target?.hero || target === unit) return; // camps / wild NPCs: no role information
          viaSquad = true;
        }
        if (target.id === actor.id) return;
        // how the credited hero dealt it: look at the source entities it used on this victim
        let bits = 0;
        for (const a of x.recentAttackers(unit.id, VIA_WINDOW)) {
          if (a === actor.id || x.creditOf(a) !== actor.id) continue;
          const k = sim.get(a)?.kind;
          bits |= k === 'hazard' ? 4 : k === 'troop' || k === 'npc' || k === 'turret' ? 2 : 1;
        }
        const direct = bits === 0 || (bits & 1) !== 0;
        if (!direct && (bits & 2) !== 0) viaSquad = true;
        const field = !direct && (bits & 2) === 0 && (bits & 4) !== 0;
        const blocked = ev.blocked !== undefined && ev.blocked !== 'shield' && ev.blocked !== 'armor';
        this.push(sim, { kind: 'attack', actor: actor.id, target: target.id, amount: blocked ? 0 : Math.max(0, ev.amount), viaSquad, field, blocked, pos: ev.pos });
        return;
      }
      case 'heal': {
        if (ev.src === undefined || ev.src === ev.target || ev.amount < 1) return;
        const healer = sim.get(ev.src);
        const t = sim.get(ev.target);
        if (!healer?.hero || !t?.hero) return;
        this.push(sim, { kind: 'heal', actor: healer.id, target: t.id, amount: ev.amount });
        return;
      }
      case 'revived': {
        const t = sim.get(ev.target);
        if (!t?.hero) return;
        const by = ev.by !== undefined && ev.by !== ev.target && sim.get(ev.by)?.hero ? ev.by : undefined;
        this.push(sim, { kind: 'revive', actor: by, target: t.id, amount: t.hp });
        return;
      }
      case 'downed': {
        const t = sim.get(ev.target);
        if (!t?.hero) return;
        const by = ev.src !== undefined && ev.src !== ev.target && sim.get(ev.src)?.hero ? ev.src : undefined;
        this.push(sim, { kind: 'downed', actor: by, target: t.id, amount: 0 });
        return;
      }
      case 'death': {
        if (ev.kind !== 'hero') return;
        const t = sim.get(ev.target);
        this.push(sim, { kind: 'death', actor: ev.killer, target: ev.target, amount: 0, role: ev.role ?? (t ? publicRole(sim, t) : undefined), public: true });
        return;
      }
      case 'claim':
        this.push(sim, { kind: 'claim', actor: ev.who, target: ev.who, amount: 0, role: ev.role, public: true });
        return;
      case 'quickchat':
        this.push(sim, { kind: 'quickchat', actor: ev.who, target: ev.who, amount: 0, chat: ev.id, public: true });
        return;
      case 'ability': {
        // lord skills (active or passive procs): only the real 主公 has them — the 影武者 has none
        if (ABILITY_BY_ID[ev.ability]?.slot !== 'lord') return;
        if (!sim.get(ev.src)?.hero) return;
        this.push(sim, { kind: 'lordSkill', actor: ev.src, target: ev.src, amount: 0, pos: ev.pos });
        return;
      }
      default:
        return;
    }
  }

  // ── polling fallback (worlds without the event tap) ────────────────────────
  private poll(sim: SimApi, first: boolean, window: number): void {
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
        m = { hp: e.hp, downed: h.downed, dead: h.dead, claim: h.claim, healing: h.stats.healing, rescues: h.stats.rescues };
        this.mem.set(e.id, m);
        if (first) continue;
      }
      if (!h.dead || !m.dead) {
        const drop = Math.max(0, m.hp - e.hp);
        const heroAttackers: EntityId[] = [];
        const via = new Map<EntityId, number>();
        for (const a of x.recentAttackers(e.id, window)) {
          const c = x.creditOf(a);
          const ch = c !== undefined ? sim.get(c) : undefined;
          if (c === undefined || c === e.id || !ch?.hero || forcedHit(sim, ch, e.id)) continue;
          if (!heroAttackers.includes(c)) heroAttackers.push(c);
          if (a === c) continue;
          const k = sim.get(a)?.kind;
          via.set(c, (via.get(c) ?? 0) | (k === 'hazard' ? 4 : k === 'troop' || k === 'npc' || k === 'turret' ? 2 : 1));
        }
        const share = heroAttackers.length > 0 ? drop / heroAttackers.length : 0;
        for (const a of heroAttackers) {
          const bits = via.get(a) ?? 1;
          const direct = (bits & 1) !== 0;
          this.push(sim, { kind: 'attack', actor: a, target: e.id, amount: share, blocked: share <= 0, viaSquad: !direct && (bits & 2) !== 0, field: !direct && (bits & 2) === 0 && (bits & 4) !== 0 });
        }
      }
      if (h.stats.healing > m.healing + 0.01) healers.push({ e, amount: h.stats.healing - m.healing });
      if (e.hp > m.hp + 0.01 && !h.dead && !(m.downed && !h.downed)) healed.push({ e, amount: e.hp - m.hp });
      if (h.stats.rescues > m.rescues) rescuers.push(e);
      if (h.downed && !m.downed && !h.dead) {
        const by = x.recentAttackers(e.id, window + 0.5).map((a) => x.creditOf(a)).find((c) => c !== undefined && c !== e.id && !!sim.get(c)?.hero);
        this.push(sim, { kind: 'downed', actor: by, target: e.id, amount: 0 });
      }
      if (!h.downed && m.downed && !h.dead) {
        const by = rescuers.length > 0 ? rescuers[0] : heroes.find((o) => o !== e && o.hero && o.hero.stats.rescues > (this.mem.get(o.id)?.rescues ?? o.hero.stats.rescues));
        this.push(sim, { kind: 'revive', actor: by?.id, target: e.id, amount: e.hp });
      }
      if (h.dead && !m.dead) this.push(sim, { kind: 'death', actor: h.killerId, target: e.id, amount: 0, role: publicRole(sim, e), public: true });
      if (h.claim && h.claim !== m.claim) this.push(sim, { kind: 'claim', actor: e.id, target: e.id, amount: 0, role: h.claim, public: true });
      m.hp = e.hp;
      m.downed = h.downed;
      m.dead = h.dead;
      m.claim = h.claim;
    }
    // heal attribution: only when exactly one healer's counter rose (ambiguous ticks are dropped)
    if (healers.length === 1) {
      const hl = healers[0];
      let rest = hl.amount - Math.min(hl.amount, healed.find((h2) => h2.e === hl.e)?.amount ?? 0);
      for (const t of healed) {
        if (t.e === hl.e || rest < 1) continue;
        const amt = Math.min(rest, t.amount);
        rest -= amt;
        this.push(sim, { kind: 'heal', actor: hl.e.id, target: t.e.id, amount: amt });
      }
    }
    for (const e of heroes) {
      const m = this.mem.get(e.id);
      if (!m || !e.hero) continue;
      m.healing = e.hero.stats.healing;
      m.rescues = e.hero.stats.rescues;
    }
    if (sim.tick % SQUAD_POLL_TICKS === 0 && !first) this.pollSquads(sim);
  }

  private pollSquads(sim: SimApi): void {
    const x = ext(sim);
    const win = SQUAD_POLL_TICKS / 30 + 1e-6;
    for (const e of sim.heroes()) {
      const h = e.hero;
      if (!h || h.dead) continue;
      const seen = new Set<EntityId>();
      for (const tid of h.squad) {
        for (const a of x.recentAttackers(tid, win)) {
          const c = x.creditOf(a);
          if (c === undefined || c === e.id || seen.has(c) || !sim.get(c)?.hero) continue;
          seen.add(c);
          this.push(sim, { kind: 'attack', actor: c, target: e.id, amount: 6, viaSquad: true });
        }
      }
    }
  }

  private push(sim: SimApi, ev: Omit<ObsEvent, 'seq' | 'time'>): void {
    const full = ev as ObsEvent;
    full.seq = ++this.seq;
    full.time = sim.time;
    this.log.push(full);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  /** Events with seq > `after` (oldest first). */
  since(after: number): ObsEvent[] {
    const log = this.log;
    if (log.length === 0 || log[log.length - 1].seq <= after) return [];
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
