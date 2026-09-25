// Shared helpers for the real-app e2e specs (tests/e2e/game*.spec.ts).
// They drive the production build through the UI like a player and inspect the
// running game through the `?debug=1` hooks (window.__sgwl, src/game/debug.ts).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SgwlDebug } from '../../../src/game/debug';
import { chromium, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** build cache (SGWL_E2E_CACHE overrides it, e.g. to keep concurrent runs of different checkouts apart) */
export const CACHE = process.env.SGWL_E2E_CACHE ? path.resolve(process.env.SGWL_E2E_CACHE) : path.join(ROOT, 'node_modules', '.cache', 'sgwl-e2e');
/** added to every game spec's server ports (SGWL_E2E_PORT_OFFSET) so parallel runs on one machine never collide */
export const PORT_OFFSET = Number(process.env.SGWL_E2E_PORT_OFFSET ?? 0) || 0;
export const DIST = path.join(CACHE, 'dist');
export const DIST_SINGLE = path.join(CACHE, 'dist-single');
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
export const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];

/** `vite build` (kind 'dist') or `vite build --mode single` into the e2e cache. */
export function buildGame(kind: 'dist' | 'single'): string {
  const out = kind === 'dist' ? DIST : DIST_SINGLE;
  const args = [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'];
  if (kind === 'single') args.push('--mode', 'single');
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`vite build (${kind}) failed:\n${r.stdout}\n${r.stderr}`);
  return out;
}

export function ensureBuilt(kind: 'dist' | 'single'): string {
  const out = kind === 'dist' ? DIST : DIST_SINGLE;
  if (!existsSync(path.join(out, 'index.html'))) buildGame(kind);
  return out;
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`server did not come up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface Server {
  url: string;
  close(): Promise<void>;
}

/** `vite preview` of the e2e production build on 127.0.0.1:<port>. */
export async function startPreview(port: number): Promise<Server> {
  ensureBuilt('dist');
  const { preview } = await import('vite');
  const srv = await preview({
    root: ROOT,
    configFile: false,
    base: './',
    logLevel: 'error',
    build: { outDir: DIST },
    preview: { port, strictPort: true, host: '127.0.0.1', open: false },
  });
  const url = `http://127.0.0.1:${port}/`;
  await waitHttp(url, 30_000);
  return { url, close: () => srv.close() };
}

/** `node server/server.mjs` (static dist + /ws relay + /peerjs) on 127.0.0.1:<port>. */
export async function startRelay(port: number): Promise<Server> {
  ensureBuilt('dist');
  const proc: ChildProcess = spawn(process.execPath, ['server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DIST_DIR: DIST },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr?.on('data', (d) => process.stderr.write(`[relay] ${d}`));
  const url = `http://127.0.0.1:${port}/`;
  await waitHttp(`${url}sgwl.json`, 30_000);
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3000).unref();
      }),
  };
}

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}), args: CHROMIUM_ARGS });
}

export interface GamePage {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

export interface OpenOptions extends BrowserContextOptions {
  /** user settings written to localStorage before the app boots (merged over the test defaults) */
  settings?: Record<string, unknown>;
  /** single-player setup prefs (sgwl.ui.single.v1) */
  single?: { playerCount?: number; mode?: 'standard' | 'chaos'; botDifficulty?: 'easy' | 'normal' | 'hard'; freePick?: boolean };
  name?: string;
}

/**
 * New context + page on `url` with error collection. Test defaults keep
 * SwiftShader fast enough: low quality, voice lines off.
 */
export async function openGame(browser: Browser, url: string, opts: OpenOptions = {}): Promise<GamePage> {
  const { settings, single, name, ...ctxOpts } = opts;
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 576 }, ...ctxOpts });
  const st = { quality: 'low', voiceLines: false, playerName: name ?? 'e2e', ...settings };
  const sp = { playerCount: 5, mode: 'standard', botDifficulty: 'normal', freePick: true, ...single };
  await ctx.addInitScript(
    ([s, p]) => {
      try {
        if (!sessionStorage.getItem('sgwl.e2e.init')) {
          sessionStorage.setItem('sgwl.e2e.init', '1');
          localStorage.setItem('sgwl.settings.v1', JSON.stringify(s));
          localStorage.setItem('sgwl.ui.single.v1', JSON.stringify(p));
        }
      } catch {
        /* file:// without storage */
      }
    },
    [st, sp] as const,
  );
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // the failing URL is only in the location for "Failed to load resource" messages
    if (m.type() === 'error') errors.push(`console: ${m.text()}${m.location()?.url ? ` @ ${m.location().url}` : ''}`);
    // our own "something broke but the frame went on" warnings count as errors too
    else if (m.type() === 'warning' && /^\[(render|vfx|hud|ui|app)\].*(fail|error)/i.test(m.text())) errors.push(`warning: ${m.text()}`);
  });
  await page.goto(url);
  return { ctx, page, errors };
}

