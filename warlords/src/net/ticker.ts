// Fixed-step driver for the host simulation.
//
// Browsers throttle main-thread timers in background tabs (≥1 s), which would
// freeze every client's game while the host alt-tabs. Dedicated workers are not
// throttled that way, so a tiny inline Worker (Blob URL) posts ticks and the
// main thread steps the sim on each message. Node / tests / CSP-restricted
// pages fall back to setInterval — also when the worker fails asynchronously
// (CSP `worker-src`, blob load error: reported as a worker 'error' event) or
// simply never ticks (watchdog).
//
// The watchdog is stall-aware (INTEGRATION_REQUESTS APP-2): a match starts with
// the main thread blocked for seconds (scene build, shader compilation), so the
// watchdog timer can run before the worker's queued first message. A watchdog
// that itself fired late (> 2 × its period) proves the main thread was busy, not
// that the worker is dead: it re-arms (without posting a second start to the
// worker). Only WORKER_WATCHDOG_MISSES consecutive on-time misses degrade.

export interface Ticker {
  start(): void;
  stop(): void;
  readonly kind: 'worker' | 'interval';
}

const WORKER_SRC = `let id=null;onmessage=(e)=>{const d=e.data;if(id!==null){clearInterval(id);id=null;}if(typeof d==='number'&&d>0){id=setInterval(()=>postMessage(0),d);}};`;

/** Watchdog period: how long a started worker gets to deliver its first tick (ms). */
export const WORKER_WATCHDOG_MS = 400;
/**
 * Consecutive watchdog periods that fired on time (main thread responsive) with
 * no tick before the worker is replaced by setInterval: a dead worker degrades
 * after ~WORKER_WATCHDOG_MISSES × WORKER_WATCHDOG_MS (1.2 s).
 */
export const WORKER_WATCHDOG_MISSES = 3;
/** Last resort: a worker that has not ticked this long after start() is given up on, stalls or not (ms). */
export const WORKER_GIVE_UP_MS = 15_000;

class IntervalTicker implements Ticker {
  readonly kind = 'interval' as const;
  private id: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly cb: () => void,
  ) {}

  start(): void {
    if (this.id !== null) return;
    this.id = setInterval(this.cb, this.intervalMs);
  }

  stop(): void {
    if (this.id === null) return;
    clearInterval(this.id);
    this.id = null;
  }
}

/** Worker-driven ticker that degrades to an IntervalTicker if the worker fails. */
class WorkerTicker implements Ticker {
  private running = false;
  private ticked = false;
  private worker: Worker | null;
  private fallback: IntervalTicker | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** when the current start() began waiting for the first tick */
  private startedAt = 0;
  /** consecutive on-time watchdog periods without a tick */
  private misses = 0;
  private readonly now: () => number;
  private readonly maxMisses: number;
  private readonly giveUpMs: number;

  constructor(
    worker: Worker,
    private readonly url: string,
    private readonly intervalMs: number,
    private readonly cb: () => void,
    private readonly watchdogMs: number,
    opts: TickerOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.maxMisses = Math.max(1, opts.watchdogMisses ?? WORKER_WATCHDOG_MISSES);
    this.giveUpMs = Math.max(this.watchdogMs * this.maxMisses, opts.giveUpMs ?? WORKER_GIVE_UP_MS);
    this.worker = worker;
    worker.onmessage = () => {
      if (!this.ticked) {
        this.ticked = true;
        this.clearWatchdog();
      }
      if (this.running) cb();
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      this.degrade(`worker error: ${ev.message || 'failed to load'}`);
    };
  }

