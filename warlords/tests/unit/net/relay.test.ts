// server/server.mjs end-to-end in Node: static files, the /ws room relay (raw
// sockets and our WsTransport), a full host + 2 clients session over the relay,
// and the /peerjs signalling endpoint.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { emptyInput } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { FakeSim } from '../../../src/net/fakeSim';
import { HostSession } from '../../../src/net/hostSession';
import { decodeRelayFrame, encodeRelayFrame, resolveWsUrl, WsTransport } from '../../../src/net/wsTransport';
import { flatMap, testHeroPool, waitFor } from './fixtures';
// @ts-expect-error plain .mjs without type declarations
import { startServer } from '../../../server/server.mjs';
// @ts-expect-error plain .mjs without type declarations
import { createRelay, HEARTBEAT_MISSES, HOST_HEARTBEAT_MISSES, UNRELIABLE_BACKLOG as RELAY_BACKLOG } from '../../../server/relay.mjs';

interface Server {
  port: number;
  close(): Promise<void>;
}

let srv: Server;
let base: string;
let wsUrl: string;
let distDir: string;

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>t</title>ok');
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
  fs.writeFileSync(path.join(distDir, 'assets', 'model.glb'), Buffer.from([1, 2, 3]));
  srv = (await startServer({ port: 0, host: '127.0.0.1', distDir, quiet: true, peer: true })) as Server;
  base = `http://127.0.0.1:${srv.port}`;
  wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
});

afterAll(async () => {
  await srv?.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

function rawGet(p: string): Promise<{ status: number; type: string; cache: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers['content-type'] ?? ''),
          cache: String(res.headers['cache-control'] ?? ''),
          body,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static server', () => {
  it('serves files with MIME types, cache headers and SPA fallback', async () => {
    const index = await rawGet('/');
    expect(index.status).toBe(200);
    expect(index.type).toContain('text/html');
    expect(index.cache).toBe('no-cache');
    const js = await rawGet('/assets/index-AbCdEf12.js');
    expect(js.type).toContain('text/javascript');
    expect(js.cache).toContain('immutable');
    expect((await rawGet('/assets/model.glb')).type).toBe('model/gltf-binary');
    const spa = await rawGet('/lobby/ABCDE');
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('ok');
    expect((await rawGet('/missing.png')).status).toBe(404);
    const trav = await rawGet('/..%2f..%2f..%2fetc%2fpasswd');
    expect(trav.body).not.toContain('root:');
    const info = JSON.parse((await rawGet('/sgwl.json')).body);
    expect(info).toMatchObject({ app: 'sanguo-warlords', relay: '/ws', peer: '/peerjs' });
  });
});

/** A raw relay socket that records control + data frames. */
async function rawSocket(url = wsUrl): Promise<{ ws: WebSocket; ctrl: Record<string, unknown>[]; data: { peer: string; data: string | Uint8Array }[]; closed: () => boolean }> {
  const ws = new WebSocket(url);
  const ctrl: Record<string, unknown>[] = [];
  const data: { peer: string; data: string | Uint8Array }[] = [];
  let closed = false;
  ws.on('message', (d, isBinary) => {
    if (!isBinary) ctrl.push(JSON.parse(d.toString()));
    else {
      const f = decodeRelayFrame(new Uint8Array(d as Buffer));
      if (f) data.push({ peer: f.peer, data: f.data });
    }
  });
  ws.on('close', () => (closed = true));
  await new Promise((r) => ws.once('open', r));
  return { ws, ctrl, data, closed: () => closed };
}

