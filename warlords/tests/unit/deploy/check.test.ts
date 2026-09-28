// deploy/check.mjs against a live server/server.mjs (plain http on 127.0.0.1): the page, the relay,
// and — when /sgwl.json says headless:true — a server-hosted room started and joined through the
// relay. Server-hosted match problems are ⚠ lines, never a failed check (players then host rooms
// in their browser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script without type declarations
import { checkServer } from '../../../deploy/check.mjs';
// @ts-expect-error plain .mjs without type declarations
import { startServer } from '../../../server/server.mjs';

const STUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/fixtures/stub-room-worker.mjs');

interface Server {
  port: number;
  rooms: { list(): unknown[] };
  close(): Promise<void>;
}
interface Check {
  ok: boolean;
  lines: string[];
  headless: string;
}

let tmp: string;
const servers: Server[] = [];
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-check-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html>ok');
  fs.writeFileSync(path.join(tmp, 'broken-worker.mjs'), "throw new Error('broken bundle');\n");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(opts: Record<string, unknown>): Promise<Server> {
  const srv = (await startServer({ port: 0, host: '127.0.0.1', distDir: tmp, quiet: true, peer: false, ...opts })) as Server;
  servers.push(srv);
  return srv;
}
const check = (srv: Server, opts: Record<string, unknown> = {}): Promise<Check> =>
  checkServer(`http://127.0.0.1:${srv.port}/`, { timeoutMs: 4000, ...opts }) as Promise<Check>;

describe('deploy/check.mjs (live server)', () => {
  it('server-hosted matches on: starts a room, joins it through the relay → ✓', async () => {
    const srv = await serve({ workerPath: STUB });
    const r = await check(srv);
    expect(r.ok).toBe(true);
    expect(r.headless).toBe('ok');
    expect(r.lines.some((l) => l.includes('服务器托管对局 ✓ / Server-hosted matches ✓'))).toBe(true);
    expect(srv.rooms.list()).toHaveLength(1); // the test room ends by itself (idle)
  });

  it('--no-headless: no test room', async () => {
    const srv = await serve({ workerPath: STUB });
    const r = await check(srv, { headless: false });
    expect(r).toMatchObject({ ok: true, headless: 'skipped' });
    expect(srv.rooms.list()).toHaveLength(0);
  });

  it('off (no bundle): a clear warning, not a failure', async () => {
    const srv = await serve({ workerPath: path.join(tmp, 'missing.mjs') });
    const r = await check(srv);
    expect(r).toMatchObject({ ok: true, headless: 'off' });
    expect(r.lines.at(-1)).toMatch(/^⚠ .*Server-hosted matches: off/);
  });

  it('a broken bundle: ⚠ did not start — the relay check still passes', async () => {
    const srv = await serve({ workerPath: path.join(tmp, 'broken-worker.mjs') });
    const r = await check(srv);
    expect(r).toMatchObject({ ok: true, headless: 'failed' });
    expect(r.lines.at(-1)).toMatch(/^⚠ .*did not start \(HTTP 500 worker-failed\)/);
  });

  it('all rooms busy: ⚠ busy, not broken', async () => {
    const srv = await serve({ workerPath: STUB, headless: { maxRooms: 0 } });
    const r = await check(srv);
    expect(r).toMatchObject({ ok: true, headless: 'busy' });
  });
});
