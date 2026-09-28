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
//
// Abuse limits: perIpPerMin creates a minute and perIpRooms live rooms per client address (a
// room nobody joins holds its slot only emptyLobbyMs); a page of another build of the game
// is refused (409: dist-headless/build.json, the POST's `build`) — its snapshots would desync;
// the workers' own output (stdout / stderr, log lines) reaches the log at a bounded rate.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** How long a worker gets to exit after {type:'shutdown'} before it is terminated. */
export const SHUTDOWN_GRACE_MS = 3000;
/** Failed starts in a row after which server-hosted rooms pause (clients host in the browser meanwhile). */
export const FAILURES_BEFORE_PAUSE = 2;
/** How long they pause. */
export const FAILURE_PAUSE_MS = 10 * 60_000;
/** Longest room display name kept (characters). */
export const MAX_ROOM_NAME = 16;
/** Rooms one client address may have at once (the rest of the slots stay free for others). */
export const ROOMS_PER_IP = 2;
/** A health check's room ({probe: true}: check.mjs) closes this soon if nobody joins (ms). */
export const PROBE_LOBBY_MS = 10_000;
/** A room's output (worker stdout / stderr, log lines): at most this many lines per LOG_WINDOW_MS. */
export const LOG_LINES_PER_WINDOW = 40;
export const LOG_WINDOW_MS = 10_000;
/** Longest output line kept (characters). */
const MAX_LOG_LINE = 2000;

/** An error with the HTTP answer it maps to (`status`, `{error: code}`). */
export class RoomsError extends Error {
  /**
   * @param {'headless-unavailable'|'rooms-full'|'rate-limited'|'worker-failed'|'version-mismatch'} code
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
 * A room's output limiter: `line(text)` logs at most `max` lines per `windowMs` (each cut to
 * MAX_LOG_LINE characters); the lines it drops are counted and reported once it logs again, or
 * at `flush()` (the room ended). A worker made to throw in a loop must not fill the disk.
 * @param {(msg: string) => void} out
 */
export function createLineLimiter(out, max = LOG_LINES_PER_WINDOW, windowMs = LOG_WINDOW_MS) {
  let windowStart = -Infinity;
  let used = 0;
  let dropped = 0;
  const report = () => {
    if (dropped > 0) out(`… ${dropped} line${dropped === 1 ? '' : 's'} of output not logged (too many)`);
    dropped = 0;
  };
  return {
    /** @param {string} text */
    line(text) {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        used = 0;
        report();
      }
      if (used >= max) {
        dropped++;
        return;
      }
      used++;
      out(text.length > MAX_LOG_LINE ? `${text.slice(0, MAX_LOG_LINE)}…` : text);
    },
    flush: report,
  };
}

/**
 * Feed a worker's stdout / stderr stream line by line into `line` (a partial line longer
 * than 64 KB is cut into pieces rather than buffered without end).
 * @param {import('node:stream').Readable | null | undefined} stream
 * @param {(text: string) => void} line
 */
function pipeLines(stream, line) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (l.trim()) line(l);
    }
    if (buf.length > 65_536) {
      line(buf);
      buf = '';
    }
  });
  stream.on('end', () => {
    if (buf.trim()) line(buf);
    buf = '';
  });
  stream.on('error', () => {});
}

/**
 * @param {{ workerPath: string, relayUrl: () => string, maxRooms?: number, perIpPerMin?: number,
 *           perIpRooms?: number, readyTimeoutMs?: number, emptyLobbyMs?: number, noHumansMs?: number,
 *           probeLobbyMs?: number, enabled?: boolean, workerLog?: boolean, log?: (msg: string) => void,
 *           errorLog?: (msg: string) => void, pauseAfterFailures?: number, pauseMs?: number,
 *           onReady?: (code: string, ip: string) => void, onExit?: (code: string | null) => void }} opts
 *   enabled: false = off (HEADLESS=0); workerLog: ask the workers for their log lines;
 *   perIpRooms: ROOMS_PER_IP; probeLobbyMs: PROBE_LOBBY_MS; errorLog: the workers' stderr (default console.error);
 *   pauseAfterFailures / pauseMs: FAILURES_BEFORE_PAUSE / FAILURE_PAUSE_MS.
 *   onReady / onExit: the relay room of a worker that just became ready (and the address that
 *   asked for it) / just exited.
 */