describe('ws relay (raw sockets)', () => {
  it('creates rooms, routes frames both ways, kicks, and closes the room when the host leaves', async () => {
    const host = await rawSocket();
    host.ws.send(JSON.stringify({ op: 'create', v: 1 }));
    await waitFor(() => host.ctrl.length > 0);
    const created = host.ctrl[0] as { op: string; code: string; id: string };
    expect(created.op).toBe('created');
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);

    const a = await rawSocket();
    const b = await rawSocket();
    a.ws.send(JSON.stringify({ op: 'join', v: 1, code: created.code.toLowerCase() }));
    b.ws.send(JSON.stringify({ op: 'join', v: 1, code: created.code }));
    await waitFor(() => a.ctrl.length > 0 && b.ctrl.length > 0);
    const aId = (a.ctrl[0] as { id: string }).id;
    const bId = (b.ctrl[0] as { id: string }).id;
    expect(a.ctrl[0]).toMatchObject({ op: 'joined', hostId: 'host' });
    await waitFor(() => host.ctrl.filter((c) => c.op === 'peerJoin').length === 2);

    // host → one client (binary), host → all (text), client → host
    host.ws.send(encodeRelayFrame(aId, new Uint8Array([9, 8, 7]), 'unreliable'));
    host.ws.send(encodeRelayFrame('*', '{"t":"hi"}', 'reliable'));
    b.ws.send(encodeRelayFrame('host', 'from-b', 'reliable'));
    await waitFor(() => a.data.length === 2 && b.data.length === 1 && host.data.length === 1);
    expect(a.data[0]).toEqual({ peer: 'host', data: new Uint8Array([9, 8, 7]) });
    expect(a.data[1]).toEqual({ peer: 'host', data: '{"t":"hi"}' });
    expect(host.data[0]).toEqual({ peer: bId, data: 'from-b' });

    host.ws.send(JSON.stringify({ op: 'kick', id: bId }));
    await waitFor(() => b.closed());
    await waitFor(() => host.ctrl.some((c) => c.op === 'peerLeave' && c.id === bId));

    host.ws.close();
    await waitFor(() => a.closed());
    expect(a.ctrl.some((c) => c.op === 'hostLeft')).toBe(true);
  });

  it('rejects unknown rooms and full rooms', async () => {
    const lost = await rawSocket();
    lost.ws.send(JSON.stringify({ op: 'join', v: 1, code: 'ZZZZZ' }));
    await waitFor(() => lost.closed());
    expect(lost.ctrl[0]).toMatchObject({ op: 'error', code: 'roomNotFound' });

    const host = await rawSocket();
    host.ws.send(JSON.stringify({ op: 'create', v: 1 }));
    await waitFor(() => host.ctrl.length > 0);
    const code = (host.ctrl[0] as { code: string }).code;
    const clients: Awaited<ReturnType<typeof rawSocket>>[] = [];
    for (let i = 0; i < 7; i++) {
      const c = await rawSocket();
      c.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
      clients.push(c);
    }
    await waitFor(() => clients.every((c) => c.ctrl.length > 0));
    expect(clients.every((c) => c.ctrl[0].op === 'joined')).toBe(true);
    const eighth = await rawSocket();
    eighth.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
    await waitFor(() => eighth.closed());
    expect(eighth.ctrl[0]).toMatchObject({ op: 'error', code: 'roomFull' });
    host.ws.close();
    await waitFor(() => clients.every((c) => c.closed()));
  });
});

