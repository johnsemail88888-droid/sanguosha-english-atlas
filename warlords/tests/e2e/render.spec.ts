// Renderer e2e (swiftshader): loads the render dev harness, checks for console
// errors, a non-blank canvas and sane draw-call counts. Self-contained: starts
// its own Vite dev server on :5181 unless one is already listening there.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.RENDER_E2E_PORT ?? 5181);
const BASE = `http://localhost:${PORT}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROMIUM = '/opt/pw-browsers/chromium';

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
});
test.describe.configure({ mode: 'serial' });

let server: ChildProcess | null = null;

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/render-dev.html`);
    return r.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  if (await reachable()) return;
  server = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  for (let i = 0; i < 120 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 500));
  expect(await reachable()).toBe(true);
});

test.afterAll(() => {
  server?.kill();
  server = null;
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function openHarness(page: Page, query: string): Promise<void> {
  await page.goto(`${BASE}/render-dev.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 150_000 });
}

test('renders the generated battlefield without console errors', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?look=0,-0.08');
  const s = await page.evaluate(() => window.__sampleCanvas!());
  expect(s.width).toBeGreaterThan(100);
  // a real scene: not a flat clear colour
  expect(s.std).toBeGreaterThan(12);
  expect(s.buckets).toBeGreaterThan(60);
  const info = await page.evaluate(() => (window as unknown as { __info: { drawCalls: number; triangles: number; entities: number } }).__info);
  expect(info.entities).toBeGreaterThan(30);
  expect(info.drawCalls).toBeGreaterThan(10);
  expect(info.drawCalls).toBeLessThan(450);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('showcase map at low quality, free camera', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?map=showcase&quality=low&cam=free&fc=0,30,70,0,-0.4');
  const s = await page.evaluate(() => window.__sampleCanvas!());
  expect(s.std).toBeGreaterThan(10);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('hero portraits render to PNG data URLs', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await openHarness(page, '?mode=portraits&n=4&size=96');
  const srcs = await page.$$eval('img', (imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.length).toBe(4);
  for (const s of srcs) {
    expect(s.startsWith('data:image/png')).toBe(true);
    expect(s.length).toBeGreaterThan(2000);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
