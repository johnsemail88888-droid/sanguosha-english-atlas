// PeerJS transport against a scripted fake PeerJS (error mapping, congestion,
// lossy channel creation) and WebSocket transport backpressure.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/game/settings';
import { NetError } from '../../../src/net/errors';
import { PeerTransport, UNRELIABLE_BACKLOG, type PeerCtor } from '../../../src/net/peerTransport';
import { UNRELIABLE_BACKLOG_PER_PEER, WsTransport } from '../../../src/net/wsTransport';

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly handlers = new Map<string, Set<Handler>>();
  on(ev: string, cb: Handler): this {
    let s = this.handlers.get(ev);
    if (!s) this.handlers.set(ev, (s = new Set()));
    s.add(cb);
    return this;
  }
  off(ev: string, cb: Handler): this {
    this.handlers.get(ev)?.delete(cb);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(ev) ?? [])]) cb(...args);
  }
}

interface ConnOptions {
  reliable?: boolean;
  label?: string;
  metadata?: unknown;
}

class FakeConn extends FakeEmitter {
  open = false;
  readonly label: string;
  readonly metadata: unknown;
  readonly dataChannel: { bufferedAmount: number; label: string; ordered: boolean; maxRetransmits: number | null };
  bufferSize = 0;
  readonly peerConnection = { iceConnectionState: 'new' as RTCIceConnectionState };
  readonly sent: unknown[] = [];

  constructor(
    readonly peer: string,
    opts: ConnOptions,
  ) {
    super();
    this.label = opts.label ?? 'dc';
    this.metadata = opts.metadata;
    this.dataChannel = { bufferedAmount: 0, label: this.label, ordered: !!opts.reliable, maxRetransmits: null };
  }
  send(d: unknown): void {
    this.sent.push(d);
  }
  /** like PeerJS: 'close' is only emitted for a connection that was open */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
  /** test helper */
  succeed(): void {
    this.open = true;
    this.emit('open');
  }
}

class FakePeer extends FakeEmitter {
  static instances: FakePeer[] = [];
  /** scripted behaviour for peer.connect() */
  static onConnect: ((c: FakeConn, p: FakePeer) => void) | null = null;
  readonly id: string;
  destroyed = false;
  disconnected = false;
  readonly conns: FakeConn[] = [];

  constructor(idOrOpts?: unknown, _opts?: unknown) {
    super();
    this.id = typeof idOrOpts === 'string' ? idOrOpts : `client-${FakePeer.instances.length + 1}`;
    FakePeer.instances.push(this);
    queueMicrotask(() => this.emit('open', this.id));
  }
  connect(peer: string, opts: ConnOptions): FakeConn {
    // mimic PeerJS: the originator creates the data channel synchronously
    const Pc = (globalThis as { RTCPeerConnection?: new () => RTCPeerConnection }).RTCPeerConnection;
    if (Pc) new Pc().createDataChannel(opts.label ?? 'dc', { ordered: !!opts.reliable });
    const c = new FakeConn(peer, opts);
    this.conns.push(c);
    queueMicrotask(() => FakePeer.onConnect?.(c, this));
    return c;
  }
  destroy(): void {
    this.destroyed = true;
  }
  reconnect(): void {}
}

const PeerImpl = FakePeer as unknown as PeerCtor;
const net = { ...DEFAULT_SETTINGS.net };

afterEach(() => {
  FakePeer.instances = [];
  FakePeer.onConnect = null;
});

const reliableOf = (p: FakePeer) => p.conns.find((c) => c.label === 'r')!;
const unreliableOf = (p: FakePeer) => p.conns.find((c) => c.label === 'u')!;

