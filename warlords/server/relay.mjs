// WebSocket room relay for 三国杀·枪火乱世 (LAN / self-hosted play).
// Plain ESM JavaScript (no build step) so Node and Electron can load it directly.
//
// Protocol v1 (mirrors src/net/wsTransport.ts):
//  control = JSON text frames
//    → {op:'create', v, code?}          ← {op:'created', code, id, hostId}
//    → {op:'join', v, code}             ← {op:'joined', code, id, hostId}
//    → {op:'kick', id}   (host only)
//    ← {op:'peerJoin', id} / {op:'peerLeave', id}   (to the host)
//    ← {op:'hostLeft'} (to clients, then closed) / {op:'error', code, message}
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
 * @param {{ maxPerRoom?: number, maxRooms?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *           unreliableBacklog?: number, log?: (...a: unknown[]) => void }} [opts]
 */
export function createRelay(opts = {}) {
  const maxPerRoom = opts.maxPerRoom ?? 8;
  const unreliableBacklog = opts.unreliableBacklog ?? UNRELIABLE_BACKLOG;
  const maxRooms = opts.maxRooms ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10000;
  const log = opts.log ?? (() => {});

  /** @type {Map<string, { code: string, host: any, clients: Map<string, any>, nextId: number, createdAt: number }>} */
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

  const leave = (client) => {
    const room = client.room;
    if (!room) return;
    client.room = null;
    if (client.isHost) {
      rooms.delete(room.code);
      for (const c of room.clients.values()) {
        c.room = null;
        sendJson(c.ws, { op: 'hostLeft' });
        c.ws.close(4000, 'host left');
      }
      room.clients.clear();
      log(`[relay] room ${room.code} closed`);
    } else if (room.clients.get(client.id) === client) {
      room.clients.delete(client.id);
      sendJson(room.host.ws, { op: 'peerLeave', id: client.id });
    }
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
        const room = { code, host: client, clients: new Map(), nextId: 1, createdAt: Date.now() };
        rooms.set(code, room);
        client.room = room;
        client.isHost = true;
        client.id = HOST_ID;
        sendJson(ws, { op: 'created', code, id: HOST_ID, hostId: HOST_ID });
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
      sendJson(room.host.ws, { op: 'peerJoin', id });
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
    } else {
      deliver(room.host, flags, client.id, payload);
    }
  };

  wss.on('connection', (ws) => {
    const client = { ws, id: '', room: null, isHost: false, alive: true, helloTimer: null };
    client.helloTimer = setTimeout(() => {
      if (!client.room) ws.close(4001, 'hello timeout');
    }, helloTimeoutMs);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
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
    ws.on('close', () => {
      clearTimeout(client.helloTimer);
      leave(client);
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
      if (!c.alive) {
        ws.terminate();
        continue;
      }
      c.alive = false;
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
      for (const r of rooms.values()) players += 1 + r.clients.size;
      return { rooms: rooms.size, players, droppedUnreliable };
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      rooms.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
