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
  // art turns on only once its file has loaded (UX-16): the first request of a match's ~130
  // emblems goes to a cold dev server, which on a loaded machine (full e2e run) can take > 15 s
  await expect(pg.locator('.hud-abilities .ico.art-on .sg-art.disc img').first()).toBeVisible({ timeout: 60_000 });
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

test('online HUD: a host freeze is one live chip (replaced in place, green, gone); only a lasting one gets a chat line, updated in place', async () => {
  const { ctx, page, errors } = await open('screen=hud&kind=online', 1280, 720);
  await expect(page.locator('.sg-hud .hud-vitals')).toBeVisible({ timeout: 15_000 });
  const status = (zh: string, en: string, extra: { key?: string; clear?: boolean } = {}): Promise<void> =>
    page.evaluate(([a, b, c]) => (window as unknown as ArtHarness).__ui.deps.lastSession.status(a, b, c), [zh, en, extra] as const);
  const sysLines = (): Promise<number> => page.locator('.hud-chat .line.k-system').count();
  const before = await sysLines();
  // (the net layer says 主机; the HUD reads 房主 like every other online string — UX-17)
  for (let i = 0; i < 3; i++) await status('等待主机响应…', 'Waiting for host…', { key: 'waitingHost' });
  // (the chip's text; since MP2-1 a waiting chip also carries 离开 — and a counter once the session reports the silence)
  await expect(page.locator('.link-chip .lk-text')).toHaveText('⚠ 等待房主响应…');
  await expect(page.locator('.link-chip .lk-btn')).toHaveText(['离开']);
  await expect(page.locator('.link-chip')).toHaveAttribute('data-tone', 'warn');
  await expect(page.locator('.hud-top .match-info')).toBeHidden();
  await status('主机已恢复响应', 'Host is responding again', { key: 'waitingHost', clear: true });
  await expect(page.locator('.link-chip')).toHaveText('✓ 房主已恢复响应');
  await expect(page.locator('.link-chip .lk-btn')).toHaveCount(0);
  // a short freeze is the chip alone (MP2-7)
  expect(await sysLines()).toBe(before);
  // no announcement for the link, and the chip clears itself
  await expect(page.locator('.hud-announce')).not.toContainText('房主');
  await expect(page.locator('.link-chip')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('.hud-top .match-info')).toBeVisible();
  // a freeze that lasts: one line after ~10 s, and the same line says when the host is back
  await status('等待主机响应…', 'Waiting for host…', { key: 'waitingHost' });
  await expect.poll(sysLines, { timeout: 25_000 }).toBe(before + 1);
  await expect(page.locator('.hud-chat .line.k-system').last()).toContainText('等待房主响应…');
  await status('主机已恢复响应', 'Host is responding again', { key: 'waitingHost', clear: true });
  await expect(page.locator('.hud-chat .line.k-system').last()).toContainText('房主已恢复响应（中断');
  expect(await sysLines()).toBe(before + 1);
  // a host notice still reads as a chat line + an announcement
  await status('玩家离开了', 'A player left');
  await expect(page.locator('.hud-announce .ann-info')).toContainText('玩家离开了');
  expect(errors).toEqual([]);
  await ctx.close();
});

// ── playtest round 2 (UX-1…19, COMBAT-7/8/11) ─────────────────────────────────

/** The mock view's internals (private in TS): your items, the entity list, events. */
type MockInternals = {
  __ui: {
    deps: {
      lastSession: {
        view: { me: { items: unknown[] }; myId: number; ents: Map<number, { x: number; y: number; z: number; yaw: number }>; list: unknown[]; playerList: { entityId: number; isBot: boolean }[]; emit(e: unknown): void };
        finish(w: string): void;
        fail(code: string, zh: string, en: string): void;
      };
    };
  };
};

