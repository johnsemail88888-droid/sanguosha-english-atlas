// NET e2e: two browser contexts join the same room through the local server
// (server/server.mjs on :8791 — WebSocket relay + PeerJS signalling) and reach
// hero select / playing. Pages are served by a dedicated Vite dev server on
// :5182 (tests/e2e/fixtures/vite.net.config.ts). Self-contained: starts and
// stops both servers itself.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VITE_PORT = 5182;
const RELAY_PORT = 8791;
const FIXTURE =
  `http://127.0.0.1:${VITE_PORT}/tests/e2e/fixtures/net.html` +
  `?ws=ws://127.0.0.1:${RELAY_PORT}/ws&peerHost=127.0.0.1&peerPort=${RELAY_PORT}&peerPath=/peerjs`;

type State = {
  phase: string | null;
  seats: number;
  roomCode: string | null;
  yourRole: string | null;
  heroSelect: { lordPhase: boolean; options: number; picks: number } | null;
  entities: number;
  localId: number | null;
  localPos: { x: number; z: number } | null;
  events: number;
  phases: string[];
  errors: string[];
};

type NetTest = {
  host(mode: 'ws' | 'peer', fake?: boolean, name?: string): Promise<string>;
  join(code: string, mode: 'ws' | 'peer', name?: string): Promise<boolean>;
  start(): void;
  setMoving(on: boolean): void;
  leave(): void;
  state(): State;
  entityPos(id: number): { x: number; z: number } | null;
  setHidden(on: boolean): void;
  channels(): { label: string; ordered: boolean; maxRetransmits: number | null }[];
  snapshotStats(): { full: number; delta: number; missing: number } | null;
};

const api = (p: Page) => ({
  entityPos: (id: number) => p.evaluate((i) => (window as unknown as { netTest: NetTest }).netTest.entityPos(i), id),
  setHidden: (on: boolean) => p.evaluate((h) => (window as unknown as { netTest: NetTest }).netTest.setHidden(h), on),
  channels: () => p.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.channels()),
  snapshotStats: () => p.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.snapshotStats()),
});

let relay: ChildProcess | null = null;
let vite: ChildProcess | null = null;
let browser: Browser | null = null;

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

function startProc(args: string[], env: Record<string, string>, label: string): ChildProcess {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr?.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  return p;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  relay = startProc(['server/server.mjs'], { PORT: String(RELAY_PORT), HOST: '127.0.0.1' }, 'relay');
  vite = startProc(['node_modules/vite/bin/vite.js', '--config', 'tests/e2e/fixtures/vite.net.config.ts'], {}, 'vite');
  await waitHttp(`http://127.0.0.1:${RELAY_PORT}/sgwl.json`, 20_000);
  await waitHttp(`http://127.0.0.1:${VITE_PORT}/tests/e2e/fixtures/net.html`, 60_000);
  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // expose real host ICE candidates instead of mDNS names (two contexts, one machine)
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
  relay?.kill('SIGTERM');
  vite?.kill('SIGTERM');
});

async function openFixture(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser!.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(FIXTURE);
  await page.waitForFunction(() => Boolean((window as unknown as { netTest?: unknown }).netTest), null, { timeout: 60_000 });
  return { ctx, page, errors };
}

const state = (p: Page): Promise<State> => p.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.state());

