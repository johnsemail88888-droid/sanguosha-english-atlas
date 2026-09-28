// WebSocket room relay for 三国杀·枪火乱世 (LAN / self-hosted play).
// Plain ESM JavaScript (no build step) so Node and Electron can load it directly.
//
// Protocol v1 (mirrors src/net/wsTransport.ts):
//  control = JSON text frames
//    → {op:'create', v, code?}          ← {op:'created', code, id, hostId, secret}
//    → {op:'join', v, code}             ← {op:'joined', code, id, hostId, serverHosted?}
//    → {op:'resume', v, code, secret}   ← {op:'resumed', code, id, hostId, peers}   (host back after a drop)
//    → {op:'kick', id}   (host only)
//    → {op:'ping'}                      ← {op:'pong', host?}   (host: is the room's host connected)
//    ← {op:'peerJoin', id} / {op:'peerLeave', id}   (to the host)
//    ← {op:'hostLeft'} (to clients, then closed) / {op:'error', code, message}
//  (additive over the first v1: older clients ignore 'secret' / never send 'resume' / 'ping';
//   'serverHosted': this server's own room worker hosts the room — the page may say "the server
//   runs this match" only then, not on a host's word in its lobby state)
//
//  A host socket that closes cleanly (the host left, the tab closed: codes 1000 / 1001 /
//  1005) ends its room at once. One that just drops (network blip, heartbeat timeout)
//  leaves the room waiting HOST_GRACE_MS for the host to 'resume' it with the room's
//  secret: the guests keep their sockets, their reliable frames to the host are kept for
//  it, their pings say host:false meanwhile; then 'hostLeft' (MP2-8).
//  data = binary frames: [flags u8][idLen u8][peer id][payload]
//    flags bit0 = binary payload, bit1 = unreliable (may be dropped under backpressure)
//    the sender writes the destination ('*' = every client, host only);
//    the relay rewrites the id to the sender before delivery.
//
// Limits (a public server: the machine name is in Certificate Transparency logs):
//  · per client address (server.mjs clientIp — loopback, i.e. this machine itself and the
//    server-hosted room workers, is exempt): MAX_SOCKETS_PER_IP sockets (HTTP 429 on the
//    upgrade), CREATES_PER_MIN rooms a minute ({op:'error', code:'rateLimited'}), and
//    MAX_ROOMS_PER_IP rooms at once — server-hosted ones it asked for included
//    ({op:'error', code:'tooManyRooms'}): one address cannot hold every room of a small server;
//  · every socket: inbound messages / bytes per second (INBOUND_LIMITS, a token bucket with
//    BURST_SECONDS of burst — RESUME_BURST_SECONDS once, right after a host's create / resume:
//    the frames its page kept while it reconnected; beyond: closed 4008), frames ≤ MAX_PAYLOAD
//    (ws closes 1009); a socket more than TERMINATE_BACKLOG behind on its outbound queue is
//    terminated — whatever the relay queues for it (data, its own answers and notices); a
//    socket that is behind gets no pong, and its messages alone do not count as a sign of life;
//  · every room: ended after IDLE_ROOM_MS without a data frame delivered to someone, and after
//    MAX_ROOM_MS in any case (not a server-hosted room: rooms.mjs ends those)
//    ({op:'error', code:'roomClosed'} to the host, 'hostLeft' to the guests); its code is then
//    refused for a while so the host's resume logic cannot re-create it.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLineLimiter } from './rooms.mjs';

export const RELAY_PROTOCOL_VERSION = 1;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOST_ID = 'host';
const F_UNRELIABLE = 2;

/** Players a room seats at most (src/net/hostSession.ts MAX_PLAYERS); the host enforces the seats. */
export const MAX_PLAYERS = 8;
/**
 * Sockets a room may hold beyond its seats: a guest whose link dropped rejoins on a new socket
 * while the relay may not have noticed the old one yet — a full room must not answer 'roomFull'.
 */
export const ROOM_SLACK = 4;
/** Sockets per room, host included. */
export const MAX_PER_ROOM = MAX_PLAYERS + ROOM_SLACK;

/**
 * Unreliable frames (snapshots, inputs) are dropped while more than this many
 * bytes are already queued for the receiving socket: a congested player gets
 * the newest state a little later instead of a growing queue of stale ones.
 * The kernel's TCP buffer sits below this, so keep it small (~6 snapshots).
 */
