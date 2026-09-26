// WebSocket transport through the relay in server/server.mjs (LAN / self-host).
//
// Relay protocol (v1, see server/relay.mjs):
//  control = JSON text frames
//    → {op:'create', v, code?}          ← {op:'created', code, id, hostId, secret}
//    → {op:'join', v, code}             ← {op:'joined', code, id, hostId}
//    → {op:'resume', v, code, secret}   ← {op:'resumed', code, id, hostId, peers}  (host, after a drop)
//    → {op:'ping'}                      ← {op:'pong', host?}
//    → {op:'kick', id}          (host)  ← {op:'peerJoin', id} / {op:'peerLeave', id} (host)
//                                       ← {op:'hostLeft'} / {op:'error', code, message}
//  data = binary frames: [flags u8][idLen u8][peer id ascii][payload]
//    flags bit0 = payload is binary (else UTF-8 text), bit1 = unreliable
//    sender writes the destination id ('*' = all clients, host only);
//    the relay rewrites it to the sender's id on delivery.
//
// Resilience: both sides ping the relay (a relay that stops answering means a dead
// socket, closed at once); a guest whose relay answers never gives up on a silent
// host (hostPresenceWatched, MP2-1); the host whose socket drops gets its room back
// (the relay keeps it HOST_GRACE_MS), keeping its reliable frames meanwhile (MP2-8).
import { NetError } from './errors';
import { maxStepFor, ResponsiveClock, StallAwareTimeout } from './stall';
import { BaseTransport, type Channel, type LinkState, type LinkStateHandler, type Payload, type PeerId } from './transport';

export const RELAY_PROTOCOL_VERSION = 1;
/**
 * Unreliable frames are dropped while more than this much data per peer is
 * queued on the socket (~4 snapshots each). The host's single socket carries
 * every client's snapshots, so its budget scales with the number of clients —
 * otherwise a normal snapshot round (one per client, sent back to back) would
 * starve the last clients.
 */
export const UNRELIABLE_BACKLOG_PER_PEER = 12 * 1024;

const F_BINARY = 1;
const F_UNRELIABLE = 2;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeRelayFrame(peer: string, data: Payload, channel: Channel): Uint8Array<ArrayBuffer> {
  const id = enc.encode(peer);
  const body = typeof data === 'string' ? enc.encode(data) : data;
  const out = new Uint8Array(2 + id.length + body.length);
  out[0] = (typeof data === 'string' ? 0 : F_BINARY) | (channel === 'unreliable' ? F_UNRELIABLE : 0);
  out[1] = id.length;
  out.set(id, 2);
  out.set(body, 2 + id.length);
  return out;
}

export function decodeRelayFrame(buf: Uint8Array): { peer: string; data: Payload; channel: Channel } | null {
  if (buf.length < 2) return null;
  const flags = buf[0];
  const idLen = buf[1];
  if (buf.length < 2 + idLen) return null;
  const peer = dec.decode(buf.subarray(2, 2 + idLen));
  const body = buf.subarray(2 + idLen);
  return {
    peer,
    data: flags & F_BINARY ? body.slice() : dec.decode(body),
    channel: flags & F_UNRELIABLE ? 'unreliable' : 'reliable',
  };
}

/**
 * Resolve the relay URL: explicit setting (accepts "host:port", "http(s)://…",
 * "ws(s)://…"; adds "/ws" when no path), else same-origin "/ws" when the page is
 * served over http(s) (i.e. by our server). null when nothing applies.
 */
export function resolveWsUrl(configured: string, loc: { protocol: string; host: string } | null = pageLocation()): string | null {
  const raw = configured.trim();
  if (raw) {
    let url = raw;
    if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
    else if (!/^wss?:\/\//i.test(url)) url = `${loc?.protocol === 'https:' ? 'wss' : 'ws'}://${url}`;
    try {
      const u = new URL(url);
      if (u.pathname === '' || u.pathname === '/') u.pathname = '/ws';
      return u.toString();
    } catch {
      return null;
    }
  }
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.host) {
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  }
  return null;
}

function pageLocation(): { protocol: string; host: string } | null {
  const l = (globalThis as { location?: { protocol: string; host: string } }).location;
  return l ? { protocol: l.protocol, host: l.host } : null;
}

