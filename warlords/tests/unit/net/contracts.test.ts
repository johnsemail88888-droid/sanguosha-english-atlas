// The optional GameSession capabilities the app uses (src/game/session.ts):
// setPaused (single-player pause menu), setLocalLoading (the match clock waits
// for the player's own 3D view), focusHero / 'pickHint' (auto-pick the hero the
// player was looking at) — plus the host's debug hooks (APP-1 time scale, APP-4
// typed cheats).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEROES } from '../../../src/data/heroes';
import { FakeSim } from '../../../src/net/fakeSim';
import { HostSession } from '../../../src/net/hostSession';
import { flatMap, testHeroPool, waitFor } from './fixtures';
import { addClient, autoPick, cleanupHarness, FAST, makeHost, runToPlaying } from './harness';

afterEach(() => {
  vi.useRealTimers();
  cleanupHarness();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A single-player (no network) host session on FakeSim. */
function localHost(timings = {}) {
  const sims: FakeSim[] = [];
  const host = new HostSession({
    name: '玩家',
    heroes: testHeroPool(),
    timings: { ...FAST, ...timings },
    seed: 3,
    preferWorkerTicker: false,
    createMatch: (init) => {
      const sim = new FakeSim(init, { map: flatMap() });
      sims.push(sim);
      return sim;
    },
  });
  host.on('heroSelect', (v) => {
    if (v.options.length > 0 && v.picks[0] === undefined) host.pickHero(v.options[0]);
  });
  return { host, sims };
}

describe('setPaused (single player)', () => {
  it('nothing advances while paused (2 s of fake time), and it resumes without a catch-up burst', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const { host, sims } = localHost();
    try {
      host.start();
      for (let i = 0; i < 300 && host.phase !== 'playing'; i++) vi.advanceTimersByTime(20);
      expect(host.phase).toBe('playing');
      vi.advanceTimersByTime(500);
      const sim = sims[0];
      expect(sim.time).toBeGreaterThan(0.3);
      host.setPaused(true);
      expect(host.isPaused).toBe(true);
      const t0 = sim.time;
      const tick0 = sim.tick;
      vi.advanceTimersByTime(2000);
      expect(sim.time).toBe(t0); // no sim steps (and so no bot thinking)
      expect(sim.tick).toBe(tick0);
      expect(host.debugState()).toMatchObject({ phase: 'playing', paused: true, loopRunning: true });
      host.setPaused(false);
      vi.advanceTimersByTime(1000);
      // ~1 s of sim time: the 2 s spent paused are not caught up
      expect(sim.time - t0).toBeGreaterThan(0.85);
      expect(sim.time - t0).toBeLessThan(1.15);
    } finally {
      host.leave();
    }
  });

  it('a pause asked for while "playing" is being entered (the HUD\'s 点击进入战场) holds: the match starts frozen (UX-11)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const { host, sims } = localHost();
    // the HUD mounts on the phase change and immediately opens "click to play"
    host.on('phase', (p) => {
      if (p === 'playing') host.setPaused(true);
    });
    try {
      host.start();
      for (let i = 0; i < 300 && host.phase !== 'playing'; i++) vi.advanceTimersByTime(20);
      expect(host.phase).toBe('playing');
      const sim = sims[0];
      const t0 = sim.time;
      vi.advanceTimersByTime(3000);
      expect(host.isPaused).toBe(true);
      expect(host.debugState()).toMatchObject({ phase: 'playing', paused: true, loopRunning: true });
      expect(sim.time).toBe(t0); // bots, zone and clock wait for the click
      host.setPaused(false); // clicked in
      vi.advanceTimersByTime(1000);
      expect(sim.time - t0).toBeGreaterThan(0.85);
      expect(sim.time - t0).toBeLessThan(1.15);
    } finally {
      host.leave();
    }
  });

  it('is ignored outside "playing"; a phase change resumes the match', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const { host } = localHost();
    try {
      host.setPaused(true); // lobby
      expect(host.isPaused).toBe(false);
      host.start();
      for (let i = 0; i < 300 && host.phase !== 'playing'; i++) vi.advanceTimersByTime(20);
      host.setPaused(true);
      expect(host.isPaused).toBe(true);
      host.returnToLobby();
      expect(host.phase).toBe('lobby');
      expect(host.isPaused).toBe(false);
    } finally {
      host.leave();
    }
  });

  it('an online host ignores it (other people are playing)', async () => {
    const h = makeHost({ seed: 4 });
    await addClient(h, 'A');
    await runToPlaying(h);
    h.host.setPaused(true);
    expect(h.host.isPaused).toBe(false);
    const t0 = h.sims[0].time;
    await sleep(300);
    expect(h.sims[0].time).toBeGreaterThan(t0 + 0.1);
  });
});

