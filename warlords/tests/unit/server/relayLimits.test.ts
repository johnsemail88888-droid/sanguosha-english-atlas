// server/relay.mjs hardening (a public server): per-address socket and room-creation limits
// (loopback exempt; behind a local proxy the first X-Forwarded-For entry is the address),
// inbound message / byte caps, 64 KB frames, a 1 MB unread backlog, crypto room codes and
// secrets, MAX_ROOMS / HOST_GRACE_MS from the environment, idle and too-old rooms reaped
// (and not brought back by the host's resume logic), bounded connection logging.
import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { RESUME_WINDOW_MS } from '../../../src/net/wsTransport';
import {
  CREATES_PER_MIN,
  createRelay,
  HOST_GRACE_MS,
  INBOUND_LIMITS,
  MAX_PAYLOAD,
  MAX_PER_ROOM,
  MAX_SOCKETS_PER_IP,
  TERMINATE_BACKLOG,
  // @ts-expect-error plain .mjs without type declarations
} from '../../../server/relay.mjs';
// @ts-expect-error plain .mjs without type declarations
import { startServer } from '../../../server/server.mjs';

interface Sock {
  ws: WebSocket;
  ctrl: Record<string, unknown>[];
  closed: () => boolean;
  code: () => number | null;
  status: number | null;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
});

async function waitFor(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A socket to `url` (optionally as client `xff` behind the local proxy): opened, or refused with an HTTP status. */
function open(url: string, xff?: string): Promise<Sock> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, xff ? { headers: { 'X-Forwarded-For': xff } } : {});
    const ctrl: Record<string, unknown>[] = [];
    let closed = false;
    let code: number | null = null;
    const s: Sock = { ws, ctrl, closed: () => closed, code: () => code, status: null };
    ws.on('message', (d, isBinary) => {
      if (!isBinary) ctrl.push(JSON.parse(String(d)) as Record<string, unknown>);
    });
    ws.on('close', (c) => {
      closed = true;
      code = c;
    });
    ws.on('error', () => {});
    ws.on('open', () => resolve(s));
    ws.on('unexpected-response', (_req, res) => {
      s.status = res.statusCode ?? 0;
      closed = true;
      ws.terminate();
      resolve(s);
    });
  });
}

