// Host + clients over the in-memory loopback transport: lobby, role dealing,
// hero select, match start, snapshots/inputs, hidden information,
// disconnect/reclaim, game over and return to lobby.
import { afterEach, describe, expect, it } from 'vitest';
import type { GameMode, HeroSelectView, InputAction } from '../../../src/core/types';
import type { MatchInit } from '../../../src/sim/host';
import { emptyInput, PROTOCOL_VERSION } from '../../../src/core/types';
import type { ClientView } from '../../../src/net/clientView';
import { BIN_SNAPSHOT, type HostMsg } from '../../../src/net/protocol';
import { decodeSnapshotMsg, encodeInputMsg, encodeJson, StringTable } from '../../../src/net/codec';
import { FakeSim } from '../../../src/net/fakeSim';
import { HostSession } from '../../../src/net/hostSession';
import { LocalView } from '../../../src/net/localView';
import { LoopbackNetwork } from '../../../src/net/loopback';
import { NetError } from '../../../src/net/errors';
import { flatMap, testHeroPool, waitFor } from './fixtures';
import { addClient, allPhases, autoPick, cleanupHarness, drive, FAST, forgetHarness, makeHost, runToPlaying } from './harness';
import { scanForLeaks } from './leakScan';

afterEach(cleanupHarness);

describe('lobby', () => {
  it('seats players, dedupes names, syncs settings, ready, chat, bots and kick', async () => {
    const h = makeHost();
    const a = await addClient(h, '小明');
    const b = await addClient(h, '小明');
    await waitFor(() => h.host.lobby.seats.length === 3);
    expect(h.host.lobby.seats.map((s) => s.name)).toEqual(['房主', '小明', '小明2']);
    expect(h.host.lobby.seats[0]).toMatchObject({ seat: 0, isHost: true, playerId: 'host' });
    expect(a.session.mySeat).toBe(1);
    await waitFor(() => b.session.lobby?.seats.length === 3);
    expect(b.session.mySeat).toBe(2);
    expect(b.session.lobby?.roomCode).toBe('TEST2');

    a.session.setReady(true);
    await waitFor(() => h.host.lobby.seats[1].ready);

    h.host.updateSettings({ playerCount: 7, mode: 'chaos', heroChoices: 4, freePick: true });
    await waitFor(() => a.session.lobby?.settings.playerCount === 7);
    expect(a.session.lobby?.settings).toMatchObject({ mode: 'chaos', heroChoices: 4, freePick: true });

    const chats: string[] = [];
    h.host.on('chat', (m) => chats.push(`host:${m.from}:${m.text}`));
    a.session.on('chat', (m) => chats.push(`a:${m.from}:${m.text}`));
    b.session.sendChat('  你好  ');
    await waitFor(() => chats.length === 2);
    expect(chats.sort()).toEqual(['a:小明2:你好', 'host:小明2:你好']);

    h.host.addBot();
    await waitFor(() => a.session.lobby?.seats.length === 4);
    const bot = h.host.lobby.seats.find((s) => s.isBot)!;
    expect(bot.playerId).toMatch(/^bot-/);
    h.host.removeBot(bot.seat);
    await waitFor(() => a.session.lobby?.seats.length === 3);

    const errors: string[] = [];
    b.session.on('error', (e) => errors.push(e.code));
    h.host.kick(2);
    await waitFor(() => errors.includes('kicked'));
    await waitFor(() => h.host.lobby.seats.length === 2);
  });

  it('refuses a wrong protocol version and joins after the match started', async () => {
    const h = makeHost();
    const raw = await h.net.connect();
    const got: HostMsg[] = [];
    raw.onMessage((_f, d) => typeof d === 'string' && got.push(JSON.parse(d)));
    raw.send('host', encodeJson({ t: 'hello', v: PROTOCOL_VERSION + 99, name: 'old' }));
    await waitFor(() => got.some((m) => m.t === 'reject'));
    expect(got.find((m) => m.t === 'reject')).toMatchObject({ code: 'versionMismatch' });

    await addClient(h, 'A');
    await runToPlaying(h);
    await expect(addClient(h, '迟到的人')).rejects.toMatchObject({ code: 'inProgress' });
  });
});