  get kind(): 'worker' | 'interval' {
    return this.fallback ? 'interval' : 'worker';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.fallback) {
      this.fallback.start();
      return;
    }
    this.worker?.postMessage(this.intervalMs);
    if (!this.ticked) {
      this.startedAt = this.now();
      this.misses = 0;
      this.armWatchdog();
    }
  }

  stop(): void {
    this.running = false;
    this.clearWatchdog();
    this.fallback?.stop();
    this.terminate();
  }

  /** (Re-)arm the first-tick watchdog. Never posts to the worker: its interval is already running. */
  private armWatchdog(): void {
    this.clearWatchdog();
    const armedAt = this.now();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.running || this.ticked || this.fallback) return;
      const t = this.now();
      if (t - this.startedAt >= this.giveUpMs) {
        this.degrade('worker never ticked');
        return;
      }
      if (t - armedAt > this.watchdogMs * 2) {
        // the timer itself ran late: the main thread was blocked (scene build,
        // shader compile, GC) and the worker's first message may still be queued
        // behind it — not evidence of a dead worker
        this.misses = 0;
      } else if (++this.misses >= this.maxMisses) {
        this.degrade('worker never ticked');
        return;
      }
      this.armWatchdog();
    }, this.watchdogMs);
  }

  private degrade(reason: string): void {
    if (this.fallback) return;
    console.warn(`[net] tick worker unavailable (${reason}); falling back to setInterval`);
    this.clearWatchdog();
    this.terminate();
    this.fallback = new IntervalTicker(this.intervalMs, this.cb);
    if (this.running) this.fallback.start();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private terminate(): void {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    w.onmessage = null;
    w.onerror = null;
    try {
      w.postMessage(0);
      w.terminate();
    } catch {
      /* already dead */
    }
    URL.revokeObjectURL(this.url);
  }
}

export interface TickerOptions {
  preferWorker?: boolean;
  /** see WORKER_WATCHDOG_MS */
  watchdogMs?: number;
  /** see WORKER_WATCHDOG_MISSES */
  watchdogMisses?: number;
  /** see WORKER_GIVE_UP_MS */
  giveUpMs?: number;
  /** Worker constructor override (tests) */
  WorkerImpl?: new (url: string) => Worker;
  /** watchdog clock in ms (tests; default performance.now) */
  now?: () => number;
}

/** A repeating timer that keeps firing in background tabs when Workers are available. */
export function createTicker(intervalMs: number, cb: () => void, opts?: TickerOptions): Ticker {
  const preferWorker = opts?.preferWorker ?? true;
  const WorkerImpl = opts?.WorkerImpl ?? (typeof Worker !== 'undefined' ? Worker : undefined);
  if (preferWorker && WorkerImpl && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function') {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const worker = new WorkerImpl(url);
      return new WorkerTicker(worker, url, intervalMs, cb, opts?.watchdogMs ?? WORKER_WATCHDOG_MS, opts);
    } catch {
      /* CSP or file:// restrictions: fall through */
      if (url) URL.revokeObjectURL(url);
    }
  }
  return new IntervalTicker(intervalMs, cb);
}

export interface FixedStepLoopOptions {
  hz: number;
  /** max steps run per wake-up (then the backlog is dropped) */
  maxCatchUp?: number;
  now?: () => number;
  /** ticker interval (default: half a step) */
  intervalMs?: number;
  preferWorker?: boolean;
  /** consecutive throwing steps before the loop gives up (default 30 = 1 s at 30 Hz) */
  maxConsecutiveFailures?: number;
  /** called once when the loop gave up because step() kept throwing */
  onFatal?: (err: unknown) => void;
  /** ticker override (tests) */
  tickerOptions?: TickerOptions;
}

/**
 * Runs `step()` at a fixed rate from a ticker, with an accumulator. Catches up
 * at most `maxCatchUp` steps per wake-up so a long stall does not spiral. A
 * step that throws is logged and skipped; `maxConsecutiveFailures` in a row
 * stop the loop and report through `onFatal` (a frozen match must surface).
 *
 * pause() freezes the loop without stopping its ticker (single-player menu):
 * no steps run while paused, and resume() restarts the clock from "now" — no
 * catch-up burst for the paused time. setTimeScale(k) (debug / e2e) runs the
 * steps k× faster than real time.
 */
