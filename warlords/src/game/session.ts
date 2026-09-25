// The object the UI talks to for the whole pre-match + match flow.
// Implemented by net/hostSession.ts (host / single-player) and
// net/clientSession.ts (joined players). UI never touches transports or sim.
import type {
  GameResult,
  HeroSelectView,
  LobbyState,
  MatchPhase,
  MatchSettings,
  PlayerId,
  RoleDealView,
} from '../core/types';
import type { ViewSource } from '../render/view';

export type SessionEventMap = {
  phase: MatchPhase;
  lobby: LobbyState;
  roles: RoleDealView;
  heroSelect: HeroSelectView;
  /** match world ready: UI should mount the game view */
  matchStart: ViewSource;
  gameOver: GameResult;
  /**
   * A chat line. `system`: a lobby event (player joined / left / was kicked) —
   * `from` is empty and `zh` / `en` carry the localized text (`text` = zh).
   */
  chat: { from: string; text: string; system?: boolean; zh?: string; en?: string };
  /** connection problems, kicked, host left... */
  error: { code: string; zh: string; en: string };
  /**
   * Connection status line (lobby status, HUD system line). `key` groups
   * lines that replace each other; `clear: true` ends that condition (e.g.
   * key 'waitingHost': "Waiting for host…" → "Host is responding again").
   */
  status: { zh: string; en: string; key?: string; clear?: boolean };
};

export type SessionEvent = keyof SessionEventMap;

export interface GameSession {
  readonly isHost: boolean;
  readonly myId: PlayerId;
  readonly phase: MatchPhase;
  readonly lobby: LobbyState | null;
  readonly roles: RoleDealView | null;
  readonly heroSelect: HeroSelectView | null;
  readonly view: ViewSource | null;
  readonly result: GameResult | null;

  on<K extends SessionEvent>(ev: K, cb: (payload: SessionEventMap[K]) => void): () => void;

  // everyone
  setName(name: string): void;
  setReady(ready: boolean): void;
  pickHero(heroId: string): void;
  sendChat(text: string): void;
  leave(): void;

  // host only (no-ops on clients)
  updateSettings(patch: Partial<MatchSettings>): void;
  addBot(): void;
  removeBot(seat: number): void;
  kick(seat: number): void;
  /** start the match (fills empty seats with bots up to playerCount) */
  start(): void;
  /** back to lobby after game over */
  returnToLobby(): void;

  // optional capabilities (callers use `session.x?.()`)
  /**
   * Single player only (host without network, phase 'playing'): freeze the
   * match — no sim steps, no bot thinking — while the pause menu is open.
   * Online sessions ignore it. Resumes by itself on a phase change / leave.
   */
  setPaused?(paused: boolean): void;
  /**
   * Hero select: the hero the player is looking at. Not a pick — but if the
   * pick timer runs out, that hero is auto-picked (when still available).
   */
  focusHero?(heroId: string): void;
  /**
   * Called by the UI synchronously from its 'matchStart' handler with the
   * game view's "ready" promise (scene built, shaders compiled): the match
   * clock does not start for this player before it settles (capped by the
   * host's load timeout). Not calling it keeps the old behaviour.
   */
  setLocalLoading?(ready: Promise<void>): void;
  /** Guests: true while the host has been silent for a few seconds (see status key 'waitingHost'). */
  readonly waitingForHost?: boolean;
}
