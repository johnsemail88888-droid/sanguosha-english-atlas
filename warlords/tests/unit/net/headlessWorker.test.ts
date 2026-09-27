// The server-run room's worker logic (src/headless/worker.ts) on a loopback transport:
// ready / status / idle exits / shutdown / errors — what server/server.mjs sees of a room.
import { afterEach, describe, expect, it } from 'vitest';
import { runHeadlessRoom, startWorker, type HeadlessRoom, type HeadlessWorkerData, type WorkerToParent } from '../../../src/headless/worker';
import { ClientSession } from '../../../src/net/clientSession';
import { FakeSim } from '../../../src/net/fakeSim';
import { LoopbackNetwork } from '../../../src/net/loopback';
import { flatMap, testHeroPool, waitFor } from './fixtures';
import { FAST } from './harness';

const KEY = 'owner-key-0123456789-abcdefghijklmnop';

const rooms: HeadlessRoom[] = [];
const sessions: ClientSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.leave();
  for (const r of rooms.splice(0)) r.close('shutdown');
});

interface Run {
  net: LoopbackNetwork;
  room: HeadlessRoom;
  msgs: WorkerToParent[];
  exits: number[];
  statuses(): Extract<WorkerToParent, { type: 'status' }>[];
  closing(): Extract<WorkerToParent, { type: 'closing' }> | undefined;
}

function run(opts: { emptyLobbyMs?: number; noHumansMs?: number; statusMinMs?: number; log?: boolean } = {}): Run {
  const net = new LoopbackNetwork();
  const msgs: WorkerToParent[] = [];
  const exits: number[] = [];
  const room = runHeadlessRoom({
    transport: net.createHost('relay-host'),
    roomCode: 'SRV23',
    ownerKey: KEY,
    emptyLobbyMs: opts.emptyLobbyMs ?? 60_000,
    noHumansMs: opts.noHumansMs ?? 60_000,
    log: opts.log,
    post: (m) => msgs.push(m),
    exit: (c) => exits.push(c),
    checkMs: 20,
    statusMinMs: opts.statusMinMs ?? 0,
    exitDelayMs: 10,
    timings: FAST,
    heroes: testHeroPool(),
    createMatch: (init) => new FakeSim(init, { map: flatMap() }),
    seed: 5,
  });
  rooms.push(room);
  return {
    net,
    room,
    msgs,
    exits,
    statuses: () => msgs.filter((m): m is Extract<WorkerToParent, { type: 'status' }> => m.type === 'status'),
    closing: () => msgs.find((m): m is Extract<WorkerToParent, { type: 'closing' }> => m.type === 'closing'),
  };
}

async function join(r: Run, name: string, ownerKey?: string): Promise<ClientSession> {
  const t = await r.net.connect();
  const s = await ClientSession.connect({ transport: t, name, ownerKey, mapFactory: () => flatMap(), hostWarmUpMs: 0 });
  sessions.push(s);
  return s;
}

