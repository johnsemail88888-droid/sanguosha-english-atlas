// Wire protocol between host and clients (GAME_SPEC §3, §11).
//
// Control messages are JSON text (see codec.encodeJson/decodeJson). The two hot
// paths — Snapshot (host → client, 20 Hz) and InputFrame (client → host, 30 Hz)
// — are compact binary (codec.encodeSnapshotMsg / encodeInputMsg); binary frames
// start with a one-byte tag (BIN_*).
//
// Hidden information rule: a message sent to player P never contains another
// player's role unless it is public (lord / revealed). Role deals and hero
// options are therefore always sent per player, never broadcast.
import type {
  EntityId,
  GameEvent,
  GameResult,
  HeroSelectView,
  InputAction,
  InputFrame,
  Kingdom,
  LobbyState,
  MatchPhase,
  MatchSettings,
  PlayerId,
  PublicPlayerView,
  RoleDealView,
} from '../core/types';

export { PROTOCOL_VERSION } from '../core/types';

/** Binary frame tags (first byte). */
export const BIN_SNAPSHOT = 1;
export const BIN_INPUT = 2;

/** Public seat table sent at match start (no roles!). */
export interface SeatInfo {
  seat: number;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  heroId: string;
  kingdom?: Kingdom;
  entityId: EntityId | null;
}

// ── client → host ───────────────────────────────────────────────────────────
export type ClientMsg =
  /** join / rejoin; `token` (from a previous welcome) reclaims that seat */
  | { t: 'hello'; v: number; name: string; token?: string }
  | { t: 'setName'; name: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'pick'; heroId: string }
  /**
   * The hero this player is looking at on hero select (not a pick): if the pick
   * timer runs out, the host auto-picks it instead of a bot choice. Additive.
   */
  | { t: 'pickHint'; hero: string }
  | { t: 'chat'; text: string }
  /** map built, view mounted: the host may start stepping */
  | { t: 'loaded' }
  | { t: 'ping'; id: number; ts: number }
  | { t: 'pong'; id: number; ts: number }
  /**
   * Delta baseline acknowledgement without an input frame (unreliable channel): sent
   * from the receive path when no input packet carried the ack for a while — a guest
   * rendering at < 1 fps still gets deltas, not full snapshots (MP2-6). Additive.
   */
  | { t: 'ack'; tick: number }
  | { t: 'leave' };

// ── host → client ───────────────────────────────────────────────────────────
export type HostMsg =
  /** `token` is private to this player: presenting it in a later hello reclaims the seat */
  | { t: 'welcome'; v: number; playerId: PlayerId; seat: number; phase: MatchPhase; lobby: LobbyState; token?: string }
  /**
   * join refused (version, full, in progress…); the connection is closed afterwards.
   * Also sent to a welcomed connection whose seat was just reclaimed by the same
   * player's newer one (code 'replacedElsewhere', a duplicated tab): final, the
   * replaced connection must not rejoin by itself (MP2-4).
   */
  | { t: 'reject'; code: string; zh: string; en: string }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'settings'; settings: MatchSettings }
  | { t: 'kick'; zh: string; en: string }
  /** the host pressed 开始: the flow leaves the lobby */
  | { t: 'start' }
  /** your private role card (+ how long the reveal lasts) */
  | { t: 'roles'; deal: RoleDealView; seconds: number }
  /** your private hero-select view (options are personal, picks public) */
  | { t: 'heroSelect'; view: HeroSelectView }
  | {
      t: 'matchStart';
      seats: SeatInfo[];
      mapSeed: number;
      settings: MatchSettings;
      /** your hero entity */
      you: EntityId | null;
      /** per-match string table used by the binary snapshot codec */
      strings: string[];
      tick: number;
      /**
       * Identifies the match (additive, optional): a rejoin that receives the
       * matchStart of the match it already shows keeps its view and renderer.
       */
      matchId?: number;
    }
  /** GameEvents produced by host tick `tick` (reliable channel) */
  | { t: 'events'; tick: number; events: GameEvent[] }
  | { t: 'chat'; from: string; text: string }
  | { t: 'ping'; id: number; ts: number }
  | { t: 'pong'; id: number; ts: number }
  /**
   * `players` (optional): the final public player list — sent to a player who
   * (re)joins after the match ended, when no snapshots follow any more.
   */
  | { t: 'gameOver'; result: GameResult; players?: PublicPlayerView[] }
  | { t: 'returnToLobby'; lobby: LobbyState }
  /**
   * informational line (player joined / disconnected / reconnected); `log`:
   * a lobby event (join / leave / kick) the UI keeps as a system chat line
   */
  | { t: 'notice'; zh: string; en: string; log?: boolean }
  /** non-fatal flow error (e.g. match creation failed) */
  | { t: 'error'; code: string; zh: string; en: string }
  /** the host closed the room */
  | { t: 'leave' };

export type ClientMsgType = ClientMsg['t'];
export type HostMsgType = HostMsg['t'];

const CLIENT_TYPES: ReadonlySet<string> = new Set<ClientMsgType>([
  'hello',
  'setName',
  'ready',
  'pick',
  'pickHint',
  'chat',
  'loaded',
  'ping',
  'pong',
  'ack',
  'leave',
]);

const HOST_TYPES: ReadonlySet<string> = new Set<HostMsgType>([
  'welcome',
  'reject',
  'lobby',
  'settings',
  'kick',
  'start',
  'roles',
  'heroSelect',
  'matchStart',
  'events',
  'chat',
  'ping',
  'pong',
  'gameOver',
  'returnToLobby',
  'notice',
  'error',
  'leave',
]);

export const isClientMsg = (m: { t: string }): m is ClientMsg => CLIENT_TYPES.has(m.t);
export const isHostMsg = (m: { t: string }): m is HostMsg => HOST_TYPES.has(m.t);

/**
 * Input as it travels on the wire: the frame plus the edge actions of up to the
 * previous 3 frames (unreliable channel: a lost packet's actions still arrive in
 * the next one). The host de-duplicates by seq.
 */
export interface InputPacket {
  frame: InputFrame;
  history: { seq: number; actions: InputAction[] }[];
  /** newest snapshot tick the client holds (delta baseline acknowledgement) */
  snapAck?: number;
}

/** How many previous frames' actions are repeated in each InputPacket. */
export const INPUT_REDUNDANCY = 3;

/** Max chat message length (characters). */
export const MAX_CHAT_LEN = 200;
/** Max player name length (characters). */
export const MAX_NAME_LEN = 16;
/** Max reclaim token length (characters). */
export const MAX_TOKEN_LEN = 64;
/** Max hero id length accepted in client messages (characters). */
export const MAX_HERO_ID_LEN = 32;

export function sanitizeName(name: string, fallback = '玩家'): string {
  // strip control chars, collapse whitespace
  const s = Array.from(name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_NAME_LEN)
    .join('');
  return s || fallback;
}

export function sanitizeChat(text: string): string {
  return Array.from(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
    .slice(0, MAX_CHAT_LEN)
    .join('');
}
