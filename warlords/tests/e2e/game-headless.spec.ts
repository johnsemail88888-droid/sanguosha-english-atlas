// Real app, server-run ("headless") room: `node server/server.mjs` with the room worker
// bundle (src/headless → dist-headless/room-worker.mjs) runs the match in a worker_thread —
// no player's browser hosts it. Two browser contexts use the UI:
//   · the creator goes online in 服务器 (ws) mode and creates a room: the page POSTs
//     /api/rooms and joins the new room as its OWNER (a guest session with the lobby powers:
//     the headless note, ＋ 添加AI, 开始);
//   · a friend joins by code: an ordinary guest (no owner controls);
//   · the owner adds a bot and starts; both play (HUD up) and neither page can see a hidden
//     role (only the lord's, and its own);
//   · the owner's page is closed mid-match: the match goes on on the server (the friend's
//     clock keeps running), the friend becomes the owner (结束对局 in the pause menu), ends the
//     match and is back in the lobby with the owner controls.
// A cross-origin page (localhost vs 127.0.0.1: another origin, like GitHub Pages vs the Mac
// mini) can create a room too (text/plain POST, no preflight, Access-Control-Allow-Origin: *).
//
// SGWL_E2E_HEADLESS_URL=http://127.0.0.1:<port>/ points the spec at a server that is already
// running (it must say headless:true in /sgwl.json); by default it starts its own on :8794.
// Screenshots: test output dir, or SGWL_E2E_SHOTS=<dir>.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  PORT_OFFSET,
  enterGame,
  launchBrowser,
  openGame,
  pickHero,
  relevantErrors,
  startRelay,
  waitMatch,
  type GamePage,
  type Server,
  type SgwlWindow,
} from './fixtures/game-fixture';

