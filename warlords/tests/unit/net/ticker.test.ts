import { describe, expect, it } from 'vitest';
import { createTicker, FixedStepLoop } from '../../../src/net/ticker';

describe('FixedStepLoop', () => {
  it('steps at a fixed rate, caps catch-up at 5 ticks and exposes alpha', () => {
    let t = 1000;
    let steps = 0;
    const loop = new FixedStepLoop(() => steps++, { hz: 30, now: () => t, intervalMs: 1e9, preferWorker: false });
    loop.start();
    t += 101; // 3 steps worth (3 × 33.3 ms)
    loop.pump();
    expect(steps).toBe(3);
    t += 10;
    expect(loop.alpha()).toBeGreaterThan(0.2);
    expect(loop.alpha()).toBeLessThanOrEqual(1);
    t += 1000; // a long stall (background tab / GC): at most 5 steps, backlog dropped
    loop.pump();
    expect(steps).toBe(8);
    t += 34;
    loop.pump();
    expect(steps).toBe(9);
    loop.stop();
    t += 1000;
    loop.pump();
    expect(steps).toBe(9);
    expect(loop.alpha()).toBe(1);
  });

  it('keeps running if a step throws', () => {
    let t = 0;
    let n = 0;
    const loop = new FixedStepLoop(
      () => {
        n++;
        if (n === 1) throw new Error('bad tick');
      },
      { hz: 10, now: () => t, intervalMs: 1e9, preferWorker: false },
    );
    const err = console.error;
    console.error = () => {};
    try {
      loop.start();
      t += 250;
      loop.pump();
    } finally {
      console.error = err;
      loop.stop();
    }
    expect(n).toBe(2);
  });

  it('falls back to setInterval where Workers do not exist (Node)', async () => {
    let n = 0;
    const tk = createTicker(5, () => n++);
    expect(tk.kind).toBe('interval');
    tk.start();
    await new Promise((r) => setTimeout(r, 60));
    tk.stop();
    const after = n;
    expect(after).toBeGreaterThan(3);
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(after);
  });
});

describe('worker ticker fallback', () => {
  class ScriptedWorker {
    static mode: 'error' | 'silent' | 'ok' = 'ok';
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    terminated = false;
    constructor(_url: string) {
      if (ScriptedWorker.mode === 'error') {
        // CSP worker-src / blob load failures arrive asynchronously as an 'error' event
        setTimeout(() => this.onerror?.({ message: 'blocked by CSP', preventDefault() {} }), 5);
      }
    }
    postMessage(ms: unknown): void {
      if (ScriptedWorker.mode !== 'ok') return;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (typeof ms === 'number' && ms > 0) this.timer = setInterval(() => this.onmessage?.({}), ms);
    }
    terminate(): void {
      this.terminated = true;
      if (this.timer) clearInterval(this.timer);
    }
  }
  const WorkerImpl = ScriptedWorker as unknown as new (url: string) => Worker;

  const run = async (mode: typeof ScriptedWorker.mode) => {
    ScriptedWorker.mode = mode;
    let n = 0;
    const warn = console.warn;
    console.warn = () => {};
    const tk = createTicker(5, () => n++, { WorkerImpl, watchdogMs: 40 });
    try {
      expect(tk.kind).toBe('worker');
      tk.start();
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      tk.stop();
      console.warn = warn;
    }
    return { n, kind: tk.kind };
  };

  it('keeps using a healthy worker', async () => {
    const r = await run('ok');
    expect(r.kind).toBe('worker');
    expect(r.n).toBeGreaterThan(5);
  });

  it('falls back to setInterval when the worker fails asynchronously', async () => {
    const r = await run('error');
    expect(r.kind).toBe('interval');
    expect(r.n).toBeGreaterThan(5);
  });

  it('falls back to setInterval when the worker never ticks (watchdog)', async () => {
    const r = await run('silent');
    expect(r.kind).toBe('interval');
    expect(r.n).toBeGreaterThan(3);
  });
});

