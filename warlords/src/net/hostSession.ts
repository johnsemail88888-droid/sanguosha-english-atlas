// Host-side GameSession (online host and single player). Owns the lobby, the
// pre-match flow (roles → hero select → loading) and the authoritative sim loop
// (GAME_SPEC §3, §11). Clients are driven purely by messages from here.
import { Rng, randomSeed } from '../core/rng';
import {
  PROTOCOL_VERSION,
  SIM_HZ,
  SNAPSHOT_HZ,
  defaultSettings,
  type GameEvent,
  type GameResult,
  type EntityId,
  type HeroSelectView,
  type InputFrame,
  type LobbySeat,
  type LobbyState,
  type MatchPhase,
  type MatchSettings,
  type PlayerId,
  type PublicPlayerView,
  type RoleDealView,
  type ViewEntity,
} from '../core/types';
import { HEROES } from '../data/heroes';
import type { HeroDef } from '../data/types';
import type { GameSession, SessionEvent, SessionEventMap } from '../game/session';
import type { ViewSource } from '../render/view';
import type { MatchInit, MatchSeatInit, SimHost } from '../sim/host';
import {
  BIN_INPUT,
  isClientMsg,
  MAX_HERO_ID_LEN,
  MAX_TOKEN_LEN,
  sanitizeChat,
  sanitizeName,
  type ClientMsg,
  type HostMsg,
  type SeatInfo,
} from './protocol';
import { binaryTag, buildMatchStrings, decodeInputMsg, decodeJson, encodeJson, encodeSnapshotMsg, heroKingdom, StringTable } from './codec';
import { Emitter } from './emitter';
import { NetError, netErrorText } from './errors';
import { filterEventsFor, hasPrivateEvents } from './eventFilter';
import { isPageHidden, watchPageFocus } from './focus';
import {
  botFreePickHero,
  botPickHero,
  clampPlayerCount,
  crownSeats,
  dealRoles,
  generalPhaseOptions,
  lordPhaseOptions,
  roleDealViewFor,
  visibleLordSeat,
  type RoleDeal,
} from './flow';
import { LocalView } from './localView';
import { adaptiveTimeoutMs, maxStepFor, RecentSilence, ResponsiveClock, SILENCE_DECAY_MS, WarmUp } from './stall';
import { FixedStepLoop } from './ticker';
import type { Channel, Payload, PeerId, Transport } from './transport';
import { neutralInput, sanitizeInputPacket } from './validate';

export interface FlowTimings {
  /** role card reveal (s) */
  roleReveal: number;
  /** lord hero pick (s) */
  lordPick: number;
  /** everyone else's hero pick (s) */
  pick: number;
  /** pause after a pick phase completes so the picks can be seen (s) */
  pickReveal: number;
  /** max wait for clients to build the map (s) */
  loadTimeout: number;
  /**
   * max wait for the host player's OWN view (setLocalLoading) (s). The clock never starts
   * behind the host's loading screen before this — downloading the art takes a while on a
   * slow line; only a view that never settles is given up on (COMBAT-10).
   */
  localLoadTimeout: number;
  /** keep simulating after game over (s) */
  postGame: number;
  pingInterval: number;
  /**
   * No traffic from a peer for this long ⇒ disconnected (s). Counted in time
   * the host's own page was responsive (stall.ts): a host frozen for a while
   * does not blame its peers for the silence.
   */
  peerTimeout: number;
  /**
   * A player whose connection closed mid-match keeps the seat (hero idle) this
   * long before a bot takes over: a blip + automatic rejoin never bounces the
   * seat to a bot and back (s; 0 = immediately).
   */
  dropGrace: number;
  /**
   * Silence tolerated from a player who is loading the match, instead of
   * peerTimeout (s): from matchStart until it reports 'loaded' its page builds
   * the map and the scene and compiles shaders, and on a slow device it freezes
   * for many seconds at a time. There is no cap on the loading itself: a slow
   * player that still answers in between keeps its seat (NET-4).
   */
  loadGrace: number;
  /**
   * dropGrace for a player whose connection closed while it was loading the
   * match (s): its busy page needs longer to reconnect and rejoin.
   */
  loadDropGrace: number;
  /**
   * After a player reported 'loaded', loadGrace / loadDropGrace keep applying
   * until its input has flowed steadily for this long (s; 0 = at once): a slow
   * device's first real frames still freeze its page for many seconds (at most
   * 2 min, see WarmUp in stall.ts).
   */
  warmUp: number;
}

export const DEFAULT_TIMINGS: FlowTimings = {
  roleReveal: 5,
  lordPick: 15,
  pick: 20,
  pickReveal: 1.5,
  loadTimeout: 20,
  localLoadTimeout: 300,
  postGame: 4,
  pingInterval: 2,
  peerTimeout: 15,
  dropGrace: 5,
  loadGrace: 60,
  loadDropGrace: 20,
  warmUp: 10,
};

export const MAX_PLAYERS = 8;
/** extra heroes offered to the lord on top of every lord candidate */
export const LORD_EXTRA_CHOICES = 3;
/** 自由选将 in single player: the pick timers run this many times longer (30 heroes to read, UX-10). */
export const SOLO_FREE_PICK_TIME_MUL = 4;
const MAX_INPUT_QUEUE = 3;
/**
 * A client whose input stream has been silent this long (hidden tab, stall,
 * dying link) gets neutral input: its hero stops instead of repeating the last
 * frame (still running, still firing) indefinitely. This is the floor: a client
 * that renders at a low frame rate sends its inputs in bursts (one render frame
 * = several input frames), so the threshold adapts to the longest recent gap
 * between its packets (× 1.5, see staleTicksFor), up to INPUT_STALE_MAX_TICKS.
 */
export const INPUT_STALE_TICKS = Math.round(0.25 * SIM_HZ);
/** Upper bound of the adaptive input staleness threshold (1 s). */
export const INPUT_STALE_MAX_TICKS = SIM_HZ;
/** Time constant (ms) with which a long input gap is forgotten once packets arrive steadily again. */
const INPUT_GAP_DECAY_MS = 3000;
/** Consecutive throwing sim steps before the match is abandoned (1 s). */
const MAX_STEP_FAILURES = SIM_HZ;
/**
 * Snapshots remembered per client as delta baselines (1.6 s at 20 Hz). A
 * client whose newest acknowledged snapshot is older gets a full snapshot.
 */
export const DELTA_HISTORY = 32;

/** Typed debug / e2e cheats (HostSession.debugCheats). */
export interface HostDebugCheats {
  /** keep a player's hero invulnerable and at full health (re-applied every tick) */
  god(playerId: PlayerId, on: boolean): boolean;
  give(playerId: PlayerId, itemId: string, count?: number): boolean;
  giveWeapon(playerId: PlayerId, weaponId: string): boolean;
  /** move a player's hero to (x, ground height, z) */
  teleport(playerId: PlayerId, x: number, z: number): boolean;
  /** kill a hero entity (other kinds are refused) */
  killHero(entityId: EntityId): boolean;
  setCooldownsReady(playerId: PlayerId): boolean;
}

/** What the cheats need from the sim (sim/world.ts World has all of it; FakeSim none — structurally optional). */
interface CheatWorld {
  get?(id: EntityId): { id: EntityId; kind: string; hp: number; maxHp: number; dead?: boolean } | undefined;
  applyStatus?(id: EntityId, status: string, duration: number): boolean;
  removeStatus?(id: EntityId, status: string): void;
  heal?(id: EntityId, amount: number): number;
  giveItem?(id: EntityId, itemId: string, count?: number): boolean;
  giveWeapon?(id: EntityId, weaponId: string): void;
  teleport?(id: EntityId, pos: { x: number; y: number; z: number }): void;
  groundHeight?(x: number, z: number): number;
  killHero?(e: unknown, creditId: EntityId | undefined): void;
  setCooldown?(id: EntityId, abilityId: string, seconds: number): void;
}

export interface HostSessionOptions {
  name: string;
  /** null / undefined = single player (no network) */
  transport?: Transport | null;
  roomCode?: string;
  /** defaults to transport.selfId, or 'local' in single player */
  myId?: PlayerId;
  /** defaults to sim/world createMatch (loaded lazily at match start) */
  createMatch?: (init: MatchInit) => SimHost | Promise<SimHost>;
  /** hero pool (defaults to data HEROES) */
  heroes?: readonly HeroDef[];
  timings?: Partial<FlowTimings>;
  /** seed for role dealing / hero options (default random) */
  seed?: number;
  settings?: Partial<MatchSettings>;
  /** use a Worker-based ticker when available (default true) */
  preferWorkerTicker?: boolean;
}

interface SeatRec {
  seat: number;
  playerId: PlayerId;
  name: string;
  /** a bot occupies the seat by design (added / auto-filled) */
  isBot: boolean;
  /** added explicitly in the lobby (kept on returnToLobby) */
  explicitBot: boolean;
  isHost: boolean;
  ready: boolean;
  /** human seat (host or client) — may reclaim after a disconnect */
  human: boolean;
  /** human client currently connected */
  connected: boolean;
  peer: PeerId | null;
  /** secret handed to the seat's player in 'welcome'; a hello presenting it reclaims the seat */
  token: string | null;
  /** the (sanitized) name the player joined with, before de-duplication */
  joinName?: string;
}