type Control =
  | { op: 'created'; code: string; id: string; hostId: string; secret?: string }
  | { op: 'joined'; code: string; id: string; hostId: string }
  | { op: 'resumed'; code: string; id: string; hostId: string; peers?: string[] }
  | { op: 'peerJoin'; id: string }
  | { op: 'peerLeave'; id: string }
  | { op: 'hostLeft' }
  | { op: 'pong'; host?: boolean }
  | { op: 'error'; code: string; message?: string };

function relayErrorToNet(code: string): NetError {
  switch (code) {
    case 'roomNotFound':
      return new NetError('roomNotFound');
    case 'roomFull':
      return new NetError('roomFull');
    case 'codeTaken':
      return new NetError('roomFull', 'room code taken');
    case 'version':
      return new NetError('versionMismatch');
    default:
      return new NetError('serverUnreachable', code);
  }
}

/** Liveness ping to the relay (ms): its answers tell the watchdogs the socket is alive. */
export const RELAY_PING_MS = 5000;
/**
 * A guest's socket counts as watching the host (hostPresenceWatched) while the relay
 * answered within this long (ms of responsive time): the relay would say 'hostLeft'.
 */
export const RELAY_WATCH_MS = 12_000;
/** A relay that answers pings but has been silent this long (responsive ms): the socket is dead. */
export const RELAY_DEAD_MS = 20_000;
/**
 * Host: how long it tries to get its room back after its relay socket dropped
 * (responsive ms) — longer than the relay's HOST_GRACE_MS (30 s), so a restarted relay
 * gets the room re-created under the same code too (MP2-8).
 */
export const RESUME_WINDOW_MS = 45_000;
/** Pauses between the host's attempts to reconnect to the relay (ms; the last repeats). */
const RESUME_BACKOFF_MS = [250, 500, 1000, 2000, 3000];
/** Reliable frames the host keeps while it reconnects to the relay (bytes; beyond: dropped). */
const RESUME_QUEUE_BYTES = 4 * 1024 * 1024;

export interface WsConnectOptions {
  timeoutMs?: number;
  /** WebSocket constructor override (tests) */
  WebSocketImpl?: typeof WebSocket;
  /** relay liveness ping period (ms, default RELAY_PING_MS; tests) */
  pingMs?: number;
  /** host: how long to try to get the room back after a drop (ms, default RESUME_WINDOW_MS; tests) */
  resumeWindowMs?: number;
}

type SocketLike = WebSocket;

export class WsTransport extends BaseTransport {
  readonly kind = 'ws' as const;
  readonly isHost: boolean;
  selfId: PeerId = '';
  hostId: PeerId = '';
  roomCode = '';
  private ws: SocketLike;
  private readonly url: string;
  private readonly Impl: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly pingMs: number;
  private readonly resumeWindowMs: number;
  /** host: the room's secret from 'created' (resume after a drop); '' with a relay that has none */
  private secret = '';
  /** host: re-establishing the relay socket (frames are kept / dropped meanwhile) */
  private resuming = false;
  private pending: (string | Uint8Array<ArrayBuffer>)[] = [];
  private pendingBytes = 0;
  private readonly linkHandlers = new Set<LinkStateHandler>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** silence of the relay in responsive time (any message resets it) */
  private relayClock: ResponsiveClock;
  private relaySilentMs = 0;
  /** the relay answered a ping once: it supports them (older relays do not) */
  private relayPings = false;
  /** guest: the relay's last word on whether the host is connected */
  private hostConnected = true;
  /** host: connected client ids */
  private readonly peerIds = new Set<PeerId>();
  /** diagnostics (tests / debug overlay) */
  readonly stats = { unreliableDropped: 0, resumed: 0 };

  private constructor(ws: SocketLike, isHost: boolean, url: string, Impl: typeof WebSocket, opts: WsConnectOptions) {
    super();
    this.ws = ws;
    this.isHost = isHost;
    this.url = url;
    this.Impl = Impl;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.pingMs = Math.max(10, opts.pingMs ?? RELAY_PING_MS);
    this.resumeWindowMs = Math.max(0, opts.resumeWindowMs ?? RESUME_WINDOW_MS);
    this.relayClock = new ResponsiveClock(maxStepFor(this.pingMs));
  }