export function createHeadlessRooms(opts) {
  const workerPath = opts.workerPath;
  const maxRooms = Math.max(0, opts.maxRooms ?? 4);
  const perIpPerMin = Math.max(1, opts.perIpPerMin ?? 6);
  const perIpRooms = Math.max(1, opts.perIpRooms ?? ROOMS_PER_IP);
  const probeLobbyMs = Math.max(0, opts.probeLobbyMs ?? PROBE_LOBBY_MS);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15000;
  const emptyLobbyMs = opts.emptyLobbyMs ?? 180_000;
  const noHumansMs = opts.noHumansMs ?? 120_000;
  const enabled = opts.enabled ?? true;
  const pauseAfterFailures = Math.max(1, opts.pauseAfterFailures ?? FAILURES_BEFORE_PAUSE);
  const pauseMs = Math.max(0, opts.pauseMs ?? FAILURE_PAUSE_MS);
  const log = opts.log ?? (() => {});
  const errorLog = opts.errorLog ?? ((m) => console.error(m));

  /**
   * @typedef {{ worker: Worker, code: string | null, ip: string, createdAt: number, phase: string,
   *             humans: number, bots: number, players: number, ready: boolean,
   *             closing: string | null, closingDetail: string, exited: Promise<void> }} Room
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

  /** The game-compatibility id of the bundle (dist-headless/build.json), null when unknown. */
  const bundleBuild = () => {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(path.dirname(workerPath), 'build.json'), 'utf8'));
      return typeof info?.compat === 'string' && info.compat ? info.compat : null;
    } catch {
      return null;
    }
  };

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
   * `req.build`: the page's game-compatibility id — another than the bundle's is refused (409);
   * `req.probe`: a health check's room, closed after probeLobbyMs if nobody joins.
   * @param {string} ip
   * @param {{ name?: unknown, lang?: unknown, build?: unknown, probe?: unknown }} [req]
   * @returns {Promise<{ code: string, ownerKey: string }>}
   */
  function create(ip, req = {}) {
    if (!available()) return Promise.reject(new RoomsError('headless-unavailable', 503));
    if (typeof req.build === 'string' && req.build) {
      const mine = bundleBuild();
      if (mine && mine !== req.build.slice(0, 64)) return Promise.reject(new RoomsError('version-mismatch', 409, `page ${req.build.slice(0, 64)}, server ${mine}`));
    }
    const now = Date.now();
    if (!allowed(ip, now)) return Promise.reject(new RoomsError('rate-limited', 429));
    if (rooms.size >= maxRooms) return Promise.reject(new RoomsError('rooms-full', 503));
    // (503 like a full server: the page hosts the room itself — nobody holds every slot)
    let mineNow = 0;
    for (const r of rooms) if (r.ip === ip) mineNow++;
    if (mineNow >= perIpRooms) return Promise.reject(new RoomsError('rooms-full', 503, `${ip} has ${mineNow} rooms`));
    remember(ip, now);

    const ownerKey = crypto.randomBytes(24).toString('base64url');
    const workerData = {
      relayUrl: opts.relayUrl(),
      ownerKey,
      name: cleanRoomName(req.name),
      lang: req.lang === 'en' ? 'en' : 'zh',
      emptyLobbyMs: req.probe === true ? Math.min(emptyLobbyMs, probeLobbyMs) : emptyLobbyMs,
      noHumansMs,
      log: !!opts.workerLog,
    };
    let worker;
    try {
      // (stdout / stderr: piped here through the room's line limiter, not straight to the log file)
      worker = new Worker(workerPath, { workerData, name: 'sgwl-room', stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512 } });
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
        closingDetail: '',
        exited: new Promise((r) => (markExited = r)),
      };
      rooms.add(room);
      const out = createLineLimiter((m) => log(m.startsWith(tag(room)) ? m : `${tag(room)} ${m}`));
      const err = createLineLimiter((m) => errorLog(`${tag(room)} ${m}`));
      pipeLines(worker.stdout, out.line);
      pipeLines(worker.stderr, err.line);
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
              opts.onReady?.(room.code, ip);
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
            if (typeof msg.msg === 'string') out.line(msg.msg);
            break;
          case 'closing':
            // (logged once, with the 'ended' line below)
            room.closing = typeof msg.reason === 'string' ? msg.reason.slice(0, 16) : 'error';
            room.closingDetail = typeof msg.detail === 'string' ? msg.detail.slice(0, 500) : '';
            if (!settled) fail(`closed before it was ready (${room.closing}${room.closingDetail ? `: ${room.closingDetail}` : ''})`);
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
        out.flush();
        err.flush();
        if (room.ready) {
          const why = room.closing ? `${room.closing}${room.closingDetail ? `: ${room.closingDetail}` : ''}` : `exit ${exitCode}`;
          log(`[rooms] room ${room.code} ended (${why}) — ${rooms.size}/${maxRooms} rooms`);
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

  /**
   * /sgwl.json: headlessRooms / headlessHumans (connected humans); headlessPlaying: rooms past
   * the lobby — a match a restart would end even while its only player is briefly away.
   */
  function stats() {
    let headlessRooms = 0;
    let headlessHumans = 0;
    let headlessPlaying = 0;
    for (const r of rooms) {
      if (!r.ready) continue;
      headlessRooms++;
      headlessHumans += r.humans;
      if (r.phase !== 'lobby' && r.phase !== 'starting') headlessPlaying++;
    }
    return { headless: available(), headlessRooms, headlessHumans, headlessPlaying };
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

  /** The bundle's game-compatibility id for /sgwl.json (read at most every 10 s), null when unknown. */
  let buildCache = { at: -Infinity, compat: /** @type {string | null} */ (null) };
  function build() {
    const now = Date.now();
    if (now - buildCache.at >= 10_000) buildCache = { at: now, compat: bundlePresent() ? bundleBuild() : null };
    return buildCache.compat;
  }

  return {
    available,
    create,
    stats,
    build,
    shutdown,
    /** Rooms `ip` asked for that are still starting (no relay room of theirs yet: the relay's MAX_ROOMS_PER_IP counts them). */
    startingOf(ip) {
      let n = 0;
      for (const r of rooms) if (!r.ready && r.ip === ip) n++;
      return n;
    },
    /** the live rooms (tests, diagnostics) */
    list: () => [...rooms].map((r) => ({ code: r.code, ip: r.ip, createdAt: r.createdAt, phase: r.phase, humans: r.humans, bots: r.bots, players: r.players, ready: r.ready })),
  };
}
