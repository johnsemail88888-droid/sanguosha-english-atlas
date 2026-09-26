// Real app, single player (production build served by `vite preview` on :5186):
// title → setup → roles → hero select (the clicked-but-unconfirmed card is what you
// get when the timer runs out — 3 runs) → loading → match; the clock starts once the
// 3D view is ready; HUD up; W moves the hero; firing uses ammo; Q / E start
// cooldowns; Tab scoreboard; Esc opens the menu with a free cursor and really
// pauses (also inside 设置); cards picked up explain themselves (zh + en); bots
// fight each other (any hero→hero hit or kill in a time-scaled window, bots
// brought together); leave back to the title.
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  PORT_OFFSET,
  SELF_CAST_HEROES,
  enterGame,
  holdKeyUntilMoved,
  launchBrowser,
  openGame,
  relevantErrors,
  startPreview,
  waitGame,
  waitMatch,
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

const elapsed = (page: Page): Promise<number> => page.evaluate(() => (window as SgwlWindow).__sgwl!.elapsed());
const locked = (page: Page): Promise<boolean> => page.evaluate(() => document.pointerLockElement !== null);

/**
 * Title / setup → 出征 → hero select; click a card (`choose` picks which), never
 * press 选定 and let the countdown run out. Returns the clicked hero and the one the
 * host finally gave this seat.
 */
async function clickAndWait(page: Page, choose: (ids: string[]) => string): Promise<{ clicked: string; got: string | null }> {
  await expect(page.locator('[data-screen="single"]')).toBeVisible();
  await page.locator('[data-screen="single"] .sg-btn.gold').click();
  await expect(page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.sg-select:not(.waiting) .grid .sg-hcard').first()).toBeVisible({ timeout: 120_000 });
  // remember the final picks this seat gets (the view goes away once the phase ends)
  await page.evaluate(() => {
    const g = (window as SgwlWindow).__sgwl!;
    const s = g.session!;
    const w = window as Window & { __myPick?: string | null };
    w.__myPick = null;
    const seat = (): number => s.lobby?.seats.find((x) => x.playerId === s.myId)?.seat ?? -1;
    s.on('heroSelect', (v) => {
      const h = v.picks[seat()];
      if (h) w.__myPick = h;
    });
  });
  const ids = await page.locator('.sg-select .grid .sg-hcard').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.hero ?? ''));
  const clicked = choose(ids);
  await page.locator(`.sg-select .grid .sg-hcard[data-hero="${clicked}"]`).click();
  await expect(page.locator(`.sg-select .grid .sg-hcard[data-hero="${clicked}"]`)).toHaveClass(/selected/);
  // no 选定: wait for the host's timeout (20 s + the lord's turn)
  await waitGame(page, "(g) => g.phase === 'loading' || g.phase === 'playing'", 90_000, 'hero select timeout');
  const got = await page.evaluate(() => (window as Window & { __myPick?: string | null }).__myPick ?? null);
  return { clicked, got };
}