/**
 * Network noise that is not a game bug: no internet in CI (STUN servers, the
 * PeerJS cloud, ICE gathering). Deliberately narrow — case-sensitive, anchored to
 * the actual messages — so real errors ("reading 'slice'", "device", a 404 of one
 * of our own chunks) are never dropped.
 */
const NETWORK_NOISE = /\bstun:|\bturns?:|\bICE (candidate|server|failed|connection)|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED|0\.peerjs\.com|peerjs\.com\//;
/** "Failed to load resource" is noise only for the favicon or a URL on another host (no internet). */
const LOAD_FAILED = /Failed to load resource.* @ (\S+)$/;

function isOwnUrl(u: string): boolean {
  return /^(file:|data:|blob:)/.test(u) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);
}

export function relevantErrors(errs: readonly string[]): string[] {
  return errs.filter((e) => {
    const lf = LOAD_FAILED.exec(e);
    if (lf) return isOwnUrl(lf[1]!) && !/\/favicon\.(png|ico)(\?|$)/.test(lf[1]!);
    return !NETWORK_NOISE.test(e);
  });
}

export type SgwlWindow = Window & { __sgwl?: SgwlDebug };

/** Wait (polling the page) until `fn(__sgwl)` is truthy. */
export async function waitGame(page: Page, fn: string, timeout = 60_000, what = fn): Promise<void> {
  try {
    await page.waitForFunction(`(() => { const g = window.__sgwl; if (!g) return false; return (${fn})(g); })()`, null, { timeout, polling: 250 });
  } catch (err) {
    const st = await page.evaluate(() => {
      const g = (window as SgwlWindow).__sgwl;
      return g ? { phase: g.phase, screen: g.screen, t: g.elapsed() } : null;
    }).catch(() => null);
    throw new Error(`timeout waiting for ${what}: ${JSON.stringify(st)}\n${(err as Error).message}`);
  }
}

/** Heroes whose Q and E work without a target (used to check cooldowns start). */
export const SELF_CAST_HEROES = ['zhangfei', 'xuchu', 'huangzhong', 'sunquan', 'xiahoudun', 'zhenji'];

/** On hero select: pick one of `prefer` if offered (free pick shows everyone), else the first card; then confirm. */
export async function pickHero(page: Page, prefer: readonly string[] = []): Promise<string> {
  await expect(page.locator('[data-screen="heroSelect"]')).toBeVisible({ timeout: 120_000 });
  const cards = page.locator('.sg-select:not(.waiting) .grid .sg-hcard');
  await expect(cards.first()).toBeVisible({ timeout: 120_000 });
  let chosen = page.locator('.sg-select .grid .sg-hcard').first();
  for (const id of prefer) {
    const c = page.locator(`.sg-select .grid .sg-hcard[data-hero="${id}"]`);
    if ((await c.count()) > 0 && !(await c.first().isDisabled().catch(() => false))) {
      chosen = c.first();
      break;
    }
  }
  const hero = (await chosen.getAttribute('data-hero')) ?? '';
  const t0 = Date.now();
  await chosen.click();
  const clicked = { ms: Date.now() - t0, ...((await selectState(page)) as object) };
  // Confirm — unless the page is too slow and the countdown already ran out: the
  // host then locks in the clicked card (focusHero hint), the screen shows 已锁定
  // and the confirm button is disabled on purpose.
  const confirm = page.locator('.detail-actions .sg-btn');
  const end = Date.now() + 60_000;
  for (;;) {
    const st = await page
      .evaluate(() => {
        const sel = document.querySelector('.sg-select');
        const btn = document.querySelector<HTMLButtonElement>('.detail-actions .sg-btn');
        return { gone: !sel, locked: !!sel?.classList.contains('locked'), enabled: !!btn && !btn.disabled };
      })
      .catch(() => ({ gone: true, locked: false, enabled: false }));
    if (st.gone || st.locked) break;
    if (st.enabled && (await confirm.click({ timeout: 10_000 }).then(() => true, () => false))) break;
    if (Date.now() > end) throw new Error(`hero select: cannot confirm ${hero}: after the card click ${JSON.stringify(clicked)}, now ${JSON.stringify(await selectState(page))}`);
    await page.waitForTimeout(250);
  }
  return hero;
}