describe('match flow', () => {
  it('deals roles, lord picks first, reaches playing with snapshots + inputs, game over, back to lobby', async () => {
    const h = makeHost({ seed: 7, fake: { endAfterSeconds: 1.5 } });
    const a = await addClient(h, 'A');
    const b = await addClient(h, 'B');
    const views: HeroSelectView[] = [];
    a.session.on('heroSelect', (v) => views.push(v));
    const phases: string[] = [];
    a.session.on('phase', (p) => phases.push(p));
    await runToPlaying(h);

    // roles: official counts, everyone got exactly their own card
    const deal = h.host.dealtRoles!;
    expect([...deal.roles].sort()).toEqual(['lord', 'loyalist', 'rebel', 'rebel', 'traitor'].sort());
    expect(h.host.roles?.yourRole).toBe(deal.roles[0]);
    for (const c of h.clients) expect(c.session.roles?.yourRole).toBe(deal.roles[c.session.mySeat]);
    expect(phases.slice(0, 4)).toEqual(['roles', 'heroSelect', 'loading', 'playing']);

    // lord first: the first views are lordPhase with only the lord's pick; others follow
    expect(views[0].lordPhase).toBe(true);
    expect(views[0].lordSeat).toBe(deal.lordSeat);
    for (const v of views.filter((x) => x.lordPhase)) {
      for (const seat of Object.keys(v.picks).map(Number)) expect(seat).toBe(deal.lordSeat);
    }
    const general = views.find((v) => !v.lordPhase)!;
    expect(general.picks[deal.lordSeat]).toBeDefined();
    const sim = h.sims[0];
    const heroes = sim.init.seats.map((s) => s.heroId);
    expect(new Set(heroes).size).toBe(5); // no duplicates
    expect(sim.init.seats.filter((s) => s.isBot)).toHaveLength(2);
    expect(sim.init.seats.find((s) => s.seat === 0)?.playerId).toBe('host');

    // snapshots arrive and the client view renders entities, predicting its own hero
    await drive(h, 0.6, (c) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1, yaw: 0.5 }));
    const av = a.session.view as ClientView;
    expect(av.entities().length).toBeGreaterThanOrEqual(5 * 4); // 5 heroes + 3 troops each
    expect(av.localId()).toBe(sim.entityOf(a.session.myId));
    expect(av.local()?.role).toBe(deal.roles[a.session.mySeat]);
    expect(av.players()).toHaveLength(5);
    expect(av.viewTick()).toBeGreaterThan(0);
    const aInputs = sim.inputLog.filter((x) => x.playerId === a.session.myId);
    expect(aInputs.length).toBeGreaterThan(5);
    for (let i = 1; i < aInputs.length; i++) expect(aInputs[i].seq).toBeGreaterThan(aInputs[i - 1].seq);
    expect(h.host.view).toBeInstanceOf(LocalView);
    expect(h.host.view!.entities().length).toBeGreaterThan(0);

    // game over propagates, then everyone returns to the lobby
    await waitFor(() => allPhases(h).every((p) => p === 'gameOver'), 5000, 'game over');
    expect(a.session.result?.winner).toBe('lord');
    expect(b.session.view?.result()?.winner).toBe('lord');
    h.host.returnToLobby();
    await waitFor(() => allPhases(h).every((p) => p === 'lobby'), 2000, 'lobby');
    expect(h.host.lobby.seats).toHaveLength(3); // auto-filled bots removed
    expect(a.session.view).toBeNull();
    expect(a.session.lobby?.seats.map((s) => s.name)).toEqual(['房主', 'A', 'B']);
    expect(h.host.debugState().loopRunning).toBe(false);
  });

  it('a second match can be started after returning to the lobby', async () => {
    const h = makeHost({ seed: 3, fake: { endAfterSeconds: 0.3 } });
    await addClient(h, 'A');
    await runToPlaying(h);
    await waitFor(() => allPhases(h).every((p) => p === 'gameOver'), 5000);
    h.host.returnToLobby();
    await waitFor(() => allPhases(h).every((p) => p === 'lobby'));
    h.host.start();
    await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'second match');
    expect(h.sims).toHaveLength(2);
  });

  it('host-side dedup: lost frames rescue their actions exactly once, late frames are ignored', async () => {
    const h = makeHost({ seed: 5 });
    const raw = await h.net.connect('raw1');
    const got: HostMsg[] = [];
    const bins: Uint8Array[] = [];
    raw.onMessage((_f, d) => {
      if (typeof d !== 'string') {
        bins.push(d);
        return;
      }
      const m = JSON.parse(d) as HostMsg;
      got.push(m);
      if (m.t === 'matchStart') raw.send('host', encodeJson({ t: 'loaded' }));
      if (m.t === 'ping') raw.send('host', encodeJson({ t: 'pong', id: m.id, ts: m.ts }));
    });
    raw.send('host', encodeJson({ t: 'hello', v: PROTOCOL_VERSION, name: 'raw' }));
    await waitFor(() => got.some((m) => m.t === 'welcome'));
    autoPick(h);
    h.host.start();
    await waitFor(() => h.host.phase === 'playing', 5000);
    const f = (seq: number, actions: InputAction[]) => ({ ...emptyInput(seq), actions });
    const send = (pkt: Parameters<typeof encodeInputMsg>[0]) => raw.send('host', encodeInputMsg(pkt), 'unreliable');
    send({ frame: f(1, [{ a: 'jump' }]), history: [] });
    // frame 2 (reload) is "lost"; frame 3 carries it in history, plus a repeat of 1
    send({ frame: f(3, [{ a: 'dodge' }]), history: [{ seq: 1, actions: [{ a: 'jump' }] }, { seq: 2, actions: [{ a: 'reload' }] }] });
    send({ frame: f(2, [{ a: 'reload' }]), history: [] }); // arrives late → ignored
    send({ frame: f(4, []), history: [{ seq: 3, actions: [{ a: 'dodge' }] }] });
    await waitFor(() => h.sims[0].inputLog.filter((x) => x.playerId === 'raw1').length >= 3, 3000, 'inputs applied');
    const applied = h.sims[0].inputLog.filter((x) => x.playerId === 'raw1');
    expect(applied.map((x) => x.seq)).toEqual([1, 3, 4]);
    expect(applied.flatMap((x) => x.actions.map((a) => a.a))).toEqual(['jump', 'reload', 'dodge']);
    // snapshots are binary, decodable with the match string table, and ack the processed input
    const start = got.find((m) => m.t === 'matchStart') as Extract<HostMsg, { t: 'matchStart' }>;
    const table = new StringTable(start.strings);
    const lastAck = (): number => {
      const snaps = bins.filter((b) => b[0] === BIN_SNAPSHOT).map((b) => decodeSnapshotMsg(b, table));
      return snaps.length ? snaps[snaps.length - 1].ackSeq : -1;
    };
    await waitFor(() => lastAck() === 4, 3000, 'ackSeq 4');
    const snap = decodeSnapshotMsg(bins.filter((b) => b[0] === BIN_SNAPSHOT).pop()!, table);
    expect(snap.you?.entityId).toBe(start.you);
  });
});

