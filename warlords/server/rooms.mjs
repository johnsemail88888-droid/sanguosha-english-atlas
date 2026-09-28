// Server-hosted ("headless") rooms for 三国杀·枪火乱世: each room's match runs in its own
// worker_thread on this server — no renderer, nobody's browser — and every human is an
// ordinary client with a filtered view (not even the room's creator sees hidden roles).
// Plain ESM JavaScript (no build step) so Node and Electron can load it directly.
//
// The worker is the bundle `npm run build:headless` writes (dist-headless/room-worker.mjs).
// It connects to this server's own relay (/ws) as the room's host and talks to us with:
//   workerData  { relayUrl, ownerKey, name, lang, emptyLobbyMs, noHumansMs, log }
//   → parent    {type:'ready', code} once the relay room exists
//               {type:'status', phase, humans, bots, players}   (≤ 1/s, latest wins)
//               {type:'log', msg}
//               {type:'closing', reason: 'idle'|'shutdown'|'relay'|'error', detail?}  right before it exits
//   ← parent    {type:'shutdown'}  → the room says goodbye to its clients and exits within 3 s
// The worker ends itself when it idles (no human for a while); a crash or a stuck start is
// cleaned up here. Without the bundle (Electron, LAN copies, a failed build) nothing is offered:
// available() is false and clients host the room in their browser as before.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

/** How long a worker gets to exit after {type:'shutdown'} before it is terminated. */
export const SHUTDOWN_GRACE_MS = 3000;
/** Failed starts in a row after which server-hosted rooms pause (clients host in the browser meanwhile). */
export const FAILURES_BEFORE_PAUSE = 2;
/** How long they pause. */
export const FAILURE_PAUSE_MS = 10 * 60_000;
/** Longest room display name kept (characters). */
export const MAX_ROOM_NAME = 16;

/** An error with the HTTP answer it maps to (`status`, `{error: code}`). */
export class RoomsError extends Error {
  /**
   * @param {'headless-unavailable'|'rooms-full'|'rate-limited'|'worker-failed'} code
   * @param {number} status
   * @param {string} [detail]
   */
  constructor(code, status, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.status = status;
  }
}

/** A display name from the request: control characters out, whitespace collapsed, ≤ MAX_ROOM_NAME characters. */
export function cleanRoomName(name, fallback = '服务器') {
  if (typeof name !== 'string') return fallback;
  const s = Array.from(name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_ROOM_NAME)
    .join('');
  return s || fallback;
}

const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1000) : 0);

/**
 * @param {{ workerPath: string, relayUrl: () => string, maxRooms?: number, perIpPerMin?: number,
 *           readyTimeoutMs?: number, emptyLobbyMs?: number, noHumansMs?: number, enabled?: boolean,
 *           workerLog?: boolean, log?: (msg: string) => void, pauseAfterFailures?: number, pauseMs?: number,
 *           onReady?: (code: string) => void, onExit?: (code: string | null) => void }} opts
 *   enabled: false = off (HEADLESS=0); workerLog: ask the workers for their log lines;
 *   pauseAfterFailures / pauseMs: FAILURES_BEFORE_PAUSE / FAILURE_PAUSE_MS.
 *   onReady / onExit: the relay room of a worker that just became ready / just exited.
 */
