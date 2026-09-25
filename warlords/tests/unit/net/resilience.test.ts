// Robustness of the session layer: silent clients, hostile input, seat reclaim
// (token / stale connection / automatic rejoin), failures while loading or
// simulating, and page focus handling.
import { afterEach, describe, expect, it } from 'vitest';
import { BTN_FIRE, emptyInput, PROTOCOL_VERSION, type InputAction, type InputFrame } from '../../../src/core/types';
import type { MatchInit } from '../../../src/sim/host';
import { encodeInputMsg, encodeJson } from '../../../src/net/codec';
import { FakeSim } from '../../../src/net/fakeSim';
import { INPUT_STALE_TICKS } from '../../../src/net/hostSession';
import { LocalView } from '../../../src/net/localView';
import type { LoopbackTransport } from '../../../src/net/loopback';
import type { HostMsg, InputPacket } from '../../../src/net/protocol';
import { sanitizeAction, sanitizeActions, sanitizeFrame, MAX_ACTIONS_PER_FRAME } from '../../../src/net/validate';
import { flatMap, waitFor } from './fixtures';
import { addClient, autoPick, cleanupHarness, drive, loopbackReconnect, makeHost, runToPlaying, type ClientRec, type Harness } from './harness';

afterEach(cleanupHarness);

interface RawClient {
  t: LoopbackTransport;
  got: HostMsg[];
  send(pkt: InputPacket): void;
}

