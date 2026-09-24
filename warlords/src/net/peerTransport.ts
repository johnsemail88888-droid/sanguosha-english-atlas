// PeerJS (WebRTC data channel) transport. The host registers the peer id
// `sgwl-<ROOM>` on the signalling server; each client opens two DataConnections
// to it: 'r' (reliable, ordered) for control/events and 'u' for snapshots and
// inputs. PeerJS's `reliable:false` only means unordered (lost messages are
// still retransmitted), so the 'u' channel is created with maxRetransmits: 0 —
// a lost snapshot is simply superseded by the next one — and unreliable sends
// are dropped as soon as a couple of snapshots are queued, so a congested link
// shows the newest state instead of seconds-old data. PeerJS is loaded lazily
// so single player and Node tests never touch WebRTC.
import type { DataConnection, Peer, PeerOptions } from 'peerjs';
import type { NetServerConfig } from '../game/settings';
import { NetError } from './errors';
import { generateRoomCode, hostPeerIdFor } from './roomCode';
import { BaseTransport, toPayload, type Channel, type Payload, type PeerId } from './transport';

/** China-reachable STUN first, then global fallbacks (GAME_SPEC §11). */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/** Unreliable sends are dropped while this much is queued on the data channel (~4 snapshots). */
export const UNRELIABLE_BACKLOG = 12 * 1024;

/** DataConnection labels: 'r' reliable ordered, 'u' lossy unordered. */
const RELIABLE_LABEL = 'r';
const UNRELIABLE_LABEL = 'u';

export function iceServersFor(net: NetServerConfig): RTCIceServer[] {
  const list = [...DEFAULT_ICE_SERVERS];
  if (net.turnUrl.trim()) {
    list.push({ urls: net.turnUrl.trim(), username: net.turnUser || undefined, credential: net.turnPass || undefined });
  }
  return list;
}

/** PeerJS constructor options from user settings (custom signalling server or the public cloud). */
export function peerOptionsFor(net: NetServerConfig): PeerOptions {
  // debug 0: we surface every failure ourselves as a bilingual NetError
  const opts: PeerOptions = { debug: 0, config: { iceServers: iceServersFor(net) } };
  const host = net.peerHost.trim();
  if (host) {
    opts.host = host;
    opts.port = net.peerPort || (net.peerSecure ? 443 : 80);
    opts.path = net.peerPath || '/';
    opts.secure = net.peerSecure;
    opts.key = 'peerjs';
  }
  return opts;
}

export type PeerCtor = typeof import('peerjs').Peer;
let peerCtorPromise: Promise<PeerCtor> | null = null;

function loadPeer(): Promise<PeerCtor> {
  if (!peerCtorPromise) {
    peerCtorPromise = import('peerjs').then((m) => m.Peer).catch((e: unknown) => {
      peerCtorPromise = null;
      throw new NetError('unsupported', e instanceof Error ? e.message : undefined);
    });
  }
  return peerCtorPromise;
}

function hasWebRtc(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== 'undefined';
}

/** Map PeerJS error types to our bilingual errors. */
export function mapPeerError(type: string | undefined, fallback: NetError['code'] = 'networkRestricted'): NetError {
  switch (type) {
    case 'peer-unavailable':
      return new NetError('roomNotFound');
    case 'unavailable-id':
      return new NetError('roomFull', 'room code taken');
    case 'browser-incompatible':
      return new NetError('unsupported');
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'ssl-unavailable':
    case 'webrtc':
      return new NetError('networkRestricted', type);
    default:
      return new NetError(fallback, type);
  }
}

interface PeerLink {
  r: DataConnection | null;
  u: DataConnection | null;
  joined: boolean;
}

export interface PeerConnectOptions {
  /** signalling connect timeout (ms) */
  signalTimeoutMs?: number;
  /** data channel open timeout (ms) */
  connectTimeoutMs?: number;
  /** Peer constructor override (tests); skips the WebRTC availability check */
  PeerImpl?: PeerCtor;
}

