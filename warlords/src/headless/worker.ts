// Server-run room: one node:worker_threads worker per room on the server
// (server/server.mjs, POST /api/rooms). The match runs here, headless — no
// renderer, no player of its own: every human is a normal client with a
// filtered view (nobody, not even the room's creator, sees hidden roles), and
// the room owner — the creator, presenting the owner key — has the lobby powers
// through 'owner' messages (net/hostSession.ts, headless mode).
//
// Built into one self-contained file by `npm run build:headless`
// (vite.headless.config.ts → dist-headless/room-worker.mjs, Node builtins only).
//
//   workerData  { relayUrl: 'ws://127.0.0.1:PORT/ws', ownerKey, name, lang,
//                 emptyLobbyMs, noHumansMs, log }
//   → parent    {type:'ready', code}                     the relay room exists
//               {type:'status', phase, humans, bots, players}   on changes, ≤ 1/s, always the latest
//               {type:'log', msg}                        (workerData.log)
//               {type:'closing', reason, detail?}        right before exiting
//   ← parent    {type:'shutdown'}                        tell the players, close, exit (< 3 s)
//
// Idle: nobody ever joined within emptyLobbyMs, or no human connected for
// noHumansMs (any phase) → closing 'idle'. The relay link lost for good →
// 'relay'. Anything thrown → 'error' and exit code 1.
//
// Imports HostSession directly — not net/index.ts, which pulls in the browser
// settings (localStorage).
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { MatchPhase } from '../core/types';
import type { HeroDef } from '../data/types';
import { HostSession, type FlowTimings } from '../net/hostSession';
import type { Transport } from '../net/transport';
import { WsTransport } from '../net/wsTransport';
import type { MatchInit, SimHost } from '../sim/host';

export interface HeadlessWorkerData {
  relayUrl: string;
  ownerKey: string;
  name: string;
  lang: 'zh' | 'en';
  emptyLobbyMs: number;
  noHumansMs: number;
  log: boolean;
}

export type ClosingReason = 'idle' | 'shutdown' | 'relay' | 'error';

export type WorkerToParent =
  | { type: 'ready'; code: string }
  | { type: 'status'; phase: MatchPhase; humans: number; bots: number; players: number }
  | { type: 'log'; msg: string }
  | { type: 'closing'; reason: ClosingReason; detail?: string };

export type ParentToWorker = { type: 'shutdown' };

/** A room nobody joined closes after this long (ms). */
export const DEFAULT_EMPTY_LOBBY_MS = 180_000;
/** A room without a connected human closes after this long, in any phase (ms). */
export const DEFAULT_NO_HUMANS_MS = 120_000;
/** Status messages at most this often (ms). */
export const STATUS_MIN_MS = 1000;
/** Idle / status check period (ms). */
export const CHECK_MS = 1000;
/** After 'closing': time for the 'leave' to reach the players and the relay socket to close cleanly (ms). */
export const EXIT_DELAY_MS = 500;

export interface HeadlessRoomOptions {
  /** the room's host transport (a relay room: WsTransport.host) */
  transport: Transport;
  roomCode: string;
  ownerKey: string;
  /** room display name (logs) */
  name?: string;
  lang?: 'zh' | 'en';
  emptyLobbyMs?: number;
  noHumansMs?: number;
  log?: boolean;
  /** to the parent (parentPort.postMessage) */
  post(msg: WorkerToParent): void;
  /** the room is closed ('closing' was posted): end the worker with this exit code */
  exit(code: number): void;
  // tests
  checkMs?: number;
  statusMinMs?: number;
  exitDelayMs?: number;
  timings?: Partial<FlowTimings>;
  createMatch?: (init: MatchInit) => SimHost | Promise<SimHost>;
  heroes?: readonly HeroDef[];
  seed?: number;
}

export interface HeadlessRoom {
  readonly session: HostSession;
  readonly code: string;
  /** closed ('closing' posted) */
  readonly closed: boolean;
  /**
   * Close the room: the players are told ('leave'), the transport closes, 'closing' is
   * posted and exit() follows. Idempotent (the first reason wins).
   */
  close(reason: ClosingReason, detail?: string): void;
}