interface PeerRec {
  id: PeerId;
  seat: number | null;
  /** wall time of the last message (name-based reclaim of a dead link) */
  lastSeen: number;
  /** silence since the last message, in time the host's page was responsive (ms, the timeout check) */
  silentMs: number;
  /** its longest recent silence (decaying): a peer that stalls a lot gets a longer timeout for a while */
  recentSilence: RecentSilence;
  rtt: number | null;
  pingSeq: number;
  inputQueue: InputFrame[];
  lastInputSeq: number;
  processedSeq: number;
  /** last frame applied to the sim (view direction for neutral input) */
  lastFrame: InputFrame | null;
  /** ticks since the last input was applied */
  starvedTicks: number;
  /** neutral input has been applied since the last real frame */
  neutralized: boolean;
  /** snapshots sent this match, oldest first: tick → entities (delta baselines) */
  sent: Map<number, Map<EntityId, ViewEntity>>;
  /** newest sent snapshot the client confirmed holding (-1 = none: send full) */
  snapAck: number;
  loaded: boolean;
  chatTimes: number[];
  /** loading the match (matchStart sent, 'loaded' not yet received): timed out after loadGrace, not peerTimeout */
  loading: boolean;
  /** after 'loaded': the loading timeouts apply until its input flows steadily (timings.warmUp) */
  warmUp: WarmUp;
  /** arrival time of the previous input packet (ms, 0 = none yet) */
  lastInputAt: number;
  /** longest recent gap between input packets (decays), ms */
  inputGapMs: number;
}

interface PickState {
  lordPhase: boolean;
  pickers: Set<number>;
  options: Map<number, string[]>;
  picks: Map<number, string>;
  /** hero each picker is looking at (focusHero / 'pickHint'): used by the auto-pick */
  hints: Map<number, string>;
  deadlineAt: number;
  completing: boolean;
}

const now = (): number => performance.now();

