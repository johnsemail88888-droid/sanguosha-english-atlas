// Client-side GameSession: mirrors the host's phases from messages and exposes
// a ClientView during the match. Holds no authority — every action is a request.
//
// Resilience:
//  - the host hands out a secret seat token in 'welcome' (kept in
//    sessionStorage per room, so a page reload also gets the seat back);
//  - when the link drops (not kicked / host left) and a `reconnect` factory is
//    given, the session re-opens a transport and rejoins with the token a few
//    times before reporting the loss. The UI keeps the same GameSession object;
//    a rejoin into the match it already shows keeps its ClientView (only the
//    snapshot stream restarts) and re-emits 'matchStart' with that same view —
//    no loading screen, no renderer rebuild.
//  - the host-silence watchdog is stall-aware: after this page was frozen
//    (shader compile, throttled tab) it skips a round so queued messages are
//    processed first; after a few silent seconds it shows "Waiting for host…".
//  - when the page is hidden / loses focus the local player's controls are
//    released immediately (the host also neutralizes a silent client).
import type { MapData } from '../core/map';
import {
  PROTOCOL_VERSION,
  type EntityId,
  type GameResult,
  type HeroSelectView,
  type LobbyState,
  type MatchPhase,
  type MatchSettings,
  type PlayerId,
  type PublicPlayerView,
  type RoleDealView,
} from '../core/types';
import type { GameSession, SessionEvent, SessionEventMap } from '../game/session';
import type { ViewSource } from '../render/view';
import type { ClientView } from './clientView';
import { BIN_SNAPSHOT, isHostMsg, MAX_HERO_ID_LEN, MAX_TOKEN_LEN, sanitizeChat, sanitizeName, type ClientMsg, type HostMsg } from './protocol';
import { binaryTag, decodeJson, encodeInputMsg, encodeJson, SnapshotReceiver, StringTable } from './codec';
import { Emitter } from './emitter';
import { NetError, type NetErrorCode } from './errors';
import { isPageHidden, watchPageFocus } from './focus';
import type { Channel, Payload, PeerId, Transport } from './transport';

export interface ClientSessionOptions {
  transport: Transport;
  name: string;
  /** wait this long for the host's welcome (ms) */
  helloTimeoutMs?: number;
  /** no message from the host for this long ⇒ connection lost (ms) */
  hostTimeoutMs?: number;
  /** builds the map from the match seed (default: sim/map/generate, loaded lazily) */
  mapFactory?: (seed: number) => MapData | Promise<MapData>;
  /** room code: the seat token is remembered per room in sessionStorage */
  roomCode?: string;
  /** seat token from an earlier session (overrides the stored one) */
  token?: string;
  /** opens a new transport to the same room: enables automatic rejoin after a drop */
  reconnect?: () => Promise<Transport>;
  /** delays (ms) before each rejoin attempt; default [0, 1500, 3000, 5000] */
  rejoinDelaysMs?: readonly number[];
  /** host silent this long ⇒ 'status' "Waiting for host…" (ms, default 3000) */
  waitingStatusMs?: number;
  /** host-silence watchdog period (ms, default 1000; tests) */
  checkIntervalMs?: number;
}

const now = (): number => performance.now();

/** Losses worth an automatic rejoin (the room may still be there). */
const RECOVERABLE: ReadonlySet<NetErrorCode> = new Set<NetErrorCode>(['connectionLost', 'timeout', 'networkRestricted', 'serverUnreachable', 'closed']);
/** Rejoin answers that make further attempts pointless. */
const FINAL_REJOIN: ReadonlySet<NetErrorCode> = new Set<NetErrorCode>(['inProgress', 'roomFull', 'versionMismatch', 'kicked', 'hostLeft', 'roomNotFound']);
const DEFAULT_REJOIN_DELAYS = [0, 1500, 3000, 5000];
/** host-silence watchdog period (ms) */
const CHECK_INTERVAL_MS = 1000;
/** status key of the "Waiting for host…" line (SessionEventMap.status) */
export const WAITING_HOST_KEY = 'waitingHost';

const TOKEN_KEY = (room: string): string => `sgwl-seat-${room}`;

function sessionStore(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null; // blocked storage (privacy mode, sandboxed iframe)
  }
}

