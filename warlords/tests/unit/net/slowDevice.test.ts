// NET-4: a guest on a slow device freezes for many seconds at a time while its
// page builds the match scene (map, models, shader compilation) and while it
// renders its first frames. It must never be dropped for that — neither by the
// host's peer timeout nor by its own host watchdog or rejoin timeouts — while a
// link that really died is still detected promptly in the match.
//
// The host-side scenarios run on fake timers at real-world scale (default
// timings, a minute and more of loading) with a hand-driven guest whose "page"
// reads and answers nothing while it is busy, like a frozen browser tab.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyInput, PROTOCOL_VERSION } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { encodeInputMsg, encodeJson } from '../../../src/net/codec';
import { FakeSim } from '../../../src/net/fakeSim';
import { DEFAULT_TIMINGS, HostSession } from '../../../src/net/hostSession';
import { LoopbackNetwork, type LoopbackTransport } from '../../../src/net/loopback';
import type { ClientMsg, HostMsg } from '../../../src/net/protocol';
import { NetError } from '../../../src/net/errors';
import type { Payload } from '../../../src/net/transport';
import { flatMap, testHeroPool, waitFor } from './fixtures';
import { addClient, cleanupHarness, FAST, loopbackReconnect, makeHost, type ClientRec } from './harness';

afterEach(() => {
  vi.useRealTimers();
  cleanupHarness();
});

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });

/** Advance fake time in small steps so the loopback's queued deliveries (microtasks) run in between. */
async function advance(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
}

/** The real connection timings; only the pre-match flow is sped up. */
const REAL_TIMINGS = {
  ...FAST,
  loadTimeout: DEFAULT_TIMINGS.loadTimeout,
  pingInterval: DEFAULT_TIMINGS.pingInterval,
  peerTimeout: DEFAULT_TIMINGS.peerTimeout,
  dropGrace: DEFAULT_TIMINGS.dropGrace,
  loadGrace: DEFAULT_TIMINGS.loadGrace,
  loadDropGrace: DEFAULT_TIMINGS.loadDropGrace,
};

/**
 * A guest's page, driven by hand: while `busy` it reads nothing and sends nothing
 * (messages queue up, as in a browser tab stuck in a long task); when it is free
 * it answers pings, picks the first hero offered and, once told, streams input.
 */
class SlowPage {
  readonly got: HostMsg[] = [];
  seat = -1;
  token: string | null = null;
  private busyUntil = 0;
  private queue: Payload[] = [];
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(
    readonly t: LoopbackTransport,
    readonly name: string,
  ) {
    t.onMessage((_f, d) => {
      if (this.busy) this.queue.push(d);
      else this.handle(d);
    });
  }

  get busy(): boolean {
    return performance.now() < this.busyUntil;
  }

  hello(token?: string): void {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, ...(token ? { token } : {}) });
  }

  /** One long task: the page is frozen for `ms`, then handles what queued up meanwhile. */
  freeze(ms: number): Promise<void> {
    this.busyUntil = performance.now() + ms;
    return new Promise((resolve) =>
      setTimeout(() => {
        const q = this.queue;
        this.queue = [];
        for (const d of q) this.handle(d);
        resolve();
      }, ms),
    );
  }

  /** Long tasks back to back: nothing is read in between (a staged scene build / shader compile). */
  async freezeChain(...ms: number[]): Promise<void> {
    this.busyUntil = performance.now() + ms.reduce((a, b) => a + b, 0);
    for (const m of ms) await new Promise((r) => setTimeout(r, m));
    const q = this.queue;
    this.queue = [];
    for (const d of q) this.handle(d);
  }

  send(msg: ClientMsg): void {
    if (!this.busy) this.t.send('host', encodeJson(msg));
  }

  /** The view renders: input packets at ~30 Hz whenever the page is not busy. */
  play(): void {
    this.inputTimer ??= setInterval(() => {
      if (this.busy) return;
      this.t.send('host', encodeInputMsg({ frame: { ...emptyInput(), seq: ++this.seq }, history: [] }), 'unreliable');
    }, 33);
  }

  stop(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
  }

  private handle(d: Payload): void {
    if (typeof d !== 'string') return; // snapshots
    const m = JSON.parse(d) as HostMsg;
    this.got.push(m);
    if (m.t === 'welcome') {
      this.seat = m.seat;
      this.token = m.token ?? null;
    }
    if (m.t === 'ping') this.send({ t: 'pong', id: m.id, ts: m.ts });
    if (m.t === 'heroSelect' && m.view.options.length > 0 && m.view.picks[this.seat] === undefined) this.send({ t: 'pick', heroId: m.view.options[0] });
  }
}

