// Connection blips and stalls: a rejoin into the running match keeps the
// client's view (no loading screen, no renderer rebuild, no bot bounce);
// watchdogs on both sides tolerate a frozen page; a player who comes back after
// the match ended sees the real results; a client at a very low frame rate
// still moves at full speed on the host.
import { afterEach, describe, expect, it } from 'vitest';
import { emptyInput, PROTOCOL_VERSION, SIM_DT, type MatchPhase } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import type { ClientView } from '../../../src/net/clientView';
import { encodeJson } from '../../../src/net/codec';
import type { ViewSource } from '../../../src/render/view';
import type { HostMsg } from '../../../src/net/protocol';
import { WALK_SPEED } from '../../../src/sim/physics';
import { flatMap, waitFor } from './fixtures';
import { addClient, autoPick, cleanupHarness, drive, loopbackReconnect, makeHost, runToPlaying, type ClientRec } from './harness';
import { receivedEvents } from './leakScan';

afterEach(cleanupHarness);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = (c: ClientRec) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1 });

/** Block this (single) JS thread — every host, client and timer in the process freezes, like a page stuck compiling shaders. */
function freeze(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* busy */
  }
}

describe('rejoin into the running match', () => {
  it('a blip keeps the same ClientView, never shows "loading" and never hands the hero to a bot', async () => {
    const h = makeHost({ seed: 9, timings: { dropGrace: 3 } });
    let a: ClientRec | undefined;
    a = await addClient(h, '阿强', { reconnect: loopbackReconnect(h, () => a), rejoinDelaysMs: [0, 200, 400] });
    const b = await addClient(h, 'B');
    await runToPlaying(h);
    await drive(h, 0.4, W);
    const sim = h.sims[0];
    const view = a.session.view as ClientView;
    const seat = a.session.mySeat;
    const oldId = a.session.myId;
    const phases: MatchPhase[] = [];
    const starts: ViewSource[] = [];
    const statuses: string[] = [];
    const hostNotices: string[] = [];
    a.session.on('phase', (p) => phases.push(p));
    a.session.on('matchStart', (v) => starts.push(v));
    a.session.on('status', (s) => statuses.push(s.en));
    h.host.on('status', (s) => hostNotices.push(s.en));
    b.session.on('status', (s) => hostNotices.push(`B: ${s.en}`));
    const tick0 = view.debugInfo().newestTick;

    h.net.dropClient(oldId); // both sides see the link close (a relay socket closing)
    await waitFor(() => a!.session.myId !== oldId && starts.length === 1, 3000, 'rejoined');
    expect(starts[0]).toBe(view); // re-emitted with the same view: app.mountMatch keeps the renderer
    expect(a.session.view).toBe(view);
    expect(phases).not.toContain('loading');
    expect(a.session.phase).toBe('playing');
    expect(statuses).toContain('Reconnected');

    await drive(h, 0.6, W);
    expect(view.debugInfo().newestTick).toBeGreaterThan(tick0); // the kept view is fed again
    expect(view.localId()).toBe(sim.entityOf(a.session.myId));
    expect(view.local()).not.toBeNull();
    expect(sim.inputLog.some((x) => x.playerId === a!.session.myId)).toBe(true);
    // seamless: the seat never became a bot, nobody was told it dropped
    expect(sim.conversions.filter((c) => c.kind === 'bot')).toEqual([]);
    expect(sim.conversions).toContainEqual({ kind: 'human', playerId: a.session.myId, seat });
    expect(hostNotices.filter((n) => /disconnected|reconnected/.test(n))).toEqual([]);
    const announces = receivedEvents(b.log).filter((e) => e.t === 'announce').map((e) => String(e.en));
    expect(announces.filter((x) => /disconnected/.test(x))).toEqual([]);
  });

  it('a player who stays away longer than the drop grace is replaced by a bot, then reclaims the hero', async () => {
    const h = makeHost({ seed: 10, timings: { dropGrace: 0.3 } });
    const a = await addClient(h, 'A');
    await addClient(h, 'B');
    await runToPlaying(h);
    const sim = h.sims[0];
    const seat = a.session.mySeat;
    const token = a.session.seatToken!;
    h.net.dropClient(a.session.myId);
    await sleep(150);
    expect(sim.conversions.some((c) => c.kind === 'bot')).toBe(false); // still within the grace
    await waitFor(() => sim.conversions.some((c) => c.kind === 'bot'), 2000, 'bot takes over');
    const back = await addClient(h, 'A', { token });
    expect(back.session.mySeat).toBe(seat);
    await waitFor(() => back.session.phase === 'playing', 3000, 'reclaimed');
    expect(sim.conversions.at(-1)).toEqual({ kind: 'human', playerId: back.session.myId, seat });
  });

  it('host: a player loading the match (frozen page, no pongs) is not timed out before it reports loaded', async () => {
    const h = makeHost({ seed: 12, timings: { peerTimeout: 0.5, loadTimeout: 10, loadGrace: 10 } });
    const t = await h.net.connect('frozen');
    const got: HostMsg[] = [];
    let loadedSent = false;
    t.onMessage((_f, d) => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as HostMsg;
      got.push(m);
      if (m.t === 'heroSelect' && m.view.options.length > 0 && m.view.picks[1] === undefined) t.send('host', encodeJson({ t: 'pick', heroId: m.view.options[0] }));
      // before the match: a live page answers pings; while loading it is frozen
      if (m.t === 'ping' && (!got.some((x) => x.t === 'matchStart') || loadedSent)) t.send('host', encodeJson({ t: 'pong', id: m.id, ts: m.ts }));
    });
    t.send('host', encodeJson({ t: 'hello', v: PROTOCOL_VERSION, name: 'frozen' }));
    await waitFor(() => got.some((m) => m.t === 'welcome'), 2000, 'welcome');
    autoPick(h);
    h.host.start();
    await waitFor(() => got.some((m) => m.t === 'matchStart'), 5000, 'matchStart');
    await sleep(1500); // 3 × peerTimeout without a word
    expect(h.host.lobby.seats.find((s) => s.name === 'frozen')?.isBot).toBe(false);
    expect(h.host.phase).toBe('loading');
    t.send('host', encodeJson({ t: 'loaded' }));
    loadedSent = true;
    await waitFor(() => h.host.phase === 'playing', 2000, 'playing');
    // the grace ends with 'loaded': a peer that then goes silent is dropped as usual
    loadedSent = false;
    h.net.sever('frozen');
    await waitFor(() => h.host.lobby.seats.find((s) => s.name === 'frozen')?.isBot === true, 3000, 'timed out after loaded');
  });
});