const PORT = 8794 + PORT_OFFSET;
const VIEWPORT = { width: 800, height: 450 };
/** the cheapest graphics tier: two SwiftShader pages at once */
const SETTINGS = { quality: 'potato', qualityAuto: false, lang: 'zh' };
let server: Server;
let browser: Browser;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const external = process.env.SGWL_E2E_HEADLESS_URL;
  server = external ? { url: external.endsWith('/') ? external : `${external}/`, close: async () => {} } : await startRelay(PORT, { headless: true });
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SGWL_E2E_SHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: dir ? path.join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`) });
}

async function serverInfo(): Promise<{ headless?: boolean; headlessRooms?: number; headlessHumans?: number }> {
  const r = await fetch(`${server.url}sgwl.json`);
  return (await r.json()) as { headless?: boolean; headlessRooms?: number; headlessHumans?: number };
}

async function chooseServerMode(page: Page): Promise<void> {
  await expect(page.locator('[data-screen="online"]')).toBeVisible();
  await page.locator('.sg-online-mode .sg-seg button[data-value="ws"]').click();
  // served by our server: the relay is on the same origin, nothing to configure
  await expect(page.locator('.sg-online .sg-note')).toContainText('/ws');
}

interface SessionFacts {
  kind: string | null;
  isHost: boolean;
  canManage: boolean | null;
  headless: boolean | null;
  phase: string | null;
}

const facts = (page: Page): Promise<SessionFacts> =>
  page.evaluate(() => {
    const g = (window as SgwlWindow).__sgwl!;
    const s = g.session as unknown as { isHost: boolean; canManage?: boolean; headless?: boolean } | null;
    return { kind: g.sessionKind, isHost: !!s?.isHost, canManage: s?.canManage ?? null, headless: s?.headless ?? null, phase: g.phase };
  });

const matchClock = (page: Page): Promise<number> => page.evaluate(() => (window as SgwlWindow).__sgwl!.elapsed());

/** Hidden roles this page can see: any role shown for a living player that is neither the lord nor itself. */
const hiddenRolesSeen = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const g = (window as SgwlWindow).__sgwl!;
    const me = g.localId();
    return g
      .players()
      .filter((p) => p.alive && p.role !== undefined && p.role !== 'lord' && p.entityId !== me)
      .map((p) => `${p.name}:${p.role}`);
  });

test('server-run room: the creator owns it without seeing hidden roles, the match needs no player\'s browser, ownership moves on', async () => {
  test.setTimeout(12 * 60_000);
  expect((await serverInfo()).headless, '/sgwl.json says the server runs rooms').toBe(true);
  const pages: GamePage[] = [];
  let ownerOpen = true;
  try {
    // ── the creator: 联机对战 → 服务器 → 创建房间 → a server-run room it owns ─────────────
    const owner = await openGame(browser, `${server.url}?debug=1&lang=zh`, { viewport: VIEWPORT, name: '房主', settings: SETTINGS });
    pages.push(owner);
    await owner.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await chooseServerMode(owner.page);
    await owner.page.locator('.sg-online-cols .col .sg-btn.gold').click();
    const codeEl = owner.page.locator('[data-screen="lobby"] .room-code .code');
    await expect(codeEl).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 30_000 });
    const code = (await codeEl.textContent())!.trim();
    console.log(`[headless e2e] room ${code}`);
    // the page is a guest of the room (the server hosts it) with the owner's powers
    expect(await facts(owner.page)).toMatchObject({ kind: 'guest', isHost: false, canManage: true, headless: true, phase: 'lobby' });
    await expect(owner.page.locator('.lobby-headless')).toContainText('服务器运行');
    await expect(owner.page.locator('.seat-tools .sg-btn')).toBeVisible(); // ＋ 添加AI
    await expect(owner.page.locator('.lobby-foot .sg-btn.gold')).toHaveText('开始游戏');
    await expect(owner.page.locator('.seat.mine .sg-chip.host')).toBeVisible(); // the crown on its own seat
    await expect.poll(async () => (await serverInfo()).headlessRooms, { message: 'the server counts the room' }).toBeGreaterThanOrEqual(1);

    // ── a friend joins by code: an ordinary guest ────────────────────────────────────
    const friend = await openGame(browser, `${server.url}?debug=1&lang=zh&room=${code}`, { viewport: VIEWPORT, name: '朋友', settings: SETTINGS });
    pages.push(friend);
    await chooseServerMode(friend.page);
    await expect(friend.page.locator('.sg-code-input')).toHaveValue(code);
    await friend.page.locator('.join-row .sg-btn').click();
    await expect(friend.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(code, { timeout: 30_000 });
    expect(await facts(friend.page)).toMatchObject({ kind: 'guest', isHost: false, canManage: false, headless: true });
    await expect(friend.page.locator('.lobby-headless')).toBeVisible();
    await expect(friend.page.locator('.seat-tools .sg-btn')).toHaveCount(0);
    await expect(friend.page.locator('.lobby-foot .sg-btn.gold')).toHaveText('准备');
    await friend.page.locator('.lobby-foot .sg-btn.gold').click(); // ready
    await expect(owner.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => (await serverInfo()).headlessHumans, { message: 'the server counts both humans' }).toBeGreaterThanOrEqual(2);

    // the owner adds a bot (an owner message the server carries out) — both pages see it
    await owner.page.locator('.seat-tools .sg-btn').click();
    await expect(owner.page.locator('.seat.bot')).toHaveCount(1, { timeout: 15_000 });
    await expect(friend.page.locator('.seat.bot')).toHaveCount(1, { timeout: 15_000 });
    await shot(owner.page, '01-owner-lobby');
    await shot(friend.page, '02-friend-lobby');

    // ── start: roles → hero select → match on both pages ────────────────────────────
    await owner.page.locator('.lobby-foot .sg-btn.gold').click();
    const confirm = owner.page.locator('.sg-modal .actions .sg-btn').last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await Promise.all(pages.map((g) => expect(g.page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 })));
    const heroes = await Promise.all(pages.map((g) => pickHero(g.page)));
    console.log(`[headless e2e] heroes: ${heroes.join(', ')}`);
    await Promise.all(pages.map((g) => waitMatch(g.page, 300_000)));
    for (const g of pages) {
      await expect
        .poll(() => g.page.evaluate(() => (window as SgwlWindow).__sgwl!.players().filter((p) => !p.isBot).length), { message: 'two humans in the match', timeout: 15_000 })
        .toBe(2);
      // nobody — not even the room's creator — sees a hidden role
      expect(await hiddenRolesSeen(g.page)).toEqual([]);
      expect(await g.page.evaluate(() => (window as SgwlWindow).__sgwl!.local()?.role)).toBeTruthy();
    }
    // the owner's pause menu offers 结束对局 (an owner control); the friend's does not
    await enterGame(owner.page);
    await owner.page.keyboard.press('Escape');
    await expect(owner.page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await expect(owner.page.locator('.pm-box .pm-end')).toBeVisible();
    await shot(owner.page, '03-owner-match-pause');
    await owner.page.locator('.pm-box .sg-btn.gold').click(); // 继续战斗
    await enterGame(friend.page);
    await friend.page.keyboard.press('Escape');
    await expect(friend.page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await expect(friend.page.locator('.pm-box .pm-end')).toHaveCount(0);
    await friend.page.locator('.pm-box .sg-btn.gold').click();

    // ── the owner's page goes away mid-match: the server's match goes on ──────────────
    const t0 = await matchClock(friend.page);
    await owner.ctx.close();
    ownerOpen = false;
    const closedAt = Date.now();
    // the friend becomes the owner once the drop grace ran out (5 s)
    await expect
      .poll(async () => (await facts(friend.page)).canManage, { message: 'the friend becomes the room owner', timeout: 30_000 })
      .toBe(true);
    console.log(`[headless e2e] owner page closed; the friend owns the room ${((Date.now() - closedAt) / 1000).toFixed(1)} s later`);
    // snapshots keep coming: the friend's match clock runs on, no host page anywhere
    await expect.poll(async () => (await matchClock(friend.page)) - t0, { message: 'the match clock runs on without the creator', timeout: 60_000 }).toBeGreaterThan(8);
    expect(await facts(friend.page)).toMatchObject({ phase: 'playing', headless: true });
    await expect(friend.page.locator('.sg-hud .hud-vitals .v-hpbar')).toBeVisible();
    await enterGame(friend.page);
    await friend.page.keyboard.press('Escape');
    await expect(friend.page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await expect(friend.page.locator('.pm-box .pm-end')).toBeVisible();
    await shot(friend.page, '04-new-owner-pause');

    // the new owner ends the match: everyone back in the lobby, owner controls there
    await friend.page.locator('.pm-box .pm-end').click();
    await friend.page.locator('.sg-modal .actions .sg-btn').last().click(); // confirm
    await expect(friend.page.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 60_000 });
    await expect(friend.page.locator('.seat-tools .sg-btn')).toBeVisible();
    await expect(friend.page.locator('.lobby-foot .sg-btn.gold')).toHaveText('开始游戏');
    await expect(friend.page.locator('.seat.mine .sg-chip.host')).toBeVisible();
    await shot(friend.page, '05-new-owner-lobby');
    expect(relevantErrors(friend.errors)).toEqual([]);

    // ── another origin (like GitHub Pages → the Mac mini) may create a room: CORS ──────
    const other = server.url.replace('127.0.0.1', 'localhost');
    if (other !== server.url) {
      const x = await openGame(browser, `${other}?lang=zh`, { viewport: VIEWPORT, name: '远方', settings: SETTINGS });
      pages.push(x);
      const res = await x.page.evaluate(async (api) => {
        const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ name: 'cors', lang: 'zh' }) });
        const b = (await r.json()) as { code?: string; ownerKey?: string };
        return { status: r.status, code: b.code ?? null, key: (b.ownerKey ?? '').length };
      }, `${server.url}api/rooms`);
      console.log(`[headless e2e] cross-origin create: ${JSON.stringify(res)}`);
      expect(res.status).toBe(201);
      expect(res.code).toMatch(/^[A-Z0-9]{4,8}$/);
      expect(res.key).toBeGreaterThanOrEqual(32);
    }
  } finally {
    for (const [i, g] of pages.entries()) if (i !== 0 || ownerOpen) await g.ctx.close().catch(() => {});
  }
});
