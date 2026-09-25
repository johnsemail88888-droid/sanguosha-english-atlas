// Stall-aware time for the connection watchdogs and connect timeouts (NET-4).
//
// A page whose own main thread is blocked — building the match scene, compiling
// shaders, a long GC, a slow phone — neither processes what arrives meanwhile
// nor sends anything, and its timers fire late, in one go, often before the
// messages that queued up behind the stall. A timeout measured in wall time then
// blames the other side for our own freeze (a guest's rejoin, run on a page busy
// building the match scene, could time out that way).
//
// These helpers count the time the page was responsive instead: a periodic tick
// credits the time since the previous tick, capped at 1.5 periods (+ timer
// slack), so a 10 s freeze counts as one short step. A tick that followed a
// stall is flagged, and a watchdog skips its verdict on that tick so the queued
// messages are processed first (the APP-6 "skip a round" rule).

/** Timer lateness always tolerated on top of 1.5 periods (ms). */
export const STALL_SLACK_MS = 250;

/** Largest step a tick of period `periodMs` credits: longer gaps are this page's own stalls. */
export function maxStepFor(periodMs: number): number {
  return 1.5 * Math.max(0, periodMs) + STALL_SLACK_MS;
}

const perfNow = (): number => performance.now();

/**
 * Responsive time between ticks. Call `tick()` from a periodic timer: it
 * returns the time since the previous tick, capped at `maxStepMs`; `stalled`
 * tells whether that gap was longer (this page was frozen meanwhile).
 */
export class ResponsiveClock {
  private last: number;
  private stalledValue = false;

  constructor(
    readonly maxStepMs: number,
    private readonly now: () => number = perfNow,
  ) {
    this.last = now();
  }

  /** Responsive ms since the previous tick (or construction / reset). */
  tick(): number {
    const t = this.now();
    const gap = Math.max(0, t - this.last);
    this.last = t;
    this.stalledValue = gap > this.maxStepMs;
    return Math.min(gap, this.maxStepMs);
  }

  /** The last tick came after a stall (its gap was capped). */
  get stalled(): boolean {
    return this.stalledValue;
  }

  /** Start the next step now (a new watchdog run). */
  reset(): void {
    this.last = this.now();
    this.stalledValue = false;
  }
}

export interface StallAwareTimeoutOptions {
  /** polling period (ms; default ms / 8, clamped to 50..500) */
  periodMs?: number;
  /** clock (tests; default performance.now) */
  now?: () => number;
}

/**
 * A timeout that counts only responsive time: `onExpire` runs once `ms` of it
 * have passed — never on the first poll after a stall, so a reply that queued up
 * behind the freeze still wins. `cancel()` is idempotent.
 */
export class StallAwareTimeout {
  private elapsedMs = 0;
  private readonly clock: ResponsiveClock;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(
    readonly ms: number,
    private readonly onExpire: () => void,
    opts: StallAwareTimeoutOptions = {},
  ) {
    const period = opts.periodMs ?? Math.min(500, Math.max(50, ms / 8));
    this.clock = new ResponsiveClock(maxStepFor(period), opts.now);
    this.timer = setInterval(() => this.poll(), period);
  }

  /** Responsive ms counted so far. */
  get elapsed(): number {
    return this.elapsedMs;
  }

  /** Still counting (neither expired nor cancelled). */
  get pending(): boolean {
    return this.timer !== null;
  }

  cancel(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (this.timer === null) return;
    this.elapsedMs += this.clock.tick();
    if (this.elapsedMs < this.ms || this.clock.stalled) return;
    this.cancel();
    this.onExpire();
  }
}

/** Time constant (ms) with which a link's long silence is forgotten (RecentSilence). */
export const SILENCE_DECAY_MS = 30_000;
/** A link's timeout is at least this multiple of its recent longest silence (adaptiveTimeoutMs). */
export const SILENCE_MARGIN = 2;

/**
 * The longest recent silence of a link, forgotten with time constant `decayMs`.
 * A peer that was just quiet for 12 s (a slow device still busy with its first
 * frames after loading) is likely to be again soon: its timeout grows for a
 * while (adaptiveTimeoutMs) instead of dropping it on the next stall. A link
 * that answers steadily keeps the normal timeout.
 */
export class RecentSilence {
  private value = 0;
  private at = 0;

  constructor(
    readonly decayMs: number = SILENCE_DECAY_MS,
    private readonly now: () => number = perfNow,
  ) {}

  /** A silence of `ms` just ended (the link spoke again). */
  note(ms: number): void {
    if (!(ms > 0)) return;
    const t = this.now();
    this.value = Math.max(ms, this.current(t));
    this.at = t;
  }

  /** The decayed longest recent silence (ms). */
  current(t: number = this.now()): number {
    return this.value > 0 ? this.value * Math.exp(-Math.max(0, t - this.at) / this.decayMs) : 0;
  }

  reset(): void {
    this.value = 0;
  }
}

/**
 * Silence after which a link counts as dead: `baseMs`, raised to SILENCE_MARGIN ×
 * its recent longest silence (see RecentSilence), never above `maxMs`.
 */
export function adaptiveTimeoutMs(baseMs: number, recentMs: number, maxMs: number): number {
  return Math.max(baseMs, Math.min(maxMs, SILENCE_MARGIN * Math.max(0, recentMs)));
}

/** setTimeout in responsive time (see StallAwareTimeout); returns the cancel function. */
export function stallAwareTimeout(fn: () => void, ms: number, opts?: StallAwareTimeoutOptions): () => void {
  const t = new StallAwareTimeout(ms, fn, opts);
  return () => t.cancel();
}

/** A promise that resolves after `ms` of responsive time. */
export function stallAwareSleep(ms: number, opts?: StallAwareTimeoutOptions): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    stallAwareTimeout(resolve, ms, opts);
  });
}
