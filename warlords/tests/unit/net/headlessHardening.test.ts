// Server-run rooms under hostile or awkward clients (review of the headless server):
//  - a seat, its hidden role and the owner's powers go only to the seat's token — never to
//    a stranger saying hello under a player's (public) name, however quiet that player is;
//  - garbage pings must not throw (each throw was a stack trace in the server's log);
//  - an older client (no hello.canOwn) is never handed a room it could not manage;
//  - a client of another build is refused (it would desync silently);
//  - a room that is gone for good is reported as closed, not retried for two minutes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { decodeJson, encodeJson } from '../../../src/net/codec';
import { COMPAT_ID } from '../../../src/net/compat';
import { NetError } from '../../../src/net/errors';
import { LoopbackNetwork } from '../../../src/net/loopback';
import type { ClientMsg } from '../../../src/net/protocol';
import { HANDLER_ERROR_LOG_MS, type Payload } from '../../../src/net/transport';
import { flatMap, waitFor } from './fixtures';
import { addClient, allPhases, autoPick, cleanupHarness, loopbackReconnect, makeHost, type ClientRec, type Harness } from './harness';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupHarness();
});

const KEY = 'owner-key-0123456789-abcdefghijklmnop';
const headlessHost = (extra: Parameters<typeof makeHost>[0] = {}): Harness => makeHost({ headless: true, ownerKey: KEY, ...extra });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bare connection that says `hello` itself and records every message it gets. */
async function rawPeer(h: Harness): Promise<{ send(m: ClientMsg | Record<string, unknown>): void; got: Payload[]; types(): string[] }> {
  const t = await h.net.connect();
  const got: Payload[] = [];
  t.onMessage((_f, d) => got.push(d));
  return {
    send: (m) => t.send(t.hostId, encodeJson(m as ClientMsg), 'reliable'),
    got,
    types: () => got.map((d) => (typeof d === 'string' ? String((decodeJson(d) as { t?: unknown } | null)?.t) : 'binary')),
  };
}

async function toPlaying(h: Harness, owner: ClientRec): Promise<void> {
  autoPick(h);
  owner.session.start();
  await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'playing');
}

describe('a server-run room hands a seat only to its token', () => {
  it('mid-match, a hello under a quiet player\'s name — or the owner\'s — gets no seat, no role, no powers', async () => {
    const h = headlessHost({ timings: { peerTimeout: 30 } });
    const a = await addClient(h, 'A', { ownerKey: KEY });
    const b = await addClient(h, 'B');
    await waitFor(() => h.host.lobby.seats.length === 2, 2000, 'seated');
    await toPlaying(h, a);
    const seatB = b.session.mySeat;
    // B's phone goes quiet (building the scene, a congested link) — for longer than a few pings
    h.net.sever(b.session.myId);
    await pause(1300);
    for (const name of ['B', 'A']) {
      const thief = await rawPeer(h);
      thief.send({ t: 'hello', v: PROTOCOL_VERSION, name, canOwn: true });
      await waitFor(() => thief.got.length > 0, 2000, 'answer');
      await pause(100);
      expect(thief.types()).toEqual(['reject']);
      expect((decodeJson(thief.got[0] as string) as unknown as { code: string }).code).toBe('inProgress');
    }
    // B still holds its seat, A still owns the room
    expect(h.host.lobby.seats.find((s) => s.seat === seatB)?.playerId).toBe(b.session.myId);
    expect(h.host.ownerSeat).toBe(a.session.mySeat);
    // once B's link is really gone and a bot plays its hero, a name alone still takes nothing
    h.net.restore(b.session.myId);
    h.net.dropClient(b.session.myId);
    await waitFor(() => h.host.lobby.seats.find((s) => s.seat === seatB)?.isBot === true, 3000, 'B dropped');
    const late = await rawPeer(h);
    late.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'B' });
    await waitFor(() => late.got.length > 0, 2000, 'answer');
    await pause(100);
    expect(late.types()).toEqual(['reject']);
    // …while B's own token brings B back to its seat
    const t = await h.net.connect();
    const back = await ClientSession.connect({ transport: t, name: 'B', token: b.session.seatToken!, mapFactory: () => flatMap(), hostWarmUpMs: 0 });
    h.clients.push({ name: 'B', session: back, transport: t, log: [] });
    expect(back.mySeat).toBe(seatB);
    await waitFor(() => back.phase === 'playing', 3000, 'B back in the match');
  });

  it('a browser-hosted room still lets a name take a seat whose link has dropped — never a live one', async () => {
    const h = makeHost({ seed: 3, timings: { peerTimeout: 30 } });
    const a = await addClient(h, 'A');
    await waitFor(() => h.host.lobby.seats.length === 2, 2000, 'seated');
    autoPick(h);
    h.host.start();
    await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'playing');
    h.net.sever(a.session.myId);
    await pause(1300);
    await expect(addClient(h, 'A')).rejects.toMatchObject({ code: 'inProgress' });
    h.net.restore(a.session.myId);
    h.net.dropClient(a.session.myId);
    await waitFor(() => h.host.lobby.seats.find((s) => s.seat === a.session.mySeat)?.isBot === true, 3000, 'A dropped');
    const again = await addClient(h, 'A');
    expect(again.session.mySeat).toBe(a.session.mySeat);
  });
});