describe('PeerTransport.join error mapping', () => {
  it('ICE negotiation failure before the channel opens ⇒ networkRestricted (not "room not found")', async () => {
    FakePeer.onConnect = (c) => {
      if (c.label !== 'r') return;
      c.peerConnection.iceConnectionState = 'failed';
      c.emit('error', { type: 'negotiation-failed' }); // PeerJS then close()s, which emits nothing (never opened)
      c.close();
    };
    const err = await PeerTransport.join(net, 'ABCDE', { PeerImpl, connectTimeoutMs: 2000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetError);
    expect(err).toMatchObject({ code: 'networkRestricted', zh: '网络受限，请尝试局域网服务器' });
    expect(FakePeer.instances[0].destroyed).toBe(true);
  });

  it('a connection that closes before opening ⇒ networkRestricted', async () => {
    FakePeer.onConnect = (c) => {
      if (c.label !== 'r') return;
      c.open = true; // pathological: close event without open
      c.close();
    };
    await expect(PeerTransport.join(net, 'ABCDE', { PeerImpl, connectTimeoutMs: 2000 })).rejects.toMatchObject({ code: 'networkRestricted' });
  });

  it("the signalling server's peer-unavailable ⇒ roomNotFound", async () => {
    FakePeer.onConnect = (c, p) => {
      if (c.label === 'r') p.emit('error', { type: 'peer-unavailable' });
    };
    await expect(PeerTransport.join(net, 'ABCDE', { PeerImpl, connectTimeoutMs: 2000 })).rejects.toMatchObject({ code: 'roomNotFound', zh: '房间不存在' });
  });

  it('a timeout while ICE is still checking ⇒ networkRestricted; with no answer at all ⇒ timeout', async () => {
    FakePeer.onConnect = (c) => {
      if (c.label === 'r') c.peerConnection.iceConnectionState = 'checking';
    };
    await expect(PeerTransport.join(net, 'ABCDE', { PeerImpl, connectTimeoutMs: 50 })).rejects.toMatchObject({ code: 'networkRestricted' });
    FakePeer.onConnect = null;
    await expect(PeerTransport.join(net, 'ABCDE', { PeerImpl, connectTimeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout', zh: '连接超时' });
  });
});

describe('PeerTransport channels', () => {
  it('creates the unreliable channel with maxRetransmits 0 and restores RTCPeerConnection afterwards', async () => {
    const created: { label: string; init?: RTCDataChannelInit }[] = [];
    class FakePc {
      createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
        created.push({ label, init });
        return {} as RTCDataChannel;
      }
    }
    const original = FakePc.prototype.createDataChannel;
    const g = globalThis as { RTCPeerConnection?: unknown };
    g.RTCPeerConnection = FakePc;
    try {
      FakePeer.onConnect = (c) => {
        if (c.label === 'r') c.succeed();
      };
      const t = await PeerTransport.join(net, 'ABCDE', { PeerImpl });
      expect(created).toEqual([
        { label: 'r', init: { ordered: true } },
        { label: 'u', init: { ordered: false, maxRetransmits: 0 } },
      ]);
      expect(FakePc.prototype.createDataChannel).toBe(original);
      t.close();
    } finally {
      delete g.RTCPeerConnection;
    }
  });

  it('drops unreliable sends once a few snapshots are queued, never reliable ones', async () => {
    FakePeer.onConnect = (c) => c.succeed();
    const t = await PeerTransport.join(net, 'ABCDE', { PeerImpl });
    const peer = FakePeer.instances[0];
    const r = reliableOf(peer);
    const u = unreliableOf(peer);
    const snap = new Uint8Array(2700);
    t.send(t.hostId, snap, 'unreliable');
    expect(u.sent).toHaveLength(1);
    u.dataChannel.bufferedAmount = UNRELIABLE_BACKLOG + 1; // congested link
    t.send(t.hostId, snap, 'unreliable');
    expect(u.sent).toHaveLength(1);
    expect(t.stats.unreliableDropped).toBe(1);
    u.dataChannel.bufferedAmount = 0;
    u.bufferSize = 1; // PeerJS's own queue is in use
    t.send(t.hostId, snap, 'unreliable');
    expect(t.stats.unreliableDropped).toBe(2);
    r.dataChannel.bufferedAmount = 10 * UNRELIABLE_BACKLOG;
    t.send(t.hostId, '{"t":"chat"}', 'reliable');
    expect(r.sent).toEqual(['{"t":"chat"}']); // reliable traffic is never dropped
    expect(UNRELIABLE_BACKLOG).toBeLessThanOrEqual(16 * 1024);
    t.close();
  });

  it('after connecting, losing the host channel reports connectionLost', async () => {
    FakePeer.onConnect = (c) => c.succeed();
    const t = await PeerTransport.join(net, 'ABCDE', { PeerImpl });
    const closed: (string | undefined)[] = [];
    t.onClose((e) => closed.push(e?.code));
    reliableOf(FakePeer.instances[0]).close();
    expect(closed).toEqual(['connectionLost']);
  });
});

describe('WsTransport backpressure', () => {
  class FakeWs {
    static last: FakeWs | null = null;
    readyState = 0;
    bufferedAmount = 0;
    binaryType = 'blob';
    readonly sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      FakeWs.last = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(d: unknown): void {
      this.sent.push(d);
      if (typeof d === 'string') {
        const m = JSON.parse(d) as { op: string };
        if (m.op === 'create') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 'created', code: 'ABCDE', id: 'host', hostId: 'host' }) }));
      }
    }
    close(): void {
      this.readyState = 3;
    }
  }

  it("scales the host's unreliable budget with the number of clients", async () => {
    const t = await WsTransport.host('ws://x/ws', { WebSocketImpl: FakeWs as unknown as typeof WebSocket });
    const ws = FakeWs.last!;
    const ctl = (m: object) => ws.onmessage?.({ data: JSON.stringify(m) });
    for (const id of ['c1', 'c2', 'c3']) ctl({ op: 'peerJoin', id });
    expect(t.unreliableBacklog).toBe(3 * UNRELIABLE_BACKLOG_PER_PEER);
    const before = ws.sent.length;
    // one snapshot round for 3 clients goes through even though the socket has not flushed
    ws.bufferedAmount = 2 * UNRELIABLE_BACKLOG_PER_PEER;
    for (const id of ['c1', 'c2', 'c3']) t.send(id, new Uint8Array(2700), 'unreliable');
    expect(ws.sent.length - before).toBe(3);
    ws.bufferedAmount = 3 * UNRELIABLE_BACKLOG_PER_PEER + 1; // really congested
    t.send('c1', new Uint8Array(2700), 'unreliable');
    t.send('c1', '{"t":"chat"}', 'reliable');
    expect(ws.sent.length - before).toBe(4);
    expect(t.stats.unreliableDropped).toBe(1);
    ctl({ op: 'peerLeave', id: 'c3' });
    expect(t.unreliableBacklog).toBe(2 * UNRELIABLE_BACKLOG_PER_PEER);
    t.close();
  });
});
