// Real app on a landscape phone (844×390, touch emulation): single-player match
// with the touch HUD — virtual stick moves the hero, fire button shoots, no
// pointer-lock "click to play" prompt.
import { expect, test, type Browser } from '@playwright/test';
import { PORT_OFFSET, launchBrowser, localPos, openGame, playSingle, relevantErrors, startPreview, type GamePage, type Server, type SgwlWindow } from './fixtures/game-fixture';

const PORT = 5187 + PORT_OFFSET;
let server: Server;
let browser: Browser;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startPreview(PORT);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test('phone 844×390 with touch: touch controls in the HUD drive the hero', async () => {
  test.setTimeout(10 * 60_000);
  let g: GamePage | null = null;
  try {
    g = await openGame(browser, `${server.url}?debug=1`, { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const { page, errors } = g;
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await playSingle(page, { players: 5 });

    // touch HUD: stick zone, fire / aim / jump / abilities, touch bar; no "click to play" prompt
    await expect(page.locator('.sg-hud.touch')).toHaveCount(1);
    for (const sel of ['.sg-touch .zone.move', '.sg-touch .fire', '.sg-touch .ads', '.sg-touch .jump', '.sg-touch .reload', '.hud-touchbar .tb']) {
      await expect(page.locator(sel).first(), sel).toBeVisible();
    }
    await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1);
    await expect(page.locator('.click-prompt')).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('touch-hud.png') });

    // push the virtual stick forward until the hero moved
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
    expect(moved, 'virtual stick moved the hero').toBeGreaterThan(1.5);

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
    expect(relevantErrors(errors)).toEqual([]);
  } finally {
    await g?.ctx.close();
  }
});
