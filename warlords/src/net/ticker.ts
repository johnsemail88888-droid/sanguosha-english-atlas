// Fixed-step driver for the host simulation.
//
// Browsers throttle main-thread timers in background tabs (≥1 s), which would
// freeze every client's game while the host alt-tabs. Dedicated workers are not
// throttled that way, so a tiny inline Worker (Blob URL) posts ticks and the
// main thread steps the sim on each message. Node / tests / CSP-restricted
// pages fall back to setInterval — also when the worker fails asynchronously
// (CSP `worker-src`, blob load error: reported as a worker 'error' event) or
// simply never ticks (watchdog).

export interface Ticker {
  start(): void;
  stop(): void;
  readonly kind: 'worker' | 'interval';
}

const WORKER_SRC = `let id=null;onmessage=(e)=>{const d=e.data;if(id!==null){clearInterval(id);id=null;}if(typeof d==='number'&&d>0){id=setInterval(()=>postMessage(0),d);}};`;

/** A started worker that has not ticked within this time is replaced by setInterval (ms). */
export const WORKER_WATCHDOG_MS = 400;

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

  constructor(
    worker: Worker,
    private readonly url: string,
    private readonly intervalMs: number,
    private readonly cb: () => void,
    private readonly watchdogMs: number,
  ) {
    this.worker = worker;
    worker.onmessage = () => {
      this.ticked = true;
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
      this.watchdog = setTimeout(() => {
        this.watchdog = null;
        if (this.running && !this.ticked) this.degrade('worker never ticked');
      }, this.watchdogMs);
    }
  }

  stop(): void {
    this.running = false;
    this.clearWatchdog();
    this.fallback?.stop();
    this.terminate();
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
  /** Worker constructor override (tests) */
  WorkerImpl?: new (url: string) => Worker;
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
      return new WorkerTicker(worker, url, intervalMs, cb, opts?.watchdogMs ?? WORKER_WATCHDOG_MS);
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
 */
export class FixedStepLoop {
  private readonly stepMs: number;
  private readonly maxCatchUp: number;
  private readonly maxFailures: number;
  private readonly now: () => number;
  private ticker: Ticker | null = null;
  private last = 0;
  private acc = 0;
  private running = false;
  private failures = 0;
  /** total steps executed */
  steps = 0;

  constructor(
    private readonly step: () => void,
    private readonly opts: FixedStepLoopOptions,
  ) {
    this.stepMs = 1000 / opts.hz;
    this.maxCatchUp = opts.maxCatchUp ?? 5;
    this.maxFailures = Math.max(1, opts.maxConsecutiveFailures ?? 30);
    this.now = opts.now ?? (() => performance.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 'worker' | 'interval' while running, null when stopped. */
  get tickerKind(): Ticker['kind'] | null {
    return this.ticker?.kind ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
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
    this.ticker?.stop();
    this.ticker = null;
  }

  /** Advance by real elapsed time. Public so tests can drive it deterministically. */
  pump(): void {
    if (!this.running) return;
    const now = this.now();
    this.acc += Math.max(0, now - this.last);
    this.last = now;
    let n = 0;
    while (this.acc >= this.stepMs && n < this.maxCatchUp && this.running) {
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
    const a = (this.acc + Math.max(0, this.now() - this.last)) / this.stepMs;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }
}
