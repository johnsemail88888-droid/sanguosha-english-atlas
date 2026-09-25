// Real app, online over the self-host server: `node server/server.mjs` serves the
// production build + the /ws relay on :8792. A host and two guests (three browser
// contexts) use the UI: host creates a room in 服务器 (ws) mode — same-origin
// relay, no configuration — guests open the invite link and join by room code;
// everyone picks a hero, reaches 'playing' and sees the other players' heroes move.
// The guests play on "slow phones" (NET-4): while they build the match scene their
// pages freeze for 12 s at a time — nobody may be dropped or reconnect for that.
// Then connection trouble mid-match (NET-3): one guest's relay socket drops (it must
// rejoin by itself within seconds, same view, seat never handed to a bot) and the
// host's page freezes ~8 s (the guests wait for it, then the match goes on).
// A second test joins over P2P from an invite link and reloads the guest (F5) while
// the host's link to the PeerJS signalling server is down (NET-4: the signalling
// server reports the host peer unavailable for a while): the tab keeps its seat
// token across the reload, keeps asking, and gets its hero back.
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  PORT_OFFSET,
  enterGame,
  launchBrowser,
  localPos,
  openGame,
  pickHero,
  relevantErrors,
  startRelay,
  waitMatch,
  type GamePage,
  type Server,
  type SgwlWindow,
} from './fixtures/game-fixture';

const RELAY_PORT = 8792 + PORT_OFFSET;
const VIEWPORT = { width: 640, height: 360 };
let relay: Server;
let browser: Browser;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  relay = await startRelay(RELAY_PORT);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close();
  await relay?.close();
});

async function chooseServerMode(page: Page): Promise<void> {
  await expect(page.locator('[data-screen="online"]')).toBeVisible();
  const ws = page.locator('.sg-online-mode .sg-seg button[data-value="ws"]');
  await ws.click();
  // served by our server: the relay is on the same origin, nothing to configure
  await expect(page.locator('.sg-online .sg-note')).toContainText('/ws');
  await expect(page.locator('.sg-online .sg-warn')).toHaveCount(0);
}

/** Positions of the other human players' heroes as this page sees them. */
async function othersSeen(page: Page): Promise<Record<number, { x: number; z: number }>> {
  return page.evaluate(() => {
    const g = (window as SgwlWindow).__sgwl!;
    const me = g.localId();
    const out: Record<number, { x: number; z: number }> = {};
    for (const p of g.players()) {
      if (p.isBot || p.entityId === me) continue;
      const e = (g as unknown as { view: { get(id: number): { x: number; z: number } | undefined } }).view.get(p.entityId);
      if (e) out[p.entityId] = { x: e.x, z: e.z };
    }
    return out;
  });
}

/** A guest back in the match after a relay blip within this (seamless rejoin: ~0.1 s idle, a few s on a loaded machine). */
const BLIP_RECONNECT_MS = 15_000;
/** The host's page freezes this long (under the guests' 15 s host timeout: no rejoin, just "Waiting for host…"). */
const HOST_FREEZE_MS = 8_000;

type StatusWindow = SgwlWindow & { __e2eStatus?: string[] };

/** Record the session's connection status lines (English) from now on. */
async function recordStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as StatusWindow;
    if (w.__e2eStatus) return;
    const log: string[] = (w.__e2eStatus = []);
    w.__sgwl!.session!.on('status', (s) => log.push(s.en));
  });
}

const statusLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as StatusWindow).__e2eStatus ?? []);

/** NET-4: each guest page freezes this long, this many times back to back, while it builds the match scene. */
const SLOW_PHONE_FREEZES = [12_000, 12_000, 12_000];

type SlowWindow = SgwlWindow & { __e2eFrozen?: number };

/**
 * Make this page a slow phone: once its match view exists (the scene build starts),
 * it freezes SLOW_PHONE_FREEZES[i] ms at a time with only a short breath in between.
 */
