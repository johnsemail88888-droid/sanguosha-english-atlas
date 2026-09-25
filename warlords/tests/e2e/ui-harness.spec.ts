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

/** InputActions that reached the (mock) sim so far, as compact strings like `claim:rebel` / `item:2`. */
async function simActions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type A = { a: string; role?: string; id?: string; slot?: number | string; order?: string };
    const g = (window as unknown as { __ui: { deps: { lastGame: { actions: A[] } | null } } }).__ui.deps.lastGame;
    return (g?.actions ?? []).map((a) => [a.a, a.role ?? a.id ?? a.slot ?? a.order].filter((x) => x !== undefined).join(':'));
  });
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

  // the mock mirrors the input controller: with no overlay a digit is a gameplay key
  await page.keyboard.press('Digit5');
  await expect.poll(() => simActions(page)).toContain('item:1');

  // T wheel → number key sends a claim through the InputSink (and nothing else)
  await page.keyboard.press('KeyT');
  await expect(page.locator('.sg-hud[data-overlay="wheel"] .hud-wheel')).toBeVisible();
  await page.keyboard.press('Digit1');
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  await expect.poll(() => simActions(page)).toContain('claim:loyalist');
  // T then 6 = quick chat #3: the digit must not also use item slot 3 / switch weapons
  await page.keyboard.press('KeyT');
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  await page.keyboard.press('Digit6');
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  await expect.poll(() => simActions(page)).toContainEqual(expect.stringMatching(/^quickchat:/));
  await page.waitForTimeout(100);
  const acts = await simActions(page);
  expect(acts.filter((a) => a === 'item:2' || a.startsWith('weapon'))).toEqual([]);

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
  await expect.poll(() => simActions(page)).toContain('jump');
  // ADS toggles on, then an overlay releases it (InputController.releaseAll) → the button follows
  await page.locator('.sg-touch .ads').dispatchEvent('pointerdown', { pointerId: 8, isPrimary: true });
  await expect(page.locator('.sg-touch .ads.on')).toHaveCount(1);
  // touch bar opens the claim wheel; tapping a claim reaches the sim
  await page.locator('.hud-touchbar .tb').first().click();
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  await expect(page.locator('.sg-touch .ads.on')).toHaveCount(0);
  await page.locator('.hud-wheel .wh-item.claim').nth(1).click();
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  await expect.poll(() => simActions(page)).toContain('claim:rebel');
  await page.locator('.hud-touchbar .tb').first().click();
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  expect(await horizontalOverflow(page)).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('real InputController: wheel claims / quick chat reach the sim, digits never leak', async () => {
  const { ctx, page, errors } = await open('screen=hud&input=real', 1280, 720);
  await expect(page.locator('.sg-hud .hud-vitals .v-hpbar')).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { realInput: boolean } | null } } }).__ui.deps.lastGame?.realInput)).toBe(true);

  // T → 1: claim loyalist
  await page.keyboard.press('KeyT');
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  await page.keyboard.press('Digit1');
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(0);
  await expect.poll(() => simActions(page)).toContain('claim:loyalist');

  // T → 6: quick chat, and NOT item slot 3
  await page.keyboard.press('KeyT');
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  await page.keyboard.press('Digit6');
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(0);
  await expect.poll(() => simActions(page)).toContainEqual(expect.stringMatching(/^quickchat:/));

  // T → click a quick-chat item
  const before = (await simActions(page)).filter((a) => a.startsWith('quickchat')).length;
  await page.keyboard.press('KeyT');
  await expect(page.locator('.sg-hud[data-overlay="wheel"]')).toHaveCount(1);
  await page.locator('.hud-wheel .wh-item.quick').first().click();
  await expect.poll(async () => (await simActions(page)).filter((a) => a.startsWith('quickchat')).length).toBe(before + 1);

  await page.waitForTimeout(150);
  const acts = await simActions(page);
  expect(acts.filter((a) => a.startsWith('item') || a.startsWith('weapon')), acts.join(', ')).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('pointer lock: Esc under lock with chat open ends in "click to play", clicking resumes', async () => {
  const { ctx, page, errors } = await open('screen=hud', 1280, 720);
  await expect(page.locator('.sg-hud .hud-vitals .v-hpbar')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('.hud-chat.open input')).toBeFocused();
  // the browser drops the lock on Esc; the chat input closes chat on the same key
  await page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { simulateUnlock(): void } } } }).__ui.deps.lastGame.simulateUnlock());
  await page.locator('.hud-chat.open input').press('Escape');
  await expect(page.locator('.sg-hud[data-overlay="pause"] .hud-pause[data-mode="click"]')).toBeVisible();
  await page.locator('.hud-pause .click-prompt').click();
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { input: { isLocked(): boolean } } } } }).__ui.deps.lastGame.input.isLocked())).toBe(true);

  // losing the lock during play opens the pause menu; wheel picks are not affected by the lock
  await page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { simulateUnlock(): void } } } }).__ui.deps.lastGame.simulateUnlock());
  await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('roles: the real Lord is told which crown is the Body Double', async () => {
  const { ctx, page, errors } = await open('screen=roles&role=lord&double=1', 1280, 720);
  await expect(page.locator('[data-screen="roles"] .crown-secret.yourDouble')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.seat-chip.decoy')).toHaveCount(1);
  expect(errors).toEqual([]);
  await ctx.close();
  const dbl = await open('screen=heroSelect&role=double&lordPhase=1', 1280, 720);
  await expect(dbl.page.locator('[data-screen="heroSelect"] .grid .sg-hcard').first()).toBeVisible({ timeout: 10_000 });
  await expect(dbl.page.locator('.sg-select.waiting')).toHaveCount(0);
  await expect(dbl.page.locator('.detail-actions .sg-btn')).toBeEnabled();
  await expect(dbl.page.locator('.picks-strip .pick.lord')).toHaveCount(2);
  expect(dbl.errors).toEqual([]);
  await dbl.ctx.close();
});

// ── playtest round-1 fixes (G1) ──────────────────────────────────────────────

type HarnessWin = Window & {
  __ui: {
    deps: {
      lastSession: { calls: string[]; view: { elapsed(): number } | null } | null;
      lastGame: { input: { isLocked(): boolean }; actions: unknown[] } | null;
    };
  };
};
const calls = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as HarnessWin).__ui.deps.lastSession?.calls ?? []);

