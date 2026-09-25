// Real app, single player (production build served by `vite preview` on :5186):
// title → setup → roles → hero select → loading → match; HUD up; W moves the
// hero; firing uses ammo; Q / E start cooldowns; Tab scoreboard; Esc pause (and
// losing the pointer lock pauses too); bots fight each other (a hero death within a
// few sim-minutes, sped up with the debug time scale — shown in the kill feed, or,
// when the Lord fell first, on the game-over screen); leave back to the title.
import { expect, test, type Browser } from '@playwright/test';
import {
  PORT_OFFSET,
  SELF_CAST_HEROES,
  enterGame,
  holdKeyUntilMoved,
  launchBrowser,
  openGame,
  playSingle,
  relevantErrors,
  startPreview,
  type GamePage,
  type Server,
  type SgwlWindow,
} from './fixtures/game-fixture';

const PORT = 5186 + PORT_OFFSET;
let server: Server;
let browser: Browser;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  server = await startPreview(PORT);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test('single player: full flow, controls, HUD, bots fight, leave', async () => {
  test.setTimeout(15 * 60_000);
  let g: GamePage | null = null;
  try {
    g = await openGame(browser, `${server.url}?debug=1`);
    const { page, errors } = g;
    const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

    // title
    await expect(page.locator('.sg-menu-btn.primary')).toContainText('单人练习');
    await expect(page.locator('.sg-logo')).toBeVisible();

    const hero = await playSingle(page, { players: 5, prefer: SELF_CAST_HEROES });
    console.log(`[game e2e] playing as ${hero}`);
    const t = await page.evaluate(() => (window as SgwlWindow).__sgwl!.timings);
    console.log(`[game e2e] load milestones (ms): ${JSON.stringify(t)}`);

    // HUD
    await expect(page.locator('.hud-minimap canvas')).toBeVisible();
    await expect(page.locator('.hud-abilities .ab').first()).toBeVisible();
    await expect(page.locator('.hud-weapon')).toBeVisible();
    const canvas = page.locator('.sg-game canvas');
    await expect(canvas).toBeVisible();
    await enterGame(page);
    await shot('01-spawn');

    // W moves the hero
    const moved = await holdKeyUntilMoved(page, 'w', 1.5);
    expect(moved, 'hero moved forward with W').toBeGreaterThan(1.5);

    // firing reduces ammo (primary; a few frames per second in SwiftShader → poll)
    const ammo = () =>
      page.evaluate(() => {
        const l = (window as SgwlWindow).__sgwl!.local()!;
        const w = l.weapons[l.activeSlot]!;
        return { id: w.id, mag: w.mag, reserve: w.reserve };
      });
    const a0 = await ammo();
    await page.mouse.down();
    let a1 = a0;
    for (let i = 0; i < 60 && a1.mag >= a0.mag && a1.reserve >= a0.reserve; i++) {
      await page.waitForTimeout(250);
      a1 = await ammo();
    }
    await page.mouse.up();
    expect(a1.mag < a0.mag || a1.reserve < a0.reserve, `firing ${a0.id} used ammo (${JSON.stringify(a0)} → ${JSON.stringify(a1)})`).toBe(true);
    await shot('02-fire');

    // Q and E start their cooldowns (the HUD ability icon dims with a sweep)
    for (const key of ['q', 'e']) {
      const ab = page.locator(`.hud-abilities .ab.slot-${key}`);
      await expect(ab).toHaveCount(1);
      await page.keyboard.press(key);
      await expect(ab, `${key.toUpperCase()} cooldown started`).toHaveClass(/cooling|recharging/, { timeout: 30_000 });
    }
    await shot('03-abilities');

    // every registered VFX (4 kingdom ability modules, item cards, explosion kinds) renders without errors
    const vfxCount = await page.evaluate(() => (window as SgwlWindow).__sgwl!.vfxSmoke(8));
    expect(vfxCount).toBeGreaterThan(90);
    await shot('03b-vfx');
    expect(relevantErrors(errors), 'VFX smoke').toEqual([]);

    // Tab = scoreboard while held
    await page.keyboard.down('Tab');
    await expect(page.locator('.sg-hud.show-score .hud-scoreboard')).toBeVisible();
    await expect(page.locator('.hud-scoreboard tbody tr, .hud-scoreboard .row').first()).toBeVisible();
    await shot('04-scoreboard');
    await page.keyboard.up('Tab');
    await expect(page.locator('.sg-hud.show-score')).toHaveCount(0);

    // Esc = pause menu. A real browser also drops the pointer lock on Esc (headless
    // Chromium does not): release it like the browser would, so the cursor is free.
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.exitPointerLock());
    await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await shot('05-pause');
    await page.locator('.pm-box .sg-btn.gold').click();
    await enterGame(page);
    // browsers swallow Esc while the pointer is locked: losing the lock alone must pause
    await page.evaluate(() => document.exitPointerLock());
    await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await page.locator('.pm-box .sg-btn.gold').click();
    await enterGame(page);

    // bots fight: god mode for us, sim sped up; wait for a hero death in the sim
    // (__sgwl.events.deaths). Which bot dies first is random: if it is the Lord the
    // match ends at once and the HUD (with its kill feed) gives way to the game-over
    // screen, so the DOM kill feed is checked only while the match is still on —
    // through a MutationObserver, as entries expire after 7 sim-seconds (≈1 s at 6×).
    await page.evaluate(() => {
      const w = window as SgwlWindow & { __kfSeen?: string[] };
      w.__kfSeen = [];
      const feed = document.querySelector('.hud-feed');
      if (!feed) return;
      new MutationObserver((muts) => {
        for (const m of muts)
          for (const n of m.addedNodes)
            if (n instanceof HTMLElement && n.matches('.kf:not(.claim)')) w.__kfSeen!.push(n.textContent ?? '');
      }).observe(feed, { childList: true, subtree: true });
    });
    const cheats = await page.evaluate(() => {
      const c = (window as SgwlWindow).__sgwl!.cheats;
      return { god: c.god(true), scale: c.timeScale(6) };
    });
    expect(cheats.god && cheats.scale, 'debug cheats available in single player').toBe(true);
    const tStart = await page.evaluate(() => (window as SgwlWindow).__sgwl!.elapsed());
    await expect
      .poll(() => page.evaluate(() => (window as SgwlWindow).__sgwl!.events.deaths.length), { timeout: 8 * 60_000, intervals: [1000] })
      .toBeGreaterThan(0);
    const after = await page.evaluate(() => {
      const g = (window as SgwlWindow).__sgwl!;
      g.cheats.timeScale(1);
      return { t: g.elapsed(), phase: g.phase, screen: g.screen, events: g.events, kf: (window as unknown as { __kfSeen: string[] }).__kfSeen };
    });
    console.log(`[game e2e] first hero death after ${(after.t - tStart).toFixed(0)} sim-s (phase ${after.phase}): ${JSON.stringify(after.events.deaths)}`);
    // …and the heroes really fought each other (not only zone deaths)
    const fought = (ev: typeof after.events): boolean => ev.heroHits > 0 || ev.deaths.some((d) => d.killer !== undefined && d.killer !== d.target);
    if (after.phase === 'playing') {
      await expect.poll(() => page.evaluate(() => (window as unknown as { __kfSeen: string[] }).__kfSeen.length), { timeout: 30_000 }).toBeGreaterThan(0);
      await shot('06-killfeed');
      await expect
        .poll(async () => fought(await page.evaluate(() => (window as SgwlWindow).__sgwl!.events)), { timeout: 5 * 60_000, intervals: [2000] })
        .toBe(true);

      // leave → title
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.exitPointerLock());
      await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
      await page.locator('.pm-box .sg-btn', { hasText: /离开|Leave/ }).click();
      await page.locator('.sg-modal .actions .sg-btn').last().click();
    } else {
      // the first death ended the match (the Lord fell): the game-over screen names the winners
      expect(after.phase, 'match over').toBe('gameOver');
      expect(fought(after.events), 'the Lord fell in a fight').toBe(true);
      await expect(page.locator('[data-screen="gameOver"]')).toBeVisible({ timeout: 30_000 });
      await shot('06-gameover');
      await page.locator('[data-screen="gameOver"] .sg-btn', { hasText: /返回标题|Main menu/ }).click();
    }
    await expect(page.locator('[data-screen="title"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sg-game canvas')).toHaveCount(0);

    expect(relevantErrors(errors)).toEqual([]);
  } finally {
    await g?.ctx.close();
  }
});
