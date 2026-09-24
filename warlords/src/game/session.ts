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
  chat: { from: string; text: string };
  /** connection problems, kicked, host left... */
  error: { code: string; zh: string; en: string };
  /** connection status line for the lobby UI */
  status: { zh: string; en: string };
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
}
