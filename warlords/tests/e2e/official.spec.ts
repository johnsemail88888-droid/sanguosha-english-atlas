// The official online server (src/net/official.ts), end to end. The game is built with
// VITE_OFFICIAL_RELAY / VITE_OFFICIAL_WEB pointing at a local `node server/server.mjs`
// (the "official server", serving that same build — what deploy/install.sh sets up on a
// cloud server). The host plays on a page that is NOT our server (a plain static host,
// like GitHub Pages) with zero settings touched: the online screen starts on
// 官方服务器（推荐）, the title's 邀请朋友一起玩 creates the room on the official relay, the
// invite link carries mode=ws&ws=<official relay>, and the friend opening it lands in
// the host's lobby — through the official server (its /sgwl.json counts the room).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { CACHE, PORT_OFFSET, ROOT, launchBrowser, openGame, relevantErrors, type GamePage } from './fixtures/game-fixture';

const OFFICIAL_PORT = 8793 + PORT_OFFSET;
const PAGE_PORT = 5321 + PORT_OFFSET;
const OFFICIAL_WEB = `http://127.0.0.1:${OFFICIAL_PORT}/`;
const OFFICIAL_RELAY = `ws://127.0.0.1:${OFFICIAL_PORT}/ws`;
const DIST_OFFICIAL = path.join(CACHE, 'dist-official');
const VIEWPORT = { width: 640, height: 360 };

let browser: Browser;
let server: ChildProcess | null = null;
let closePage: (() => Promise<void>) | null = null;

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`server did not come up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(6 * 60_000);
  // a build that knows its official server (no code edit: the build-time env)
  if (process.env.SGWL_E2E_SKIP_BUILD !== '1' || !existsSync(path.join(DIST_OFFICIAL, 'index.html'))) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', DIST_OFFICIAL, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, VITE_OFFICIAL_RELAY: OFFICIAL_RELAY, VITE_OFFICIAL_WEB: OFFICIAL_WEB },
    });
    if (r.status !== 0) throw new Error(`vite build (official) failed:\n${r.stdout}\n${r.stderr}`);
  }
  // the official server: server.mjs serving that build + the /ws relay
  server = spawn(process.execPath, ['server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(OFFICIAL_PORT), HOST: '127.0.0.1', DIST_DIR: DIST_OFFICIAL },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[official] ${d}`));
  await waitHttp(`${OFFICIAL_WEB}sgwl.json`, 30_000);
  // the page players open: a plain static host of the same build (no /sgwl.json, no relay) — like GitHub Pages
  const { preview } = await import('vite');
  const srv = await preview({
    root: ROOT,
    configFile: false,
    base: './',
    logLevel: 'error',
    build: { outDir: DIST_OFFICIAL },
    preview: { port: PAGE_PORT, strictPort: true, host: '127.0.0.1', open: false },
  });
  closePage = () => srv.close();
  await waitHttp(`http://127.0.0.1:${PAGE_PORT}/`, 30_000);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await closePage?.();
  if (server && server.exitCode === null) {
    const s = server;
    await new Promise<void>((resolve) => {
      s.once('exit', () => resolve());
      s.kill('SIGTERM');
      setTimeout(() => resolve(), 3000);
    });
  }
});

const PAGE = (): string => `http://127.0.0.1:${PAGE_PORT}/`;

async function roomsOnOfficial(): Promise<number> {
  const j = (await (await fetch(`${OFFICIAL_WEB}sgwl.json`)).json()) as { rooms: number };
  return j.rooms;
}

