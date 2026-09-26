// WebSocket room relay for 三国杀·枪火乱世 (LAN / self-hosted play).
// Plain ESM JavaScript (no build step) so Node and Electron can load it directly.
//
// Protocol v1 (mirrors src/net/wsTransport.ts):
//  control = JSON text frames
//    → {op:'create', v, code?}          ← {op:'created', code, id, hostId, secret}
//    → {op:'join', v, code}             ← {op:'joined', code, id, hostId}
//    → {op:'resume', v, code, secret}   ← {op:'resumed', code, id, hostId, peers}   (host back after a drop)
//    → {op:'kick', id}   (host only)
//    → {op:'ping'}                      ← {op:'pong', host?}   (host: is the room's host connected)
//    ← {op:'peerJoin', id} / {op:'peerLeave', id}   (to the host)
//    ← {op:'hostLeft'} (to clients, then closed) / {op:'error', code, message}
//  (additive over the first v1: older clients ignore 'secret' / never send 'resume' / 'ping')
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
import { WebSocketServer } from 'ws';

export const RELAY_PROTOCOL_VERSION = 1;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOST_ID = 'host';
const F_UNRELIABLE = 2;

/**
 * Unreliable frames (snapshots, inputs) are dropped while more than this many
 * bytes are already queued for the receiving socket: a congested player gets
 * the newest state a little later instead of a growing queue of stale ones.
 * The kernel's TCP buffer sits below this, so keep it small (~6 snapshots).
 */
export const UNRELIABLE_BACKLOG = 16 * 1024;

/**
 * Heartbeat rounds in a row a socket may stay silent (no pong, no message) before it
 * is dropped. A browser whose page is frozen (a phone building the match scene) can
 * stop reading its socket and so stop answering pings for a while: a socket that is
 * merely quiet is kept (NET-4); the game's own watchdogs judge the players.
 */
export const HEARTBEAT_MISSES = 4;

/**
 * A room whose host socket dropped without closing waits this long for the host to
 * reconnect ({op:'resume'}) before its guests are told 'hostLeft' (MP2-8).
 */
export const HOST_GRACE_MS = 30_000;
/** Reliable frames kept for an absent host during the grace, per room (bytes; beyond: dropped). */
export const HOST_QUEUE_BYTES = 1024 * 1024;
/** Close codes of a socket closed on purpose (leave, tab closed): the room ends at once. */
const CLEAN_CLOSE = new Set([1000, 1001, 1005]);

/**
 * @param {{ maxPerRoom?: number, maxRooms?: number, heartbeatMs?: number, heartbeatMisses?: number,
 *           helloTimeoutMs?: number, unreliableBacklog?: number, hostGraceMs?: number,
 *           log?: (...a: unknown[]) => void }} [opts]
 */
