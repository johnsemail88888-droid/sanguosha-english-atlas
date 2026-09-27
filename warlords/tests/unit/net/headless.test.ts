// Server-run (headless) rooms: HostSession without a player of its own. Every human is
// a client; the room owner — the creator presenting the owner key, else the first human —
// has the host's lobby powers through 'owner' messages; ownership lives on the seat (a
// reload keeps it), moves on after a real leave or the drop grace, and the owner key
// always takes it back. The match itself leaks nothing to anyone.
import { afterEach, describe, expect, it } from 'vitest';
import { emptyInput, type LobbyState } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { encodeJson } from '../../../src/net/codec';
import { HostSession } from '../../../src/net/hostSession';
import { LoopbackNetwork } from '../../../src/net/loopback';
import type { ClientMsg } from '../../../src/net/protocol';
import type { Payload } from '../../../src/net/transport';
import { flatMap, waitFor } from './fixtures';
import { addClient, allPhases, autoPick, cleanupHarness, makeHost, type ClientRec, type Harness } from './harness';
import { scanForLeaks } from './leakScan';

afterEach(cleanupHarness);

const KEY = 'owner-key-0123456789-abcdefghijklmnop';

const headlessHost = (extra: Parameters<typeof makeHost>[0] = {}): Harness => makeHost({ headless: true, ownerKey: KEY, ...extra });

/** Send a raw client message (bypassing ClientSession's own checks). */
const raw = (c: ClientRec, msg: ClientMsg | Record<string, unknown>): void => c.transport.send(c.transport.hostId, encodeJson(msg as ClientMsg), 'reliable');

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const systemLines = (c: ClientRec): string[] => {
  const out: string[] = [];
  c.session.on('chat', (m) => {
    if (m.system) out.push(m.zh ?? m.text);
  });
  return out;
};

