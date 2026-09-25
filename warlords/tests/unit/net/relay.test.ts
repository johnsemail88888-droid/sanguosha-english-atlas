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
import { createRelay, UNRELIABLE_BACKLOG as RELAY_BACKLOG } from '../../../server/relay.mjs';

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
