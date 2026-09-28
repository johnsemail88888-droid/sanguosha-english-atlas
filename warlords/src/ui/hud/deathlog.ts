// Downed / death bookkeeping for the HUD (pure logic, no DOM; unit-tested in tests/unit/ui):
//  - DamageLog: the hits you took, for the death recap (who, with what, how much, the last ~10 s)
//  - HelpCalls: who called 「需要桃！」 lately (F while downed) — they may be shown on your
//    minimap / in the world: a call for help gives your position away, on purpose
//  - downedMarkers: which downed heroes get a revive marker for you (hidden roles stay hidden:
//    only heroes you know are with you, or who called for help) — and which get a 补刀 marker
//    instead (the ones you knocked down yourself: never invite a revive of your own victim)
import type { DamageType, EntityId, ViewEntity } from '../../core/types';
import { VF_DEAD, VF_DOWNED, VF_REVIVING } from '../../core/types';
import type { KillCause } from './killcause';

/** Seconds of damage the death recap sums up (before the knock, when you bled out). */
export const RECAP_WINDOW = 10;
/** Seconds of hits the log keeps (a bleed-out lasts up to 30 s: the knock must still be there). */
export const RECAP_KEEP = 45;
/** Seconds a 「需要桃！」 call keeps the caller marked for everyone (a first knock bleeds out in 30 s). */
export const HELP_MARK_TIME = 30;
/** Revive markers only for downed heroes this close (m). */
export const MARKER_RANGE = 120;

export interface TakenHit {
  /** HUD clock (performance.now() s) */
  at: number;
  /** credited attacker (a hero for his troops' / turrets' shots); undefined: the zone, a fall… */
  src?: EntityId;
  amount: number;
  head: boolean;
  dtype: DamageType;
  cause: KillCause | null;
}

export interface RecapRow {
  /** null: no attacker (the zone, a fall) */
  src: EntityId | null;
  zone: boolean;
  total: number;
  hits: number;
  heads: number;
  /** distinct causes, most damage first */
  causes: KillCause[];
}

export interface DeathRecap {
  /** who got the kill (null: the zone / nobody) */
  killer: EntityId | null;
  /** who knocked you down first (may differ from the killer: someone else finished you) */
  downedBy: EntityId | null;
  /** the killing blow's weapon / ability / card */
  cause: KillCause | null;
  rows: RecapRow[];
  total: number;
  /** seconds the rows cover */
  window: number;
  /** HUD time of your last hit taken (null: none recorded) — a knock long before death is a bleed-out */
  lastHitAt: number | null;
}

const sameCause = (a: KillCause, b: KillCause): boolean => a.kind === b.kind && a.id === b.id;

export class DamageLog {
  private hits: TakenHit[] = [];

  constructor(
    readonly window = RECAP_WINDOW,
    readonly keep = Math.max(RECAP_KEEP, window),
  ) {}

  add(hit: TakenHit): void {
    if (!(hit.amount > 0)) return;
    this.hits.push(hit);
    // bounded: nothing older than the keep horizon matters (a long fight under the zone adds a hit per second)
    if (this.hits.length > 256) this.prune(hit.at);
  }

  clear(): void {
    this.hits = [];
  }

  /**
   * The hits from `from` (default: the last `window` seconds) up to `now`, grouped by attacker,
   * most damage first.
   */
  rows(now: number, from = now - this.window): RecapRow[] {
    this.prune(now);
    const by = new Map<string, RecapRow & { perCause: { c: KillCause; dmg: number }[] }>();
    for (const h of this.hits) {
      if (h.at > now || h.at < from) continue;
      const zone = h.src === undefined && h.dtype === 'zone';
      const key = h.src !== undefined ? `e${h.src}` : zone ? 'zone' : 'none';
      let row = by.get(key);
      if (!row) {
        row = { src: h.src ?? null, zone, total: 0, hits: 0, heads: 0, causes: [], perCause: [] };
        by.set(key, row);
      }
      row.total += h.amount;
      row.hits++;
      if (h.head) row.heads++;
      if (h.cause) {
        const pc = row.perCause.find((p) => sameCause(p.c, h.cause!));
        if (pc) pc.dmg += h.amount;
        else row.perCause.push({ c: h.cause, dmg: h.amount });
      }
    }
    const out: RecapRow[] = [];
    for (const r of by.values()) {
      r.perCause.sort((a, b) => b.dmg - a.dmg);
      out.push({ src: r.src, zone: r.zone, total: Math.round(r.total), hits: r.hits, heads: r.heads, causes: r.perCause.map((p) => p.c) });
    }
    return out.sort((a, b) => b.total - a.total);
  }

