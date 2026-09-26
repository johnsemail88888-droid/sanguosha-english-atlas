// 自由选将 (COMBAT-1 / UX-10): the humans choose first from the whole roster — the bots pick
// once every human locked in (or at the deadline, after the humans' hints) and from a random
// handful each, so line-ups vary; a single player gets a long timer to read 30 heroes.
// The dealt mode (options per seat) keeps its old flow: bots pick at the start of the phase.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeroSelectView } from '../../../src/core/types';
import { HEROES } from '../../../src/data/heroes';
import { FakeSim } from '../../../src/net/fakeSim';
import { DEFAULT_TIMINGS, HostSession } from '../../../src/net/hostSession';
import { flatMap, waitFor } from './fixtures';
import { FAST } from './harness';

afterEach(() => vi.useRealTimers());

/** An 8-seat single-player (no network) host on FakeSim; `onView` plays the human (seat 0). */
function solo(seed: number, freePick: boolean, onView: (host: HostSession, v: HeroSelectView) => void, timings = FAST) {
  const sims: FakeSim[] = [];
  const views: HeroSelectView[] = [];
  const host = new HostSession({
    name: '玩家',
    heroes: HEROES,
    timings: { ...timings },
    seed,
    preferWorkerTicker: false,
    settings: { playerCount: 8, freePick },
    createMatch: (init) => {
      const sim = new FakeSim(init, { map: flatMap() });
      sims.push(sim);
      return sim;
    },
  });
  host.on('heroSelect', (v) => {
    views.push(structuredClone(v));
    onView(host, v);
  });
  return { host, sims, views };
}

const heroOf = (sim: FakeSim, seat: number): string | undefined => sim.init.seats.find((s) => s.seat === seat)?.heroId;

describe('自由选将: humans first', () => {
  it('no bot has taken a hero when the human first sees the roster: 关羽 is always free, and he gets him', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      let first: HeroSelectView | null = null;
      const { host, sims } = solo(seed, true, (h, v) => {
        if (v.options.length === 0 || v.picks[0] !== undefined) return;
        first ??= structuredClone(v);
        h.pickHero('guanyu');
      });
      try {
        host.start();
        await waitFor(() => sims.length === 1, 5000, 'match created');
        expect(first!.options).toContain('guanyu');
        // only crown bearers of an earlier (lord) phase may have picked before the human
        const bots = Object.keys(first!.picks).map(Number).filter((s) => s !== 0);
        for (const s of bots) expect(first!.lordPhase, `seat ${s} picked before the human`).toBe(false);
        expect(heroOf(sims[0], 0)).toBe('guanyu');
      } finally {
        host.leave();
      }
    }
  });

  it('the bots pick right after the human locks in (no waiting for the deadline)', async () => {
    const { host, sims } = solo(9, true, (h, v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) h.pickHero(v.options[5]);
    }, { ...FAST, lordPick: 30, pick: 30 });
    try {
      const t0 = Date.now();
      host.start();
      await waitFor(() => sims.length === 1, 5000, 'match created');
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(new Set(sims[0].init.seats.map((s) => s.heroId)).size).toBe(8);
    } finally {
      host.leave();
    }
  });

  it('at the deadline the human gets the hero on screen (hint) before any bot chooses', async () => {
    // the human looks at 吕布 (a bot favourite) and never confirms
    const { host, sims } = solo(4, true, (h, v) => {
      if (v.options.includes('lubu') && v.picks[0] === undefined) h.focusHero('lubu');
    });
    try {
      host.start();
      await waitFor(() => sims.length === 1, 5000, 'match created');
      expect(heroOf(sims[0], 0)).toBe('lubu');
    } finally {
      host.leave();
    }
  });

  it('bot line-ups vary: over 20 seeds no hero is a bot in more than half the matches', async () => {
    const count = new Map<string, number>();
    for (let seed = 100; seed < 120; seed++) {
      const { host, sims } = solo(seed, true, (h, v) => {
        // the human takes the first card it is shown
        if (v.options.length > 0 && v.picks[0] === undefined) h.pickHero(v.options[0]);
      });
      try {
        host.start();
        await waitFor(() => sims.length === 1, 5000, 'match created');
        for (const s of sims[0].init.seats) if (s.seat !== 0) count.set(s.heroId, (count.get(s.heroId) ?? 0) + 1);
      } finally {
        host.leave();
      }
    }
    const dist = [...count].sort((a, b) => b[1] - a[1]);
    process.stdout.write(`[free pick] bot heroes over 20 seeds (${dist.length} distinct): ${dist.map(([id, n]) => `${id} ${n}`).join(', ')}\n`);
    expect(dist[0][1]).toBeLessThanOrEqual(10);
    expect(dist.length).toBeGreaterThanOrEqual(22);
  }, 60_000);
});

describe('自由选将 in single player: a long timer', () => {
  it('the pick phases last 4× the online timer; online and the dealt mode keep theirs', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const timings = { ...DEFAULT_TIMINGS, roleReveal: 0.1 };
    const deadlines = (freePick: boolean): number[] => {
      const out: number[] = [];
      const { host } = solo(3, freePick, (_h, v) => {
        if (v.options.length > 0 && out.length < 1) out.push(v.deadline);
      }, timings);
      try {
        host.start();
        vi.advanceTimersByTime(2500);
        return out;
      } finally {
        host.leave();
      }
    };
    const free = deadlines(true)[0];
    const dealt = deadlines(false)[0];
    // seat 0 picks in the lord phase (15 s online) or the general phase (20 s online)
    expect([60, 80].some((s) => Math.abs(free - s) < 0.5), `free pick deadline ${free}`).toBe(true);
    expect([15, 20].some((s) => Math.abs(dealt - s) < 0.5), `dealt deadline ${dealt}`).toBe(true);
  });
});

describe('dealt mode (自由选将 off) is unchanged', () => {
  it('bots pick at the start of the phase', async () => {
    let first: HeroSelectView | null = null;
    const { host, sims } = solo(5, false, (h, v) => {
      if (v.options.length === 0 || v.picks[0] !== undefined) return;
      first ??= structuredClone(v);
      h.pickHero(v.options[0]);
    });
    try {
      host.start();
      await waitFor(() => sims.length === 1, 5000, 'match created');
      const others = Object.keys(first!.picks).map(Number).filter((s) => s !== 0);
      expect(others.length).toBeGreaterThan(0);
    } finally {
      host.leave();
    }
  });
});