export function createHeadlessRooms(opts) {
  const workerPath = opts.workerPath;
  const maxRooms = Math.max(0, opts.maxRooms ?? 4);
  const perIpPerMin = Math.max(1, opts.perIpPerMin ?? 6);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15000;
  const emptyLobbyMs = opts.emptyLobbyMs ?? 180_000;
  const noHumansMs = opts.noHumansMs ?? 120_000;
  const enabled = opts.enabled ?? true;
  const pauseAfterFailures = Math.max(1, opts.pauseAfterFailures ?? FAILURES_BEFORE_PAUSE);
  const pauseMs = Math.max(0, opts.pauseMs ?? FAILURE_PAUSE_MS);
  const log = opts.log ?? (() => {});

  /**
   * @typedef {{ worker: Worker, code: string | null, ip: string, createdAt: number, phase: string,
   *             humans: number, bots: number, players: number, ready: boolean,
   *             closing: string | null, exited: Promise<void> }} Room
   * @type {Set<Room>}
   */
  const rooms = new Set();
  /** @type {Map<string, number[]>} create times in the last minute, per client IP */
  const recent = new Map();
  let failuresInARow = 0;
  let pausedUntil = 0;
  let shuttingDown = null;

  const bundlePresent = () => {
    try {
      return fs.statSync(workerPath).isFile();
    } catch {
      return false;
    }
  };

  const available = () => enabled && !shuttingDown && Date.now() >= pausedUntil && bundlePresent();

  /** Sliding one-minute window per IP: true when `ip` may create another room now. */
  const allowed = (ip, now) => {
    const times = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (times.length) recent.set(ip, times);
    else recent.delete(ip);
    return times.length < perIpPerMin;
  };
  const remember = (ip, now) => {
    const times = recent.get(ip) ?? [];
    times.push(now);
    recent.set(ip, times);
    if (recent.size > 10_000) {
      // a flood of distinct addresses: forget the stale ones
      for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
    }
  };

  const tag = (room) => `[room ${room.code ?? '…'}]`;

  /**
   * Start a room for `ip`. Resolves with its code and the owner key once the worker's relay
   * room exists; rejects with a RoomsError.
   * @param {string} ip
   * @param {{ name?: unknown, lang?: unknown }} [req]
   * @returns {Promise<{ code: string, ownerKey: string }>}
   */
  function create(ip, req = {}) {
    if (!available()) return Promise.reject(new RoomsError('headless-unavailable', 503));
    const now = Date.now();
    if (!allowed(ip, now)) return Promise.reject(new RoomsError('rate-limited', 429));
    if (rooms.size >= maxRooms) return Promise.reject(new RoomsError('rooms-full', 503));
    remember(ip, now);

    const ownerKey = crypto.randomBytes(24).toString('base64url');
    const workerData = {
      relayUrl: opts.relayUrl(),
      ownerKey,
      name: cleanRoomName(req.name),
      lang: req.lang === 'en' ? 'en' : 'zh',
      emptyLobbyMs,
      noHumansMs,
      log: !!opts.workerLog,
    };
    let worker;
    try {
      worker = new Worker(workerPath, { workerData, name: 'sgwl-room', resourceLimits: { maxOldGenerationSizeMb: 512 } });
    } catch (err) {
      failed(`could not start: ${err?.message ?? err}`);
      return Promise.reject(new RoomsError('worker-failed', 500, String(err?.message ?? err)));
    }

    return new Promise((resolve, reject) => {
      /** @type {(v: void) => void} */
      let markExited = () => {};
      /** @type {Room} */
      const room = {
        worker,
        code: null,
        ip,
        createdAt: now,
        phase: 'starting',
        humans: 0,
        bots: 0,
        players: 0,
        ready: false,
        closing: null,
        exited: new Promise((r) => (markExited = r)),
      };
      rooms.add(room);
      let settled = false;
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failed(why);
        reject(new RoomsError('worker-failed', 500, why));
        worker.terminate().catch(() => {});
      };
      const timer = setTimeout(() => fail(`not ready after ${readyTimeoutMs} ms`), readyTimeoutMs);

      worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'ready': {
            if (settled || typeof msg.code !== 'string' || !msg.code || msg.code.length > 16) return;
            settled = true;
            clearTimeout(timer);
            room.code = msg.code;
            room.ready = true;
            room.phase = room.phase === 'starting' ? 'lobby' : room.phase;
            failuresInARow = 0;
            log(`[rooms] room ${room.code} started (${workerData.name}, ${ip}) — ${rooms.size}/${maxRooms} rooms`);
            try {
              opts.onReady?.(room.code);
            } catch {
              /* ignore */
            }
            resolve({ code: room.code, ownerKey });
            break;
          }
          case 'status':
            if (typeof msg.phase === 'string') room.phase = msg.phase.slice(0, 32);
            room.humans = count(msg.humans);
            room.bots = count(msg.bots);
            room.players = count(msg.players);
            break;
          case 'log':
            if (typeof msg.msg === 'string') {
              const text = msg.msg.slice(0, 2000);
              log(text.startsWith(tag(room)) ? text : `${tag(room)} ${text}`);
            }
            break;
          case 'closing':
            room.closing = typeof msg.reason === 'string' ? msg.reason : 'error';
            log(`${tag(room)} closing: ${room.closing}${typeof msg.detail === 'string' && msg.detail ? ` (${msg.detail.slice(0, 500)})` : ''}`);
            if (!settled) fail(`closed before it was ready (${room.closing})`);
            break;
          default:
            break;
        }
      });
      worker.on('error', (err) => {
        log(`${tag(room)} worker error: ${err?.stack ?? err?.message ?? err}`);
        fail(`crashed: ${err?.message ?? err}`);
      });
      worker.on('exit', (exitCode) => {
        rooms.delete(room);
        if (!settled) fail(`exited (${exitCode}) before it was ready`);
        if (room.ready) {
          log(`[rooms] room ${room.code} ended (${room.closing ?? `exit ${exitCode}`}) — ${rooms.size}/${maxRooms} rooms`);
        }
        try {
          opts.onExit?.(room.code);
        } catch {
          /* ignore */
        }
        markExited();
      });
    });
  }

  /**
   * A start that failed (a broken bundle, a machine too busy): after `pauseAfterFailures` in a row,
   * rooms pause — POST answers 503 meanwhile and clients host in their browser instead of failing.
   */
  function failed(why) {
    log(`[rooms] a room failed to start: ${why}`);
    if (shuttingDown) return;
    failuresInARow++;
    if (failuresInARow >= pauseAfterFailures) {
      pausedUntil = Date.now() + pauseMs;
      failuresInARow = 0;
      log(`[rooms] ${pauseAfterFailures} failed starts in a row: server-hosted rooms paused for ${Math.round(pauseMs / 1000)} s (players host in their browser meanwhile)`);
    }
  }

  function stats() {
    let headlessRooms = 0;
    let headlessHumans = 0;
    for (const r of rooms) {
      if (!r.ready) continue;
      headlessRooms++;
      headlessHumans += r.humans;
    }
    return { headless: available(), headlessRooms, headlessHumans };
  }

  /** Tell every room to close (their clients hear 'leave'); stragglers are terminated after 3 s. */
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      const all = [...rooms];
      for (const r of all) {
        try {
          r.worker.postMessage({ type: 'shutdown' });
        } catch {
          /* already gone */
        }
      }
      const kill = setTimeout(() => {
        for (const r of all) r.worker.terminate().catch(() => {});
      }, SHUTDOWN_GRACE_MS);
      await Promise.all(all.map((r) => r.exited));
      clearTimeout(kill);
    })();
    return shuttingDown;
  }

  return {
    available,
    create,
    stats,
    shutdown,
    /** the live rooms (tests, diagnostics) */
    list: () => [...rooms].map((r) => ({ code: r.code, ip: r.ip, createdAt: r.createdAt, phase: r.phase, humans: r.humans, bots: r.bots, players: r.players, ready: r.ready })),
  };
}