function loadToken(room: string | undefined): string | null {
  if (!room) return null;
  try {
    const v = sessionStore()?.getItem(TOKEN_KEY(room)) ?? null;
    return v && v.length <= MAX_TOKEN_LEN ? v : null;
  } catch {
    return null;
  }
}

function saveToken(room: string | undefined, token: string | null): void {
  if (!room) return;
  try {
    const s = sessionStore();
    if (!s) return;
    if (token) s.setItem(TOKEN_KEY(room), token);
    else s.removeItem(TOKEN_KEY(room));
  } catch {
    /* storage full / blocked: rejoin by name still works */
  }
}

export class ClientSession implements GameSession {
  readonly isHost = false;

  private readonly emitter = new Emitter<SessionEventMap>();
  private transport: Transport;
  private hostId: PeerId;
  private readonly name: string;
  private readonly mapFactory: (seed: number) => MapData | Promise<MapData>;
  private readonly hostTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly roomCode: string | undefined;
  private readonly reconnectFn: (() => Promise<Transport>) | null;
  private readonly rejoinDelays: readonly number[];
  private readonly waitingStatusMs: number;
  private readonly checkIntervalMs: number;
  private transportUnsubs: (() => void)[] = [];
  private unwatchFocus: (() => void) | null = null;

  private myIdValue: PlayerId;
  private seat = -1;
  private token: string | null;
  private phaseValue: MatchPhase = 'lobby';
  private lobbyValue: LobbyState | null = null;
  private rolesValue: RoleDealView | null = null;
  private heroSelectValue: HeroSelectView | null = null;
  private heroSelectDeadlineAt = 0;
  private viewValue: ClientView | null = null;
  /** decodes (delta) snapshots for the current match; its newest tick is acknowledged in every input packet */
  private snapshots: SnapshotReceiver | null = null;
  private resultValue: GameResult | null = null;
  private matchToken = 0;
  /** the match the current view shows (a rejoin into the same match keeps the view) */
  private currentMatch: { id: number | undefined; mapSeed: number; you: EntityId | null } | null = null;
  /** final player list that arrived with gameOver before the view existed */
  private pendingPlayers: PublicPlayerView[] | null = null;
  /** while 'matchStart' is being emitted: the UI may hand over its load promise (setLocalLoading) */
  private acceptLocalLoad = false;
  private localLoad: Promise<void> | null = null;
  /** the local view's load promise that has not settled yet ('loaded' waits for it) */
  private localLoadPending: Promise<void> | null = null;
  private lastHint: string | null = null;
  private lastHostMsgAt = now();
  private lastCheckAt = 0;
  private waitingHost = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private welcomed = false;
  private everWelcomed = false;
  private rejoining = false;
  private closed = false;
  private hidden = isPageHidden();
  /** last built map: a rejoin or the next match on the same seed skips the rebuild */
  private mapCache: { seed: number; map: MapData } | null = null;
  private rtt: number | null = null;
  private pingSeq = 0;
  private handshake: { resolve: () => void; reject: (e: NetError) => void } | null = null;

  /** Connect: send hello and wait for the host's welcome (rejects with NetError). */
  static async connect(opts: ClientSessionOptions): Promise<ClientSession> {
    const s = new ClientSession(opts);
    try {
      await s.handshakeWith(opts.helloTimeoutMs ?? 10_000);
    } catch (e) {
      s.dispose();
      throw e;
    }
    return s;
  }

  private constructor(opts: ClientSessionOptions) {
    this.transport = opts.transport;
    this.hostId = opts.transport.hostId;
    this.myIdValue = opts.transport.selfId;
    this.name = sanitizeName(opts.name);
    this.mapFactory = opts.mapFactory ?? loadAndGenerateMap;
    this.hostTimeoutMs = opts.hostTimeoutMs ?? 15_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.roomCode = opts.roomCode;
    this.reconnectFn = opts.reconnect ?? null;
    this.rejoinDelays = opts.rejoinDelaysMs?.length ? opts.rejoinDelaysMs : DEFAULT_REJOIN_DELAYS;
    this.waitingStatusMs = opts.waitingStatusMs ?? 3000;
    this.checkIntervalMs = Math.max(10, opts.checkIntervalMs ?? CHECK_INTERVAL_MS);
    this.token = opts.token ?? loadToken(opts.roomCode);
    this.attach(opts.transport);
    this.unwatchFocus = watchPageFocus({
      onHidden: () => {
        this.hidden = true;
        this.viewValue?.setSuspended(true);
      },
      onVisible: () => {
        this.hidden = false;
        this.viewValue?.setSuspended(false);
      },
      onBlur: () => this.viewValue?.releaseInput(),
    });
  }