const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Unguessable seat reclaim token (crypto RNG when available). */
function randomToken(): string {
  const bytes = new Uint8Array(20);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

export class HostSession implements GameSession {
  readonly isHost = true;
  readonly myId: PlayerId;

  private readonly emitter = new Emitter<SessionEventMap>();
  private readonly transport: Transport | null;
  private readonly roomCode: string;
  private readonly createMatchFn: (init: MatchInit) => SimHost | Promise<SimHost>;
  private readonly pool: readonly HeroDef[];
  private readonly heroById: Record<string, HeroDef>;
  private readonly timings: FlowTimings;
  private readonly rng: Rng;
  private readonly preferWorker: boolean;
  private readonly unsubs: (() => void)[] = [];

  private settings: MatchSettings;
  private phaseValue: MatchPhase = 'lobby';
  private readonly seats = new Map<number, SeatRec>();
  private readonly peers = new Map<PeerId, PeerRec>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private flowToken = 0;
  private disposed = false;

  // flow state
  private deal: RoleDeal | null = null;
  private rolesEndAt = 0;
  private pick: PickState | null = null;
  private sim: SimHost | null = null;
  private loop: FixedStepLoop | null = null;
  private localView: LocalView | null = null;
  private table: StringTable | null = null;
  private waitingLoad = new Set<PeerId>();
  private snapAcc = 0;
  private postGameTicks = 0;
  private extraEvents: GameEvent[] = [];
  private resultValue: GameResult | null = null;
  private unwatchFocus: (() => void) | null = null;
  /** single-player pause (setPaused) */
  private paused = false;
  /** the host's own view is still loading (setLocalLoading) */
  private localLoading = false;
  /** bumped for every match created (guards async callbacks) */
  private matchSerial = 0;
  /** id of the current match, sent in matchStart (a rejoin keeps its view for the same id) */
  private matchId = 0;
  /** debug time scale for the sim loop (setDebugTimeScale) */
  private debugTimeScale = 1;
  /** players kept invulnerable + healed every tick (debugCheats.god) */
  private readonly godPlayers = new Set<PlayerId>();
  /** the lobby the host asked for: joining humans may displace bots / bump the count, leaving humans restore it */
  private hostCount: number;
  private hostBots = 0;
  /** kicked players: refused for the room's lifetime */
  private readonly bannedTokens = new Set<string>();
  private readonly bannedNames = new Set<string>();
  /** seats whose connection closed mid-match, waiting out timings.dropGrace */
  private readonly dropTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** steps of the peer-timeout check in time this page was responsive (stall detection) */
  private pingClock: ResponsiveClock | null = null;

  constructor(opts: HostSessionOptions) {
    this.transport = opts.transport ?? null;
    this.myId = opts.myId ?? this.transport?.selfId ?? 'local';
    this.roomCode = opts.roomCode ?? '';
    this.createMatchFn = opts.createMatch ?? loadAndCreateMatch;
    this.pool = opts.heroes ?? HEROES;
    this.heroById = Object.fromEntries(this.pool.map((h) => [h.id, h]));
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.rng = new Rng(opts.seed ?? randomSeed());
    this.preferWorker = opts.preferWorkerTicker ?? true;
    this.settings = sanitizeSettings({ ...defaultSettings(), ...opts.settings }, 1);
    this.hostCount = this.settings.playerCount;
    this.seats.set(0, {
      seat: 0,
      playerId: this.myId,
      name: sanitizeName(opts.name),
      isBot: false,
      explicitBot: false,
      isHost: true,
      ready: true,
      human: true,
      connected: true,
      peer: null,
      token: null,
    });

    const t = this.transport;
    if (t) {
      this.unsubs.push(
        t.onMessage((from, data, ch) => this.onMessage(from, data, ch)),
        t.onPeerJoin((p) => this.onPeerJoin(p)),
        t.onPeerLeave((p) => this.onPeerLeave(p)),
        t.onClose((err) => this.onTransportClosed(err)),
      );
      this.pingClock = new ResponsiveClock(maxStepFor(this.timings.pingInterval * 1000), now);
      this.pingTimer = setInterval(() => this.pingPeers(), this.timings.pingInterval * 1000);
      this.status('房间已创建，等待玩家加入…', 'Room created — waiting for players…');
    }
  }

  // ── GameSession getters ──────────────────────────────────────────────────
  get phase(): MatchPhase {
    return this.phaseValue;
  }

  get lobby(): LobbyState {
    return this.lobbyState();
  }

  get roles(): RoleDealView | null {
    return this.deal ? roleDealViewFor(this.deal, 0) : null;
  }

  get heroSelect(): HeroSelectView | null {
    return this.pick && this.phaseValue === 'heroSelect' ? this.heroSelectViewFor(0) : null;
  }

  get view(): ViewSource | null {
    return this.localView;
  }

  get result(): GameResult | null {
    return this.resultValue;
  }

  on<K extends SessionEvent>(ev: K, cb: (payload: SessionEventMap[K]) => void): () => void {
    return this.emitter.on(ev, cb);
  }

  // ── everyone ─────────────────────────────────────────────────────────────
  setName(name: string): void {
    const rec = this.seats.get(0);
    if (!rec || this.phaseValue !== 'lobby') return;
    rec.name = this.uniqueName(sanitizeName(name), 0);
    this.lobbyChanged();
  }

  setReady(_ready: boolean): void {
    // the host is always ready
  }

  pickHero(heroId: string): void {
    this.tryPick(0, heroId);
  }

  sendChat(text: string): void {
    const clean = sanitizeChat(text);
    if (!clean) return;
    this.relayChat(this.seats.get(0)?.name ?? '', clean);
  }

  leave(): void {
    if (this.disposed) return;
    this.broadcast({ t: 'leave' });
    this.dispose();
  }

  // ── host controls ────────────────────────────────────────────────────────
  updateSettings(patch: Partial<MatchSettings>): void {
    if (this.phaseValue !== 'lobby') return;
    const before = this.seats.size;
    this.settings = sanitizeSettings({ ...this.settings, ...patch }, this.humanCount());
    // the host's own choice (humans may raise the actual count while they are here)
    if (patch.playerCount !== undefined) this.hostCount = sanitizeSettings({ ...this.settings, playerCount: patch.playerCount }, 1).playerCount;
    this.fitSeatsToCount();
    // bots the host's smaller table no longer has room for are gone for good
    this.hostBots = Math.min(this.hostBots, this.explicitBotCount());
    this.broadcast({ t: 'settings', settings: { ...this.settings } });
    if (this.seats.size !== before) this.broadcastLobby();
    this.emitter.emit('lobby', this.lobbyState());
  }

  addBot(): void {
    if (this.phaseValue !== 'lobby') return;
    let seat = this.firstFreeSeat(this.settings.playerCount);
    if (seat === null && this.settings.playerCount < MAX_PLAYERS) {
      this.settings = { ...this.settings, playerCount: clampPlayerCount(this.settings.playerCount + 1) };
      this.hostCount = Math.max(this.hostCount, this.settings.playerCount);
      seat = this.firstFreeSeat(this.settings.playerCount);
    }
    if (seat === null) return;
    this.seats.set(seat, this.botRec(seat, true));
    this.hostBots = this.explicitBotCount();
    this.lobbyChanged();
  }

  removeBot(seat: number): void {
    if (this.phaseValue !== 'lobby') return;
    const rec = this.seats.get(seat);
    if (!rec || !rec.isBot) return;
    this.seats.delete(seat);
    if (rec.explicitBot) this.hostBots = Math.max(0, this.hostBots - 1);
    this.lobbyChanged();
  }

  kick(seat: number): void {
    const rec = this.seats.get(seat);
    if (!rec || rec.isHost) return;
    if (rec.isBot) {
      this.removeBot(seat);
      return;
    }
    // banned for the room's lifetime: neither the seat token nor the name get back in
    if (rec.token) this.bannedTokens.add(rec.token);
    this.bannedNames.add(rec.name);
    if (rec.joinName) this.bannedNames.add(rec.joinName);
    this.cancelDrop(rec.seat);
    const peerId = rec.peer;
    if (peerId) {
      const k = netErrorText('kicked');
      this.sendTo(peerId, { t: 'kick', zh: k.zh, en: k.en });
      const peer = this.peers.get(peerId);
      if (peer) peer.seat = null;
      this.peers.delete(peerId);
      // give the kick message a moment to flush before dropping the link
      setTimeout(() => this.transport?.disconnect(peerId), 200);
    }
    // a kicked player cannot reclaim the seat
    rec.human = false;
    rec.connected = false;
    rec.peer = null;
    rec.token = null;
    this.notice(`${rec.name} 被房主请出了房间`, `${rec.name} was kicked by the host`, this.phaseValue === 'lobby');
    if (this.phaseValue === 'lobby') {
      this.seats.delete(seat);
      this.restoreHostLobby();
      this.lobbyChanged();
    } else {
      this.humanLostMidMatch(rec);
    }
  }

  start(): void {
    if (this.phaseValue !== 'lobby' || this.disposed) return;
    if (this.pool.length === 0) {
      this.fail(new NetError('simFailed', 'no heroes available'));
      return;
    }
    const count = clampPlayerCount(Math.max(this.settings.playerCount, this.humanCount()));
    this.settings = { ...this.settings, playerCount: count };
    this.fitSeatsToCount();
    for (let s = 0; s < count; s++) if (!this.seats.has(s)) this.seats.set(s, this.botRec(s, false));

    this.flowToken++;
    this.deal = dealRoles(this.settings.mode, count, this.rng);
    this.resultValue = null;
    this.setPhase('roles');
    this.broadcast({ t: 'start' });
    this.broadcastLobby();
    this.rolesEndAt = now() + this.timings.roleReveal * 1000;
    for (const rec of this.seats.values()) this.sendRoles(rec);
    const roles = this.roles;
    if (roles) this.emitter.emit('roles', roles);
    const token = this.flowToken;
    this.after(this.timings.roleReveal, () => {
      if (token === this.flowToken) this.beginLordPick();
    });
  }

  returnToLobby(): void {
    if (this.phaseValue === 'lobby' || this.disposed) return;
    this.stopMatch();
    this.flowToken++;
    this.clearTimers();
    for (const rec of [...this.seats.values()]) {
      const keep = rec.isHost || (rec.human && rec.connected) || rec.explicitBot;
      if (!keep) this.seats.delete(rec.seat);
      else if (!rec.isHost && !rec.isBot) rec.ready = false;
    }
    for (const peer of this.peers.values()) {
      peer.loaded = false;
      peer.inputQueue = [];
      peer.lastFrame = null;
      peer.starvedTicks = 0;
      peer.neutralized = false;
      peer.sent.clear();
      peer.snapAck = -1;
      peer.loading = false;
      peer.warmUp.reset();
      peer.lastInputAt = 0;
      peer.inputGapMs = 0;
    }
    this.deal = null;
    this.pick = null;
    this.resultValue = null;
    this.fitSeatsToCount();
    this.restoreHostLobby();
    this.setPhase('lobby');
    this.broadcast({ t: 'returnToLobby', lobby: this.lobbyState() });
    this.emitter.emit('lobby', this.lobbyState());
  }

  // ── optional GameSession capabilities ────────────────────────────────────
  /**
   * Single player only: freeze the match while the pause menu is open (no sim
   * steps, no bot thinking). Ignored online (other people keep playing) and
   * outside 'playing'; a phase change or leave() resumes by itself.
   */
  setPaused(paused: boolean): void {
    if (this.disposed || this.transport !== null) return;
    if (paused) {
      if (this.phaseValue !== 'playing' || !this.loop || this.paused) return;
      this.paused = true;
      this.localView?.releaseInput();
      this.loop.pause();
    } else {
      this.unpause();
    }
  }

  /** true while the single-player match is paused (setPaused). */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Hero select: remember the hero the host player is looking at (auto-pick uses it). */
  focusHero(heroId: string): void {
    this.setPickHint(0, heroId);
  }

  /**
   * The host's own 3D view is still loading: keep the match in 'loading' until
   * `ready` settles (capped by timings.localLoadTimeout). Called by the UI from its
   * 'matchStart' handler; without it the match starts as soon as every client
   * reported 'loaded' (the old behaviour).
   */
  setLocalLoading(ready: Promise<void>): void {
    if (this.disposed || this.phaseValue !== 'loading' || !this.loop || this.loop.isRunning) return;
    const serial = this.matchSerial;
    this.localLoading = true;
    const done = (): void => {
      if (this.disposed || serial !== this.matchSerial || !this.localLoading) return;
      this.localLoading = false;
      this.maybeBeginPlaying();
    };
    Promise.resolve(ready).then(done, (err: unknown) => {
      console.warn('[net] local view failed to load', err);
      done();
    });
  }

  /** Debug / e2e only (INTEGRATION_REQUESTS APP-1): run the sim `scale`× faster than real time (0.1..10). */
  setDebugTimeScale(scale: number): void {
    this.debugTimeScale = Number.isFinite(scale) ? Math.max(0.1, Math.min(10, scale)) : 1;
    this.loop?.setTimeScale(this.debugTimeScale);
  }

  /**
   * Debug / e2e cheats on the live sim (INTEGRATION_REQUESTS APP-4). Every
   * call returns false when there is no match or the sim lacks the hook.
   * src/game/debug.ts only offers them for local single-player sessions.
   */
  readonly debugCheats: HostDebugCheats = {
    god: (playerId, on) => {
      const w = this.cheatWorld();
      const id = w ? this.sim?.entityOf(playerId) ?? null : null;
      if (!w || id === null || !w.applyStatus) return false;
      if (on) {
        this.godPlayers.add(playerId);
        this.applyGod(w, id);
      } else {
        this.godPlayers.delete(playerId);
        w.removeStatus?.(id, 'invuln');
      }
      return true;
    },
    give: (playerId, itemId, count = 1) => {
      const w = this.cheatWorld();
      const id = w ? this.sim?.entityOf(playerId) ?? null : null;
      return !!(w?.giveItem && id !== null && w.giveItem(id, itemId, count));
    },
    giveWeapon: (playerId, weaponId) => {
      const w = this.cheatWorld();
      const id = w ? this.sim?.entityOf(playerId) ?? null : null;
      if (!w?.giveWeapon || id === null) return false;
      w.giveWeapon(id, weaponId);
      return true;
    },
    teleport: (playerId, x, z) => {
      const w = this.cheatWorld();
      const id = w ? this.sim?.entityOf(playerId) ?? null : null;
      if (!w?.teleport || id === null || !Number.isFinite(x) || !Number.isFinite(z)) return false;
      w.teleport(id, { x, y: w.groundHeight ? w.groundHeight(x, z) : 0, z });
      return true;
    },
    killHero: (entityId) => {
      const w = this.cheatWorld();
      const e = w?.get?.(entityId);
      if (!w?.killHero || !e || e.kind !== 'hero' || e.dead) return false;
      w.killHero(e, undefined);
      return true;
    },
    setCooldownsReady: (playerId) => {
      const w = this.cheatWorld();
      const sim = this.sim;
      const id = sim?.entityOf(playerId) ?? null;
      if (!w?.setCooldown || !sim || id === null) return false;
      const cds = sim.snapshotFor(playerId).you?.cooldowns ?? {};
      for (const abilityId of Object.keys(cds)) w.setCooldown(id, abilityId, 0);
      return true;
    },
  };

  private cheatWorld(): CheatWorld | null {
    return this.sim ? (this.sim as unknown as CheatWorld) : null;
  }

  private applyGod(w: CheatWorld, id: EntityId): void {
    try {
      w.applyStatus?.(id, 'invuln', 2);
      const e = w.get?.(id);
      if (e && e.hp < e.maxHp) w.heal?.(id, e.maxHp);
    } catch (err) {
      console.warn('[net] god mode failed', err);
    }
  }

  private unpause(): void {
    if (!this.paused) return;
    this.paused = false;
    this.loop?.resume();
  }

  private setPickHint(seat: number, heroId: string): void {
    const pick = this.pick;
    if (this.phaseValue !== 'heroSelect' || !pick || pick.completing) return;
    if (typeof heroId !== 'string' || heroId.length === 0 || heroId.length > MAX_HERO_ID_LEN) return;
    if (!pick.pickers.has(seat) || pick.picks.has(seat)) return;
    // only a hero this seat could actually pick right now
    if (!this.availableOptions(seat).includes(heroId) || this.takenByOther(seat, heroId)) return;
    pick.hints.set(seat, heroId);
  }

  private takenByOther(seat: number, heroId: string): boolean {
    for (const [s, h] of this.pick?.picks ?? []) if (s !== seat && h === heroId) return true;
    return false;
  }

  // ── lobby helpers ────────────────────────────────────────────────────────
  private lobbyState(): LobbyState {
    const seats: LobbySeat[] = [...this.seats.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((r) => ({
        seat: r.seat,
        playerId: r.playerId,
        name: r.name,
        isBot: r.isBot || (!r.isHost && !r.connected),
        isHost: r.isHost,
        ready: r.isHost || r.isBot || r.ready,
      }));
    return { roomCode: this.roomCode, hostId: this.myId, settings: { ...this.settings }, seats };
  }

  private lobbyChanged(): void {
    this.broadcastLobby();
    this.emitter.emit('lobby', this.lobbyState());
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', lobby: this.lobbyState() });
  }

  private humanCount(): number {
    let n = 0;
    for (const r of this.seats.values()) if (r.human && (r.isHost || r.connected)) n++;
    return n;
  }

  private explicitBotCount(): number {
    let n = 0;
    for (const r of this.seats.values()) if (r.isBot && r.explicitBot) n++;
    return n;
  }

  /**
   * Lobby: back to what the host chose once the humans who displaced it left —
   * the host's player count (never below the humans present) and the bots the
   * host added (re-seated in free seats).
   */
  private restoreHostLobby(): void {
    const count = clampPlayerCount(Math.max(this.hostCount, this.humanCount()));
    if (count !== this.settings.playerCount) {
      this.settings = { ...this.settings, playerCount: count };
      this.fitSeatsToCount();
    }
    let bots = this.explicitBotCount();
    while (bots < this.hostBots) {
      const seat = this.firstFreeSeat(this.settings.playerCount);
      if (seat === null) break;
      this.seats.set(seat, this.botRec(seat, true));
      bots++;
    }
  }

  private botRec(seat: number, explicit: boolean): SeatRec {
    return {
      seat,
      playerId: `bot-${seat}`,
      name: `人机${seat + 1}`,
      isBot: true,
      explicitBot: explicit,
      isHost: false,
      ready: true,
      human: false,
      connected: false,
      peer: null,
      token: null,
    };
  }

  private firstFreeSeat(limit: number): number | null {
    for (let s = 1; s < Math.min(limit, MAX_PLAYERS); s++) if (!this.seats.has(s)) return s;
    return null;
  }

  /** Keep every seat index < playerCount: drop surplus bots, move humans down. */
  private fitSeatsToCount(): void {
    const count = this.settings.playerCount;
    for (const rec of [...this.seats.values()].sort((a, b) => b.seat - a.seat)) {
      if (rec.seat < count) continue;
      this.seats.delete(rec.seat);
      if (!rec.human) continue;
      let free = this.firstFreeSeat(count);
      if (free === null) {
        // evict the highest bot to make room for the human
        const bot = [...this.seats.values()].filter((r) => r.isBot).sort((a, b) => b.seat - a.seat)[0];
        if (bot) {
          this.seats.delete(bot.seat);
          free = bot.seat;
        }
      }
      if (free === null) continue; // cannot happen: count >= humans
      rec.seat = free;
      this.seats.set(free, rec);
      if (rec.peer) {
        const peer = this.peers.get(rec.peer);
        if (peer) peer.seat = free;
      }
    }
    if (this.phaseValue === 'lobby') {
      for (const rec of this.seats.values()) if (rec.isBot) rec.playerId = `bot-${rec.seat}`;
    }
  }

  private uniqueName(name: string, seat: number): string {
    const taken = new Set([...this.seats.values()].filter((r) => r.seat !== seat).map((r) => r.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = `${name}${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${name}${seat + 1}`;
  }

  // ── transport handlers ───────────────────────────────────────────────────
  private onPeerJoin(id: PeerId): void {
    if (this.disposed || this.peers.has(id)) return;
    this.peers.set(id, {
      id,
      seat: null,
      lastSeen: now(),
      silentMs: 0,
      recentSilence: new RecentSilence(SILENCE_DECAY_MS, now),
      warmUp: new WarmUp(this.timings.warmUp * 1000, now),
      rtt: null,
      pingSeq: 0,
      inputQueue: [],
      lastInputSeq: 0,
      processedSeq: 0,
      lastFrame: null,
      starvedTicks: 0,
      neutralized: false,
      sent: new Map(),
      snapAck: -1,
      loaded: false,
      chatTimes: [],
      loading: false,
      lastInputAt: 0,
      inputGapMs: 0,
    });
  }

  /** `said`: the peer sent 'leave' (a reload or a real leave) — its link did not just fail under it. */
  private onPeerLeave(id: PeerId, said = false): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.waitingLoad.delete(id);
    if (peer.seat === null) return;
    const rec = this.seats.get(peer.seat);
    if (!rec || rec.peer !== id) return;
    rec.peer = null;
    if (this.phaseValue === 'lobby') {
      rec.connected = false;
      this.leftLobby(rec);
      return;
    }
    // mid-flow: keep the seat for a moment — a blip rejoins with its token
    // (auto-rejoin) and must not bounce the hero to a bot and back
    if (this.sim && peer.lastFrame) {
      const n = neutralInput(peer.lastFrame);
      try {
        if (n) this.sim.setInput(rec.playerId, n);
      } catch (err) {
        console.error('[net] releasing a dropped player\'s input failed', err);
      }
    }
    if (this.phaseValue === 'loading') this.maybeBeginPlaying();
    this.cancelDrop(rec.seat);
    // a player whose link failed while it was loading the match needs longer to come
    // back: its page is busy building the scene
    const busy = (peer.loading || peer.warmUp.active) && !said;
    const grace = Math.max(0, busy ? Math.max(this.timings.dropGrace, this.timings.loadDropGrace) : this.timings.dropGrace) * 1000;
    if (grace <= 0) {
      this.finishDrop(rec);
      return;
    }
    const timer = setTimeout(() => {
      if (this.dropTimers.get(rec.seat) !== timer) return;
      this.dropTimers.delete(rec.seat);
      if (!this.disposed) this.finishDrop(rec);
    }, grace);
    this.dropTimers.set(rec.seat, timer);
  }

  /** The grace after a mid-match drop ran out without a rejoin: a bot takes over (or the lobby seat is freed). */
  private finishDrop(rec: SeatRec): void {
    if (rec.peer !== null || !rec.human || this.seats.get(rec.seat) !== rec) return;
    rec.connected = false;
    if (this.phaseValue === 'lobby') {
      this.leftLobby(rec);
      return;
    }
    this.notice(`${rec.name} 断开连接，由人机接管`, `${rec.name} disconnected — a bot takes over`);
    this.humanLostMidMatch(rec);
  }

  private cancelDrop(seat: number): void {
    const timer = this.dropTimers.get(seat);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.dropTimers.delete(seat);
  }

  /** A lobby player left: free the seat and restore the host's lobby. */
  private leftLobby(rec: SeatRec): void {
    this.seats.delete(rec.seat);
    this.notice(`${rec.name} 离开了房间`, `${rec.name} left the room`, true);
    this.restoreHostLobby();
    this.lobbyChanged();
  }

  /** A human seat lost its player during the flow: a bot takes over. */
  private humanLostMidMatch(rec: SeatRec): void {
    if (this.sim) {
      try {
        this.sim.convertToBot(rec.playerId);
      } catch (err) {
        console.error('[net] convertToBot failed', err);
      }
      this.injectEvent({ t: 'announce', zh: `${rec.name} 掉线，由人机接管`, en: `${rec.name} disconnected — a bot takes over`, kind: 'info' });
    }
    if (this.phaseValue === 'heroSelect' && this.pick) {
      this.botPicks();
      this.broadcastHeroSelect();
      this.checkPickComplete();
    }
    if (this.phaseValue === 'loading') this.maybeBeginPlaying();
    this.lobbyChanged();
  }

  private onTransportClosed(err: NetError | null): void {
    if (this.disposed) return;
    const e = err ?? new NetError('closed');
    this.emitter.emit('error', e.toPayload());
  }

  private onMessage(from: PeerId, data: Payload, _channel: Channel): void {
    if (this.disposed) return;
    let peer = this.peers.get(from);
    if (!peer) {
      this.onPeerJoin(from);
      peer = this.peers.get(from);
      if (!peer) return;
    }
    peer.lastSeen = now();
    if (peer.silentMs > 0) peer.recentSilence.note(peer.silentMs);
    peer.silentMs = 0;
    if (typeof data !== 'string') {
      if (binaryTag(data) === BIN_INPUT) this.onInput(peer, data);
      return;
    }
    const raw = decodeJson(data);
    if (!raw || !isClientMsg(raw)) return;
    const msg = raw as ClientMsg;
    if (msg.t === 'hello') {
      this.onHello(peer, msg);
      return;
    }
    if (msg.t === 'ping') {
      this.sendTo(from, { t: 'pong', id: Number(msg.id) || 0, ts: Number(msg.ts) || 0 });
      return;
    }
    if (msg.t === 'pong') {
      const rtt = now() - Number(msg.ts);
      if (Number.isFinite(rtt) && rtt >= 0 && rtt < 60_000) peer.rtt = peer.rtt === null ? rtt : peer.rtt * 0.7 + rtt * 0.3;
      return;
    }
    if (peer.seat === null) return;
    const rec = this.seats.get(peer.seat);
    if (!rec || rec.peer !== from) return;
    switch (msg.t) {
      case 'setName':
        if (this.phaseValue === 'lobby' && typeof msg.name === 'string') {
          rec.name = this.uniqueName(sanitizeName(msg.name), rec.seat);
          this.lobbyChanged();
        }
        break;
      case 'ready':
        if (this.phaseValue === 'lobby') {
          rec.ready = msg.ready === true;
          this.lobbyChanged();
        }
        break;
      case 'pick':
        if (typeof msg.heroId === 'string') this.tryPick(rec.seat, msg.heroId);
        break;
      case 'pickHint':
        if (typeof msg.hero === 'string') this.setPickHint(rec.seat, msg.hero);
        break;
      case 'chat': {
        if (typeof msg.text !== 'string') break;
        const t = now();
        peer.chatTimes = peer.chatTimes.filter((x) => t - x < 3000);
        if (peer.chatTimes.length >= 5) break; // flood control
        peer.chatTimes.push(t);
        const clean = sanitizeChat(msg.text);
        if (clean) this.relayChat(rec.name, clean);
        break;
      }
      case 'loaded':
        peer.loaded = true;
        peer.loading = false;
        peer.warmUp.start();
        this.waitingLoad.delete(from);
        this.maybeBeginPlaying();
        break;
      case 'leave':
        this.transport?.disconnect(from);
        this.onPeerLeave(from, true);
        break;
      default:
        break;
    }
  }

  private onHello(peer: PeerRec, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (peer.seat !== null) return;
    if (msg.v !== PROTOCOL_VERSION) {
      this.reject(peer.id, 'versionMismatch');
      return;
    }
    const name = sanitizeName(typeof msg.name === 'string' ? msg.name : '');
    // a returning player (auto-rejoin after a blip, page reload) presents the
    // seat's secret token: reclaim that seat in any phase, even if the host has
    // not noticed the old connection dying yet
    const token = typeof msg.token === 'string' && msg.token.length > 0 && msg.token.length <= MAX_TOKEN_LEN ? msg.token : null;
    if (token) {
      if (this.bannedTokens.has(token)) {
        this.reject(peer.id, 'kicked');
        return;
      }
      const owned = [...this.seats.values()].find((r) => r.human && !r.isHost && r.token === token);
      if (owned) {
        this.reclaim(peer, owned);
        return;
      }
    }
    // a kicked player stays out for the room's lifetime (also under the same name without the token)
    if (this.bannedNames.has(name)) {
      this.reject(peer.id, 'kicked');
      return;
    }
    if (this.phaseValue === 'lobby') {
      let seat = this.firstFreeSeat(this.settings.playerCount);
      if (seat === null) {
        const bot = [...this.seats.values()].filter((r) => r.isBot).sort((a, b) => b.seat - a.seat)[0];
        if (bot) {
          this.seats.delete(bot.seat);
          seat = bot.seat;
        } else if (this.settings.playerCount < MAX_PLAYERS) {
          this.settings = { ...this.settings, playerCount: clampPlayerCount(this.settings.playerCount + 1) };
          seat = this.firstFreeSeat(this.settings.playerCount);
        }
      }
      if (seat === null) {
        this.reject(peer.id, 'roomFull');
        return;
      }
      const rec: SeatRec = {
        seat,
        playerId: peer.id,
        name: this.uniqueName(name, seat),
        isBot: false,
        explicitBot: false,
        isHost: false,
        ready: false,
        human: true,
        connected: true,
        peer: peer.id,
        token: randomToken(),
        joinName: name,
      };
      this.seats.set(seat, rec);
      peer.seat = seat;
      this.sendTo(peer.id, {
        t: 'welcome',
        v: PROTOCOL_VERSION,
        playerId: peer.id,
        seat,
        phase: 'lobby',
        lobby: this.lobbyState(),
        token: rec.token ?? undefined,
      });
      this.notice(`${rec.name} 加入了房间`, `${rec.name} joined the room`, true);
      this.lobbyChanged();
      return;
    }
    // mid-flow without a token (new tab / device): a human seat with the same
    // name may be reclaimed if it is disconnected — or if its connection has
    // gone silent (the host has not detected the drop yet)
    const humans = [...this.seats.values()].filter((r) => r.human && !r.isHost && r.name === name);
    const rec = humans.find((r) => !r.connected || r.peer === null) ?? humans.find((r) => this.connectionStale(r));
    if (!rec) {
      this.reject(peer.id, 'inProgress');
      return;
    }
    this.reclaim(peer, rec);
  }

  /** The seat's connection has been silent for several ping intervals. */
  private connectionStale(rec: SeatRec): boolean {
    if (!rec.connected || !rec.peer) return false;
    const old = this.peers.get(rec.peer);
    if (!old) return true;
    return now() - old.lastSeen > this.staleMs();
  }

  /** Silence after which a connection counts as dead for name-based reclaim (3.5 s with default timings). */
  private staleMs(): number {
    return Math.max(1, this.timings.pingInterval * 1.5 + 0.5) * 1000;
  }

  private reclaim(peer: PeerRec, rec: SeatRec): void {
    // replace a connection the host still believes alive (dead link, duplicate tab)
    const oldPeer = rec.peer;
    if (oldPeer && oldPeer !== peer.id) {
      this.peers.delete(oldPeer);
      this.waitingLoad.delete(oldPeer);
      this.transport?.disconnect(oldPeer);
    }
    // back within the drop grace (or replacing a link we still thought alive):
    // nobody was told it left, nothing to announce
    this.cancelDrop(rec.seat);
    const wasBot = !rec.connected;
    rec.playerId = peer.id;
    rec.peer = peer.id;
    rec.connected = true;
    rec.token ??= randomToken();
    peer.seat = rec.seat;
    this.sendTo(peer.id, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      playerId: peer.id,
      seat: rec.seat,
      phase: this.phaseValue,
      lobby: this.lobbyState(),
      token: rec.token,
    });
    this.sendRoles(rec);
    if (this.phaseValue === 'heroSelect' && this.pick) this.sendTo(peer.id, { t: 'heroSelect', view: this.heroSelectViewFor(rec.seat) });
    if (this.sim) {
      try {
        this.sim.convertToHuman(rec.seat, peer.id, rec.name);
      } catch (err) {
        console.error('[net] convertToHuman failed', err);
      }
      this.sendMatchStart(peer);
      if (this.phaseValue === 'loading') this.waitingLoad.add(peer.id);
      if (wasBot) this.injectEvent({ t: 'announce', zh: `${rec.name} 重新连接`, en: `${rec.name} reconnected`, kind: 'info' });
    }
    // a player who comes back after the match ended gets the real results: the
    // loop has stopped, so no snapshot will bring the final player list
    if (this.phaseValue === 'gameOver' && this.resultValue) {
      this.sendTo(peer.id, { t: 'gameOver', result: this.resultValue, players: this.finalPlayersFor(rec) });
    }
    if (wasBot) this.notice(`${rec.name} 重新连接`, `${rec.name} reconnected`);
    this.lobbyChanged();
  }

  /** Public player list as `rec` sees it (end of match: everything is revealed anyway). */
  private finalPlayersFor(rec: SeatRec): PublicPlayerView[] | undefined {
    try {
      return this.sim?.snapshotFor(rec.playerId).players.map((p) => ({ ...p }));
    } catch (err) {
      console.error('[net] final player list failed', err);
      return undefined;
    }
  }

  private reject(peerId: PeerId, code: 'versionMismatch' | 'roomFull' | 'inProgress' | 'kicked'): void {
    const m = netErrorText(code);
    this.sendTo(peerId, { t: 'reject', code, zh: m.zh, en: m.en });
    this.peers.delete(peerId);
    setTimeout(() => this.transport?.disconnect(peerId), 200);
  }

  private pingPeers(): void {
    const clock = this.pingClock;
    if (!clock) return;
    const t = now();
    // stall-aware (APP-6, NET-4): silence counts only while this page was
    // responsive (a frozen host could not have heard its peers), and right after
    // such a stall the timer may run before the messages that queued up meanwhile
    // — no timeout verdicts this round, so they are processed first
    const step = clock.tick();
    for (const peer of [...this.peers.values()]) {
      peer.silentMs += step;
      if (!clock.stalled && peer.silentMs > this.peerTimeoutMs(peer)) {
        this.transport?.disconnect(peer.id);
        this.onPeerLeave(peer.id);
        continue;
      }
      this.sendTo(peer.id, { t: 'ping', id: ++peer.pingSeq, ts: t });
    }
  }

  /**
   * Silence after which `peer` counts as disconnected (NET-4): loadGrace while it
   * loads the match and warms up (its first frames); afterwards peerTimeout,
   * raised for a while after it was silent for long.
   */
  private peerTimeoutMs(peer: PeerRec): number {
    const base = this.timings.peerTimeout * 1000;
    const loading = Math.max(base, this.timings.loadGrace * 1000);
    return peer.loading || peer.warmUp.active ? loading : adaptiveTimeoutMs(base, peer.recentSilence.current(), loading);
  }

  /** Neutral-input threshold for `peer`: adapts to how bursty its input stream is (see INPUT_STALE_TICKS). */
  private staleTicksFor(peer: PeerRec): number {
    const byGap = Math.ceil((1.5 * peer.inputGapMs * SIM_HZ) / 1000);
    return Math.max(INPUT_STALE_TICKS, Math.min(INPUT_STALE_MAX_TICKS, byGap));
  }

  private onInput(peer: PeerRec, data: Uint8Array): void {
    if (!this.sim || peer.seat === null) return;
    const rec = this.seats.get(peer.seat);
    if (!rec || rec.peer !== peer.id) return;
    let pkt;
    try {
      pkt = sanitizeInputPacket(decodeInputMsg(data));
    } catch {
      return; // malformed packet
    }
    // how bursty is this client's input? (a low frame rate sends several frames per render frame)
    const t = now();
    if (peer.lastInputAt > 0) {
      const gap = t - peer.lastInputAt;
      peer.inputGapMs = Math.max(gap, peer.inputGapMs * Math.exp(-gap / INPUT_GAP_DECAY_MS));
    }
    peer.lastInputAt = t;
    peer.warmUp.beat();
    // delta baseline acknowledgement (only ticks we actually sent this match)
    const ack = pkt.snapAck;
    if (ack !== undefined && ack > peer.snapAck && peer.sent.has(ack)) peer.snapAck = ack;
    const f = pkt.frame;
    if (f.seq <= peer.lastInputSeq) return; // late / duplicate
    // rescue edge actions from frames that were lost (seq-based dedup)
    const actions = [];
    const lost = pkt.history.filter((h) => h.seq > peer.lastInputSeq && h.seq < f.seq).sort((a, b) => a.seq - b.seq);
    for (const h of lost) actions.push(...h.actions);
    actions.push(...f.actions);
    f.actions = actions;
    peer.lastInputSeq = f.seq;
    peer.inputQueue.push(f);
    // bound input latency: merge the oldest frames' actions forward
    while (peer.inputQueue.length > MAX_INPUT_QUEUE) {
      const dropped = peer.inputQueue.shift() as InputFrame;
      peer.inputQueue[0].actions = [...dropped.actions, ...peer.inputQueue[0].actions];
    }
  }

  // ── roles / hero select ──────────────────────────────────────────────────
  private sendRoles(rec: SeatRec): void {
    if (!this.deal || !rec.peer || this.phaseValue === 'lobby') return;
    const seconds = Math.max(0, (this.rolesEndAt - now()) / 1000);
    this.sendTo(rec.peer, { t: 'roles', deal: roleDealViewFor(this.deal, rec.seat), seconds });
  }

  private seatBotControlled(seat: number): boolean {
    const rec = this.seats.get(seat);
    if (!rec) return true;
    if (rec.isHost) return false;
    return rec.isBot || !rec.connected;
  }

  private beginLordPick(): void {
    const deal = this.deal;
    if (!deal) return;
    const crowns = crownSeats(deal);
    const options = this.settings.freePick
      ? Object.fromEntries(crowns.map((s) => [s, this.pool.map((h) => h.id)]))
      : lordPhaseOptions(this.pool, crowns, LORD_EXTRA_CHOICES, this.rng);
    this.pick = {
      lordPhase: true,
      pickers: new Set(crowns),
      options: new Map(crowns.map((s) => [s, options[s]])),
      picks: new Map(),
      hints: new Map(),
      deadlineAt: now() + this.pickSeconds(true) * 1000,
      completing: false,
    };
    this.setPhase('heroSelect');
    this.runPickPhase(this.pickSeconds(true));
  }

  private beginGeneralPick(): void {
    const deal = this.deal;
    const prev = this.pick;
    if (!deal || !prev) return;
    const crowns = new Set(crownSeats(deal));
    const others = [...this.seats.keys()].filter((s) => !crowns.has(s)).sort((a, b) => a - b);
    const taken = new Set(prev.picks.values());
    const options = this.settings.freePick
      ? Object.fromEntries(others.map((s) => [s, this.pool.map((h) => h.id)]))
      : generalPhaseOptions(this.pool, others, this.settings.heroChoices, taken, this.rng);
    this.pick = {
      lordPhase: false,
      pickers: new Set(others),
      options: new Map(others.map((s) => [s, options[s]])),
      picks: prev.picks,
      hints: new Map(),
      deadlineAt: now() + this.pickSeconds(false) * 1000,
      completing: false,
    };
    this.runPickPhase(this.pickSeconds(false));
  }

  /** Length of a pick phase: 自由选将 in single player gives time to read the whole roster. */
  private pickSeconds(lordPhase: boolean): number {
    const s = lordPhase ? this.timings.lordPick : this.timings.pick;
    return this.settings.freePick && this.transport === null ? s * SOLO_FREE_PICK_TIME_MUL : s;
  }

  private runPickPhase(seconds: number): void {
    const token = ++this.flowToken;
    this.after(seconds, () => {
      const pick = this.pick;
      if (token !== this.flowToken || !pick) return;
      // time's up: the humans still choosing get the card they were looking at first, then
      // the bots choose, then anyone left
      for (const seat of pick.pickers) if (!pick.picks.has(seat) && !this.seatBotControlled(seat)) this.autoPick(seat);
      this.botPicks(true);
      for (const seat of pick.pickers) if (!pick.picks.has(seat)) this.autoPick(seat);
      this.broadcastHeroSelect();
      this.checkPickComplete();
    });
    this.botPicks();
    this.broadcastHeroSelect();
    this.checkPickComplete();
  }

  /** Options `seat` may still choose from (taken heroes removed when possible). */
  private availableOptions(seat: number): string[] {
    const pick = this.pick;
    if (!pick) return [];
    const opts = pick.options.get(seat) ?? [];
    const mine = pick.picks.get(seat);
    const taken = new Set([...pick.picks.values()]);
    const free = opts.filter((id) => !taken.has(id) || id === mine);
    return free.length > 0 ? free : opts;
  }

  /**
   * Bot-controlled seats choose. In 自由选将 the humans choose first (the whole roster is
   * theirs): the bots wait until every human locked in, or `force` at the deadline (COMBAT-1).
   */
  private botPicks(force = false): void {
    const pick = this.pick;
    if (!pick) return;
    if (this.settings.freePick && !force && [...pick.pickers].some((s) => !pick.picks.has(s) && !this.seatBotControlled(s))) return;
    // real lord first so a bot double never steals from a bot lord's best choice
    const order = [...pick.pickers].sort((a, b) => (a === this.deal?.lordSeat ? -1 : b === this.deal?.lordSeat ? 1 : a - b));
    for (const seat of order) if (!pick.picks.has(seat) && this.seatBotControlled(seat)) this.autoPick(seat);
  }

  private autoPick(seat: number): void {
    const pick = this.pick;
    const deal = this.deal;
    if (!pick || !deal) return;
    const opts = this.availableOptions(seat);
    if (opts.length === 0) return;
    // the hero the player was looking at when the timer ran out, if still free
    const hint = pick.hints.get(seat);
    if (hint !== undefined && opts.includes(hint) && !this.takenByOther(seat, hint)) {
      pick.picks.set(seat, hint);
      return;
    }
    const role = deal.roles[seat];
    const heroId = this.settings.freePick
      ? botFreePickHero(opts, role, this.heroById, this.rng, { crown: pick.lordPhase, choices: this.settings.heroChoices, extra: LORD_EXTRA_CHOICES })
      : botPickHero(opts, role, this.heroById, this.rng);
    pick.picks.set(seat, heroId);
  }

  private tryPick(seat: number, heroId: string): void {
    const pick = this.pick;
    if (this.phaseValue !== 'heroSelect' || !pick || pick.completing) return;
    if (!pick.pickers.has(seat) || pick.picks.has(seat)) return;
    if (!this.availableOptions(seat).includes(heroId)) return;
    pick.picks.set(seat, heroId);
    this.botPicks(); // 自由选将: the last human locked in → the bots choose now
    this.broadcastHeroSelect();
    this.checkPickComplete();
  }

  private checkPickComplete(): void {
    const pick = this.pick;
    if (!pick || pick.completing) return;
    for (const seat of pick.pickers) if (!pick.picks.has(seat)) return;
    pick.completing = true;
    const token = ++this.flowToken; // cancels the phase timeout
    const next = pick.lordPhase ? () => this.beginGeneralPick() : () => this.beginLoading();
    this.after(this.timings.pickReveal, () => {
      if (token === this.flowToken) next();
    });
  }

  private heroSelectViewFor(seat: number): HeroSelectView {
    const pick = this.pick as PickState;
    const deal = this.deal as RoleDeal;
    const picks: Record<number, string> = {};
    for (const [s, h] of pick.picks) picks[s] = h;
    return {
      options: pick.pickers.has(seat) ? this.availableOptions(seat) : [],
      deadline: pick.completing ? 0 : Math.max(0, (pick.deadlineAt - now()) / 1000),
      picks,
      lordSeat: visibleLordSeat(deal, seat),
      lordPhase: pick.lordPhase,
    };
  }

  private broadcastHeroSelect(): void {
    if (!this.pick) return;
    for (const rec of this.seats.values()) {
      if (rec.peer && rec.connected) this.sendTo(rec.peer, { t: 'heroSelect', view: this.heroSelectViewFor(rec.seat) });
    }
    this.emitter.emit('heroSelect', this.heroSelectViewFor(0));
  }

  // ── match ────────────────────────────────────────────────────────────────
  private beginLoading(): void {
    const deal = this.deal;
    const pick = this.pick;
    if (!deal || !pick) return;
    this.flowToken++;
    this.clearTimers();
    const seatsInit: MatchSeatInit[] = [...this.seats.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((r) => {
        const s: MatchSeatInit = {
          seat: r.seat,
          playerId: r.playerId,
          name: r.name,
          isBot: this.seatBotControlled(r.seat),
          role: deal.roles[r.seat],
          heroId: pick.picks.get(r.seat) ?? this.pool[0].id,
        };
        const target = deal.bountyTargets[r.seat];
        if (target !== undefined) s.bountyTargetSeat = target;
        return s;
      });
    const init: MatchInit = { settings: { ...this.settings }, seats: seatsInit, seed: this.rng.int(1, 0x7fffffff) };
    this.setPhase('loading');
    const token = this.flowToken;
    let created: SimHost | Promise<SimHost>;
    try {
      created = this.createMatchFn(init);
    } catch (err) {
      this.simFailed(err);
      return;
    }
    if (created instanceof Promise) {
      created.then(
        (sim) => {
          if (token === this.flowToken && !this.disposed && this.phaseValue === 'loading') this.onSimReady(sim, init);
        },
        (err: unknown) => {
          if (token === this.flowToken && !this.disposed) this.simFailed(err);
        },
      );
    } else {
      this.onSimReady(created, init);
    }
  }

  private simFailed(err: unknown): void {
    console.error('[net] match failed (creating or running the sim)', err);
    this.fail(new NetError('simFailed', err instanceof Error ? err.message : undefined));
    this.returnToLobby();
  }

  private onSimReady(sim: SimHost, init: MatchInit): void {
    this.sim = sim;
    this.matchSerial++;
    this.matchId = 1 + Math.floor(Math.random() * 0x7ffffffe);
    this.localLoading = false;
    this.paused = false;
    this.godPlayers.clear();
    // players who dropped / came back while the sim was being created
    for (const s of init.seats) {
      const rec = this.seats.get(s.seat);
      if (!rec || rec.isHost || !rec.human) continue;
      try {
        // reconnected (possibly under a new peer id) / dropped meanwhile
        if (rec.connected && (s.isBot || s.playerId !== rec.playerId)) sim.convertToHuman(s.seat, rec.playerId, rec.name);
        else if (!rec.connected && !s.isBot) sim.convertToBot(s.playerId);
      } catch (err) {
        console.error('[net] seat conversion failed', err);
      }
    }
    const extra: string[] = [];
    for (const r of this.seats.values()) extra.push(r.playerId, r.name);
    this.table = new StringTable(buildMatchStrings(extra));
    this.snapAcc = 0;
    const loop: FixedStepLoop = new FixedStepLoop(() => this.tick(), {
      hz: SIM_HZ,
      maxCatchUp: 5,
      preferWorker: this.preferWorker,
      maxConsecutiveFailures: MAX_STEP_FAILURES,
      // the sim keeps throwing: surface it instead of showing a frozen match
      onFatal: (err) => {
        if (this.loop === loop && !this.disposed) this.simFailed(err);
      },
    });
    if (this.debugTimeScale !== 1) loop.setTimeScale(this.debugTimeScale);
    this.loop = loop;
    this.localView = new LocalView(sim, this.myId, () => loop.alpha());
    // host player: release the controls while the tab is hidden / unfocused
    // (the worker keeps the sim ticking with the last input otherwise)
    const view = this.localView;
    if (isPageHidden()) view.setSuspended(true);
    this.unwatchFocus?.();
    this.unwatchFocus = watchPageFocus({
      onHidden: () => view.setSuspended(true),
      onVisible: () => view.setSuspended(false),
      onBlur: () => view.releaseInput(),
    });
    this.extraEvents = [];
    this.waitingLoad.clear();
    for (const peer of this.peers.values()) {
      if (peer.seat === null) continue;
      const rec = this.seats.get(peer.seat);
      if (!rec || rec.peer !== peer.id || !rec.connected) continue;
      this.waitingLoad.add(peer.id);
      this.sendMatchStart(peer);
    }
    const token = this.flowToken;
    // guests that are still loading after loadTimeout are not waited for any longer (they join
    // late); the host's own view is (COMBAT-10), up to localLoadTimeout
    this.after(this.timings.loadTimeout, () => {
      if (token !== this.flowToken || this.phaseValue !== 'loading') return;
      this.waitingLoad.clear();
      this.maybeBeginPlaying();
    });
    this.after(Math.max(this.timings.loadTimeout, this.timings.localLoadTimeout), () => {
      if (token === this.flowToken && this.phaseValue === 'loading') this.beginPlaying();
    });
    // the UI mounts the view here and may call setLocalLoading() synchronously:
    // this must happen before maybeBeginPlaying() can start the clock
    this.emitter.emit('matchStart', this.localView);
    if (this.phaseValue === 'loading' && this.sim === sim) this.maybeBeginPlaying();
  }

  private sendMatchStart(peer: PeerRec): void {
    const sim = this.sim;
    const table = this.table;
    if (!sim || !table || !this.pick) return;
    const rec = peer.seat === null ? undefined : this.seats.get(peer.seat);
    if (!rec) return;
    peer.loaded = false;
    peer.inputQueue = [];
    peer.lastInputSeq = 0;
    peer.processedSeq = 0;
    peer.lastFrame = null;
    peer.starvedTicks = 0;
    peer.neutralized = false;
    peer.sent.clear();
    peer.snapAck = -1;
    // it is building the map / scene and compiling shaders now (a page frozen for
    // seconds at a time on a slow device): the long loading timeout until 'loaded'
    peer.loading = true;
    peer.warmUp.reset();
    // input cadence is learnt afresh (the gap before this match / during the blip says nothing)
    peer.lastInputAt = 0;
    peer.inputGapMs = 0;
    const seats: SeatInfo[] = [...this.seats.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((r) => {
        const heroId = this.pick?.picks.get(r.seat) ?? '';
        const info: SeatInfo = {
          seat: r.seat,
          playerId: r.playerId,
          name: r.name,
          isBot: this.seatBotControlled(r.seat),
          heroId,
          entityId: sim.entityOf(r.playerId),
        };
        const k = heroKingdom(heroId);
        if (k) info.kingdom = k;
        return info;
      });
    this.sendTo(peer.id, {
      t: 'matchStart',
      seats,
      mapSeed: this.settings.mapSeed,
      settings: { ...this.settings },
      you: sim.entityOf(rec.playerId),
      strings: [...table.strings],
      tick: sim.tick,
      matchId: this.matchId,
    });
  }

  private maybeBeginPlaying(): void {
    if (this.phaseValue === 'loading' && this.waitingLoad.size === 0 && !this.localLoading) this.beginPlaying();
  }

  private beginPlaying(): void {
    if (this.phaseValue !== 'loading' || !this.loop) return;
    this.flowToken++;
    this.clearTimers();
    this.waitingLoad.clear();
    this.localLoading = false;
    this.setPhase('playing');
    // the HUD mounted by the phase change may already have asked to pause (「点击进入战场」):
    // setPaused could not freeze a loop that was not running yet, so it starts frozen (UX-11)
    this.loop.start(this.paused);
  }

  /** One authoritative tick. */
  private tick(): void {
    const sim = this.sim;
    if (!sim) return;
    if (this.godPlayers.size > 0) {
      const w = this.cheatWorld();
      for (const pid of this.godPlayers) {
        const id = sim.entityOf(pid);
        if (w && id !== null) this.applyGod(w, id);
      }
    }
    for (const peer of this.peers.values()) {
      if (peer.seat === null) continue;
      const rec = this.seats.get(peer.seat);
      if (!rec || rec.peer !== peer.id) {
        peer.inputQueue.length = 0;
        continue;
      }
      const f = peer.inputQueue.shift();
      if (f) {
        sim.setInput(rec.playerId, f);
        peer.processedSeq = f.seq;
        peer.lastFrame = f;
        peer.starvedTicks = 0;
        peer.neutralized = false;
        continue;
      }
      // silent client (hidden tab, stall, dying link): let go of its controls
      if (!peer.neutralized && peer.lastFrame && ++peer.starvedTicks >= this.staleTicksFor(peer)) {
        const n = neutralInput(peer.lastFrame);
        if (n) sim.setInput(rec.playerId, n);
        peer.neutralized = true;
      }
    }
    sim.step();
    const events = sim.drainEvents();
    if (this.extraEvents.length > 0) {
      events.push(...this.extraEvents);
      this.extraEvents = [];
    }
    if (events.length > 0) this.fanOutEvents(sim.tick, events);
    this.localView?.onStep();

    this.snapAcc += SNAPSHOT_HZ / SIM_HZ;
    if (this.snapAcc >= 1) {
      this.snapAcc -= 1;
      this.sendSnapshots();
    }

    if (this.phaseValue === 'playing') {
      const r = sim.result();
      if (r) this.onGameOver(r);
    } else if (this.phaseValue === 'gameOver') {
      if (--this.postGameTicks <= 0) this.loop?.stop();
    }
  }

  /**
   * Deliver one tick's events: public events to everyone, private ones (hidden
   * information, see eventFilter.ts) only to the player they concern — the
   * host's own LocalView included.
   */
  private fanOutEvents(tick: number, events: GameEvent[]): void {
    const sim = this.sim;
    const priv = hasPrivateEvents(events);
    const entityOf = (playerId: PlayerId): number | null => {
      try {
        return sim?.entityOf(playerId) ?? null;
      } catch {
        return null;
      }
    };
    if (this.localView) this.localView.pushEvents(priv ? filterEventsFor(events, entityOf(this.myId)) : events);
    const t = this.transport;
    if (!t) return;
    const pub = priv ? filterEventsFor(events, null) : events;
    let pubText: string | null = null;
    const encode = (list: GameEvent[]): string => encodeJson({ t: 'events', tick, events: list } satisfies HostMsg, { round: true });
    for (const peer of this.peers.values()) {
      if (peer.seat === null || !peer.loaded) continue;
      let list = pub;
      if (priv) {
        const rec = this.seats.get(peer.seat);
        if (!rec || rec.peer !== peer.id) continue;
        list = filterEventsFor(events, entityOf(rec.playerId));
      }
      if (list.length === 0) continue;
      // same length as the public list ⇒ identical (the filter only removes)
      const text = list.length === pub.length ? (pubText ??= encode(pub)) : encode(list);
      t.send(peer.id, text, 'reliable');
    }
  }

  /** Add a host-generated event (announcements) to the stream; sent with the next tick. */
  private injectEvent(ev: GameEvent): void {
    const sim = this.sim;
    if (!sim) return;
    if (this.loop?.isRunning) {
      this.extraEvents.push(ev);
      if (this.extraEvents.length > 64) this.extraEvents.shift();
    } else if (this.phaseValue === 'gameOver') {
      this.fanOutEvents(sim.tick, [ev]);
    }
  }

  private sendSnapshots(): void {
    const sim = this.sim;
    const table = this.table;
    const t = this.transport;
    if (!sim || !table || !t) return;
    const pingByPlayer = new Map<PlayerId, number>();
    for (const peer of this.peers.values()) {
      if (peer.seat === null || peer.rtt === null) continue;
      const rec = this.seats.get(peer.seat);
      if (rec) pingByPlayer.set(rec.playerId, Math.round(peer.rtt));
    }
    for (const peer of this.peers.values()) {
      if (peer.seat === null || !peer.loaded) continue;
      const rec = this.seats.get(peer.seat);
      if (!rec || rec.peer !== peer.id) continue;
      try {
        const raw = sim.snapshotFor(rec.playerId);
        const snap = {
          ...raw,
          ackSeq: peer.processedSeq,
          players: raw.players.map((p) => {
            const ping = pingByPlayer.get(p.playerId);
            return ping === undefined ? p : { ...p, ping };
          }),
        };
        // delta against the newest snapshot the client confirmed (full if none)
        const baseEnts = peer.snapAck >= 0 ? peer.sent.get(peer.snapAck) : undefined;
        const base = baseEnts ? { tick: peer.snapAck, ents: baseEnts } : null;
        t.send(peer.id, encodeSnapshotMsg(snap, table, base), 'unreliable');
        this.rememberSent(peer, snap.tick, snap.ents);
      } catch (err) {
        console.error('[net] snapshot failed', err);
      }
    }
  }

  /** Keep what was sent as a potential delta baseline (bounded history). */
  private rememberSent(peer: PeerRec, tick: number, ents: readonly ViewEntity[]): void {
    const byId = new Map<EntityId, ViewEntity>();
    for (const e of ents) byId.set(e.id, e);
    peer.sent.delete(tick);
    peer.sent.set(tick, byId);
    while (peer.sent.size > DELTA_HISTORY) {
      const oldest = peer.sent.keys().next().value as number;
      peer.sent.delete(oldest);
      if (oldest === peer.snapAck) peer.snapAck = -1;
    }
  }

  private onGameOver(r: GameResult): void {
    this.resultValue = r;
    this.postGameTicks = Math.max(1, Math.round(this.timings.postGame * SIM_HZ));
    this.setPhase('gameOver');
    this.broadcast({ t: 'gameOver', result: r });
    this.emitter.emit('gameOver', r);
  }

  private stopMatch(): void {
    this.unwatchFocus?.();
    this.unwatchFocus = null;
    this.paused = false;
    this.localLoading = false;
    this.godPlayers.clear();
    this.loop?.stop();
    this.loop = null;
    this.localView?.dispose();
    this.localView = null;
    this.sim = null;
    this.table = null;
    this.waitingLoad.clear();
  }

  // ── misc ─────────────────────────────────────────────────────────────────
  private relayChat(from: string, text: string): void {
    this.broadcast({ t: 'chat', from, text });
    this.emitter.emit('chat', { from, text });
  }

  /** Tell everyone; `log`: a lobby event (join / leave / kick) that the UI keeps as a system chat line. */
  private notice(zh: string, en: string, log = false): void {
    this.broadcast(log ? { t: 'notice', zh, en, log: true } : { t: 'notice', zh, en });
    this.status(zh, en);
    if (log) this.emitter.emit('chat', { from: '', text: zh, system: true, zh, en });
  }

  private status(zh: string, en: string): void {
    this.emitter.emit('status', { zh, en });
  }

  private fail(err: NetError): void {
    const p = err.toPayload();
    this.broadcast({ t: 'error', code: p.code, zh: p.zh, en: p.en });
    this.emitter.emit('error', p);
  }

  private setPhase(p: MatchPhase): void {
    if (this.phaseValue === p) return;
    this.phaseValue = p;
    this.unpause(); // a paused single-player match resumes on any phase change (game over, back to lobby)
    this.emitter.emit('phase', p);
  }

  private sendTo(peer: PeerId, msg: HostMsg, channel: Channel = 'reliable'): void {
    this.transport?.send(peer, encodeJson(msg), channel);
  }

  /** Send to every seated, connected peer. */
  private broadcast(msg: HostMsg): void {
    const t = this.transport;
    if (!t) return;
    const text = encodeJson(msg);
    for (const peer of this.peers.values()) if (peer.seat !== null) t.send(peer.id, text, 'reliable');
  }

  private after(seconds: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, Math.max(0, seconds * 1000));
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  private dispose(): void {
    this.disposed = true;
    this.stopMatch();
    this.clearTimers();
    for (const t of this.dropTimers.values()) clearTimeout(t);
    this.dropTimers.clear();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const u of this.unsubs) u();
    const t = this.transport;
    // let the 'leave' message flush before tearing the link down
    if (t) setTimeout(() => t.close(), 100);
    this.emitter.clear();
  }

  /** Diagnostics for tests / debug overlays. */
  debugState(): { phase: MatchPhase; peers: number; tick: number; loopRunning: boolean; paused: boolean; ticker: string | null } {
    return {
      phase: this.phaseValue,
      peers: this.peers.size,
      tick: this.sim?.tick ?? 0,
      loopRunning: this.loop?.isRunning ?? false,
      paused: this.paused,
      ticker: this.loop?.tickerKind ?? null,
    };
  }

  /** The live SimHost (tests / debug tools). */
  get simHost(): SimHost | null {
    return this.sim;
  }

  /** Secret: the dealt roles (tests only — never expose to clients). */
  get dealtRoles(): RoleDeal | null {
    return this.deal;
  }
}

/** Default match factory: sim/world is imported lazily so a broken or heavy sim module never blocks the app shell. */
async function loadAndCreateMatch(init: MatchInit): Promise<SimHost> {
  const { createMatch } = await import('../sim/world');
  return createMatch(init);
}

function sanitizeSettings(s: MatchSettings, minPlayers: number): MatchSettings {
  const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  const d = defaultSettings();
  return {
    playerCount: clampPlayerCount(Math.max(num(s.playerCount, 5, 8, d.playerCount), minPlayers)),
    mode: s.mode === 'chaos' ? 'chaos' : 'standard',
    botDifficulty: s.botDifficulty === 'easy' || s.botDifficulty === 'hard' ? s.botDifficulty : 'normal',
    heroChoices: num(s.heroChoices, 1, 10, d.heroChoices),
    freePick: s.freePick === true,
    mapSeed: num(s.mapSeed, 0, 0xffffffff, d.mapSeed),
    friendlyFire: s.friendlyFire !== false,
    troopsPerHero: num(s.troopsPerHero, 0, 12, d.troopsPerHero),
  };
}