/**
 * Run `fn` (which synchronously creates PeerJS DataConnections) with
 * RTCPeerConnection.createDataChannel patched so the 'u' channel is created
 * fire-and-forget (unordered, no retransmissions). The creator's parameters
 * apply to both directions, so patching the client side is enough.
 */
function withLossyUnreliableChannel<T>(fn: () => T): T {
  const Ctor = (globalThis as { RTCPeerConnection?: { prototype: RTCPeerConnection } }).RTCPeerConnection;
  const proto = Ctor?.prototype;
  const orig = proto?.createDataChannel;
  if (!proto || typeof orig !== 'function') return fn();
  proto.createDataChannel = function (this: RTCPeerConnection, label: string, init?: RTCDataChannelInit): RTCDataChannel {
    return orig.call(this, label, label === UNRELIABLE_LABEL ? { ...init, ordered: false, maxRetransmits: 0 } : init);
  };
  try {
    return fn();
  } finally {
    proto.createDataChannel = orig;
  }
}

/** Why a DataConnection that never opened failed: NAT / ICE trouble unless the room is gone. */
export function preOpenFailure(err?: { type?: string } | null): NetError {
  if (err?.type === 'peer-unavailable') return new NetError('roomNotFound');
  return new NetError('networkRestricted', err?.type ?? 'data channel closed before opening');
}

export class PeerTransport extends BaseTransport {
  readonly kind = 'peer' as const;
  readonly selfId: PeerId;
  readonly hostId: PeerId;
  readonly isHost: boolean;
  readonly roomCode: string;
  private readonly peer: Peer;
  private readonly links = new Map<PeerId, PeerLink>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** diagnostics (tests / debug overlay) */
  readonly stats = { unreliableDropped: 0 };

  private constructor(peer: Peer, isHost: boolean, roomCode: string, hostId: PeerId) {
    super();
    this.peer = peer;
    this.isHost = isHost;
    this.roomCode = roomCode;
    this.selfId = peer.id;
    this.hostId = hostId;
  }