async function ownRelay(opts: Record<string, unknown> = {}) {
  const relay = createRelay(opts);
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head, req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']) : undefined));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
  cleanups.push(async () => {
    await relay.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  return { relay, url };
}

async function serve(opts: Record<string, unknown> = {}) {
  const srv = (await startServer({ port: 0, host: '127.0.0.1', distDir: '/nonexistent-sgwl-dist', quiet: true, peer: false, headless: false, ...opts })) as {
    port: number;
    close(): Promise<void>;
    relay: { stats(): { rooms: number; players: number }; counters(): Record<string, number> };
  };
  cleanups.push(() => srv.close());
  return { srv, url: `ws://127.0.0.1:${srv.port}/ws` };
}

const create = async (s: Sock, code?: string): Promise<Record<string, unknown>> => {
  const n = s.ctrl.length;
  s.ws.send(JSON.stringify({ op: 'create', v: 1, ...(code ? { code } : {}) }));
  await waitFor(() => s.ctrl.length > n || s.closed(), 3000, 'create answer');
  return s.ctrl[n] ?? {};
};
const join = async (s: Sock, code: string): Promise<Record<string, unknown>> => {
  const n = s.ctrl.length;
  s.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
  await waitFor(() => s.ctrl.length > n || s.closed(), 3000, 'join answer');
  return s.ctrl[n] ?? {};
};
/** A relay data frame: [flags][idLen][id][payload] (flags 0: reliable text). */
const frame = (to: string, payload: Uint8Array | string): Buffer => {
  const id = Buffer.from(to);
  const body = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
  return Buffer.concat([Buffer.from([typeof payload === 'string' ? 0 : 1, id.length]), id, body]);
};

describe('relay limits: the numbers', () => {
  it('as specified: 1 MB backlog, 64 KB frames, 8 seats + 4 rejoin slack, 8 sockets and 5 rooms a minute per address', () => {
    expect(TERMINATE_BACKLOG).toBe(1024 * 1024);
    expect(MAX_PAYLOAD).toBe(64 * 1024);
    expect(MAX_PER_ROOM).toBe(8 + 4);
    expect(MAX_SOCKETS_PER_IP).toBe(8);
    expect(CREATES_PER_MIN).toBe(5);
    expect(INBOUND_LIMITS.guest).toEqual({ msgs: 100, bytes: 32 * 1024 });
    // a real 8-player match: host ≤ ~320 msgs / ~220 KB a second, a guest ≤ 33 msgs / 1 KB (relayLoad.measure.test.ts)
    expect(INBOUND_LIMITS.host.msgs).toBeGreaterThanOrEqual(3 * 320);
    expect(INBOUND_LIMITS.host.bytes).toBeGreaterThanOrEqual(3 * 220 * 1024);
    expect(INBOUND_LIMITS.guest.msgs).toBeGreaterThanOrEqual(3 * 33);
  });

  it('a dropped host gets as long as it keeps trying to resume (the client resume window)', () => {
    expect(HOST_GRACE_MS).toBe(120_000);
    expect(HOST_GRACE_MS).toBeGreaterThanOrEqual(RESUME_WINDOW_MS);
  });
});

describe('relay limits: per client address', () => {
  it('≤ 8 sockets per address (HTTP 429 on the upgrade); a closed one frees its slot; loopback is exempt', async () => {
    const { srv, url } = await serve();
    const mine: Sock[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_IP; i++) mine.push(await open(url, '203.0.113.5'));
    expect(mine.every((s) => s.status === null && !s.closed())).toBe(true);
    const ninth = await open(url, '203.0.113.5, 10.0.0.1');
    expect(ninth.status).toBe(429);
    // another address is not affected
    const other = await open(url, '203.0.113.6');
    expect(other.status).toBeNull();
    // one closes: room for one more
    mine[0].ws.close();
    await waitFor(() => mine[0].closed());
    await waitFor(() => srv.relay.counters().sockets === MAX_SOCKETS_PER_IP, 2000, 'socket gone');
    const again = await open(url, '203.0.113.5');
    expect(again.status).toBeNull();
    // this machine itself (the server's room workers, a local browser): no limit
    const local: Sock[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_IP + 3; i++) local.push(await open(url));
    expect(local.every((s) => s.status === null)).toBe(true);
    for (const s of [...mine, other, again, ...local]) s.ws.close();
  });

  it('≤ 5 rooms a minute per address ({op:error, code:rateLimited}, closed 4029); resumes and loopback do not count', async () => {
    const { url } = await serve();
    const codes: string[] = [];
    for (let i = 0; i < CREATES_PER_MIN; i++) {
      const s = await open(url, '198.51.100.9');
      const got = await create(s);
      expect(got.op).toBe('created');
      codes.push(String(got.code));
      s.ws.close(1000); // (the room ends with its host: only the rate matters here)
      await waitFor(() => s.closed());
    }
    const sixth = await open(url, '198.51.100.9');
    expect(await create(sixth)).toEqual({ op: 'error', code: 'rateLimited' });
    await waitFor(() => sixth.closed());
    expect(sixth.code()).toBe(4029);
    // another address may
    const other = await open(url, '198.51.100.10');
    expect((await create(other)).op).toBe('created');
    other.ws.close();
    // the machine itself may
    for (let i = 0; i < CREATES_PER_MIN + 2; i++) {
      const s = await open(url);
      expect((await create(s)).op).toBe('created');
      s.ws.close();
    }
  });
});

describe('relay limits: inbound caps', () => {
  it('a guest flooding messages is closed (4008); the room and its host carry on', async () => {
    const { relay, url } = await ownRelay({ inbound: { guest: { msgs: 20 } } });
    const host = await open(url);
    const code = String((await create(host)).code);
    const calm = await open(url);
    await join(calm, code);
    const flood = await open(url);
    const fid = String((await join(flood, code)).id);
    for (let i = 0; i < 100; i++) flood.ws.send(frame('host', `{"t":"spam","i":${i}}`));
    await waitFor(() => flood.closed(), 3000, 'flooder closed');
    expect(flood.code()).toBe(4008);
    expect(host.closed()).toBe(false);
    expect(calm.closed()).toBe(false);
    await waitFor(() => host.ctrl.some((c) => c.op === 'peerLeave' && c.id === fid), 2000, 'peerLeave');
    expect(relay.counters().rateLimited).toBe(1);
    expect(relay.stats().players).toBe(2);
  });

  it('bytes count too (a guest sending big frames); a host gets its own, higher caps', async () => {
    const { url } = await ownRelay({ inbound: { guest: { bytes: 8 * 1024 }, host: { msgs: 1000, bytes: 1024 * 1024 } } });
    const host = await open(url);
    const code = String((await create(host)).code);
    const g = await open(url);
    const gid = String((await join(g, code)).id);
    const big = new Uint8Array(6000);
    // the host sends 40 KB at once: within its caps
    for (let i = 0; i < 7; i++) host.ws.send(frame(gid, big));
    for (let i = 0; i < 5; i++) g.ws.send(frame('host', big)); // 30 KB > 2 s × 8 KB
    await waitFor(() => g.closed(), 3000, 'guest closed');
    expect(g.code()).toBe(4008);
    expect(host.closed()).toBe(false);
  });

  it('a frame over 64 KB closes the socket (1009)', async () => {
    const { url } = await ownRelay();
    const host = await open(url);
    await create(host);
    host.ws.send(frame('*', new Uint8Array(MAX_PAYLOAD + 10)));
    await waitFor(() => host.closed(), 3000, 'closed');
    expect(host.code()).toBe(1009);
  });

  it('a socket that stops reading is terminated once 1 MB is queued for it', async () => {
    const { relay, url } = await ownRelay({ terminateBacklog: 64 * 1024, inbound: { host: { msgs: 100_000, bytes: 1e9 } } });
    const host = await open(url);
    const code = String((await create(host)).code);
    const reader = await open(url);
    const rid = String((await join(reader, code)).id);
    // the reader's socket stops reading (its receive buffer fills, the relay's queue grows)
    (reader.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const chunk = new Uint8Array(32 * 1024);
    for (let i = 0; i < 200 && relay.counters().terminatedBacklog === 0; i++) {
      host.ws.send(frame(rid, chunk));
      await new Promise((r) => setTimeout(r, 2));
    }
    await waitFor(() => relay.counters().terminatedBacklog === 1, 5000, 'terminated');
    await waitFor(() => host.ctrl.some((c) => c.op === 'peerLeave' && c.id === rid), 3000, 'peerLeave');
  });
});

describe('relay: codes and secrets', () => {
  it('come from crypto.randomInt, never Math.random', async () => {
    const randomInt = vi.spyOn(crypto, 'randomInt');
    const mathRandom = vi.spyOn(Math, 'random');
    try {
      const { url } = await ownRelay();
      const host = await open(url);
      const got = await create(host);
      expect(String(got.code)).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
      expect(String(got.secret)).toMatch(/^[A-HJ-NP-Z2-9]{24}$/);
      expect(randomInt.mock.calls.length).toBeGreaterThanOrEqual(5 + 24);
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      randomInt.mockRestore();
      mathRandom.mockRestore();
    }
  });
});

describe('relay: environment', () => {
  it('MAX_ROOMS caps the rooms (serverFull); HOST_GRACE_MS sets the dropped host’s grace', async () => {
    vi.stubEnv('MAX_ROOMS', '2');
    vi.stubEnv('HOST_GRACE_MS', '150');
    const { url } = await serve();
    const a = await open(url);
    const b = await open(url);
    expect((await create(a)).op).toBe('created');
    expect((await create(b)).op).toBe('created');
    const c = await open(url);
    expect(await create(c)).toEqual({ op: 'error', code: 'serverFull' });
    // a's host socket drops: its guest hears hostLeft after ~150 ms, not 2 minutes
    const code = String(a.ctrl[0].code);
    const g = await open(url);
    await join(g, code);
    const t0 = Date.now();
    a.ws.terminate();
    await waitFor(() => g.ctrl.some((m) => m.op === 'hostLeft'), 3000, 'hostLeft');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a full relay (MAX_ROOMS): POST /api/rooms answers 503 rooms-full instead of starting a worker that cannot get a room', async () => {
    vi.stubEnv('MAX_ROOMS', '1');
    const STUB = new URL('./fixtures/stub-room-worker.mjs', import.meta.url).pathname;
    const { srv, url } = await serve({ headless: {}, workerPath: STUB });
    const post = () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end('{}');
      });
    const host = await open(url);
    expect((await create(host)).op).toBe('created');
    const r = await post();
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ error: 'rooms-full' });
    host.ws.close(1000);
    await waitFor(() => srv.relay.stats().rooms === 0, 2000, 'room gone');
    expect((await post()).status).toBe(201);
  });

  it('defaults: 1000 rooms, a 120 s grace (a clean close still ends the room at once)', async () => {
    const { url } = await serve();
    const host = await open(url);
    const code = String((await create(host)).code);
    const g = await open(url);
    await join(g, code);
    host.ws.close(1000);
    await waitFor(() => g.ctrl.some((m) => m.op === 'hostLeft'), 1000, 'hostLeft at once');
  });
});