/** A hand-driven client: hello, answers pings, reports 'loaded' at match start. */
async function rawClient(h: Harness, id: string, name: string): Promise<RawClient> {
  const t = await h.net.connect(id);
  const got: HostMsg[] = [];
  t.onMessage((_f, d) => {
    if (typeof d !== 'string') return;
    const m = JSON.parse(d) as HostMsg;
    got.push(m);
    if (m.t === 'matchStart') t.send('host', encodeJson({ t: 'loaded' }));
    if (m.t === 'ping') t.send('host', encodeJson({ t: 'pong', id: m.id, ts: m.ts }));
  });
  t.send('host', encodeJson({ t: 'hello', v: PROTOCOL_VERSION, name }));
  await waitFor(() => got.some((m) => m.t === 'welcome'), 2000, 'welcome');
  return { t, got, send: (pkt) => t.send('host', encodeInputMsg(pkt), 'unreliable') };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('silent clients', () => {
  it('a client that stops sending input gets neutral controls after ~250 ms (keeps its aim)', async () => {
    const h = makeHost({ seed: 5 });
    const raw = await rawClient(h, 'raw1', 'raw');
    autoPick(h);
    h.host.start();
    await waitFor(() => h.host.phase === 'playing', 5000);
    const sim = h.sims[0];
    // hold forward + fire for ~0.5 s at 30 Hz, then go silent (hidden tab)
    let seq = 0;
    const timer = setInterval(() => {
      seq++;
      raw.send({ frame: { ...emptyInput(seq), moveZ: 1, yaw: 0.7, buttons: BTN_FIRE }, history: [] });
    }, 1000 / 30);
    await sleep(500);
    clearInterval(timer);
    const lastRealAt = sim.tick;
    await sleep(600);
    const mine = sim.inputLog.filter((x) => x.playerId === 'raw1');
    const neutralIdx = mine.findIndex((x) => x.seq === 0);
    expect(neutralIdx).toBeGreaterThan(5); // only after the real frames
    expect(mine.slice(neutralIdx + 1)).toHaveLength(0); // applied once
    const hero = () => sim.snapshotFor('raw1').ents.find((e) => e.id === sim.entityOf('raw1'))!;
    // FakeSim keeps the whole frame: moveZ / buttons released, yaw kept
    const snapYou = sim.snapshotFor('raw1').you!;
    expect(snapYou).toBeTruthy();
    const pos1 = { x: hero().x, z: hero().z };
    await sleep(300);
    const pos2 = { x: hero().x, z: hero().z };
    expect(Math.hypot(pos2.x - pos1.x, pos2.z - pos1.z)).toBeLessThan(0.01); // stopped
    expect(hero().yaw).toBeCloseTo(0.7, 2); // aim kept
    expect(sim.tick - lastRealAt).toBeGreaterThan(INPUT_STALE_TICKS);
  });

  it('LocalView: releaseInput lets go of the controls; suspended views ignore input', () => {
    const init: MatchInit = {
      settings: { playerCount: 5, mode: 'standard', botDifficulty: 'normal', heroChoices: 3, freePick: false, mapSeed: 1, friendlyFire: true, troopsPerHero: 0 },
      seats: [{ seat: 0, playerId: 'local', name: 'me', isBot: false, role: 'lord', heroId: 'liubei' }],
      seed: 1,
    };
    const sim = new FakeSim(init, { map: flatMap(), troopsPerHero: 0 });
    const view = new LocalView(sim, 'local', () => 1);
    const held: InputFrame = { ...emptyInput(1), moveZ: 1, yaw: 1.2, pitch: 0.1, buttons: BTN_FIRE };
    view.pushInput(held);
    view.releaseInput();
    const last = sim.inputLog[sim.inputLog.length - 1];
    expect(last.seq).toBe(0);
    view.setSuspended(true);
    const n = sim.inputLog.length;
    view.pushInput({ ...held, seq: 2 });
    expect(sim.inputLog).toHaveLength(n); // ignored while hidden
    view.setSuspended(false);
    view.pushInput({ ...held, seq: 3 });
    expect(sim.inputLog[sim.inputLog.length - 1].seq).toBe(3);
  });
});

describe('input validation', () => {
  it('sanitizes actions: known kinds with valid parameters only', () => {
    expect(sanitizeAction({ a: 'jump' })).toEqual({ a: 'jump' });
    expect(sanitizeAction({ a: 'ability', slot: 'q' })).toEqual({ a: 'ability', slot: 'q' });
    expect(sanitizeAction({ a: 'ability', slot: 'x' })).toBeNull();
    expect(sanitizeAction({ a: 'weapon', slot: 1 })).toEqual({ a: 'weapon', slot: 1 });
    expect(sanitizeAction({ a: 'weapon', slot: 2 })).toBeNull();
    expect(sanitizeAction({ a: 'item', slot: 3 })).toEqual({ a: 'item', slot: 3 });
    expect(sanitizeAction({ a: 'item', slot: 1.5 })).toBeNull();
    expect(sanitizeAction({ a: 'drop', slot: 1, what: 'weapon' })).toEqual({ a: 'drop', slot: 1, what: 'weapon' });
    expect(sanitizeAction({ a: 'drop', slot: 3, what: 'weapon' })).toBeNull();
    expect(sanitizeAction({ a: 'command', order: 'charge' })).toEqual({ a: 'command', order: 'charge' });
    expect(sanitizeAction({ a: 'command', order: 'nuke' })).toBeNull();
    expect(sanitizeAction({ a: 'claim', role: 'loyalist' })).toEqual({ a: 'claim', role: 'loyalist' });
    expect(sanitizeAction({ a: 'claim', role: 'emperor' })).toBeNull();
    expect(sanitizeAction({ a: 'quickchat', id: 'followMe' })).toEqual({ a: 'quickchat', id: 'followMe' });
    expect(sanitizeAction({ a: 'quickchat', id: 'x'.repeat(33) })).toBeNull();
    expect(sanitizeAction({ a: 'quickchat', id: '<script>' })).toBeNull();
    expect(sanitizeAction({ a: '__proto__' })).toBeNull();
    expect(sanitizeAction({ a: 'jump', extra: 'x'.repeat(10_000) })).toEqual({ a: 'jump' }); // extra fields dropped
    expect(sanitizeAction(null)).toBeNull();
    expect(sanitizeActions(Array.from({ length: 50 }, () => ({ a: 'reload' })))).toHaveLength(MAX_ACTIONS_PER_FRAME);
  });

  it('clamps frame fields and drops non-finite aim data', () => {
    const f = sanitizeFrame({
      seq: 5,
      moveX: 3,
      moveZ: Number.NaN,
      yaw: Infinity,
      pitch: 9,
      buttons: -1,
      actions: [],
      aimPoint: { x: Number.NaN, y: 0, z: 0 },
      aimTargetId: -3,
      viewTick: 1.5,
    });
    expect(f).toEqual({ seq: 5, moveX: 1, moveZ: 0, yaw: 0, pitch: Math.PI / 2, buttons: 0xffffffff, actions: [] });
  });

  it('the host never passes malformed actions to the sim', async () => {
    const h = makeHost({ seed: 5 });
    const raw = await rawClient(h, 'raw1', 'raw');
    autoPick(h);
    h.host.start();
    await waitFor(() => h.host.phase === 'playing', 5000);
    const junk = [
      { a: 'teleport', to: { x: 0, y: 0, z: 0 } }, // unknown kind (JSON-encoded on the wire)
      { a: 'weapon', slot: 9 },
      { a: 'claim', role: 'emperor' },
      { a: 'quickchat', id: 'x'.repeat(500) },
      { a: 'reload' },
    ] as unknown as InputAction[];
    raw.send({ frame: { ...emptyInput(1), actions: junk }, history: [] });
    await waitFor(() => h.sims[0].inputLog.some((x) => x.playerId === 'raw1'), 2000, 'input applied');
    const applied = h.sims[0].inputLog.filter((x) => x.playerId === 'raw1');
    expect(applied[0].actions).toEqual([{ a: 'reload' }]);
    // a garbage binary frame is ignored without breaking the session
    raw.t.send('host', new Uint8Array([2, 255, 255, 255]), 'unreliable');
    raw.send({ frame: { ...emptyInput(2), actions: [{ a: 'jump' }] }, history: [] });
    await waitFor(() => h.sims[0].inputLog.some((x) => x.playerId === 'raw1' && x.seq === 2), 2000, 'next input');
  });
});

describe('seat reclaim', () => {
  it('a silently dropped client rejoins by itself with its seat token and keeps its hero', async () => {
    const h = makeHost({ seed: 9 });
    let a: ClientRec | undefined;
    a = await addClient(h, '阿强', { hostTimeoutMs: 500, reconnect: loopbackReconnect(h, () => a), rejoinDelaysMs: [0, 200, 400] });
    await addClient(h, 'B');
    const errors: string[] = [];
    const statuses: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    a.session.on('status', (s) => statuses.push(s.en));
    let starts = 0;
    a.session.on('matchStart', () => starts++);
    await runToPlaying(h);
    const sim = h.sims[0];
    const seat = a.session.mySeat;
    const oldId = a.session.myId;
    const token = a.session.seatToken;
    expect(token).toMatch(/^[a-z2-9]{20}$/);
    starts = 0;

    h.net.sever(oldId); // no close, no goodbye: the host still thinks the link is alive
    await waitFor(() => a!.session.myId !== oldId && a!.session.phase === 'playing' && starts === 1, 6000, 'auto rejoin');
    expect(errors).toEqual([]);
    expect(statuses).toContain('Connection lost — reconnecting…');
    expect(statuses).toContain('Reconnected');
    expect(a.session.mySeat).toBe(seat);
    expect(a.session.seatToken).toBe(token);
    expect(sim.conversions).toContainEqual({ kind: 'human', playerId: a.session.myId, seat });
    expect(sim.conversions.some((c) => c.kind === 'bot' && c.playerId === oldId)).toBe(false); // seamless: never a bot
    expect(h.host.lobby.seats.find((s) => s.seat === seat)?.playerId).toBe(a.session.myId);
    expect(h.host.debugState().peers).toBe(2); // the dead connection was dropped
    await drive(h, 0.3, (c) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1 }));
    expect(a.session.view?.localId()).toBe(sim.entityOf(a.session.myId));
    expect(a.session.view?.local()).not.toBeNull();
  });

  it('without a token, a seat is reclaimed by name only once its old connection went silent', async () => {
    const h = makeHost({ seed: 9 });
    const a = await addClient(h, '阿强');
    await runToPlaying(h);
    const seat = a.session.mySeat;
    h.net.sever(a.session.myId);
    // right away the old link still looks alive: someone else using the name is refused
    await expect(addClient(h, '阿强')).rejects.toMatchObject({ code: 'inProgress' });
    await sleep(1300); // > stale threshold with FAST timings (1 s)
    const back = await addClient(h, '阿强');
    expect(back.session.mySeat).toBe(seat);
    await waitFor(() => back.session.phase === 'playing', 3000, 'reclaimed player playing');
  });

  it('a token reclaims the same lobby seat instead of adding a duplicate', async () => {
    const h = makeHost({ seed: 2 });
    const a = await addClient(h, 'A');
    await addClient(h, 'B');
    const seat = a.session.mySeat;
    h.net.sever(a.session.myId);
    const again = await addClient(h, 'A', { token: a.session.seatToken! });
    expect(again.session.mySeat).toBe(seat);
    await waitFor(() => h.host.lobby.seats.length === 3);
    expect(h.host.lobby.seats.map((s) => s.name)).toEqual(['房主', 'A', 'B']);
    expect(h.host.debugState().peers).toBe(2);
  });

  it('a kicked player cannot come back with its token (nor under the same name)', async () => {
    const h = makeHost({ seed: 4 });
    const a = await addClient(h, 'A');
    await addClient(h, 'B');
    await runToPlaying(h);
    const token = a.session.seatToken!;
    h.host.kick(a.session.mySeat);
    await expect(addClient(h, 'A', { token })).rejects.toMatchObject({ code: 'kicked' });
    await expect(addClient(h, 'A')).rejects.toMatchObject({ code: 'kicked' });
  });

  it('a player who reconnects while the sim is still being created is re-bound to its hero', async () => {
    const pending: { init: MatchInit; resolve: (s: FakeSim) => void }[] = [];
    const h = makeHost({
      seed: 6,
      createMatch: (init) => new Promise<FakeSim>((resolve) => pending.push({ init, resolve })),
    });
    const a = await addClient(h, 'A');
    await addClient(h, 'B');
    autoPick(h);
    h.host.start();
    await waitFor(() => h.host.phase === 'loading' && pending.length === 1, 5000, 'loading');
    const seat = a.session.mySeat;
    a.transport.close(); // drop…
    await waitFor(() => h.host.lobby.seats.find((s) => s.seat === seat)?.isBot === true, 2000, 'seat released');
    const back = await addClient(h, 'A'); // …and come back under a new peer id before the sim exists
    expect(back.session.mySeat).toBe(seat);
    const sim = new FakeSim(pending[0].init, { map: flatMap() });
    h.sims.push(sim);
    pending[0].resolve(sim);
    await waitFor(() => back.session.phase === 'playing', 5000, 'playing');
    expect(sim.conversions).toContainEqual({ kind: 'human', playerId: back.session.myId, seat });
    await drive(h, 0.3, (c) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1 }));
    expect(back.session.view?.local()?.entityId).toBe(sim.entityOf(back.session.myId));
    expect(sim.inputLog.some((x) => x.playerId === back.session.myId)).toBe(true);
  });
});