  /**
   * The death recap at `now`. `downedAt`: when you were knocked (this life) — the recap then reaches
   * back to `window` s before the knock, so a bleed-out still shows who put you down.
   */
  recap(now: number, killer: EntityId | undefined, downedBy: EntityId | undefined, cause: KillCause | null, downedAt?: number): DeathRecap {
    const from = downedAt !== undefined && downedAt <= now ? Math.min(now - this.window, downedAt - this.window) : now - this.window;
    const rows = this.rows(now, from);
    let total = 0;
    for (const r of rows) total += r.total;
    let lastHitAt: number | null = null;
    for (const h of this.hits) if (h.at <= now && h.at >= from && (lastHitAt === null || h.at > lastHitAt)) lastHitAt = h.at;
    return { killer: killer ?? null, downedBy: downedBy ?? null, cause, rows, total, window: Math.round(now - from), lastHitAt };
  }

  private prune(now: number): void {
    const from = now - this.keep;
    let i = 0;
    while (i < this.hits.length && this.hits[i].at < from) i++;
    if (i > 0) this.hits.splice(0, i);
  }
}

/** Who called for a 桃 lately (quickchat 'needPeach'). */
export class HelpCalls {
  private readonly at = new Map<EntityId, number>();

  note(who: EntityId, now: number): void {
    this.at.set(who, now);
  }

  /** `who` called within HELP_MARK_TIME s. */
  active(who: EntityId, now: number): boolean {
    const t = this.at.get(who);
    return t !== undefined && now - t <= HELP_MARK_TIME && now >= t;
  }

  /** seconds since `who` last called (Infinity: never) */
  since(who: EntityId, now: number): number {
    const t = this.at.get(who);
    return t === undefined ? Infinity : now - t;
  }

  forget(who: EntityId): void {
    this.at.delete(who);
  }

  clear(): void {
    this.at.clear();
  }
}

export interface DownedMarker {
  id: EntityId;
  x: number;
  y: number;
  z: number;
  dist: number;
  /** someone is reviving him right now (VF_REVIVING) */
  reviving: boolean;
  /** a known ally (影武者 ↔ 主公, the Lord for his side) */
  ally: boolean;
  /** called for help lately */
  called: boolean;
  /** you knocked him down yourself (or your troops did): a 补刀 marker, never 救 */
  finish: boolean;
}

/**
 * Downed heroes that get a marker for the viewer at `from`, nearest first, within `range`:
 *  - 救: a known ally, or anyone who called 「需要桃！」 within HELP_MARK_TIME s (the call is public);
 *  - 补刀 (`finish`): one you knocked down yourself (`knocked`, unless a known ally) — his call for
 *    help must not invite you to revive your own victim.
 * Never yourself; the dead and the standing never.
 */
export function downedMarkers(
  selfId: EntityId | null,
  from: { x: number; z: number } | undefined,
  ents: readonly ViewEntity[],
  allies: ReadonlySet<EntityId>,
  calls: HelpCalls,
  now: number,
  range = MARKER_RANGE,
  knocked: ReadonlySet<EntityId> = NONE,
): DownedMarker[] {
  if (!from) return [];
  const out: DownedMarker[] = [];
  for (const e of ents) {
    if (e.kind !== 'hero' || e.id === selfId || !(e.flags & VF_DOWNED) || e.flags & VF_DEAD) continue;
    const ally = allies.has(e.id);
    const called = calls.active(e.id, now);
    const finish = !ally && knocked.has(e.id);
    if (!ally && !called && !finish) continue;
    const dist = Math.hypot(e.x - from.x, e.z - from.z);
    if (dist > range) continue;
    out.push({ id: e.id, x: e.x, y: e.y, z: e.z, dist, reviving: (e.flags & VF_REVIVING) !== 0, ally, called, finish });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

const NONE: ReadonlySet<EntityId> = new Set();

/** The death headline's case: bled out after a knock (the last hit landed well before death). */
export function bledOut(recap: Pick<DeathRecap, 'downedBy' | 'lastHitAt'>, downedAt: number | undefined, now: number): boolean {
  if (downedAt === undefined) return false;
  const last = recap.lastHitAt ?? downedAt;
  return now - last > 0.5;
}

/**
 * The heroes a viewer knows are on his side, from public information only: his knownAllies
 * (主公 ↔ 影武者), and the Lord (and a crown bearer) for a loyalist / 影武者. Nobody else's role is public.
 */
export function knownFriends(myRole: string | undefined, knownAllies: readonly EntityId[] | undefined, ents: readonly ViewEntity[]): Set<EntityId> {
  const s = new Set<EntityId>(knownAllies ?? []);
  if (myRole === 'loyalist' || myRole === 'double') {
    for (const e of ents) if (e.kind === 'hero' && e.role === 'lord') s.add(e.id);
  }
  return s;
}

/** "11.4" style bleed-out seconds (one decimal under 10 s, whole seconds above). */
export function bleedText(sec: number): string {
  const s = Math.max(0, sec);
  return s < 10 ? s.toFixed(1) : String(Math.ceil(s));
}
