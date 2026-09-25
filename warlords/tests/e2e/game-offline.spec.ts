// `npm run build:single` output (one self-contained HTML file) opened from
// file:// — no server at all: reaches the title and starts a single-player match.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Browser } from '@playwright/test';
import { DIST_SINGLE, ensureBuilt, enterGame, holdKeyUntilMoved, launchBrowser, openGame, playSingle, relevantErrors, type GamePage } from './fixtures/game-fixture';
import { readdirSync } from 'node:fs';

let browser: Browser;

test.beforeAll(async () => {
  ensureBuilt('single');
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
});

test('single-file build runs from file:// (title → single-player match)', async () => {
  test.setTimeout(10 * 60_000);
  // one file only: everything (scripts, styles, icon) is inlined
  const files = readdirSync(DIST_SINGLE).filter((f) => !f.startsWith('.'));
  expect(files.filter((f) => f.endsWith('.js') || f.endsWith('.css'))).toEqual([]);
  const url = `${pathToFileURL(path.join(DIST_SINGLE, 'index.html')).href}?debug=1`;
  let g: GamePage | null = null;
  try {
    g = await openGame(browser, url);
    const { page, errors } = g;
    await expect(page.locator('.sg-menu-btn.primary')).toContainText('单人练习', { timeout: 60_000 });
    await page.screenshot({ path: test.info().outputPath('title.png') });
    await playSingle(page, { players: 5 });
    await enterGame(page);
    expect(await holdKeyUntilMoved(page, 'w', 1)).toBeGreaterThan(1);
    await page.screenshot({ path: test.info().outputPath('match.png') });
    expect(relevantErrors(errors)).toEqual([]);
  } finally {
    await g?.ctx.close();
  }
});
