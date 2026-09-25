// The context object every screen receives from the app shell.
import type { MatchSettings } from '../core/types';
import type { GameSession } from '../game/session';
import type { NetServerConfig } from '../game/settings';
import type { AppDeps, LoadProgress } from './app';
import type { PortraitCache, SfxName } from './widgets';
import type { LobbyChatLog } from './screens/lobby';

export type ScreenId =
  | 'title'
  | 'single'
  | 'online'
  | 'lobby'
  | 'roles'
  | 'heroSelect'
  | 'loading'
  | 'match'
  | 'gameOver'
  | 'gallery'
  | 'help';

export type SettingsTab = 'general' | 'controls' | 'graphics' | 'audio' | 'network';

export interface Screen {
  readonly el: HTMLElement;
  dispose(): void;
  /** re-render text after a language change (screens without it are rebuilt) */
  relabel?(): void;
}

export interface UiCtx {
  readonly deps: AppDeps;
  /** the `.sg-root` element */
  readonly root: HTMLElement;
  readonly portraits: PortraitCache;
  readonly session: GameSession | null;
  readonly sessionKind: 'single' | 'online' | null;
  /** WebGL 2 probe at boot: without it no match can render (the title explains and blocks play) */
  readonly webgl: { ok: boolean; reason: string | null };
  sfx(name: SfxName): void;
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(text: string, opts?: { ok?: string; cancel?: string; title?: string }): Promise<boolean>;
  alert(title: string, text: string): Promise<void>;
  openSettings(tab?: SettingsTab): void;
  /** navigate between non-session screens */
  go(screen: ScreenId): void;
  /** saved (or generated) player name */
  playerName(): string;
  /** create the local session, apply settings and start */
  startSingle(patch: Partial<MatchSettings>): void;
  hostOnline(mode: 'peer' | 'ws'): Promise<void>;
  joinOnline(code: string, mode: 'peer' | 'ws'): Promise<void>;
  /** leave the current session (and by default return to the title) */
  leaveSession(goTitle?: boolean): void;
  /** single player: go back to the lobby and immediately start again */
  playAgain(): void;
  /** the hero you picked this match (still known after the hero-select phase ends), if any */
  myHero(): string | null;
  /** room code from `?room=` (consumed once) */
  pendingRoom(): string | null;
  /**
   * Staged 3D loading progress of the current match view (null before the view
   * exists). `cb` is called right away and on every change.
   */
  loadProgress?(cb: (p: LoadProgress | null) => void): () => void;
  /** lobby chat history of the current online session (kept across matches) */
  chatLog?(): LobbyChatLog | null;
  /** how the current online session connects (invite links carry it) */
  connection?(): { mode: 'peer' | 'ws'; net: NetServerConfig } | null;
}