test('the online screen starts on 官方服务器（推荐）; P2P and 自建服务器 stay selectable', async () => {
  const g = await openGame(browser, `${PAGE()}?debug=1`, { viewport: VIEWPORT, name: '玩家' });
  try {
    await g.page.locator('[data-screen="title"] .sg-title-menu button:not(.sg-invite-btn)', { hasText: /联机对战|Play Online/ }).first().click();
    const seg = g.page.locator('.sg-online-mode .sg-seg');
    await expect(seg.locator('button')).toHaveCount(3);
    await expect(seg.locator('button[data-value="official"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.locator('button[data-value="official"]')).toContainText(/官方服务器|Official/);
    await expect(g.page.locator('.sg-online .sg-warn')).toHaveCount(0);
    await g.page.screenshot({ path: test.info().outputPath('official-online-screen.png') });
    // P2P is one click away (and back)
    await seg.locator('button[data-value="peer"]').click();
    await expect(seg.locator('button[data-value="peer"]')).toHaveAttribute('aria-pressed', 'true');
    await seg.locator('button[data-value="official"]').click();
    await expect(seg.locator('button[data-value="official"]')).toHaveAttribute('aria-pressed', 'true');
    expect(relevantErrors(g.errors)).toEqual([]);
  } finally {
    await g.ctx.close();
  }
});

/** A PeerJS signalling server nobody answers on: the way 0.peerjs.com looks from a network that blocks it. */
const DEAD_SIGNALLING = {
  net: { mode: 'peer', peerHost: '127.0.0.1', peerPort: 9, peerPath: '/', peerSecure: false, wsUrl: '', turnUrl: '', turnUser: '', turnPass: '' },
};

test('P2P blocked: creating a room says the signalling server is unreachable; 改用官方服务器重试 makes it on the official server', async () => {
  test.setTimeout(3 * 60_000);
  const g = await openGame(browser, `${PAGE()}?debug=1`, { viewport: { width: 1024, height: 576 }, name: '房主', settings: DEAD_SIGNALLING });
  try {
    await g.page.locator('[data-screen="title"] .sg-title-menu button:not(.sg-invite-btn)', { hasText: /联机对战|Play Online/ }).first().click();
    await g.page.locator('.sg-online-mode .sg-seg button[data-value="peer"]').click();
    await g.page.locator('.sg-online-cols .col button.gold').first().click();
    const help = g.page.locator('.sg-online-status .p2p-help');
    await expect(help).toHaveAttribute('data-reason', 'signal', { timeout: 30_000 });
    await expect(g.page.locator('.sg-online-status .err')).toContainText(/信令服务器|signalling server/);
    await expect(help.locator('.p2p-fix')).toContainText(/改用官方服务器重试|official server/);
    await g.page.screenshot({ path: test.info().outputPath('official-p2p-failed.png') });
    const before = await roomsOnOfficial();
    await help.locator('.p2p-fix').click();
    await expect(g.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 60_000 });
    await expect.poll(roomsOnOfficial).toBe(before + 1);
    expect(relevantErrors(g.errors).filter((e) => !/127\.0\.0\.1:9\b/.test(e))).toEqual([]);
  } finally {
    await g.ctx.close();
  }
});

test('联机检测: three probes with ✓/✗ and ms (signalling down here, the official relay up)', async () => {
  test.setTimeout(3 * 60_000);
  const g = await openGame(browser, `${PAGE()}?debug=1`, { viewport: { width: 1024, height: 576 }, name: '玩家', settings: DEAD_SIGNALLING });
  try {
    await g.page.locator('[data-screen="title"] .sg-title-menu button:not(.sg-invite-btn)', { hasText: /联机对战|Play Online/ }).first().click();
    await g.page.locator('.net-check-btn').click();
    const rows = g.page.locator('.sg-netcheck .rows li');
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await expect(g.page.locator('.sg-netcheck li[data-probe="signal"]')).toHaveClass(/bad/);
    await expect(g.page.locator('.sg-netcheck li[data-probe="signal"]')).toContainText('✗');
    await expect(g.page.locator('.sg-netcheck li[data-probe="relay"]')).toHaveClass(/ok/);
    await expect(g.page.locator('.sg-netcheck li[data-probe="relay"]')).toContainText(/✓ .*127\.0\.0\.1:\d+.* · \d+ ms/);
    await expect(g.page.locator('.sg-netcheck li[data-probe="ice"]')).toContainText(/[✓✗]/);
    await expect(g.page.locator('.sg-netcheck .verdict')).toContainText(/官方服务器|official server/i);
    await g.page.locator('.sg-netcheck').scrollIntoViewIfNeeded();
    await g.page.screenshot({ path: test.info().outputPath('official-netcheck.png') });
    expect(relevantErrors(g.errors).filter((e) => !/127\.0\.0\.1:9\b/.test(e))).toEqual([]);
  } finally {
    await g.ctx.close();
  }
});

test('邀请朋友一起玩 with zero settings touched: the room is on the official relay, the friend joins from the link', async () => {
  test.setTimeout(5 * 60_000);
  const pages: GamePage[] = [];
  try {
    const before = await roomsOnOfficial();
    const host = await openGame(browser, `${PAGE()}?debug=1`, { viewport: VIEWPORT, name: '主持人' });
    pages.push(host);
    await host.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PAGE().replace(/\/$/, '') });
    await host.page.locator('[data-screen="title"] .sg-invite-btn').click();
    const field = host.page.locator('[data-screen="lobby"] .invite-link');
    await expect(field).toHaveValue(/[?&]room=[A-Z0-9]{4,8}\b/, { timeout: 60_000 });
    const link = await field.inputValue();
    const code = (await host.page.locator('[data-screen="lobby"] .room-code .code').textContent())!.trim();
    const q = new URL(link).searchParams;
    expect(q.get('room')).toBe(code);
    expect(q.get('mode')).toBe('ws');
    expect(q.get('ws')).toBe(OFFICIAL_RELAY);
    // the room lives on the official server
    await expect.poll(roomsOnOfficial).toBe(before + 1);
    console.log(`[official e2e] one-click invite: ${link}`);
    await host.page.screenshot({ path: test.info().outputPath('official-host-lobby.png') });
    // the friend: the link itself, zero clicks, zero settings, into the host's lobby
    const guest = await openGame(browser, `${link}&debug=1`, { viewport: VIEWPORT, name: '朋友' });
    pages.push(guest);
    await expect(guest.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(code, { timeout: 60_000 });
    await expect(host.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(2, { timeout: 30_000 });
    const stats = (await (await fetch(`${OFFICIAL_WEB}sgwl.json`)).json()) as { rooms: number; players: number };
    expect(stats.rooms).toBe(before + 1);
    expect(stats.players).toBeGreaterThanOrEqual(2);
    await guest.page.screenshot({ path: test.info().outputPath('official-guest-lobby.png') });
    for (const g of pages) expect(relevantErrors(g.errors)).toEqual([]);
  } finally {
    for (const g of pages) await g.ctx.close();
  }
});