export function createRelay(opts = {}) {
  const maxPerRoom = opts.maxPerRoom ?? 8;
  const unreliableBacklog = opts.unreliableBacklog ?? UNRELIABLE_BACKLOG;
  const maxRooms = opts.maxRooms ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const heartbeatMisses = Math.max(1, opts.heartbeatMisses ?? HEARTBEAT_MISSES);
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10000;
  const hostGraceMs = Math.max(0, opts.hostGraceMs ?? HOST_GRACE_MS);
  const log = opts.log ?? (() => {});

  /**
   * `host` is null while the host's socket is away (grace); `hostQueue` holds the guests'
   * reliable frames for it meanwhile.
   * @type {Map<string, { code: string, secret: string, host: any, clients: Map<string, any>, nextId: number, createdAt: number,
   *                      graceTimer: any, hostQueue: { flags: number, from: string, payload: Buffer }[], hostQueueBytes: number }>}
   */
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  let droppedUnreliable = 0;

  const sendJson = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const genCode = () => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let s = '';
      for (let i = 0; i < 5; i++) s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
      if (!rooms.has(s)) return s;
    }
    throw new Error('relay: could not allocate a room code');
  };

  const validCode = (c) => typeof c === 'string' && c.length === 5 && [...c].every((ch) => ROOM_ALPHABET.includes(ch));

  /** The room's secret: only its host can resume it after a drop. */
  const genSecret = () => {
    let s = '';
    for (let i = 0; i < 24; i++) s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    return s;
  };

  const frameFor = (flags, fromId, payload) => {
    const id = Buffer.from(fromId, 'utf8');
    return Buffer.concat([Buffer.from([flags, id.length]), id, payload]);
  };

  const deliver = (target, flags, fromId, payload) => {
    const ws = target.ws;
    if (ws.readyState !== ws.OPEN) return;
    if (flags & F_UNRELIABLE && ws.bufferedAmount > unreliableBacklog) {
      droppedUnreliable++; // congested: the next snapshot supersedes this one
      return;
    }
    if (ws.bufferedAmount > 16 * 1024 * 1024) {
      ws.terminate(); // hopelessly behind
      return;
    }
    ws.send(frameFor(flags, fromId, payload), { binary: true });
  };

  const closeRoom = (room) => {
    if (rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
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
    log(`[relay] room ${room.code} closed`);
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
      room.graceTimer = setTimeout(() => closeRoom(room), hostGraceMs);
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
        const code = validCode(msg.code) && !rooms.has(msg.code) ? msg.code : genCode();
        const room = {
          code,
          secret: genSecret(),
          host: client,
          clients: new Map(),
          nextId: 1,
          createdAt: Date.now(),
          graceTimer: null,
          hostQueue: [],
          hostQueueBytes: 0,
        };
        rooms.set(code, room);
        client.room = room;
        client.isHost = true;
        client.id = HOST_ID;
        sendJson(ws, { op: 'created', code, id: HOST_ID, hostId: HOST_ID, secret: room.secret });
        log(`[relay] room ${code} created`);
        return;
      }
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { op: 'error', code: 'roomNotFound' });
        ws.close(4004, 'room not found');
        return;
      }
      if (1 + room.clients.size >= maxPerRoom) {
        sendJson(ws, { op: 'error', code: 'roomFull' });
        ws.close(4006, 'room full');
        return;
      }
      const id = `c${room.nextId++}`;
      client.room = room;
      client.id = id;
      room.clients.set(id, client);
      sendJson(ws, { op: 'joined', code, id, hostId: HOST_ID });
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
      if (!room || typeof msg.secret !== 'string' || msg.secret !== room.secret) {
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
      sendJson(ws, { op: 'resumed', code, id: HOST_ID, hostId: HOST_ID, peers: [...room.clients.keys()] });
      // what the guests sent meanwhile (only guests still here)
      const queued = room.hostQueue;
      room.hostQueue = [];
      room.hostQueueBytes = 0;
      for (const f of queued) if (room.clients.has(f.from)) deliver(client, f.flags, f.from, f.payload);
      log(`[relay] room ${code}: host back`);
      return;
    }
    if (msg.op === 'ping') {
      // liveness for the players' own watchdogs: a guest learns the relay is there (and
      // whether the host is) — a silent host is then not a gone host (MP2-1)
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
    if (client.isHost) {
      if (dest === '*') {
        for (const c of room.clients.values()) deliver(c, flags, HOST_ID, payload);
      } else {
        const c = room.clients.get(dest);
        if (c) deliver(c, flags, HOST_ID, payload);
      }
    } else if (room.host) {
      deliver(room.host, flags, client.id, payload);
    } else if (!(flags & F_UNRELIABLE)) {
      queueForHost(room, flags, client.id, payload);
    }
  };

  wss.on('connection', (ws) => {
    const client = { ws, id: '', room: null, isHost: false, missed: 0, helloTimer: null };
    client.helloTimer = setTimeout(() => {
      if (!client.room) ws.close(4001, 'hello timeout');
    }, helloTimeoutMs);
    ws.on('pong', () => {
      client.missed = 0;
    });
    ws.on('message', (data, isBinary) => {
      client.missed = 0;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
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
      // no pong / message for `heartbeatMisses` pings in a row (60–75 s by default): a dead link
      if (c.missed >= heartbeatMisses) {
        log(`[relay] ${c.room ? `room ${c.room.code} ${c.id}` : 'socket'}: no sign of life for ${heartbeatMisses} heartbeats, dropped`);
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

  return {
    wss,
    rooms,
    /** route an HTTP upgrade (path already matched) into the relay */
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    stats() {
      let players = 0;
      for (const r of rooms.values()) players += (r.host ? 1 : 0) + r.clients.size;
      return { rooms: rooms.size, players, droppedUnreliable };
    },
    close() {
      clearInterval(heartbeat);
      for (const r of rooms.values()) clearTimeout(r.graceTimer);
      for (const ws of wss.clients) ws.terminate();
      rooms.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