describe('headless room: seats and owner', () => {
  it('has no host seat: the first human takes seat 0 and owns the room; nothing local leaks', async () => {
    const h = headlessHost();
    expect(h.host.headless).toBe(true);
    expect(h.host.canManage).toBe(false);
    expect(h.host.lobby.seats).toEqual([]);
    expect(h.host.lobby.headless).toBe(true);
    expect(h.host.lobby.ownerSeat).toBeUndefined();
    const a = await addClient(h, 'A');
    const b = await addClient(h, 'B');
    await waitFor(() => b.session.lobby?.seats.length === 2, 2000, 'both seated');
    expect(a.session.mySeat).toBe(0);
    expect(b.session.mySeat).toBe(1);
    expect(h.host.ownerSeat).toBe(0);
    // the owner is shown as the host (older UIs: the crown) and counts as ready
    const seat0 = h.host.lobby.seats.find((s) => s.seat === 0)!;
    expect(seat0).toMatchObject({ isHost: true, ready: true, isBot: false });
    expect(h.host.lobby.seats.find((s) => s.seat === 1)).toMatchObject({ isHost: false, ready: false });
    expect(a.session.isOwner && a.session.canManage && a.session.headless).toBe(true);
    expect(b.session.isOwner || b.session.canManage).toBe(false);
    expect(b.session.headless).toBe(true);
    // the server's session shows nothing of any seat
    h.host.pickHero('liubei');
    h.host.setName('X');
    h.host.sendChat('hi');
    expect(h.host.lobby.seats.map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('the owner has the host powers; the same messages from anyone else are ignored', async () => {
    const h = headlessHost();
    const a = await addClient(h, 'A', { ownerKey: KEY });
    const b = await addClient(h, 'B');
    await waitFor(() => h.host.lobby.seats.length === 2, 2000, 'seated');
    expect(h.host.ownerSeat).toBe(a.session.mySeat);
    const before = JSON.stringify(h.host.lobby);
    // a non-owner: its session sends nothing, and forged owner messages change nothing
    b.session.updateSettings({ playerCount: 8 });
    b.session.addBot();
    b.session.start();
    raw(b, { t: 'owner', op: 'settings', patch: { playerCount: 8, mode: 'chaos' } });
    raw(b, { t: 'owner', op: 'addBot' });
    raw(b, { t: 'owner', op: 'kick', seat: a.session.mySeat });
    raw(b, { t: 'owner', op: 'start' });
    await pause(80);
    expect(JSON.stringify(h.host.lobby)).toBe(before);
    expect(h.host.phase).toBe('lobby');

    // the owner: settings (strictly validated), bots, kick
    a.session.updateSettings({ playerCount: 7, mode: 'chaos', friendlyFire: false, troopsPerHero: 4 });
    await waitFor(() => h.host.lobby.settings.playerCount === 7, 2000, 'settings applied');
    expect(h.host.lobby.settings).toMatchObject({ mode: 'chaos', friendlyFire: false, troopsPerHero: 4 });
    await waitFor(() => b.session.lobby?.settings.playerCount === 7, 2000, 'guests see the settings');
    const settingsNow = JSON.stringify(h.host.lobby.settings);
    raw(a, { t: 'owner', op: 'settings', patch: { playerCount: 'eight', mode: 'deathmatch', evil: true } });
    raw(a, { t: 'owner', op: 'settings', patch: 'x' });
    raw(a, { t: 'owner', op: 'removeBot', seat: -1 });
    raw(a, { t: 'owner', op: 'kick', seat: 99 });
    raw(a, { t: 'owner', op: 'nope' });
    await pause(60);
    expect(JSON.stringify(h.host.lobby.settings)).toBe(settingsNow);

    a.session.addBot();
    await waitFor(() => h.host.lobby.seats.some((s) => s.isBot), 2000, 'bot added');
    const bot = h.host.lobby.seats.find((s) => s.isBot)!;
    a.session.removeBot(bot.seat);
    await waitFor(() => !h.host.lobby.seats.some((s) => s.isBot), 2000, 'bot removed');
    // the owner cannot kick itself
    a.session.kick(a.session.mySeat);
    await pause(60);
    expect(h.host.lobby.seats).toHaveLength(2);
    const bErrors: string[] = [];
    b.session.on('error', (e) => bErrors.push(e.code));
    a.session.kick(b.session.mySeat);
    await waitFor(() => bErrors.includes('kicked'), 2000, 'B kicked');
    expect(h.host.lobby.seats).toHaveLength(1);
  });

  it('the owner starts the match, ends it mid-match and brings everyone back after game over', async () => {
    const h = headlessHost({ fake: { endAfterSeconds: 0.6 }, timings: { autoLobby: 30 } });
    const a = await addClient(h, 'A', { ownerKey: KEY });
    const b = await addClient(h, 'B');
    await waitFor(() => b.session.lobby?.seats.length === 2, 2000, 'seated');
    autoPick(h);
    a.session.start();
    await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'everyone playing');
    // bots filled the table, humans kept their seats (no host seat at 0)
    expect(h.host.lobby.seats).toHaveLength(h.host.lobby.settings.playerCount);
    expect(h.host.lobby.seats.filter((s) => !s.isBot).map((s) => s.seat)).toEqual([0, 1]);
    // the server keeps no view of its own
    expect(h.host.view).toBeNull();
    expect(h.host.roles).toBeNull();
    // game over (FakeSim ends it) → the owner goes back to the lobby
    await waitFor(() => allPhases(h).every((p) => p === 'gameOver'), 5000, 'game over');
    b.session.returnToLobby(); // not the owner: nothing
    await pause(60);
    expect(h.host.phase).toBe('gameOver');
    a.session.returnToLobby();
    await waitFor(() => allPhases(h).every((p) => p === 'lobby'), 3000, 'back in the lobby');
    expect(a.session.isOwner).toBe(true);
    // again, and this time 结束对局 from the pause menu mid-match (endMatch)
    a.session.start();
    await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'playing again');
    a.session.returnToLobby();
    await waitFor(() => allPhases(h).every((p) => p === 'lobby'), 3000, 'match ended by the owner');
  });

  it('goes back to the lobby by itself after game over when the owner does not', async () => {
    const h = headlessHost({ fake: { endAfterSeconds: 0.4 }, timings: { autoLobby: 0.3 } });
    const a = await addClient(h, 'A', { ownerKey: KEY });
    autoPick(h);
    a.session.start();
    await waitFor(() => a.session.phase === 'gameOver', 6000, 'game over');
    await waitFor(() => h.host.phase === 'lobby' && a.session.phase === 'lobby', 3000, 'auto back to the lobby');
    expect(h.host.ownerSeat).toBe(a.session.mySeat);
  });
});

describe('headless room: ownership', () => {
  it('the owner key wins ownership — also back from the first player', async () => {
    const h = headlessHost();
    const a = await addClient(h, 'A');
    const aLines = systemLines(a);
    await waitFor(() => a.session.isOwner, 2000, 'A owns the empty room');
    const b = await addClient(h, 'B', { ownerKey: KEY });
    await waitFor(() => b.session.isOwner && !a.session.isOwner, 2000, 'B took it');
    expect(h.host.ownerSeat).toBe(b.session.mySeat);
    expect(h.host.lobby.seats.filter((s) => s.isHost).map((s) => s.seat)).toEqual([b.session.mySeat]);
    await waitFor(() => aLines.some((l) => l.includes('B 成为房主')), 2000, 'told');
    // a wrong key is just a player
    const c = await addClient(h, 'C', { ownerKey: `${KEY}x` });
    await pause(50);
    expect(c.session.isOwner).toBe(false);
    expect(h.host.ownerSeat).toBe(b.session.mySeat);
  });

  it('ownership stays through a reload (lobby grace), moves on after a real leave or the grace running out', async () => {
    const h = headlessHost({ timings: { lobbyDropGrace: 0.5 } });
    const a = await addClient(h, 'A', { ownerKey: KEY });
    const b = await addClient(h, 'B');
    const c = await addClient(h, 'C');
    const bLines = systemLines(b);
    await waitFor(() => c.session.lobby?.seats.length === 3, 2000, 'seated');
    expect(h.host.ownerSeat).toBe(0);
    // A's page reloads: the seat (and the room) is held for the tab that comes back
    const token = a.session.seatToken!;
    a.session.leave({ keepToken: true });
    await pause(150);
    expect(h.host.ownerSeat).toBe(0);
    expect(b.session.isOwner).toBe(false);
    // …which comes back with its seat token (a reload also presents the owner key; here only the token)
    const t = await h.net.connect();
    const a2 = await ClientSession.connect({ transport: t, name: 'A', token, mapFactory: () => flatMap(), hostWarmUpMs: 0 });
    h.clients.push({ name: 'A', session: a2, transport: t, log: [] });
    expect(a2.mySeat).toBe(0);
    await waitFor(() => a2.isOwner, 2000, 'still the owner');
    await pause(500); // past the grace: nothing happens, A is back
    expect(h.host.ownerSeat).toBe(0);
    expect(bLines.some((l) => l.includes('成为房主'))).toBe(false);
    // a real leave: the lowest connected seat owns the room now
    a2.leave();
    await waitFor(() => b.session.isOwner, 2000, 'B owns it');
    expect(bLines.some((l) => l.includes('B 成为房主'))).toBe(true);
    // B's link fails and B never comes back: once the grace ran out, C owns it
    b.session.leave({ keepToken: true });
    await pause(200);
    expect(h.host.ownerSeat).toBe(b.session.mySeat);
    await waitFor(() => c.session.isOwner, 3000, 'C owns it after the grace');
    // everyone gone: nobody owns it, the next human does
    c.session.leave();
    await waitFor(() => h.host.lobby.seats.length === 0, 2000, 'empty');
    expect(h.host.ownerSeat).toBeUndefined();
    const d = await addClient(h, 'D');
    await waitFor(() => d.session.isOwner, 2000, 'D owns it');
  });

  it('mid-match: a dropped owner keeps the room through the drop grace, then it passes on', async () => {
    const h = headlessHost({ timings: { dropGrace: 0.5, loadDropGrace: 0.5 } });
    const a = await addClient(h, 'A', { ownerKey: KEY });
    const b = await addClient(h, 'B');
    await waitFor(() => b.session.lobby?.seats.length === 2, 2000, 'seated');
    autoPick(h);
    a.session.start();
    await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'playing');
    a.transport.close(); // the link fails (no rejoin in this test)
    await pause(200);
    expect(h.host.ownerSeat).toBe(0);
    await waitFor(() => b.session.isOwner, 3000, 'B owns the room after the grace');
    expect(h.host.lobby.seats.find((s) => s.seat === 0)?.isBot).toBe(true); // a bot plays A's hero
    b.session.returnToLobby(); // the new owner ends the match
    await waitFor(() => h.host.phase === 'lobby' && b.session.phase === 'lobby', 3000, 'back in the lobby');
    expect(h.host.lobby.seats.filter((s) => !s.isBot).map((s) => s.name)).toEqual(['B']);
  });
});

