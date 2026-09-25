// In-memory transport: single player (a host with no peers) and tests
// (a host + N clients in one process). Delivery is asynchronous like a real
// network; optional latency / unreliable-loss simulation for tests.
import { NetError } from './errors';
import { BaseTransport, type Channel, type Payload, type PeerId } from './transport';

export interface LoopbackOptions {
  /** one-way delay in ms (0 = next microtask) */
  latencyMs?: number;
  /** probability [0,1] that an unreliable message is dropped */
  unreliableLoss?: number;
  /** deterministic random source for loss simulation */
  random?: () => number;
}

const copyPayload = (d: Payload): Payload => (typeof d === 'string' ? d : d.slice());

export class LoopbackNetwork {
  private host: LoopbackTransport | null = null;
  private readonly clients = new Map<PeerId, LoopbackTransport>();
  private readonly severed = new Set<PeerId>();
  private nextClient = 1;

  constructor(readonly opts: LoopbackOptions = {}) {}

  /** Create the host endpoint (one per network). */
  createHost(hostId: PeerId = 'host'): LoopbackTransport {
    if (this.host && !this.host.isClosed) throw new Error('LoopbackNetwork: host already exists');
    this.host = new LoopbackTransport(this, hostId, hostId, true);
    return this.host;
  }

  /** Connect a new client; resolves once the host has seen the join. */
  async connect(clientId?: PeerId): Promise<LoopbackTransport> {
    const host = this.host;
    if (!host || host.isClosed) throw new NetError('roomNotFound');
    const id = clientId ?? `c${this.nextClient++}`;
    if (this.clients.has(id)) throw new Error(`LoopbackNetwork: client id ${id} in use`);
    const client = new LoopbackTransport(this, id, host.selfId, false);
    this.clients.set(id, client);
    await this.delay();
    host.peerJoined(id);
    return client;
  }

  /**
   * Test helper: silently cut a client off (a dead NAT mapping, a pulled
   * cable): nothing is delivered either way and nobody is told.
   */
  sever(clientId: PeerId): void {
    this.severed.add(clientId);
  }

  /** Test helper: undo sever() — a link that was only silent for a while (frozen host, congested path). */
  restore(clientId: PeerId): void {
    this.severed.delete(clientId);
  }

  /** @internal */
  deliver(from: LoopbackTransport, to: PeerId, data: Payload, channel: Channel): void {
    if (this.severed.has(from.selfId) || this.severed.has(to)) return;
    if (channel === 'unreliable' && this.opts.unreliableLoss) {
      const r = (this.opts.random ?? Math.random)();
      if (r < this.opts.unreliableLoss) return;
    }
    const target = to === this.host?.selfId ? this.host : this.clients.get(to);
    if (!target || target.isClosed) return;
    const payload = copyPayload(data);
    // like a real socket, messages sent right before close() are still delivered
    const fromId = from.selfId;
    this.schedule(() => target.receive(fromId, payload, channel));
  }

  /** @internal a client closed */
  clientClosed(client: LoopbackTransport): void {
    if (this.clients.get(client.selfId) !== client) return;
    this.clients.delete(client.selfId);
    if (this.severed.has(client.selfId)) return; // nobody hears a severed link close
    const host = this.host;
    if (host && !host.isClosed) this.schedule(() => host.peerLeft(client.selfId));
  }

  /** @internal the host closed: every client loses the connection */
  hostClosed(host: LoopbackTransport): void {
    if (this.host !== host) return;
    this.host = null;
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.schedule(() => {
      for (const c of clients) c.hostGone();
    });
  }

  /** @internal host kicks one client */
  dropClient(id: PeerId): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    const host = this.host;
    this.schedule(() => {
      c.hostGone();
      if (host && !host.isClosed) host.peerLeft(id);
    });
  }

  peers(): PeerId[] {
    return [...this.clients.keys()];
  }

  private schedule(fn: () => void): void {
    const ms = this.opts.latencyMs ?? 0;
    if (ms > 0) setTimeout(fn, ms);
    else queueMicrotask(fn);
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => this.schedule(resolve));
  }
}

export class LoopbackTransport extends BaseTransport {
  readonly kind = 'loopback' as const;

  constructor(
    private readonly net: LoopbackNetwork,
    readonly selfId: PeerId,
    readonly hostId: PeerId,
    readonly isHost: boolean,
  ) {
    super();
  }

  send(to: PeerId, data: Payload, channel: Channel = 'reliable'): void {
    if (this.closed) return;
    this.net.deliver(this, to, data, channel);
  }

  broadcast(data: Payload, channel: Channel = 'reliable'): void {
    if (this.closed) return;
    if (!this.isHost) {
      this.send(this.hostId, data, channel);
      return;
    }
    for (const p of this.net.peers()) this.net.deliver(this, p, data, channel);
  }

  disconnect(peer: PeerId): void {
    if (this.isHost) this.net.dropClient(peer);
  }

  protected doClose(): void {
    if (this.isHost) this.net.hostClosed(this);
    else this.net.clientClosed(this);
  }

  /** @internal */
  receive(from: PeerId, data: Payload, channel: Channel): void {
    this.emitMessage(from, data, channel);
  }

  /** @internal */
  peerJoined(id: PeerId): void {
    this.emitJoin(id);
  }

  /** @internal */
  peerLeft(id: PeerId): void {
    this.emitLeave(id);
  }

  /** @internal */
  hostGone(): void {
    if (this.closed) return;
    this.emitLeave(this.hostId);
    this.fail(new NetError('connectionLost'));
  }
}