describe('relay heartbeat (NET-4)', () => {
  it('keeps a socket that misses a few pings (a frozen page with a full receive pipe), drops one silent for HEARTBEAT_MISSES rounds', async () => {
    expect(HEARTBEAT_MISSES).toBeGreaterThanOrEqual(4); // × 15 s: longer than a loading guest's grace
    const relay = createRelay({ heartbeatMs: 60 });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
    try {
      const host = await rawSocket(url);
      host.ws.send(JSON.stringify({ op: 'create', v: 1 }));
      await waitFor(() => host.ctrl.length > 0);
      const code = (host.ctrl[0] as { code: string }).code;
      // a guest whose page is frozen: its browser answers no pings (and sends nothing)
      const frozen = new WebSocket(url, { autoPong: false });
      let frozenClosed = false;
      frozen.on('close', () => (frozenClosed = true));
      await new Promise((r) => frozen.once('open', r));
      frozen.send(JSON.stringify({ op: 'join', v: 1, code }));
      const t0 = Date.now();
      // 3 silent rounds: still there (the old relay dropped it after one)
      await new Promise((r) => setTimeout(r, 3 * 60 + 20));
      expect(frozenClosed).toBe(false);
      expect(relay.stats().players).toBe(2);
      await waitFor(() => frozenClosed, 2000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(HEARTBEAT_MISSES * 60 - 20);
      // the host answers its pings: it stays
      expect(host.closed()).toBe(false);
      await waitFor(() => host.ctrl.some((m) => m.op === 'peerLeave'), 1000);
      host.ws.close();
    } finally {
      await relay.close();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('relay congestion', () => {
  it('drops unreliable frames for a congested socket (never reliable ones) and keeps the queue small', async () => {
    expect(RELAY_BACKLOG).toBeLessThanOrEqual(32 * 1024);
    // backlog -1: every socket counts as congested, so every unreliable frame is dropped
    const relay = createRelay({ unreliableBacklog: -1 });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
    try {
      const host = await rawSocket(url);
      host.ws.send(JSON.stringify({ op: 'create', v: 1 }));
      await waitFor(() => host.ctrl.length > 0);
      const code = (host.ctrl[0] as { code: string }).code;
      const a = await rawSocket(url);
      a.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
      await waitFor(() => a.ctrl.length > 0);
      const aId = (a.ctrl[0] as { id: string }).id;
      host.ws.send(encodeRelayFrame(aId, new Uint8Array([1, 2, 3]), 'unreliable'));
      host.ws.send(encodeRelayFrame(aId, '{"t":"events"}', 'reliable'));
      a.ws.send(encodeRelayFrame('host', new Uint8Array([4]), 'unreliable'));
      await waitFor(() => a.data.length === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(a.data).toEqual([{ peer: 'host', data: '{"t":"events"}' }]);
      expect(host.data).toEqual([]);
      expect(relay.stats().droppedUnreliable).toBe(2);
      a.ws.close();
      host.ws.close();
    } finally {
      await relay.close();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('WsTransport over the relay', () => {
  it('resolves relay URLs', () => {
    expect(resolveWsUrl('192.168.1.5:8787', null)).toBe('ws://192.168.1.5:8787/ws');
    expect(resolveWsUrl('https://game.example.com', null)).toBe('wss://game.example.com/ws');
    expect(resolveWsUrl('ws://10.0.0.2:9000/custom', null)).toBe('ws://10.0.0.2:9000/custom');
    expect(resolveWsUrl('', { protocol: 'https:', host: 'x.io:8443' })).toBe('wss://x.io:8443/ws');
    expect(resolveWsUrl('', { protocol: 'file:', host: '' })).toBeNull();
  });

  it('maps relay failures to bilingual NetErrors', async () => {
    await expect(WsTransport.join(wsUrl, 'ZZZZZ')).rejects.toMatchObject({ code: 'roomNotFound', zh: '房间不存在' });
    await expect(WsTransport.join('ws://127.0.0.1:1/ws', 'ABCDE', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'serverUnreachable' });
  });

  it('runs a host + 2 client sessions through the relay to playing, with snapshots and inputs', async () => {
    const hostT = await WsTransport.host(wsUrl);
    const sims: FakeSim[] = [];
    const host = new HostSession({
      name: '房主',
      transport: hostT,
      roomCode: hostT.roomCode,
      heroes: testHeroPool(),
      timings: { roleReveal: 0.02, lordPick: 0.5, pick: 0.5, pickReveal: 0.01, pingInterval: 0.3, dropGrace: 0 },
      preferWorkerTicker: false,
      seed: 5,
      createMatch: (init) => {
        const s = new FakeSim(init, { map: flatMap() });
        sims.push(s);
        return s;
      },
    });
    const clients: ClientSession[] = [];
    try {
      for (const name of ['甲', '乙']) {
        const t = await WsTransport.join(wsUrl, hostT.roomCode);
        clients.push(await ClientSession.connect({ transport: t, name, mapFactory: () => flatMap() }));
      }
      await waitFor(() => host.lobby.seats.length === 3, 3000, 'lobby of 3');
      expect(clients[1].lobby?.roomCode).toBe(hostT.roomCode);
      host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && host.pickHero(v.options[0]));
      for (const c of clients) c.on('heroSelect', (v) => v.options.length && v.picks[c.mySeat] === undefined && c.pickHero(v.options[0]));
      host.start();
      await waitFor(() => [host, ...clients].every((s) => s.phase === 'playing'), 6000, 'playing over ws');
      const end = Date.now() + 700;
      while (Date.now() < end) {
        for (const c of clients) {
          c.view?.pushInput({ ...emptyInput(), moveZ: 1 });
          c.view?.update(1 / 60);
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      for (const c of clients) {
        expect(c.view!.entities().length).toBe(20);
        expect(c.view!.local()?.entityId).toBe(c.view!.localId());
        expect(sims[0].inputLog.filter((x) => x.playerId === c.myId).length).toBeGreaterThan(5);
      }
      // a client leaving mid-match hands its hero to a bot
      const leaverId = clients[0].myId;
      clients[0].leave();
      await waitFor(() => sims[0].conversions.some((c) => c.kind === 'bot' && c.playerId === leaverId), 3000, 'convertToBot');
      // host leaving → remaining client gets an error
      const errs: string[] = [];
      clients[1].on('error', (e) => errs.push(e.code));
      host.leave();
      await waitFor(() => errs.length > 0, 3000, 'host left error');
      expect(errs[0]).toBe('hostLeft');
    } finally {
      for (const c of clients) c.leave();
      host.leave();
    }
  });
});

describe('PeerJS signalling mount', () => {
  it('hands out ids over HTTP and accepts peers over WebSocket', async () => {
    const id = await rawGet('/peerjs/peerjs/id');
    expect(id.status).toBe(200);
    expect(id.body.length).toBeGreaterThan(8);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/peerjs/peerjs?key=peerjs&id=sgwl-TEST2&token=abc`);
    const msg = await new Promise<string>((resolve, reject) => {
      ws.once('message', (d) => resolve(d.toString()));
      ws.once('error', reject);
    });
    expect(JSON.parse(msg)).toMatchObject({ type: 'OPEN' });
    ws.close();
  });
});

/** A relay on its own HTTP server (custom options), optionally on a given port (a restart). */
async function ownRelay(opts: Record<string, unknown> = {}, port = 0) {
  const relay = createRelay(opts);
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const p = (server.address() as { port: number }).port;
  return {
    relay,
    port: p,
    url: `ws://127.0.0.1:${p}/ws`,
    close: async () => {
      await relay.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

describe('relay: a dropped host gets its room back (MP2-8)', () => {
  it('keeps the room and the guests through a host drop, keeps their reliable frames, and hands the room back with its secret', async () => {
    const r = await ownRelay({ hostGraceMs: 5000 });
    try {
      const host = await rawSocket(r.url);
      host.ws.send(JSON.stringify({ op: 'create', v: 1 }));
      await waitFor(() => host.ctrl.length > 0);
      const { code, secret } = host.ctrl[0] as { code: string; secret: string };
      expect(secret).toMatch(/^[A-Z0-9]{16,}$/);
      const a = await rawSocket(r.url);
      a.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
      await waitFor(() => a.ctrl.length > 0);
      const aId = (a.ctrl[0] as { id: string }).id;
      a.ws.send(JSON.stringify({ op: 'ping' }));
      await waitFor(() => a.ctrl.some((c) => c.op === 'pong'));
      expect(a.ctrl.find((c) => c.op === 'pong')).toEqual({ op: 'pong', host: true });

      host.ws.terminate(); // no close frame: a dropped link (the relay sees 1006)
      await waitFor(() => r.relay.stats().players === 1, 2000, 'host gone from the room');
      expect(a.closed()).toBe(false);
      a.ws.send(JSON.stringify({ op: 'ping' }));
      await waitFor(() => a.ctrl.filter((c) => c.op === 'pong').length === 2);
      expect(a.ctrl.filter((c) => c.op === 'pong')[1]).toEqual({ op: 'pong', host: false });
      a.ws.send(encodeRelayFrame('host', '{"t":"loaded"}', 'reliable'));
      a.ws.send(encodeRelayFrame('host', new Uint8Array([2, 1]), 'unreliable'));

      // someone else cannot take the room over
      const thief = await rawSocket(r.url);
      thief.ws.send(JSON.stringify({ op: 'resume', v: 1, code, secret: 'NOPE' }));
      await waitFor(() => thief.ctrl.length > 0);
      expect(thief.ctrl[0]).toMatchObject({ op: 'error', code: 'roomNotFound' });
      expect(thief.closed()).toBe(false); // (a host whose room is gone may create it again)
      thief.ws.close();

      const back = await rawSocket(r.url);
      back.ws.send(JSON.stringify({ op: 'resume', v: 1, code, secret }));
      await waitFor(() => back.ctrl.length > 0 && back.data.length > 0);
      expect(back.ctrl[0]).toEqual({ op: 'resumed', code, id: 'host', hostId: 'host', peers: [aId] });
      expect(back.data).toEqual([{ peer: aId, data: '{"t":"loaded"}' }]); // the reliable one, kept; the snapshot-like one dropped
      back.ws.send(encodeRelayFrame(aId, 'hi again', 'reliable'));
      await waitFor(() => a.data.length === 1);
      expect(a.data[0]).toEqual({ peer: 'host', data: 'hi again' });
      a.ws.send(JSON.stringify({ op: 'ping' }));
      await waitFor(() => a.ctrl.filter((c) => c.op === 'pong').length === 3);
      expect(a.ctrl.filter((c) => c.op === 'pong')[2]).toEqual({ op: 'pong', host: true });
      back.ws.close();
      await waitFor(() => a.closed());
      expect(a.ctrl.some((c) => c.op === 'hostLeft')).toBe(true); // a clean close still ends it at once
    } finally {
      await r.close();
    }
  });

  it('a host that does not come back within the grace: the guests are told hostLeft', async () => {
    const r = await ownRelay({ hostGraceMs: 200 });
    try {
      const host = await rawSocket(r.url);
      host.ws.send(JSON.stringify({ op: 'create', v: 1 }));
      await waitFor(() => host.ctrl.length > 0);
      const { code } = host.ctrl[0] as { code: string };
      const a = await rawSocket(r.url);
      a.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
      await waitFor(() => a.ctrl.length > 0);
      const t0 = Date.now();
      host.ws.terminate();
      await waitFor(() => a.closed(), 3000, 'guest closed');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      expect(a.ctrl.some((c) => c.op === 'hostLeft')).toBe(true);
      expect(r.relay.stats().rooms).toBe(0);
    } finally {
      await r.close();
    }
  });
});

describe('WsTransport: relay liveness and the host resuming its room (MP2-1 / MP2-8)', () => {
  function makeWsHost(t: WsTransport, sims: FakeSim[]) {
    return new HostSession({
      name: '房主',
      transport: t,
      roomCode: t.roomCode,
      heroes: testHeroPool(),
      timings: { roleReveal: 0.02, lordPick: 0.5, pick: 0.5, pickReveal: 0.01, pingInterval: 0.2, peerTimeout: 1, dropGrace: 0 },
      preferWorkerTicker: false,
      seed: 7,
      createMatch: (init) => {
        const s = new FakeSim(init, { map: flatMap() });
        sims.push(s);
        return s;
      },
    });
  }

  async function toPlaying(host: HostSession, clients: ClientSession[]) {
    await waitFor(() => host.lobby.seats.length === 1 + clients.length, 3000, 'lobby');
    host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && host.pickHero(v.options[0]));
    for (const c of clients) c.on('heroSelect', (v) => v.options.length && v.picks[c.mySeat] === undefined && c.pickHero(v.options[0]));
    host.start();
    await waitFor(() => [host, ...clients].every((s) => s.phase === 'playing'), 6000, 'playing over ws');
  }

  it('a guest whose relay answers pings watches the host (hostPresenceWatched)', async () => {
    const r = await ownRelay();
    try {
      const hostT = await WsTransport.host(r.url, { pingMs: 50 });
      const g = await WsTransport.join(r.url, hostT.roomCode, { pingMs: 50 });
      expect(g.hostPresenceWatched()).toBe(false); // no answer yet: an older relay is not trusted
      await waitFor(() => g.hostPresenceWatched(), 1000, 'relay answered');
      expect(hostT.hostPresenceWatched()).toBe(false); // (a guest-side notion)
      g.close();
      hostT.close();
    } finally {
      await r.close();
    }
  });

  it('the relay drops the host socket mid-match: the host resumes the room, the guests never notice beyond a pause', async () => {
    const r = await ownRelay({ hostGraceMs: 5000 });
    const sims: FakeSim[] = [];
    const hostT = await WsTransport.host(r.url, { pingMs: 100, resumeWindowMs: 4000 });
    const host = makeWsHost(hostT, sims);
    const clients: ClientSession[] = [];
    try {
      for (const name of ['甲', '乙']) {
        const t = await WsTransport.join(r.url, hostT.roomCode, { pingMs: 100 });
        clients.push(await ClientSession.connect({ transport: t, name, mapFactory: () => flatMap(), hostWarmUpMs: 0 }));
      }
      await toPlaying(host, clients);
      const ids = clients.map((c) => c.myId);
      const hostStatus: { zh: string; en: string; key?: string; clear?: boolean }[] = [];
      const guestStatus: string[] = [];
      const errors: string[] = [];
      host.on('status', (s) => hostStatus.push(s));
      host.on('error', (e) => errors.push(`host ${e.code}`));
      for (const c of clients) {
        c.on('status', (s) => guestStatus.push(s.en));
        c.on('error', (e) => errors.push(`guest ${e.code}`));
      }
      r.relay.rooms.get(hostT.roomCode).host.ws.terminate(); // the relay loses the host's socket
      await waitFor(() => hostStatus.some((s) => s.key === 'relayLink' && s.clear), 4000, 'host back on the relay');
      expect(hostStatus[0]).toMatchObject({ key: 'relayLink', zh: '与中转服务器的连接中断，正在重新连接…' });
      expect(hostT.stats.resumed).toBe(1);
      // the match goes on for everyone on the same connections: a guest's input reaches the host
      const n0 = sims[0].inputLog.filter((x) => x.playerId === ids[0]).length;
      const end = Date.now() + 600;
      while (Date.now() < end) {
        clients[0].view?.pushInput({ ...emptyInput(), moveZ: 1 });
        clients[0].view?.update(1 / 60);
        await new Promise((res) => setTimeout(res, 16));
      }
      expect(sims[0].inputLog.filter((x) => x.playerId === ids[0]).length).toBeGreaterThan(n0);
      expect(clients.map((c) => c.myId)).toEqual(ids);
      expect(guestStatus.filter((s) => /reconnect/i.test(s))).toEqual([]);
      expect(errors).toEqual([]);
      expect(host.lobby.seats.filter((s) => !s.isBot).length).toBe(3);
      expect(host.phase).toBe('playing');
    } finally {
      for (const c of clients) c.leave();
      host.leave();
      await r.close();
    }
  });

  it('the relay restarts: the host creates the room again under the same code and the guests rejoin into their seats', async () => {
    let r = await ownRelay({ hostGraceMs: 5000 });
    const port = r.port;
    const sims: FakeSim[] = [];
    const hostT = await WsTransport.host(r.url, { pingMs: 100, resumeWindowMs: 8000 });
    const host = makeWsHost(hostT, sims);
    const code = hostT.roomCode;
    const clients: ClientSession[] = [];
    try {
      for (const name of ['甲', '乙']) {
        const t = await WsTransport.join(r.url, code, { pingMs: 100 });
        clients.push(
          await ClientSession.connect({
            transport: t,
            name,
            mapFactory: () => flatMap(),
            hostWarmUpMs: 0,
            reconnect: () => WsTransport.join(`ws://127.0.0.1:${port}/ws`, code, { pingMs: 100, timeoutMs: 1000 }),
            rejoinDelaysMs: [0, 200],
            rejoinRetryMs: 300,
          }),
        );
      }
      await toPlaying(host, clients);
      const seats = clients.map((c) => c.mySeat);
      const errors: string[] = [];
      host.on('error', (e) => errors.push(`host ${e.code}`));
      for (const c of clients) c.on('error', (e) => errors.push(`guest ${e.code}`));
      await r.close(); // the relay process dies …
      await new Promise((res) => setTimeout(res, 500));
      r = await ownRelay({ hostGraceMs: 5000 }, port); // … and comes back empty
      await waitFor(() => hostT.stats.resumed === 1, 8000, 'room created again');
      expect(hostT.roomCode).toBe(code);
      await waitFor(() => clients.every((c) => !c.reconnecting && c.phase === 'playing'), 10_000, 'guests back');
      expect(clients.map((c) => c.mySeat)).toEqual(seats);
      await waitFor(() => host.lobby.seats.filter((s) => !s.isBot).length === 3, 3000, 'humans again');
      expect(errors).toEqual([]);
    } finally {
      for (const c of clients) c.leave();
      host.leave();
      await r.close();
    }
  });

  it('no relay for longer than the resume window: the host is told 与中转服务器的连接已断开 (relayLost)', async () => {
    const r = await ownRelay();
    const hostT = await WsTransport.host(r.url, { pingMs: 100, resumeWindowMs: 600, timeoutMs: 300 });
    const host = makeWsHost(hostT, []);
    try {
      const errors: { code: string; zh: string }[] = [];
      host.on('error', (e) => errors.push(e));
      await r.close();
      await waitFor(() => errors.length > 0, 5000, 'gave up');
      expect(errors[0]).toMatchObject({ code: 'relayLost', zh: '与中转服务器的连接已断开' });
    } finally {
      host.leave();
    }
  });
});

describe('relay heartbeat for a frozen host (MP2-1 / MP2-8)', () => {
  it('a host socket gets twice the heartbeat tolerance, then the room still waits its grace for the host', async () => {
    expect(HOST_HEARTBEAT_MISSES).toBeGreaterThanOrEqual(2 * HEARTBEAT_MISSES);
    const r = await ownRelay({ heartbeatMs: 40, hostGraceMs: 400 });
    try {
      // the host's page is frozen: its browser answers no pings and sends nothing
      const host = new WebSocket(r.url, { autoPong: false });
      const ctrl: Record<string, unknown>[] = [];
      let hostClosed = false;
      host.on('message', (d, isBinary) => !isBinary && ctrl.push(JSON.parse(d.toString())));
      host.on('close', () => (hostClosed = true));
      await new Promise((res) => host.once('open', res));
      host.send(JSON.stringify({ op: 'create', v: 1 }));
      await waitFor(() => ctrl.length > 0);
      const code = (ctrl[0] as { code: string }).code;
      const a = await rawSocket(r.url);
      a.ws.send(JSON.stringify({ op: 'join', v: 1, code }));
      await waitFor(() => a.ctrl.length > 0);
      const t0 = Date.now();
      await new Promise((res) => setTimeout(res, (HEARTBEAT_MISSES + 1) * 40 + 20));
      expect(hostClosed).toBe(false); // a guest would be gone by now
      await waitFor(() => hostClosed, 3000, 'host socket dropped');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(HOST_HEARTBEAT_MISSES * 40 - 20);
      expect(a.closed()).toBe(false); // the room waits for the host to resume it
      await waitFor(() => a.closed(), 3000, 'grace over');
      expect(a.ctrl.some((c) => c.op === 'hostLeft')).toBe(true);
    } finally {
      await r.close();
    }
  });
});

describe('WsTransport resume: what the guests sent meanwhile (MP2-8)', () => {
  it('reaches the host transport right behind the "resumed" answer, peers reconciled', async () => {
    const r = await ownRelay({ hostGraceMs: 5000 });
    // the host's resume request goes out 300 ms late: the guests talk while it is away
    type Impl = NonNullable<NonNullable<Parameters<typeof WsTransport.host>[1]>['WebSocketImpl']>;
    const Native = (globalThis as unknown as { WebSocket: new (url: string) => { send(d: unknown): void } }).WebSocket;
    function SlowResume(url: string) {
      const ws = new Native(url);
      const send = ws.send.bind(ws);
      ws.send = (d: unknown) => (typeof d === 'string' && d.includes('"op":"resume"') ? void setTimeout(() => send(d), 300) : send(d));
      return ws;
    }
    try {
      const hostT = await WsTransport.host(r.url, { WebSocketImpl: SlowResume as unknown as Impl, pingMs: 1000 });
      const joins: string[] = [];
      const leaves: string[] = [];
      const got: string[] = [];
      const links: string[] = [];
      hostT.onPeerJoin((p) => joins.push(p));
      hostT.onPeerLeave((p) => leaves.push(p));
      hostT.onMessage((from, data) => typeof data === 'string' && got.push(`${from}:${data}`));
      hostT.onLinkState((s) => links.push(s));
      const a = await rawSocket(r.url);
      a.ws.send(JSON.stringify({ op: 'join', v: 1, code: hostT.roomCode }));
      const b = await rawSocket(r.url);
      b.ws.send(JSON.stringify({ op: 'join', v: 1, code: hostT.roomCode }));
      await waitFor(() => joins.length === 2, 2000, 'joins');
      const [aId, bId] = [(a.ctrl[0] as { id: string }).id, (b.ctrl[0] as { id: string }).id];
      r.relay.rooms.get(hostT.roomCode).host.ws.terminate();
      await waitFor(() => r.relay.rooms.get(hostT.roomCode)?.host === null && links.includes('reconnecting'), 2000, 'host away');
      for (let i = 0; i < 5; i++) a.ws.send(encodeRelayFrame('host', `{"t":"chat","text":"m${i}"}`, 'reliable'));
      b.ws.close(); // one guest leaves while the host is away
      const c = await rawSocket(r.url); // … and another one arrives
      c.ws.send(JSON.stringify({ op: 'join', v: 1, code: hostT.roomCode }));
      await waitFor(() => c.ctrl.length > 0, 2000, 'c joined');
      const cId = (c.ctrl[0] as { id: string }).id;
      await waitFor(() => links.at(-1) === 'ok', 3000, 'resumed');
      await waitFor(() => got.length === 5, 2000, 'kept frames delivered');
      expect(got).toEqual([0, 1, 2, 3, 4].map((i) => `${aId}:{"t":"chat","text":"m${i}"}`));
      expect(leaves).toEqual([bId]);
      expect(joins).toEqual([aId, bId, cId]);
      // and the link works both ways again
      hostT.send(aId, 'welcome back', 'reliable');
      await waitFor(() => a.data.some((d) => d.data === 'welcome back'), 2000, 'host → guest');
      hostT.close();
    } finally {
      await r.close();
    }
  });
});
