// Playtest round 2, multiplayer (MP2): a host still loading must not take the guests
// down (they wait on 'loading' for its clock; a relay-watched host is never given up
// on), human heroes are shielded until their owners take the controls, a rejoin that
// cannot find the host never says "the host left", a duplicated tab does not start a
// reconnect storm, late players get the real final table, and a guest at < 1 fps keeps
// getting delta snapshots.
import { afterEach, describe, expect, it } from 'vitest';
import { emptyInput, type MatchPhase } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { HostSession } from '../../../src/net/hostSession';
import type { Transport } from '../../../src/net/transport';
import { flatMap, testHeroPool, waitFor } from './fixtures';
import { FakeSim } from '../../../src/net/fakeSim';
import { addClient, autoPick, cleanupHarness, drive, FAST, loopbackReconnect, makeHost, runToPlaying, type ClientRec } from './harness';

afterEach(cleanupHarness);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('MP2-1: the host loading its own view', () => {
  it("guests stay on 'loading' (等待房主加载…) until the host's clock runs, then play", async () => {
    const h = makeHost({ seed: 61, timings: { loadTimeout: 0.2, localLoadTimeout: 30 } });
    const a = await addClient(h, 'A');
    const hostView = deferred();
    h.host.on('matchStart', () => h.host.setLocalLoading(hostView.promise));
    const phases: MatchPhase[] = [];
    a.session.on('phase', (p) => phases.push(p));
    autoPick(h);
    h.host.start();
    await waitFor(() => a.session.view !== null, 5000, 'guest view built');
    await sleep(600); // 3 × loadTimeout: the guest loaded long ago, the host has not
    expect(h.host.phase).toBe('loading');
    expect(a.session.phase).toBe('loading');
    expect(a.session.awaitingHostStart).toBe(true);
    expect(phases).not.toContain('playing');
    hostView.resolve();
    await waitFor(() => a.session.phase === 'playing', 2000, 'guest playing on the first snapshot');
    expect(a.session.awaitingHostStart).toBe(false);
    expect(phases.slice(-2)).toEqual(['loading', 'playing']);
  });

  it('a guest whose relay watches the host waits for a silent host past every timeout; without it the link is lost', async () => {
    const h = makeHost({ seed: 62 });
    const a = await addClient(h, 'A', { hostTimeoutMs: 300, hostLoadingTimeoutMs: 300, checkIntervalMs: 50, waitingStatusMs: 100 });
    let watched = true;
    (a.transport as Transport).hostPresenceWatched = () => watched;
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    await runToPlaying(h);
    h.net.sever(a.session.myId); // the host's page is frozen (its relay socket still open)
    await sleep(1500); // 5 × the timeout
    expect(errors).toEqual([]);
    expect(a.session.waitingForHost).toBe(true);
    expect(a.session.hostSilentMs).toBeGreaterThan(1000); // the chip's seconds counter
    h.net.restore(a.session.myId);
    await waitFor(() => !a.session.waitingForHost, 2000, 'host back');
    expect(a.session.hostSilentMs).toBeLessThan(500);
    // the relay stopped answering: the host's silence counts again
    watched = false;
    h.net.sever(a.session.myId);
    await waitFor(() => errors.length > 0, 3000, 'lost');
    expect(errors).toEqual(['connectionLost']);
  });
});

describe('MP2-1: spawn shield until the owner takes the controls', () => {
  const invuln = (sim: FakeSim, playerId: string) => {
    const id = sim.entityOf(playerId);
    return id !== null && sim.hasStatus(id, 'invuln') && sim.hasStatus(id, 'untargetable');
  };

  it('every human hero starts invulnerable + untargetable; the first active input (not a neutral frame) ends it; bots never have it', async () => {
    const h = makeHost({ seed: 63 });
    const a = await addClient(h, 'A');
    const b = await addClient(h, 'B');
    await runToPlaying(h);
    const sim = h.sims[0];
    expect(h.host.shieldedSeats).toEqual([0, a.session.mySeat, b.session.mySeat].sort());
    for (const id of [h.host.myId, a.session.myId, b.session.myId]) expect(invuln(sim, id)).toBe(true);
    const bots = h.host.lobby.seats.filter((s) => s.isBot);
    expect(bots.length).toBeGreaterThan(0);
    for (const s of bots) expect(invuln(sim, s.playerId)).toBe(false);
    // the guests' views render (neutral frames, looking around): still shielded
    await drive(h, 0.4, (c) => c.session.view?.pushInput({ ...emptyInput(), yaw: 0.3 }));
    expect(invuln(sim, a.session.myId)).toBe(true);
    // A walks: its shield ends; B only looks
    await drive(h, 0.4, (c) => c.session.view?.pushInput(c === a ? { ...emptyInput(), moveZ: 1 } : { ...emptyInput(), yaw: 0.5 }));
    await waitFor(() => !invuln(sim, a.session.myId), 2000, 'A unshielded');
    expect(invuln(sim, b.session.myId)).toBe(true);
    // the host player fires
    h.host.view?.pushInput({ ...emptyInput(), buttons: 1 });
    expect(invuln(sim, h.host.myId)).toBe(false);
    expect(h.host.shieldedSeats).toEqual([b.session.mySeat]);
    // B drops: a bot plays its hero now — no shield (FAST: no drop grace)
    const bId = b.session.myId;
    h.net.dropClient(bId);
    await waitFor(() => sim.conversions.some((c) => c.kind === 'bot' && c.playerId === bId), 2000, 'bot');
    expect(invuln(sim, bId)).toBe(false);
    expect(h.host.shieldedSeats).toEqual([]);
  });

  it('runs out by itself after timings.spawnShield', async () => {
    const h = makeHost({ seed: 64, timings: { spawnShield: 0.3 } });
    const a = await addClient(h, 'A');
    await runToPlaying(h);
    const sim = h.sims[0];
    expect(invuln(sim, a.session.myId)).toBe(true);
    await waitFor(() => sim.time > 0.35, 3000, 'sim time');
    expect(invuln(sim, a.session.myId)).toBe(false);
    await waitFor(() => h.host.shieldedSeats.length === 0, 1000, 'forgotten');
  });

  it('single player: no shield (the match starts frozen behind 「点击进入战场」 instead)', async () => {
    const sims: FakeSim[] = [];
    const host = new HostSession({
      name: 'solo',
      transport: null,
      heroes: testHeroPool(),
      timings: FAST,
      seed: 3,
      preferWorkerTicker: false,
      createMatch: (init) => {
        const s = new FakeSim(init, { map: flatMap() });
        sims.push(s);
        return s;
      },
    });
    try {
      host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && host.pickHero(v.options[0]));
      host.start();
      await waitFor(() => host.phase === 'playing', 5000, 'playing');
      expect(host.shieldedSeats).toEqual([]);
      expect(sims[0].hasStatus(sims[0].entityOf('local')!, 'invuln')).toBe(false);
    } finally {
      host.leave();
    }
  });
});

