// Voice pooling + per-type throttling. Pure bookkeeping (no WebAudio types) so
// the policy is unit-testable in Node; the SFX engine supplies `kill` callbacks.
//
// Policy:
//  - at most `maxVoices` concurrent voices; when full, the lowest-priority
//    (then oldest) voice is stolen, unless every voice outranks the newcomer;
//  - per throttle group: a minimum gap between starts and a concurrency cap
//    (the oldest voice of the group is replaced when the cap is reached);
//  - "concurrent" means sounding at the newcomer's start time: voices that are
//    scheduled to start later (reload scripts, staggered shots, heartbeats)
//    or have already ended by then do not count, and a voice that has not
//    started yet is never stolen (it would be silenced before it plays);
//  - stacked voices of one group get a 1/sqrt(n) gain compensation so eight
//    simultaneous shotguns do not sum into clipping.

export interface VoiceRecord {
  id: number;
  group: string;
  priority: number;
  start: number;
  /** scheduled end (ctx seconds); Infinity for loops until stopped */
  end: number;
  /** fade out and stop at `at` (ctx seconds). Must be idempotent. */
  kill(at: number): void;
  /** release graph resources once ended (disconnect). Must be idempotent. */
  dispose(): void;
}

export interface ThrottleRule {
  /** minimum seconds between two starts of this group */
  minGap: number;
  /** max concurrent voices of this group */
  maxConcurrent: number;
}

export interface Admission {
  ok: boolean;
  /** voices that must be killed to make room */
  steal: VoiceRecord[];
  /** gain compensation for stacking within the group (0..1] */
  gainComp: number;
}

export const DEFAULT_RULE: ThrottleRule = { minGap: 0.02, maxConcurrent: 4 };

/** a voice starting later than `now + START_SLACK` counts as scheduled, not sounding */
export const START_SLACK = 0.03;

export class VoicePool {
  private voices: VoiceRecord[] = [];
  private graveyard: { rec: VoiceRecord; at: number }[] = [];
  private lastStart = new Map<string, number>();
  private nextId = 1;

  constructor(
    private maxVoices: number,
    private readonly rules: Readonly<Record<string, ThrottleRule>>,
    private readonly fallback: ThrottleRule = DEFAULT_RULE,
  ) {}

  get size(): number {
    return this.voices.length;
  }

  get capacity(): number {
    return this.maxVoices;
  }

  setCapacity(n: number): void {
    this.maxVoices = Math.max(1, Math.floor(n));
  }

  allocId(): number {
    return this.nextId++;
  }

  rule(group: string): ThrottleRule {
    return this.rules[group] ?? this.fallback;
  }

  /** voices audible at `now` (started and not yet ended); scheduled ones excluded */
  sounding(now: number): number {
    let n = 0;
    for (const v of this.voices) if (v.start <= now + START_SLACK && v.end > now) n++;
    return n;
  }

  countGroup(group: string): number {
    let n = 0;
    for (const v of this.voices) if (v.group === group) n++;
    return n;
  }