  /** Register `sgwl-<code>` (retrying with new codes if taken) and accept connections. */
  static async host(net: NetServerConfig, opts: PeerConnectOptions & { code?: string } = {}): Promise<PeerTransport> {
    if (!opts.PeerImpl && !hasWebRtc()) throw new NetError('unsupported');
    const PeerImpl = opts.PeerImpl ?? (await loadPeer());
    let lastErr: NetError = new NetError('networkRestricted');
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = attempt === 0 && opts.code ? opts.code : generateRoomCode();
      try {
        const peer = await openPeer(PeerImpl, hostPeerIdFor(code), net, opts.signalTimeoutMs ?? 10_000);
        const t = new PeerTransport(peer, true, code, peer.id);
        t.attachHost();
        return t;
      } catch (e) {
        lastErr = e instanceof NetError ? e : new NetError('networkRestricted');
        if (lastErr.code !== 'roomFull') throw lastErr; // only "id taken" is worth retrying
      }
    }
    throw lastErr;
  }

  /** Connect to the room's host. */
  static async join(net: NetServerConfig, code: string, opts: PeerConnectOptions = {}): Promise<PeerTransport> {
    if (!opts.PeerImpl && !hasWebRtc()) throw new NetError('unsupported');
    const PeerImpl = opts.PeerImpl ?? (await loadPeer());
    const peer = await openPeer(PeerImpl, null, net, opts.signalTimeoutMs ?? 10_000);
    const hostId = hostPeerIdFor(code);
    const t = new PeerTransport(peer, false, code, hostId);
    try {
      await t.connectToHost(opts.connectTimeoutMs ?? 15_000);
    } catch (e) {
      t.close();
      throw e;
    }
    return t;
  }

  // ── host side ────────────────────────────────────────────────────────────
  private attachHost(): void {
    this.peer.on('connection', (conn) => this.onIncoming(conn));
    this.peer.on('disconnected', () => this.scheduleReconnect());
    this.peer.on('error', (err: { type?: string }) => {
      // errors after open are mostly signalling hiccups; data channels keep working
      console.warn('[net] peer error', err.type ?? err);
      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-closed') this.scheduleReconnect();
    });
    this.peer.on('close', () => this.fail(new NetError('networkRestricted', 'signalling closed')));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.peer.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.peer.destroyed) return;
      if (this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.scheduleReconnect();
        }
      }
    }, 2000);
  }

  private onIncoming(conn: DataConnection): void {
    if (this.closed) {
      conn.close();
      return;
    }
    const kind = (conn.metadata as { ch?: string } | undefined)?.ch === UNRELIABLE_LABEL ? 'u' : 'r';
    const id = conn.peer;
    let link = this.links.get(id);
    if (!link) {
      link = { r: null, u: null, joined: false };
      this.links.set(id, link);
    }
    const prev = link[kind];
    if (prev && prev !== conn) prev.close();
    link[kind] = conn;
    const channel: Channel = kind === 'u' ? 'unreliable' : 'reliable';
    conn.on('data', (d: unknown) => {
      const p = toPayload(d);
      if (p !== null) this.emitMessage(id, p, channel);
    });
    conn.on('open', () => {
      const l = this.links.get(id);
      if (kind === 'r' && l && !l.joined) {
        l.joined = true;
        this.emitJoin(id);
      }
    });
    const onGone = (): void => {
      const l = this.links.get(id);
      if (!l || l[kind] !== conn) return;
      l[kind] = null;
      if (kind === 'r') {
        l.u?.close();
        this.links.delete(id);
        if (l.joined) this.emitLeave(id);
      }
    };
    conn.on('close', onGone);
    conn.on('error', onGone);
  }

  // ── client side ──────────────────────────────────────────────────────────
  private connectToHost(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const link: PeerLink = { r: null, u: null, joined: false };
      this.links.set(this.hostId, link);
      let settled = false;
      const done = (err: NetError | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.peer.off('error', onPeerError);
        if (err) reject(err);
        else resolve();
      };
      let r: DataConnection | undefined;
      const timer = setTimeout(() => {
        // the host answered but ICE never connected ⇒ NAT / firewall trouble
        const ice = r?.peerConnection?.iceConnectionState;
        done(ice === 'checking' || ice === 'failed' || ice === 'disconnected' ? new NetError('networkRestricted', `ICE ${ice}`) : new NetError('timeout'));
      }, timeoutMs);
      // peer-level errors: 'peer-unavailable' = no such room, else signalling trouble
      const onPeerError = (err: { type?: string }): void => done(mapPeerError(err.type));
      this.peer.on('error', onPeerError);

      let u: DataConnection | undefined;
      try {
        r = this.peer.connect(this.hostId, { reliable: true, serialization: 'raw', label: RELIABLE_LABEL, metadata: { ch: RELIABLE_LABEL } });
        u = withLossyUnreliableChannel(() =>
          this.peer.connect(this.hostId, { reliable: false, serialization: 'raw', label: UNRELIABLE_LABEL, metadata: { ch: UNRELIABLE_LABEL } }),
        );
      } catch (e) {
        done(new NetError('networkRestricted', e instanceof Error ? e.message : undefined));
        return;
      }
      if (!r) {
        done(new NetError('networkRestricted'));
        return;
      }
      link.r = r;
      link.u = u ?? null;
      const wire = (conn: DataConnection, channel: Channel): void => {
        conn.on('data', (d: unknown) => {
          const p = toPayload(d);
          if (p !== null) this.emitMessage(this.hostId, p, channel);
        });
      };
      wire(r, 'reliable');
      if (u) {
        wire(u, 'unreliable');
        const dropU = (): void => {
          if (link.u === u) link.u = null;
        };
        u.on('close', dropU);
        u.on('error', dropU);
      }
      r.on('open', () => {
        link.joined = true;
        done(null);
      });
      // Before the channel opened, a DataConnection error / close is an ICE or
      // negotiation failure (PeerJS emits 'negotiation-failed' then closes when
      // iceConnectionState turns 'failed') — typical behind symmetric NAT /
      // CGNAT. "Room not found" arrives separately as the peer-level
      // 'peer-unavailable' error above.
      const lostHost = (err?: { type?: string }): void => {
        if (!settled) {
          done(preOpenFailure(err));
          return;
        }
        this.emitLeave(this.hostId);
        this.fail(new NetError('connectionLost'));
      };
      r.on('close', () => lostHost());
      r.on('error', (err: { type?: string }) => lostHost(err));
      // the signalling link is not needed once connected; keep it for ICE restarts
      this.peer.on('disconnected', () => {
        if (!this.closed && settled) this.scheduleReconnect();
      });
    });
  }

  // ── Transport ────────────────────────────────────────────────────────────
  send(to: PeerId, data: Payload, channel: Channel = 'reliable'): void {
    if (this.closed) return;
    const link = this.links.get(this.isHost ? to : this.hostId);
    if (!link) return;
    let conn = channel === 'unreliable' ? (link.u?.open ? link.u : link.r) : link.r;
    if (!conn?.open) conn = link.r;
    if (!conn?.open) return;
    if (channel === 'unreliable' && isCongested(conn)) {
      this.stats.unreliableDropped++;
      return; // the next snapshot / input supersedes this one
    }
    try {
      void conn.send(data);
    } catch (err) {
      console.warn('[net] peer send failed', err);
    }
  }

  broadcast(data: Payload, channel: Channel = 'reliable'): void {
    if (!this.isHost) {
      this.send(this.hostId, data, channel);
      return;
    }
    for (const [id, link] of this.links) if (link.joined) this.send(id, data, channel);
  }

  disconnect(peer: PeerId): void {
    const link = this.links.get(peer);
    if (!link) return;
    link.u?.close();
    link.r?.close();
  }

  /** Debug: data channel parameters per link (label, ordered, maxRetransmits). */
  channelInfo(): { peer: PeerId; label: string; ordered: boolean; maxRetransmits: number | null }[] {
    const out: { peer: PeerId; label: string; ordered: boolean; maxRetransmits: number | null }[] = [];
    for (const [peer, link] of this.links) {
      for (const c of [link.r, link.u]) {
        const dc = c?.dataChannel;
        if (dc) out.push({ peer, label: dc.label, ordered: dc.ordered, maxRetransmits: dc.maxRetransmits });
      }
    }
    return out;
  }

  protected doClose(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const link of this.links.values()) {
      link.u?.close();
      link.r?.close();
    }
    this.links.clear();
    try {
      this.peer.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** More than a couple of snapshots already queued on this connection. */
export function isCongested(conn: { dataChannel?: RTCDataChannel | null; bufferSize?: number }): boolean {
  const queued = conn.dataChannel?.bufferedAmount ?? 0;
  return queued > UNRELIABLE_BACKLOG || (conn.bufferSize ?? 0) > 0;
}

/** Create a Peer and wait for the signalling server to accept it. */
function openPeer(PeerImpl: PeerCtor, id: string | null, net: NetServerConfig, timeoutMs: number): Promise<Peer> {
  return new Promise<Peer>((resolve, reject) => {
    let peer: Peer;
    try {
      const opts = peerOptionsFor(net);
      peer = id ? new PeerImpl(id, opts) : new PeerImpl(opts);
    } catch (e) {
      reject(new NetError('unsupported', e instanceof Error ? e.message : undefined));
      return;
    }
    let settled = false;
    const finish = (err: NetError | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onError);
      if (err) {
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve(peer);
      }
    };
    const onOpen = (): void => finish(null);
    const onError = (err: { type?: string }): void => finish(mapPeerError(err.type));
    const timer = setTimeout(() => finish(new NetError('networkRestricted', 'signalling timeout')), timeoutMs);
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}
