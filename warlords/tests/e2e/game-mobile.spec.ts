// Real app on a landscape phone (844×390, touch emulation), served by
// `node server/server.mjs` (static build + /ws relay): a fresh profile starts on
// low quality; title / setup / lobby / hero select / game over fit the screen;
// a single-player match with the touch HUD — the virtual stick moves the hero,
// the fire button shoots, and the map / scoreboard / wheel / chat never trap the
// player (every touch-bar button toggles its overlay, ✕ closes, the stick and the
// fire button keep working with the map open); 640×360 keeps the feed and the
// claim wheel off the zone banner.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PORT_OFFSET, launchBrowser, localPos, openGame, pickHero, relevantErrors, startRelay, waitMatch, type GamePage, type Server, type SgwlWindow } from './fixtures/game-fixture';

const PORT = 8793 + PORT_OFFSET;
const PHONE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };
let server: Server;
let browser: Browser;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startRelay(PORT);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type Rect = { x: number; y: number; width: number; height: number };
const rect = (page: Page, sel: string): Promise<Rect | null> =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
const inside = (r: Rect | null, w: number, h: number): boolean => !!r && r.x >= -1 && r.y >= -1 && r.x + r.width <= w + 1 && r.y + r.height <= h + 1 && r.width > 0;
const overlap = (a: Rect | null, b: Rect | null): boolean => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What sits at the centre of each touch control (should be the control itself). */
function hitTest(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const sel of ['.hud-touchbar .tb', '.sg-touch .fire', '.sg-touch .zone.move', '.sg-touch .jump']) {
      const el = document.querySelector(sel);
      if (!el) {
        out[sel] = 'missing';
        continue;
      }
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out[sel] = hit && (hit === el || el.contains(hit)) ? 'ok' : `${hit?.tagName.toLowerCase()}.${String(hit?.className)}`;
    }
    return out;
  });
}
const ALL_OK = { '.hud-touchbar .tb': 'ok', '.sg-touch .fire': 'ok', '.sg-touch .zone.move': 'ok', '.sg-touch .jump': 'ok' };