  /**
   * Decide whether a voice of `group` may start at `start` (ctx seconds).
   * Stolen voices should be stopped at `start` (they are all already sounding).
   */
  admit(group: string, priority: number, start: number, now: number): Admission {
    this.sweep(now);
    const reject: Admission = { ok: false, steal: [], gainComp: 1 };
    const rule = this.rule(group);
    const last = this.lastStart.get(group);
    if (last !== undefined && Math.abs(start - last) < rule.minGap) return reject;
    const at = Math.max(start, now);
    const horizon = at + START_SLACK;
    const startedBy = now + START_SLACK;
    // voices sounding when the newcomer starts; only already-started ones may be stolen
    let live = 0;
    let sameLive = 0;
    let oldest: VoiceRecord | null = null;
    for (const v of this.voices) {
      if (v.start > horizon || v.end <= at) continue;
      live++;
      if (v.group !== group) continue;
      sameLive++;
      if (v.start <= startedBy && (!oldest || v.start < oldest.start)) oldest = v;
    }
    const steal: VoiceRecord[] = [];
    if (sameLive >= rule.maxConcurrent) {
      // replace the oldest sounding voice of the same group if we are not outranked
      if (!oldest || oldest.priority > priority) return reject;
      steal.push(oldest);
    }
    if (live - steal.length >= this.maxVoices) {
      let victim: VoiceRecord | null = null;
      for (const v of this.voices) {
        if (v.start > startedBy || v.end <= at || steal.includes(v)) continue;
        if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.start < victim.start)) victim = v;
      }
      if (!victim || victim.priority > priority) return reject;
      steal.push(victim);
    }
    // hard ceiling on sounding + scheduled voices (bounds live graph nodes)
    if (this.voices.length - steal.length >= this.maxVoices * 2) return reject;
    const stacked = sameLive - steal.filter((v) => v.group === group).length;
    return { ok: true, steal, gainComp: 1 / Math.sqrt(1 + 0.45 * Math.max(0, stacked)) };
  }

  /** Register a started voice (after a successful admit). */
  add(rec: VoiceRecord): void {
    this.voices.push(rec);
    const prev = this.lastStart.get(rec.group);
    if (prev === undefined || rec.start > prev) this.lastStart.set(rec.group, rec.start);
  }

  /** Kill + forget a voice (disposed by a later sweep once its fade finished). */
  stop(rec: VoiceRecord, at: number): void {
    rec.kill(at);
    const i = this.voices.indexOf(rec);
    if (i >= 0) this.voices.splice(i, 1);
    this.graveyard.push({ rec, at: at + 0.25 });
  }

  /** Drop finished voices (and dispose them). */
  sweep(now: number): void {
    if (this.voices.length) {
      const keep: VoiceRecord[] = [];
      for (const v of this.voices) {
        if (v.end + 0.05 < now) v.dispose();
        else keep.push(v);
      }
      this.voices = keep;
    }
    if (this.graveyard.length) {
      const rest: { rec: VoiceRecord; at: number }[] = [];
      for (const g of this.graveyard) {
        if (g.at < now) g.rec.dispose();
        else rest.push(g);
      }
      this.graveyard = rest;
    }
  }

  /** Kill (fade out) every voice. */
  stopAll(now: number): void {
    for (const v of [...this.voices]) this.stop(v, now);
  }

  /** Dispose everything immediately (context closing). */
  clear(): void {
    for (const v of this.voices) v.dispose();
    for (const g of this.graveyard) g.rec.dispose();
    this.voices = [];
    this.graveyard = [];
    this.lastStart.clear();
  }

  list(): readonly VoiceRecord[] {
    return this.voices;
  }
}

/** Throttle groups used by the SFX catalog. */
export const THROTTLE_RULES: Record<string, ThrottleRule> = {
  'gun:local': { minGap: 0.018, maxConcurrent: 6 },
  'gun:pistol': { minGap: 0.012, maxConcurrent: 5 },
  'gun:smg': { minGap: 0.012, maxConcurrent: 6 },
  'gun:rifle': { minGap: 0.012, maxConcurrent: 6 },
  'gun:lmg': { minGap: 0.015, maxConcurrent: 5 },
  'gun:dmr': { minGap: 0.02, maxConcurrent: 4 },
  'gun:sniper': { minGap: 0.03, maxConcurrent: 3 },
  'gun:shotgun': { minGap: 0.045, maxConcurrent: 3 },
  'gun:launcher': { minGap: 0.05, maxConcurrent: 3 },
  'gun:bow': { minGap: 0.03, maxConcurrent: 3 },
  'gun:crossbow': { minGap: 0.03, maxConcurrent: 3 },
  'gun:melee': { minGap: 0.04, maxConcurrent: 3 },
  'gun:tesla': { minGap: 0.04, maxConcurrent: 3 },
  'gun:flamer': { minGap: 0.05, maxConcurrent: 2 },
  impact: { minGap: 0.018, maxConcurrent: 6 },
  flyby: { minGap: 0.08, maxConcurrent: 2 },
  casing: { minGap: 0.1, maxConcurrent: 2 },
  explosion: { minGap: 0.04, maxConcurrent: 4 },
  lightning: { minGap: 0.1, maxConcurrent: 2 },
  footstep: { minGap: 0.03, maxConcurrent: 6 },
  reload: { minGap: 0.02, maxConcurrent: 4 },
  /** per-shot pump / bolt cycling (kept apart from reload scripts) */
  action: { minGap: 0.05, maxConcurrent: 2 },
  dry: { minGap: 0.08, maxConcurrent: 2 },
  /** chain-lightning arcs between targets */
  zap: { minGap: 0.03, maxConcurrent: 4 },
  hitmarker: { minGap: 0.035, maxConcurrent: 2 },
  headshot: { minGap: 0.06, maxConcurrent: 2 },
  hurt: { minGap: 0.1, maxConcurrent: 2 },
  heal: { minGap: 0.12, maxConcurrent: 3 },
  status: { minGap: 0.06, maxConcurrent: 4 },
  ability: { minGap: 0.05, maxConcurrent: 4 },
  ui: { minGap: 0.03, maxConcurrent: 4 },
  'ui:hover': { minGap: 0.05, maxConcurrent: 2 },
  loop: { minGap: 0, maxConcurrent: 12 },
  big: { minGap: 0.1, maxConcurrent: 3 },
  misc: { minGap: 0.03, maxConcurrent: 6 },
};