test('settings sliders: knobs sit on their values, one arrow step = one step', async () => {
  const { ctx, page, errors } = await open('screen=settings&tab=audio', 1280, 720);
  const sliders = page.locator('.sg-settings .sg-range');
  await expect(sliders.first()).toBeVisible();
  // every knob agrees with its fill (--p) and its label
  const check = async (): Promise<{ v: string; p: string; out: string; min: string; max: string }[]> =>
    sliders.evaluateAll((els) => els.map((el) => {
      const i = el.querySelector('input') as HTMLInputElement;
      return { v: i.value, p: i.style.getPropertyValue('--p'), out: el.querySelector('output')?.textContent ?? '', min: i.min, max: i.max };
    }));
  for (const s of await check()) {
    const pct = ((Number(s.v) - Number(s.min)) / (Number(s.max) - Number(s.min))) * 100;
    expect(Number.parseFloat(s.p)).toBeCloseTo(pct, 3);
    expect(s.out).toBe(`${Math.round(Number(s.v) * 100)}%`);
  }
  // 音乐 50 % → one ArrowLeft → 49 %
  const music = sliders.nth(1).locator('input');
  const before = Number(await music.inputValue());
  await music.focus();
  await page.keyboard.press('ArrowLeft');
  expect(Number(await music.inputValue())).toBeCloseTo(before - 0.01, 5);
  await expect(sliders.nth(1).locator('output')).toHaveText(`${Math.round((before - 0.01) * 100)}%`);
  // 操作: ADS 0.60× stays 0.6 (was 1.2 before value came after min/max/step)
  await page.locator('.sg-settings .sg-tab[data-tab="controls"]').click();
  const ads = page.locator('.sg-settings .sg-range').nth(1);
  const adsVal = Number(await ads.locator('input').inputValue());
  await expect(ads.locator('output')).toHaveText(`${adsVal.toFixed(2)}×`);
  expect(adsVal).toBeLessThan(1.5);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('hero select: cards stay attached while picks arrive, focus is sent, the clicked card is locked in on time', async () => {
  const { ctx, page, errors } = await open('screen=title', 1280, 720);
  await page.locator('.sg-menu-btn.primary').click();
  await page.locator('[data-screen="single"] .sg-btn.gold').click();
  await expect(page.locator('.sg-select:not(.waiting) .grid .sg-hcard').first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    const w = window as Window & { __cards?: Element[] };
    w.__cards = [...document.querySelectorAll('.sg-select .grid .sg-hcard')];
  });
  const cards = page.locator('.sg-select .grid .sg-hcard');
  const n = await cards.count();
  // bots pick one by one (a heroSelect event every ~450 ms): click through the cards meanwhile
  for (let i = 0; i < 6; i++) {
    await cards.nth(i % n).click();
    await page.waitForTimeout(220);
  }
  const third = cards.nth(Math.min(2, n - 1));
  await third.click();
  const hero = (await third.getAttribute('data-hero')) ?? '';
  expect(await page.evaluate(() => (window as Window & { __cards?: Element[] }).__cards!.every((c) => c.isConnected))).toBe(true);
  expect(await calls(page)).toContain(`focusHero:${hero}`);
  // no 选定: the countdown (20 s) locks the clicked card in at ≤ 1.5 s
  await expect.poll(() => calls(page), { timeout: 30_000 }).toContain(`pickHero:${hero}`);
  expect((await calls(page)).filter((c) => c.startsWith('pickHero'))).toEqual([`pickHero:${hero}`]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('single player: 返回 / Esc on roles and hero select go back to the setup', async () => {
  const roles = await open('screen=roles&single=1', 1280, 720);
  await roles.page.locator('.sg-roles .sg-back').click();
  await expect(roles.page.locator('[data-screen="single"]')).toBeVisible();
  expect(await calls(roles.page)).toContain('returnToLobby');
  expect(roles.errors).toEqual([]);
  await roles.ctx.close();
  const sel = await open('screen=heroSelect&single=1', 1280, 720);
  await expect(sel.page.locator('.sel-head .sel-back')).toBeVisible();
  await sel.page.keyboard.press('Escape');
  await expect(sel.page.locator('[data-screen="single"]')).toBeVisible();
  // online sessions have no such button
  const online = await open('screen=heroSelect', 1280, 720);
  await expect(online.page.locator('.grid .sg-hcard').first()).toBeVisible();
  await expect(online.page.locator('.sel-back')).toHaveCount(0);
  expect(sel.errors).toEqual([]);
  await sel.ctx.close();
  await online.ctx.close();
});

test('pause: single player really pauses (menu, settings), releases the pointer; online reads 菜单 and runs on', async () => {
  const { ctx, page, errors } = await open('screen=hud', 1280, 720);
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1, { timeout: 15_000 });
  const locked = (): Promise<boolean> => page.evaluate(() => (window as unknown as HarnessWin).__ui.deps.lastGame!.input.isLocked());
  const clock = (): Promise<number> => page.evaluate(() => (window as unknown as HarnessWin).__ui.deps.lastSession!.view!.elapsed());
  expect(await locked()).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box h2')).toHaveText('暂停');
  // the menu needs a free cursor: the lock is released at once
  await expect.poll(locked).toBe(false);
  expect(await calls(page)).toContain('setPaused:true');
  const t0 = await clock();
  await page.waitForTimeout(800);
  expect(await clock()).toBeCloseTo(t0, 5);
  // settings from the pause menu: still paused
  await page.locator('.pm-box .sg-btn').nth(1).click();
  await expect(page.locator('.sg-settings')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await clock()).toBeCloseTo(t0, 5);
  await page.keyboard.press('Escape');
  await expect(page.locator('.sg-settings')).toHaveCount(0);
  // 离开对局 is clickable → confirm dialog (cancel)
  await page.locator('.pm-box .sg-btn', { hasText: '离开对局' }).click();
  await expect(page.locator('.sg-modal-back[role="dialog"] .sg-modal')).toContainText('确定离开当前对局');
  await page.locator('.sg-modal .actions .sg-btn').first().click();
  // 继续战斗 re-takes the lock and resumes the clock
  await page.locator('.pm-box .sg-btn.gold').click();
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  await expect.poll(locked).toBe(true);
  expect((await calls(page)).filter((c) => c.startsWith('setPaused')).slice(-1)).toEqual(['setPaused:false']);
  await expect.poll(clock, { timeout: 10_000 }).toBeGreaterThan(t0 + 0.1);
  // the card guide lists your cards with their effects
  await page.keyboard.press('Escape');
  await expect(page.locator('.pm-cards .pc-list.held .pc-card').first()).toBeVisible();
  await page.locator('.pc-all-toggle').click();
  await expect(page.locator('.pm-cards .pc-list.all .pc-card')).toHaveCount(20);
  await expect(page.locator('.pm-cards .pc-list.all .pc-card[data-item="shandian"] .desc')).toContainText('雷');
  expect(errors).toEqual([]);
  await ctx.close();

  const on = await open('screen=hud&kind=online', 1280, 720);
  await expect(on.page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1, { timeout: 15_000 });
  await on.page.keyboard.press('Escape');
  await expect(on.page.locator('.pm-box h2')).toHaveText('菜单');
  await expect(on.page.locator('.pm-box')).not.toContainText('暂停');
  await expect(on.page.locator('.pm-note')).toContainText('对局仍在进行');
  expect((await calls(on.page)).filter((c) => c.startsWith('setPaused'))).toEqual([]);
  // the host can end the match for everyone
  await on.page.locator('.pm-box .pm-end').click();
  await on.page.locator('.sg-modal .actions .sg-btn').last().click();
  await expect.poll(() => calls(on.page)).toContain('returnToLobby');
  expect(on.errors).toEqual([]);
  await on.ctx.close();
});

test('touch: map / scoreboard let the controls through, every overlay button toggles, long-press explains a card', async () => {
  const { ctx, page, errors } = await open('screen=hud&touch=1', 844, 390);
  await expect(page.locator('.sg-touch .fire')).toBeVisible({ timeout: 15_000 });
  const hits = (): Promise<Record<string, string>> => page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const sel of ['.hud-touchbar .tb', '.sg-touch .fire', '.sg-touch .zone.move', '.sg-touch .jump']) {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out[sel] = hit && (hit === el || el.contains(hit)) ? 'ok' : `${hit?.className}`;
    }
    return out;
  });
  const tb = (key: string) => page.locator(`.hud-touchbar .tb[data-key="${key}"]`);
  const overlay = (): Promise<string | undefined> => page.evaluate(() => document.querySelector<HTMLElement>('.sg-hud')!.dataset.overlay);
  await tb('map').click();
  expect(await overlay()).toBe('map');
  expect(await hits()).toEqual({ '.hud-touchbar .tb': 'ok', '.sg-touch .fire': 'ok', '.sg-touch .zone.move': 'ok', '.sg-touch .jump': 'ok' });
  await tb('map').click();
  expect(await overlay()).toBe('none');
  await tb('map').click();
  await page.locator('.hud-bigmap .hud-close .x').click();
  expect(await overlay()).toBe('none');
  await tb('score').click();
  await expect(page.locator('.sg-hud.show-score')).toHaveCount(1);
  expect((await hits())['.hud-touchbar .tb']).toBe('ok');
  await tb('score').click();
  await expect(page.locator('.sg-hud.show-score')).toHaveCount(0);
  await tb('score').click();
  await page.locator('.hud-scoreboard .hud-close').click();
  await expect(page.locator('.sg-hud.show-score')).toHaveCount(0);
  await tb('wheel').click();
  expect(await overlay()).toBe('wheel');
  await expect(page.locator('.wh-hint')).not.toContainText('Esc');
  await tb('wheel').click();
  expect(await overlay()).toBe('none');
  await tb('wheel').click();
  await page.mouse.click(420, 30);
  expect(await overlay()).toBe('none');
  await tb('chat').click();
  expect(await overlay()).toBe('chat');
  await expect(page.locator('.hud-chat.open .chat-close')).toBeVisible();
  await expect(page.locator('.hud-chat.open input')).toHaveAttribute('placeholder', /发送/);
  await tb('chat').click();
  expect(await overlay()).toBe('none');
  await tb('chat').click();
  await page.locator('.hud-chat .chat-close').click();
  expect(await overlay()).toBe('none');
  // long-press an item slot: its description, and the card is NOT used
  const slot = page.locator('.sg-touch .item:not(.empty)').first();
  const before = (await simActions(page)).filter((a) => a.startsWith('item')).length;
  await slot.dispatchEvent('pointerdown', { pointerId: 21, isPrimary: true });
  await page.waitForTimeout(650);
  await slot.dispatchEvent('pointerup', { pointerId: 21, isPrimary: true });
  await expect(page.locator('.hud-cardinfo:not(.off) .pc-card .desc')).not.toBeEmpty();
  await page.waitForTimeout(150);
  expect((await simActions(page)).filter((a) => a.startsWith('item')).length).toBe(before);
  // a short tap still uses it
  await slot.dispatchEvent('pointerdown', { pointerId: 22, isPrimary: true });
  await slot.dispatchEvent('pointerup', { pointerId: 22, isPrimary: true });
  await expect.poll(async () => (await simActions(page)).filter((a) => a.startsWith('item')).length).toBe(before + 1);
  expect(errors).toEqual([]);
  await ctx.close();
});