export const UNRELIABLE_BACKLOG = 16 * 1024;
/**
 * A socket this far behind (bytes queued that it does not read) is terminated: a reader that
 * stopped reading must not hold the server's memory (21 such sockets held 347 MB at 16 MB each).
 * Far above a live player's reliable backlog (events of a few seconds are a few KB).
 */
export const TERMINATE_BACKLOG = 1024 * 1024;
/** Largest inbound frame (bytes; a full snapshot is ~5 KB). */
export const MAX_PAYLOAD = 64 * 1024;

/**
 * Heartbeat rounds in a row a socket may stay silent (no pong, no message) before it
 * is dropped. A browser whose page is frozen (a phone building the match scene) can
 * stop reading its socket and so stop answering pings for a while: a socket that is
 * merely quiet is kept (NET-4); the game's own watchdogs judge the players.
 */
export const HEARTBEAT_MISSES = 4;
/**
 * Heartbeat misses tolerated from a room's HOST socket (2–2.25 min): the host's page does the
 * heavy work (it runs the sim and loads its own view — on a slow machine frozen for minutes,
 * not reading its socket), and a dropped host still has HOST_GRACE_MS to resume its room.
 * The guests meanwhile see the host's silence with the relay's word that it is still there.
 */
export const HOST_HEARTBEAT_MISSES = 8;

/**
 * A room whose host socket dropped without closing waits this long for the host to
 * reconnect ({op:'resume'}) before its guests are told 'hostLeft' (MP2-8). As long as the
 * host keeps trying (src/net/wsTransport.ts RESUME_WINDOW_MS): a host that comes back
 * within its window finds its guests still there. Env HOST_GRACE_MS (server.mjs).
 */
export const HOST_GRACE_MS = 120_000;
/** Reliable frames kept for an absent host during the grace, per room (bytes; beyond: dropped). */
export const HOST_QUEUE_BYTES = 1024 * 1024;
/** Close codes of a socket closed on purpose (leave, tab closed): the room ends at once. */
const CLEAN_CLOSE = new Set([1000, 1001, 1005]);

/** Relay sockets one client address may hold at once (loopback exempt). */
export const MAX_SOCKETS_PER_IP = 8;
/** Rooms one client address may create a minute (loopback exempt; resumes do not count). */
export const CREATES_PER_MIN = 5;
/**
 * Rooms one client address may hold at once (loopback exempt): the rooms its sockets created and
 * the server-hosted rooms it asked for (markServerHosted). A friend hosts one room; a small
 * server (the Mac mini: MAX_ROOMS=4) must not be filled from one address.
 */
export const MAX_ROOMS_PER_IP = 2;
/**
 * Inbound caps per socket (a token bucket: `msgs` messages and `bytes` bytes a second, with
 * BURST_SECONDS of burst). Measured on a real 8-player match through this relay (host player
 * + 7 guests, tests/unit/server/relayLoad.measure.test.ts): the host socket peaks at 280
 * messages / 195 KB a second (snapshots to every guest + their event streams; ~320 with 8
 * guests), a guest at 33 messages / 0.8 KB. The host caps sit 3× above that — a lagging
 * guest's full-snapshot catch-up and a big fight's event burst must never cut a match off.
 */
export const INBOUND_LIMITS = Object.freeze({
  host: Object.freeze({ msgs: 1000, bytes: 1024 * 1024 }),
  guest: Object.freeze({ msgs: 100, bytes: 32 * 1024 }),
});
export const BURST_SECONDS = 2;
/**
 * A host socket's one-off burst right after a successful create / resume (seconds of its
 * INBOUND_LIMITS, at least RESUME_BURST_MIN_BYTES): the page sends what it kept while it
 * reconnected (src/net/wsTransport.ts: ≤ RESUME_QUEUE_FRAMES frames / 4 MB, ~84 frames a second
 * of a 7-guest match) — a relay back after half a minute must not cut its host off for that.
 */
export const RESUME_BURST_SECONDS = 10;
export const RESUME_BURST_MIN_BYTES = 4 * 1024 * 1024 + 512 * 1024;
/** A room without a single data frame for this long is ended. */
export const IDLE_ROOM_MS = 15 * 60_000;
/**
 * Any room ends after this long (not a server-hosted one: rooms.mjs ends those). Only a
 * backstop: a room plays match after match (it goes back to its lobby by itself), a whole
 * evening; one address holds MAX_ROOMS_PER_IP rooms at most, and a room without traffic to
 * anybody ends after IDLE_ROOM_MS.
 */