  private attach(t: Transport): void {
    this.detach(false);
    this.transport = t;
    this.hostId = t.hostId;
    this.lastHostMsgAt = now();
    this.lastCheckAt = 0;
    this.transportUnsubs = [
      t.onMessage((from, data, ch) => this.onMessage(from, data, ch)),
      t.onPeerLeave((p) => {
        if (p === this.hostId) this.lost(new NetError('connectionLost'));
      }),
      t.onClose((err) => this.lost(err ?? new NetError('connectionLost'))),
    ];
  }

  private detach(close: boolean): void {
    for (const u of this.transportUnsubs) u();
    this.transportUnsubs = [];
    if (close) {
      const t = this.transport;
      // let a final message flush before tearing the link down
      setTimeout(() => t.close(), 100);
    }
  }

  /** Send hello on the current transport and wait for welcome / reject. */
  private handshakeWith(timeoutMs: number): Promise<void> {
    this.welcomed = false;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(new NetError('timeout'));
      }, timeoutMs);
      this.handshake = {
        resolve: () => {
          clearTimeout(timer);
          this.handshake = null;
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          this.handshake = null;
          reject(e);
        },
      };
      const hello: ClientMsg = { t: 'hello', v: PROTOCOL_VERSION, name: this.name };
      if (this.token) hello.token = this.token;
      this.send(hello);
    });
  }

  // ── getters ──────────────────────────────────────────────────────────────
  get myId(): PlayerId {
    return this.myIdValue;
  }

  get phase(): MatchPhase {
    return this.phaseValue;
  }

  get lobby(): LobbyState | null {
    return this.lobbyValue;
  }

  get roles(): RoleDealView | null {
    return this.rolesValue;
  }

  get heroSelect(): HeroSelectView | null {
    const v = this.heroSelectValue;
    if (!v || this.phaseValue !== 'heroSelect') return null;
    return { ...v, deadline: Math.max(0, (this.heroSelectDeadlineAt - now()) / 1000) };
  }

  get view(): ViewSource | null {
    return this.viewValue;
  }

  get result(): GameResult | null {
    return this.resultValue;
  }

  /** your seat index (-1 before welcome) */
  get mySeat(): number {
    return this.seat;
  }

  /** smoothed round-trip time to the host in ms (null until measured) */
  get ping(): number | null {
    return this.rtt;
  }

  /** true while an automatic rejoin is in progress */
  get reconnecting(): boolean {
    return this.rejoining;
  }

  /** Snapshot stream diagnostics for this match (debug overlay): full / delta / skipped. */
  get snapshotStats(): { full: number; delta: number; missing: number } | null {
    return this.snapshots ? { ...this.snapshots.stats } : null;
  }

  /** This player's secret seat token (pass as `token` to reclaim the seat from a new session). */
  get seatToken(): string | null {
    return this.token;
  }

  /** true while the host has been silent for a few seconds (status key 'waitingHost'). */
  get waitingForHost(): boolean {
    return this.waitingHost;
  }

  on<K extends SessionEvent>(ev: K, cb: (payload: SessionEventMap[K]) => void): () => void {
    return this.emitter.on(ev, cb);
  }

  // ── actions ──────────────────────────────────────────────────────────────
  setName(name: string): void {
    if (this.phaseValue === 'lobby') this.send({ t: 'setName', name: sanitizeName(name) });
  }

  setReady(ready: boolean): void {
    if (this.phaseValue === 'lobby') this.send({ t: 'ready', ready });
  }

  pickHero(heroId: string): void {
    if (this.phaseValue === 'heroSelect') this.send({ t: 'pick', heroId });
  }

  /** Hero select: the hero this player is looking at (the host auto-picks it if the timer runs out). */
  focusHero(heroId: string): void {
    if (this.phaseValue !== 'heroSelect' || typeof heroId !== 'string' || heroId.length === 0 || heroId.length > MAX_HERO_ID_LEN) return;
    if (heroId === this.lastHint) return;
    this.lastHint = heroId;
    this.send({ t: 'pickHint', hero: heroId });
  }

  /**
   * The UI's game view is still loading (scene, shaders): report 'loaded' to
   * the host only once `ready` settles, so the match clock waits for this
   * player. Only accepted while 'matchStart' / the phase change to 'playing'
   * are being emitted (the UI mounts the view there).
   */
  setLocalLoading(ready: Promise<void>): void {
    if (this.acceptLocalLoad) this.localLoad = ready;
  }

  sendChat(text: string): void {
    const clean = sanitizeChat(text);
    if (clean) this.send({ t: 'chat', text: clean });
  }

  leave(): void {
    if (this.closed) return;
    this.send({ t: 'leave' });
    saveToken(this.roomCode, null); // leaving on purpose: the next join is a new seat
    this.dispose();
  }

  // host-only controls are no-ops on clients
  updateSettings(_patch: Partial<MatchSettings>): void {}
  addBot(): void {}
  removeBot(_seat: number): void {}
  kick(_seat: number): void {}
  start(): void {}
  returnToLobby(): void {}

  // ── inbound ──────────────────────────────────────────────────────────────
  private onMessage(from: PeerId, data: Payload, _ch: Channel): void {
    if (this.closed || from !== this.hostId) return;
    this.lastHostMsgAt = now();
    if (this.waitingHost) {
      this.waitingHost = false;
      this.emitter.emit('status', { zh: '主机已恢复响应', en: 'Host is responding again', key: WAITING_HOST_KEY, clear: true });
    }
    if (typeof data !== 'string') {
      if (binaryTag(data) === BIN_SNAPSHOT) this.onSnapshot(data);
      return;
    }
    const raw = decodeJson(data);
    if (!raw || !isHostMsg(raw)) return;
    this.handle(raw as HostMsg);
  }

  private onSnapshot(data: Uint8Array): void {
    const view = this.viewValue;
    const rx = this.snapshots;
    if (!view || !rx) return;
    try {
      const got = rx.receive(data);
      if (got) view.onSnapshot(got.snap, got.byId);
    } catch (err) {
      console.warn('[net] bad snapshot dropped', err);
    }
  }

  private handle(msg: HostMsg): void {
    if (!this.welcomed) {
      if (msg.t === 'welcome') this.onWelcome(msg);
      else if (msg.t === 'reject') this.handshake?.reject(new NetError(asErrorCode(msg.code, 'roomFull')));
      else if (msg.t === 'leave') this.handshake?.reject(new NetError('hostLeft'));
      return;
    }
    switch (msg.t) {
      case 'lobby':
        this.lobbyValue = msg.lobby;
        this.syncSeat();
        this.emitter.emit('lobby', msg.lobby);
        break;
      case 'settings':
        if (this.lobbyValue) {
          this.lobbyValue = { ...this.lobbyValue, settings: msg.settings };
          this.emitter.emit('lobby', this.lobbyValue);
        }
        break;
      case 'start':
        this.resetMatch();
        break;
      case 'roles':
        this.rolesValue = msg.deal;
        // a reconnecting player gets their card again mid-match: keep the phase
        if (this.phaseValue === 'lobby' || this.phaseValue === 'roles') this.setPhase('roles');
        this.emitter.emit('roles', msg.deal);
        break;
      case 'heroSelect':
        if (this.heroSelectValue?.lordPhase !== msg.view.lordPhase) this.lastHint = null;
        this.heroSelectValue = msg.view;
        this.heroSelectDeadlineAt = now() + Math.max(0, msg.view.deadline) * 1000;
        this.setPhase('heroSelect');
        this.emitter.emit('heroSelect', msg.view);
        break;
      case 'matchStart':
        this.onMatchStart(msg);
        break;
      case 'events':
        this.viewValue?.onEvents(msg.tick, msg.events);
        break;
      case 'chat':
        this.emitter.emit('chat', { from: msg.from, text: msg.text });
        break;
      case 'ping':
        this.send({ t: 'pong', id: msg.id, ts: msg.ts });
        break;
      case 'pong': {
        const rtt = now() - msg.ts;
        if (Number.isFinite(rtt) && rtt >= 0) this.rtt = this.rtt === null ? rtt : this.rtt * 0.7 + rtt * 0.3;
        break;
      }
      case 'gameOver': {
        this.resultValue = msg.result;
        const players = Array.isArray(msg.players) && msg.players.length > 0 ? msg.players : null;
        const view = this.viewValue;
        if (!view && this.phaseValue === 'loading') {
          // (re)joined after the end: show the results once the view is built (buildMatch)
          if (players) this.pendingPlayers = players;
          break;
        }
        if (view) {
          view.setResult(msg.result);
          if (players) view.setPlayers(players);
        }
        this.setPhase('gameOver');
        this.emitter.emit('gameOver', msg.result);
        break;
      }
      case 'returnToLobby':
        this.resetMatch();
        this.rolesValue = null;
        this.lobbyValue = msg.lobby;
        this.syncSeat();
        this.setPhase('lobby');
        this.emitter.emit('lobby', msg.lobby);
        break;
      case 'notice':
        this.emitter.emit('status', { zh: msg.zh, en: msg.en });
        if (msg.log === true) this.emitter.emit('chat', { from: '', text: msg.zh, system: true, zh: msg.zh, en: msg.en });
        break;
      case 'error':
        this.emitter.emit('error', { code: msg.code, zh: msg.zh, en: msg.en });
        break;
      case 'kick':
        saveToken(this.roomCode, null);
        this.token = null;
        this.fatal(new NetError('kicked'));
        break;
      case 'leave':
        this.fatal(new NetError('hostLeft'));
        break;
      default:
        break;
    }
  }

  private onWelcome(msg: Extract<HostMsg, { t: 'welcome' }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.handshake?.reject(new NetError('versionMismatch'));
      return;
    }
    const rejoin = this.everWelcomed;
    this.welcomed = true;
    this.everWelcomed = true;
    this.myIdValue = msg.playerId;
    this.seat = msg.seat;
    this.lobbyValue = msg.lobby;
    if (typeof msg.token === 'string' && msg.token.length > 0 && msg.token.length <= MAX_TOKEN_LEN) {
      this.token = msg.token;
      saveToken(this.roomCode, msg.token);
    }
    const inMatch = msg.phase === 'playing' || msg.phase === 'loading' || msg.phase === 'gameOver';
    let phase: MatchPhase;
    if (!inMatch) phase = msg.phase;
    else if (rejoin && this.viewValue) {
      // back into the match on screen: the host re-sends matchStart for the same
      // match and the view is kept — no loading screen in between
      phase = this.phaseValue === 'loading' || this.phaseValue === 'gameOver' ? this.phaseValue : 'playing';
    } else {
      // the match (or its results) will be shown once matchStart built the view
      phase = 'loading';
    }
    if (rejoin) {
      // the host re-sends roles / hero select / matchStart as needed
      if (!inMatch && this.viewValue) this.resetMatch();
      else if (phase !== this.phaseValue && phase === 'lobby') this.resetMatch();
      this.setPhase(phase);
      this.emitter.emit('lobby', msg.lobby);
    } else {
      this.phaseValue = phase;
    }
    if (this.watchdog) clearInterval(this.watchdog);
    this.lastCheckAt = now();
    this.watchdog = setInterval(() => this.checkHost(), this.checkIntervalMs);
    this.handshake?.resolve();
    if (rejoin) this.emitter.emit('status', { zh: '已重新连接', en: 'Reconnected' });
    else this.emitter.emit('status', { zh: '已连接到房间', en: 'Connected to the room' });
  }

  private onMatchStart(msg: Extract<HostMsg, { t: 'matchStart' }>): void {
    const view = this.viewValue;
    const cur = this.currentMatch;
    if (view && cur && msg.matchId !== undefined && cur.id === msg.matchId && cur.mapSeed === msg.mapSeed && cur.you === msg.you) {
      // a rejoin into the match we already show: keep the view (and the
      // renderer built on it) — only the snapshot stream starts over
      this.snapshots = new SnapshotReceiver(new StringTable(msg.strings));
      view.resetNetState();
      this.sendLoadedWhen(this.localLoadPending, this.matchToken);
      this.setPhase(this.resultValue ? 'gameOver' : 'playing');
      this.emitter.emit('matchStart', view);
      return;
    }
    this.resetMatch(true);
    this.currentMatch = { id: msg.matchId, mapSeed: msg.mapSeed, you: msg.you };
    const token = this.matchToken;
    this.setPhase('loading');
    void this.buildMatch(msg, token);
  }

  /** Load the view code + build the map (lazily, so lobby code never depends on sim/map). */
  private async buildMatch(msg: Extract<HostMsg, { t: 'matchStart' }>, token: number): Promise<void> {
    // yield first so the UI can paint "loading" before the (heavy) map build
    await new Promise((r) => setTimeout(r, 0));
    if (this.closed || token !== this.matchToken) return;
    let map: MapData;
    let ViewCtor: typeof ClientView;
    try {
      const cached = this.mapCache?.seed === msg.mapSeed ? this.mapCache.map : null;
      const [mod, built] = await Promise.all([import('./clientView'), cached ?? this.mapFactory(msg.mapSeed)]);
      ViewCtor = mod.ClientView;
      map = built;
      this.mapCache = { seed: msg.mapSeed, map };
    } catch (err) {
      console.error('[net] match setup failed', err);
      if (this.closed || token !== this.matchToken) return;
      // we cannot play this match: give the seat to a bot right away (instead
      // of idling until the host's load timeout) and close the session so the
      // UI can offer to rejoin — the seat token reclaims the hero.
      this.send({ t: 'leave' });
      this.fatal(new NetError('simFailed', err instanceof Error ? err.message : undefined));
      return;
    }
    if (this.closed || token !== this.matchToken) return;
    this.snapshots = new SnapshotReceiver(new StringTable(msg.strings));
    const view = new ViewCtor({
      map,
      localEntityId: msg.you,
      sendInput: (pkt) => {
        if (this.closed || this.rejoining) return;
        // acknowledge the newest snapshot of the current stream (a rejoin swaps the receiver)
        const rx = this.snapshots;
        if (rx && rx.newest >= 0) pkt.snapAck = rx.newest;
        this.transport.send(this.hostId, encodeInputMsg(pkt), 'unreliable');
      },
    });
    if (this.hidden) view.setSuspended(true);
    this.viewValue = view;
    if (this.resultValue) view.setResult(this.resultValue);
    if (this.pendingPlayers) view.setPlayers(this.pendingPlayers);
    this.pendingPlayers = null;
    const over = this.resultValue;
    // the UI mounts the view on the phase change / matchStart and may hand over
    // its load promise (setLocalLoading) meanwhile: 'loaded' waits for it
    this.localLoad = null;
    this.acceptLocalLoad = true;
    try {
      this.setPhase(over ? 'gameOver' : 'playing');
      this.emitter.emit('matchStart', view);
    } finally {
      this.acceptLocalLoad = false;
    }
    if (this.closed || token !== this.matchToken) return;
    if (over) this.emitter.emit('gameOver', over);
    const ready = this.localLoad;
    this.localLoad = null;
    if (ready) {
      const pending: Promise<void> = Promise.resolve(ready).then(
        () => undefined,
        (err: unknown) => console.warn('[net] local view failed to load', err),
      );
      this.localLoadPending = pending;
      void pending.then(() => {
        if (this.localLoadPending === pending) this.localLoadPending = null;
      });
    }
    this.sendLoadedWhen(this.localLoadPending, token);
  }

  /** Report 'loaded' now, or once the local view finished loading. */
  private sendLoadedWhen(ready: Promise<void> | null, token: number): void {
    if (!ready) {
      this.send({ t: 'loaded' });
      return;
    }
    void ready.then(() => {
      // (during a rejoin this goes nowhere; the host's matchStart after the rejoin gets its own 'loaded')
      if (!this.closed && token === this.matchToken) this.send({ t: 'loaded' });
    });
  }

  /** Drop the current match's view. `keepResult`: a matchStart after the host said the match is over (late rejoin). */
  private resetMatch(keepResult = false): void {
    this.matchToken++;
    this.viewValue?.dispose();
    this.viewValue = null;
    this.snapshots = null;
    this.currentMatch = null;
    this.localLoadPending = null;
    this.heroSelectValue = null;
    if (!keepResult) {
      this.resultValue = null;
      this.pendingPlayers = null;
    }
  }

  private syncSeat(): void {
    const mine = this.lobbyValue?.seats.find((s) => s.playerId === this.myIdValue);
    if (mine) this.seat = mine.seat;
  }

  private checkHost(): void {
    if (this.closed || this.rejoining) return;
    const t = now();
    // stall-aware (APP-6): this page itself was frozen (shader compile, throttled
    // tab, sleep) — the host's messages that queued up meanwhile may not have
    // been dispatched yet: skip one round instead of declaring the link dead
    const gap = this.lastCheckAt > 0 ? t - this.lastCheckAt : 0;
    this.lastCheckAt = t;
    if (gap > 2 * this.checkIntervalMs + 1000) {
      this.lastHostMsgAt = Math.max(this.lastHostMsgAt, t - this.checkIntervalMs);
      return;
    }
    const silent = t - this.lastHostMsgAt;
    if (silent > this.hostTimeoutMs) {
      this.lost(new NetError('connectionLost'));
      return;
    }
    if (silent > this.waitingStatusMs && !this.waitingHost) {
      this.waitingHost = true;
      this.emitter.emit('status', { zh: '等待主机响应…', en: 'Waiting for host…', key: WAITING_HOST_KEY });
    }
    // measure our own RTT occasionally (host pings drive its view of us)
    if (++this.pingSeq % 3 === 0) this.send({ t: 'ping', id: this.pingSeq, ts: t });
  }

  /** The link to the host went away: rejoin if possible, else report. */
  private lost(err: NetError): void {
    if (this.closed) return;
    if (this.handshake) {
      this.handshake.reject(err);
      return;
    }
    if (this.rejoining) return;
    if (this.reconnectFn && this.everWelcomed && RECOVERABLE.has(err.code)) {
      void this.rejoin(err);
      return;
    }
    this.fatal(err);
  }

  private async rejoin(cause: NetError): Promise<void> {
    this.rejoining = true;
    this.welcomed = false;
    this.waitingHost = false; // superseded by "reconnecting…"
    this.viewValue?.releaseInput();
    this.detach(true);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.emitter.emit('status', { zh: '连接中断，正在重新连接…', en: 'Connection lost — reconnecting…' });
    const reconnect = this.reconnectFn as () => Promise<Transport>;
    let final: NetError | null = null;
    for (const delay of this.rejoinDelays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (this.closed) return;
      let t: Transport;
      try {
        t = await reconnect();
      } catch (e) {
        if (e instanceof NetError && FINAL_REJOIN.has(e.code)) {
          final = e;
          break;
        }
        continue;
      }
      if (this.closed) {
        t.close();
        return;
      }
      this.attach(t);
      try {
        await this.handshakeWith(this.helloTimeoutMs);
        this.rejoining = false;
        return;
      } catch (e) {
        this.detach(true);
        if (this.closed) return;
        if (e instanceof NetError && FINAL_REJOIN.has(e.code)) {
          final = e;
          break;
        }
      }
    }
    this.rejoining = false;
    if (this.closed) return;
    // the room vanished while we were away: the host is gone
    this.fatal(final ? (final.code === 'roomNotFound' ? new NetError('hostLeft') : final) : cause);
  }

  /** Report a terminal error and close the session. */
  private fatal(err: NetError): void {
    if (this.closed) return;
    this.emitter.emit('error', err.toPayload());
    this.dispose();
  }

  private setPhase(p: MatchPhase): void {
    if (this.phaseValue === p) return;
    this.phaseValue = p;
    if (p !== 'heroSelect') this.lastHint = null;
    this.emitter.emit('phase', p);
  }

  private send(msg: ClientMsg): void {
    if (this.closed) return;
    this.transport.send(this.hostId, encodeJson(msg), 'reliable');
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.matchToken++;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.unwatchFocus?.();
    this.unwatchFocus = null;
    this.detach(true);
    this.viewValue?.dispose();
    this.emitter.clear();
  }
}

async function loadAndGenerateMap(seed: number): Promise<MapData> {
  const { generateMap } = await import('../sim/map/generate');
  return generateMap(seed);
}

const KNOWN_CODES: ReadonlySet<string> = new Set<NetErrorCode>([
  'roomNotFound',
  'timeout',
  'networkRestricted',
  'serverUnreachable',
  'noServerConfigured',
  'invalidCode',
  'roomFull',
  'versionMismatch',
  'inProgress',
  'kicked',
  'hostLeft',
  'connectionLost',
  'simFailed',
  'unsupported',
  'closed',
]);

function asErrorCode(code: string, fallback: NetErrorCode): NetErrorCode {
  return KNOWN_CODES.has(code) ? (code as NetErrorCode) : fallback;
}
