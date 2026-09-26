// Audio e2e: loads audio-dev.html, renders key sounds / music / stress
// scenarios through an OfflineAudioContext with the real mixing chain and
// asserts finite, audible output that never reaches full scale. Also drives
// the live engine (unlock, UI sounds, simulated firefight through the event
// router) and checks the console stays clean.
//
// Uses its own Vite server on port 5184 unless AUDIO_E2E_URL points at a
// running dev server (e.g. http://localhost:5173/audio-dev.html).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5184;
const URL = process.env.AUDIO_E2E_URL ?? `http://localhost:${PORT}/audio-dev.html`;

interface Stats {
  peak: number;
  peakDb: number;
  rms: number;
  finite: boolean;
  silent: boolean;
}

interface DevApi {
  renderSfx(name: string, req?: Record<string, unknown>): Promise<Stats>;
  renderLoop(name: string, opts?: Record<string, unknown>, seconds?: number): Promise<Stats>;
  renderMusic(track: string, seconds: number, intensity?: number): Promise<Stats>;
  renderScenario(name: string, seconds?: number): Promise<Stats>;
  renderScenarioBaked(name: string, seconds?: number): Promise<Stats>;
  renderMusicBaked(track: string, seconds: number, intensity?: number): Promise<Stats>;
  bankStats(): Promise<{ count: number; mb: number }>;
  renderCalibration(): Promise<Stats>;
  simulateFirefight(seconds: number, withMusic: boolean): void;
  engine: {
    stats(): { state: string; voices: number; loops: number; music: string | null };
    ui(name: string): void;
    music(track: string | null): void;
    unlock(): Promise<void>;
  };
}

/** window with the dev hook (type-only; evaluate callbacks are serialised) */
type W = Window & { __audioDev?: DevApi };

let server: ChildProcess | null = null;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
let navigations = 0;

/**
 * A fresh Vite server may reload the page once while it optimises
 * dependencies; wait until the page has been stable for `quietMs`.
 */
