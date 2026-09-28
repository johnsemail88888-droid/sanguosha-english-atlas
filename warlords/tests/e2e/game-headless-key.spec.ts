// Real app against a server that requires the access key (RELAY_KEY: the Mac mini's
// home-host.sh sets one; its public name is in Certificate Transparency logs):
//   · the owner opens the SHARE LINK (/?k=<key>): the page keeps the key for this server and
//     takes it out of the address bar, creates a server-run room (POST /api/rooms?k=…) and
//     joins it over the keyed relay (/ws?k=…);
//   · the lobby's invite link carries the key: a friend who opens exactly that link joins,
//     and both play the match (HUD up);
//   · a page without the key (or with a wrong one) cannot create or join — it says
//     需要房主发的邀请链接（带密钥） instead of a generic connection failure.
//
// SGWL_E2E_HEADLESS_URL=http://127.0.0.1:<port>/ + SGWL_E2E_KEY=<its RELAY_KEY> point the spec
// at a running keyed server (/sgwl.json must say keyRequired and headless); by default it
// starts its own on :8795 with a random key.
import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PORT_OFFSET, launchBrowser, openGame, pickHero, relevantErrors, startRelay, waitMatch, type GamePage, type Server, type SgwlWindow } from './fixtures/game-fixture';

const PORT = 8795 + PORT_OFFSET;
const VIEWPORT = { width: 800, height: 450 };
const SETTINGS = { quality: 'potato', qualityAuto: false, lang: 'zh' };
const NEEDS_KEY = '需要房主发的邀请链接（带密钥）';
const external = process.env.SGWL_E2E_HEADLESS_URL;
const KEY = external ? (process.env.SGWL_E2E_KEY ?? '') : randomBytes(18).toString('base64url');
let server: Server;
let browser: Browser;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  if (external && !KEY) throw new Error('SGWL_E2E_HEADLESS_URL needs SGWL_E2E_KEY (the server’s RELAY_KEY)');
  server = external
    ? { url: external.endsWith('/') ? external : `${external}/`, close: async () => {} }
    : await startRelay(PORT, { headless: true, env: { RELAY_KEY: KEY, NO_PEER: '1' } });
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** window.__sgwl without ?debug=1 in the address (the invite link is opened exactly as generated) */
const DEBUG_ON = (): void => {
  try {
    localStorage.setItem('sgwl.debug', '1');
  } catch {
    /* ignore */
  }
};

async function serverInfo(): Promise<{ keyRequired?: boolean; headless?: boolean }> {
  return (await (await fetch(`${server.url}sgwl.json`)).json()) as { keyRequired?: boolean; headless?: boolean };
}

async function chooseServerMode(page: Page): Promise<void> {
  await expect(page.locator('[data-screen="online"]')).toBeVisible();
  await page.locator('.sg-online-mode .sg-seg button[data-value="ws"]').click();
  await expect(page.locator('.sg-online .sg-note')).toContainText('/ws');
}

const storedKeys = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem('sgwl.settings.v1') ?? '{}') as { net?: { keys?: Record<string, string> } }).net?.keys ?? {};
    } catch {
      return {};
    }
  });

