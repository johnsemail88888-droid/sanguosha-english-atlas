// Loopback test harness: an in-process host + N clients over LoopbackNetwork,
// with a FakeSim (or a custom sim factory). Every payload a client receives is
// logged for hidden-information scans.
import type { HeroSelectView, MatchSettings } from '../../../src/core/types';
import type { MatchInit, SimHost } from '../../../src/sim/host';
import { ClientSession, type ClientSessionOptions } from '../../../src/net/clientSession';
import { FakeSim, type FakeSimOptions } from '../../../src/net/fakeSim';
import { HostSession, type FlowTimings } from '../../../src/net/hostSession';
import { LoopbackNetwork, type LoopbackTransport } from '../../../src/net/loopback';
import type { Payload } from '../../../src/net/transport';
import { flatMap, testHeroPool, waitFor } from './fixtures';

export const FAST: Partial<FlowTimings> = {
  roleReveal: 0.03,
  lordPick: 0.5,
  pick: 0.5,
  pickReveal: 0.01,
  loadTimeout: 3,
  postGame: 0.1,
  pingInterval: 0.2,
  peerTimeout: 5,
  // a closed connection hands the seat to a bot at once (tests of the drop grace set their own)
  dropGrace: 0,
};

export interface ClientRec {
  name: string;
  session: ClientSession;
  transport: LoopbackTransport;
  /** every payload this client received, in order (across rejoins) */
  log: Payload[];
}

export interface Harness {
  net: LoopbackNetwork;
  host: HostSession;
  sims: FakeSim[];
  clients: ClientRec[];
}

let current: Harness | null = null;

/** Tear down the harness created last (call from afterEach). */
export function cleanupHarness(): void {
  if (!current) return;
  for (const c of current.clients) c.session.leave();
  current.host.leave();
  current = null;
}

/** Forget the current harness without tearing it down (it was closed by the test). */
export function forgetHarness(): void {
  current = null;
}

export interface MakeHostOptions {
  seed?: number;
  settings?: Partial<MatchSettings>;
  fake?: FakeSimOptions;
  timings?: Partial<FlowTimings>;
  /** custom sim factory (defaults to FakeSim on a flat map) */
  createMatch?: (init: MatchInit) => SimHost | Promise<SimHost>;
}

export function makeHost(opts: MakeHostOptions = {}): Harness {
  const net = new LoopbackNetwork();
  const sims: FakeSim[] = [];
  const host = new HostSession({
    name: '房主',
    transport: net.createHost('host'),
    roomCode: 'TEST2',
    heroes: testHeroPool(),
    timings: { ...FAST, ...opts.timings },
    seed: opts.seed ?? 42,
    preferWorkerTicker: false,
    settings: opts.settings,
    createMatch:
      opts.createMatch ??
      ((init) => {
        const sim = new FakeSim(init, { map: flatMap(), ...opts.fake });
        sims.push(sim);
        return sim;
      }),
  });
  const h: Harness = { net, host, sims, clients: [] };
  current = h;
  return h;
}

export async function addClient(h: Harness, name: string, extra: Partial<ClientSessionOptions> = {}): Promise<ClientRec> {
  const transport = await h.net.connect();
  const log: Payload[] = [];
  transport.onMessage((_from, data) => log.push(data));
  const rec = { name, transport, log } as ClientRec;
  rec.session = await ClientSession.connect({ transport, name, mapFactory: () => flatMap(), ...extra });
  h.clients.push(rec);
  return rec;
}

/** A reconnect factory for addClient that keeps logging into `rec.log`. */
export function loopbackReconnect(h: Harness, rec: () => ClientRec | undefined): () => Promise<LoopbackTransport> {
  return async () => {
    const t = await h.net.connect();
    t.onMessage((_from, data) => rec()?.log.push(data));
    const r = rec();
    if (r) r.transport = t;
    return t;
  };
}

/** Every human picks their first option as soon as it is their turn. */
export function autoPick(h: Harness): void {
  const pickFor = (seatOf: () => number, pick: (id: string) => void) => (v: HeroSelectView) => {
    const seat = seatOf();
    if (v.options.length > 0 && v.picks[seat] === undefined) pick(v.options[0]);
  };
  h.host.on('heroSelect', pickFor(() => 0, (id) => h.host.pickHero(id)));
  for (const c of h.clients) c.session.on('heroSelect', pickFor(() => c.session.mySeat, (id) => c.session.pickHero(id)));
}

export const allPhases = (h: Harness): string[] => [h.host.phase, ...h.clients.map((c) => c.session.phase)];

export async function runToPlaying(h: Harness): Promise<void> {
  autoPick(h);
  h.host.start();
  await waitFor(() => allPhases(h).every((p) => p === 'playing'), 5000, 'everyone playing');
}

/** Simulate render frames on every client view for `seconds` of wall time. */
export async function drive(h: Harness, seconds: number, input?: (c: ClientRec, i: number) => void): Promise<void> {
  const end = Date.now() + seconds * 1000;
  let i = 0;
  let last = performance.now();
  while (Date.now() < end) {
    const now = performance.now();
    for (const c of h.clients) {
      const v = c.session.view;
      if (!v) continue;
      input?.(c, i);
      v.update((now - last) / 1000);
    }
    h.host.view?.update((now - last) / 1000);
    last = now;
    i++;
    await new Promise((r) => setTimeout(r, 16));
  }
}
