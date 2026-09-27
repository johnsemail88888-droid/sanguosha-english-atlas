// Mac smoke: the production build (served by `vite preview`) in the engines Mac
// players use — WebKit (= Safari) and Chromium (= Chrome on macOS) — driven like a
// player. Run by the Mac check workflow (.github/workflows/warlords-mac.yml) through
// playwright.mac.config.ts on an Apple-silicon runner; the default config runs it
// too (Linux Chromium on SwiftShader) as a quick local smoke.
//   title: renders, no page errors / unhandled rejections; WebGL 2 and the GPU the
//   engine draws with (logged, with the extensions the renderer relies on); the
//   audio unlocks on the first click; 自动 quality benchmarks the GPU and picks a tier.
//   single player: hero select → match in first person; W moves, the mouse aims,
//   firing uses ammo while the sim clock runs (fps sampled); Esc → pause menu;
//   设置 → 画面 shows the GPU line; leave to the title.
//   P2P (WebKit only): two WebKit players join one room over the public PeerJS
//   cloud and both reach the match (skipped when the cloud is unreachable).
// Every console line of a page goes to <test output>/console*.log next to the
// screenshots; the numbers (renderer, tier, fps) to the GitHub step summary.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { chromium, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { PORT_OFFSET, holdKeyUntilMoved, pickHero, playSingle, relevantErrors, startPreview, waitMatch, type Server, type SgwlWindow } from './fixtures/game-fixture';

test.describe.configure({ mode: 'serial' });

let server: Server;

test.beforeAll(async ({}, info) => {
  test.setTimeout(300_000);
  // one port per project: the projects run one after the other, each with its own server
  const idx = Math.max(0, info.config.projects.findIndex((p) => p.name === info.project.name));
  server = await startPreview(5318 + idx * 2 + PORT_OFFSET);
});

test.afterAll(async () => {
  await server?.close();
});

interface MacWindow {
  __mac?: { ctxs: AudioContext[]; rejections: string[] };
}

/** In every document before the app: unhandled rejections → console errors; remember the AudioContexts the page makes. */
function instrument(): void {
  const w = window as unknown as MacWindow & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const mac = { ctxs: [] as AudioContext[], rejections: [] as string[] };
  w.__mac = mac;
  addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason as { stack?: string } | undefined;
    const msg = r && r.stack ? String(r.stack) : String(e.reason);
    mac.rejections.push(msg);
    console.error(`[unhandledrejection] ${msg}`);
  });
  const Base = w.AudioContext ?? w.webkitAudioContext;
  if (Base) {
    const Tracked = class extends Base {
      constructor(opts?: AudioContextOptions) {
        super(opts);
        mac.ctxs.push(this);
      }
    };
    w.AudioContext = Tracked;
    if (w.webkitAudioContext) w.webkitAudioContext = Tracked;
  }
}