describe('hidden information', () => {
  const cases: { mode: GameMode; count: 5 | 6 | 7 | 8; seed: number }[] = [
    { mode: 'standard', count: 5, seed: 1 },
    { mode: 'standard', count: 8, seed: 2 },
    { mode: 'chaos', count: 6, seed: 3 },
    { mode: 'chaos', count: 8, seed: 4 },
    { mode: 'chaos', count: 8, seed: 11 },
  ];
  for (const cs of cases) {
    it(`${cs.mode} ${cs.count}p: no client ever receives another player's hidden role`, async () => {
      const h = makeHost({ seed: cs.seed, settings: { playerCount: cs.count, mode: cs.mode } });
      await addClient(h, 'A');
      await addClient(h, 'B');
      await addClient(h, 'C');
      await runToPlaying(h);
      await drive(h, 0.3, (c) => c.session.view?.pushInput({ ...emptyInput(), actions: [{ a: 'quickchat', id: 'followMe' }] }));
      const deal = h.host.dealtRoles!;
      expect(deal.roles).toHaveLength(cs.count);
      for (const c of h.clients) {
        const seat = c.session.mySeat;
        const mine = deal.roles[seat];
        const violations = scanForLeaks(c.log, mine, c.session.myId);
        expect(violations, `seat ${seat} (${mine}) saw hidden roles`).toEqual([]);
      }
    });
  }
});