describe('failures', () => {
  it('a client that cannot build the map gives its seat to a bot at once and reports simFailed', async () => {
    const h = makeHost({ seed: 8, timings: { loadTimeout: 10 } });
    const a = await addClient(h, 'A', {
      mapFactory: () => {
        throw new Error('chunk failed to load');
      },
    });
    await addClient(h, 'B');
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    const oldId = a.session.myId;
    autoPick(h);
    const t0 = Date.now();
    h.host.start();
    await waitFor(() => h.host.phase === 'playing', 5000, 'host playing');
    expect(Date.now() - t0).toBeLessThan(4000); // did not wait out the 10 s load timeout
    expect(errors).toEqual(['simFailed']);
    expect(h.sims[0].conversions).toContainEqual({ kind: 'bot', playerId: oldId });
  });

  it('a sim that keeps throwing ends the match with simFailed instead of freezing', async () => {
    class BrokenSim extends FakeSim {
      override step(): void {
        if (this.tick >= 5) throw new Error('boom');
        super.step();
      }
    }
    const h = makeHost({
      seed: 8,
      createMatch: (init) => {
        const s = new BrokenSim(init, { map: flatMap() });
        h.sims.push(s);
        return s;
      },
    });
    const a = await addClient(h, 'A');
    const hostErrors: string[] = [];
    const clientErrors: string[] = [];
    h.host.on('error', (e) => hostErrors.push(e.code));
    a.session.on('error', (e) => clientErrors.push(e.code));
    const logged = console.error;
    console.error = () => {};
    try {
      await runToPlaying(h);
      await waitFor(() => hostErrors.includes('simFailed'), 4000, 'host simFailed');
    } finally {
      console.error = logged;
    }
    await waitFor(() => clientErrors.includes('simFailed') && a.session.phase === 'lobby', 2000, 'client told');
    expect(h.host.phase).toBe('lobby');
    expect(h.host.debugState().loopRunning).toBe(false);
  });
});