describe('MP2-4: a duplicated tab (same seat token in two tabs)', () => {
  it('the replaced tab is told 你已在其他窗口进入该房间 and does not rejoin — no reconnect storm', async () => {
    const h = makeHost({ seed: 65 });
    let a: ClientRec | undefined;
    let rejoins = 0;
    const reconnect = loopbackReconnect(h, () => a);
    a = await addClient(h, 'A', {
      reconnect: () => {
        rejoins++;
        return reconnect();
      },
      rejoinDelaysMs: [0, 50],
    });
    await addClient(h, 'B');
    await runToPlaying(h);
    const seat = a.session.mySeat;
    const errors: { code: string; zh: string }[] = [];
    a.session.on('error', (e) => errors.push(e));
    // the duplicate: a new tab presenting the same token (sessionStorage copied)
    const t = await h.net.connect();
    const dup = await ClientSession.connect({ transport: t, name: 'A', token: a.session.seatToken!, mapFactory: () => flatMap(), hostWarmUpMs: 0 });
    try {
      expect(dup.mySeat).toBe(seat);
      await waitFor(() => errors.length > 0, 2000, 'old tab told');
      expect(errors[0]).toMatchObject({ code: 'replacedElsewhere', zh: '你已在其他窗口进入该房间' });
      await sleep(600);
      expect(rejoins).toBe(0);
      // the new tab keeps the seat: one human there, no churn
      const rec = h.host.lobby.seats.find((s) => s.seat === seat)!;
      expect(rec).toMatchObject({ playerId: dup.myId, isBot: false });
      await waitFor(() => dup.phase === 'playing', 3000, 'dup plays');
    } finally {
      dup.leave();
    }
  });
});

describe('MP2-5: game over carries the final table', () => {
  it('a player still loading (back from a reload) when the match ends gets the real kills', async () => {
    const h = makeHost({ seed: 66, fake: { endAfterSeconds: 1.2 }, timings: { postGame: 0.1 } });
    const a = await addClient(h, 'A');
    const b = await addClient(h, 'B');
    await runToPlaying(h);
    const sim = h.sims[0];
    sim.kill(b.session.mySeat, a.session.mySeat); // A: 1 kill
    // A reloads: a new page presents its token and loads the match view slowly (no 'loaded' yet)
    const token = a.session.seatToken!;
    a.transport.close();
    const t = await h.net.connect();
    const fresh = await ClientSession.connect({ transport: t, name: 'A', token, mapFactory: () => flatMap(), hostWarmUpMs: 0 });
    fresh.on('matchStart', () => fresh.setLocalLoading(new Promise<void>(() => undefined)));
    try {
      await waitFor(() => fresh.phase === 'gameOver', 5000, 'results');
      const me = fresh.view!.players().find((p) => p.name === 'A');
      expect(me?.kills).toBe(1);
      expect(fresh.view!.players().length).toBe(h.host.lobby.seats.length);
    } finally {
      fresh.leave();
    }
  });
});

describe('MP2-6: acknowledgements without input packets', () => {
  it('a guest that renders no frames (rAF held) still acknowledges snapshots: deltas, not full ones', async () => {
    const h = makeHost({ seed: 67 });
    const a = await addClient(h, 'A');
    await runToPlaying(h);
    // no view.update / pushInput at all: not a single input packet carries an ack
    await sleep(2500); // > DELTA_HISTORY (1.6 s)
    const st = a.session.snapshotStats!;
    expect(st.full + st.delta).toBeGreaterThan(30);
    expect(st.full).toBeLessThanOrEqual(2);
    expect(st.delta).toBeGreaterThan(st.full * 10);
  });
});