export const MAX_ROOM_MS = 24 * 60 * 60_000;
/** An ended (reaped) room's code is refused to 'create' for this long (the host's resume retries). */
export const ENDED_CODE_MS = 10 * 60_000;
/** Connection log lines (connect / close) at most this many a minute; the rest are counted. */
export const CONN_LOG_LINES_PER_MIN = 60;

/**
 * A token bucket: `take(n)` → false once more than `rate`/s (plus `burst` s of it) was taken.
 * `extra`: a one-off allowance on top of the burst (used first; never refilled).
 */
function bucket(rate, burstSeconds, now, extra = 0) {
  const cap = rate * burstSeconds;
  let tokens = cap + Math.max(0, extra);
  let last = now;
  return {
    take(n, t) {
      // (refilling never goes past the cap; a one-off allowance above it just drains)
      if (tokens < cap) tokens = Math.min(cap, tokens + ((t - last) / 1000) * rate);
      last = t;
      tokens -= n;
      return tokens >= 0;
    },
  };
}

/** `::ffff:1.2.3.4` → `1.2.3.4` */
const plainIp = (ip) => String(ip ?? '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
/** Loopback: this machine itself (the server-hosted room workers, local tests) — not rate-limited. */
export const isLoopbackIp = (ip) => ip === '::1' || /^127\./.test(ip) || ip === 'localhost';

/**
 * @param {{ maxPerRoom?: number, maxRooms?: number, heartbeatMs?: number, heartbeatMisses?: number, hostHeartbeatMisses?: number,
 *           helloTimeoutMs?: number, unreliableBacklog?: number, terminateBacklog?: number, hostGraceMs?: number,
 *           maxSocketsPerIp?: number, createsPerMin?: number, maxRoomsPerIp?: number,
 *           inbound?: { host?: { msgs?: number, bytes?: number }, guest?: { msgs?: number, bytes?: number } },
 *           idleRoomMs?: number, maxRoomMs?: number, sweepMs?: number, endedCodeMs?: number, connLogPerMin?: number,
 *           pendingRoomsOf?: (ip: string) => number, log?: (...a: unknown[]) => void }} [opts]
 *   pendingRoomsOf: server-hosted rooms `ip` asked for that have no relay room yet (rooms.mjs):
 *   they count towards its MAX_ROOMS_PER_IP too.
 */
export function createRelay(opts = {}) {
  const maxPerRoom = opts.maxPerRoom ?? MAX_PER_ROOM;
  const unreliableBacklog = opts.unreliableBacklog ?? UNRELIABLE_BACKLOG;
  const terminateBacklog = opts.terminateBacklog ?? TERMINATE_BACKLOG;
  const maxRooms = opts.maxRooms ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const heartbeatMisses = Math.max(1, opts.heartbeatMisses ?? HEARTBEAT_MISSES);
  const hostHeartbeatMisses = Math.max(heartbeatMisses, opts.hostHeartbeatMisses ?? HOST_HEARTBEAT_MISSES);
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10000;
  const hostGraceMs = Math.max(0, opts.hostGraceMs ?? HOST_GRACE_MS);
  const maxSocketsPerIp = Math.max(1, opts.maxSocketsPerIp ?? MAX_SOCKETS_PER_IP);
  const createsPerMin = Math.max(1, opts.createsPerMin ?? CREATES_PER_MIN);
  const maxRoomsPerIp = Math.max(1, opts.maxRoomsPerIp ?? MAX_ROOMS_PER_IP);
  const pendingRoomsOf = typeof opts.pendingRoomsOf === 'function' ? opts.pendingRoomsOf : () => 0;
  const limits = {
    host: { ...INBOUND_LIMITS.host, ...(opts.inbound?.host ?? {}) },
    guest: { ...INBOUND_LIMITS.guest, ...(opts.inbound?.guest ?? {}) },
  };
  const idleRoomMs = Math.max(1, opts.idleRoomMs ?? IDLE_ROOM_MS);
  const maxRoomMs = Math.max(1, opts.maxRoomMs ?? MAX_ROOM_MS);
  const sweepMs = Math.max(10, opts.sweepMs ?? Math.min(30_000, Math.floor(idleRoomMs / 4)));
  const endedCodeMs = Math.max(0, opts.endedCodeMs ?? ENDED_CODE_MS);
  const log = opts.log ?? (() => {});
  // connect / close lines: at a sane rate (a flood must not fill the disk)
  const connLog = createLineLimiter((m) => log(m), Math.max(1, opts.connLogPerMin ?? CONN_LOG_LINES_PER_MIN), 60_000);

  /**
   * `host` is null while the host's socket is away (grace); `hostQueue` holds the guests'
   * reliable frames for it meanwhile.
   * `ownerIp`: the address the room counts against (MAX_ROOMS_PER_IP): its creator's — for a
   * server-hosted room, the address that asked for it (markServerHosted).
   * @type {Map<string, { code: string, secret: string, host: any, clients: Map<string, any>, nextId: number, createdAt: number,
   *                      lastTraffic: number, graceTimer: any, hostQueue: { flags: number, from: string, payload: Buffer }[],
   *                      hostQueueBytes: number, ownerIp: string, limit?: number, serverHosted?: boolean }>}
   */
  const rooms = new Map();
  /** codes of rooms this relay ended (idle / too old) → until when 'create' refuses them */
  const endedCodes = new Map();
  /** live relay sockets per client address (loopback not counted) */
  const socketsPerIp = new Map();
  /** room creations in the last minute per client address */
  const createTimes = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  const counters = {
    socketsOpened: 0,
    socketsClosed: 0,
    roomsCreated: 0,
    roomsClosed: 0,
    bytesIn: 0,
    bytesOut: 0,
    framesIn: 0,
    framesOut: 0,
    droppedUnreliable: 0,
    terminatedBacklog: 0,
    rateLimited: 0,
    refusedSockets: 0,
    refusedCreates: 0,
    refusedRooms: 0,
    reapedIdle: 0,
    reapedOld: 0,
  };

  /**
   * A control message to `ws` — under the same backlog cap as data (deliver): a socket that
   * stopped reading must not grow the server's memory with the relay's own answers either.
   */
  const sendJson = (ws, obj) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > terminateBacklog) {
      counters.terminatedBacklog++;
      const c = ws._sgwlClient;
      connLog.line(`[relay] ${c?.ip ?? '?'} ${c?.room?.code ?? '-'} ${c?.id || '?'}: ${ws.bufferedAmount} bytes unread, terminated`);
      ws.terminate();
      return;
    }
    const s = JSON.stringify(obj);
    counters.bytesOut += s.length;
    ws.send(s);
  };

  const randomFrom = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    return s;
  };

  const genCode = () => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const s = randomFrom(5);
      if (!rooms.has(s) && !endedCodes.has(s)) return s;
    }
    throw new Error('relay: could not allocate a room code');
  };

  const validCode = (c) => typeof c === 'string' && c.length === 5 && [...c].every((ch) => ROOM_ALPHABET.includes(ch));

  /** The room's secret (120 bits): only its host can resume it after a drop. */
  const genSecret = () => randomFrom(24);

  const frameFor = (flags, fromId, payload) => {
    const id = Buffer.from(fromId, 'utf8');
    return Buffer.concat([Buffer.from([flags, id.length]), id, payload]);
  };

  /** A data frame to `target`; true when it went out (not dropped / the socket not terminated). */
  const deliver = (target, flags, fromId, payload) => {
    const ws = target.ws;
    if (ws.readyState !== ws.OPEN) return false;
    if (flags & F_UNRELIABLE && ws.bufferedAmount > unreliableBacklog) {
      counters.droppedUnreliable++; // congested: the next snapshot supersedes this one
      return false;
    }
    if (ws.bufferedAmount > terminateBacklog) {
      // hopelessly behind (a reader that stopped reading): its link is as good as dead
      counters.terminatedBacklog++;
      connLog.line(`[relay] ${target.ip} ${target.room?.code ?? '-'} ${target.id || '?'}: ${ws.bufferedAmount} bytes unread, terminated`);
      ws.terminate();
      return false;
    }
    const frame = frameFor(flags, fromId, payload);
    counters.bytesOut += frame.length;
    counters.framesOut++;
    ws.send(frame, { binary: true });
    return true;
  };

  const closeRoom = (room, why = 'closed') => {
    if (rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
    counters.roomsClosed++;
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
    room.hostQueue = [];
    room.hostQueueBytes = 0;
    for (const c of room.clients.values()) {
      c.room = null;
      sendJson(c.ws, { op: 'hostLeft' });
      c.ws.close(4000, 'host left');
    }
    room.clients.clear();
    log(`[relay] room ${room.code} ${why} (${Math.round((Date.now() - room.createdAt) / 1000)} s)`);
  };

  /**
   * End a room for good (idle / too old): the guests hear 'hostLeft'; the host hears
   * 'roomClosed' and its socket closes — and its code is refused for a while, or the host's
   * resume logic (which re-creates a room the relay forgot) would bring it straight back.
   */
  const reapRoom = (room, why) => {
    const host = room.host;
    if (endedCodeMs > 0) endedCodes.set(room.code, Date.now() + endedCodeMs);
    closeRoom(room, why);
    if (host) {
      host.room = null;
      sendJson(host.ws, { op: 'error', code: 'roomClosed', message: why });
      host.ws.close(4009, why.slice(0, 60));
    }
  };

  /** `code`: the socket's close code (a clean close of the host's socket ends its room at once). */
  const leave = (client, code) => {
    const room = client.room;
    if (!room) return;
    client.room = null;
    if (client.isHost) {
      if (room.host !== client) return; // a host socket already replaced by a resume
      if (code !== undefined && CLEAN_CLOSE.has(code)) {
        closeRoom(room);
        return;
      }
      // dropped, not closed: the host may come back (resume) — its guests stay (MP2-8)
      room.host = null;
      clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => closeRoom(room, 'closed: its host did not come back'), hostGraceMs);
      room.graceTimer.unref?.();
      log(`[relay] room ${room.code}: host dropped (${code ?? '?'}), waiting ${hostGraceMs / 1000} s for it`);
    } else if (room.clients.get(client.id) === client) {
      room.clients.delete(client.id);
      if (room.host) sendJson(room.host.ws, { op: 'peerLeave', id: client.id });
    }
  };

  /** A guest's reliable frame while the host is away: kept for it (bounded). */
  const queueForHost = (room, flags, from, payload) => {
    if (room.hostQueueBytes + payload.length > HOST_QUEUE_BYTES) return;
    room.hostQueue.push({ flags, from, payload: Buffer.from(payload) });
    room.hostQueueBytes += payload.length;
  };

  /** Rooms `ip` holds now (MAX_ROOMS_PER_IP): relay rooms counted against it + its server-hosted rooms still starting. */
  const roomsOf = (ip) => {
    let n = 0;
    for (const r of rooms.values()) if (r.ownerIp === ip) n++;
    return n + Math.max(0, Number(pendingRoomsOf(ip)) || 0);
  };

  /**
   * A host socket's buckets right after its create / resume: its own rates plus a one-off
   * RESUME_BURST_SECONDS allowance (what its page kept while it reconnected goes out at once).
   */
  const hostBuckets = (client, now) => {
    client.limitKind = 'host';
    const extraMsgs = limits.host.msgs * RESUME_BURST_SECONDS;
    const extraBytes = Math.max(RESUME_BURST_MIN_BYTES, limits.host.bytes * RESUME_BURST_SECONDS);
    client.msgBucket = bucket(limits.host.msgs, BURST_SECONDS, now, extraMsgs);
    client.byteBucket = bucket(limits.host.bytes, BURST_SECONDS, now, extraBytes);
  };

  /** Sliding one-minute window: true when `ip` may create another room now (and counts it). */
  const mayCreate = (ip, now) => {
    if (isLoopbackIp(ip)) return true;
    const times = (createTimes.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= createsPerMin) {
      createTimes.set(ip, times);
      return false;
    }
    times.push(now);
    createTimes.set(ip, times);
    return true;
  };

  const onControl = (client, msg) => {
    const ws = client.ws;
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'create' || msg.op === 'join') {
      if (client.room) return;
      if (msg.v !== RELAY_PROTOCOL_VERSION) {
        sendJson(ws, { op: 'error', code: 'version', message: `relay protocol ${RELAY_PROTOCOL_VERSION}` });
        ws.close(4002, 'version');
        return;
      }
      clearTimeout(client.helloTimer);
      if (msg.op === 'create') {
        if (rooms.size >= maxRooms) {
          sendJson(ws, { op: 'error', code: 'serverFull' });
          ws.close(4005, 'server full');
          return;
        }
        const wanted = validCode(msg.code) ? msg.code : null;
        if (wanted && endedCodes.has(wanted)) {
          // a room this relay ended (idle / too old): its host may not bring it back
          sendJson(ws, { op: 'error', code: 'roomClosed' });
          ws.close(4009, 'room closed');
          return;
        }
        const now = Date.now();
        if (!isLoopbackIp(client.ip) && roomsOf(client.ip) >= maxRoomsPerIp) {
          counters.refusedRooms++;
          connLog.line(`[relay] ${client.ip}: already holds ${maxRoomsPerIp} rooms, refused`);
          sendJson(ws, { op: 'error', code: 'tooManyRooms' });
          ws.close(4029, 'too many rooms');
          return;
        }
        if (!mayCreate(client.ip, now)) {
          counters.refusedCreates++;
          connLog.line(`[relay] ${client.ip}: more than ${createsPerMin} rooms a minute, refused`);
          sendJson(ws, { op: 'error', code: 'rateLimited' });
          ws.close(4029, 'too many rooms');
          return;
        }
        const code = wanted && !rooms.has(wanted) ? wanted : genCode();
        const room = {
          code,
          secret: genSecret(),
          host: client,
          clients: new Map(),
          nextId: 1,
          createdAt: now,
          lastTraffic: now,
          graceTimer: null,
          hostQueue: [],
          hostQueueBytes: 0,
          ownerIp: client.ip,
        };
        rooms.set(code, room);
        counters.roomsCreated++;
        client.room = room;
        client.isHost = true;
        client.id = HOST_ID;
        hostBuckets(client, now);
        sendJson(ws, { op: 'created', code, id: HOST_ID, hostId: HOST_ID, secret: room.secret });
        connLog.line(`[relay] + ${client.ip} create ${code}`);
        return;
      }
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { op: 'error', code: 'roomNotFound' });
        ws.close(4004, 'room not found');
        return;
      }
      if (1 + room.clients.size >= (room.limit ?? maxPerRoom)) {
        sendJson(ws, { op: 'error', code: 'roomFull' });
        ws.close(4006, 'room full');
        return;
      }
      const id = `c${room.nextId++}`;
      client.room = room;
      client.id = id;
      room.clients.set(id, client);
      sendJson(ws, room.serverHosted ? { op: 'joined', code, id, hostId: HOST_ID, serverHosted: true } : { op: 'joined', code, id, hostId: HOST_ID });
      connLog.line(`[relay] + ${client.ip} join ${code} ${id}`);
      // (a host that is away learns its guests from the 'resumed' list)
      if (room.host) sendJson(room.host.ws, { op: 'peerJoin', id });
      return;
    }
    if (msg.op === 'resume') {
      // the host of a room reconnects after its socket dropped (MP2-8)
      if (client.room) return;
      if (msg.v !== RELAY_PROTOCOL_VERSION) {
        sendJson(ws, { op: 'error', code: 'version', message: `relay protocol ${RELAY_PROTOCOL_VERSION}` });
        ws.close(4002, 'version');
        return;
      }
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room || typeof msg.secret !== 'string' || !sameSecret(msg.secret, room.secret)) {
        // gone (the grace ran out, the relay restarted): the socket stays open — the host
        // may create the room again under the same code
        sendJson(ws, { op: 'error', code: 'roomNotFound' });
        return;
      }
      clearTimeout(client.helloTimer);
      const old = room.host;
      if (old && old !== client) {
        // its previous socket is still around (a half-open link): this one replaces it
        old.room = null;
        try {
          old.ws.terminate();
        } catch {
          /* ignore */
        }
      }
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
      room.host = client;
      client.room = room;
      client.isHost = true;
      client.id = HOST_ID;
      hostBuckets(client, Date.now());
      sendJson(ws, { op: 'resumed', code, id: HOST_ID, hostId: HOST_ID, peers: [...room.clients.keys()] });
      // what the guests sent meanwhile (only guests still here)
      const queued = room.hostQueue;
      room.hostQueue = [];
      room.hostQueueBytes = 0;
      for (const f of queued) if (room.clients.has(f.from) && room.host === client) deliver(client, f.flags, f.from, f.payload);
      connLog.line(`[relay] + ${client.ip} resume ${code}`);
      return;
    }
    if (msg.op === 'ping') {
      // liveness for the players' own watchdogs: a guest learns the relay is there (and
      // whether the host is) — a silent host is then not a gone host (MP2-1). A socket already
      // behind on reading gets none: a pong is only a hint, and pinging must not pile them up
      if (ws.bufferedAmount > unreliableBacklog) return;
      const room = client.room;
      sendJson(ws, room && !client.isHost ? { op: 'pong', host: room.host !== null } : { op: 'pong' });
      return;
    }
    if (msg.op === 'kick' && client.isHost && client.room) {
      const target = client.room.clients.get(String(msg.id));
      if (target) {
        leave(target);
        target.ws.close(4003, 'kicked');
      }
    }
  };

  const onFrame = (client, buf) => {
    const room = client.room;
    if (!room || buf.length < 2) return;
    const flags = buf[0];
    const idLen = buf[1];
    if (buf.length < 2 + idLen) return;
    const dest = buf.subarray(2, 2 + idLen).toString('utf8');
    const payload = buf.subarray(2 + idLen);
    // a room lives on traffic between its players: a host sending to nobody keeps nothing alive
    let traffic = false;
    if (client.isHost) {
      if (dest === '*') {
        for (const c of room.clients.values()) traffic = deliver(c, flags, HOST_ID, payload) || traffic;
      } else {
        const c = room.clients.get(dest);
        if (c) traffic = deliver(c, flags, HOST_ID, payload);
      }
    } else if (room.host) {
      traffic = true; // (a guest's word counts even when its host is congested)
      deliver(room.host, flags, client.id, payload);
    } else {
      traffic = true;
      if (!(flags & F_UNRELIABLE)) queueForHost(room, flags, client.id, payload);
    }
    if (traffic) room.lastTraffic = Date.now();
  };

  /** Inbound caps (INBOUND_LIMITS): false (and the socket closes) once the client exceeds them. */
  const withinLimits = (client, size) => {
    const now = Date.now();
    const kind = client.isHost ? 'host' : 'guest';
    if (client.limitKind !== kind) {
      // (a socket becomes a host with 'create' / 'resume': fresh buckets at the host's rates)
      client.limitKind = kind;
      client.msgBucket = bucket(limits[kind].msgs, BURST_SECONDS, now);
      client.byteBucket = bucket(limits[kind].bytes, BURST_SECONDS, now);
    }
    const okMsgs = client.msgBucket.take(1, now);
    const okBytes = client.byteBucket.take(size, now);
    if (okMsgs && okBytes) return true;
    counters.rateLimited++;
    connLog.line(
      `[relay] ${client.ip} ${client.room?.code ?? '-'} ${client.id || '?'}: over ${okMsgs ? `${limits[kind].bytes} bytes` : `${limits[kind].msgs} messages`} a second, closed`,
    );
    client.room && client.isHost ? leave(client, 4008) : leave(client);
    client.ws.close(4008, 'rate limit');
    return false;
  };

  wss.on('connection', (ws, req) => {
    const ip = typeof req?._sgwlIp === 'string' ? req._sgwlIp : plainIp(req?.socket?.remoteAddress) || 'unknown';
    const client = { ws, ip, id: '', room: null, isHost: false, missed: 0, helloTimer: null, openedAt: Date.now(), closed: false };
    counters.socketsOpened++;
    client.helloTimer = setTimeout(() => {
      if (!client.room) ws.close(4001, 'hello timeout');
    }, helloTimeoutMs);
    ws.on('pong', () => {
      client.missed = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (client.closed) return;
      // a sign of life — unless the socket is behind on reading: one that sends but never reads
      // must be judged by its pongs (a live page reads its socket, and so answers the pings)
      if (ws.bufferedAmount <= unreliableBacklog) client.missed = 0;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      counters.bytesIn += buf.length;
      counters.framesIn++;
      if (!withinLimits(client, buf.length)) {
        client.closed = true;
        return;
      }
      if (!isBinary) {
        let msg;
        try {
          msg = JSON.parse(buf.toString('utf8'));
        } catch {
          return;
        }
        onControl(client, msg);
      } else {
        onFrame(client, buf);
      }
    });
    ws.on('close', (code) => {
      clearTimeout(client.helloTimer);
      client.closed = true;
      counters.socketsClosed++;
      if (!isLoopbackIp(ip)) {
        const n = (socketsPerIp.get(ip) ?? 1) - 1;
        if (n > 0) socketsPerIp.set(ip, n);
        else socketsPerIp.delete(ip);
      }
      const room = client.room;
      if (room) connLog.line(`[relay] - ${ip} ${room.code} ${client.id} close ${code} (${Math.round((Date.now() - client.openedAt) / 1000)} s)`);
      leave(client, code);
    });
    ws.on('error', () => {
      /* 'close' follows */
    });
    ws._sgwlClient = client;
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const c = ws._sgwlClient;
      if (!c) continue;
      // no pong / message for `heartbeatMisses` pings in a row (60–75 s by default; a host
      // twice that): a dead link
      const misses = c.isHost && c.room ? hostHeartbeatMisses : heartbeatMisses;
      if (c.missed >= misses) {
        log(`[relay] ${c.room ? `room ${c.room.code} ${c.id}` : 'socket'}: no sign of life for ${misses} heartbeats, dropped`);
        ws.terminate();
        continue;
      }
      c.missed++;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  // idle and too-old rooms end; the refused codes of ended rooms and old create times expire
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (!room.serverHosted && now - room.createdAt >= maxRoomMs) {
        counters.reapedOld++;
        reapRoom(room, `ended: open longer than ${Math.round(maxRoomMs / 60_000)} min`);
      } else if (now - room.lastTraffic >= idleRoomMs) {
        counters.reapedIdle++;
        reapRoom(room, `ended: idle for ${Math.round(idleRoomMs / 60_000)} min`);
      }
    }
    for (const [code, until] of endedCodes) if (until <= now) endedCodes.delete(code);
    for (const [ip, times] of createTimes) if (!times.some((t) => now - t < 60_000)) createTimes.delete(ip);
  }, sweepMs);
  sweep.unref?.();

  /** Refuse an upgrade with an HTTP answer (before any WebSocket exists). */
  const refuse = (socket, status, text, body) => {
    try {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch {
      /* ignore */
    }
    socket.destroy();
  };

  return {
    wss,
    rooms,
    /**
     * Route an HTTP upgrade (path and access key already checked) into the relay. `ip`: the
     * client's address (server.mjs clientIp; default: the socket's peer) — at most
     * maxSocketsPerIp sockets each (HTTP 429), loopback exempt.
     */
    handleUpgrade(req, socket, head, ip) {
      const addr = typeof ip === 'string' && ip ? ip : plainIp(req.socket?.remoteAddress) || 'unknown';
      if (!isLoopbackIp(addr)) {
        const n = socketsPerIp.get(addr) ?? 0;
        if (n >= maxSocketsPerIp) {
          counters.refusedSockets++;
          connLog.line(`[relay] ${addr}: more than ${maxSocketsPerIp} sockets, refused`);
          refuse(socket, 429, 'Too Many Requests', '{"error":"too-many-connections"}');
          return;
        }
        socketsPerIp.set(addr, n + 1);
      }
      req._sgwlIp = addr;
      let accepted = false;
      // a handshake that fails never reaches 'connection' (whose 'close' uncounts the socket)
      socket.once('close', () => {
        if (accepted || isLoopbackIp(addr)) return;
        const n = (socketsPerIp.get(addr) ?? 1) - 1;
        if (n > 0) socketsPerIp.set(addr, n);
        else socketsPerIp.delete(addr);
      });
      wss.handleUpgrade(req, socket, head, (ws) => {
        accepted = true;
        wss.emit('connection', ws, req);
      });
    },
    /**
     * Sockets room `code` may hold, host included (default maxPerRoom). A server-hosted room's
     * host is the server itself, not a player: it takes one more so it seats as many humans.
     */
    setRoomLimit(code, max) {
      const room = rooms.get(code);
      if (room && Number.isFinite(max) && max >= 1) room.limit = Math.floor(max);
    },
    /**
     * Room `code` is hosted by this server's room worker (rooms.mjs): its guests hear so in
     * 'joined'. `ownerIp`: the address that asked for it — the room counts against it
     * (MAX_ROOMS_PER_IP), not against this machine.
     */
    markServerHosted(code, ownerIp) {
      const room = rooms.get(code);
      if (!room) return;
      room.serverHosted = true;
      if (typeof ownerIp === 'string' && ownerIp) room.ownerIp = ownerIp;
    },
    /** Rooms `ip` holds now (MAX_ROOMS_PER_IP; 0 for loopback, which is exempt). */
    roomsOf(ip) {
      return isLoopbackIp(String(ip ?? '')) ? 0 : roomsOf(String(ip));
    },
    /** The per-address room cap (MAX_ROOMS_PER_IP / the maxRoomsPerIp option). */
    maxRoomsPerIp,
    /** End room `code` now (its guests hear 'hostLeft'): its host is known to be gone for good. */
    endRoom(code) {
      const room = rooms.get(code);
      if (!room) return;
      const host = room.host;
      closeRoom(room);
      if (host) {
        host.room = null;
        host.ws.terminate();
      }
    },
    /** No room for another relay room (MAX_ROOMS): a server-hosted room would not get one either. */
    full() {
      return rooms.size >= maxRooms;
    },
    /** /sgwl.json: rooms, sockets in rooms (players), unreliable frames dropped so far. */
    stats() {
      let players = 0;
      for (const r of rooms.values()) players += (r.host ? 1 : 0) + r.clients.size;
      return { rooms: rooms.size, players, droppedUnreliable: counters.droppedUnreliable };
    },
    /** Running totals for the server's stats line (it logs their deltas). */
    counters() {
      return { ...counters, sockets: wss.clients.size };
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      for (const r of rooms.values()) clearTimeout(r.graceTimer);
      for (const ws of wss.clients) ws.terminate();
      rooms.clear();
      connLog.flush();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Constant-time comparison of two room secrets. */
function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
