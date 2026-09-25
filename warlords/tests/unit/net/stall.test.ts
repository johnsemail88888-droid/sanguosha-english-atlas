// Stall-aware time (src/net/stall.ts, NET-4): the watchdogs and connect timeouts
// count only the time this page was responsive, so a page frozen while it builds
// the match scene never blames the other side for its own stall.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRetryingRoomNotFound, roomNotFoundBackoffMs } from '../../../src/net/clientSession';
import { NetError } from '../../../src/net/errors';
import {
  adaptiveTimeoutMs,
  maxStepFor,
  RecentSilence,
  ResponsiveClock,
  SILENCE_DECAY_MS,
  SILENCE_MARGIN,
  STALL_SLACK_MS,
  StallAwareTimeout,
  stallAwareSleep,
  WARM_GAP_MS,
  WARM_MAX_MS,
  WarmUp,
} from '../../../src/net/stall';

afterEach(() => {
  vi.useRealTimers();
});

/** A hand-moved clock. */
function manualClock(start = 1000): { now: () => number; set(t: number): void; add(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    set: (v) => {
      t = v;
    },
    add: (ms) => {
      t += ms;
    },
  };
}

/** Fake setTimeout/setInterval + performance.now: time only moves when the test says so. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });

describe('ResponsiveClock', () => {
  it('credits the time between ticks, but at most 1.5 periods (+ slack) after a stall, and flags it', () => {
    const c = manualClock();
    const clock = new ResponsiveClock(maxStepFor(1000), c.now);
    expect(maxStepFor(1000)).toBe(1500 + STALL_SLACK_MS);
    c.add(1000);
    expect(clock.tick()).toBe(1000);
    expect(clock.stalled).toBe(false);
    c.add(1600); // a slightly late timer still counts in full
    expect(clock.tick()).toBe(1600);
    expect(clock.stalled).toBe(false);
    c.add(12_000); // the page was frozen building the scene: one capped step
    expect(clock.tick()).toBe(1750);
    expect(clock.stalled).toBe(true);
    c.add(1000);
    expect(clock.tick()).toBe(1000);
    expect(clock.stalled).toBe(false);
  });

  it('reset() starts the next step now', () => {
    const c = manualClock();
    const clock = new ResponsiveClock(1000, c.now);
    c.add(800);
    clock.reset();
    c.add(300);
    expect(clock.tick()).toBe(300);
  });

  it('a page busy in long tasks (timers 2.5 × late, again and again) still counts most of the time', () => {
    const c = manualClock();
    const clock = new ResponsiveClock(maxStepFor(1000), c.now);
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      c.add(2500);
      sum += clock.tick();
    }
    // 25 s of wall time: 17.5 s counted — a truly silent peer is still found, a little later
    expect(sum).toBe(17_500);
  });
});

describe('StallAwareTimeout', () => {
  it('fires after `ms` of responsive time', () => {
    fakeTimers();
    const fired: number[] = [];
    const t0 = performance.now();
    const t = new StallAwareTimeout(2000, () => fired.push(performance.now() - t0));
    vi.advanceTimersByTime(1900);
    expect(fired).toEqual([]);
    expect(t.pending).toBe(true);
    vi.advanceTimersByTime(400);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeGreaterThanOrEqual(2000);
    expect(fired[0]).toBeLessThanOrEqual(2250); // polled every 250 ms (ms / 8)
    expect(t.pending).toBe(false);
  });

  it('a freeze longer than the timeout counts as one short step: the reply queued behind it still wins', () => {
    // the timer's clock is the page's clock: during a freeze it jumps while no timer runs
    const c = manualClock();
    fakeTimers();
    let expired = false;
    const t = new StallAwareTimeout(2000, () => (expired = true), { now: c.now }); // polls every 250 ms
    for (let i = 0; i < 2; i++) {
      c.add(250);
      vi.advanceTimersByTime(250);
    }
    expect(t.elapsed).toBe(500);
    c.add(10_000); // the page compiles shaders for 10 s …
    vi.advanceTimersByTime(250); // … then the late poll runs first: one capped step, no verdict
    expect(t.elapsed).toBe(500 + maxStepFor(250));
    expect(expired).toBe(false); // (a wall-clock setTimeout(2000) would have rejected here)
    t.cancel(); // the answer that queued up during the freeze is processed now
    vi.advanceTimersByTime(5000);
    expect(expired).toBe(false);
  });

  it('never expires on the poll right after a stall, even when that stall used up the budget', () => {
    const c = manualClock();
    fakeTimers();
    let expired = false;
    const t = new StallAwareTimeout(400, () => (expired = true), { periodMs: 100, now: c.now });
    c.add(100);
    vi.advanceTimersByTime(100);
    c.add(5000); // stall: +400 credited (1.5 × 100 + 250), elapsed 500 ≥ 400 …
    vi.advanceTimersByTime(100);
    expect(t.elapsed).toBe(500);
    expect(expired).toBe(false); // … but that poll followed a stall
    c.add(100);
    vi.advanceTimersByTime(100);
    expect(expired).toBe(true);
  });

  it('cancel() is idempotent and stops the polling', () => {
    fakeTimers();
    let n = 0;
    const t = new StallAwareTimeout(300, () => n++);
    t.cancel();
    t.cancel();
    vi.advanceTimersByTime(2000);
    expect(n).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stallAwareSleep resolves after the responsive time', async () => {
    fakeTimers();
    let done = false;
    void stallAwareSleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(true);
    await expect(stallAwareSleep(0)).resolves.toBeUndefined();
  });
});

describe('RecentSilence + adaptiveTimeoutMs', () => {
  it('remembers the longest recent silence and forgets it with the decay time constant', () => {
    const c = manualClock(0);
    const s = new RecentSilence(SILENCE_DECAY_MS, c.now);
    expect(s.current()).toBe(0);
    s.note(17_000);
    expect(s.current()).toBe(17_000);
    s.note(3000); // shorter ones do not lower it
    expect(s.current()).toBe(17_000);
    c.add(SILENCE_DECAY_MS);
    expect(s.current()).toBeCloseTo(17_000 / Math.E, 0);
    s.note(0);
    s.note(Number.NaN);
    expect(s.current()).toBeCloseTo(17_000 / Math.E, 0);
    s.reset();
    expect(s.current()).toBe(0);
  });

  it('the timeout is the base, raised to SILENCE_MARGIN × the recent silence, capped', () => {
    expect(SILENCE_MARGIN).toBe(2);
    expect(adaptiveTimeoutMs(15_000, 0, 60_000)).toBe(15_000);
    expect(adaptiveTimeoutMs(15_000, 5000, 60_000)).toBe(15_000);
    expect(adaptiveTimeoutMs(15_000, 17_000, 60_000)).toBe(34_000);
    expect(adaptiveTimeoutMs(15_000, 45_000, 60_000)).toBe(60_000);
    expect(adaptiveTimeoutMs(15_000, 45_000, 10_000)).toBe(15_000); // never below the base
  });
});

describe('WarmUp (the first frames after loading)', () => {
  it('lasts until the stream has flowed steadily for steadyMs; a gap over WARM_GAP_MS starts the count again', () => {
    const c = manualClock(0);
    const w = new WarmUp(10_000, c.now);
    expect(w.active).toBe(false); // not started
    w.start();
    expect(w.active).toBe(true);
    for (let i = 0; i < 20; i++) {
      c.add(500);
      w.beat();
    }
    expect(w.active).toBe(true); // 9.5 s steady so far
    c.add(17_000); // a 17 s freeze on a first frame
    expect(17_000).toBeGreaterThan(WARM_GAP_MS);
    w.beat();
    for (let i = 0; i < 19; i++) {
      c.add(500);
      w.beat();
    }
    expect(w.active).toBe(true);
    c.add(500);
    w.beat(); // 10 s steady since the freeze
    expect(w.active).toBe(false);
    w.beat();
    expect(w.active).toBe(false); // stays warm
  });

  it('ends after WARM_MAX_MS even if the stream never flows (a hidden tab); steadyMs 0 disables it; reset() ends it', () => {
    const c = manualClock(0);
    const w = new WarmUp(10_000, c.now);
    w.start();
    c.add(WARM_MAX_MS - 1);
    expect(w.active).toBe(true);
    c.add(1);
    expect(w.active).toBe(false);
    w.start(); // a rejoin into the match: warm up again
    expect(w.active).toBe(true);
    w.reset();
    expect(w.active).toBe(false);
    const off = new WarmUp(0, c.now);
    off.start();
    expect(off.active).toBe(false);
  });
});

describe('"room not found" retries (P2P host peer unavailable)', () => {
  it('backs off 1 s, 2 s, 4 s, then every 5 s', () => {
    expect([0, 1, 2, 3, 4, 9].map(roomNotFoundBackoffMs)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it('asks again while the answer is "room not found", within the window', async () => {
    fakeTimers();
    let calls = 0;
    const open = async (): Promise<string> => {
      calls++;
      if (calls < 4) throw new NetError('roomNotFound');
      return 'link';
    };
    const p = openRetryingRoomNotFound(open, 30_000);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);
    await expect(p).resolves.toBe('link');
    expect(calls).toBe(4);
    expect(vi.getTimerCount()).toBe(0); // the window's poller is gone
  });

  it('gives up after the window with the last answer; other errors and a zero window count at once', async () => {
    fakeTimers();
    let calls = 0;
    const gone = openRetryingRoomNotFound(async () => {
      calls++;
      throw new NetError('roomNotFound');
    }, 10_000);
    const settled = gone.then(
      () => 'resolved',
      (e: NetError) => e.code,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await settled).toBe('roomNotFound');
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(calls).toBeLessThanOrEqual(6);

    let once = 0;
    await expect(
      openRetryingRoomNotFound(async () => {
        once++;
        throw new NetError('roomNotFound');
      }, 0),
    ).rejects.toMatchObject({ code: 'roomNotFound' });
    expect(once).toBe(1);
    let other = 0;
    await expect(
      openRetryingRoomNotFound(async () => {
        other++;
        throw new NetError('roomFull');
      }, 30_000),
    ).rejects.toMatchObject({ code: 'roomFull' });
    expect(other).toBe(1);
  });

  it('stops early once the session is closed', async () => {
    fakeTimers();
    let closed = false;
    let calls = 0;
    const p = openRetryingRoomNotFound(
      async () => {
        calls++;
        throw new NetError('roomNotFound');
      },
      30_000,
      () => closed,
    ).catch((e: NetError) => e.code);
    await vi.advanceTimersByTimeAsync(500);
    closed = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('roomNotFound');
    expect(calls).toBe(1);
  });
});