describe('headless room: a real match', () => {
  it('runs a bot-filled match on the real sim; no client learns a hidden role', async (ctx) => {
    const net = new LoopbackNetwork();
    const host = new HostSession({
      name: '服务器',
      transport: net.createHost('relay-host'),
      roomCode: 'HDLS2',
      seed: 23,
      preferWorkerTicker: false,
      headless: true,
      ownerKey: KEY,
      settings: { playerCount: 6, mode: 'chaos' },
      timings: { roleReveal: 0.02, lordPick: 1, pick: 1, pickReveal: 0.01, loadTimeout: 30 },
    });
    const errors: string[] = [];
    host.on('error', (e) => errors.push(`${e.code}: ${e.en}`));
    const clients: { s: ClientSession; log: Payload[] }[] = [];
    try {
      for (const [name, ownerKey] of [
        ['甲', KEY],
        ['乙', undefined],
      ] as const) {
        const t = await net.connect();
        const log: Payload[] = [];
        t.onMessage((_f, d) => log.push(d));
        const s = await ClientSession.connect({ transport: t, name, ownerKey });
        s.on('heroSelect', (v) => v.options.length && v.picks[s.mySeat] === undefined && s.pickHero(v.options[0]));
        clients.push({ s, log });
      }
      const [owner] = clients;
      await waitFor(() => owner.s.isOwner, 2000, 'owner');
      owner.s.start();
      await waitFor(() => (host.phase === 'playing' && clients.every((c) => c.s.phase === 'playing')) || errors.length > 0, 60_000, 'real match');
      if (errors.length > 0) {
        ctx.skip(`real sim unavailable: ${errors[0]}`);
        return;
      }
      const lobby: LobbyState = host.lobby;
      expect(lobby.seats).toHaveLength(6);
      expect(lobby.seats.filter((s) => !s.isBot).map((s) => s.seat)).toEqual([0, 1]);
      expect(host.view).toBeNull();
      expect(host.roles).toBeNull();
      const end = Date.now() + 1500;
      let last = performance.now();
      while (Date.now() < end) {
        const now = performance.now();
        for (const c of clients) {
          c.s.view?.pushInput({ ...emptyInput(), moveZ: 1 });
          c.s.view?.update((now - last) / 1000);
        }
        last = now;
        await pause(16);
      }
      const deal = host.dealtRoles!;
      for (const c of clients) {
        const seat = c.s.mySeat;
        const view = c.s.view!;
        expect(view.entities().length).toBeGreaterThan(6);
        expect(view.local()?.role).toBe(deal.roles[seat]);
        expect(scanForLeaks(c.log, deal.roles[seat], c.s.myId), `seat ${seat} (${deal.roles[seat]})`).toEqual([]);
        expect(c.log.filter((p) => typeof p !== 'string' && p[0] === 1).length).toBeGreaterThan(10); // snapshots flowed
      }
    } finally {
      for (const c of clients) c.s.leave();
      host.leave();
    }
  }, 90_000);
});