  /** Create a room on the relay (optionally requesting a specific code). */
  static host(url: string, opts: WsConnectOptions & { code?: string } = {}): Promise<WsTransport> {
    return WsTransport.open(url, true, { op: 'create', v: RELAY_PROTOCOL_VERSION, code: opts.code }, opts);
  }

  static join(url: string, code: string, opts: WsConnectOptions = {}): Promise<WsTransport> {
    return WsTransport.open(url, false, { op: 'join', v: RELAY_PROTOCOL_VERSION, code }, opts);
  }

  private static open(url: string, isHost: boolean, hello: object, opts: WsConnectOptions): Promise<WsTransport> {
    const Impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) return Promise.reject(new NetError('unsupported'));
    return new Promise<WsTransport>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new Impl(url);
      } catch (e) {
        reject(new NetError('serverUnreachable', e instanceof Error ? e.message : undefined));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const t = new WsTransport(ws, isHost, url, Impl, opts);
      let settled = false;
      // responsive time (stall.ts): a page frozen meanwhile (a rejoin while the
      // scene builds) still gets to read the relay's queued answer
      const timer = new StallAwareTimeout(t.timeoutMs, () => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new NetError('timeout'));
      });
      const settle = (err: NetError | null): void => {
        if (settled) return;
        settled = true;
        timer.cancel();
        if (err) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(err);
        } else {
          t.wire(ws);
          t.startPings();
          resolve(t);
        }
      };
      ws.onopen = () => ws.send(JSON.stringify(hello));
      ws.onerror = () => settle(new NetError('serverUnreachable'));
      ws.onclose = () => settle(new NetError('serverUnreachable'));
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        const msg = parseControl(ev.data);
        if (!msg) return;
        if (msg.op === 'created' || msg.op === 'joined') {
          t.selfId = msg.id;
          t.hostId = msg.hostId;
          t.roomCode = msg.code;
          if (msg.op === 'created' && typeof msg.secret === 'string') t.secret = msg.secret;
          settle(null);
        } else if (msg.op === 'error') {
          settle(relayErrorToNet(msg.code));
        }
      };
    });
  }

  /** Route an open, settled socket's traffic into this transport. */
  private wire(ws: SocketLike): void {
    ws.onopen = null;
    ws.onerror = () => undefined; // 'close' follows
    ws.onclose = () => {
      if (ws === this.ws) this.onSocketClosed();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ws !== this.ws || this.closed) return;
      this.relaySilentMs = 0; // any word from the relay: the socket is alive
      if (typeof ev.data === 'string') {
        const msg = parseControl(ev.data);
        if (msg) this.onControl(msg);
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
      if (buf) this.onFrame(buf);
    };
  }

  private startPings(): void {
    if (this.pingTimer) return;
    this.relayClock.reset();
    this.pingTimer = setInterval(() => this.pingRelay(), this.pingMs);
  }

  /**
   * Liveness (MP2-1 / MP2-8): ping the relay; a relay that answers pings but has gone
   * silent (in responsive time) means a dead socket the browser has not noticed — close
   * it now (a guest rejoins, the host resumes its room).
   */
  private pingRelay(): void {
    const step = this.relayClock.tick();
    if (this.closed || this.resuming) return;
    this.relaySilentMs += step;
    if (this.relayPings && !this.relayClock.stalled && this.relaySilentMs > RELAY_DEAD_MS) {
      console.warn('[net] the relay stopped answering: dropping the socket');
      const ws = this.ws;
      ws.onclose = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.onSocketClosed();
      return;
    }
    if (this.ws.readyState === 1) this.ws.send('{"op":"ping"}');
  }

  private onControl(msg: Control): void {
    switch (msg.op) {
      case 'peerJoin':
        if (this.isHost && !this.peerIds.has(msg.id)) {
          this.peerIds.add(msg.id);
          this.emitJoin(msg.id);
        }
        break;
      case 'peerLeave':
        if (this.isHost && this.peerIds.delete(msg.id)) this.emitLeave(msg.id);
        break;
      case 'hostLeft':
        if (!this.isHost) {
          this.emitLeave(this.hostId);
          this.fail(new NetError('hostLeft'));
        }
        break;
      case 'pong':
        this.relayPings = true;
        this.hostConnected = msg.host !== false;
        break;
      case 'error':
        console.warn('[net] relay error', msg.code, msg.message ?? '');
        break;
      default:
        break;
    }
  }

  private onFrame(buf: Uint8Array): void {
    const f = decodeRelayFrame(buf);
    if (!f) return;
    this.emitMessage(this.isHost ? f.peer : this.hostId, f.data, f.channel);
  }

  private onSocketClosed(): void {
    if (this.closed) return;
    // the host gets its room back: the relay keeps it for a while after a drop (MP2-8)
    if (this.isHost && this.secret) {
      void this.resume();
      return;
    }
    if (!this.isHost) this.emitLeave(this.hostId);
    this.fail(new NetError(this.isHost ? 'relayLost' : 'connectionLost', 'relay connection closed'));
  }

  /**
   * Host: the relay socket dropped. Reconnect and resume the room with its secret — the
   * relay kept it and the guests' sockets for its grace period; a relay that restarted
   * meanwhile gets the room created again under the same code (the guests' rejoins find
   * it). Reliable frames sent meanwhile are kept and delivered afterwards. Gives up after
   * resumeWindowMs of responsive time: onClose('relayLost').
   */
  private async resume(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    this.emitLinkState('reconnecting');
    const budget = new StallAwareTimeout(this.resumeWindowMs, () => undefined);
    try {
      for (let attempt = 0; !this.closed; attempt++) {
        if (attempt > 0) {
          if (!budget.pending) break;
          await new Promise((r) => setTimeout(r, RESUME_BACKOFF_MS[Math.min(attempt - 1, RESUME_BACKOFF_MS.length - 1)]));
          if (this.closed) return;
        }
        try {
          await this.openResume(); // (adopted the new socket already)
          return;
        } catch (e) {
          console.info('[net] relay: room not back yet', e instanceof Error ? e.message : e);
        }
      }
    } finally {
      budget.cancel();
      this.resuming = false;
    }
    if (!this.closed) this.fail(new NetError('relayLost'));
  }

  /**
   * One attempt: a new socket that resumes the room (or re-creates it under the same code),
   * adopted as soon as the relay says so — inside that message handler: the frames the
   * relay sends right behind its answer (what the guests sent meanwhile) may be dispatched
   * before any promise continuation runs, and must reach the wired socket.
   */
  private openResume(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: SocketLike;
      try {
        ws = new this.Impl(this.url);
      } catch (e) {
        reject(new NetError('serverUnreachable', e instanceof Error ? e.message : undefined));
        return;
      }
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const done = (err: NetError | null, value?: { ws: SocketLike; peers: string[]; secret?: string }): void => {
        if (settled) return;
        settled = true;
        timer.cancel();
        if (err || !value) {
          ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(err ?? new NetError('serverUnreachable'));
          return;
        }
        if (this.closed) {
          ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        } else this.adopt(value);
        resolve();
      };
      const timer = new StallAwareTimeout(this.timeoutMs, () => done(new NetError('timeout')));
      ws.onopen = () => ws.send(JSON.stringify({ op: 'resume', v: RELAY_PROTOCOL_VERSION, code: this.roomCode, secret: this.secret }));
      ws.onerror = () => done(new NetError('serverUnreachable'));
      ws.onclose = () => done(new NetError('serverUnreachable'));
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        const msg = parseControl(ev.data);
        if (!msg) return;
        if (msg.op === 'resumed') {
          done(null, { ws, peers: Array.isArray(msg.peers) ? msg.peers.filter((p) => typeof p === 'string') : [] });
        } else if (msg.op === 'created') {
          // the relay had forgotten the room: made again — under the same code, or it is useless
          if (msg.code === this.roomCode) done(null, { ws, peers: [], secret: typeof msg.secret === 'string' ? msg.secret : '' });
          else done(new NetError('roomNotFound', 'room code taken'));
        } else if (msg.op === 'error') {
          if (msg.code === 'roomNotFound') ws.send(JSON.stringify({ op: 'create', v: RELAY_PROTOCOL_VERSION, code: this.roomCode }));
          else done(relayErrorToNet(msg.code));
        }
      };
    });
  }

  /** The room is back on `got.ws`: swap the socket, reconcile the guests, flush what was kept. */
  private adopt(got: { ws: SocketLike; peers: string[]; secret?: string }): void {
    const old = this.ws;
    old.onopen = old.onclose = old.onmessage = old.onerror = null;
    try {
      old.close();
    } catch {
      /* ignore */
    }
    this.ws = got.ws;
    if (got.secret !== undefined) this.secret = got.secret;
    this.wire(got.ws);
    this.relaySilentMs = 0;
    this.relayClock.reset();
    this.stats.resumed++;
    const here = new Set(got.peers);
    for (const id of [...this.peerIds]) {
      if (here.has(id)) continue;
      this.peerIds.delete(id);
      this.emitLeave(id);
    }
    for (const id of got.peers) {
      if (this.peerIds.has(id)) continue;
      this.peerIds.add(id);
      this.emitJoin(id);
    }
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const f of queued) if (!this.closed && this.ws.readyState === 1) this.ws.send(f);
    console.info(`[net] relay: room ${this.roomCode} back (${got.peers.length} guests)`);
    this.emitLinkState('ok');
  }

  private emitLinkState(state: LinkState): void {
    for (const cb of [...this.linkHandlers]) {
      try {
        cb(state);
      } catch (err) {
        console.error('[net] link state handler threw', err);
      }
    }
  }

  /** Host: the relay socket is being re-established ('reconnecting') / back ('ok') (MP2-8). */
  onLinkState(cb: LinkStateHandler): () => void {
    this.linkHandlers.add(cb);
    return () => this.linkHandlers.delete(cb);
  }

  /**
   * Guest: the relay answers, so it will say 'hostLeft' when the host really goes (it
   * keeps the room while the host's socket reconnects): the host's silence alone is no
   * reason to give up (MP2-1). False on a relay without pings (older server) or one that
   * went quiet.
   */
  hostPresenceWatched(): boolean {
    return !this.isHost && !this.closed && this.ws.readyState === 1 && this.relayPings && this.relaySilentMs < RELAY_WATCH_MS;
  }

  /** Guest: the relay's last word on whether the host's socket is connected (diagnostics). */
  get hostOnRelay(): boolean {
    return this.hostConnected;
  }

  /** Bytes of queued data above which unreliable frames are dropped. */
  get unreliableBacklog(): number {
    return UNRELIABLE_BACKLOG_PER_PEER * (this.isHost ? Math.max(1, this.peerIds.size) : 1);
  }

  send(to: PeerId, data: Payload, channel: Channel = 'reliable'): void {
    if (this.closed) return;
    if (this.resuming) {
      // kept for after the reconnect (the guests' views stay consistent); snapshots are superseded anyway
      if (channel === 'reliable') this.keep(encodeRelayFrame(this.isHost ? to : this.hostId, data, channel));
      return;
    }
    if (this.ws.readyState !== 1) return;
    if (channel === 'unreliable' && this.ws.bufferedAmount > this.unreliableBacklog) {
      this.stats.unreliableDropped++;
      return; // superseded by the next snapshot / input
    }
    this.ws.send(encodeRelayFrame(this.isHost ? to : this.hostId, data, channel));
  }

  private keep(frame: string | Uint8Array<ArrayBuffer>): void {
    const n = typeof frame === 'string' ? frame.length : frame.byteLength;
    if (this.pendingBytes + n > RESUME_QUEUE_BYTES) return;
    this.pending.push(frame);
    this.pendingBytes += n;
  }

  broadcast(data: Payload, channel: Channel = 'reliable'): void {
    this.send(this.isHost ? '*' : this.hostId, data, channel);
  }

  disconnect(peer: PeerId): void {
    if (!this.isHost || this.closed) return;
    const kick = JSON.stringify({ op: 'kick', id: peer });
    if (this.resuming) this.keep(kick);
    else if (this.ws.readyState === 1) this.ws.send(kick);
  }

  protected doClose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pending = [];
    this.linkHandlers.clear();
    try {
      this.ws.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }
}

function parseControl(text: string): Control | null {
  try {
    const m = JSON.parse(text) as Control;
    return m && typeof m === 'object' && typeof m.op === 'string' ? m : null;
  } catch {
    return null;
  }
}
