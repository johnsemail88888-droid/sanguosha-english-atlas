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