describe('stall-aware connection watchdogs (APP-6)', () => {
  it('host: after its own page froze longer than peerTimeout, nobody is dropped', async () => {
    const h = makeHost({ seed: 13, timings: { pingInterval: 0.2, peerTimeout: 0.6 } });
    const a = await addClient(h, 'A');
    const b = await addClient(h, 'B');
    await runToPlaying(h);
    const notices: string[] = [];
    h.host.on('status', (s) => notices.push(s.en));
    freeze(2000); // > peerTimeout and > 2 × pingInterval + 1 s
    await drive(h, 1.0, W);
    expect(notices.filter((n) => /disconnected|left/.test(n))).toEqual([]);
    expect(h.host.lobby.seats.filter((s) => !s.isBot).map((s) => s.name).sort()).toEqual(['A', 'B', '房主'].sort());
    expect(a.session.phase).toBe('playing');
    expect(b.session.phase).toBe('playing');
  });

  it('client: after its own page froze longer than hostTimeout, it does not declare the host lost', async () => {
    const h = makeHost({ seed: 14 });
    const errors: string[] = [];
    const statuses: string[] = [];
    const a = await addClient(h, 'A', { hostTimeoutMs: 800, checkIntervalMs: 100 });
    a.session.on('error', (e) => errors.push(e.code));
    a.session.on('status', (s) => statuses.push(s.en));
    await runToPlaying(h);
    freeze(1500); // > hostTimeout and > 2 × check interval + 1 s
    await drive(h, 1.0, W);
    expect(errors).toEqual([]);
    expect(statuses.filter((s) => /lost/.test(s))).toEqual([]);
    expect(a.session.phase).toBe('playing');
  });

  it('client: without the stall allowance a truly silent host is still detected', async () => {
    const h = makeHost({ seed: 15 });
    const errors: string[] = [];
    const a = await addClient(h, 'A', { hostTimeoutMs: 600, checkIntervalMs: 100 });
    a.session.on('error', (e) => errors.push(e.code));
    h.net.sever(a.session.myId);
    await waitFor(() => errors.includes('connectionLost'), 3000, 'connectionLost');
  });

  it('client: "Waiting for host…" after a few silent seconds, cleared when the host speaks again', async () => {
    const h = makeHost({ seed: 16 });
    const statuses: { en: string; key?: string; clear?: boolean }[] = [];
    const a = await addClient(h, 'A', { waitingStatusMs: 400, checkIntervalMs: 100, hostTimeoutMs: 10_000 });
    a.session.on('status', (s) => statuses.push(s));
    await runToPlaying(h);
    h.net.sever(a.session.myId); // the host goes quiet (frozen host page, stuck relay)
    await waitFor(() => a.session.waitingForHost, 2000, 'waiting status');
    expect(statuses.at(-1)).toEqual({ zh: '等待主机响应…', en: 'Waiting for host…', key: 'waitingHost' });
    expect(a.session.phase).toBe('playing');
    h.net.restore(a.session.myId);
    await waitFor(() => !a.session.waitingForHost, 3000, 'host back');
    expect(statuses.at(-1)).toMatchObject({ key: 'waitingHost', clear: true });
    expect(statuses.filter((s) => s.key === 'waitingHost')).toHaveLength(2);
  });
});

