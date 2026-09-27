// Server-hosted ("headless") rooms: POST /api/rooms on server/server.mjs spawning room workers
// (server/rooms.mjs). A stub worker (fixtures/stub-room-worker.mjs) follows the worker contract
// without the game: ready / status / closing, shutdown, a start that never gets ready, crashes.
// The last block runs the real bundle (dist-headless/room-worker.mjs, `npm run build:headless`)
// and is skipped when it has not been built.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../../src/core/types';
// @ts-expect-error plain .mjs without type declarations
import { clientIp, startServer } from '../../../server/server.mjs';
// @ts-expect-error plain .mjs without type declarations
import { cleanRoomName, createHeadlessRooms } from '../../../server/rooms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, 'fixtures', 'stub-room-worker.mjs');
const REAL = path.resolve(HERE, '../../../dist-headless/room-worker.mjs');

interface Rooms {
  available(): boolean;
  stats(): { headless: boolean; headlessRooms: number; headlessHumans: number };
  list(): { code: string | null; phase: string; humans: number; ready: boolean }[];
}
interface Server {
  port: number;
  rooms: Rooms;
  close(): Promise<void>;
}
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let distDir: string;
const servers: Server[] = [];

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-rooms-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>t</title>ok');
});
afterAll(() => fs.rmSync(distDir, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(opts: Record<string, unknown> = {}): Promise<Server> {
  const srv = (await startServer({ port: 0, host: '127.0.0.1', distDir, quiet: true, peer: false, workerPath: STUB, ...opts })) as Server;
  servers.push(srv);
  return srv;
}

function request(srv: Server, method: string, p: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          parsed = { raw: text };
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST /api/rooms as client `ip` (the test's socket is loopback: the server trusts X-Forwarded-For). */
const createRoom = (srv: Server, body: Record<string, unknown> = {}, ip = '203.0.113.1', type = 'application/json'): Promise<Answer> =>
  request(srv, 'POST', '/api/rooms', JSON.stringify(body), { 'Content-Type': type, 'X-Forwarded-For': `${ip}, 10.0.0.1` });

const info = async (srv: Server): Promise<Record<string, unknown>> => (await request(srv, 'GET', '/sgwl.json')).body;

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
/** The relay's data frame (src/net/wsTransport.ts encodeRelayFrame): [flags][idLen][id][payload], text = flags 0. */
function relayText(to: string, text: string): Uint8Array {
  const id = enc.encode(to);
  const body = enc.encode(text);
  const out = new Uint8Array(2 + id.length + body.length);
  out[0] = 0;
  out[1] = id.length;
  out.set(id, 2);
  out.set(body, 2 + id.length);
  return out;
}

interface Guest {
  ws: WebSocket;
  ctrl: Record<string, unknown>[];
  /** the text payloads of data frames, parsed (HostMsg JSON) */
  msgs: Record<string, unknown>[];
  closed: () => boolean;
}

async function guest(srv: Server, code: string): Promise<Guest> {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const ctrl: Record<string, unknown>[] = [];
  const msgs: Record<string, unknown>[] = [];
  let closed = false;
  ws.on('message', (d, isBinary) => {
    const buf = new Uint8Array(d as Buffer);
    if (!isBinary) {
      ctrl.push(JSON.parse(dec.decode(buf)) as Record<string, unknown>);
      return;
    }
    if (buf.length < 2 || buf[0] & 1) return; // binary payloads (snapshots) are not JSON
    try {
      msgs.push(JSON.parse(dec.decode(buf.subarray(2 + buf[1]))) as Record<string, unknown>);
    } catch {
      /* not JSON */
    }
  });
  ws.on('close', () => (closed = true));
  ws.on('error', () => {});
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ op: 'join', v: 1, code }));
  await waitFor(() => ctrl.length > 0 || closed, 3000, 'join answer');
  return { ws, ctrl, msgs, closed: () => closed };
}

describe('POST /api/rooms (stub worker)', () => {
  it('starts a room: 201 {code, ownerKey}, CORS, relay room joinable, /sgwl.json counts it', async () => {
    const srv = await serve();
    expect(await info(srv)).toMatchObject({ app: 'sanguo-warlords', headless: true, headlessRooms: 0, headlessHumans: 0 });
    const res = await createRoom(srv, { name: '甘宁的房间', lang: 'en' });
    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
    const { code, ownerKey } = res.body as { code: string; ownerKey: string };
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(ownerKey.length).toBeGreaterThanOrEqual(32);
    expect(ownerKey).toMatch(/^[A-Za-z0-9_-]+$/);

    const g = await guest(srv, code);
    expect(g.ctrl[0]).toMatchObject({ op: 'joined', code, hostId: 'host' });
    await waitFor(async () => (await info(srv)).headlessHumans === 1, 3000, 'headlessHumans 1');
    expect(await info(srv)).toMatchObject({ headless: true, headlessRooms: 1, headlessHumans: 1, rooms: 1 });
    expect(srv.rooms.list()).toMatchObject([{ code, phase: 'lobby', humans: 1, ready: true }]);
    g.ws.close();
    await waitFor(async () => (await info(srv)).headlessHumans === 0, 3000, 'headlessHumans 0');
  });

  it('takes text/plain (no preflight) and an empty body; refuses bad JSON, other types, big bodies, GET', async () => {
    const srv = await serve();
    expect((await createRoom(srv, { name: 'x' }, '203.0.113.2', 'text/plain;charset=UTF-8')).status).toBe(201);
    expect((await request(srv, 'POST', '/api/rooms', '', { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(201);
    const bad = await request(srv, 'POST', '/api/rooms', '{nope', { 'Content-Type': 'application/json' });
    expect(bad).toMatchObject({ status: 400, body: { error: 'bad-request' } });
    expect(bad.headers['access-control-allow-origin']).toBe('*');
    expect((await request(srv, 'POST', '/api/rooms', '[1]', { 'Content-Type': 'application/json' })).status).toBe(400);
    expect((await request(srv, 'POST', '/api/rooms', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(400);
    const big = await request(srv, 'POST', '/api/rooms', JSON.stringify({ name: 'x'.repeat(3000) }), { 'Content-Type': 'application/json' });
    expect(big.status).toBe(413);
    const get = await request(srv, 'GET', '/api/rooms');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toContain('POST');
  });

  it('answers the CORS preflight', async () => {
    const srv = await serve();
    const res = await request(srv, 'OPTIONS', '/api/rooms', undefined, {
      Origin: 'https://example.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('content-type');
  });

  it('a worker that never gets ready → 500 worker-failed, cleaned up', async () => {
    const srv = await serve({ headless: { readyTimeoutMs: 300 } });
    const res = await createRoom(srv, { name: 'hang' });
    expect(res).toMatchObject({ status: 500, body: { error: 'worker-failed' } });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    await waitFor(() => srv.rooms.list().length === 0, 3000, 'hung worker gone');
    expect(await info(srv)).toMatchObject({ headless: true, headlessRooms: 0 });
  });

  it('a worker that crashes or bails while starting → 500, cleaned up; two in a row pause rooms (503, clients host)', async () => {
    const srv = await serve({ headless: { pauseAfterFailures: 2, pauseMs: 60_000 } });
    expect(await createRoom(srv, { name: 'crash' }, '203.0.113.3')).toMatchObject({ status: 500, body: { error: 'worker-failed' } });
    expect(await createRoom(srv, { name: 'bail' }, '203.0.113.4')).toMatchObject({ status: 500, body: { error: 'worker-failed' } });
    await waitFor(() => srv.rooms.list().length === 0, 3000, 'crashed workers gone');
    expect(await createRoom(srv, {}, '203.0.113.5')).toMatchObject({ status: 503, body: { error: 'headless-unavailable' } });
    expect((await info(srv)).headless).toBe(false);
  });

  it('a room that crashes mid-game ends its relay room at once (guests hear hostLeft, no 30 s grace)', async () => {
    const srv = await serve();
    const res = await createRoom(srv, { name: 'crash-later' });
    expect(res.status).toBe(201);
    const g = await guest(srv, (res.body as { code: string }).code);
    await waitFor(() => g.closed(), 3000, 'guest closed');
    expect(g.ctrl.some((c) => c.op === 'hostLeft')).toBe(true);
    await waitFor(() => srv.rooms.list().length === 0, 3000, 'room gone');
    expect((await info(srv)).rooms).toBe(0);
  });

  it('HEADLESS_MAX_ROOMS: the next one → 503 rooms-full', async () => {
    const srv = await serve({ headless: { maxRooms: 2 } });
    expect((await createRoom(srv, {}, '198.51.100.1')).status).toBe(201);
    expect((await createRoom(srv, {}, '198.51.100.2')).status).toBe(201);
    expect(await createRoom(srv, {}, '198.51.100.3')).toMatchObject({ status: 503, body: { error: 'rooms-full' } });
    expect(await info(srv)).toMatchObject({ headless: true, headlessRooms: 2 });
  });

  it('rate limit per client IP (first X-Forwarded-For entry behind a local proxy) → 429', async () => {
    const srv = await serve({ headless: { perIpPerMin: 2, maxRooms: 10 } });
    expect((await createRoom(srv, {}, '192.0.2.7')).status).toBe(201);
    expect((await createRoom(srv, {}, '192.0.2.7')).status).toBe(201);
    const third = await createRoom(srv, {}, '192.0.2.7');
    expect(third).toMatchObject({ status: 429, body: { error: 'rate-limited' } });
    expect(third.headers['access-control-allow-origin']).toBe('*');
    expect((await createRoom(srv, {}, '192.0.2.8')).status).toBe(201);
  });

  it('a server-hosted room seats 8 humans (its host is the server): the 9th guest is refused by the relay', async () => {
    const srv = await serve();
    const res = await createRoom(srv);
    const code = (res.body as { code: string }).code;
    const guests: Guest[] = [];
    for (let i = 0; i < 8; i++) guests.push(await guest(srv, code));
    expect(guests.every((g) => g.ctrl[0]?.op === 'joined')).toBe(true);
    const ninth = await guest(srv, code);
    expect(ninth.ctrl[0]).toMatchObject({ op: 'error', code: 'roomFull' });
    for (const g of guests) g.ws.close();
  });

  it('an empty room ends by itself (emptyLobbyMs)', async () => {
    const srv = await serve({ headless: { emptyLobbyMs: 200 } });
    expect((await createRoom(srv)).status).toBe(201);
    expect((await info(srv)).headlessRooms).toBe(1);
    await waitFor(async () => (await info(srv)).headlessRooms === 0 && (await info(srv)).rooms === 0, 3000, 'idle room gone');
  });

  it('503 headless-unavailable without the bundle, or with HEADLESS off — /sgwl.json says headless:false', async () => {
    const lines: string[] = [];
    const missing = (await startServer({
      port: 0,
      host: '127.0.0.1',
      distDir,
      peer: false,
      workerPath: path.join(distDir, 'no-such-worker.mjs'),
      log: (m: string) => lines.push(m),
    })) as Server;
    servers.push(missing);
    expect(await createRoom(missing)).toMatchObject({ status: 503, body: { error: 'headless-unavailable' } });
    expect(await info(missing)).toMatchObject({ headless: false, headlessRooms: 0, headlessHumans: 0 });
    expect(lines.join('\n')).toContain('npm run build:headless');
    const off = await serve({ headless: false });
    expect(await createRoom(off)).toMatchObject({ status: 503, body: { error: 'headless-unavailable' } });
    expect((await info(off)).headless).toBe(false);
  });

  it('close() shuts the rooms down first: guests hear the room close, a stubborn worker is terminated', async () => {
    const srv = await serve({ headless: { maxRooms: 4 } });
    const a = await createRoom(srv, {}, '198.51.100.10');
    const b = await createRoom(srv, { name: 'stubborn' }, '198.51.100.11');
    const ga = await guest(srv, (a.body as { code: string }).code);
    const gb = await guest(srv, (b.body as { code: string }).code);
    servers.splice(servers.indexOf(srv), 1);
    const t0 = Date.now();
    await srv.close();
    const took = Date.now() - t0;
    expect(ga.msgs).toContainEqual({ t: 'leave' }); // the room's own goodbye (HostMsg 'leave')
    expect(took).toBeLessThan(6000);
    expect(took).toBeGreaterThanOrEqual(2500); // the stubborn one waited out its 3 s
    await waitFor(() => ga.closed() && gb.closed(), 3000, 'guests closed');
    expect(srv.rooms.list()).toEqual([]);
    expect(srv.rooms.available()).toBe(false);
  });
});

describe('rooms helpers', () => {
  it('client IP: the socket peer, or the first X-Forwarded-For entry when the peer is a local proxy', () => {
    const req = (remoteAddress: string, xff?: string): unknown => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    expect(clientIp(req('127.0.0.1', '203.0.113.9, 100.64.0.1'))).toBe('203.0.113.9');
    expect(clientIp(req('::1', '2001:db8::1'))).toBe('2001:db8::1');
    expect(clientIp(req('::ffff:127.0.0.1', ' 198.51.100.4 '))).toBe('198.51.100.4');
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    // a LAN / internet peer cannot pick its own address
    expect(clientIp(req('::ffff:192.168.1.20', '1.2.3.4'))).toBe('192.168.1.20');
    expect(clientIp(req('198.51.100.7', '1.2.3.4'))).toBe('198.51.100.7');
  });

  it('room names: control characters out, ≤ 16 characters, a default', () => {
    expect(cleanRoomName('  甘宁\n的\u0000房间  ')).toBe('甘宁的房间');
    expect(cleanRoomName('x'.repeat(40))).toHaveLength(16);
    expect(cleanRoomName(42)).toBe('服务器');
    expect(cleanRoomName('   ')).toBe('服务器');
  });

  it('available() follows the bundle file (built later / removed after a failed build)', () => {
    const f = path.join(distDir, 'late-worker.mjs');
    const rooms = createHeadlessRooms({ workerPath: f, relayUrl: () => 'ws://127.0.0.1:1/ws' }) as Rooms;
    expect(rooms.available()).toBe(false);
    fs.writeFileSync(f, '');
    expect(rooms.available()).toBe(true);
    fs.rmSync(f);
    expect(rooms.available()).toBe(false);
    const off = createHeadlessRooms({ workerPath: STUB, relayUrl: () => '', enabled: false }) as Rooms;
    expect(off.available()).toBe(false);
  });
});

describe.skipIf(!fs.existsSync(REAL))('the real room worker (dist-headless/room-worker.mjs)', () => {
  it('POST → join through the relay → hello with the owner key → welcome from a headless lobby, owner = my seat', async () => {
    const srv = await serve({ workerPath: REAL });
    const res = await createRoom(srv, { name: '测试房', lang: 'zh' });
    expect(res.status).toBe(201);
    const { code, ownerKey } = res.body as { code: string; ownerKey: string };
    const g = await guest(srv, code);
    expect(g.ctrl[0]).toMatchObject({ op: 'joined', code });
    const hostId = String(g.ctrl[0].hostId);
    g.ws.send(relayText(hostId, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'tester', owner: ownerKey })));
    await waitFor(() => g.msgs.some((m) => m.t === 'welcome'), 8000, 'welcome');
    const welcome = g.msgs.find((m) => m.t === 'welcome') as { seat: number; lobby: { headless?: boolean; ownerSeat?: number } };
    expect(welcome.lobby.headless).toBe(true);
    expect(welcome.lobby.ownerSeat).toBe(welcome.seat);
    await waitFor(async () => (await info(srv)).headlessHumans === 1, 5000, 'headlessHumans 1');

    // a second player without the key is an ordinary guest, not the owner
    const g2 = await guest(srv, code);
    g2.ws.send(relayText(hostId, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'other' })));
    await waitFor(() => g2.msgs.some((m) => m.t === 'welcome'), 8000, 'second welcome');
    const w2 = g2.msgs.find((m) => m.t === 'welcome') as { seat: number; lobby: { ownerSeat?: number } };
    expect(w2.seat).not.toBe(welcome.seat);
    expect(w2.lobby.ownerSeat).toBe(welcome.seat);
    g.ws.close();
    g2.ws.close();
  }, 30_000);
});