describe('setLocalLoading (the match clock waits for the local view)', () => {
  it('host: stays in "loading" until the view is ready', async () => {
    const { host } = localHost({ loadTimeout: 5 });
    const d = deferred();
    let calls = 0;
    host.on('matchStart', () => {
      calls++;
      host.setLocalLoading(d.promise); // synchronously, from the UI's matchStart handler
    });
    try {
      host.start();
      await waitFor(() => calls === 1, 5000, 'matchStart');
      expect(host.phase).toBe('loading');
      await sleep(400);
      expect(host.phase).toBe('loading');
      expect(host.debugState().loopRunning).toBe(false);
      d.resolve();
      await waitFor(() => host.phase === 'playing', 1000, 'playing after ready');
    } finally {
      host.leave();
    }
  });

  it('host: a view that never gets ready is capped by loadTimeout', async () => {
    const { host } = localHost({ loadTimeout: 0.5 });
    let at = 0;
    host.on('matchStart', () => {
      at = performance.now();
      host.setLocalLoading(new Promise<void>(() => {}));
    });
    try {
      host.start();
      await waitFor(() => host.phase === 'playing', 5000, 'playing by timeout');
      expect(performance.now() - at).toBeGreaterThanOrEqual(450);
    } finally {
      host.leave();
    }
  });

  it('host: a failed view load does not block the match', async () => {
    const { host } = localHost({ loadTimeout: 5 });
    const warn = console.warn;
    console.warn = () => {};
    host.on('matchStart', () => host.setLocalLoading(Promise.reject(new Error('context lost'))));
    try {
      host.start();
      await waitFor(() => host.phase === 'playing', 5000, 'playing');
    } finally {
      console.warn = warn;
      host.leave();
    }
  });

  it('client: "loaded" is reported when its view is ready, so the host waits for it', async () => {
    const h = makeHost({ seed: 5, timings: { loadTimeout: 5 } });
    const a = await addClient(h, 'A');
    const d = deferred();
    a.session.on('matchStart', () => a.session.setLocalLoading(d.promise));
    autoPick(h);
    h.host.start();
    await waitFor(() => a.session.view !== null, 5000, 'client view');
    await sleep(400);
    expect(h.host.phase).toBe('loading');
    d.resolve();
    await waitFor(() => h.host.phase === 'playing', 1000, 'host playing');
  });

  it('without it nothing changes: the match starts as soon as everyone loaded', async () => {
    const { host } = localHost({ loadTimeout: 30 });
    try {
      host.start();
      await waitFor(() => host.phase === 'playing', 5000, 'playing');
    } finally {
      host.leave();
    }
  });
});

describe('focusHero / pickHint', () => {
  it('a guest who looked at 华佗 but never confirmed gets 华佗 when the timer runs out', async () => {
    const h = makeHost({ seed: 11, heroes: HEROES, settings: { freePick: true }, timings: { lordPick: 0.4, pick: 0.6 } });
    const a = await addClient(h, 'A');
    h.host.on('heroSelect', (v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) h.host.pickHero(v.options.includes('huatuo') ? v.options.find((x) => x !== 'huatuo')! : v.options[0]);
    });
    a.session.on('heroSelect', (v) => {
      if (v.options.includes('huatuo')) a.session.focusHero('huatuo');
    });
    h.host.start();
    await waitFor(() => h.host.phase === 'loading' || h.host.phase === 'playing', 6000, 'picks done');
    const seat = a.session.mySeat;
    expect(h.sims[0].init.seats.find((s) => s.seat === seat)?.heroId).toBe('huatuo');
  });

  it('the host player’s own hint works the same way', async () => {
    const h = makeHost({ seed: 12, heroes: HEROES, settings: { freePick: true }, timings: { lordPick: 0.4, pick: 0.6 } });
    h.host.on('heroSelect', (v) => {
      if (v.options.includes('huatuo')) h.host.focusHero('huatuo');
    });
    h.host.start();
    await waitFor(() => h.sims.length === 1, 6000, 'picks done');
    expect(h.sims[0].init.seats.find((s) => s.seat === 0)?.heroId).toBe('huatuo');
  });

  it('an invalid hint (not offered / unknown / garbage) is ignored', async () => {
    const h = makeHost({ seed: 13, timings: { lordPick: 0.4, pick: 0.6 } });
    const a = await addClient(h, 'A');
    let offered: string[] = [];
    h.host.on('heroSelect', (v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) h.host.pickHero(v.options[0]);
    });
    a.session.on('heroSelect', (v) => {
      if (v.options.length === 0) return;
      offered = v.options;
      const notOffered = testHeroPool().find((x) => !v.options.includes(x.id))!.id;
      a.session.focusHero(notOffered);
      a.session.focusHero('huatuo'); // not in this pool at all
      a.session.focusHero('x'.repeat(500));
    });
    h.host.start();
    await waitFor(() => h.sims.length === 1, 6000, 'picks done');
    const hero = h.sims[0].init.seats.find((s) => s.seat === a.session.mySeat)?.heroId;
    expect(offered).toContain(hero); // a regular auto-pick from its own options
  });
});

describe('debug hooks on the host', () => {
  it('setDebugTimeScale runs the sim faster (APP-1), also for the next match', async () => {
    const h = makeHost({ seed: 14 });
    h.host.setDebugTimeScale(4);
    await runToPlaying(h);
    const t0 = h.sims[0].time;
    const w0 = performance.now();
    await sleep(500);
    const simDt = h.sims[0].time - t0;
    const realDt = (performance.now() - w0) / 1000;
    expect(simDt / realDt).toBeGreaterThan(2.5);
    h.host.setDebugTimeScale(1);
  });

  it('debugCheats degrade to false on a sim without the hooks (FakeSim)', async () => {
    const h = makeHost({ seed: 15 });
    expect(h.host.debugCheats.god('host', true)).toBe(false); // no match yet
    await runToPlaying(h);
    expect(h.host.debugCheats.give('host', 'tao')).toBe(false);
    expect(h.host.debugCheats.teleport('host', 1, 2)).toBe(false);
    expect(h.host.debugCheats.killHero(1)).toBe(false);
    expect(h.host.debugCheats.setCooldownsReady('host')).toBe(false);
  });
});