async function settle(quietMs = 2500, maxMs = 30_000): Promise<void> {
  const until = Date.now() + maxMs;
  let seen = -1;
  let since = Date.now();
  while (Date.now() < until) {
    if (navigations !== seen) {
      seen = navigations;
      since = Date.now();
    }
    if (Date.now() - since >= quietMs) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await page.waitForFunction(() => !!(window as W).__audioDev, null, { timeout: 30_000 });
}

/** page.evaluate that survives one dev-server reload */
async function run<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
  // arguments here are plain JSON (no handles), so the unboxed type is the type itself
  const call = (): Promise<T> => page.evaluate(fn as (arg: unknown) => T | Promise<T>, arg as unknown);
  try {
    return await call();
  } catch (err) {
    if (!/context was destroyed|navigation/i.test(String(err))) throw err;
    await settle();
    return call();
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!(await reachable(URL))) {
    server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    const deadline = Date.now() + 60_000;
    while (!(await reachable(URL))) {
      if (Date.now() > deadline) throw new Error(`dev server did not start at ${URL}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  page = await browser.newPage();
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(URL);
  await settle();
});

test.afterAll(async () => {
  await browser?.close();
  if (server) {
    server.kill('SIGTERM');
    server = null;
  }
});

function check(label: string, s: Stats): void {
  expect(s.finite, `${label}: finite`).toBe(true);
  expect(s.silent, `${label}: audible (peak ${s.peakDb.toFixed(1)} dB)`).toBe(false);
  expect(s.peak, `${label}: peak ${s.peakDb.toFixed(1)} dB below full scale`).toBeLessThan(1);
}

test('mix chain passes quiet signals at unity gain', async () => {
  const s = await run(() => (window as W).__audioDev!.renderCalibration(), null);
  // 0.1 amplitude sine × UI bus 0.9 → −20.9 dBFS
  expect(Math.abs(s.peakDb - -20.92)).toBeLessThan(0.5);
});

test('key sound effects render non-silent, finite and below full scale', async () => {
  const jobs: [string, string, Record<string, unknown>][] = [];
  for (const g of ['pistol', 'smg', 'rifle', 'shotgun', 'dmr', 'sniper', 'lmg', 'launcher', 'flamer', 'bow', 'crossbow', 'melee', 'tesla']) {
    jobs.push([`gun:${g}:local`, 'gun', { variant: g, local: true, seconds: 2 }]);
  }
  jobs.push(['gun:rifle@8m', 'gun', { variant: 'rifle', pos: { x: 3, y: 1.6, z: -7 }, seconds: 2 }]);
  jobs.push(['gun:sniper@150m', 'gun', { variant: 'sniper', pos: { x: 40, y: 1.6, z: -145 }, seconds: 3 }]);
  jobs.push(['gun:rifle:ice', 'gun', { variant: 'rifle', flavor: 'ice', local: true, seconds: 2 }]);
  for (const e of ['frag', 'rocket', 'fire', 'ice', 'thunder', 'holy', 'gas']) jobs.push([`explosion:${e}`, 'explosion', { variant: e, pos: { x: 4, y: 1, z: -10 }, size: 2, seconds: 3 }]);
  jobs.push(['lightning', 'lightning', { pos: { x: 0, y: 5, z: -20 }, size: 2, seconds: 4 }]);
  jobs.push(['arc (chain lightning)', 'arc', { pos: { x: 2, y: 1, z: -6 }, seconds: 1 }]);
  jobs.push(['arc x6 burst', 'arc', { pos: { x: 1, y: 1, z: -3 }, count: 6, every: 0.01, seconds: 1 }]);
  for (const m of ['flesh', 'wood', 'stone', 'metal', 'dirt', 'water', 'shield']) jobs.push([`impact:${m}`, 'impact', { variant: m, pos: { x: 1, y: 1, z: -3 }, seconds: 1 }]);
  for (const u of ['click', 'hover', 'confirm', 'back', 'flip', 'error', 'countdown', 'reveal']) jobs.push([`ui:${u}`, 'ui', { variant: u, seconds: 2 }]);
  for (const k of ['shu', 'wei', 'wu', 'qun', 'god']) jobs.push([`abilityCast:${k}`, 'abilityCast', { variant: k, local: true, seconds: 2 }]);
  jobs.push(['abilityCast:lord', 'abilityCast', { variant: 'wei', size: 1.5, local: true, seconds: 3 }]);
  for (const [n, v] of [
    ['reload', 'in'],
    ['reload', 'pump'],
    ['dryFire', ''],
    ['headshot', ''],
    ['hitmarker', ''],
    ['killConfirm', ''],
    ['heal', ''],
    ['revive', ''],
    ['shieldUp', ''],
    ['dodge', ''],
    ['crateOpen', '2'],
    ['pickup', 'weapon'],
    ['itemUse', 'wine'],
    ['itemUse', 'trick'],
    ['downed', ''],
    ['deathGong', ''],
    ['zoneHorn', ''],
    ['airdropThud', ''],
    ['footstep', 'dirt'],
    ['footstep', 'hoof'],
    ['status', 'stun'],
    ['heartbeat', ''],
    ['hurt', ''],
    ['command', 'charge'],
  ] as const) {
    jobs.push([`${n}${v ? ':' + v : ''}`, n, { variant: v, local: true, seconds: n === 'deathGong' || n === 'zoneHorn' ? 5 : 2 }]);
  }
  jobs.push(['plane', 'plane', { path: { from: { x: -300, y: 110, z: -20 }, to: { x: 300, y: 110, z: -20 }, duration: 5 }, seconds: 5.5 }]);
  jobs.push(['gun:shotgun x12 burst', 'gun', { variant: 'shotgun', pos: { x: 2, y: 1.6, z: -3 }, count: 12, every: 0.004, seconds: 2 }]);

  const results = await run(async (list) => {
    const out: [string, Stats][] = [];
    for (const [label, name, req] of list) out.push([label, await (window as W).__audioDev!.renderSfx(name, req)]);
    return out;
  }, jobs);
  expect(results).toHaveLength(jobs.length);
  for (const [label, s] of results) check(label, s);
});

test('loops render cleanly', async () => {
  const results = await run(async () => {
    const out: [string, Stats][] = [];
    for (const l of ['flamer', 'fire', 'zone', 'storm', 'arrows', 'rocket', 'heal', 'shield']) {
      out.push([l, await (window as W).__audioDev!.renderLoop(l, { pos: { x: 2, y: 1, z: -4 } }, 1.5)]);
    }
    return out;
  }, null);
  for (const [label, s] of results) check(`loop:${label}`, s);
});

test('music tracks and stingers render cleanly at full volume', async () => {
  const results = await run(async () => {
    const d = (window as W).__audioDev!;
    return [
      ['menu', await d.renderMusic('menu', 8, 0)],
      ['battle low', await d.renderMusic('battle', 6, 0.15)],
      ['battle high', await d.renderMusic('battle', 8, 1)],
      ['victory', await d.renderMusic('victory', 7)],
      ['defeat', await d.renderMusic('defeat', 8)],
    ] as [string, Stats][];
  }, null);
  for (const [label, s] of results) check(`music:${label}`, s);
  const low = results.find(([l]) => l === 'battle low')![1];
  const high = results.find(([l]) => l === 'battle high')![1];
  // layers follow intensity: the full battle mix is clearly louder
  expect(high.rms).toBeGreaterThan(low.rms * 1.4);
});

test('stress: eight shotguns, explosions and a full firefight never clip', async () => {
  const results = await run(async () => {
    const d = (window as W).__audioDev!;
    return [
      ['shotguns8', await d.renderScenario('shotguns8', 3)],
      ['explosions', await d.renderScenario('explosions', 3)],
      ['firefight', await d.renderScenario('firefight', 3)],
      ['fullMix', await d.renderScenario('fullMix', 3)],
    ] as [string, Stats][];
  }, null);
  for (const [label, s] of results) check(`scenario:${label}`, s);
});

test('baked sample bank: renders the same scenarios cleanly', async () => {
  const res = await run(async () => {
    const d = (window as W).__audioDev!;
    const bank = await d.bankStats();
    return {
      bank,
      stats: [
        ['firefight', await d.renderScenarioBaked('firefight', 3)],
        ['shotguns8', await d.renderScenarioBaked('shotguns8', 3)],
        ['battle', await d.renderMusicBaked('battle', 6, 1)],
      ] as [string, Stats][],
    };
  }, null);
  expect(res.bank.count).toBeGreaterThan(40);
  expect(res.bank.mb).toBeLessThan(40);
  for (const [label, s] of res.stats) check(`baked:${label}`, s);
});

test('live engine: unlock, UI, music and a simulated firefight', async () => {
  await page.click('#unlock');
  await page.waitForFunction(() => (window as W).__audioDev!.engine.stats().state === 'running', null, { timeout: 10_000 });
  await page.evaluate(() => {
    const d = (window as W).__audioDev!;
    d.engine.ui('click');
    d.engine.ui('confirm');
    d.engine.music('menu');
    d.simulateFirefight(1.5, true);
  });
  let maxVoices = 0;
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => (window as W).__audioDev!.engine.stats());
    maxVoices = Math.max(maxVoices, s.voices);
    expect(s.voices).toBeLessThanOrEqual(32);
  }
  expect(maxVoices).toBeGreaterThan(0);
  const s = await page.evaluate(() => (window as W).__audioDev!.engine.stats());
  expect(s.music).toBe('battle');
  await page.evaluate(() => (window as W).__audioDev!.engine.music(null));
});

test('no console errors', () => {
  expect(consoleErrors).toEqual([]);
});