describe('garbage from a client', () => {
  it('pings / pongs with objects for numbers do not throw (no stack trace per message in the log)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = headlessHost();
    const p = await rawPeer(h); // no hello needed
    for (let i = 0; i < 50; i++) {
      p.send({ t: 'ping', id: { toString: 1, valueOf: 1 }, ts: { toString: 1 } });
      p.send({ t: 'pong', id: 1, ts: { valueOf: 1 } });
      p.send({ t: 'ping', id: 'x', ts: [] });
    }
    await waitFor(() => p.types().filter((t) => t === 'pong').length === 100, 2000, 'pongs');
    const pongs = p.got.map((d) => decodeJson(d as string) as { t: string; id: number; ts: number }).filter((m) => m.t === 'pong');
    expect(pongs.every((m) => m.id === 0 && m.ts === 0)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a handler that throws is logged at most once a minute per peer', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const net = new LoopbackNetwork();
    const host = net.createHost();
    host.onMessage(() => {
      throw new TypeError('boom');
    });
    const c1 = await net.connect();
    const c2 = await net.connect();
    for (let i = 0; i < 200; i++) c1.send(c1.hostId, 'x', 'reliable');
    c2.send(c2.hostId, 'x', 'reliable');
    await pause(50);
    expect(errors).toHaveBeenCalledTimes(2); // one line for c1, one for c2
    expect(HANDLER_ERROR_LOG_MS).toBeGreaterThanOrEqual(60_000);
    host.close();
  });
});

describe('who may own a server-run room', () => {
  it('an older client (no hello.canOwn) is passed over while someone who can manage the room is there', async () => {
    const h = headlessHost({ timings: { peerTimeout: 30 } });
    const a = await addClient(h, 'A', { ownerKey: KEY });
    await waitFor(() => a.session.isOwner, 2000, 'A owns');
    const old = await rawPeer(h); // an older release: its hello has no canOwn (and no build)
    old.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Old' });
    await waitFor(() => old.types().includes('welcome'), 2000, 'old welcomed');
    const oldSeat = (decodeJson(old.got[old.types().indexOf('welcome')] as string) as unknown as { seat: number }).seat;
    const b = await addClient(h, 'B');
    await waitFor(() => h.host.lobby.seats.length === 3, 2000, 'three seated');
    expect(oldSeat).toBeLessThan(b.session.mySeat);
    a.session.leave();
    await waitFor(() => b.session.isOwner, 2000, 'B owns (not the older client in the lower seat)');
    expect(h.host.ownerSeat).toBe(b.session.mySeat);
    b.session.start();
    autoPick(h);
    await waitFor(() => h.host.phase !== 'lobby', 3000, 'B can start the match');
  });

  it('alone, an older client holds the crown — until a client that can use it joins', async () => {
    const h = headlessHost({ timings: { peerTimeout: 30 } });
    const old = await rawPeer(h);
    old.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Old' });
    await waitFor(() => h.host.ownerSeat === 0, 2000, 'old owns the empty room');
    const b = await addClient(h, 'B');
    await waitFor(() => b.session.isOwner, 2000, 'B takes it over');
    expect(h.host.ownerSeat).toBe(b.session.mySeat);
  });
});

describe('builds', () => {
  it('a server-run room refuses a client of another build; one without a build id (older) is let in', async () => {
    const h = headlessHost();
    const other = await rawPeer(h);
    other.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'X', canOwn: true, build: `${COMPAT_ID}-other` });
    await waitFor(() => other.got.length > 0, 2000, 'answer');
    expect(other.types()).toEqual(['reject']);
    expect((decodeJson(other.got[0] as string) as unknown as { code: string }).code).toBe('versionMismatch');
    const same = await addClient(h, 'Y'); // sends COMPAT_ID
    expect(same.session.mySeat).toBe(0);
    const older = await rawPeer(h);
    older.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Z' });
    await waitFor(() => older.types().includes('welcome'), 2000, 'older client welcomed');
  });

  it('a browser-hosted room does not check builds (as before)', async () => {
    const h = makeHost({ seed: 5 });
    const other = await rawPeer(h);
    other.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'X', build: 'something-else' });
    await waitFor(() => other.types().includes('welcome'), 2000, 'welcomed');
  });
});

describe('a server-run room that is gone', () => {
  it('a dropped player whose room no longer exists (roomNotFound) hears "the server closed the room" at once', async () => {
    const h = headlessHost();
    let a: ClientRec | undefined;
    let gone = false;
    const reconnect = loopbackReconnect(h, () => a);
    a = await addClient(h, 'A', {
      reconnect: async () => {
        if (gone) throw new NetError('roomNotFound');
        return reconnect();
      },
      rejoinDelaysMs: [0, 200, 400],
    });
    await waitFor(() => a!.session.headless, 2000, 'headless lobby');
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    gone = true;
    const t0 = Date.now();
    h.net.dropClient(a.session.myId);
    await waitFor(() => errors.length > 0, 3000, 'error');
    expect(errors).toEqual(['serverClosed']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
