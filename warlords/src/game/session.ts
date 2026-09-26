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
   * key 'waitingHost': "Waiting for host…" → "Host is responding again";
   * key 'hostUnreachable': the auto-rejoin cannot find the host, still retrying →
   * "Reconnected"; key 'relayLink' on the host: its relay socket is being re-established).
   */
  status: { zh: string; en: string; key?: string; clear?: boolean };
};

export type SessionEvent = keyof SessionEventMap;

export interface LeaveOptions {
  /** the page is unloading (reload / tab closed), not leaving: keep the seat token (see GameSession.leave) */
  keepToken?: boolean;
}

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
  /**
   * Leave the room / end the session. `keepToken`: this is not a real leave but
   * the page going away (F5 / closing the tab) — an online guest keeps its seat
   * token (sessionStorage survives a reload of the same tab), so the reloaded
   * page reclaims the same seat. A plain leave() forgets it: the next join is a
   * new seat. The host and single player ignore it.
   */
  leave(opts?: LeaveOptions): void;

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
  /**
   * Guests: how long the host has been silent, in ms this page was responsive (0 while it
   * talks). For a "等待房主响应… 12 s" counter next to the waitingHost chip (MP2-1). On the
   * WebSocket relay a silent host is waited for as long as the relay says it is there.
   */
  readonly hostSilentMs?: number;
  /**
   * Guests: the automatic rejoin cannot reach the host (P2P: its peer id is gone from the
   * signalling server — a frozen host; relay: the room is not found) and keeps trying for a
   * while (status key 'hostUnreachable'): offer 重试 (retryNow) / 离开 (leave) (MP2-2).
   */
  readonly hostUnreachable?: boolean;
  /** Guests: during the automatic rejoin, try again right now (and keep trying for the full window again). */
  retryNow?(): void;
  /**
   * Guests: this match's view exists but the host's clock has not started yet (the host,
   * or a slow guest, is still loading): the phase stays 'loading' until the first snapshot
   * — the loading screen can say 等待房主加载… once the own view is ready (MP2-1).
   */
  readonly awaitingHostStart?: boolean;
}