describe('headless room worker', () => {
  it('posts ready with the room code, then the status (humans / bots / players) as the room changes', async () => {
    const r = run({ log: true });
    expect(r.msgs[0]).toEqual({ type: 'ready', code: 'SRV23' });
    expect(r.statuses()[0]).toEqual({ type: 'status', phase: 'lobby', humans: 0, bots: 0, players: 0 });
    const a = await join(r, 'A', KEY);
    expect(a.isOwner).toBe(true);
    await waitFor(() => r.statuses().some((s) => s.humans === 1 && s.players === 1), 2000, 'a human');
    a.addBot();
    await waitFor(() => r.statuses().some((s) => s.humans === 1 && s.bots === 1 && s.players === 2), 2000, 'a bot');
    a.start();
    await waitFor(() => r.statuses().some((s) => s.phase === 'roles'), 2000, 'phase in the status');
    expect(r.msgs.some((m) => m.type === 'log' && m.msg.includes('A joined the room'))).toBe(true);
    expect(r.closing()).toBeUndefined();
  });

  it('throttles status messages to one per statusMinMs, always sending the latest', async () => {
    const r = run({ statusMinMs: 300 });
    const a = await join(r, 'A', KEY);
    a.addBot();
    a.addBot();
    a.addBot();
    await waitFor(() => r.statuses().some((s) => s.bots === 3), 2000, 'latest status');
    const s = r.statuses();
    // the first (empty room) went out at once; the burst of changes is one message with the final state
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s[s.length - 1]).toMatchObject({ humans: 1, bots: 3, players: 4 });
  });

  it('closes a room nobody joined after emptyLobbyMs', async () => {
    const r = run({ emptyLobbyMs: 150 });
    await waitFor(() => r.exits.length > 0, 2000, 'exit');
    expect(r.closing()).toMatchObject({ type: 'closing', reason: 'idle' });
    expect(r.exits).toEqual([0]);
    expect(r.room.closed).toBe(true);
  });

  it('closes a room once no human was connected for noHumansMs — not while one is', async () => {
    const r = run({ emptyLobbyMs: 100, noHumansMs: 250 });
    const a = await join(r, 'A', KEY);
    await new Promise((res) => setTimeout(res, 300)); // past emptyLobbyMs: someone joined, so no
    expect(r.closing()).toBeUndefined();
    a.leave();
    await waitFor(() => r.closing() !== undefined, 2000, 'idle close');
    expect(r.closing()?.reason).toBe('idle');
    await waitFor(() => r.exits.length > 0, 1000, 'exit');
    expect(r.exits).toEqual([0]);
  });

  it('shutdown tells the players the server closed the room, posts closing and exits', async () => {
    const r = run();
    const a = await join(r, 'A', KEY);
    const b = await join(r, 'B');
    const errs: string[] = [];
    a.on('error', (e) => errs.push(e.code));
    b.on('error', (e) => errs.push(e.code));
    r.room.close('shutdown');
    r.room.close('error', 'twice'); // idempotent: the first reason wins
    await waitFor(() => errs.length === 2, 2000, 'players told');
    expect(errs).toEqual(['serverClosed', 'serverClosed']);
    expect(r.msgs.filter((m) => m.type === 'closing')).toEqual([{ type: 'closing', reason: 'shutdown' }]);
    await waitFor(() => r.exits.length > 0, 1000, 'exit');
    expect(r.exits).toEqual([0]);
  });

  it('startWorker: relay room, parent shutdown, relay failure and uncaught errors', async () => {
    const data: HeadlessWorkerData = { relayUrl: 'ws://127.0.0.1:1/ws', ownerKey: KEY, name: '服务器', lang: 'zh', emptyLobbyMs: 60_000, noHumansMs: 60_000, log: false };
    const fakePort = () => {
      const posted: WorkerToParent[] = [];
      let onMsg: ((m: unknown) => void) | null = null;
      return {
        posted,
        send: (m: unknown) => onMsg?.(m),
        port: {
          postMessage: (m: unknown) => posted.push(m as WorkerToParent),
          on: (_ev: 'message', cb: (m: unknown) => void) => {
            onMsg = cb;
          },
        },
      };
    };

    // a room on the relay, closed by the parent
    const net = new LoopbackNetwork();
    const p1 = fakePort();
    const exits1: number[] = [];
    let fatal1: ((e: unknown) => void) | null = null;
    const room = await startWorker(data, p1.port, {
      openHost: async () => Object.assign(net.createHost('relay-host'), { roomCode: 'WRK42' }),
      exit: (c) => exits1.push(c),
      onFatal: (cb) => {
        fatal1 = cb;
      },
    });
    expect(room).not.toBeNull();
    rooms.push(room!);
    expect(p1.posted[0]).toEqual({ type: 'ready', code: 'WRK42' });
    p1.send({ type: 'nonsense' });
    expect(room!.closed).toBe(false);
    p1.send({ type: 'shutdown' });
    expect(p1.posted.find((m) => m.type === 'closing')).toEqual({ type: 'closing', reason: 'shutdown' });
    await waitFor(() => exits1.length > 0, 2000, 'exit after shutdown');
    expect(exits1).toEqual([0]);
    expect(fatal1).not.toBeNull();

    // the relay cannot create the room
    const p2 = fakePort();
    const exits2: number[] = [];
    const none = await startWorker(data, p2.port, {
      openHost: async () => {
        throw new Error('ECONNREFUSED');
      },
      exit: (c) => exits2.push(c),
      onFatal: () => undefined,
    });
    expect(none).toBeNull();
    expect(p2.posted).toEqual([{ type: 'closing', reason: 'relay', detail: 'ECONNREFUSED' }]);
    await waitFor(() => exits2.length > 0, 2000, 'exit after relay failure');
    expect(exits2).toEqual([1]);

    // anything thrown in the worker: closing 'error', exit 1
    const net3 = new LoopbackNetwork();
    const p3 = fakePort();
    const exits3: number[] = [];
    let fatal3: ((e: unknown) => void) | null = null;
    const room3 = await startWorker(data, p3.port, {
      openHost: async () => Object.assign(net3.createHost('relay-host'), { roomCode: 'WRK43' }),
      exit: (c) => exits3.push(c),
      onFatal: (cb) => {
        fatal3 = cb;
      },
    });
    rooms.push(room3!);
    (fatal3 as unknown as (e: unknown) => void)(new TypeError('boom'));
    expect(p3.posted.find((m) => m.type === 'closing')).toEqual({ type: 'closing', reason: 'error', detail: 'TypeError: boom' });
    await waitFor(() => exits3.length > 0, 2000, 'exit after an error');
    expect(exits3).toEqual([1]);
  });
});