/** Fake-timer host (real connection timings) + one slow guest in the lobby. */
async function slowRoom(seed: number) {
  fakeTimers();
  const h = makeHost({ seed, timings: REAL_TIMINGS });
  const notices: string[] = [];
  h.host.on('status', (s) => notices.push(s.en));
  h.host.on('heroSelect', (v) => {
    if (v.options.length > 0 && v.picks[0] === undefined) h.host.pickHero(v.options[0]);
  });
  const t = await h.net.connect('slow');
  const g = new SlowPage(t, '慢机');
  g.hello();
  await advance(200);
  expect(g.seat).toBeGreaterThan(0);
  const seatOf = () => h.host.lobby.seats.find((s) => s.name === '慢机');
  return { h, g, notices, seatOf };
}

/** Start the match and wait (fake time) until the slow guest got matchStart. */
async function toMatchStart(h: ReturnType<typeof makeHost>, g: SlowPage): Promise<void> {
  h.host.start();
  for (let i = 0; i < 100 && !g.got.some((m) => m.t === 'matchStart'); i++) await advance(100);
  expect(g.got.some((m) => m.t === 'matchStart')).toBe(true);
}

describe('host: a guest on a slow device, loading the match', () => {
  it('stays in its seat through a minute and a half of loading in 10 s + 8 s freezes, and through a 17 s freeze on its first frames', async () => {
    const { h, g, notices, seatOf } = await slowRoom(41);
    await toMatchStart(h, g);
    // the page builds the map, the scene, the models, compiles shaders: 18 s at a time
    // without reading a message (two long tasks back to back), then answers what queued up
    for (let i = 0; i < 5; i++) {
      await Promise.all([g.freezeChain(10_000, 8_000), advance(18_000)]);
      await advance(200);
    }
    expect(h.host.phase).toBe('playing'); // the match did not wait for it (loadTimeout)
    expect(seatOf()?.isBot).toBe(false);
    g.send({ t: 'loaded' });
    g.play();
    await advance(500);
    // its first frames: another long freeze (remaining shaders, textures)
    await Promise.all([g.freeze(17_000), advance(17_000)]);
    await advance(10_000);
    expect(seatOf()?.isBot).toBe(false);
    expect(h.sims[0]!.conversions.filter((c) => c.kind === 'bot')).toEqual([]);
    expect(notices.filter((n) => /disconnected|left/.test(n))).toEqual([]);
    g.stop();
  });

  it('a link that dies in the match is still detected promptly: 15 s peer timeout (+ the drop grace)', async () => {
    const { h, g, notices, seatOf } = await slowRoom(42);
    await toMatchStart(h, g);
    await Promise.all([g.freezeChain(10_000, 8_000), advance(18_000)]);
    await advance(200);
    g.send({ t: 'loaded' });
    g.play();
    // it just stalled for 18 s: for a while its timeout is raised (2 × that silence) …
    await advance(10_000);
    // … and back to the normal 15 s once it has been answering steadily for a couple of minutes
    await advance(150_000);
    expect(seatOf()?.isBot).toBe(false);
    g.stop();
    h.net.sever('slow'); // a dead NAT mapping: no close, no goodbye
    const t0 = performance.now();
    while (!seatOf()?.isBot && performance.now() - t0 < 60_000) await advance(500);
    const detectedAfter = performance.now() - t0;
    expect(seatOf()?.isBot).toBe(true);
    // peerTimeout 15 s (checked every 2 s) + dropGrace 5 s
    expect(detectedAfter).toBeGreaterThan(15_000 + 5_000);
    expect(detectedAfter).toBeLessThan(15_000 + 2_000 + 5_000 + 1_000);
    expect(notices.some((n) => /disconnected/.test(n))).toBe(true);
  });

  it('a guest that goes silent for good while loading is dropped after loadGrace, not held forever', async () => {
    const { h, g, seatOf } = await slowRoom(43);
    await toMatchStart(h, g);
    h.net.sever('slow');
    await advance(DEFAULT_TIMINGS.loadGrace * 1000 - 5000);
    expect(seatOf()?.isBot).toBe(false);
    // loadGrace + ping period + loadDropGrace (it was loading when its link was judged dead)
    await advance(5000 + 2000 + DEFAULT_TIMINGS.loadDropGrace * 1000 + 1000);
    expect(seatOf()?.isBot).toBe(true);
  });

  it('a loading guest whose socket closes keeps its seat for loadDropGrace: back within it, no bot, no announcement', async () => {
    const { h, g, notices, seatOf } = await slowRoom(44);
    await toMatchStart(h, g);
    const token = g.token!;
    expect(token).toBeTruthy();
    h.net.dropClient('slow'); // the relay socket closed under the busy page
    await advance(12_000); // longer than dropGrace: its page was busy building the scene
    expect(seatOf()?.isBot).toBe(false);
    const back = new SlowPage(await h.net.connect('slow2'), '慢机');
    back.hello(token);
    await advance(500);
    expect(back.got.some((m) => m.t === 'welcome')).toBe(true);
    expect(back.got.some((m) => m.t === 'matchStart')).toBe(true);
    back.send({ t: 'loaded' });
    await advance(30_000);
    expect(seatOf()?.isBot).toBe(false);
    expect(h.sims[0]!.conversions.filter((c) => c.kind === 'bot')).toEqual([]);
    expect(notices.filter((n) => /disconnected/.test(n))).toEqual([]);
  });

  it('once loaded, a closed socket gets the normal drop grace', async () => {
    const { h, g, seatOf } = await slowRoom(45);
    await toMatchStart(h, g);
    g.send({ t: 'loaded' });
    await advance(1000);
    h.net.dropClient('slow');
    await advance(DEFAULT_TIMINGS.dropGrace * 1000 + 500);
    expect(seatOf()?.isBot).toBe(true);
  });
});