async function slowPhone(page: Page): Promise<void> {
  await page.evaluate((freezes) => {
    const w = window as SlowWindow;
    w.__e2eFrozen = 0;
    let armed = true;
    w.__sgwl!.session!.on('matchStart', () => {
      if (!armed) return;
      armed = false;
      const next = (i: number): void => {
        if (i >= freezes.length) return;
        setTimeout(() => {
          const end = performance.now() + freezes[i]!;
          while (performance.now() < end) {
            /* building the scene on a slow device */
          }
          w.__e2eFrozen! += freezes[i]!;
          next(i + 1);
        }, 150);
      };
      next(0);
    });
  }, SLOW_PHONE_FREEZES);
}
const sessionId = (page: Page): Promise<string> => page.evaluate(() => (window as SgwlWindow).__sgwl!.session!.myId);
const matchClock = (page: Page): Promise<number> => page.evaluate(() => (window as SgwlWindow).__sgwl!.elapsed());
const humansSeen = (page: Page): Promise<number> => page.evaluate(() => (window as SgwlWindow).__sgwl!.players().filter((p) => !p.isBot).length);

/** Wait until this page's match clock ran `seconds` past its reading now (the match goes on for it). */
async function clockRuns(page: Page, seconds: number, timeout: number, what: string): Promise<void> {
  const t0 = await matchClock(page);
  await expect.poll(async () => (await matchClock(page)) - t0, { message: `${what}: the match clock runs`, timeout }).toBeGreaterThan(seconds);
}

/**
 * A short relay drop: the guest's socket to the relay closes. The guest must rejoin
 * the running match by itself within BLIP_RECONNECT_MS — same game view (no loading
 * screen), its seat never handed to a bot.
 */
async function blipGuest(guest: Page, host: Page): Promise<void> {
  const oldId = await guest.evaluate(() => {
    document.querySelector<HTMLCanvasElement>('.sg-game canvas')!.dataset.e2e = 'before-blip';
    return (window as SgwlWindow).__sgwl!.session!.myId;
  });
  const t0 = Date.now();
  await guest.evaluate(() => ((window as SgwlWindow).__sgwl!.session as unknown as { transport: { ws: WebSocket } }).transport.ws.close());
  await guest.waitForFunction(
    (old) => {
      const g = (window as SgwlWindow).__sgwl!;
      return g.session!.myId !== old && g.screen === 'match' && g.phase === 'playing' && g.localEntity() !== null;
    },
    oldId,
    { timeout: BLIP_RECONNECT_MS, polling: 100 },
  );
  const backMs = Date.now() - t0;
  const kept = await guest.evaluate(() => {
    const c = document.querySelectorAll<HTMLCanvasElement>('.sg-game canvas');
    return c.length === 1 && c[0]!.dataset.e2e === 'before-blip';
  });
  console.log(`[online e2e] relay blip: guest back in the match after ${backMs} ms, same view: ${kept}`);
  expect(kept, 'the rejoin keeps the game view (no loading screen, no rebuild)').toBe(true);
  expect(await statusLog(guest)).toContain('Reconnected');
  await clockRuns(guest, 2, 20_000, 'guest after the blip');
  await expect.poll(() => humansSeen(host), { message: 'the host still has three humans', timeout: 10_000 }).toBe(3);
}

/**
 * The host's page freezes for HOST_FREEZE_MS (a long GC / shader compile / debugger
 * pause). The guests show "Waiting for host…" meanwhile, then recover on the same
 * connection, and the match goes on: clocks run, a guest's input reaches the host —
 * `mover` walks back ('s') along the path it walked forward earlier (forward it may
 * now face a wall: the Lord spawns inside the palace).
 */
