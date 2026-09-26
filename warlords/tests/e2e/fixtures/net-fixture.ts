// Test page that drives GameSessions from Playwright (the real UI is not wired
// yet). Server settings come from the URL:
//   ?ws=ws://127.0.0.1:8791/ws&peerHost=127.0.0.1&peerPort=8791&peerPath=/peerjs
// Exposes window.netTest (see NetTestApi).
import { emptyInput, type GameEvent } from '../../../src/core/types';
import type { GameSession } from '../../../src/game/session';
import { settings } from '../../../src/game/settings';
import type { ViewSource } from '../../../src/render/view';
import { hostOnlineSession, joinOnlineSession, HostSession, isNetError } from '../../../src/net/index';
import { createFakeMatch } from '../../../src/net/fakeSim';
import { resolveWsUrl, WsTransport } from '../../../src/net/wsTransport';
import { PeerTransport } from '../../../src/net/peerTransport';

// capture PeerJS transports created through the public API (channel diagnostics)
const peerTransports: PeerTransport[] = [];
const origPeerJoin = PeerTransport.join.bind(PeerTransport);
PeerTransport.join = async (...args: Parameters<typeof PeerTransport.join>) => {
  const t = await origPeerJoin(...args);
  peerTransports.push(t);
  return t;
};

// simulated tab visibility (headless pages are always visible)
let fakeHidden: boolean | null = null;
const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
Object.defineProperty(document, 'hidden', {
  configurable: true,
  get: () => (fakeHidden === null ? (hiddenDesc?.get?.call(document) as boolean) : fakeHidden),
});

const q = new URLSearchParams(location.search);
settings.update({
  net: {
    ...settings.get().net,
    wsUrl: q.get('ws') ?? '',
    peerHost: q.get('peerHost') ?? '',
    peerPort: Number(q.get('peerPort') ?? 443),
    peerPath: q.get('peerPath') ?? '/',
    peerSecure: q.get('peerSecure') === '1',
  },
});

interface FixtureState {
  ready: boolean;
  phase: string | null;
  isHost: boolean;
  myId: string | null;
  roomCode: string | null;
  seats: number;
  yourRole: string | null;
  heroSelect: { lordPhase: boolean; options: number; picks: number } | null;
  entities: number;
  localId: number | null;
  localPos: { x: number; z: number } | null;
  events: number;
  phases: string[];
  errors: string[];
  statuses: string[];
}

let session: GameSession | null = null;
let view: ViewSource | null = null;
let moving = false;
let eventCount = 0;
const phases: string[] = [];
const errors: string[] = [];
const statuses: string[] = [];

function mySeat(s: GameSession): number {
  if (s.isHost) return 0;
  return s.lobby?.seats.find((x) => x.playerId === s.myId)?.seat ?? -1;
}

function attach(s: GameSession): void {
  session = s;
  s.on('phase', (p) => phases.push(p));
  s.on('error', (e) => errors.push(`${e.code}: ${e.zh} / ${e.en}`));
  s.on('status', (st) => statuses.push(st.en));
  s.on('heroSelect', (v) => {
    const seat = mySeat(s);
    if (v.options.length > 0 && v.picks[seat] === undefined) s.pickHero(v.options[0]);
  });
  s.on('matchStart', (v) => {
    view = v;
  });
}

let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (view) {
    view.pushInput({ ...emptyInput(), moveZ: moving ? 1 : 0, yaw: 0 });
    view.update(dt);
    const evs: GameEvent[] = view.drainEvents();
    eventCount += evs.length;
  }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const FAST = { roleReveal: 0.3, lordPick: 8, pick: 8, pickReveal: 0.2 };

async function hostFake(mode: 'ws' | 'peer', name: string): Promise<GameSession> {
  const net = settings.get().net;
  const t = mode === 'ws' ? await WsTransport.host(resolveWsUrl(net.wsUrl) ?? '') : await PeerTransport.host(net);
  if (t instanceof PeerTransport) peerTransports.push(t);
  return new HostSession({ name, transport: t, roomCode: t.roomCode, timings: FAST, createMatch: (init) => createFakeMatch(init) });
}

const api = {
  /** Create a room. fake = use the stand-in sim + short timers. Returns the room code. */
  async host(mode: 'ws' | 'peer', fake = false, name = '房主'): Promise<string> {
    try {
      const s = fake ? await hostFake(mode, name) : await hostOnlineSession({ name, mode });
      attach(s);
      return s.lobby?.roomCode ?? '';
    } catch (e) {
      errors.push(isNetError(e) ? `${e.code}: ${e.zh} / ${e.en}` : String(e));
      return '';
    }
  },
  async join(code: string, mode: 'ws' | 'peer', name = '客人'): Promise<boolean> {
    try {
      attach(await joinOnlineSession(code, { name, mode }));
      return true;
    } catch (e) {
      errors.push(isNetError(e) ? `${e.code}: ${e.zh} / ${e.en}` : String(e));
      return false;
    }
  },
  start(): void {
    session?.start();
  },
  setMoving(on: boolean): void {
    moving = on;
  },
  chat(text: string): void {
    session?.sendChat(text);
  },
  leave(): void {
    session?.leave();
  },
  /** position of any entity in this page's view */
  entityPos(id: number): { x: number; z: number } | null {
    const e = view?.get(id);
    return e ? { x: e.x, z: e.z } : null;
  },
  /** pretend the tab was hidden / shown (fires visibilitychange like a real tab switch) */
  setHidden(on: boolean): void {
    fakeHidden = on;
    document.dispatchEvent(new Event('visibilitychange'));
  },
  /** snapshot stream stats of a joined (client) session */
  snapshotStats(): { full: number; delta: number; missing: number } | null {
    return (session as { snapshotStats?: { full: number; delta: number; missing: number } | null } | null)?.snapshotStats ?? null;
  },
  /** data channel parameters of PeerJS transports on this page */
  channels(): { label: string; ordered: boolean; maxRetransmits: number | null }[] {
    return peerTransports.flatMap((t) => t.channelInfo().map(({ label, ordered, maxRetransmits }) => ({ label, ordered, maxRetransmits })));
  },
  state(): FixtureState {
    const s = session;
    const hs = s?.heroSelect ?? null;
    const localId = view?.localId() ?? null;
    const me = localId !== null ? view?.get(localId) : undefined;
    return {
      ready: true,
      phase: s?.phase ?? null,
      isHost: s?.isHost ?? false,
      myId: s?.myId ?? null,
      roomCode: s?.lobby?.roomCode ?? null,
      seats: s?.lobby?.seats.length ?? 0,
      yourRole: s?.roles?.yourRole ?? null,
      heroSelect: hs ? { lordPhase: hs.lordPhase, options: hs.options.length, picks: Object.keys(hs.picks).length } : null,
      entities: view?.entities().length ?? 0,
      localId,
      localPos: me ? { x: me.x, z: me.z } : null,
      events: eventCount,
      phases: [...phases],
      errors: [...errors],
      statuses: [...statuses],
    };
  },
};

export type NetTestApi = typeof api;
(window as unknown as { netTest: NetTestApi }).netTest = api;

const out = document.getElementById('out');
let lastRender = 0;
function render(): void {
  const now = performance.now();
  if (!out || now - lastRender < 250) return;
  lastRender = now;
  out.textContent = JSON.stringify(api.state(), null, 2);
}