/** WebGL 2 as the page sees it: renderer strings, limits, and which of the extensions the renderer uses are missing. */
function webglInfo(): Record<string, unknown> {
  const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
  if (!gl) return { webgl2: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const exts = gl.getSupportedExtensions() ?? [];
  const used = [
    'EXT_color_buffer_float',
    'EXT_color_buffer_half_float',
    'OES_texture_float_linear',
    'EXT_float_blend',
    'KHR_parallel_shader_compile',
    'EXT_disjoint_timer_query_webgl2',
    'EXT_texture_filter_anisotropic',
    'WEBGL_compressed_texture_astc',
    'WEBGL_compressed_texture_etc',
    'WEBGL_compressed_texture_s3tc',
    'WEBGL_multi_draw',
    'WEBGL_lose_context',
  ];
  const out = {
    webgl2: true,
    renderer: String(gl.getParameter(gl.RENDERER)),
    vendor: String(gl.getParameter(gl.VENDOR)),
    unmaskedRenderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
    unmaskedVendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
    version: String(gl.getParameter(gl.VERSION)),
    maxSamples: Number(gl.getParameter(gl.MAX_SAMPLES)),
    maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    extensions: exts.length,
    missing: used.filter((e) => !exts.includes(e)),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
}

interface MacPage {
  page: Page;
  errors: string[];
  lines: string[];
  close(): Promise<void>;
}

/**
 * A fresh context on `url` with the full console kept (`lines`) and the errors
 * collected like game-fixture's openGame. `settings` go into localStorage first.
 */
async function open(browser: Browser, url: string, settings: Record<string, unknown>, logName: string): Promise<MacPage> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(
    ([s, p]) => {
      try {
        if (!sessionStorage.getItem('sgwl.e2e.init')) {
          sessionStorage.setItem('sgwl.e2e.init', '1');
          localStorage.setItem('sgwl.settings.v1', JSON.stringify(s));
          localStorage.setItem('sgwl.ui.single.v1', JSON.stringify(p));
        }
      } catch {
        /* no storage */
      }
    },
    [{ voiceLines: false, lang: 'zh', ...settings }, { playerCount: 5, mode: 'standard', botDifficulty: 'normal', freePick: true }] as const,
  );
  await ctx.addInitScript(instrument);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const lines: string[] = [];
  const t0 = Date.now();
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
    lines.push(`${((Date.now() - t0) / 1000).toFixed(1)} [pageerror] ${e.stack ?? e.message}`);
  });
  page.on('console', (m) => {
    const where = m.location()?.url ? ` @ ${m.location().url}` : '';
    lines.push(`${((Date.now() - t0) / 1000).toFixed(1)} [${m.type()}] ${m.text()}${where}`);
    if (m.type() === 'error') errors.push(`console: ${m.text()}${where}`);
    else if (m.type() === 'warning' && /^\[(render|vfx|hud|ui|app)\].*(fail|error)/i.test(m.text())) errors.push(`warning: ${m.text()}`);
  });
  await page.goto(url);
  const file = test.info().outputPath(`console-${logName}.log`);
  return {
    page,
    errors,
    lines,
    close: async () => {
      writeFileSync(file, `${lines.join('\n')}\n`);
      await ctx.close();
    },
  };
}

/** One markdown section per project in the GitHub step summary (and the test log). */
function summarize(title: string, rows: Record<string, unknown>): void {
  const text = [`### ${title}`, '', '| | |', '|---|---|', ...Object.entries(rows).map(([k, v]) => `| ${k} | ${String(typeof v === 'object' && v !== null ? JSON.stringify(v) : v).replace(/\|/g, '\\|')} |`), '', ''].join('\n');
  console.log(text);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, text);
}

type PerfLike = { fps: number; frameMs: number; drawCalls: number; pixelRatio: number; quality: string };
const perf = (page: Page): Promise<PerfLike | null> =>
  page.evaluate(() => {
    const r = ((window as SgwlWindow).__sgwl?.handle as { renderer?: { perf(): PerfLike } } | null)?.renderer;
    return r ? { ...r.perf() } : null;
  });
/** What stands between the player and the game: HUD overlay, pointer lock, focus, the lock events seen. */
const lockState = (page: Page) =>
  page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.sg-hud');
    return {
      overlay: hud?.dataset.overlay ?? null,
      pauseMode: hud?.dataset.pauseMode ?? null,
      locked: document.pointerLockElement !== null,
      focus: document.hasFocus(),
      visibility: document.visibilityState,
      lockEvents: (window as unknown as { __lockLog?: string[] }).__lockLog ?? [],
    };
  });

/**
 * A headed browser on the macOS runner is started by the runner agent and never becomes
 * the frontmost app, and macOS browsers only grant the pointer lock to the active app:
 * bring it to the front (LaunchServices, like a player clicking its Dock icon).
 */