describe('leak scanner', () => {
  it('is not vacuous: flags another player\'s role in JSON and in binary snapshots', () => {
    const roles = encodeJson({ t: 'roles', deal: { yourRole: 'rebel', publicRoles: { 0: 'lord', 3: 'traitor' } }, seconds: 1 });
    expect(scanForLeaks([roles], 'rebel', 'me')).toEqual(['deal.publicRoles.3=traitor']);
    expect(scanForLeaks([encodeJson({ t: 'roles', deal: { yourRole: 'rebel', publicRoles: { 0: 'lord' } }, seconds: 1 })], 'rebel', 'me')).toEqual([]);
  });
});

describe('disconnects', () => {
  it('a human who drops mid-match becomes a bot and can reclaim the seat by name', async () => {
    const h = makeHost({ seed: 9 });
    const a = await addClient(h, '阿强');
    await addClient(h, 'B');
    await runToPlaying(h);
    const sim = h.sims[0];
    const seat = a.session.mySeat;
    const oldId = a.session.myId;
    const statuses: string[] = [];
    h.host.on('status', (s) => statuses.push(s.en));

    a.transport.close(); // network drop, no goodbye
    await waitFor(() => sim.conversions.some((c) => c.kind === 'bot' && c.playerId === oldId), 2000, 'convertToBot');
    expect(statuses.some((s) => s.includes('disconnected'))).toBe(true);
    expect(h.host.lobby.seats.find((s) => s.seat === seat)?.isBot).toBe(true);

    const back = await addClient(h, '阿强');
    expect(back.session.mySeat).toBe(seat);
    expect(back.session.myId).not.toBe(oldId);
    await waitFor(() => sim.conversions.some((c) => c.kind === 'human' && c.seat === seat && c.playerId === back.session.myId), 2000);
    await waitFor(() => back.session.phase === 'playing', 3000, 'reclaimed player playing');
    expect(back.session.roles?.yourRole).toBe(h.host.dealtRoles!.roles[seat]);
    await drive(h, 0.3);
    expect(back.session.view?.localId()).toBe(sim.entityOf(back.session.myId));
    expect(back.session.view!.entities().length).toBeGreaterThan(0);
  });

  it('a human who drops during hero select is auto-picked for', async () => {
    const h = makeHost({ seed: 21 });
    const a = await addClient(h, 'A');
    await addClient(h, 'B');
    // nobody picks for A; A drops as soon as hero select starts
    h.host.on('heroSelect', (v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) h.host.pickHero(v.options[0]);
    });
    h.clients[1].session.on('heroSelect', (v) => {
      const s = h.clients[1].session.mySeat;
      if (v.options.length > 0 && v.picks[s] === undefined) h.clients[1].session.pickHero(v.options[0]);
    });
    a.session.on('phase', (p) => {
      if (p === 'heroSelect') a.transport.close();
    });
    h.host.start();
    await waitFor(() => h.host.phase === 'playing', 5000, 'playing without A');
    const seatA = h.sims[0].init.seats.find((s) => s.name === 'A')!;
    expect(seatA.isBot).toBe(true);
    expect(seatA.heroId).toBeTruthy();
  });

  it('clients get an error when the host leaves', async () => {
    const h = makeHost();
    const a = await addClient(h, 'A');
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    h.host.leave();
    await waitFor(() => errors.length > 0, 2000);
    expect(errors[0]).toBe('hostLeft');
    forgetHarness();
  });

  it('joining a room that does not exist fails with roomNotFound', async () => {
    const net = new LoopbackNetwork();
    await expect(net.connect()).rejects.toBeInstanceOf(NetError);
    await expect(net.connect()).rejects.toMatchObject({ code: 'roomNotFound' });
  });
});

