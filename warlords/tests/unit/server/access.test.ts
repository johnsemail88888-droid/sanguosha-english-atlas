// The access key (RELAY_KEY) on server/server.mjs: without it nothing changes (LAN, desktop app,
// tests); with it the relay upgrade needs ?k= (HTTP 401 before any WebSocket exists), POST
// /api/rooms ?k= or X-SGWL-Key (401 JSON key-required / bad-key; the CORS preflight stays open),
// /peerjs likewise — the page, the game files and /sgwl.json stay public ({keyRequired}, never
// the key). The server's own room workers present the key too. Constant-time comparison.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error plain .mjs without type declarations
import { createKeyCheck, startServer } from '../../../server/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, 'fixtures', 'stub-room-worker.mjs');
const KEY = 'Zm9vYmFyLWtleS0xMjM0NTY3ODkwYWJj';

interface Server {
  port: number;
  close(): Promise<void>;
  rooms: { list(): { code: string | null; ready: boolean }[] };
}
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

let distDir: string;
const servers: Server[] = [];
beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-key-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>t</title>page');
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
        let json: Record<string, unknown> = {};
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Open the relay: 'open', or the HTTP status that refused the upgrade. */
function tryRelay(srv: Server, query = ''): Promise<{ result: 'open' | number; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws${query}`);
    ws.on('open', () => resolve({ result: 'open', ws }));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ result: res.statusCode ?? 0, ws });
      ws.terminate();
    });
    ws.on('error', () => {});
  });
}

async function createOverRelay(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>));
    ws.send(JSON.stringify({ op: 'create', v: 1 }));
  });
}

describe('createKeyCheck', () => {
  it('no key: everything passes; a key: key-required / bad-key / ok, compared in constant time', () => {
    const open = createKeyCheck('');
    expect(open.required).toBe(false);
    expect(open.check(undefined)).toBeNull();
    expect(open.check('anything')).toBeNull();

    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    try {
      const k = createKeyCheck(KEY);
      expect(k.required).toBe(true);
      expect(k.check(undefined)).toBe('key-required');
      expect(k.check('')).toBe('key-required');
      expect(k.check('nope')).toBe('bad-key'); // (a shorter key: still compared, as digests)
      expect(k.check(`${KEY}x`)).toBe('bad-key');
      expect(k.check(KEY)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(3);
      for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('RELAY_KEY set', () => {
  it('the relay upgrade needs ?k= (401 before upgrading); with it rooms work as before', async () => {
    const srv = await serve({ relayKey: KEY });
    expect((await tryRelay(srv)).result).toBe(401);
    expect((await tryRelay(srv, '?k=wrong')).result).toBe(401);
    expect((await tryRelay(srv, `?k=${encodeURIComponent(KEY.slice(0, -1))}`)).result).toBe(401);
    const { result, ws } = await tryRelay(srv, `?k=${encodeURIComponent(KEY)}`);
    expect(result).toBe('open');
    expect(await createOverRelay(ws)).toMatchObject({ op: 'created' });
    ws.close();
    // the refusal is a JSON body the client can tell apart from a network failure
    const raw = await request(srv, 'GET', '/ws', undefined, { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' });
    expect(raw.status).toBe(401);
    expect(raw.json).toEqual({ error: 'key-required' });
  });

  it('POST /api/rooms: 401 key-required / bad-key; ?k= or X-SGWL-Key works; the preflight stays open', async () => {
    const srv = await serve({ relayKey: KEY });
    const body = JSON.stringify({ name: 'k' });
    const none = await request(srv, 'POST', '/api/rooms', body, { 'Content-Type': 'application/json' });
    expect(none.status).toBe(401);
    expect(none.json).toEqual({ error: 'key-required' });
    expect(none.headers['access-control-allow-origin']).toBe('*'); // (a page elsewhere can read why)
    const bad = await request(srv, 'POST', '/api/rooms?k=wrong', body, { 'Content-Type': 'application/json' });
    expect(bad).toMatchObject({ status: 401, json: { error: 'bad-key' } });
    const badHeader = await request(srv, 'POST', '/api/rooms', body, { 'Content-Type': 'application/json', 'X-SGWL-Key': 'wrong' });
    expect(badHeader).toMatchObject({ status: 401, json: { error: 'bad-key' } });

    const pre = await request(srv, 'OPTIONS', '/api/rooms', undefined, { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'POST' });
    expect(pre.status).toBe(204);
    expect(String(pre.headers['access-control-allow-headers'])).toContain('X-SGWL-Key');

    const viaQuery = await request(srv, 'POST', `/api/rooms?k=${encodeURIComponent(KEY)}`, body, { 'Content-Type': 'text/plain' });
    expect(viaQuery.status).toBe(201);
    const viaHeader = await request(srv, 'POST', '/api/rooms', body, { 'Content-Type': 'application/json', 'X-SGWL-Key': KEY });
    expect(viaHeader.status).toBe(201);
    // the room workers reached the relay with the key: their rooms are live and joinable
    const code = String(viaQuery.json.code);
    expect(srv.rooms.list().filter((r) => r.ready)).toHaveLength(2);
    const { result, ws } = await tryRelay(srv, `?k=${encodeURIComponent(KEY)}`);
    expect(result).toBe('open');
    const joined = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>));
      ws.send(JSON.stringify({ op: 'join', v: 1, code }));
    });
    expect(joined).toMatchObject({ op: 'joined', code, serverHosted: true });
    ws.close();
  });

  it('the page, the game files and /sgwl.json stay public; /sgwl.json says keyRequired and never shows the key', async () => {
    const srv = await serve({ relayKey: KEY });
    const page = await request(srv, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('page');
    const info = await request(srv, 'GET', '/sgwl.json');
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({ app: 'sanguo-warlords', relay: '/ws', keyRequired: true });
    expect(info.text).not.toContain(KEY);
  });

  it('/peerjs needs the key too when it is mounted', async () => {
    const srv = await serve({ relayKey: KEY, peer: true });
    expect((await request(srv, 'GET', '/peerjs/peerjs/id')).status).toBe(401);
    const ok = await request(srv, 'GET', `/peerjs/peerjs/id?k=${encodeURIComponent(KEY)}`);
    expect(ok.status).toBe(200);
    expect(ok.text.length).toBeGreaterThan(8);
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/peerjs/peerjs?key=peerjs&id=sgwl-K1&token=abc`);
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on('open', () => {
        resolve(101);
        ws.close();
      });
      ws.on('error', () => {});
    });
    expect(refused).toBe(401);
  });

  it('RELAY_KEY from the environment', async () => {
    vi.stubEnv('RELAY_KEY', KEY);
    try {
      const srv = await serve();
      expect((await request(srv, 'GET', '/sgwl.json')).json.keyRequired).toBe(true);
      expect((await tryRelay(srv)).result).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('RELAY_KEY unset (LAN, desktop app): exactly as before', () => {
  it('the relay and POST /api/rooms need no key; /sgwl.json keyRequired: false', async () => {
    vi.stubEnv('RELAY_KEY', '');
    try {
      const srv = await serve();
      expect((await request(srv, 'GET', '/sgwl.json')).json.keyRequired).toBe(false);
      const { result, ws } = await tryRelay(srv);
      expect(result).toBe('open');
      expect(await createOverRelay(ws)).toMatchObject({ op: 'created' });
      ws.close();
      // a stray k= does no harm
      const extra = await tryRelay(srv, '?k=whatever');
      expect(extra.result).toBe('open');
      extra.ws.close();
      const res = await request(srv, 'POST', '/api/rooms', '{}', { 'Content-Type': 'application/json' });
      expect(res.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