describe('worker ticker watchdog vs main-thread stalls (APP-2)', () => {
  /** A worker that ticks fine, but whose first message only arrives `firstAfterMs` (real time) after start. */
  class LateWorker {
    static firstAfterMs = 0;
    static posts: unknown[] = [];
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
    private timers: ReturnType<typeof setTimeout>[] = [];
    postMessage(ms: unknown): void {
      LateWorker.posts.push(ms);
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
      if (typeof ms !== 'number' || ms <= 0) return;
      this.timers.push(
        setTimeout(() => {
          this.onmessage?.({});
          this.timers.push(setInterval(() => this.onmessage?.({}), ms));
        }, LateWorker.firstAfterMs),
      );
    }
    terminate(): void {
      for (const t of this.timers) clearTimeout(t);
    }
  }
  /** A worker that loads but never posts anything. */
  class DeadWorker {
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
    postMessage(): void {}
    terminate(): void {}
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const captureWarn = () => {
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
    return { warns, restore: () => (console.warn = warn) };
  };

  it('a watchdog that fires late because of a 3 s main-thread stall re-arms instead of degrading', async () => {
    LateWorker.firstAfterMs = 450; // queued behind the (late) watchdog timer
    LateWorker.posts = [];
    let offset = 0;
    const clock = () => performance.now() + offset;
    const w = captureWarn();
    let n = 0;
    const tk = createTicker(5, () => n++, { WorkerImpl: LateWorker as unknown as new (url: string) => Worker, now: clock });
    try {
      tk.start();
      offset += 3000; // the main thread was blocked for 3 s: the 400 ms watchdog runs 3 s late
      await sleep(1500);
      expect(tk.kind).toBe('worker');
      expect(n).toBeGreaterThan(10);
      expect(w.warns.filter((x) => x.includes('tick worker unavailable'))).toEqual([]);
      expect(LateWorker.posts).toEqual([5]); // re-arming never posts a second start to the worker
    } finally {
      tk.stop();
      w.restore();
    }
  });

  it('the event loop really blocked: the late watchdog runs before the queued first tick and still keeps the worker', async () => {
    LateWorker.firstAfterMs = 60;
    LateWorker.posts = [];
    const w = captureWarn();
    let n = 0;
    const tk = createTicker(5, () => n++, { WorkerImpl: LateWorker as unknown as new (url: string) => Worker, watchdogMs: 40 });
    try {
      tk.start();
      const end = performance.now() + 400;
      while (performance.now() < end) {
        /* synchronous stall: shader compilation */
      }
      await sleep(300);
      expect(tk.kind).toBe('worker');
      expect(n).toBeGreaterThan(5);
      expect(w.warns).toEqual([]);
    } finally {
      tk.stop();
      w.restore();
    }
  });

  it('a truly dead worker still degrades within ~1.2 s while the main thread is responsive', async () => {
    const w = captureWarn();
    let n = 0;
    const t0 = performance.now();
    const tk = createTicker(5, () => n++, { WorkerImpl: DeadWorker as unknown as new (url: string) => Worker });
    let degradedAt = -1;
    try {
      tk.start();
      while (performance.now() - t0 < 3000) {
        await sleep(10);
        if (tk.kind === 'interval') {
          degradedAt = performance.now() - t0;
          break;
        }
      }
      await sleep(50);
    } finally {
      tk.stop();
      w.restore();
    }
    expect(degradedAt).toBeGreaterThanOrEqual(1150);
    expect(degradedAt).toBeLessThan(2000); // 3 × 400 ms (+ timer slack on a busy CI box)
    expect(n).toBeGreaterThan(3);
    expect(w.warns.some((x) => x.includes('worker never ticked'))).toBe(true);
  });

  it('a dead worker behind a main thread that keeps stalling is given up on after giveUpMs', async () => {
    let offset = 0;
    const clock = () => performance.now() + offset;
    const w = captureWarn();
    const tk = createTicker(5, () => {}, { WorkerImpl: DeadWorker as unknown as new (url: string) => Worker, now: clock, watchdogMs: 20, giveUpMs: 2000 });
    const stall = setInterval(() => (offset += 100), 10); // every watchdog period looks late
    try {
      tk.start();
      await sleep(120);
      expect(tk.kind).toBe('worker'); // only late periods so far: keep waiting
      await sleep(400);
      expect(tk.kind).toBe('interval');
    } finally {
      clearInterval(stall);
      tk.stop();
      w.restore();
    }
  });
});

describe('FixedStepLoop pause and time scale', () => {
  it('pause() runs no steps; resume() does not catch up the paused time', () => {
    let t = 0;
    let steps = 0;
    const loop = new FixedStepLoop(() => steps++, { hz: 10, now: () => t, intervalMs: 1e9, preferWorker: false });
    loop.start();
    t += 250;
    loop.pump();
    expect(steps).toBe(2);
    t += 30;
    loop.pause();
    const frozen = loop.alpha();
    expect(loop.isPaused).toBe(true);
    t += 2000;
    loop.pump();
    expect(steps).toBe(2);
    expect(loop.alpha()).toBe(frozen);
    loop.resume();
    expect(loop.isPaused).toBe(false);
    loop.pump();
    expect(steps).toBe(2); // no burst for the 2 s spent paused
    t += 100;
    loop.pump();
    expect(steps).toBe(3);
    loop.stop();
  });

  it('setTimeScale(k) steps k× faster and raises the catch-up cap', () => {
    let t = 0;
    let steps = 0;
    const loop = new FixedStepLoop(() => steps++, { hz: 10, now: () => t, intervalMs: 1e9, preferWorker: false });
    loop.start();
    loop.setTimeScale(4);
    expect(loop.timeScale).toBe(4);
    t += 1000;
    loop.pump();
    expect(steps).toBe(20); // 40 due, catch-up capped at ceil(5 × 4)
    t += 250;
    loop.pump();
    expect(steps).toBe(30);
    loop.setTimeScale(100);
    expect(loop.timeScale).toBe(10);
    loop.stop();
  });
});

describe('FixedStepLoop fatal failures', () => {
  it('gives up after N consecutive throwing steps and reports once', () => {
    let t = 0;
    const fatal: unknown[] = [];
    const loop = new FixedStepLoop(
      () => {
        throw new Error('sim broke');
      },
      { hz: 10, now: () => t, intervalMs: 1e9, preferWorker: false, maxConsecutiveFailures: 3, onFatal: (e) => fatal.push(e) },
    );
    const err = console.error;
    console.error = () => {};
    try {
      loop.start();
      t += 1000;
      loop.pump();
      t += 1000;
      loop.pump();
    } finally {
      console.error = err;
      loop.stop();
    }
    expect(fatal).toHaveLength(1);
    expect(loop.isRunning).toBe(false);
    expect(loop.steps).toBe(3);
  });

  it('a successful step resets the failure count', () => {
    let t = 0;
    let n = 0;
    const fatal: unknown[] = [];
    const loop = new FixedStepLoop(
      () => {
        n++;
        if (n % 3 !== 0) throw new Error('flaky');
      },
      { hz: 10, now: () => t, intervalMs: 1e9, preferWorker: false, maxCatchUp: 100, maxConsecutiveFailures: 3, onFatal: (e) => fatal.push(e) },
    );
    const err = console.error;
    console.error = () => {};
    try {
      loop.start();
      t += 3000;
      loop.pump();
    } finally {
      console.error = err;
      loop.stop();
    }
    expect(n).toBe(30);
    expect(fatal).toHaveLength(0);
  });
});