/** Block this (single) JS thread — host, client and every timer in the process freeze. */
function freezeThread(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* busy */
  }
}

describe('client: its own stalls never cost it the connection', () => {
  it('a welcome that queued up behind a page freeze longer than the hello timeout still gets it in', async () => {
    // messages travel through timers (30 ms latency), so after the freeze the late
    // hello timeout would run before the welcome — a wall-clock timeout rejected here
    const net = new LoopbackNetwork({ latencyMs: 30 });
    const host = new HostSession({
      name: '房主',
      transport: net.createHost('host'),
      roomCode: 'SLOW2',
      heroes: testHeroPool(),
      timings: FAST,
      seed: 5,
      preferWorkerTicker: false,
      createMatch: (init) => new FakeSim(init, { map: flatMap() }),
    });
    try {
      const t = await net.connect();
      const p = ClientSession.connect({ transport: t, name: 'A', helloTimeoutMs: 1000, mapFactory: () => flatMap() });
      freezeThread(2500); // the page is busy right after sending hello
      const s = await p;
      expect(s.phase).toBe('lobby');
      expect(s.mySeat).toBe(1);
      s.leave();
    } finally {
      host.leave();
    }
  });
});

describe('client: P2P rejoin when the host peer is briefly unavailable', () => {
  /** A reconnect factory that answers "room not found" `n` times first (PeerJS: host peer unavailable). */
  function flaky(h: ReturnType<typeof makeHost>, rec: () => ClientRec | undefined, n: number) {
    const real = loopbackReconnect(h, rec);
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= n) throw new NetError('roomNotFound');
      return real();
    };
    return { fn, calls: () => calls };
  }

  it('retries "room not found" with backoff (without using up its attempts) and gets back in', async () => {
    const h = makeHost({ seed: 46 });
    let a: ClientRec | undefined;
    const f = flaky(h, () => a, 2);
    // a single attempt: the two "room not found" answers must not count as attempts
    a = await addClient(h, 'A', { reconnect: f.fn, rejoinDelaysMs: [0], roomNotFoundRetryMs: 10_000 });
    const statuses: string[] = [];
    const errors: string[] = [];
    a.session.on('status', (s) => statuses.push(s.en));
    a.session.on('error', (e) => errors.push(e.code));
    const oldId = a.session.myId;
    h.net.dropClient(oldId);
    await waitFor(() => a!.session.myId !== oldId && statuses.includes('Reconnected'), 8000, 'rejoined');
    expect(f.calls()).toBe(3); // 1 s + 2 s of backoff in between
    expect(errors).toEqual([]);
  });

  it('gives up once the retry window is over: the host left', async () => {
    const h = makeHost({ seed: 47 });
    let a: ClientRec | undefined;
    const f = flaky(h, () => a, 1000);
    a = await addClient(h, 'A', { reconnect: f.fn, rejoinDelaysMs: [0, 100], roomNotFoundRetryMs: 1500 });
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    h.net.dropClient(a.session.myId);
    await waitFor(() => errors.length > 0, 8000, 'gave up');
    expect(errors).toEqual(['hostLeft']);
    expect(f.calls()).toBeGreaterThanOrEqual(2);
  });

  it('on the relay (no retry window) "room not found" is final at once, as before', async () => {
    const h = makeHost({ seed: 48 });
    let a: ClientRec | undefined;
    const f = flaky(h, () => a, 1000);
    a = await addClient(h, 'A', { reconnect: f.fn, rejoinDelaysMs: [0, 100, 200] });
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    h.net.dropClient(a.session.myId);
    await waitFor(() => errors.length > 0, 3000, 'hostLeft');
    expect(errors).toEqual(['hostLeft']);
    expect(f.calls()).toBe(1);
  });

  it('defaults: a P2P session retries for ROOM_NOT_FOUND_RETRY_MS, other transports do not', async () => {
    const h = makeHost({ seed: 49 });
    const t = await h.net.connect();
    Object.defineProperty(t, 'kind', { value: 'peer' });
    const s = await ClientSession.connect({ transport: t, name: 'P', mapFactory: () => flatMap() });
    expect((s as unknown as { roomNotFoundRetryMs: number }).roomNotFoundRetryMs).toBe(30_000);
    const b = await addClient(h, 'B');
    expect((b.session as unknown as { roomNotFoundRetryMs: number }).roomNotFoundRetryMs).toBe(0);
    s.leave();
  });
});
