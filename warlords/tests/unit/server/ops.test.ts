// Running server/server.mjs as a service: HTTP keep-alive longer than tailscaled's idle
// connections (95 s / headers 96 s), ISO timestamps on every log line, a stats line a minute with
// deltas, /sgwl.json with the build, uptime and memory (old keys kept), and a crash that exits 1
// (launchd / systemd restart it) instead of limping on.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error plain .mjs without type declarations
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_MS, startServer, statsLine } from '../../../server/server.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/server.mjs');
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function serve(opts: Record<string, unknown> = {}) {
  const srv = (await startServer({ port: 0, host: '127.0.0.1', distDir: '/nonexistent-sgwl-dist', peer: false, headless: false, quiet: true, ...opts })) as {
    port: number;
    close(): Promise<void>;
  };
  cleanups.push(() => srv.close());
  return srv;
}

function get(port: number, p: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

describe('HTTP keep-alive', () => {
  it('outlasts tailscaled’s 90 s idle connections (Keep-Alive: timeout=95)', async () => {
    expect(KEEP_ALIVE_MS).toBe(95_000);
    expect(HEADERS_TIMEOUT_MS).toBe(96_000);
    const srv = await serve();
    const res = await get(srv.port, '/sgwl.json');
    expect(res.headers['keep-alive']).toBe('timeout=95');
  });
});

describe('/sgwl.json', () => {
  it('keeps its keys and adds keyRequired, build {compat, sha}, uptime, rss', async () => {
    vi.stubEnv('SGWL_GIT_SHA', '0123456789abcdef0123456789abcdef01234567');
    const srv = await serve();
    const j = JSON.parse((await get(srv.port, '/sgwl.json')).body) as Record<string, unknown>;
    for (const k of ['app', 'relay', 'peer', 'rooms', 'players', 'droppedUnreliable', 'headless', 'headlessRooms', 'headlessHumans', 'headlessPlaying']) expect(j).toHaveProperty(k);
    expect(j).toMatchObject({ app: 'sanguo-warlords', keyRequired: false, build: { compat: null, sha: '0123456789abcdef0123456789abcdef01234567' } });
    expect(typeof j.uptime).toBe('number');
    expect(j.rss as number).toBeGreaterThan(1e6);
  });
});

describe('logs', () => {
  it('every line of the default log starts with an ISO timestamp', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
    const srv = await serve({ quiet: false });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatch(ISO);
    // a relay room: its connect line is stamped too
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ op: 'create', v: 1 }));
    await new Promise((r) => ws.once('message', r));
    ws.close();
    expect(out.find((l) => l.includes('[relay] + 127.0.0.1 create'))).toMatch(ISO);
  });

  it('a stats line with deltas while anything happens; nothing while idle', async () => {
    const lines: string[] = [];
    const srv = await serve({ quiet: false, log: (m: string) => lines.push(m), statsMs: 60 });
    await new Promise((r) => setTimeout(r, 200));
    expect(lines.filter((l) => l.startsWith('[stats]'))).toEqual([]); // idle: at most one an hour
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ op: 'create', v: 1 }));
    await new Promise((r) => ws.once('message', r));
    await new Promise((r) => setTimeout(r, 150));
    const stats = lines.filter((l) => l.startsWith('[stats]'));
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.join('\n')).toMatch(/rooms 1 \(\+1 −0\) · sockets 1 \(\+1 −0\) · in [\d.]+ MB · out [\d.]+ MB · dropped 0/);
    expect(stats[0]).toMatch(/rss [\d.]+ MB · headless 0 rooms, 0 humans, 0 playing$/);
    ws.close();
  });

  it('statsLine: deltas since the last line, trouble only when there was some', () => {
    const prev = { sockets: 2, socketsOpened: 10, socketsClosed: 8, roomsCreated: 3, roomsClosed: 2, bytesIn: 0, bytesOut: 0, droppedUnreliable: 5, rateLimited: 0, refusedKeys: 1 };
    const now = { ...prev, sockets: 4, socketsOpened: 13, socketsClosed: 9, bytesIn: 2 * 1048576, bytesOut: 10 * 1048576, droppedUnreliable: 7, rateLimited: 1, refusedKeys: 4, httpRequests: 12, httpBytes: 1048576 };
    const line = statsLine(now, { ...prev, httpRequests: 2, httpBytes: 0 }, { rooms: 1 }, { headlessRooms: 1, headlessHumans: 3, headlessPlaying: 1 }, 150 * 1048576);
    expect(line).toBe(
      '[stats] rooms 1 (+0 −0) · sockets 4 (+3 −1) · in 2.0 MB · out 10.0 MB · dropped 2 · terminated 0 · rate-limited 1 · refused sockets 0 / rooms 0 / keys 3 · reaped 0 idle / 0 old · http 10 requests, 1.0 MB sent · rss 150.0 MB · headless 1 rooms, 3 humans, 1 playing',
    );
  });
});

describe('a crash', () => {
  it('uncaught exception / unhandled rejection: logged with a timestamp, exit 1 (the service manager restarts it)', async () => {
    for (const bomb of ['setTimeout(() => { throw new Error("boom") }, 300)', 'setTimeout(() => Promise.reject(new Error("boom")), 300)']) {
      const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bomb)}`, SERVER], {
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1', NO_PEER: '1', HEADLESS: '0', DIST_DIR: '/nonexistent-sgwl-dist' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.stdout.on('data', () => {});
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, 10_000);
        child.on('exit', (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      expect(code).toBe(1);
      expect(err).toMatch(/\d{4}-\d\d-\d\dT[\d:.]+Z (uncaught exception|unhandled rejection): Error: boom/);
    }
  }, 30_000);
});