/** Four different cards in your bar and a 桃 (or `sub`) lying just in front of you. */
async function fullBarWithLoot(page: Page, sub = 'tao'): Promise<void> {
  await page.evaluate((id) => {
    const v = (window as unknown as MockInternals).__ui.deps.lastSession.view;
    v.me.items = [{ id: 'wugu', count: 1 }, { id: 'jiedao', count: 1 }, { id: 'tiesuo', count: 1 }, { id: 'wuxie', count: 1 }];
    const loot = { id: 9001, kind: 'loot', sub: id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 };
    const follow = (): void => {
      const m = v.ents.get(v.myId)!;
      loot.x = m.x - Math.sin(m.yaw) * 1.1;
      loot.z = m.z - Math.cos(m.yaw) * 1.1;
      loot.y = m.y;
    };
    follow();
    v.ents.set(loot.id, loot as never);
    v.list.push(loot);
    setInterval(follow, 30);
  }, sub);
}

test('round 2: help tables, card labels, pickup lines, full-bar swap + discard, scope, draw, name field, ping column, reconnect', async () => {
  // UX-1 / UX-2 / UX-8: 玩法说明
  const hp = await open('screen=help');
  await expect(hp.page.locator('.help-body .role-row').first()).toBeVisible({ timeout: 15_000 });
  await hp.page.locator('.sg-tab[data-tab="items"]').click();
  // 杀 (common) in the dark parchment ink, not the pale HUD grey
  await expect(hp.page.locator('.sg-table.items tbody tr').first().locator('b').first()).toHaveCSS('color', 'rgb(66, 59, 48)');
  await hp.page.locator('.sg-tab[data-tab="weapons"]').click();
  const weap = await hp.page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sg-table.weapons tbody tr')];
    let overlaps = 0;
    for (const r of rows) {
      const name = r.querySelector('td.wname > b')!.getBoundingClientRect();
      const chip = r.querySelector('td.wname .sg-chip')?.getBoundingClientRect();
      if (chip && chip.top < name.bottom - 1 && chip.left < name.right) overlaps++;
    }
    return { rows: rows.length, overlaps, text: document.querySelector('.sg-table.weapons')!.textContent };
  });
  expect(weap.rows).toBe(27);
  expect(weap.overlaps).toBe(0);
  expect(weap.text).not.toContain('力士巨锤');
  expect(weap.text).not.toContain('象牙冲撞');
  await hp.page.locator('.sg-tab[data-tab="squad"]').click();
  // every troop name on one line (黄巾力士 / 南蛮勇士 used to break mid-word)
  // (an inline box has one client rect per line it spans)
  const lines = await hp.page.evaluate(() => [...document.querySelectorAll('.sg-table.troops tbody td:first-child > b')].map((b) => b.getClientRects().length));
  expect(lines.length).toBeGreaterThan(5);
  expect(lines.every((n) => n === 1)).toBe(true);
  expect(hp.errors).toEqual([]);
  await hp.ctx.close();

  // UX-9 labels + COMBAT-8 pickup lines (never over the crosshair)
  const hud = await open('screen=hud');
  const pg = hud.page;
  await expect(pg.locator('.sg-hud .hud-vitals')).toBeVisible({ timeout: 15_000 });
  await pg.evaluate(() => {
    const v = (window as unknown as MockInternals).__ui.deps.lastSession.view;
    v.me.items = [{ id: 'sha', count: 2 }, { id: 'tao', count: 1 }, { id: 'wuzhong', count: 1 }, { id: 'jiedao', count: 1 }];
  });
  await expect(pg.locator('.hud-abilities .item .card.art-on')).toHaveCount(4);
  expect(await pg.locator('.hud-abilities .item .nm').allTextContents()).toEqual(['杀', '桃', '无中', '借刀']);
  for (const nm of await pg.locator('.hud-abilities .item .nm').all()) await expect(nm).toBeVisible();
  const infoLines = await pg.locator('.hud-announce .ann-info .line').count();
  await pg.evaluate(() => {
    const v = (window as unknown as MockInternals).__ui.deps.lastSession.view;
    for (const item of ['nanman', 'nanman', 'tiesuo', 'qinglong']) v.emit({ t: 'pickup', who: v.myId, item });
  });
  await expect(pg.locator('.hud-pickups .pk-row')).toHaveCount(3);
  await expect(pg.locator('.hud-pickups .pk-row').first()).toContainText('×2');
  const strip = await pg.locator('.hud-pickups').boundingBox();
  expect(strip!.y).toBeGreaterThan((720 * 2) / 3);
  expect(await pg.locator('.hud-announce .ann-info .line').count()).toBe(infoLines);
  await expect(pg.locator('.hud-pickups .pk-row')).toHaveCount(0, { timeout: 10_000 });
  expect(hud.errors).toEqual([]);
  await hud.ctx.close();

  // COMBAT-7: F swaps with slot 7 — the prompt says which card goes and how to discard another
  const fb = await open('screen=hud');
  await expect(fb.page.locator('.sg-hud .hud-vitals')).toBeVisible({ timeout: 15_000 });
  await fullBarWithLoot(fb.page);
  await expect(fb.page.locator('.hud-interact.swapcard:not(.off)')).toBeVisible();
  await expect(fb.page.locator('.hud-interact .sg-key')).toHaveText('F');
  await expect(fb.page.locator('.hud-interact .txt')).toContainText('7');
  await expect(fb.page.locator('.hud-interact .txt')).toContainText('无懈可击');
  await expect(fb.page.locator('.hud-interact .sub')).toContainText('X');
  expect(fb.errors).toEqual([]);
  await fb.ctx.close();
  // …and X + 6 on the real InputController drops slot 6 (no squad "hold" order on X's release)
  const rk = await open('screen=hud&input=real');
  await expect(rk.page.locator('.sg-hud .hud-vitals')).toBeVisible({ timeout: 15_000 });
  await rk.page.evaluate(() => (window as unknown as { __ui: { deps: { lastGame: { input: { setEnabled(b: boolean): void } } } } }).__ui.deps.lastGame.input.setEnabled(true));
  await rk.page.keyboard.down('x');
  await rk.page.keyboard.press('6');
  await rk.page.keyboard.up('x');
  await expect.poll(() => simActions(rk.page)).toContain('drop:2');
  expect((await simActions(rk.page)).filter((a) => a.startsWith('command') || a.startsWith('item'))).toEqual([]);
  expect(rk.errors).toEqual([]);
  await rk.ctx.close();

  // COMBAT-11: looking through a scope, no F prompt in the lens
  const sc = await open('screen=hud&weapon=qilin&ads=1');
  await expect(sc.page.locator('.hud-scope.on')).toBeVisible({ timeout: 15_000 });
  await fullBarWithLoot(sc.page, 'zhuge');
  await expect(sc.page.locator('.hud-interact:not(.off)')).toHaveCount(1);
  await expect(sc.page.locator('.hud-interact')).toHaveCSS('visibility', 'hidden');
  await sc.ctx.close();

  // UX-13: a draw is 平 on every row
  const go = await open('screen=gameOver&single=1');
  await expect(go.page.locator('[data-screen="gameOver"] .over-banner')).toBeVisible({ timeout: 15_000 });
  await go.page.evaluate(() => (window as unknown as MockInternals).__ui.deps.lastSession.finish('draw'));
  await expect(go.page.locator('.over-table .res.d')).toHaveCount(8);
  await expect(go.page.locator('.over-table .res.l')).toHaveCount(0);
  await go.ctx.close();

  // UX-14: a generated name is the placeholder ("Nameless 885"), the field is empty
  const nm = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await nm.addInitScript(() => localStorage.setItem('sgwl.settings.v1', JSON.stringify({ playerName: '无名885' })));
  const np = await nm.newPage();
  await np.goto(`${URL}?screen=settings&lang=en`);
  const field = np.locator('.sg-settings input.sg-input').first();
  await expect(field).toHaveAttribute('placeholder', 'Nameless 885', { timeout: 15_000 });
  await expect(field).toHaveValue('');
  await nm.close();

  // UX-19: single player (you + bots): no 延迟 column; a remote human brings it back
  const sb = await open('screen=scoreboard');
  await expect(sb.page.locator('.sg-hud.show-score .hud-scoreboard')).toBeVisible({ timeout: 15_000 });
  await expect(sb.page.locator('.hud-scoreboard thead th', { hasText: '延迟' })).toBeVisible();
  await sb.page.evaluate(() => {
    const v = (window as unknown as MockInternals).__ui.deps.lastSession.view;
    for (const p of v.playerList) if (p.entityId !== v.myId) p.isBot = true;
  });
  await expect(sb.page.locator('.hud-scoreboard thead th', { hasText: '延迟' })).toBeHidden();
  await sb.ctx.close();

  // MP2-3: a guest who lost the host is offered 重新加入 {CODE}; the record survives the drop
  const rc = await open('screen=lobby&host=0');
  await expect(rc.page.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 15_000 });
  const drop = (): Promise<void> => rc.page.evaluate(() => {
    sessionStorage.setItem('sgwl.rejoin.v1', JSON.stringify({ code: 'BWKQR', mode: 'peer', net: {}, at: Date.now() }));
    (window as unknown as MockInternals).__ui.deps.lastSession.fail('connectionLost', '与房主的连接已断开', 'Lost connection to the host');
  });
  await drop();
  const rejoinBtn = rc.page.locator('.sg-modal-back .sg-btn', { hasText: '重新加入 BWKQR' });
  await expect(rejoinBtn).toBeVisible();
  // 返回标题 first: the record is kept, and the online screen offers the rejoin in the room's own mode (no auto join)
  await rc.page.locator('.sg-modal-back .sg-btn', { hasText: '返回标题' }).click();
  expect(await rc.page.evaluate(() => sessionStorage.getItem('sgwl.rejoin.v1'))).toContain('BWKQR');
  await rc.page.locator('[data-screen="title"] .sg-menu-btn', { hasText: '联机对战' }).click();
  await expect(rc.page.locator('[data-screen="online"] .sg-rejoin .rejoin-btn')).toHaveText('重新加入 BWKQR');
  await expect(rc.page.locator('[data-screen="online"] .sg-code-input')).toHaveValue('BWKQR');
  await expect(rc.page.locator('[data-screen="online"] .sg-seg button[data-value="peer"]')).toHaveAttribute('aria-pressed', 'true');
  await rc.page.waitForTimeout(1500);
  await expect(rc.page.locator('[data-screen="online"]')).toBeVisible();
  // the button joins that room, in P2P, and lands in its lobby
  await rc.page.locator('[data-screen="online"] .sg-rejoin .rejoin-btn').click();
  await expect(rc.page.locator('[data-screen="lobby"] .room-code')).toContainText('BWKQR');
  // dropped again: 重新加入 in the dialog rejoins by itself
  await drop();
  await rejoinBtn.click();
  await expect(rc.page.locator('[data-screen="lobby"] .room-code')).toContainText('BWKQR', { timeout: 15_000 });
  expect(rc.errors).toEqual([]);
  await rc.ctx.close();
});