function activateBrowserApp(browserName: string): void {
  if (process.platform !== 'darwin') return;
  const exe = browserName === 'webkit' ? webkit.executablePath() : chromium.executablePath();
  const app = exe.slice(0, exe.indexOf('.app/') + 4);
  if (!app.endsWith('.app')) return;
  const r = spawnSync('open', ['-a', app], { encoding: 'utf8', timeout: 10_000 });
  console.log(`[mac] open -a ${app}: ${r.status} ${r.stderr ?? ''}`.trim());
}

/**
 * The runner refused the pointer lock (lock events: only 'error'): stand in for the
 * browser's lock so the rest of the flow (aim, fire, Esc, menus) still runs. The page
 * already showed it handles the refusal: the click-to-play overlay stayed up, no errors.
 */
async function emulatePointerLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    let locked: Element | null = null;
    const changed = (): void => void setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0);
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked });
    Element.prototype.requestPointerLock = function (this: Element) {
      locked = this;
      changed();
      return Promise.resolve();
    } as typeof Element.prototype.requestPointerLock;
    document.exitPointerLock = () => {
      if (!locked) return;
      locked = null;
      changed();
    };
  });
}

/**
 * Click into the game (pointer lock) until no overlay is open, like enterGame, but
 * logging every step. Returns how the lock was got: 'real', or 'emulated' when the
 * runner refused it (see emulatePointerLock).
 */
async function enterPlay(page: Page, who: string, headed: boolean, browserName: string): Promise<'real' | 'emulated'> {
  await page.evaluate(() => {
    const w = window as unknown as { __lockLog?: string[] };
    if (w.__lockLog) return;
    const log: string[] = (w.__lockLog = []);
    document.addEventListener('pointerlockchange', () => log.push(`change:${document.pointerLockElement !== null ? 'locked' : 'free'}`));
    document.addEventListener('pointerlockerror', () => log.push('error'));
  });
  if (headed) activateBrowserApp(browserName);
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  let mode: 'real' | 'emulated' = 'real';
  for (let i = 0; i < 8; i++) {
    const st = await lockState(page);
    if (st.overlay === 'none') return mode;
    console.log(`[mac] ${who} enter #${i}: ${JSON.stringify(st)}`);
    if (mode === 'real' && i >= 2 && st.lockEvents.length > 0 && st.lockEvents.every((e) => e === 'error')) {
      console.log(`[mac] ${who}: the runner refuses the pointer lock, emulating it for the rest of the test`);
      await emulatePointerLock(page);
      mode = 'emulated';
    }
    await page.mouse.click(vp.width / 2, vp.height * 0.62);
    await page.waitForTimeout(700);
  }
  const st = await lockState(page);
  if (st.overlay !== 'none') throw new Error(`cannot enter the game (pointer lock): ${JSON.stringify(st)}`);
  return mode;
}

const elapsed = (page: Page): Promise<number> => page.evaluate(() => (window as SgwlWindow).__sgwl!.elapsed());
const storedSettings = (page: Page): Promise<Record<string, unknown>> => page.evaluate(() => JSON.parse(localStorage.getItem('sgwl.settings.v1') ?? '{}') as Record<string, unknown>);

