// WebSocket transport through the relay in server/server.mjs (LAN / self-host).
//
// Relay protocol (v1):
//  control = JSON text frames
//    → {op:'create', v, code?}          ← {op:'created', code, id, hostId}
//    → {op:'join', v, code}             ← {op:'joined', code, id, hostId}
//    → {op:'kick', id}          (host)  ← {op:'peerJoin', id} / {op:'peerLeave', id} (host)
//                                       ← {op:'hostLeft'} / {op:'error', code, message}
//  data = binary frames: [flags u8][idLen u8][peer id ascii][payload]
//    flags bit0 = payload is binary (else UTF-8 text), bit1 = unreliable
//    sender writes the destination id ('*' = all clients, host only);
//    the relay rewrites it to the sender's id on delivery.
import { NetError } from './errors';
import { StallAwareTimeout } from './stall';
import { BaseTransport, type Channel, type Payload, type PeerId } from './transport';

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
  | { op: 'created'; code: string; id: string; hostId: string }
  | { op: 'joined'; code: string; id: string; hostId: string }
  | { op: 'peerJoin'; id: string }
  | { op: 'peerLeave'; id: string }
  | { op: 'hostLeft' }
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

export interface WsConnectOptions {
  timeoutMs?: number;
  /** WebSocket constructor override (tests) */
  WebSocketImpl?: typeof WebSocket;
}

export class WsTransport extends BaseTransport {
  readonly kind = 'ws' as const;
  readonly isHost: boolean;
  selfId: PeerId = '';
  hostId: PeerId = '';
  roomCode = '';
  private readonly ws: WebSocket;
  /** host: connected client ids */
  private readonly peerIds = new Set<PeerId>();
  /** diagnostics (tests / debug overlay) */
  readonly stats = { unreliableDropped: 0 };

  private constructor(ws: WebSocket, isHost: boolean) {
    super();
    this.ws = ws;
    this.isHost = isHost;
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
      const t = new WsTransport(ws, isHost);
      let settled = false;
      // responsive time (stall.ts): a page frozen meanwhile (a rejoin while the
      // scene builds) still gets to read the relay's queued answer
      const timer = new StallAwareTimeout(opts.timeoutMs ?? 8000, () => {
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
          resolve(t);
        }
      };
      ws.onopen = () => ws.send(JSON.stringify(hello));
      ws.onerror = () => settle(new NetError('serverUnreachable'));
      ws.onclose = () => {
        if (!settled) settle(new NetError('serverUnreachable'));
        else t.onSocketClosed();
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let msg: Control;
          try {
            msg = JSON.parse(ev.data) as Control;
          } catch {
            return;
          }
          if (!settled) {
            if (msg.op === 'created' || msg.op === 'joined') {
              t.selfId = msg.id;
              t.hostId = msg.hostId;
              t.roomCode = msg.code;
              settle(null);
            } else if (msg.op === 'error') {
              settle(relayErrorToNet(msg.code));
            }
            return;
          }
          t.onControl(msg);
          return;
        }
        if (!settled) return;
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
        if (buf) t.onFrame(buf);
      };
    });
  }

  private onControl(msg: Control): void {
    switch (msg.op) {
      case 'peerJoin':
        if (this.isHost) {
          this.peerIds.add(msg.id);
          this.emitJoin(msg.id);
        }
        break;
      case 'peerLeave':
        if (this.isHost) {
          this.peerIds.delete(msg.id);
          this.emitLeave(msg.id);
        }
        break;
      case 'hostLeft':
        if (!this.isHost) {
          this.emitLeave(this.hostId);
          this.fail(new NetError('hostLeft'));
        }
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
    if (!this.isHost) this.emitLeave(this.hostId);
    this.fail(new NetError(this.isHost ? 'serverUnreachable' : 'connectionLost', 'relay connection closed'));
  }

  /** Bytes of queued data above which unreliable frames are dropped. */
  get unreliableBacklog(): number {
    return UNRELIABLE_BACKLOG_PER_PEER * (this.isHost ? Math.max(1, this.peerIds.size) : 1);
  }

  send(to: PeerId, data: Payload, channel: Channel = 'reliable'): void {
    if (this.closed || this.ws.readyState !== 1) return;
    if (channel === 'unreliable' && this.ws.bufferedAmount > this.unreliableBacklog) {
      this.stats.unreliableDropped++;
      return; // superseded by the next snapshot / input
    }
    this.ws.send(encodeRelayFrame(this.isHost ? to : this.hostId, data, channel));
  }

  broadcast(data: Payload, channel: Channel = 'reliable'): void {
    this.send(this.isHost ? '*' : this.hostId, data, channel);
  }

  disconnect(peer: PeerId): void {
    if (!this.isHost || this.closed || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ op: 'kick', id: peer }));
  }

  protected doClose(): void {
    try {
      this.ws.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }
}
