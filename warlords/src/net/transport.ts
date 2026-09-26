// Transport abstraction shared by Loopback / PeerJS / WebSocket-relay.
// A host transport talks to many peers; a client transport has exactly one
// peer: the host (`hostId`). Payloads are either JSON text or binary.
import type { NetError } from './errors';

export type PeerId = string;
export type Channel = 'reliable' | 'unreliable';
export type Payload = string | Uint8Array;

export type MessageHandler = (from: PeerId, data: Payload, channel: Channel) => void;
/** State of a transport's own link (the relay socket): 'reconnecting' while it is being re-established. */
export type LinkState = 'ok' | 'reconnecting';
export type LinkStateHandler = (state: LinkState) => void;
export type PeerHandler = (peer: PeerId) => void;
export type CloseHandler = (err: NetError | null) => void;

export interface Transport {
  readonly kind: 'loopback' | 'peer' | 'ws';
  /** this endpoint's peer id */
  readonly selfId: PeerId;
  /** the host's peer id (=== selfId on the host) */
  readonly hostId: PeerId;
  readonly isHost: boolean;
  /** Send to one peer. Unreliable messages may be dropped under congestion. */
  send(to: PeerId, data: Payload, channel?: Channel): void;
  /** Host: send to every connected peer. Client: send to the host. */
  broadcast(data: Payload, channel?: Channel): void;
  onMessage(cb: MessageHandler): () => void;
  onPeerJoin(cb: PeerHandler): () => void;
  onPeerLeave(cb: PeerHandler): () => void;
  /** The transport itself went away (client: lost the host / relay; host: signalling died). */
  onClose(cb: CloseHandler): () => void;
  /** Host only: drop one peer's connection. */
  disconnect(peer: PeerId): void;
  /** Close everything. Idempotent. Does not fire onClose. */
  close(): void;
  /**
   * Optional (client): true while this link itself reports the host's departure — a
   * relay socket whose relay answers: the relay says 'hostLeft' when the host really
   * goes, so the host's silence alone (a frozen page) is no reason to give up (MP2-1).
   */
  hostPresenceWatched?(): boolean;
  /**
   * Optional (host): the transport re-establishes its own link by itself (the relay
   * keeps the room meanwhile, MP2-8); peers can neither hear nor reach the host while
   * it is 'reconnecting'. onClose fires only if that fails for good.
   */
  onLinkState?(cb: LinkStateHandler): () => void;
}

/** Listener bookkeeping shared by the concrete transports. */
export abstract class BaseTransport implements Transport {
  abstract readonly kind: Transport['kind'];
  abstract readonly selfId: PeerId;
  abstract readonly hostId: PeerId;
  abstract readonly isHost: boolean;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly joinHandlers = new Set<PeerHandler>();
  private readonly leaveHandlers = new Set<PeerHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  protected closed = false;

  abstract send(to: PeerId, data: Payload, channel?: Channel): void;
  abstract broadcast(data: Payload, channel?: Channel): void;
  abstract disconnect(peer: PeerId): void;
  protected abstract doClose(): void;

  onMessage(cb: MessageHandler): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeerJoin(cb: PeerHandler): () => void {
    this.joinHandlers.add(cb);
    return () => this.joinHandlers.delete(cb);
  }

  onPeerLeave(cb: PeerHandler): () => void {
    this.leaveHandlers.add(cb);
    return () => this.leaveHandlers.delete(cb);
  }

  onClose(cb: CloseHandler): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.doClose();
    } finally {
      this.messageHandlers.clear();
      this.joinHandlers.clear();
      this.leaveHandlers.clear();
      this.closeHandlers.clear();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  protected emitMessage(from: PeerId, data: Payload, channel: Channel): void {
    if (this.closed) return;
    for (const cb of [...this.messageHandlers]) {
      try {
        cb(from, data, channel);
      } catch (err) {
        console.error('[net] message handler threw', err);
      }
    }
  }

  protected emitJoin(peer: PeerId): void {
    if (this.closed) return;
    for (const cb of [...this.joinHandlers]) {
      try {
        cb(peer);
      } catch (err) {
        console.error('[net] peerJoin handler threw', err);
      }
    }
  }

  protected emitLeave(peer: PeerId): void {
    if (this.closed) return;
    for (const cb of [...this.leaveHandlers]) {
      try {
        cb(peer);
      } catch (err) {
        console.error('[net] peerLeave handler threw', err);
      }
    }
  }

  /** Fatal transport failure: notify, then close. */
  protected fail(err: NetError | null): void {
    if (this.closed) return;
    for (const cb of [...this.closeHandlers]) {
      try {
        cb(err);
      } catch (e) {
        console.error('[net] close handler threw', e);
      }
    }
    this.close();
  }
}

/** Normalise whatever a data channel / socket delivered into a Payload. */
export function toPayload(data: unknown): Payload | null {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Race a promise against a timeout that rejects with `err()`. */
export function withTimeout<T>(p: Promise<T>, ms: number, err: () => Error, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(err());
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