test('Mac smoke: title → audio → GPU tier → single player: move / aim / fire → pause → 设置 GPU → title', async ({ browser, browserName }, info) => {
  test.setTimeout(15 * 60_000);
  const rows: Record<string, unknown> = { engine: `${browserName} ${browser.version()}${info.project.use.headless === false ? ' (headed)' : ''}` };
  let g: MacPage | null = null;
  try {
    // 自动 quality with the benchmark on (?autotune=1: automated browsers skip it otherwise)
    g = await open(browser, `${server.url}?debug=1&autotune=1&lang=zh`, { playerName: 'mac', qualityAuto: true }, 'single');
    const { page, errors } = g;
    const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${browserName}-${name}.png`) });

    // title
    await expect(page.locator('.sg-menu-btn.primary')).toContainText('单人练习', { timeout: 90_000 });
    await expect(page.locator('.sg-logo')).toBeVisible();
    rows.userAgent = await page.evaluate(() => navigator.userAgent);
    const gl = await page.evaluate(webglInfo);
    rows.webgl = gl;
    rows.renderer = gl.unmaskedRenderer ?? gl.renderer;
    console.log(`[mac] ${browserName} WebGL: ${JSON.stringify(gl)}`);
    expect(gl.webgl2, 'WebGL 2 context').toBe(true);
    await shot('01-title');

    // the first click unlocks the audio (an AudioContext created and running)
    const audio0 = await page.evaluate(() => (window as MacWindow).__mac!.ctxs.map((c) => c.state));
    await page.locator('.sg-logo').click();
    await expect
      .poll(() => page.evaluate(() => (window as MacWindow).__mac!.ctxs.map((c) => c.state)), { message: 'an AudioContext runs after the click', timeout: 15_000 })
      .toContain('running');
    rows.audio = `${JSON.stringify(audio0)} → ${JSON.stringify(await page.evaluate(() => (window as MacWindow).__mac!.ctxs.map((c) => `${c.state} ${c.sampleRate} Hz`)))}`;

    // 自动: the GPU benchmark runs on the title and picks the tier
    await expect.poll(async () => ((await storedSettings(page)).gpuBench as { at?: number } | undefined)?.at ?? 0, { message: 'GPU benchmark stored', timeout: 90_000 }).toBeGreaterThan(0);
    const st = await storedSettings(page);
    rows.benchmark = st.gpuBench;
    rows.autoTier = `${String(st.quality)} (render scale cap ${String(st.autoRenderScale)})`;
    console.log(`[mac] ${browserName} benchmark: ${JSON.stringify(st.gpuBench)} → ${String(rows.autoTier)}`);

    // single player → match, first person
    const hero = await playSingle(page, { players: 5 });
    rows.hero = hero;
    rows.loadMs = await page.evaluate(() => JSON.stringify((window as SgwlWindow).__sgwl!.timings));
    const fp = await page.evaluate(() => ((window as SgwlWindow).__sgwl!.handle as { renderer: { firstPerson: boolean } }).renderer.firstPerson);
    expect(fp, 'first person by default with mouse + keyboard').toBe(true);
    const headed = info.project.use.headless === false;
    const lockMode = await enterPlay(page, browserName, headed, browserName);
    const ls = await lockState(page);
    rows.pointerLock = `${lockMode === 'real' ? 'granted' : 'refused by the runner (the page kept its click-to-play overlay, no errors), emulated'} · events ${ls.lockEvents.join(',')}`;
    await shot('02-match');
    const t0 = await elapsed(page);

    // move
    const moved = await holdKeyUntilMoved(page, 'w', 1.5);
    expect(moved, 'W moves the hero').toBeGreaterThan(1.5);

    // aim: the mouse turns the view (pointer lock → movementX)
    const yaw = () => page.evaluate(() => (window as SgwlWindow).__sgwl!.localEntity()!.yaw);
    const y0 = await yaw();
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(640 + (i + 1) * 20, 400, { steps: 2 });
      await page.waitForTimeout(50);
    }
    const turned = expect.poll(async () => Math.abs((await yaw()) - y0), { message: 'the mouse turns the hero', timeout: 10_000 }).toBeGreaterThan(0.05);
    let aimVia = 'mouse';
    if (lockMode === 'real') await turned;
    else if (!(await turned.then(() => true, () => false))) {
      // WebKit's synthetic mouse moves carry no movementX (a real locked pointer does): send
      // the engine's own MouseEvents with movementX, the way a locked pointer reports motion
      aimVia = 'MouseEvent movementX';
      await page.evaluate(() => {
        for (let i = 0; i < 10; i++) document.dispatchEvent(new MouseEvent('mousemove', { movementX: 25, movementY: 0, bubbles: true }));
      });
      await expect.poll(async () => Math.abs((await yaw()) - y0), { message: 'movementX turns the hero', timeout: 10_000 }).toBeGreaterThan(0.05);
    }
    rows.aim = `yaw ${y0.toFixed(2)} → ${(await yaw()).toFixed(2)} (${aimVia})`;

    // fire: ammo goes down
    const ammo = () =>
      page.evaluate(() => {
        const l = (window as SgwlWindow).__sgwl!.local()!;
        const w = l.weapons[l.activeSlot]!;
        return { id: w.id, mag: w.mag, reserve: w.reserve };
      });
    const a0 = await ammo();
    await page.mouse.down();
    let a1 = a0;
    for (let i = 0; i < 40 && a1.mag >= a0.mag && a1.reserve >= a0.reserve; i++) {
      await page.waitForTimeout(250);
      a1 = await ammo();
    }
    await page.waitForTimeout(1000);
    await page.mouse.up();
    expect(a1.mag < a0.mag || a1.reserve < a0.reserve, `firing ${a0.id} used ammo (${JSON.stringify(a0)} → ${JSON.stringify(a1)})`).toBe(true);
    await shot('03-fire');

    // the sim runs, and how fast the frames come (the renderer's own fps, sampled over 5 s)
    const samples: PerfLike[] = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const p = await perf(page);
      if (p) samples.push(p);
    }
    const t1 = await elapsed(page);
    expect(t1 - t0, 'the match clock runs').toBeGreaterThan(3);
    const fps = samples.map((s) => s.fps).sort((a, b) => a - b);
    const last = samples[samples.length - 1];
    rows.fps = `median ${fps[fps.length >> 1] ?? '?'} (min ${fps[0] ?? '?'}, max ${fps[fps.length - 1] ?? '?'})`;
    rows.frame = last ? `${last.frameMs.toFixed(1)} ms · ${last.drawCalls} draw calls · pixel ratio ${last.pixelRatio.toFixed(2)} · tier ${last.quality}` : 'n/a';
    rows.simClock = `${t0.toFixed(1)} → ${t1.toFixed(1)} s`;
    console.log(`[mac] ${browserName} perf: ${String(rows.fps)} · ${String(rows.frame)}`);

    // Esc → pause menu with a free cursor
    await page.keyboard.press('Escape');
    await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null), { message: 'the menu frees the pointer' }).toBe(true);
    await shot('04-pause');

    // 设置 → 画面: the GPU line
    await page.locator('.pm-box .sg-btn', { hasText: '设置' }).click();
    await expect(page.locator('.sg-settings')).toBeVisible();
    await page.locator('.sg-settings .sg-tab[data-tab="graphics"]').click();
    const gpuLine = page.locator('.sg-settings .set-gpu');
    await expect(gpuLine).toBeVisible();
    await expect(gpuLine).toContainText('显卡');
    rows.settingsGpuLine = ((await gpuLine.textContent()) ?? '').trim();
    rows.softwareRenderer = await gpuLine.evaluate((el) => el.classList.contains('soft'));
    await shot('05-settings-gpu');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sg-settings')).toHaveCount(0);

    // leave → title
    await expect(page.locator('.sg-hud[data-overlay="pause"] .pm-box')).toBeVisible();
    await page.locator('.pm-box .sg-btn', { hasText: /离开|Leave/ }).click();
    await page.locator('.sg-modal .actions .sg-btn').last().click();
    await expect(page.locator('[data-screen="title"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sg-game canvas')).toHaveCount(0);
    await shot('06-back-to-title');

    rows.rejections = await page.evaluate(() => (window as MacWindow).__mac!.rejections.length);
    rows.errors = relevantErrors(errors).length;
    expect(relevantErrors(errors)).toEqual([]);
    rows.result = 'passed';
  } catch (err) {
    rows.result = `FAILED: ${(err as Error).message.split('\n')[0]}`;
    if (g) {
      rows.errors = relevantErrors(g.errors).slice(0, 5);
      rows.state = await lockState(g.page).catch(() => null);
      console.log(`[mac] ${browserName} console (last 60 lines):\n${g.lines.slice(-60).join('\n')}`);
    }
    throw err;
  } finally {
    summarize(`Mac smoke · ${info.project.name || browserName}`, rows);
    await g?.close();
  }
});

test('Mac smoke: P2P join between two WebKit players (PeerJS cloud)', async ({ browser, browserName }, info) => {
  test.skip(browserName !== 'webkit' || info.project.use.headless === false, 'P2P runs between two headless WebKit (Safari) contexts');
  test.setTimeout(12 * 60_000);
  const reachable = await fetch(`https://0.peerjs.com/peerjs/id?ts=${Date.now()}`, { signal: AbortSignal.timeout(8000) }).then(
    (r) => r.ok,
    () => false,
  );
  if (!reachable) summarize(`Mac smoke · P2P (${browserName})`, { result: 'skipped: the PeerJS cloud (0.peerjs.com) is unreachable from this runner' });
  test.skip(!reachable, 'the PeerJS cloud (0.peerjs.com) is unreachable');
  const rows: Record<string, unknown> = {};
  const pages: MacPage[] = [];
  try {
    const low = { quality: 'low', qualityAuto: false };
    const host = await open(browser, `${server.url}?debug=1&lang=zh`, { ...low, playerName: '主持人' }, 'p2p-host');
    pages.push(host);
    await host.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await expect(host.page.locator('[data-screen="online"]')).toBeVisible();
    await host.page.locator('.sg-online-mode .sg-seg button[data-value="peer"]').click();
    await host.page.locator('.sg-online-cols .col .sg-btn.gold').click();
    await expect(host.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 90_000 });
    const code = (await host.page.locator('[data-screen="lobby"] .room-code .code').textContent())!.trim();
    rows.room = code;

    // the guest opens the invite link (public PeerJS cloud) and lands in the host's lobby
    const guest = await open(browser, `${server.url}?room=${code}&mode=peer&debug=1&lang=zh`, { ...low, playerName: '远客' }, 'p2p-guest');
    pages.push(guest);
    await expect(guest.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(code, { timeout: 90_000 });
    await expect(host.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(2, { timeout: 60_000 });
    await guest.page.locator('.lobby-foot .sg-btn.gold').click(); // ready
    await host.page.locator('.lobby-foot .sg-btn.gold').click(); // start
    const confirm = host.page.locator('.sg-modal .actions .sg-btn').last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await Promise.all(pages.map((p) => expect(p.page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 90_000 })));
    const heroes = await Promise.all(pages.map((p) => pickHero(p.page)));
    await Promise.all(pages.map((p) => waitMatch(p.page, 300_000)));
    rows.heroes = heroes.join(' / ');
    const guestView = await guest.page.evaluate(() => {
      const g = (window as SgwlWindow).__sgwl!;
      return { kind: g.sessionKind, phase: g.phase, hero: g.local()?.heroId ?? null, humans: g.players().filter((p) => !p.isBot).length };
    });
    rows.guest = guestView;
    expect(guestView).toMatchObject({ kind: 'guest', phase: 'playing', hero: heroes[1], humans: 2 });
    // the guest's clock follows the host's
    const c0 = await elapsed(guest.page);
    await expect.poll(() => elapsed(guest.page), { message: 'the guest clock runs', timeout: 30_000 }).toBeGreaterThan(c0 + 2);
    await guest.page.screenshot({ path: test.info().outputPath('webkit-p2p-guest.png') });
    await host.page.screenshot({ path: test.info().outputPath('webkit-p2p-host.png') });
    for (const p of pages) expect(relevantErrors(p.errors)).toEqual([]);
    rows.result = 'passed';
  } catch (err) {
    rows.result = `FAILED: ${(err as Error).message.split('\n')[0]}`;
    rows.errors = pages.flatMap((p) => relevantErrors(p.errors)).slice(0, 5);
    for (const p of pages) console.log(`[mac] p2p console (last 40 lines):\n${p.lines.slice(-40).join('\n')}`);
    throw err;
  } finally {
    summarize(`Mac smoke · P2P (${browserName})`, rows);
    for (const p of pages) await p.close();
  }
});
