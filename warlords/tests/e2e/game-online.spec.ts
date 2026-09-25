// Real app, online over the self-host server: `node server/server.mjs` serves the
// production build + the /ws relay on :8792. A host and two guests (three browser
// contexts) use the UI: host creates a room in 服务器 (ws) mode — same-origin
// relay, no configuration — guests open the invite link and join by room code;
// everyone picks a hero, reaches 'playing' and sees the other players' heroes move.
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  enterGame,
  launchBrowser,
  localPos,
  openGame,
  pickHero,
  relevantErrors,
  startRelay,
  waitMatch,
  type GamePage,
  type Server,
  type SgwlWindow,
} from './fixtures/game-fixture';

const RELAY_PORT = 8792;
const VIEWPORT = { width: 640, height: 360 };
let relay: Server;
let browser: Browser;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  relay = await startRelay(RELAY_PORT);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await relay?.close();
});

async function chooseServerMode(page: Page): Promise<void> {
  await expect(page.locator('[data-screen="online"]')).toBeVisible();
  const ws = page.locator('.sg-online-mode .sg-seg button[data-value="ws"]');
  await ws.click();
  // served by our server: the relay is on the same origin, nothing to configure
  await expect(page.locator('.sg-online .sg-note')).toContainText('/ws');
  await expect(page.locator('.sg-online .sg-warn')).toHaveCount(0);
}

/** Positions of the other human players' heroes as this page sees them. */
async function othersSeen(page: Page): Promise<Record<number, { x: number; z: number }>> {
  return page.evaluate(() => {
    const g = (window as SgwlWindow).__sgwl!;
    const me = g.localId();
    const out: Record<number, { x: number; z: number }> = {};
    for (const p of g.players()) {
      if (p.isBot || p.entityId === me) continue;
      const e = (g as unknown as { view: { get(id: number): { x: number; z: number } | undefined } }).view.get(p.entityId);
      if (e) out[p.entityId] = { x: e.x, z: e.z };
    }
    return out;
  });
}

test('online (ws relay, same origin): host + 2 guests join by room code, play, see each other move', async () => {
  test.setTimeout(15 * 60_000);
  const pages: GamePage[] = [];
  try {
    const host = await openGame(browser, `${relay.url}?debug=1`, { viewport: VIEWPORT, name: '主持人' });
    pages.push(host);
    await host.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await chooseServerMode(host.page);
    await host.page.locator('.sg-online-cols .col .sg-btn.gold').click();
    await expect(host.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 30_000 });
    const code = (await host.page.locator('[data-screen="lobby"] .room-code .code').textContent())!.trim();
    console.log(`[online e2e] room ${code}`);

    for (const name of ['客人甲', '客人乙']) {
      const g = await openGame(browser, `${relay.url}?debug=1&room=${code}`, { viewport: VIEWPORT, name });
      pages.push(g);
      await chooseServerMode(g.page);
      await expect(g.page.locator('.sg-code-input')).toHaveValue(code);
      await g.page.locator('.join-row .sg-btn').click();
      await expect(g.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(code, { timeout: 30_000 });
      await g.page.locator('.lobby-foot .sg-btn.gold').click(); // ready
    }
    await expect(host.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(3, { timeout: 30_000 });
    await host.page.locator('.lobby-foot .sg-btn.gold').click();
    // (all guests are ready: no "start anyway?" confirm — accept it if it shows up)
    const confirm = host.page.locator('.sg-modal .actions .sg-btn').last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    // roles → hero select → match on every client
    await Promise.all(pages.map((g) => expect(g.page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 })));
    const heroes = await Promise.all(pages.map((g) => pickHero(g.page)));
    console.log(`[online e2e] heroes: ${heroes.join(', ')}`);
    await Promise.all(pages.map((g) => waitMatch(g.page, 300_000)));
    for (const g of pages) {
      const st = await g.page.evaluate(() => ({ phase: (window as SgwlWindow).__sgwl!.phase, humans: (window as SgwlWindow).__sgwl!.players().filter((p) => !p.isBot).length }));
      expect(st).toEqual({ phase: 'playing', humans: 3 });
    }

    // everyone walks forward; every client must see the two other heroes move
    for (const g of pages) await enterGame(g.page);
    const before = await Promise.all(pages.map((g) => othersSeen(g.page)));
    const start = await Promise.all(pages.map((g) => localPos(g.page)));
    await Promise.all(pages.map((g) => g.page.keyboard.down('w')));
    const end = Date.now() + 90_000;
    let ok = false;
    let last: Record<number, { x: number; z: number }>[] = [];
    while (!ok && Date.now() < end) {
      await pages[0].page.waitForTimeout(1000);
      last = await Promise.all(pages.map((g) => othersSeen(g.page)));
      ok = last.every((seen, i) => {
        const ids = Object.keys(before[i]);
        return ids.length === 2 && ids.every((id) => {
          const a = before[i][Number(id)];
          const b = seen[Number(id)];
          return !!b && Math.hypot(b.x - a.x, b.z - a.z) > 1.5;
        });
      });
    }
    await Promise.all(pages.map((g) => g.page.keyboard.up('w')));
    const after = await Promise.all(pages.map((g) => localPos(g.page)));
    console.log(`[online e2e] own moves: ${after.map((p, i) => Math.hypot(p.x - start[i].x, p.z - start[i].z).toFixed(1)).join(' / ')} m`);
    expect(ok, `every client sees both other heroes move: before ${JSON.stringify(before)} after ${JSON.stringify(last)}`).toBe(true);
    for (const [i, g] of pages.entries()) await g.page.screenshot({ path: test.info().outputPath(`client-${i}.png`) });
    for (const g of pages) expect(relevantErrors(g.errors)).toEqual([]);
  } finally {
    for (const g of pages) await g.ctx.close();
  }
});