/** Two boxes overlap (by more than a pixel)? */
const overlaps = (a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null): boolean =>
  !!a && !!b && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

test('MP2-11 small screens: lord HUD row, game over, online error, role seals, guest settings, wheel hint, loading card', async () => {
  // a lord's four emblems + four cards between the vitals and the weapon panel (640×360, 800×450)
  for (const [w, hgt] of [[640, 360], [800, 450]]) {
    const { ctx, page, errors } = await open('screen=hud&role=lord', w, hgt);
    await expect(page.locator('.hud-abilities .ab')).toHaveCount(4, { timeout: 15_000 });
    const bar = await page.locator('.hud-abilities').boundingBox();
    expect(overlaps(bar, await page.locator('.hud-weapon .w-main').boundingBox()), `${w}×${hgt} weapon`).toBe(false);
    expect(overlaps(bar, await page.locator('.hud-vitals').boundingBox()), `${w}×${hgt} vitals`).toBe(false);
    expect(bar!.x + bar!.width).toBeLessThanOrEqual(w);
    expect(errors).toEqual([]);
    await ctx.close();
  }
  // game over 640×360: your four stats above the sticky button bar
  const go = await open('screen=gameOver&single=1', 640, 360);
  await expect(go.page.locator('.stat-row .stat')).toHaveCount(4, { timeout: 15_000 });
  const actions = await go.page.locator('.over-actions').boundingBox();
  for (const st of await go.page.locator('.stat-row .stat').all()) {
    const b = await st.boundingBox();
    expect(b!.y + b!.height).toBeLessThanOrEqual(actions!.y + 1);
  }
  await go.ctx.close();
  // online 800×450: the join error and the switch-mode retry sit inside the panel
  const on = await open('screen=online', 800, 450);
  await on.page.locator('.sg-code-input').fill('FAIL0');
  await on.page.locator('.join-row .sg-btn').click();
  await expect(on.page.locator('.sg-online-status .switch-mode')).toBeVisible({ timeout: 15_000 });
  const sheet = await on.page.locator('.sg-online .sg-sheet').boundingBox();
  const retry = await on.page.locator('.sg-online-status .switch-mode').boundingBox();
  expect(retry!.y + retry!.height).toBeLessThanOrEqual(sheet!.y + sheet!.height - 8);
  await on.ctx.close();
  // lobby 1280×720, 乱世 8 players: every variant's seals on one line; a guest at 800×450 sees 身份分配 without scrolling
  const lb = await open('screen=lobby', 1280, 720);
  await expect(lb.page.locator('[data-screen="lobby"] .settings-panel')).toBeVisible({ timeout: 15_000 });
  for (const n of [6, 8]) {
    await lb.page.evaluate((c) => (window as unknown as { __ui: { deps: { lastSession: { updateSettings(p: object): void } } } }).__ui.deps.lastSession.updateSettings({ mode: 'chaos', playerCount: c }), n);
    await expect(lb.page.locator('.settings-panel .sg-role-preview .variant').first().locator('.cell')).toHaveCount(n);
    const tops = await lb.page.evaluate(() => [...document.querySelectorAll('.settings-panel .sg-role-preview .variant')].map((v) => new Set([...v.querySelectorAll('.cell')].map((c) => Math.round(c.getBoundingClientRect().top))).size));
    expect(tops.every((k) => k === 1), `chaos ${n}: ${tops}`).toBe(true);
  }
  await lb.ctx.close();
  const gs = await open('screen=lobby&host=0', 800, 450);
  await expect(gs.page.locator('[data-screen="lobby"]')).toBeVisible({ timeout: 15_000 });
  await gs.page.evaluate(() => (window as unknown as { __ui: { deps: { lastSession: { updateSettings(p: object): void } } } }).__ui.deps.lastSession.updateSettings({ mode: 'chaos', playerCount: 8 }));
  await gs.page.locator('.lobby-tabs .lt[data-tab="settings"]').click();
  const panel = await gs.page.locator('.settings-panel').boundingBox();
  const preview = await gs.page.locator('.settings-panel .sg-role-preview').boundingBox();
  expect(preview!.y + preview!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
  await gs.ctx.close();
  // the claim wheel at 640×360: its hint is not drawn over the (hidden) item bar
  const wh = await open('screen=hud&overlay=wheel', 640, 360);
  await expect(wh.page.locator('.sg-hud[data-overlay="wheel"] .wh-hint')).toBeVisible({ timeout: 15_000 });
  await expect(wh.page.locator('.hud-abilities')).toHaveCSS('visibility', 'hidden');
  await wh.ctx.close();
  // loading 640×360: the hero card is not cut at the top
  const ld = await open('screen=loading', 640, 360);
  await expect(ld.page.locator('.load-card .sg-hcard')).toBeVisible({ timeout: 15_000 });
  const card = await ld.page.locator('.load-card').boundingBox();
  expect(card!.y).toBeGreaterThanOrEqual(0);
  expect(card!.y + card!.height).toBeLessThanOrEqual(360);
  await ld.ctx.close();
});

test('PLATFORM-5/6/9/10 phones: touch labels, emblem captions, card captions, the guide off the controls, chat, roles / lobby / select fit', async () => {
  for (const [w, hgt, lang] of [[844, 390, 'zh'], [667, 375, 'en'], [640, 360, 'zh'], [1024, 768, 'zh']] as const) {
    const at = `${w}×${hgt} ${lang}`;
    const { ctx, page, errors } = await open(`screen=hud&touch=1&lang=${lang}`, w, hgt);
    await expect(page.locator('.sg-touch .fire')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      (window as unknown as MockInternals).__ui.deps.lastSession.view.me.items = ['tao', 'jiu', 'sha', 'shan'].map((id) => ({ id, count: 1 }));
    });
    // PLATFORM-5: 装弹 / 切枪, and the interact button never reads a Latin F
    await expect(page.locator('.sg-touch .reload .l')).toHaveText(lang === 'en' ? 'Reload' : '装弹');
    await expect(page.locator('.sg-touch .swap .l')).toHaveText(lang === 'en' ? 'Swap' : '切枪');
    expect(await page.locator('.sg-touch .interact .l').textContent(), at).not.toBe('F');
    // PLATFORM-10: the whole guide shows (touches pass through it: it cannot scroll) and covers no control
    const guide = page.locator('.hud-guide');
    await expect(guide).toBeVisible();
    await expect.poll(() => guide.evaluate((el) => el.scrollHeight - el.clientHeight), { message: `${at} guide clipped` }).toBeLessThanOrEqual(1);
    const g = await guide.boundingBox();
    const controls = await page.locator('.sg-touch .tbtn:not(.sg-hidden), .sg-touch .stick-base, .hud-touchbar .tb, .hud-weapon .w-main, .hud-minimap, .hud-vitals, .hud-topcenter').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { cls: e.className, x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    for (const c of controls) expect(overlaps(g, c), `${at}: guide over ${c.cls}`).toBe(false);
    // never into the stick zone (the left 42 % — 36 % as the last resort); right of the crosshair when there is room
    expect(g!.x, at).toBeGreaterThanOrEqual(w * 0.36 - 1);
    if (w >= 844) expect(g!.x, at).toBeGreaterThan(w / 2);
    // the weapon panel keeps clear of the zone banner
    expect(overlaps(await page.locator('.hud-weapon .w-main').boundingBox(), await page.locator('.hud-zone').boundingBox()), `${at} weapon / zone`).toBe(false);
    // PLATFORM-6: painted emblems keep the skill's name and a ≥ 10 px key letter; card captions ≥ 10 px, 桃 / 酒 / 杀 / 闪 too
    await expect(page.locator('.sg-touch .ab-q.art-on')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.sg-touch .item.art-on')).toHaveCount(4, { timeout: 15_000 });
    const readLabels = () =>
      page.locator('.sg-touch :is(.ab-q, .ab-e), .sg-touch .item').evaluateAll((els) =>
        els.map((b) => {
          const l = b.querySelector<HTMLElement>(':scope > .l, :scope > .n')!;
          const k = b.querySelector<HTMLElement>(':scope > .k')!;
          const cs = getComputedStyle(l);
          return { cls: b.className, text: l.textContent ?? '', shown: cs.visibility === 'visible' && cs.display !== 'none' && l.getBoundingClientRect().height > 0, fs: parseFloat(cs.fontSize), kfs: parseFloat(getComputedStyle(k).fontSize) };
        }),
      );
    // (reduced motion gives every style change a 1 ms transition: read once the art-on sizes have settled)
    const problems = async (): Promise<string[]> =>
      (await readLabels()).flatMap((l) => [
        ...(l.shown && l.text.length > 0 ? [] : [`${l.cls}: "${l.text}" hidden`]),
        ...(l.fs >= 10 ? [] : [`${l.cls}: ${l.fs}px`]),
        ...(!/\bab\b/.test(l.cls) || l.kfs >= 10 ? [] : [`${l.cls} key: ${l.kfs}px`]),
      ]);
    await expect.poll(problems, { message: at }).toEqual([]);
    const labels = await readLabels();
    expect(labels).toHaveLength(6);
    if (lang === 'zh') expect(labels.slice(2).map((l) => l.text)).toEqual(['桃', '酒', '杀', '闪']);
    await guide.locator('.gd-x').click();
    await expect(guide).toHaveCount(0);
    expect(errors, at).toEqual([]);
    await ctx.close();
  }

  // PLATFORM-9 (d) chat overlay: the oldest line can be scrolled back to below 令聊图战; the input is opaque
  const ch = await open('screen=hud&touch=1', 844, 390);
  await expect(ch.page.locator('.sg-touch .fire')).toBeVisible({ timeout: 15_000 });
  await ch.page.evaluate(() => {
    const v = (window as unknown as MockInternals).__ui.deps.lastSession.view;
    for (let i = 0; i < 8; i++) v.emit({ t: 'chat', from: `人机${i + 2}`, text: `第 ${i + 1} 句：我是忠臣！` });
  });
  await ch.page.locator('.hud-touchbar .tb[data-key="chat"]').click();
  await expect(ch.page.locator('.hud-chat.open')).toHaveCount(1);
  const chat = await ch.page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('.hud-chat .log')!;
    log.scrollTop = 0;
    const first = log.querySelector('.line')!.getBoundingClientRect();
    const bar = document.querySelector('.hud-touchbar')!.getBoundingClientRect();
    const bg = getComputedStyle(document.querySelector('.hud-chat .sg-input')!).backgroundColor;
    return { firstTop: first.top, barBottom: bar.bottom, alpha: Number(/rgba?\(([^)]+)\)/.exec(bg)![1].split(',')[3] ?? 1) };
  });
  expect(chat.firstTop).toBeGreaterThanOrEqual(chat.barBottom);
  expect(chat.alpha).toBeGreaterThanOrEqual(0.9);
  await ch.ctx.close();

  // (a) roles: every seat chip and the tip inside the screen
  const ro = await open('screen=roles&single=1', 844, 390);
  await expect(ro.page.locator('.seat-chip').first()).toBeVisible({ timeout: 15_000 });
  for (const el of await ro.page.locator('.seat-chip, .roles-tip').all()) {
    const b = await el.boundingBox();
    expect(b!.y + b!.height, 'roles').toBeLessThanOrEqual(390);
  }
  await ro.ctx.close();
  // (b) lobby: ＋ 添加AI in the seats heading, nothing scrolled out of the panel
  const lb = await open('screen=lobby', 844, 390);
  const add = lb.page.locator('.seats-panel .seat-tools .sg-btn');
  await expect(add).toBeVisible({ timeout: 15_000 });
  const panel = await lb.page.locator('.seats-panel').boundingBox();
  const addBox = await add.boundingBox();
  expect(addBox!.y + addBox!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
  await lb.ctx.close();
  // (e) hero select: every seat's name in full (「AI·孙仲谋」, not 「A…」)
  const hs = await open('screen=heroSelect', 844, 390);
  await expect(hs.page.locator('.pick .who .nm').first()).toBeVisible({ timeout: 15_000 });
  const cut = await hs.page.locator('.pick .who .nm').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(cut).toEqual([]);
  await hs.ctx.close();
  // (f) portrait select: 选定 sits on an opaque bar (the 专属武器 stats no longer show through a fade)
  // (a guest's link chip / loading line: see the MP2-1 / MP2-2 test below)
  const ps = await open('screen=heroSelect', 390, 844);
  await expect(ps.page.locator('.detail-actions')).toBeVisible({ timeout: 15_000 });
  expect(await ps.page.locator('.detail-actions').evaluate((e) => getComputedStyle(e).backgroundColor)).toMatch(/^rgb\(/);
  await ps.ctx.close();
});

type LinkMock = { __ui: { deps: { lastSession: { hostSilentMs: number; calls: string[]; status(zh: string, en: string, extra?: { key?: string; clear?: boolean }): void } } } };

test('MP2-1 / MP2-2 guest link: the chip counts a silent host, offers 重试 / 离开, loading waits for the host', async () => {
  // a phone (the chip sits above the touch look zone: its buttons take the tap) and a desktop window
  for (const [w, hgt, touch] of [[844, 390, true], [1280, 720, false]] as const) {
    const { ctx, page, errors } = await open(`screen=hud&kind=online${touch ? '&touch=1' : ''}`, w, hgt);
    await expect(page.locator('.hud-top .role-chip')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      const s = (window as unknown as LinkMock).__ui.deps.lastSession;
      s.hostSilentMs = 12_400;
      s.status('等待主机响应…', 'Waiting for host…', { key: 'waitingHost' });
    });
    const chip = page.locator('.link-chip');
    await expect(chip.locator('.lk-text')).toHaveText('⚠ 等待房主响应… 12 秒');
    await expect(chip.locator('.lk-btn')).toHaveText(['离开']);
    await page.evaluate(() => {
      (window as unknown as LinkMock).__ui.deps.lastSession.hostSilentMs = 15_000;
    });
    await expect(chip.locator('.lk-text')).toHaveText('⚠ 等待房主响应… 15 秒');
    await page.evaluate(() => {
      const s = (window as unknown as LinkMock).__ui.deps.lastSession;
      s.status('连接中断，正在重新连接…', 'Connection lost — reconnecting…');
      s.status('暂时联系不上房主，正在重试…', 'Connection lost — cannot reach the host, retrying…', { key: 'hostUnreachable' });
    });
    await expect(chip.locator('.lk-text')).toHaveText('⚠ 暂时联系不上房主，正在重试…');
    await expect(chip.locator('.lk-btn')).toHaveText(['重试', '离开']);
    await chip.locator('.lk-btn.retry').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as LinkMock).__ui.deps.lastSession.calls.filter((c) => c === 'retryNow').length)).toBe(1);
    // 离开 asks first (the pause menu's own confirmation)
    await chip.locator('.lk-btn.leave').click();
    await expect(page.locator('.sg-modal-back')).toBeVisible();
    await page.locator('.sg-modal-back .sg-btn').first().click();
    // back: the green chip, no buttons
    await page.evaluate(() => (window as unknown as LinkMock).__ui.deps.lastSession.status('已重新连接', 'Reconnected', { key: 'hostUnreachable', clear: true }));
    await expect(chip).toHaveAttribute('data-tone', 'ok');
    await expect(chip.locator('.lk-btn')).toHaveCount(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }
  // loading: the view is ready but the host's clock has not started → 等待房主加载…, not 开战！
  const ld = await open('screen=loading&awaitHost=1', 1280, 720);
  await expect(ld.page.locator('.load-stage')).toHaveText('等待房主加载…', { timeout: 15_000 });
  await ld.page.evaluate(() => {
    (window as unknown as { __ui: { deps: { lastSession: { awaitingHostStart: boolean } } } }).__ui.deps.lastSession.awaitingHostStart = false;
  });
  await expect(ld.page.locator('.load-stage')).toHaveText('开战！ 100%');
  await ld.ctx.close();
});