/** Hero-select diagnostics for a failed pick (what the page shows and what the session holds). */
export async function selectState(page: Page): Promise<unknown> {
  return page
    .evaluate(() => {
      const g = (window as SgwlWindow).__sgwl;
      const s = g?.session as unknown as { heroSelect?: { lordPhase: boolean; options: string[]; picks: Record<number, string>; deadline: number; lordSeat: number } | null; myId?: string; lobby?: { seats: { seat: number; playerId: string | null }[] } | null } | null;
      const v = s?.heroSelect ?? null;
      const sel = document.querySelector('.sg-select');
      return {
        screen: g?.screen ?? null,
        phase: g?.phase ?? null,
        cls: sel?.className ?? null,
        stage: sel?.querySelector('.titles')?.textContent ?? null,
        ring: sel?.querySelector('.ring')?.textContent ?? null,
        confirm: document.querySelector('.detail-actions .sg-btn')?.textContent ?? null,
        view: v ? { lordPhase: v.lordPhase, options: v.options.length, picks: v.picks, deadline: v.deadline, lordSeat: v.lordSeat } : null,
        me: s?.lobby?.seats.find((x) => x.playerId === s.myId)?.seat ?? null,
        t: performance.now() | 0,
      };
    })
    .catch((e: unknown) => ({ evalError: String(e) }));
}

/** Title → 单人练习 → setup → start → roles → hero select → match (HUD up). Returns the picked hero id. */
export async function playSingle(page: Page, opts: { players?: 5 | 6 | 7 | 8; prefer?: readonly string[] } = {}): Promise<string> {
  await page.locator('.sg-menu-btn.primary').click();
  await expect(page.locator('[data-screen="single"]')).toBeVisible();
  if (opts.players) await page.locator('[data-screen="single"] .sg-seg button', { hasText: String(opts.players) }).first().click();
  await page.locator('[data-screen="single"] .sg-btn.gold').click();
  await expect(page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 });
  const hero = await pickHero(page, opts.prefer ?? []);
  await waitMatch(page);
  return hero;
}

/** Loading screen (staged 3D build) → match screen with the HUD. */
export async function waitMatch(page: Page, timeout = 240_000): Promise<void> {
  await waitGame(page, "(g) => g.screen === 'loading' || g.screen === 'match'", timeout, 'loading screen');
  await waitGame(page, "(g) => g.screen === 'match' && g.phase === 'playing' && g.localEntity() !== null", timeout, 'match screen');
  await expect(page.locator('.sg-hud .hud-vitals .v-hpbar')).toBeVisible({ timeout: 60_000 });
}

/** Click into the game (pointer lock) until no overlay is open. */
export async function enterGame(page: Page): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1024, height: 576 };
  for (let i = 0; i < 5; i++) {
    const ov = await page.evaluate(() => document.querySelector<HTMLElement>('.sg-hud')?.dataset.overlay ?? null);
    if (ov === 'none') return;
    await page.mouse.click(vp.width / 2, vp.height * 0.62);
    await page.waitForTimeout(600);
  }
  await expect(page.locator('.sg-hud[data-overlay="none"]')).toHaveCount(1, { timeout: 20_000 });
}

export async function localPos(page: Page): Promise<{ x: number; z: number }> {
  const p = await page.evaluate(() => {
    const e = (window as SgwlWindow).__sgwl?.localEntity();
    return e ? { x: e.x, z: e.z } : null;
  });
  if (!p) throw new Error('no local hero');
  return p;
}

/** Hold `key` until the local hero moved `minDist` metres (SwiftShader renders only a few fps). */
export async function holdKeyUntilMoved(page: Page, key: string, minDist: number, timeout = 45_000): Promise<number> {
  const start = await localPos(page);
  await page.keyboard.down(key);
  const end = Date.now() + timeout;
  let d = 0;
  try {
    while (Date.now() < end) {
      await page.waitForTimeout(400);
      const p = await localPos(page);
      d = Math.hypot(p.x - start.x, p.z - start.z);
      if (d >= minDist) break;
    }
  } finally {
    await page.keyboard.up(key);
  }
  return d;
}