/** Run a server-run room on an open host transport (the worker entry below; tests use a loopback one). */
export function runHeadlessRoom(opts: HeadlessRoomOptions): HeadlessRoom {
  const { transport, post } = opts;
  const emptyLobbyMs = Math.max(0, opts.emptyLobbyMs ?? DEFAULT_EMPTY_LOBBY_MS);
  const noHumansMs = Math.max(0, opts.noHumansMs ?? DEFAULT_NO_HUMANS_MS);
  const statusMinMs = Math.max(0, opts.statusMinMs ?? STATUS_MIN_MS);
  const name = opts.name || '服务器';
  const log = (msg: string): void => {
    if (opts.log) post({ type: 'log', msg: `[room ${opts.roomCode}] ${msg}` });
  };
  const session = new HostSession({
    name,
    transport,
    roomCode: opts.roomCode,
    headless: true,
    ownerKey: opts.ownerKey,
    preferWorkerTicker: false,
    timings: opts.timings,
    createMatch: opts.createMatch,
    heroes: opts.heroes,
    seed: opts.seed,
  });
  const clock = (): number => performance.now();
  const startedAt = clock();
  let closed = false;
  let noHumansSince: number | null = null;
  let lastStatus = '';
  let lastStatusAt = -Infinity;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubs: (() => void)[] = [];

  const sendStatus = (): void => {
    statusTimer = null;
    if (closed) return;
    const st = session.roomStats();
    const msg: WorkerToParent = { type: 'status', phase: session.phase, humans: st.humans, bots: st.bots, players: st.players };
    const key = `${msg.phase}|${msg.humans}|${msg.bots}|${msg.players}`;
    if (key === lastStatus) return;
    lastStatus = key;
    lastStatusAt = clock();
    post(msg);
  };
  /** A change: send the status now, or — within STATUS_MIN_MS of the last one — the latest once it is due. */
  const scheduleStatus = (): void => {
    if (closed || statusTimer !== null) return;
    const wait = lastStatusAt + statusMinMs - clock();
    if (wait <= 0) sendStatus();
    else statusTimer = setTimeout(sendStatus, wait);
  };

  const room: HeadlessRoom = {
    session,
    code: opts.roomCode,
    get closed() {
      return closed;
    },
    close(reason, detail) {
      if (closed) return;
      closed = true;
      clearInterval(checkTimer);
      if (statusTimer !== null) clearTimeout(statusTimer);
      statusTimer = null;
      for (const u of unsubs) u();
      log(`closing (${reason}${detail ? `: ${detail}` : ''})`);
      post(detail ? { type: 'closing', reason, detail } : { type: 'closing', reason });
      try {
        session.leave(); // tells every player ('leave'), closes the transport shortly after
      } catch (err) {
        console.error('[headless] leaving the room failed', err);
      }
      const code = reason === 'error' || reason === 'relay' ? 1 : 0;
      setTimeout(() => opts.exit(code), Math.max(0, opts.exitDelayMs ?? EXIT_DELAY_MS));
    },
  };

  const check = (): void => {
    if (closed) return;
    const st = session.roomStats();
    const t = clock();
    if (st.humansJoined === 0) {
      if (t - startedAt >= emptyLobbyMs) room.close('idle', `nobody joined within ${Math.round(emptyLobbyMs / 1000)} s`);
    } else if (st.humans === 0) {
      noHumansSince ??= t;
      if (t - noHumansSince >= noHumansMs) room.close('idle', `no players for ${Math.round(noHumansMs / 1000)} s`);
    } else {
      noHumansSince = null;
    }
    scheduleStatus();
  };
  const checkTimer = setInterval(check, Math.max(10, opts.checkMs ?? CHECK_MS));

  unsubs.push(
    session.on('lobby', scheduleStatus),
    session.on('phase', (p) => {
      log(`phase ${p}`);
      scheduleStatus();
    }),
    session.on('status', (s) => {
      if (s.key === undefined) log(s.en);
    }),
    session.on('error', (e) => log(`error ${e.code}: ${e.en}`)),
    // the relay link is gone for good (WsTransport gave up getting the room back)
    transport.onClose((err) => room.close('relay', err ? `${err.code}: ${err.message}` : 'relay link closed')),
  );

  post({ type: 'ready', code: opts.roomCode });
  log(`ready (${name}, ${opts.lang ?? 'zh'})`);
  sendStatus();
  return room;
}

