// Offline-render stall watchdog (src/audio/stall.ts): Chromium sometimes leaves
// an OfflineAudioContext 'running' after resume() with its clock frozen, and
// startRendering() never settles. The render is abandoned once its clock stops
// moving and redone once on a fresh context. Fake contexts model a healthy, a
// slow, a frozen and a main-thread-blocked render.
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithStallRetry, RenderStalledError, type RenderAttempt } from '../../../src/audio/stall';

interface FakeBehaviour {
  /** the clock freezes here for good (the Chromium hang) */
  freezeAt?: number;
  /** render step period (ms); each step renders 50 ms of audio */
  stepMs?: number;
  /** at this render position one step blocks the thread for `blockMs` before going on */
  blockAt?: number;
  blockMs?: number;
}

const timers: ReturnType<typeof setInterval>[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) clearInterval(t);
});

/** A fake OfflineAudioContext: `currentTime` advances as it "renders" `seconds` of audio. */
class FakeOfflineContext {
  currentTime = 0;
  constructor(
    readonly seconds: number,
    private readonly b: FakeBehaviour = {},
  ) {}

  startRendering(): Promise<string> {
    return new Promise((resolve) => {
      let blocked = false;
      let resumeAt = 0;
      const t = setInterval(() => {
        if (this.b.freezeAt !== undefined && this.currentTime >= this.b.freezeAt) return; // frozen: never settles
        if (this.b.blockAt !== undefined && this.currentTime >= this.b.blockAt) {
          if (!blocked) {
            blocked = true;
            const end = performance.now() + (this.b.blockMs ?? 0);
            while (performance.now() < end) {
              /* a long task on this thread (e.g. heavy timeline callbacks) */
            }
            resumeAt = performance.now() + 100; // … and the render needs a moment to be serviced again
          }
          if (performance.now() < resumeAt) return;
        }
        this.currentTime = Math.min(this.seconds, Math.round((this.currentTime + 0.05) * 1000) / 1000);
        if (this.currentTime >= this.seconds) {
          clearInterval(t);
          resolve(`rendered ${this.seconds} s`);
        }
      }, this.b.stepMs ?? 2);
      timers.push(t);
    });
  }
}

/** A start() for renderWithStallRetry that builds a fresh fake context per attempt. */
function attempts(...behaviours: FakeBehaviour[]): { start: () => RenderAttempt<string>; made: FakeOfflineContext[] } {
  const made: FakeOfflineContext[] = [];
  return {
    made,
    start: () => {
      const ctx = new FakeOfflineContext(1, behaviours[made.length] ?? {});
      made.push(ctx);
      return { clock: ctx, done: ctx.startRendering() };
    },
  };
}

describe('offline render stall watchdog', () => {
  it('a healthy render resolves on its first context', async () => {
    const a = attempts({});
    const stalls: number[] = [];
    await expect(renderWithStallRetry(a.start, { stallMs: 150, onStall: (_i, at) => stalls.push(at) })).resolves.toBe('rendered 1 s');
    expect(a.made).toHaveLength(1);
    expect(stalls).toEqual([]);
  });

  it('a render whose clock freezes after resume() is abandoned and redone once on a fresh context', async () => {
    const a = attempts({ freezeAt: 0.02 }, {});
    const stalls: [number, number][] = [];
    const t0 = performance.now();
    const out = await renderWithStallRetry(a.start, { stallMs: 150, onStall: (i, at) => stalls.push([i, at]) });
    expect(out).toBe('rendered 1 s');
    expect(a.made).toHaveLength(2);
    expect(stalls).toEqual([[0, 0.05]]); // frozen at the first step past 0.02 s
    expect(a.made[0].currentTime).toBe(0.05); // the abandoned context never moved again
    expect(performance.now() - t0).toBeGreaterThanOrEqual(150); // not before the stall threshold
  });

  it('gives up with RenderStalledError when the retry stalls too (no third context)', async () => {
    const a = attempts({ freezeAt: 0.3 }, { freezeAt: 0.5 });
    const err = await renderWithStallRetry(a.start, { stallMs: 120 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderStalledError);
    expect(err).toMatchObject({ attempts: 2, at: 0.5 });
    expect(a.made).toHaveLength(2);
  });

  it('retries: 0 reports the first stall', async () => {
    const a = attempts({ freezeAt: 0 }, {});
    await expect(renderWithStallRetry(a.start, { stallMs: 100, retries: 0 })).rejects.toMatchObject({ attempts: 1, at: 0 });
    expect(a.made).toHaveLength(1);
  });

  it('a slow render whose clock keeps moving is never abandoned', async () => {
    // 20 steps 60 ms apart (1.2 s in all) against a 150 ms stall threshold
    const a = attempts({ stepMs: 60 });
    await expect(renderWithStallRetry(a.start, { stallMs: 150, pollMs: 20 })).resolves.toBe('rendered 1 s');
    expect(a.made).toHaveLength(1);
  });

  it('a long task on this thread is not held against the render', async () => {
    // The watchdog has seen the clock at 0.5 s, then the thread is blocked for 1.2 s (4× the
    // threshold) while the clock stands still, and the render needs another ~100 ms to be
    // serviced again: only those ~100 ms of responsive polls count.
    const a = attempts({ stepMs: 40, blockAt: 0.5, blockMs: 1200 });
    await expect(renderWithStallRetry(a.start, { stallMs: 300, pollMs: 20 })).resolves.toBe('rendered 1 s');
    expect(a.made).toHaveLength(1);
  });

  it("a render's own error is passed through, not retried", async () => {
    let n = 0;
    const start = (): RenderAttempt<string> => {
      n++;
      return { clock: { currentTime: 0 }, done: Promise.reject(new Error('bad buffer size')) };
    };
    await expect(renderWithStallRetry(start, { stallMs: 100 })).rejects.toThrow('bad buffer size');
    expect(n).toBe(1);
  });
});