describe('single player', () => {
  it('runs the whole flow in-process with bots and a LocalView', async () => {
    const sims: FakeSim[] = [];
    const host = new HostSession({
      name: '单人',
      transport: null,
      myId: 'local',
      heroes: testHeroPool(),
      timings: FAST,
      seed: 1,
      preferWorkerTicker: false,
      settings: { playerCount: 6 },
      createMatch: (init) => {
        const s = new FakeSim(init, { map: flatMap() });
        sims.push(s);
        return s;
      },
    });
    host.on('heroSelect', (v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) host.pickHero(v.options[0]);
    });
    expect(host.lobby.roomCode).toBe('');
    expect(host.lobby.seats).toHaveLength(1);
    let mounted = false;
    host.on('matchStart', () => (mounted = true));
    host.start();
    await waitFor(() => host.phase === 'playing', 5000);
    expect(mounted).toBe(true);
    expect(sims[0].init.seats).toHaveLength(6);
    expect(sims[0].init.seats.filter((s) => !s.isBot).map((s) => s.playerId)).toEqual(['local']);
    const view = host.view!;
    view.pushInput({ ...emptyInput(1), moveZ: 1, actions: [{ a: 'jump' }] });
    await waitFor(() => sims[0].tick > 5, 2000);
    view.update(1 / 60);
    expect(view.entities().length).toBe(6 * 4);
    expect(view.local()?.entityId).toBe(view.localId());
    expect(sims[0].inputLog.some((x) => x.playerId === 'local' && x.actions.some((a) => a.a === 'jump'))).toBe(true);
    const evs = view.drainEvents();
    expect(evs.some((e) => e.t === 'announce')).toBe(true);
    expect(evs.some((e) => e.t === 'sfx')).toBe(true);
    host.leave();
  });

  it('accepts an async match factory (lazy sim) and ignores a late sim after an abort', async () => {
    const pending: { init: MatchInit; resolve: (s: FakeSim) => void }[] = [];
    const host = new HostSession({
      name: 'x',
      heroes: testHeroPool(),
      timings: FAST,
      preferWorkerTicker: false,
      createMatch: (init) => new Promise<FakeSim>((resolve) => pending.push({ init, resolve })),
    });
    host.on('heroSelect', (v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) host.pickHero(v.options[0]);
    });
    host.start();
    await waitFor(() => host.phase === 'loading' && pending.length === 1, 5000);
    // abort while the sim is still loading: the late sim must be ignored
    host.returnToLobby();
    pending[0].resolve(new FakeSim(pending[0].init, { map: flatMap() }));
    await new Promise((r) => setTimeout(r, 20));
    expect(host.phase).toBe('lobby');
    expect(host.view).toBeNull();
    // a second attempt resolves normally
    host.start();
    await waitFor(() => pending.length === 2, 5000);
    pending[1].resolve(new FakeSim(pending[1].init, { map: flatMap() }));
    await waitFor(() => host.phase === 'playing', 2000);
    expect(host.view).toBeInstanceOf(LocalView);
    host.leave();
  });

  it('reports simFailed and returns to the lobby when the match cannot be created', async () => {
    const host = new HostSession({
      name: 'x',
      heroes: testHeroPool(),
      timings: FAST,
      preferWorkerTicker: false,
      createMatch: () => {
        throw new Error('boom');
      },
    });
    host.on('heroSelect', (v) => {
      if (v.options.length > 0 && v.picks[0] === undefined) host.pickHero(v.options[0]);
    });
    const errors: string[] = [];
    host.on('error', (e) => errors.push(e.code));
    host.start();
    await waitFor(() => errors.length > 0, 5000);
    expect(errors[0]).toBe('simFailed');
    expect(host.phase).toBe('lobby');
    host.leave();
  });
});