test('keyed server: the share link creates a room, the lobby invite link carries the key, the friend joins, both play', async () => {
  test.setTimeout(12 * 60_000);
  const info = await serverInfo();
  expect(info.keyRequired, '/sgwl.json says a key is required').toBe(true);
  expect(info.headless).toBe(true);
  expect(JSON.stringify(info)).not.toContain(KEY); // never the key itself
  const relayOrigin = server.url.replace(/^http/, 'ws').replace(/\/$/, '');
  const pages: GamePage[] = [];
  const sockets: string[] = [];
  try {
    // ── the owner opens the SHARE LINK ───────────────────────────────────────────
    const owner = await openGame(browser, `${server.url}?k=${encodeURIComponent(KEY)}&lang=zh`, { viewport: VIEWPORT, name: '房主', settings: SETTINGS, initScript: DEBUG_ON });
    pages.push(owner);
    owner.page.on('websocket', (ws) => sockets.push(ws.url()));
    await expect.poll(() => owner.page.url(), { message: 'k= taken out of the address bar' }).not.toContain('k=');
    expect(await storedKeys(owner.page)).toEqual({ [relayOrigin]: KEY });
    await owner.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await chooseServerMode(owner.page);
    await owner.page.locator('.sg-online-cols .col .sg-btn.gold').click();
    const codeEl = owner.page.locator('[data-screen="lobby"] .room-code .code');
    await expect(codeEl).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 30_000 });
    const code = (await codeEl.textContent())!.trim();
    const ownerFacts = await owner.page.evaluate(() => {
      const s = (window as SgwlWindow).__sgwl!.session as unknown as { headless?: boolean; canManage?: boolean } | null;
      return { headless: s?.headless ?? null, canManage: s?.canManage ?? null };
    });
    expect(ownerFacts).toEqual({ headless: true, canManage: true });
    expect(sockets.some((u) => u.startsWith(`${relayOrigin}/ws?`) && new URL(u).searchParams.get('k') === KEY), `keyed relay socket (${sockets.join(' ')})`).toBe(true);

    // ── the invite link the owner's lobby shows: its key masked on screen, whole once the
    // field is focused (长按 / Ctrl+C) — and 复制 / 分享 take the whole link ─────────────────
    const field = owner.page.locator('[data-screen="lobby"] .invite-link');
    const shown = await field.inputValue();
    expect(shown, 'the key is masked on screen').toContain('k=••••');
    expect(shown).not.toContain(KEY);
    await field.focus();
    const link = await field.inputValue();
    console.log(`[headless key e2e] room ${code}, invite link ${link.replace(encodeURIComponent(KEY), '<key>').replace(KEY, '<key>')}`);
    const q = new URL(link).searchParams;
    expect(q.get('room')).toBe(code);
    expect(q.get('mode')).toBe('ws');
    expect(q.get('k'), 'the invite link carries the key').toBe(KEY);

    // ── a friend opens exactly that link ─────────────────────────────────────────
    const friend = await openGame(browser, link, { viewport: VIEWPORT, name: '朋友', settings: SETTINGS, initScript: DEBUG_ON });
    pages.push(friend);
    await expect.poll(() => friend.page.url()).not.toContain('k=');
    expect(new URL(friend.page.url()).searchParams.get('room')).toBe(code);
    expect(await storedKeys(friend.page)).toEqual({ [relayOrigin]: KEY });
    // an invite link with its mode joins by itself (one-click invite); the online screen's 加入 otherwise
    const friendCode = friend.page.locator('[data-screen="lobby"] .room-code .code');
    const joinBtn = friend.page.locator('[data-screen="online"] .join-row .sg-btn');
    await expect(friendCode.or(joinBtn)).toBeVisible({ timeout: 30_000 });
    if (await joinBtn.isVisible().catch(() => false)) await joinBtn.click();
    await expect(friendCode).toHaveText(code, { timeout: 30_000 });
    await friend.page.locator('.lobby-foot .sg-btn.gold').click(); // ready
    await expect(owner.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(2, { timeout: 30_000 });
    await owner.page.locator('.seat-tools .sg-btn').click(); // ＋ 添加AI
    await expect(friend.page.locator('.seat.bot')).toHaveCount(1, { timeout: 15_000 });

    // ── both play ───────────────────────────────────────────────────────────────
    await owner.page.locator('.lobby-foot .sg-btn.gold').click();
    const confirm = owner.page.locator('.sg-modal .actions .sg-btn').last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await Promise.all(pages.map((g) => expect(g.page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 })));
    await Promise.all(pages.map((g) => pickHero(g.page)));
    await Promise.all(pages.map((g) => waitMatch(g.page, 300_000)));
    for (const g of pages) {
      expect(await g.page.evaluate(() => (window as SgwlWindow).__sgwl!.phase)).toBe('playing');
      expect(await g.page.evaluate(() => (window as SgwlWindow).__sgwl!.players().filter((p) => !p.isBot).length)).toBe(2);
    }
    await owner.page.screenshot({ path: test.info().outputPath('owner-playing.png') });
    for (const g of pages) expect(relevantErrors(g.errors)).toEqual([]);
  } finally {
    for (const g of pages) await g.ctx.close().catch(() => {});
  }
});

test('no key / a wrong key: creating and joining say 需要房主发的邀请链接（带密钥）', async () => {
  test.setTimeout(5 * 60_000);
  const pages: GamePage[] = [];
  try {
    for (const [what, query] of [
      ['no key', ''],
      ['wrong key', `&k=${encodeURIComponent(`${KEY.slice(0, -4)}WXYZ`)}`],
    ] as const) {
      // create
      const p = await openGame(browser, `${server.url}?lang=zh${query}`, { viewport: VIEWPORT, name: '路人', settings: SETTINGS });
      pages.push(p);
      await p.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
      await chooseServerMode(p.page);
      await p.page.locator('.sg-online-cols .col .sg-btn.gold').click();
      await expect(p.page.locator('.sg-online-status .err'), `${what}: create`).toContainText(NEEDS_KEY, { timeout: 30_000 });
      await expect(p.page.locator('[data-screen="lobby"]')).toHaveCount(0);
      // join by code (a room code without the invite link)
      const j = await openGame(browser, `${server.url}?lang=zh&room=ABCDE${query}`, { viewport: VIEWPORT, name: '路人', settings: SETTINGS });
      pages.push(j);
      await chooseServerMode(j.page);
      await expect(j.page.locator('.sg-code-input')).toHaveValue('ABCDE');
      await j.page.locator('.join-row .sg-btn').click();
      await expect(j.page.locator('.sg-online-status .err'), `${what}: join`).toContainText(NEEDS_KEY, { timeout: 30_000 });
      if (what === 'no key') await p.page.screenshot({ path: test.info().outputPath('no-key.png') });
    }
  } finally {
    for (const g of pages) await g.ctx.close().catch(() => {});
  }
});