describe('rejoin after the match ended', () => {
  async function toGameOver() {
    const h = makeHost({ seed: 17, fake: { endAfterSeconds: 0.6 }, timings: { postGame: 0.1 } });
    let a: ClientRec | undefined;
    a = await addClient(h, 'A', { reconnect: loopbackReconnect(h, () => a), rejoinDelaysMs: [0, 200] });
    await addClient(h, 'B');
    await runToPlaying(h);
    await waitFor(() => a!.session.phase === 'gameOver' && h.host.phase === 'gameOver', 5000, 'game over');
    await sleep(300); // the post-game ticks are over: no snapshot will ever come again
    expect(h.host.debugState().loopRunning).toBe(false);
    return { h, a: a! };
  }

  it('a page reload (new session + seat token) shows the real results and follows the host back to the lobby in its seat', async () => {
    const { h, a } = await toGameOver();
    const seat = a.session.mySeat;
    const token = a.session.seatToken!;
    a.transport.close(); // the page went away
    const phases: MatchPhase[] = [];
    const t = await h.net.connect();
    const fresh = await ClientSession.connect({ transport: t, name: 'A', token, mapFactory: () => flatMap() });
    try {
      fresh.on('phase', (p) => phases.push(p));
      expect(fresh.phase).toBe('loading'); // never "gameOver" without the results to show
      await waitFor(() => fresh.phase === 'gameOver', 3000, 'results');
      expect(fresh.mySeat).toBe(seat);
      expect(fresh.result?.winner).toBe('lord');
      const view = fresh.view!;
      expect(view.result()).toEqual(fresh.result);
      const players = view.players();
      expect(players.length).toBe(h.host.lobby.seats.length);
      expect(players.map((p) => p.name)).toContain('A');
      expect(players.every((p) => p.entityId > 0)).toBe(true);
      h.host.returnToLobby();
      await waitFor(() => fresh.phase === 'lobby', 2000, 'back to lobby');
      expect(fresh.mySeat).toBe(seat);
      expect(fresh.lobby?.seats.find((s) => s.seat === seat)).toMatchObject({ name: 'A', isBot: false });
      expect(phases).toEqual(['gameOver', 'lobby']);
    } finally {
      fresh.leave();
    }
  });

  it('an automatic rejoin during game over keeps the results on screen', async () => {
    const { h, a } = await toGameOver();
    const view = a.session.view!;
    const result = a.session.result;
    const phases: MatchPhase[] = [];
    a.session.on('phase', (p) => phases.push(p));
    const oldId = a.session.myId;
    h.net.dropClient(oldId);
    await waitFor(() => a.session.myId !== oldId && !a.session.reconnecting, 3000, 'rejoined');
    await sleep(100);
    expect(a.session.view).toBe(view);
    expect(a.session.result).toEqual(result);
    expect(a.session.phase).toBe('gameOver');
    expect(phases.filter((p) => p !== 'gameOver')).toEqual([]);
    expect(view.players().length).toBeGreaterThan(0);
    const seat = a.session.mySeat;
    h.host.returnToLobby();
    await waitFor(() => a.session.phase === 'lobby', 2000, 'back to lobby');
    expect(a.session.mySeat).toBe(seat);
  });
});

describe('input at a very low frame rate', () => {
  it('a guest rendering every 500 ms still moves at full speed on the host', async () => {
    const h = makeHost({ seed: 18 });
    const a = await addClient(h, 'A');
    await runToPlaying(h);
    const sim = h.sims[0];
    const view = a.session.view!;
    const hero = () => {
      const id = sim.entityOf(a.session.myId)!;
      return sim.snapshotFor(a.session.myId).ents.find((e) => e.id === id)!;
    };
    const frame = async () => {
      view.pushInput({ ...emptyInput(), moveZ: 1 });
      view.update(0.5); // one render frame every 500 ms
      await sleep(500);
    };
    // two frames to settle (the host learns this client's cadence from its first gap)
    await frame();
    await frame();
    const p0 = hero();
    const t0 = sim.time;
    for (let i = 0; i < 6; i++) await frame();
    const p1 = hero();
    const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const expected = WALK_SPEED * (sim.time - t0);
    expect(sim.time - t0).toBeGreaterThan(2.5);
    expect(dist / expected).toBeGreaterThan(0.9);
    expect(dist / expected).toBeLessThan(1.1);
    // prediction agrees: one predicted step per host tick
    const shown = view.get(view.localId()!)!;
    expect(Math.hypot(shown.x - p1.x, shown.z - p1.z)).toBeLessThan(WALK_SPEED * 0.6 + SIM_DT * WALK_SPEED * 3);
  });

  it('a normal-rate guest that goes silent still gets neutral controls after ~250 ms', async () => {
    const h = makeHost({ seed: 19 });
    const a = await addClient(h, 'A');
    await runToPlaying(h);
    await drive(h, 0.6, W);
    const sim = h.sims[0];
    const id = sim.entityOf(a.session.myId)!;
    const pos = () => sim.snapshotFor(a.session.myId).ents.find((e) => e.id === id)!;
    const n0 = sim.inputLog.length;
    await sleep(600);
    // the host released the controls (seq 0 neutral frame) and the hero stopped
    expect(sim.inputLog.slice(n0).some((x) => x.playerId === a.session.myId && x.seq === 0)).toBe(true);
    const p0 = pos();
    await sleep(200);
    const p1 = pos();
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(0.3);
  });
});