type ApplyingMock = { __ui: { deps: { lastGame: { simulateQualityApplying(on: boolean): void }; lastSession: { calls: string[]; paused: boolean } } } };

test('PLATFORM-4 a mid-match quality switch: 「应用中…」 over the HUD and in 设置, single player stays paused until it has applied', async () => {
  const { ctx, page, errors } = await open('screen=hud&overlay=pause');
  await expect(page.locator('.sg-hud[data-overlay="pause"]')).toHaveCount(1, { timeout: 15_000 });
  const applying = (on: boolean): Promise<void> => page.evaluate((v) => (window as unknown as ApplyingMock).__ui.deps.lastGame.simulateQualityApplying(v), on);
  const resumeBtn = page.locator('.pm-box .sg-btn').first();
  await expect(page.locator('.hud-applying')).toBeHidden();
  await applying(true);
  await expect(page.locator('.hud-applying')).toHaveText('应用中…');
  await expect(resumeBtn).toHaveText('应用中…');
  await expect(resumeBtn).toBeDisabled();
  // 继续 / Esc cannot leave the menu meanwhile: the sim stays paused
  await resumeBtn.click({ force: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.sg-hud[data-overlay="pause"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as ApplyingMock).__ui.deps.lastSession.paused)).toBe(true);
  // 设置 shows the badge too (its heading), and it goes with the switch
  await page.locator('.pm-box .sg-btn').nth(1).click();
  await expect(page.locator('.sg-settings .set-applying')).toBeVisible();
  await applying(false);
  await expect(page.locator('.sg-settings .set-applying')).toBeHidden();
  await expect(page.locator('.hud-applying')).toBeHidden();
  await page.locator('.sg-settings .set-foot .sg-btn.gold').click();
  await expect(resumeBtn).toBeEnabled();
  await expect(resumeBtn).toHaveText('继续战斗');
  await resumeBtn.click();
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as ApplyingMock).__ui.deps.lastSession.paused)).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();
});