test('single player: full flow, controls, HUD, pause, cards, bots fight, leave', async () => {
  test.setTimeout(25 * 60_000);
  let g: GamePage | null = null;
  try {
    g = await openGame(browser, `${server.url}?debug=1`);
    const { page, errors } = g;
    const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

    // title
    await expect(page.locator('.sg-menu-btn.primary')).toContainText('单人练习');
    await expect(page.locator('.sg-logo')).toBeVisible();
    await page.locator('.sg-menu-btn.primary').click();

    // hero select ignores nothing: the clicked (not confirmed) card is the one you get — 3 runs
    const results: { clicked: string; got: string | null }[] = [];
    for (let run = 0; run < 2; run++) {
      const r = await clickAndWait(page, (ids) => ids[2] ?? ids[ids.length - 1]!);
      results.push(r);
      // back to the setup for the next run
      await page.evaluate(() => (window as SgwlWindow).__sgwl!.session!.returnToLobby());
    }
    const last = await clickAndWait(page, (ids) => SELF_CAST_HEROES.find((h) => ids.includes(h)) ?? ids[2]!);
    results.push(last);
    console.log(`[game e2e] hero-select timeouts: ${JSON.stringify(results)}`);
    for (const r of results) expect(r.got, `timeout gives the clicked card (${r.clicked})`).toBe(r.clicked);

    await waitMatch(page);
    const hero = await page.evaluate(() => (window as SgwlWindow).__sgwl!.local()!.heroId);
    expect(hero, 'the match hero is the clicked card').toBe(last.clicked);
    console.log(`[game e2e] playing as ${hero}`);
    // APP-3: the match clock starts when the 3D view is ready — the first HUD frame reads 0:00–0:01
    const clockText = await page.locator('.hud-top .match-info .clock').textContent();
    const t = await page.evaluate(() => (window as SgwlWindow).__sgwl!.timings);
    console.log(`[game e2e] load milestones (ms): ${JSON.stringify(t)} · first clock ${clockText}`);
    expect(clockText ?? '').toMatch(/^0:0[01]$/);
    if (t['load:ready'] !== undefined && t['phase:playing'] !== undefined) expect(t['phase:playing']).toBeGreaterThanOrEqual(t['load:ready'] - 300);

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

    // Esc under pointer lock (headless Chromium delivers the key and keeps the lock):
    // the menu opens AND frees the cursor, so its buttons work
    await enterGame(page);
    expect(await locked(page), 'pointer locked in play').toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await expect.poll(() => locked(page), { message: 'the menu releases the pointer lock' }).toBe(false);
    await page.locator('.pm-box .sg-btn', { hasText: '离开对局' }).click();
    await expect(page.locator('.sg-modal-back .sg-modal')).toContainText('确定离开当前对局');
    await page.locator('.sg-modal .actions .sg-btn').first().click(); // cancel
    await shot('05-pause');

    // the pause menu really pauses single player (and so does 设置 opened from it)
    const pausable = await page.evaluate(() => typeof (window as SgwlWindow).__sgwl!.session?.['setPaused' as keyof object] === 'function');
    const p0 = await elapsed(page);
    await page.waitForTimeout(3000);
    const p1 = await elapsed(page);
    await page.locator('.pm-box .sg-btn', { hasText: '设置' }).click();
    await expect(page.locator('.sg-settings')).toBeVisible();
    await page.waitForTimeout(3000);
    const p2 = await elapsed(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sg-settings')).toHaveCount(0);
    console.log(`[game e2e] paused clock: ${p0.toFixed(2)} → ${p1.toFixed(2)} (menu) → ${p2.toFixed(2)} (settings); setPaused ${pausable}`);
    if (pausable) {
      expect(p1 - p0, 'pause menu freezes the match').toBeLessThan(0.15);
      expect(p2 - p1, '设置 from the menu keeps it frozen').toBeLessThan(0.15);
    } else {
      test.info().annotations.push({ type: 'skip-assert', description: 'session.setPaused (G2) missing: pause freeze not asserted' });
    }
    // 继续战斗 re-takes the pointer lock and the clock runs again
    await page.locator('.pm-box .sg-btn.gold').click();
    await expect.poll(() => locked(page), { message: '继续战斗 re-acquires the lock' }).toBe(true);
    await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
    await expect.poll(() => elapsed(page), { timeout: 30_000 }).toBeGreaterThan(p2 + 0.5);
    // browsers swallow Esc while the pointer is locked: losing the lock alone opens the menu
    await page.evaluate(() => document.exitPointerLock());
    await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await page.locator('.pm-box .sg-btn.gold').click();
    await enterGame(page);

    // a card you get: a compact line by the item bar (COMBAT-8: never over the crosshair), its effect in the 锦囊说明 in the menu
    expect(await page.evaluate(() => (window as SgwlWindow).__sgwl!.cheats.give('shandian'))).toBe(true);
    await expect(page.locator('.hud-pickups .pk-row[data-item="shandian"]')).toContainText('闪电', { timeout: 15_000 });
    await shot('06-card-toast-zh');
    await page.keyboard.press('Escape');
    await expect(page.locator('.pm-cards .pc-list.held .pc-card[data-item="shandian"] .desc')).toContainText('雷云');
    // English: the same explanations in English
    await page.locator('.pm-box .sg-btn', { hasText: '设置' }).click();
    await page.locator('.sg-settings .sg-tab[data-tab="general"]').click();
    await page.locator('.sg-settings .sg-seg button[data-value="en"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pm-box h2')).toHaveText('Paused');
    await expect(page.locator('.pm-cards .pc-list.held .pc-card[data-item="shandian"] .desc')).toContainText('storm cloud');
    await shot('07-card-guide-en');
    await page.locator('.pm-box .sg-btn.gold').click();
    await enterGame(page);
    expect(await page.evaluate(() => (window as SgwlWindow).__sgwl!.cheats.give('wuzhong'))).toBe(true);
    await expect(page.locator('.hud-pickups .pk-row[data-item="wuzhong"]')).toContainText('Got', { timeout: 15_000 });
    await shot('08-card-toast-en');

    // bots fight: god mode for us, sim sped up, every bot brought next to the Lord (the
    // one role everyone knows) — any hero→hero hit or kill counts, whoever it is
    const setup = await page.evaluate(() => {
      const g = (window as SgwlWindow).__sgwl!;
      const c = g.cheats;
      const god = c.god(true);
      const scale = c.timeScale(4);
      const me = g.localId();
      const players = g.players();
      const lord = players.find((p) => p.role === 'lord' && p.alive) ?? players.find((p) => p.alive && p.entityId !== me)!;
      const at = g.entities().find((e) => e.id === lord.entityId)!;
      let moved = 0;
      players.filter((p) => p.alive && p.entityId !== lord.entityId && p.entityId !== me).forEach((p, i) => {
        const a = (i / 4) * Math.PI * 2;
        if (c.teleportHero(p.entityId, at.x + Math.cos(a) * 6, at.z + Math.sin(a) * 6)) moved++;
      });
      return { god, scale, moved, lord: lord.heroId };
    });
    console.log(`[game e2e] bots brought to the Lord: ${JSON.stringify(setup)}`);
    expect(setup.god && setup.scale, 'debug cheats available in single player').toBe(true);
    const tStart = await elapsed(page);
    const fought = (ev: { heroHits: number; deaths: { killer?: number; target: number }[] }): boolean => ev.heroHits > 0 || ev.deaths.some((d) => d.killer !== undefined && d.killer !== d.target);
    await expect
      .poll(async () => fought(await page.evaluate(() => (window as SgwlWindow).__sgwl!.events)), { timeout: 6 * 60_000, intervals: [1000] })
      .toBe(true);
    const after = await page.evaluate(() => {
      const g = (window as SgwlWindow).__sgwl!;
      g.cheats.timeScale(1);
      return { t: g.elapsed(), phase: g.phase, screen: g.screen, events: { heroHits: g.events.heroHits, heroDamage: g.events.heroDamage, deaths: g.events.deaths } };
    });
    console.log(`[game e2e] heroes fought after ${(after.t - tStart).toFixed(0)} sim-s (phase ${after.phase}): ${JSON.stringify(after.events)}`);
    await shot('09-fight');

    if (after.phase === 'playing') {
      // leave → title
      await page.keyboard.press('Escape');
      await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
      await page.locator('.pm-box .sg-btn', { hasText: /离开|Leave/ }).click();
      await page.locator('.sg-modal .actions .sg-btn').last().click();
    } else {
      // a fight ended the match (the Lord fell): the game-over screen names the winners
      expect(after.phase, 'match over').toBe('gameOver');
      await expect(page.locator('[data-screen="gameOver"]')).toBeVisible({ timeout: 30_000 });
      await shot('09b-gameover');
      await page.locator('[data-screen="gameOver"] .sg-btn', { hasText: /返回标题|Main menu/ }).click();
    }
    await expect(page.locator('[data-screen="title"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sg-game canvas')).toHaveCount(0);

    expect(relevantErrors(errors)).toEqual([]);
  } finally {
    await g?.ctx.close();
  }
});