// ── wave 2: painted card / icon art, lord toast, link chip ───────────────────

/** Like open(), also recording every HTTP error and every card / icon / weapon art request. */
async function openArt(query: string, width = 1280, height = 720): Promise<Opened & { http: string[]; art: string[] }> {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const http: string[] = [];
  const art: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) http.push(`${r.status()} ${r.url()}`);
    if (/\/assets\/(cards|icons|weapons)\//.test(r.url())) art.push(r.url());
  });
  await page.goto(`${URL}?${query}`);
  return { ctx, page, errors, http, art };
}

/** card / icon art elements anywhere in the UI */
const artCount = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll('.sg-art, .art-on, .sg-rcard, .front.art, .pm-role').length);

type ArtHarness = { __ui: { deps: { lastGame: { emitUiKey(k: string, d: boolean): void }; lastSession: { heroSelect: object; emit(e: string, v: unknown): void; othersPhase(): void; status(zh: string, en: string, extra?: { key?: string; clear?: boolean }): void } } } };

test('card art: HUD, pause, identity card and 玩法说明 use the painted art — without files, not one art element or request', async () => {
  const a = await openArt('screen=hud');
  const pg = a.page;
  await expect(pg.locator('.hud-abilities .ico.art-on .sg-art.disc img').first()).toBeVisible({ timeout: 15_000 });
  expect(await pg.locator('.hud-abilities .ico.art-on').count()).toBeGreaterThanOrEqual(2);
  await expect(pg.locator('.hud-abilities .item .card.art-on')).toHaveCount(3);
  await expect(pg.locator('.v-gear .gchip.art-on')).toHaveCount(2);
  await expect(pg.locator('.role-chip .sg-rcard img')).toBeVisible();
  // the weapon render: black cut out on a canvas (a blob URL)
  await expect(pg.locator('.w-main.art-on .w-art img')).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
  await expect(pg.locator('.w-slots .wslot.art-on')).toHaveCount(2);
  // the seeded kill: its weapon glyph in the feed
  await expect(pg.locator('.hud-feed .kf .kf-how').first()).toBeVisible();
  // every round emblem / card decoded (no broken image)
  await expect.poll(() => pg.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.sg-art.disc img, .sg-rcard img')].every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
  // pause: your identity card and goal
  await pg.evaluate(() => (window as unknown as ArtHarness).__ui.deps.lastGame.emitUiKey('menu', true));
  await expect(pg.locator('.pm-role .sg-rcard img')).toBeVisible();
  expect(a.http, 'http errors').toEqual([]);
  expect(a.errors).toEqual([]);
  await a.ctx.close();

  const r = await openArt('screen=roles&role=rebel');
  await expect(r.page.locator('.flip-card.flipped .front.art .sg-art img')).toBeVisible({ timeout: 15_000 });
  await expect(r.page.locator('.flip-card .front.art .rname')).toHaveText('反贼');
  expect(r.http).toEqual([]);
  expect(r.errors).toEqual([]);
  await r.ctx.close();

  const hp = await openArt('screen=help');
  await expect(hp.page.locator('.role-row .sg-rcard')).toHaveCount(7);
  await hp.page.locator('.sg-tab[data-tab="items"]').click();
  await expect(hp.page.locator('.sg-table.items .item-glyph.art-on')).toHaveCount(20);
  await hp.page.locator('.sg-tab[data-tab="gear"]').click();
  await expect(hp.page.locator('.item-glyph.art-on')).toHaveCount(10);
  await hp.page.locator('.sg-tab[data-tab="weapons"]').click();
  await expect(hp.page.locator('.sg-table.weapons .wt-art')).toHaveCount(27);
  await expect(hp.page.locator('.sg-table.weapons .wt-art img').first()).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
  expect(hp.http).toEqual([]);
  expect(hp.errors).toEqual([]);
  await hp.ctx.close();

  // without the art (single-file build): the procedural look — no art element, no art request
  for (const [q, ready] of [
    ['screen=hud&art=0', '.sg-hud .hud-weapon .w-main'],
    ['screen=roles&role=rebel&art=0', '.flip-card.flipped .front'],
    ['screen=gameOver&art=0', '[data-screen="gameOver"] .over-table .role-cell'],
    ['screen=scoreboard&art=0', '.sg-hud.show-score .hud-scoreboard .role-cell'],
  ]) {
    const n = await openArt(q);
    await expect(n.page.locator(ready).first(), q).toBeVisible({ timeout: 15_000 });
    await n.page.waitForTimeout(1500);
    expect(await artCount(n.page), q).toBe(0);
    expect(n.art, q).toEqual([]);
    expect(n.http, q).toEqual([]);
    expect(n.errors, q).toEqual([]);
    await n.ctx.close();
  }
  const nh = await openArt('screen=help&art=0');
  await expect(nh.page.locator('.help-body .role-row').first()).toBeVisible({ timeout: 15_000 });
  for (const tab of ['roles', 'items', 'gear', 'weapons']) {
    await nh.page.locator(`.sg-tab[data-tab="${tab}"]`).click();
    await nh.page.waitForTimeout(300);
    expect(await artCount(nh.page), tab).toBe(0);
  }
  expect(nh.art).toEqual([]);
  expect(nh.errors).toEqual([]);
  await nh.ctx.close();
});

test('hero select: the "♛ Lord chose X" toast never covers a hero card (1280×720, 1600×900, phones)', async () => {
  for (const [w, hgt] of [[1280, 720], [1600, 900], [390, 844], [844, 390]]) {
    const { ctx, page, errors } = await open('screen=heroSelect&lordPhase=1', w, hgt);
    // the lord phase: you wait (no cards yet) while the crown picks
    await expect(page.locator('[data-screen="heroSelect"] .picks-strip .pick').first()).toBeVisible({ timeout: 15_000 });
    // the lord picks, then the other seats get their options while the toast is still up
    await page.evaluate(() => {
      const s = (window as unknown as ArtHarness).__ui.deps.lastSession;
      s.heroSelect = { ...s.heroSelect, options: [], picks: { 0: 'liubei' } };
      s.emit('heroSelect', s.heroSelect);
      s.othersPhase();
    });
    await expect(page.locator('.lord-flash.show')).toHaveCount(1);
    await expect(page.locator('.grid .sg-hcard')).toHaveCount(3);
    const hits = await page.evaluate(() => {
      const band = document.querySelector('.lord-flash .lf-band')!.getBoundingClientRect();
      const over = (r: DOMRect): boolean => r.left < band.right && band.left < r.right && r.top < band.bottom && band.top < r.bottom;
      return {
        cards: [...document.querySelectorAll('.grid .sg-hcard')].filter((c) => over(c.getBoundingClientRect())).length,
        inside: band.left >= -1 && band.right <= window.innerWidth + 1 && band.height > 0,
      };
    });
    expect(hits, `${w}×${hgt}`).toEqual({ cards: 0, inside: true });
    expect(errors).toEqual([]);
    await ctx.close();
  }
});

test('online HUD: a host freeze is one live chip (replaced in place, green, gone) and one chat line per change', async () => {
  const { ctx, page, errors } = await open('screen=hud&kind=online', 1280, 720);
  await expect(page.locator('.sg-hud .hud-vitals')).toBeVisible({ timeout: 15_000 });
  const status = (zh: string, en: string, extra: { key?: string; clear?: boolean } = {}): Promise<void> =>
    page.evaluate(([a, b, c]) => (window as unknown as ArtHarness).__ui.deps.lastSession.status(a, b, c), [zh, en, extra] as const);
  const sysLines = (): Promise<number> => page.locator('.hud-chat .line.k-system').count();
  const before = await sysLines();
  for (let i = 0; i < 3; i++) await status('等待主机响应…', 'Waiting for host…', { key: 'waitingHost' });
  await expect(page.locator('.link-chip')).toHaveText('⚠ 等待主机响应…');
  await expect(page.locator('.link-chip')).toHaveAttribute('data-tone', 'warn');
  await expect(page.locator('.hud-top .match-info')).toBeHidden();
  expect(await sysLines()).toBe(before + 1);
  await status('主机已恢复响应', 'Host is responding again', { key: 'waitingHost', clear: true });
  await expect(page.locator('.link-chip')).toHaveText('✓ 主机已恢复响应');
  expect(await sysLines()).toBe(before + 2);
  // no announcement for the link, and the chip clears itself
  await expect(page.locator('.hud-announce')).not.toContainText('主机');
  await expect(page.locator('.link-chip')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('.hud-top .match-info')).toBeVisible();
  // a host notice still reads as a chat line + an announcement
  await status('玩家离开了', 'A player left');
  await expect(page.locator('.hud-announce .ann-info')).toContainText('玩家离开了');
  expect(errors).toEqual([]);
  await ctx.close();
});