describe('relay: idle and old rooms end', () => {
  it('no data frame for idleRoomMs: the guests hear hostLeft, the host roomClosed (4009) — and cannot bring it back', async () => {
    const { relay, url } = await ownRelay({ idleRoomMs: 250, sweepMs: 20 });
    const host = await open(url);
    const created = await create(host);
    const code = String(created.code);
    const g = await open(url);
    await join(g, code);
    // traffic keeps it: 400 ms of frames
    const busyUntil = Date.now() + 400;
    while (Date.now() < busyUntil) {
      g.ws.send(frame('host', '{"t":"ping"}'));
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(relay.stats().rooms).toBe(1);
    // then silence (pings are not traffic)
    const silenceFrom = Date.now();
    g.ws.send(JSON.stringify({ op: 'ping' }));
    await waitFor(() => g.ctrl.some((m) => m.op === 'hostLeft'), 3000, 'reaped');
    expect(Date.now() - silenceFrom).toBeGreaterThanOrEqual(200);
    await waitFor(() => host.closed(), 2000, 'host closed');
    expect(host.ctrl.at(-1)).toMatchObject({ op: 'error', code: 'roomClosed' });
    expect(host.code()).toBe(4009);
    expect(relay.counters().reapedIdle).toBe(1);
    // the host's resume logic: resume → roomNotFound → create under the same code → refused
    const back = await open(url);
    back.ws.send(JSON.stringify({ op: 'resume', v: 1, code, secret: created.secret }));
    await waitFor(() => back.ctrl.length > 0);
    expect(back.ctrl[0]).toMatchObject({ op: 'error', code: 'roomNotFound' });
    expect(await create(back, code)).toEqual({ op: 'error', code: 'roomClosed' });
    await waitFor(() => back.closed());
    // a new room (no code asked for) is fine
    const fresh = await open(url);
    expect((await create(fresh)).op).toBe('created');
  });

  it('any room ends after maxRoomMs, busy or not', async () => {
    const { relay, url } = await ownRelay({ maxRoomMs: 300, sweepMs: 20 });
    const host = await open(url);
    const code = String((await create(host)).code);
    const g = await open(url);
    await join(g, code);
    const t0 = Date.now();
    const timer = setInterval(() => g.ws.readyState === WebSocket.OPEN && g.ws.send(frame('host', '{"t":"x"}')), 30);
    try {
      await waitFor(() => g.ctrl.some((m) => m.op === 'hostLeft'), 3000, 'ended');
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(relay.counters().reapedOld).toBe(1);
  });
});

describe('relay: logging', () => {
  it('a line per connect / close with the address, room and close code — at a bounded rate', async () => {
    const lines: string[] = [];
    const { url } = await ownRelay({ log: (m: string) => lines.push(m), connLogPerMin: 6 });
    const host = await open(url, '192.0.2.44');
    const code = String((await create(host)).code);
    const socks: Sock[] = [];
    for (let i = 0; i < 6; i++) {
      const g = await open(url, '192.0.2.45');
      await join(g, code);
      socks.push(g);
    }
    expect(lines.some((l) => l.includes(`+ 192.0.2.44 create ${code}`))).toBe(true);
    expect(lines.some((l) => /\+ 192\.0\.2\.45 join [A-Z0-9]{5} c1/.test(l))).toBe(true);
    for (const s of socks) s.ws.close(1001);
    host.ws.close(1000);
    await waitFor(() => host.closed());
    // 1 create + 6 joins + closes > 6 a minute: the rest is counted, not logged
    const conn = lines.filter((l) => /\[relay\] [+-] /.test(l));
    expect(conn.length).toBeLessThanOrEqual(6);
  });

  it('the close line has the close code and how long the socket lived', async () => {
    const lines: string[] = [];
    const { url } = await ownRelay({ log: (m: string) => lines.push(m) });
    const host = await open(url, '192.0.2.50');
    const code = String((await create(host)).code);
    const g = await open(url, '192.0.2.51');
    await join(g, code);
    g.ws.close(1001);
    await waitFor(() => lines.some((l) => l.includes(`- 192.0.2.51 ${code} c1 close 1001`)), 2000, 'close line');
    expect(lines.find((l) => l.includes('close 1001'))).toMatch(/\(\d+ s\)$/);
  });
});