describe('page focus', () => {
  it('a hidden tab releases the controls immediately, without waiting for the next frame', async () => {
    const g = globalThis as { document?: unknown; window?: unknown };
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const win = new EventTarget();
    g.document = doc;
    g.window = win;
    try {
      const h = makeHost({ seed: 12 });
      const a = await addClient(h, 'A');
      await runToPlaying(h);
      const sim = h.sims[0];
      await drive(h, 0.3, (c) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1, yaw: 0.4, buttons: BTN_FIRE }));
      const before = sim.inputLog.filter((x) => x.playerId === a.session.myId).length;
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => sim.inputLog.filter((x) => x.playerId === a.session.myId).length > before, 1000, 'neutral frame');
      const frames = sim.inputLog.filter((x) => x.playerId === a.session.myId);
      const heroNow = () => sim.snapshotFor(a.session.myId).ents.find((e) => e.id === sim.entityOf(a.session.myId))!;
      await sleep(150);
      const p1 = heroNow();
      await sleep(200);
      const p2 = heroNow();
      expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeLessThan(0.01);
      expect(frames.length).toBeGreaterThan(before);
      // input pushed while hidden is ignored; showing the page again resumes
      a.session.view!.pushInput({ ...emptyInput(), moveZ: 1 });
      a.session.view!.update(0.1);
      await sleep(100);
      expect(Math.hypot(heroNow().x - p2.x, heroNow().z - p2.z)).toBeLessThan(0.01);
      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await drive(h, 0.3, (c) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1 }));
      expect(Math.hypot(heroNow().x - p2.x, heroNow().z - p2.z)).toBeGreaterThan(0.5);
    } finally {
      delete g.document;
      delete g.window;
    }
  });
});