function isWorkerData(d: unknown): d is HeadlessWorkerData {
  const w = d as Partial<HeadlessWorkerData> | null;
  return !!w && typeof w === 'object' && typeof w.relayUrl === 'string' && typeof w.ownerKey === 'string';
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

interface PortLike {
  postMessage(msg: unknown): void;
  on(ev: 'message', cb: (msg: unknown) => void): unknown;
}

export interface WorkerDeps {
  /** opens the room on the relay (default WsTransport.host) */
  openHost?: (relayUrl: string) => Promise<Transport & { roomCode?: string }>;
  exit?: (code: number) => void;
  /** process-wide error hooks (default: process 'uncaughtException' / 'unhandledRejection') */
  onFatal?: (cb: (err: unknown) => void) => void;
}

/**
 * The worker's main: open the relay room, run it, answer 'shutdown', turn anything thrown
 * into closing 'error' + exit(1). Exported for tests (with fake deps).
 */
export async function startWorker(data: HeadlessWorkerData, port: PortLike, deps: WorkerDeps = {}): Promise<HeadlessRoom | null> {
  const post = (m: WorkerToParent): void => {
    try {
      port.postMessage(m);
    } catch {
      /* the parent is gone */
    }
  };
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let room: HeadlessRoom | null = null;
  let done = false;
  let shutdownAsked = false;
  /** closing before the room exists (or after it failed to close itself) */
  const bail = (reason: ClosingReason, detail: string | undefined, code: number): void => {
    if (done) return;
    done = true;
    post(detail ? { type: 'closing', reason, detail } : { type: 'closing', reason });
    setTimeout(() => exit(code), 50);
  };
  const fatal = (err: unknown): void => {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[headless] fatal', err);
    if (room && !room.closed) room.close('error', detail);
    else bail('error', detail, 1);
  };
  const onFatal =
    deps.onFatal ??
    ((cb: (err: unknown) => void) => {
      process.on('uncaughtException', cb);
      process.on('unhandledRejection', cb);
    });
  onFatal(fatal);
  port.on('message', (m) => {
    if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'shutdown') return;
    shutdownAsked = true;
    if (room) room.close('shutdown');
  });
  let transport: Transport & { roomCode?: string };
  try {
    transport = await (deps.openHost ?? ((url: string) => WsTransport.host(url)))(data.relayUrl);
  } catch (err) {
    bail('relay', err instanceof Error ? err.message : String(err), 1);
    return null;
  }
  if (shutdownAsked) {
    transport.close();
    bail('shutdown', undefined, 0);
    return null;
  }
  try {
    room = runHeadlessRoom({
      transport,
      roomCode: transport.roomCode ?? '',
      ownerKey: data.ownerKey,
      name: typeof data.name === 'string' ? data.name : undefined,
      lang: data.lang === 'en' ? 'en' : 'zh',
      emptyLobbyMs: num(data.emptyLobbyMs, DEFAULT_EMPTY_LOBBY_MS),
      noHumansMs: num(data.noHumansMs, DEFAULT_NO_HUMANS_MS),
      log: data.log === true,
      post,
      exit: (code) => {
        done = true;
        exit(code);
      },
    });
  } catch (err) {
    transport.close();
    fatal(err);
    return null;
  }
  return room;
}

// Worker entry: runs only as a worker started with a room's workerData (importing this module elsewhere — tests — does nothing).
if (!isMainThread && parentPort && isWorkerData(workerData)) {
  const port = parentPort;
  void startWorker(workerData, port).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      port.postMessage({ type: 'closing', reason: 'error', detail } satisfies WorkerToParent);
    } finally {
      setTimeout(() => process.exit(1), 50);
    }
  });
}