export class FixedStepLoop {
  // stepMs / maxCatchUp stay plain fields: src/game/debug.ts (older fallback for
  // __sgwl.cheats.timeScale) adjusts them at runtime on hosts without setDebugTimeScale
  private stepMs: number;
  private maxCatchUp: number;
  private readonly baseMaxCatchUp: number;
  private readonly maxFailures: number;
  private readonly now: () => number;
  private ticker: Ticker | null = null;
  private last = 0;
  private acc = 0;
  private running = false;
  private paused = false;
  /** interpolation factor frozen at pause() */
  private pausedAlpha = 1;
  private scale = 1;
  private failures = 0;
  /** total steps executed */
  steps = 0;

  constructor(
    private readonly step: () => void,
    private readonly opts: FixedStepLoopOptions,
  ) {
    this.stepMs = 1000 / opts.hz;
    this.maxCatchUp = opts.maxCatchUp ?? 5;
    this.baseMaxCatchUp = this.maxCatchUp;
    this.maxFailures = Math.max(1, opts.maxConsecutiveFailures ?? 30);
    this.now = opts.now ?? (() => performance.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** true between pause() and resume() (while running). */
  get isPaused(): boolean {
    return this.running && this.paused;
  }

  /** 'worker' | 'interval' while running, null when stopped. */
  get tickerKind(): Ticker['kind'] | null {
    return this.ticker?.kind ?? null;
  }

  /** current debug time scale (1 = real time) */
  get timeScale(): number {
    return this.scale;
  }

  /** `paused`: start frozen (a pause asked for before the loop ran), as if pause() came right after. */
  start(paused = false): void {
    if (this.running) return;
    this.running = true;
    this.paused = paused;
    this.pausedAlpha = 0;
    this.last = this.now();
    this.acc = 0;
    this.failures = 0;
    this.ticker = createTicker(this.opts.intervalMs ?? this.stepMs / 2, () => this.pump(), {
      preferWorker: this.opts.preferWorker,
      ...this.opts.tickerOptions,
    });
    this.ticker.start();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.ticker?.stop();
    this.ticker = null;
  }

  /** Freeze the simulation: no steps until resume(). The ticker keeps running (cheap no-op pumps). */
  pause(): void {
    if (!this.running || this.paused) return;
    this.pausedAlpha = this.alpha();
    this.paused = true;
  }

  /** Continue after pause(): the paused time is skipped, not caught up. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.last = this.now();
    this.acc = 0;
  }

  /**
   * Debug / e2e only: run the simulation `k`× faster than real time (clamped to
   * 0.1..10). Catch-up per wake-up scales along so a fast loop keeps up.
   */
  setTimeScale(k: number): void {
    const scale = Number.isFinite(k) ? Math.max(0.1, Math.min(10, k)) : 1;
    if (this.running && !this.paused) this.pump(); // bank the time elapsed at the old rate
    this.scale = scale;
    this.maxCatchUp = Math.max(this.baseMaxCatchUp, Math.ceil(this.baseMaxCatchUp * scale));
  }

  /** Advance by real elapsed time. Public so tests can drive it deterministically. */
  pump(): void {
    if (!this.running || this.paused) return;
    const now = this.now();
    this.acc += Math.max(0, now - this.last) * this.scale;
    this.last = now;
    let n = 0;
    while (this.acc >= this.stepMs && n < this.maxCatchUp && this.running && !this.paused) {
      this.acc -= this.stepMs;
      n++;
      this.steps++;
      try {
        this.step();
        this.failures = 0;
      } catch (err) {
        this.failures++;
        if (this.failures === 1 || this.failures % 10 === 0) console.error(`[net] simulation step threw (${this.failures} in a row)`, err);
        if (this.failures >= this.maxFailures) {
          this.stop();
          this.opts.onFatal?.(err);
          return;
        }
      }
    }
    // dropped backlog: keep at most one partial step
    if (this.acc >= this.stepMs) this.acc = this.acc % this.stepMs;
  }

  /** Interpolation factor in [0,1] between the previous and the latest step, as of now. */
  alpha(): number {
    if (!this.running) return 1;
    if (this.paused) return this.pausedAlpha;
    const a = (this.acc + Math.max(0, this.now() - this.last) * this.scale) / this.stepMs;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }
}