test('phone 844×390: fresh profile is low quality; title, setup and lobby fit the screen', async () => {
  test.setTimeout(5 * 60_000);
  // a fresh profile: nothing in localStorage
  const ctx = await browser.newContext(PHONE);
  try {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.url}?debug=1`);
    await expect(page.locator('.sg-logo')).toBeVisible();
    // title fits 390 px: logo not clipped, the footer does not cover 设置
    const logo = await rect(page, '.sg-logo');
    expect(logo!.y, 'logo not clipped at the top').toBeGreaterThanOrEqual(0);
    const settingsBtn = page.locator('.sg-title-menu .sg-menu-btn').last();
    const sb = await settingsBtn.boundingBox();
    const foot = await rect(page, '.sg-title-foot');
    expect(overlap(sb, foot), 'footer does not overlap 设置').toBe(false);
    await page.screenshot({ path: test.info().outputPath('title-844x390.png') });
    // graphics quality of a fresh phone profile: 流畅 (low)
    await settingsBtn.click();
    await page.locator('.sg-settings .sg-tab[data-tab="graphics"]').click();
    await expect(page.locator('.sg-settings .sg-seg button[data-value="low"]')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    // single-player setup: 出征 visible without scrolling
    await page.locator('.sg-menu-btn.primary').click();
    await expect(page.locator('[data-screen="single"]')).toBeVisible();
    expect(inside(await rect(page, '[data-screen="single"] .sg-sheet-actions .sg-btn'), 844, 390), '出征 on screen').toBe(true);
    await page.screenshot({ path: test.info().outputPath('single-844x390.png') });
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }

  // lobby (host a room on the same-origin relay): panels tabbed at 844×390, ≥ 4 seats at 960×540
  const g = await openGame(browser, `${server.url}?debug=1`, { ...PHONE, name: '房主' });
  try {
    const { page, errors } = g;
    await page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await page.locator('.sg-online-mode .sg-seg button[data-value="ws"]').click();
    await page.locator('.sg-online-cols .col .sg-btn.gold').click();
    await expect(page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 30_000 });
    await expect(page.locator('.lobby-tabs')).toBeVisible();
    const seats = await rect(page, '.seats-panel');
    expect(seats!.height, 'seats panel gets the height').toBeGreaterThanOrEqual(150);
    await page.locator('.lobby-tabs .lt[data-tab="settings"]').click();
    expect((await rect(page, '.settings-panel'))!.height).toBeGreaterThanOrEqual(150);
    await page.locator('.lobby-tabs .lt[data-tab="chat"]').click();
    expect(inside(await rect(page, '.lobby-grid .chat .chat-row'), 844, 390), 'chat input on screen').toBe(true);
    await page.screenshot({ path: test.info().outputPath('lobby-844x390.png') });
    await page.setViewportSize({ width: 960, height: 540 });
    await expect(page.locator('.lobby-tabs')).toBeHidden();
    const visibleSeats = await page.locator('.seat-list .seat').evaluateAll((els) => {
      const vh = window.innerHeight;
      return els.filter((e) => {
        const r = e.getBoundingClientRect();
        const box = e.closest('section')!.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= Math.min(box.bottom, vh) + 1;
      }).length;
    });
    expect(visibleSeats, '≥ 4 seats visible at 960×540').toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: test.info().outputPath('lobby-960x540.png') });
    expect(relevantErrors(errors)).toEqual([]);
  } finally {
    await g.ctx.close();
  }
});

test('phone 844×390 with touch: the touch HUD drives the hero, overlays never trap the player', async () => {
  test.setTimeout(12 * 60_000);
  let g: GamePage | null = null;
  try {
    g = await openGame(browser, `${server.url}?debug=1`, PHONE);
    const { page, errors } = g;
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.locator('.sg-menu-btn.primary').click();
    await page.locator('[data-screen="single"] .sg-btn.gold').click();
    await expect(page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 });
    // hero select: 选定 stays on screen at 844×390
    await expect(page.locator('.sg-select:not(.waiting) .grid .sg-hcard').first()).toBeVisible({ timeout: 120_000 });
    await page.locator('.sg-select .grid .sg-hcard').first().click();
    expect(inside(await rect(page, '.detail-actions .sg-btn'), 844, 390), '选定 inside the viewport').toBe(true);
    await page.screenshot({ path: test.info().outputPath('select-844x390.png') });
    await pickHero(page);
    await waitMatch(page);

    // touch HUD: stick zone, fire / aim / jump / abilities, touch bar; no "click to play" prompt
    await expect(page.locator('.sg-hud.touch')).toHaveCount(1);
    for (const sel of ['.sg-touch .zone.move', '.sg-touch .fire', '.sg-touch .ads', '.sg-touch .jump', '.sg-touch .reload', '.hud-touchbar .tb']) {
      await expect(page.locator(sel).first(), sel).toBeVisible();
    }
    await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
    await expect(page.locator('.click-prompt')).toBeHidden();
    // the minimap's region name sits on a plate
    expect(await page.locator('.mm-region').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await page.screenshot({ path: test.info().outputPath('touch-hud.png') });

    const overlay = (): Promise<string | undefined> => page.evaluate(() => document.querySelector<HTMLElement>('.sg-hud')!.dataset.overlay);
    const tb = (key: string) => page.locator(`.hud-touchbar .tb[data-key="${key}"]`);

    // 图: the map opens; every touch control is still reachable around it
    await tb('map').tap();
    expect(await overlay()).toBe('map');
    expect(await hitTest(page)).toEqual(ALL_OK);
    await page.screenshot({ path: test.info().outputPath('touch-map.png') });

    // …and the stick moves the hero with the map open
    const zone = page.locator('.sg-touch .zone.move');
    const box = (await zone.boundingBox())!;
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.6;
    const start = await localPos(page);
    await zone.dispatchEvent('pointerdown', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true });
    await zone.dispatchEvent('pointermove', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y - 70, bubbles: true });
    let moved = 0;
    for (let i = 0; i < 100 && moved < 1.5; i++) {
      await page.waitForTimeout(400);
      const p = await localPos(page);
      moved = Math.hypot(p.x - start.x, p.z - start.z);
    }
    await zone.dispatchEvent('pointerup', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y - 70, bubbles: true });
    expect(moved, 'virtual stick moved the hero with the map open').toBeGreaterThan(1.5);

    // 图 again closes it; ✕ closes it
    await tb('map').tap();
    expect(await overlay()).toBe('none');
    await tb('map').tap();
    await page.locator('.hud-bigmap .hud-close').tap();
    expect(await overlay()).toBe('none');

    // 战 toggles the scoreboard (and never covers its own button)
    await tb('score').tap();
    await expect(page.locator('.sg-hud.show-score')).toHaveCount(1);
    expect((await hitTest(page))['.hud-touchbar .tb']).toBe('ok');
    await page.screenshot({ path: test.info().outputPath('touch-score.png') });
    await tb('score').tap();
    await expect(page.locator('.sg-hud.show-score')).toHaveCount(0);

    // 令 and 聊 close when tapped again
    await tb('wheel').tap();
    expect(await overlay()).toBe('wheel');
    await expect(page.locator('.hud-wheel .wh-center .x')).toBeVisible();
    await expect(page.locator('.wh-hint')).not.toContainText(/Esc/);
    await tb('wheel').tap();
    expect(await overlay()).toBe('none');
    await tb('chat').tap();
    expect(await overlay()).toBe('chat');
    await expect(page.locator('.hud-chat .chat-close')).toBeVisible();
    await expect(page.locator('.hud-chat.open input')).not.toHaveAttribute('placeholder', /Esc/);
    await tb('chat').tap();
    expect(await overlay()).toBe('none');

    // hold the fire button until ammo drops
    const ammo = () => page.evaluate(() => {
      const l = (window as SgwlWindow).__sgwl!.local()!;
      const w = l.weapons[l.activeSlot]!;
      return w.mag + w.reserve;
    });
    const a0 = await ammo();
    const fire = page.locator('.sg-touch .fire');
    await fire.dispatchEvent('pointerdown', { pointerId: 12, pointerType: 'touch', isPrimary: false, bubbles: true });
    let a1 = a0;
    for (let i = 0; i < 80 && a1 >= a0; i++) {
      await page.waitForTimeout(250);
      a1 = await ammo();
    }
    await fire.dispatchEvent('pointerup', { pointerId: 12, pointerType: 'touch', isPrimary: false, bubbles: true });
    expect(a1, 'touch fire used ammo').toBeLessThan(a0);
    await page.screenshot({ path: test.info().outputPath('touch-fire.png') });

    // 640×360: the kill feed and the claim wheel keep off the zone banner
    await page.setViewportSize({ width: 640, height: 360 });
    await page.waitForTimeout(600);
    const banner = await rect(page, '.hud-topcenter');
    const feed = await rect(page, '.hud-feed');
    if (feed && feed.height > 0) expect(overlap(feed, banner), 'feed vs zone banner').toBe(false);
    await tb('wheel').tap();
    expect(await overlay()).toBe('wheel');
    const items = await page.locator('.hud-wheel .wh-item').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    for (const it of items) expect(overlap(it, banner), 'wheel item vs zone banner').toBe(false);
    await page.screenshot({ path: test.info().outputPath('wheel-640x360.png') });
    await tb('wheel').tap();
    await page.setViewportSize({ width: 844, height: 390 });

    // game over at 844×390: the buttons are on screen without scrolling
    expect(await page.evaluate(() => (window as SgwlWindow).__sgwl!.cheats.killOthers())).toBeGreaterThan(0);
    await expect(page.locator('[data-screen="gameOver"] .over-actions .sg-btn').first()).toBeVisible({ timeout: 60_000 });
    for (const b of await page.locator('[data-screen="gameOver"] .over-actions .sg-btn').all()) {
      expect(inside(await b.boundingBox(), 844, 390), 'game-over button on screen').toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath('gameover-844x390.png') });
    expect(relevantErrors(errors)).toEqual([]);
  } finally {
    await g?.ctx.close();
  }
});