async function waitState(p: Page, pred: (s: State) => boolean, timeoutMs: number, what: string): Promise<State> {
  const end = Date.now() + timeoutMs;
  let s = await state(p);
  while (!pred(s)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(s)}`);
    await p.waitForTimeout(150);
    s = await state(p);
  }
  return s;
}

/** Console noise we accept: PeerJS logs failed STUN lookups (no internet in CI). */
const relevant = (errs: string[]): string[] => errs.filter((e) => !/stun|ICE|ERR_NAME_NOT_RESOLVED/i.test(e));

test('WS relay + real sim: two contexts join one room via the public API and play', async () => {
  test.setTimeout(120_000);
  const host = await openFixture();
  const guest = await openFixture();
  try {
    const code = await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.host('ws'));
    expect(code, JSON.stringify(await state(host.page))).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const joined = await guest.page.evaluate((c) => (window as unknown as { netTest: NetTest }).netTest.join(c.toLowerCase(), 'ws', '客人'), code);
    expect(joined, JSON.stringify(await state(guest.page))).toBe(true);
    await waitState(host.page, (s) => s.seats === 2, 10_000, 'host sees 2 seats');
    const g = await waitState(guest.page, (s) => s.seats === 2, 10_000, 'guest sees 2 seats');
    expect(g.roomCode).toBe(code);

    await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.start());
    const gs = await waitState(guest.page, (s) => s.phases.includes('heroSelect'), 30_000, 'guest hero select');
    expect(gs.yourRole).toBeTruthy();
    await waitState(host.page, (s) => s.phases.includes('heroSelect'), 10_000, 'host hero select');

    // the real sim (sim/world) runs the match: both sides must reach 'playing'
    const live = await waitState(guest.page, (s) => s.phase === 'playing' && s.entities > 0 && s.localPos !== null, 90_000, 'guest playing (real sim)');
    expect(live.errors).toEqual([]);
    expect(live.localId).not.toBeNull();
    const h = await waitState(host.page, (s) => s.phase === 'playing' && s.entities > 0, 30_000, 'host playing (real sim)');
    expect(h.errors).toEqual([]);
    expect(h.phases).not.toContain('lobby'); // never bounced back by simFailed
    console.log(`[net e2e] real sim: guest playing, ${live.entities} entities (host ${h.entities})`);
    // the guest's hero moves under the real sim (prediction + host authority)
    await guest.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.setMoving(true));
    await guest.page.waitForTimeout(1500);
    const moved = await state(guest.page);
    expect(Math.hypot(moved.localPos!.x - live.localPos!.x, moved.localPos!.z - live.localPos!.z)).toBeGreaterThan(0.5);
    const onHost = await api(host.page).entityPos(live.localId!);
    expect(onHost).not.toBeNull();
    expect(Math.hypot(onHost!.x - moved.localPos!.x, onHost!.z - moved.localPos!.z)).toBeLessThan(3);
    // snapshots arrive as deltas against acknowledged baselines, none skipped
    const ss = (await api(guest.page).snapshotStats())!;
    expect(ss.delta).toBeGreaterThan(ss.full * 3);
    expect(ss.missing).toBe(0);
    console.log(`[net e2e] guest snapshots: ${ss.full} full, ${ss.delta} delta, ${ss.missing} skipped`);
    await guest.page.screenshot({ path: test.info().outputPath('guest-real-sim.png') });
    expect(relevant(host.errors)).toEqual([]);
    expect(relevant(guest.errors)).toEqual([]);
  } finally {
    await host.ctx.close();
    await guest.ctx.close();
  }
});

test('WS relay: snapshots stream to the guest and its hero moves (stand-in sim)', async () => {
  test.setTimeout(120_000);
  const host = await openFixture();
  const guest = await openFixture();
  try {
    const code = await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.host('ws', true));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(await guest.page.evaluate((c) => (window as unknown as { netTest: NetTest }).netTest.join(c, 'ws', '行者'), code)).toBe(true);
    await waitState(host.page, (s) => s.seats === 2, 10_000, 'host sees guest');
    await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.start());
    const g = await waitState(guest.page, (s) => s.phase === 'playing' && s.entities > 0 && s.localPos !== null, 60_000, 'guest playing');
    const h = await waitState(host.page, (s) => s.phase === 'playing' && s.entities > 0, 10_000, 'host playing');
    expect(g.entities).toBe(h.entities);

    const before = (await state(guest.page)).localPos!;
    await guest.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.setMoving(true));
    await guest.page.waitForTimeout(1500);
    const moved = await state(guest.page);
    const dist = Math.hypot(moved.localPos!.x - before.x, moved.localPos!.z - before.z);
    expect(dist).toBeGreaterThan(2); // ~4.6 m/s forward for 1.5 s, predicted locally and confirmed by the host
    expect(moved.events).toBeGreaterThan(0);

    // tab hidden while holding "forward": the hero stops on the host right away
    const gid = moved.localId!;
    await api(guest.page).setHidden(true);
    await host.page.waitForTimeout(400);
    const p1 = (await api(host.page).entityPos(gid))!;
    await host.page.waitForTimeout(800);
    const p2 = (await api(host.page).entityPos(gid))!;
    expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeLessThan(0.05);
    await api(guest.page).setHidden(false);
    await host.page.waitForTimeout(800);
    const p3 = (await api(host.page).entityPos(gid))!;
    expect(Math.hypot(p3.x - p2.x, p3.z - p2.z)).toBeGreaterThan(1); // moving again once visible

    // guest leaves → host keeps playing (bot takes over); host leaves → guest gets an error
    await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.leave());
    await waitState(guest.page, (s) => s.errors.some((e) => e.startsWith('hostLeft')), 10_000, 'hostLeft error');
    expect(relevant(host.errors)).toEqual([]);
    expect(relevant(guest.errors)).toEqual([]);
  } finally {
    await host.ctx.close();
    await guest.ctx.close();
  }
});

test('PeerJS via the local signalling server: two contexts connect over WebRTC and reach hero select', async () => {
  test.setTimeout(120_000);
  const host = await openFixture();
  const guest = await openFixture();
  try {
    const code = await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.host('peer', true));
    expect(code, JSON.stringify(await state(host.page))).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const ok = await guest.page.evaluate((c) => (window as unknown as { netTest: NetTest }).netTest.join(c, 'peer', '远方'), code);
    expect(ok, JSON.stringify(await state(guest.page))).toBe(true);
    await waitState(host.page, (s) => s.seats === 2, 20_000, 'host sees peer guest');
    await host.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.start());
    await waitState(guest.page, (s) => s.phases.includes('heroSelect'), 30_000, 'peer guest hero select');
    const g = await waitState(guest.page, (s) => s.phase === 'playing' && s.entities > 0, 60_000, 'peer guest playing');
    expect(g.localId).not.toBeNull();
    // the snapshot/input channel is really lossy (no retransmissions), on both ends
    const gch = await api(guest.page).channels();
    expect(gch).toContainEqual({ label: 'u', ordered: false, maxRetransmits: 0 });
    expect(gch).toContainEqual({ label: 'r', ordered: true, maxRetransmits: null });
    const hch = await api(host.page).channels();
    expect(hch).toContainEqual({ label: 'u', ordered: false, maxRetransmits: 0 });
    expect(relevant(host.errors)).toEqual([]);
    expect(relevant(guest.errors)).toEqual([]);

    // joining a room that does not exist gives the bilingual "room not found"
    const lost = await openFixture();
    try {
      const joined = await lost.page.evaluate(() => (window as unknown as { netTest: NetTest }).netTest.join('ZZZZZ', 'peer'));
      expect(joined).toBe(false);
      const s = await state(lost.page);
      expect(s.errors[0]).toContain('房间不存在');
    } finally {
      await lost.ctx.close();
    }
  } finally {
    await host.ctx.close();
    await guest.ctx.close();
  }
});
