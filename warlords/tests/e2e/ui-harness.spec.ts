// UI e2e: drives the dev harness (ui-dev.html) through every screen at desktop
// and phone sizes, checks nothing overflows horizontally and the console stays
// clean, then plays a mock single-player flow end to end (title → setup →
// roles → hero select → HUD → scoreboard / wheel / chat → game over).
//
// Starts its own Vite server (HMR off) on port 5183 unless UI_E2E_URL points at
// a running one, e.g. UI_E2E_URL=http://localhost:5173/ui-dev.html.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.UI_E2E_PORT ?? 5183);
const URL = process.env.UI_E2E_URL ?? `http://localhost:${PORT}/ui-dev.html`;
const CHROMIUM = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

let server: ViteDevServer | null = null;
let browser: Browser;

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!(await reachable(URL))) {
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.ts'),
      logLevel: 'error',
      server: { port: PORT, strictPort: true, hmr: false },
    });
    await server.listen();
  }
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  server = null;
});

interface Opened {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

async function open(query: string, width = 1280, height = 720): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${URL}?${query}`);
  return { ctx, page, errors };
}

/** Elements that stick out of the viewport horizontally (outside any scroll/clip container). */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`document ${document.documentElement.scrollWidth}px`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.sg-root *'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      let p = el.parentElement;
      let clipped = false;
      while (p && !p.classList.contains('sg-root')) {
        const cs = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(cs.overflowX + cs.overflow)) {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) {
            clipped = true;
            break;
          }
        }
        p = p.parentElement;
      }
      if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
    }
    return out.slice(0, 5);
  });
}

const SCREENS: { screen: string; ready: string; text?: RegExp }[] = [
  { screen: 'title', ready: '[data-screen="title"] .sg-logo', text: /单人练习/ },
  { screen: 'single', ready: '[data-screen="single"] .sg-role-preview .sg-seal', text: /出征/ },
  { screen: 'online', ready: '[data-screen="online"] .sg-code-input', text: /创建房间/ },
  { screen: 'lobby', ready: '[data-screen="lobby"] .room-code', text: /KX7QD/ },
  { screen: 'roles', ready: '[data-screen="roles"] .flip-card', text: /胜利条件/ },
  { screen: 'heroSelect', ready: '[data-screen="heroSelect"] .grid .sg-hcard', text: /选定/ },
  { screen: 'hud', ready: '.sg-hud .hud-vitals .v-hpbar', text: /烽火圈/ },
  { screen: 'scoreboard', ready: '.sg-hud.show-score .hud-scoreboard', text: /战况/ },
  { screen: 'map', ready: '.sg-hud[data-overlay="map"] .bm-canvas', text: /战场地图/ },
  { screen: 'gameOver', ready: '[data-screen="gameOver"] .over-banner', text: /胜利|败北/ },
  { screen: 'gallery', ready: '[data-screen="gallery"] .gal-grid .sg-hcard', text: /武将图鉴/ },
  { screen: 'help', ready: '[data-screen="help"] .help-body .role-row', text: /身份与胜负/ },
  { screen: 'settings', ready: '.sg-settings .sg-tabs', text: /网络/ },
];

for (const size of [
  { name: 'desktop', w: 1280, h: 720 },
  { name: 'phone', w: 390, h: 844 },
]) {
  test(`every harness screen renders cleanly (${size.name} ${size.w}×${size.h})`, async () => {
    for (const s of SCREENS) {
      const { ctx, page, errors } = await open(`screen=${s.screen}`, size.w, size.h);
      const inMatch = ['hud', 'scoreboard', 'map'].includes(s.screen);
      if (size.name === 'phone' && inMatch) {
        // portrait phones get a rotate hint instead of the HUD
        await expect(page.locator('.sg-rotate'), s.screen).toBeVisible({ timeout: 15_000 });
      } else {
        await expect(page.locator(s.ready).first(), s.screen).toBeVisible({ timeout: 15_000 });
        if (s.text) await expect(page.locator('.sg-root'), s.screen).toContainText(s.text);
      }
      await page.waitForTimeout(300);
      expect(await horizontalOverflow(page), `${s.screen} overflow`).toEqual([]);
      expect(errors, `${s.screen} console`).toEqual([]);
      await ctx.close();
    }
  });
}

test('English toggle relabels the UI', async () => {
  const { ctx, page, errors } = await open('screen=title');
  await expect(page.locator('.sg-menu-btn.primary')).toContainText('单人练习');
  await page.locator('.sg-lang-btn').click();
  await expect(page.locator('.sg-menu-btn.primary')).toContainText('Single Player');
  await page.locator('.sg-lang-btn').click();
  await expect(page.locator('.sg-menu-btn.primary')).toContainText('单人练习');
  const en = await open('screen=hud&lang=en');
  await expect(en.page.locator('.hud-zone')).toContainText(/Phase|Zone/, { timeout: 15_000 });
  expect(errors).toEqual([]);
  expect(en.errors).toEqual([]);
  await en.ctx.close();
  await ctx.close();
});

test('mock single-player flow: setup → roles → hero select → HUD → game over', async () => {
  const { ctx, page, errors } = await open('screen=title', 1280, 720);
  await page.locator('.sg-menu-btn.primary').click();
  await expect(page.locator('[data-screen="single"]')).toBeVisible();
  await page.locator('[data-screen="single"] .sg-seg button', { hasText: '6' }).first().click();
  await expect(page.locator('.sg-role-preview .sg-seal')).toHaveCount(6);
  await page.locator('[data-screen="single"] .sg-btn.gold').click();

  await expect(page.locator('[data-screen="roles"] .flip-card')).toBeVisible();
  await expect(page.locator('[data-screen="roles"] .flip-card.flipped')).toBeVisible({ timeout: 5_000 });

  // lord picks first (bot), then everyone else
  await expect(page.locator('[data-screen="heroSelect"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.sg-select:not(.waiting) .grid .sg-hcard').first()).toBeVisible({ timeout: 20_000 });
  const cards = page.locator('.sg-select .grid .sg-hcard');
  await cards.nth(1).click();
  await expect(cards.nth(1)).toHaveClass(/selected/);
  const heroId = await cards.nth(1).getAttribute('data-hero');
  await expect(page.locator('.detail .sg-hero-detail')).toHaveAttribute('data-hero', heroId ?? '');
  await page.locator('.detail-actions .sg-btn').click();
  await expect(page.locator('.detail-actions .sg-btn')).toBeDisabled();

  // loading → HUD
  await expect(page.locator('.sg-hud .hud-vitals .v-hpbar')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.hud-minimap canvas')).toBeVisible();
  await expect(page.locator('.hud-abilities .ab').first()).toBeVisible();

  // Tab holds the scoreboard
  await page.keyboard.down('Tab');
  await expect(page.locator('.sg-hud.show-score .hud-scoreboard')).toBeVisible();
  await page.keyboard.up('Tab');
  await expect(page.locator('.sg-hud.show-score')).toHaveCount(0);

  // T wheel → number key sends a claim through the InputSink
  await page.keyboard.press('KeyT');
  await expect(page.locator('.sg-hud[data-overlay="wheel"] .hud-wheel')).toBeVisible();
  await page.keyboard.press('Digit1');
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  const actions = await page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { actions: { a: string }[] } | null } } }).__ui.deps.lastGame?.actions.map((a) => a.a) ?? []);
  expect(actions).toContain('claim');

  // Enter opens chat, typing + Enter sends through the session
  await page.keyboard.press('Enter');
  const chat = page.locator('.hud-chat.open input');
  await expect(chat).toBeFocused();
  await chat.fill('跟我来');
  await chat.press('Enter');
  await expect(page.locator('.hud-chat .log')).toContainText('跟我来');

  // M toggles the big map, Esc opens the pause menu
  await page.keyboard.press('KeyM');
  await expect(page.locator('.sg-hud[data-overlay="map"]')).toHaveCount(1);
  await page.keyboard.press('KeyM');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
  await page.locator('.pm-box .sg-btn.gold').click();
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);

  // end the match (F8 dev key) → game over → play again returns to roles
  await page.keyboard.press('F8');
  await expect(page.locator('[data-screen="gameOver"] .over-banner')).toBeVisible();
  await expect(page.locator('.over-table tbody tr')).toHaveCount(6);
  await page.locator('.over-actions .sg-btn.gold').click();
  await expect(page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
  await ctx.close();
});

test('online: join by ?room= link, host lobby controls, failed join shows the error', async () => {
  const { ctx, page, errors } = await open('room=kx7qd');
  const code = page.locator('.sg-code-input');
  await expect(code).toHaveValue('KX7QD');
  await code.fill('FAIL0');
  await page.locator('.join-row .sg-btn').click();
  await expect(page.locator('.sg-online-status .err')).toContainText('房间不存在', { timeout: 10_000 });
  await code.fill('KX7QD');
  await page.locator('.join-row .sg-btn').click();
  await expect(page.locator('[data-screen="lobby"] .room-code')).toContainText('KX7QD', { timeout: 10_000 });
  // clients cannot edit settings, they can ready up
  await expect(page.locator('.settings-panel .sg-seg')).toHaveCount(0);
  await page.locator('.lobby-foot .sg-btn').click();
  await expect(page.locator('.seat.mine .sg-chip.ready')).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();

  const host = await open('screen=lobby');
  const seats = host.page.locator('.seat:not(.empty)');
  const before = await seats.count();
  await host.page.locator('.seat-tools .sg-btn').click();
  await expect(seats).toHaveCount(before + 1);
  await host.page.locator('.seat.bot .acts .sg-btn').first().click();
  await expect(seats).toHaveCount(before);
  await host.page.locator('.lobby-grid .chat input').fill('开打');
  await host.page.locator('.lobby-grid .chat input').press('Enter');
  await expect(host.page.locator('.chat-log')).toContainText('开打');
  expect(host.errors).toEqual([]);
  await host.ctx.close();
});

test('touch controls on a landscape phone', async () => {
  const { ctx, page, errors } = await open('screen=hud&touch=1', 844, 390);
  await expect(page.locator('.sg-touch .fire')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.sg-hud.touch .hud-abilities')).toBeHidden();
  const fire = page.locator('.sg-touch .fire');
  const box = await fire.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.locator('.sg-touch .jump').dispatchEvent('pointerdown', { pointerId: 7, isPrimary: true });
  const actions = await page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { actions: { a: string }[] } | null } } }).__ui.deps.lastGame?.actions.map((a) => a.a) ?? []);
  expect(actions).toContain('jump');
  // touch bar opens the claim wheel
  await page.locator('.hud-touchbar .tb').first().click();
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  expect(await horizontalOverflow(page)).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
