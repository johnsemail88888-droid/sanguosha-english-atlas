// Stall watchdog for offline renders (render.ts renderOffline).
//
// Chromium occasionally — about 1 in 60–100 back-to-back OfflineAudioContext
// renders that suspend() / resume() along a timeline — leaves a context
// 'running' after resume() with its clock frozen: startRendering() never
// settles and whoever awaits it hangs forever. An offline render cannot be
// cancelled, so a render whose clock stops moving is abandoned and redone on
// a fresh context (once by default). In-game audio never suspends a render
// (bake.ts), so only the dev page and the audio e2e test go through here.

/** The part of an OfflineAudioContext the watchdog reads (tests pass a fake). */
export interface RenderClock {
  /** render position (s); advances while the render runs */
  readonly currentTime: number;
}

/** One render: the context it runs on and its completion (startRendering()). */
export interface RenderAttempt<T> {
  clock: RenderClock;
  done: Promise<T>;
}

export interface StallWatchOptions {
  /** the render clock did not move for this long ⇒ stalled (ms) */
  stallMs?: number;
  /** watchdog period (ms) */
  pollMs?: number;
  /** fresh attempts after a stall (default 1) */
  retries?: number;
  /** an attempt was abandoned, its clock frozen at `at` seconds (attempt: 0-based) */
  onStall?: (attempt: number, at: number) => void;
}

/**
 * Default stall threshold (ms). A healthy render renders seconds of audio in
 * well under a second, and its clock moves on every render quantum; only
 * wall time in which this thread was responsive counts (see watchRender).
 */
export const RENDER_STALL_MS = 4000;
const POLL_MS = 200;

export class RenderStalledError extends Error {
  constructor(
    /** render position (s) where the last attempt froze */
    readonly at: number,
    readonly attempts: number,
  ) {
    super(`offline render stalled at ${at.toFixed(4)} s (${attempts} attempt${attempts === 1 ? '' : 's'})`);
    this.name = 'RenderStalledError';
  }
}

type Watched<T> = { ok: true; value: T } | { ok: false; at: number };

/**
 * Resolve with the render's result, or with `{ ok: false }` once its clock has
 * not moved for `stallMs`. Stall-aware like the net watchdogs: when this
 * thread itself was blocked (a long task — the render callbacks run here too)
 * the time is not held against the render, and it takes a few quiet polls in
 * a row to call a stall.
 */
function watchRender<T>(a: RenderAttempt<T>, stallMs: number, pollMs: number): Promise<Watched<T>> {
  return new Promise<Watched<T>>((resolve, reject) => {
    let settled = false;
    let last = a.clock.currentTime;
    let lastPoll = performance.now();
    let still = 0; // wall time (ms) the clock has not moved, counting responsive polls only
    let quiet = 0; // polls in a row without a move
    const timer = setInterval(() => {
      if (settled) return;
      const t = performance.now();
      const gap = t - lastPoll;
      lastPoll = t;
      const now = a.clock.currentTime;
      if (now !== last) {
        last = now;
        still = 0;
        quiet = 0;
        return;
      }
      // this thread was blocked: the render may simply not have been serviced yet
      if (gap > Math.max(4 * pollMs, 1000)) return;
      still += gap;
      quiet++;
      if (still >= stallMs && quiet >= 3) finish({ ok: false, at: now });
    }, pollMs);
    const finish = (r: Watched<T> | Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    // an abandoned attempt that settles later is ignored (its rejection is handled here)
    a.done.then(
      (value) => finish({ ok: true, value }),
      (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/**
 * Run `start()` (one offline render on a fresh context) under the stall
 * watchdog; a stalled attempt is abandoned and `start()` called again, up to
 * `retries` times. Rejects with RenderStalledError when every attempt stalled,
 * or with the render's own error.
 */
export async function renderWithStallRetry<T>(start: () => RenderAttempt<T>, o: StallWatchOptions = {}): Promise<T> {
  const stallMs = o.stallMs ?? RENDER_STALL_MS;
  const pollMs = Math.max(1, o.pollMs ?? Math.min(POLL_MS, stallMs / 4));
  const retries = Math.max(0, o.retries ?? 1);
  for (let attempt = 0; ; attempt++) {
    const r = await watchRender(start(), stallMs, pollMs);
    if (r.ok) return r.value;
    o.onStall?.(attempt, r.at);
    if (attempt >= retries) throw new RenderStalledError(r.at, attempt + 1);
  }
}