async function freezeHost(host: Page, guests: Page[], mover: Page): Promise<void> {
  const ids = await Promise.all(guests.map(sessionId));
  const waited = guests.map(() => false);
  let frozen = true;
  const watch = (async () => {
    while (frozen) {
      for (const [i, g] of guests.entries()) {
        const w = await g.evaluate(() => ((window as SgwlWindow).__sgwl!.session as unknown as { waitingForHost?: boolean }).waitingForHost === true).catch(() => false);
        if (w) waited[i] = true;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  const t0 = Date.now();
  await host.evaluate((ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      /* the host's main thread is stuck */
    }
  }, HOST_FREEZE_MS);
  frozen = false;
  await watch;
  console.log(`[online e2e] host frozen for ${Date.now() - t0} ms; guests saw "Waiting for host…": ${JSON.stringify(waited)}`);
  expect(waited, 'every guest shows "Waiting for host…" while the host is frozen').toEqual(guests.map(() => true));
  for (const g of guests) {
    await g.waitForFunction(() => ((window as SgwlWindow).__sgwl!.session as unknown as { waitingForHost?: boolean }).waitingForHost === false, null, { timeout: 20_000, polling: 250 });
  }
  // the match goes on for everyone
  await Promise.all([host, ...guests].map((p, i) => clockRuns(p, 2, 30_000, i === 0 ? 'host after the freeze' : `guest ${i} after the freeze`)));
  // recovered on the same connection: no rejoin was needed
  expect(await Promise.all(guests.map(sessionId))).toEqual(ids);
  for (const g of guests) expect(await statusLog(g)).toEqual(expect.arrayContaining(['Waiting for host…', 'Host is responding again']));
  expect(await humansSeen(host)).toBe(3);
  // a guest's input reaches the host again: the host sees that guest walk
  const moverId = await mover.evaluate(() => (window as SgwlWindow).__sgwl!.localId());
  const from = (await othersSeen(host))[moverId!];
  expect(from, 'the host sees the guest hero').toBeTruthy();
  await mover.keyboard.down('s');
  try {
    await expect
      .poll(
        async () => {
          const p = (await othersSeen(host))[moverId!];
          return p ? Math.hypot(p.x - from!.x, p.z - from!.z) : 0;
        },
        { message: 'the host sees the guest move after the freeze', timeout: 60_000, intervals: [1000] },
      )
      .toBeGreaterThan(1.2);
  } finally {
    await mover.keyboard.up('s');
  }
}

test('online (ws relay, same origin): host + 2 guests join by room code, play, see each other move, survive a relay blip and a host freeze', async () => {
  test.setTimeout(15 * 60_000);
  const pages: GamePage[] = [];
  try {
    const host = await openGame(browser, `${relay.url}?debug=1`, { viewport: VIEWPORT, name: '主持人' });
    pages.push(host);
    await host.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await chooseServerMode(host.page);
    await host.page.locator('.sg-online-cols .col .sg-btn.gold').click();
    await expect(host.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 30_000 });
    const code = (await host.page.locator('[data-screen="lobby"] .room-code .code').textContent())!.trim();
    console.log(`[online e2e] room ${code}`);

    for (const name of ['客人甲', '客人乙']) {
      const g = await openGame(browser, `${relay.url}?debug=1&room=${code}`, { viewport: VIEWPORT, name });
      pages.push(g);
      await chooseServerMode(g.page);
      await expect(g.page.locator('.sg-code-input')).toHaveValue(code);
      await g.page.locator('.join-row .sg-btn').click();
      await expect(g.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(code, { timeout: 30_000 });
      await g.page.locator('.lobby-foot .sg-btn.gold').click(); // ready
    }
    await expect(host.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(3, { timeout: 30_000 });
    // from here on every connection status line is recorded; the guests are slow phones
    for (const g of pages) await recordStatus(g.page);
    for (const g of pages.slice(1)) await slowPhone(g.page);
    await host.page.locator('.lobby-foot .sg-btn.gold').click();
    // (all guests are ready: no "start anyway?" confirm — accept it if it shows up)
    const confirm = host.page.locator('.sg-modal .actions .sg-btn').last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    // roles → hero select → match on every client
    await Promise.all(pages.map((g) => expect(g.page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 })));
    const heroes = await Promise.all(pages.map((g) => pickHero(g.page)));
    console.log(`[online e2e] heroes: ${heroes.join(', ')}`);
    const loadStart = Date.now();
    await Promise.all(pages.map((g) => waitMatch(g.page, 300_000)));
    const frozenMs = () => Promise.all(pages.slice(1).map((g) => g.page.evaluate(() => (window as SlowWindow).__e2eFrozen ?? 0)));
    // (the last freeze may land on the first frames right after loading)
    const total = SLOW_PHONE_FREEZES.reduce((a, b) => a + b, 0);
    await expect.poll(frozenMs, { message: 'the slow-phone freezes ran', timeout: 60_000 }).toEqual(pages.slice(1).map(() => total));
    const loadLines = await Promise.all(pages.map((g) => statusLog(g.page)));
    console.log(`[online e2e] slow phones: match up after ${((Date.now() - loadStart) / 1000).toFixed(0)} s, each guest frozen ${total} ms; status lines: ${JSON.stringify(loadLines)}`);
    // NET-4: nobody was dropped for building the scene slowly — no "disconnected / a bot
    // takes over" on the host, no "connection lost — reconnecting" on a guest
    expect(loadLines.flat().filter((l) => /disconnected|bot takes over|lost|reconnect/i.test(l))).toEqual([]);
    for (const g of pages) {
      // (a guest's view may need a snapshot or two for the full player list)
      const st = () => g.page.evaluate(() => ({ phase: (window as SgwlWindow).__sgwl!.phase, humans: (window as SgwlWindow).__sgwl!.players().filter((p) => !p.isBot).length }));
      await expect.poll(st, { message: 'every client plays with 3 humans', timeout: 10_000 }).toEqual({ phase: 'playing', humans: 3 });
    }

    // everyone walks forward; every client must see the two other heroes move
    for (const g of pages) await enterGame(g.page);
    const before = await Promise.all(pages.map((g) => othersSeen(g.page)));
    const start = await Promise.all(pages.map((g) => localPos(g.page)));
    await Promise.all(pages.map((g) => g.page.keyboard.down('w')));
    const end = Date.now() + 90_000;
    let ok = false;
    let last: Record<number, { x: number; z: number }>[] = [];
    while (!ok && Date.now() < end) {
      await pages[0].page.waitForTimeout(1000);
      last = await Promise.all(pages.map((g) => othersSeen(g.page)));
      ok = last.every((seen, i) => {
        const ids = Object.keys(before[i]);
        return ids.length === 2 && ids.every((id) => {
          const a = before[i][Number(id)];
          const b = seen[Number(id)];
          return !!b && Math.hypot(b.x - a.x, b.z - a.z) > 1.5;
        });
      });
    }
    await Promise.all(pages.map((g) => g.page.keyboard.up('w')));
    const after = await Promise.all(pages.map((g) => localPos(g.page)));
    const moved = after.map((p, i) => Math.hypot(p.x - start[i].x, p.z - start[i].z));
    console.log(`[online e2e] own moves: ${moved.map((d) => d.toFixed(1)).join(' / ')} m`);
    expect(ok, `every client sees both other heroes move: before ${JSON.stringify(before)} after ${JSON.stringify(last)}`).toBe(true);
    for (const [i, g] of pages.entries()) await g.page.screenshot({ path: test.info().outputPath(`client-${i}.png`) });

    // ── NET-3: connection trouble in the running match ─────────────────────────
    for (const g of pages) await recordStatus(g.page);
    await blipGuest(pages[1].page, host.page);
    // the guest that walked the farthest above retraces its steps after the freeze
    const mover = moved[1]! >= moved[2]! ? pages[1] : pages[2];
    await freezeHost(host.page, [pages[1].page, pages[2].page], mover.page);
    const lines = await Promise.all(pages.map((g) => statusLog(g.page)));
    console.log(`[online e2e] status lines: ${JSON.stringify(lines)}`);
    // nobody was ever announced as dropped / handed to a bot
    expect(lines.flat().filter((l) => /disconnected|bot takes over/i.test(l))).toEqual([]);
    for (const g of pages) expect(relevantErrors(g.errors)).toEqual([]);
  } finally {
    for (const g of pages) await g.ctx.close();
  }
});

test('P2P invite on a server-served page joins in P2P without touching the mode; F5 mid-match reclaims the seat in P2P', async () => {
  test.setTimeout(15 * 60_000);
  const pages: GamePage[] = [];
  // the host uses the server's own PeerJS signalling (no internet here): a non-default PeerJS server
  const peer = { mode: 'peer', peerHost: '127.0.0.1', peerPort: RELAY_PORT, peerPath: '/peerjs', peerSecure: false };
  try {
    const host = await openGame(browser, `${relay.url}?debug=1`, { viewport: VIEWPORT, name: '主持人', settings: { net: peer } });
    pages.push(host);
    await host.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: relay.url.replace(/\/$/, '') });
    await host.page.locator('.sg-menu-btn', { hasText: '联机对战' }).click();
    await expect(host.page.locator('[data-screen="online"]')).toBeVisible();
    await host.page.locator('.sg-online-mode .sg-seg button[data-value="peer"]').click();
    await host.page.locator('.sg-online-cols .col .sg-btn.gold').click();
    await expect(host.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(/^[A-Z0-9]{4,8}$/, { timeout: 60_000 });
    const code = (await host.page.locator('[data-screen="lobby"] .room-code .code').textContent())!.trim();
    await host.page.locator('.lobby-head .sg-btn', { hasText: '复制邀请链接' }).click();
    await expect.poll(() => host.page.evaluate(() => navigator.clipboard.readText().catch(() => '')), { timeout: 10_000 }).toContain(code);
    const link = await host.page.evaluate(() => navigator.clipboard.readText());
    console.log(`[online e2e] P2P invite: ${link}`);
    const q = new URL(link).searchParams;
    expect(q.get('mode')).toBe('peer');
    expect(q.get('ph')).toBe('127.0.0.1');
    expect(q.get('pa')).toBe('/peerjs');

    // a fresh guest (default settings: public PeerJS cloud) opens the invite on the server-served page
    const guest = await openGame(browser, `${link}&debug=1`, { viewport: VIEWPORT, name: '远客' });
    pages.push(guest);
    await expect(guest.page.locator('[data-screen="online"]')).toBeVisible();
    await expect(guest.page.locator('.sg-code-input')).toHaveValue(code);
    // the server probe must not flip the mode the link asked for
    await guest.page.waitForTimeout(3000);
    await expect(guest.page.locator('.sg-online-mode .sg-seg button[data-value="peer"]')).toHaveAttribute('aria-pressed', 'true');
    await guest.page.locator('.join-row .sg-btn').click();
    await expect(guest.page.locator('[data-screen="lobby"] .room-code .code')).toHaveText(code, { timeout: 60_000 });
    await guest.page.locator('.lobby-foot .sg-btn.gold').click(); // ready
    await expect(host.page.locator('.seat:not(.empty):not(.bot)')).toHaveCount(2, { timeout: 30_000 });
    await host.page.locator('.lobby-foot .sg-btn.gold').click();
    const confirm = host.page.locator('.sg-modal .actions .sg-btn').last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await Promise.all(pages.map((g) => expect(g.page.locator('[data-screen="roles"]')).toBeVisible({ timeout: 60_000 })));
    const heroes = await Promise.all(pages.map((g) => pickHero(g.page)));
    await Promise.all(pages.map((g) => waitMatch(g.page, 300_000)));
    const guestHero = await guest.page.evaluate(() => (window as SgwlWindow).__sgwl!.local()!.heroId);
    expect(guestHero).toBe(heroes[1]);
    expect(await guest.page.evaluate(() => JSON.parse(sessionStorage.getItem('sgwl.rejoin.v1') ?? 'null'))).toMatchObject({ code, mode: 'peer' });
    // the seat token (sessionStorage) must survive the unload: the reloaded tab reclaims
    // its seat with it, not just by player name. Read it before the new page's app runs.
    const tokenKey = `sgwl-seat-${code}`;
    const seatToken = await guest.page.evaluate((k) => sessionStorage.getItem(k), tokenKey);
    expect(seatToken, 'the guest holds a seat token').toBeTruthy();
    await guest.page.addInitScript((k) => {
      (window as Window & { __seatAtBoot?: string | null }).__seatAtBoot = sessionStorage.getItem(k);
    }, tokenKey);

    // NET-4: the host's link to the PeerJS signalling server drops now and stays down
    // (its automatic reconnect is held) until the reloading guest has been told "peer
    // unavailable" at least once: a transient answer the guest must not take for
    // "room not found" — it keeps asking, and gets in once the host is back.
    await host.page.evaluate(() => {
      type HeldPeer = { reconnect(): void; disconnect(): void };
      const w = window as SgwlWindow & { __e2eSignallingBack?: () => void };
      const peer = ((w.__sgwl!.session as unknown as { transport: { peer: HeldPeer } }).transport).peer;
      const reconnect = peer.reconnect.bind(peer);
      peer.reconnect = () => undefined; // PeerTransport's reconnect after 2 s does nothing …
      peer.disconnect();
      w.__e2eSignallingBack = () => {
        peer.reconnect = reconnect; // … until the network is back
        reconnect();
      };
    });
    const retries: string[] = [];
    guest.page.on('console', (m) => {
      if (/^\[net\] room not found .*asking again/.test(m.text())) retries.push(m.text());
    });

    // F5 mid-match: the tab rejoins the same room over P2P and gets its hero back.
    // The reload cancels the old page's in-flight art downloads (GLB bodies, clips and
    // textures still streaming in after the load budget), and the dying page logs
    // "Failed to fetch" for each. That is not an error of the game: drop what the old
    // document logged before the new one commits, and keep checking the new page.
    const loggedBeforeF5 = guest.errors.length;
    const f5At = Date.now();
    await guest.page.reload({ waitUntil: 'commit' });
    guest.errors.splice(loggedBeforeF5);
    const joinState = async (): Promise<string> => {
      if (retries.length > 0) return 'keeps asking';
      const err = await guest.page.evaluate(() => document.querySelector('[data-screen="online"] .err')?.textContent ?? null).catch(() => null);
      return err ? `gave up: ${err}` : 'joining';
    };
    await expect.poll(joinState, { message: 'the reloaded guest keeps asking for the unavailable host peer', timeout: 90_000 }).toBe('keeps asking');
    const downFor = Date.now() - f5At;
    await host.page.evaluate(() => (window as SgwlWindow & { __e2eSignallingBack?: () => void }).__e2eSignallingBack!());
    await waitMatch(guest.page, 300_000);
    console.log(`[online e2e] host signalling down ${(downFor / 1000).toFixed(1)} s after the F5; guest retries: ${JSON.stringify(retries)}; back in the match ${((Date.now() - f5At) / 1000).toFixed(1)} s after the F5`);
    const after = await guest.page.evaluate((k) => {
      const g = (window as SgwlWindow).__sgwl!;
      return {
        kind: g.sessionKind,
        phase: g.phase,
        hero: g.local()?.heroId,
        rejoin: JSON.parse(sessionStorage.getItem('sgwl.rejoin.v1') ?? 'null'),
        seatAtBoot: (window as Window & { __seatAtBoot?: string | null }).__seatAtBoot ?? null,
        seat: sessionStorage.getItem(k),
      };
    }, tokenKey);
    console.log(`[online e2e] after F5: ${JSON.stringify(after)}`);
    expect(after).toMatchObject({ kind: 'guest', phase: 'playing', hero: guestHero, rejoin: { code, mode: 'peer' }, seatAtBoot: seatToken, seat: seatToken });
    // the host's own view can trail the guest by a frame or two (a slow SwiftShader frame
    // with the art loaded): poll instead of reading once
    const humans = () => host.page.evaluate(() => (window as SgwlWindow).__sgwl!.players().filter((p) => !p.isBot).length);
    await expect.poll(humans, { message: 'the host sees the guest human again', timeout: 20_000 }).toBe(2);
    await guest.page.screenshot({ path: test.info().outputPath('p2p-after-f5.png') });
    for (const g of pages) expect(relevantErrors(g.errors)).toEqual([]);
  } finally {
    for (const g of pages) await g.ctx.close();
  }
});
