// App shell: owns the layer stack (3D game, HUD, screens, modals, toasts),
// routes screens from GameSession phases/events, and exposes the UiCtx that
// every screen uses. Public entry point: mountApp().
import type { GameEvent, MatchPhase, MatchSettings, Vec3 } from '../core/types';
import type { GameSession } from '../game/session';
import type { InputSink } from '../game/input-types';
import { settings } from '../game/settings';
import type { ViewSource } from '../render/view';
import type { ScreenId, Screen, SettingsTab, UiCtx } from './ctx';
import { Bag, h, clear } from './dom';
import { getLang, t, tx } from './i18n';
import { applyRootVars, injectStyles } from './styles';
import { PortraitCache, button, type SfxName } from './widgets';
import { TITLE_ART } from './art';
import { artBackdrop, type ArtBackdrop } from './keyart';
import { heroAbilityArt, matchCardArt, prefetchArt } from './artIcons';
import { HEROES } from '../data';
import { createTitleScreen } from './screens/title';
import { createSingleScreen } from './screens/single';
import { allowRejoin, createOnlineScreen } from './screens/online';
import { LobbyChatLog, createLobbyScreen } from './screens/lobby';
import { createRolesScreen, mySeat } from './screens/roles';
import { createHeroSelectScreen } from './screens/heroSelect';
import { createLoadingScreen } from './screens/loading';
import { createGameOverScreen } from './screens/gameOver';
import { createGalleryScreen } from './screens/gallery';
import { createHelpScreen } from './screens/help';
import { createSettingsPanel } from './screens/settings';
import { Hud } from './hud/hud';
import { probeWebGL, type WebGLSupport } from './webgl';
import { clearRejoin, isReconnectable, loadRejoin, netFor, saveRejoin } from './invite';
import type { NetServerConfig } from '../game/settings';

export type UiKey = 'scoreboard' | 'map' | 'chat' | 'menu' | 'quickchat';

export interface AppDeps {
  createLocalSession(name: string): GameSession;
  hostOnline(name: string, mode: 'peer' | 'ws'): Promise<GameSession>;
  joinOnline(code: string, name: string, mode: 'peer' | 'ws'): Promise<GameSession>;
  /** mount the 3D game for a ViewSource; returns a handle the UI uses during the match */
  mountGame(container: HTMLElement, view: ViewSource, session: GameSession): GameHandle;
  renderHeroPortrait(heroId: string, size?: number): Promise<string>;
  mountHeroTurntable?(container: HTMLElement, heroId: string): { dispose(): void };
  audio?: {
    ui(name: 'click' | 'hover' | 'confirm' | 'back' | 'flip' | 'error' | 'countdown' | 'reveal'): void;
    music(track: 'menu' | 'battle' | 'victory' | 'defeat' | null): void;
    unlock(): Promise<void>;
  };
}

export interface GameHandle {
  input: InputSink & {
    onUiKey(cb: (key: UiKey, down: boolean) => void): () => void;
    setEnabled(on: boolean): void;
    requestLock(): void;
    isLocked(): boolean;
  };
  /** batches of GameEvents each frame (the renderer is the only drainEvents consumer and re-emits them here) */
  onEvents(cb: (evs: readonly GameEvent[]) => void): () => void;
  setSpectateTarget(id: number | null): void;
  dispose(): void;
  /**
   * Optional: project a world point to CSS pixels relative to the game container
   * (null when behind the camera). When present, damage numbers float at the hit point.
   */
  worldToScreen?(p: Vec3): { x: number; y: number } | null;
  /**
   * Optional staged loading (scene build → shader warm-up → first frames). `cb` is
   * called right away with the current state. While not ready the loading screen
   * stays up (showing this progress) even after the session reached 'playing'.
   */
  onLoadProgress?(cb: (p: LoadProgress) => void): () => void;
  isReady?(): boolean;
}

export interface LoadProgress {
  /** 0..1 */
  progress: number;
  stage: 'scene' | 'models' | 'shaders' | 'warmup' | 'ready' | 'failed';
  error?: string;
}

export interface MountAppOptions {
  /** open this screen first (dev harness / deep links) */
  initialScreen?: ScreenId;
  /** pre-fill the join code (defaults to `?room=` in the URL) */
  roomCode?: string | null;
  /** version string shown on the title screen */
  version?: string;
  /** adopt an already-created session (deep links, reconnects, dev harness) */
  initialSession?: { session: GameSession; kind: 'single' | 'online' };
  /** open the settings modal on this tab right after mounting */
  initialSettings?: SettingsTab;
  /** override the WebGL 2 probe (dev harness: `false` previews the "no WebGL" title) */
  webgl?: boolean;
}

type MusicTrack = 'menu' | 'battle' | 'victory' | 'defeat' | null;

/** Menu screens drawn over the blurred key art (when it ships): the title and loading have their own art. */
const MENU_ART_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['single', 'online', 'lobby', 'roles', 'heroSelect', 'gallery', 'help']);

/** Error codes after which the session is unusable (we return to the title). */
const FATAL_CODES = new Set([
  'kicked',
  'hostLeft',
  'connectionLost',
  'closed',
  'roomFull',
  'roomNotFound',
  'versionMismatch',
  'inProgress',
  'simFailed',
  'timeout',
  'serverUnreachable',
  'networkRestricted',
  'unsupported',
]);
const FATAL_ERROR = /kick|host.?left|disconnect|lost|closed|full|version|not.?found|fail|timeout|refused|ended/i;

export function isFatalSessionError(code: string): boolean {
  return FATAL_CODES.has(code) || FATAL_ERROR.test(code);
}

/** Session endings that are news, not malfunctions: titled 提示 / Notice instead of 出错了. */
export function isNoticeCode(code: string): boolean {
  return code === 'kicked' || code === 'hostLeft' || /kick|host.?left/i.test(code);
}

class App implements UiCtx {
  readonly root: HTMLElement;
  readonly portraits: PortraitCache;
  session: GameSession | null = null;
  sessionKind: 'single' | 'online' | null = null;

  private readonly bag = new Bag();
  private readonly gameLayer: HTMLElement;
  private readonly hudLayer: HTMLElement;
  private readonly screenLayer: HTMLElement;
  private readonly modalLayer: HTMLElement;
  private readonly toastLayer: HTMLElement;
  private screen: Screen | null = null;
  private screenId: ScreenId | null = null;
  private settingsPanel: Screen | null = null;
  private sessionBag: Bag | null = null;
  private lastPhase: MatchPhase | null = null;
  /** your hero this match: sessions stop exposing `heroSelect` once that phase ends */
  private pickedHero: string | null = null;
  private autoRestart = false;
  private match: { handle: GameHandle; hud: Hud; container: HTMLElement; view: ViewSource; offLoad: () => void; settleLoad: () => void } | null = null;
  /** lobby chat of the current online session: kept across matches (the lobby screen is rebuilt) */
  private lobbyChat: LobbyChatLog | null = null;
  /** connection of the current online session (host or guest) */
  private conn: { mode: 'peer' | 'ws'; net: NetServerConfig } | null = null;
  private load: LoadProgress | null = null;
  private readonly loadSubs = new Set<(p: LoadProgress | null) => void>();
  private music: MusicTrack | undefined = undefined;
  private unlocked = false;
  private lastHover = 0;
  private roomCode: string | null;
  private lang = getLang();
  readonly version: string;
  /** WebGL 2 is available (probed once at boot): without it no match can render */
  readonly webgl: WebGLSupport;
  /** the 3D view of the current match failed to start (the failure modal is up) */
  private loadFailed = false;
  /** blurred key art behind the menu screens (dropped during a match to free the decoded image) */
  private menuArt: ArtBackdrop | null = null;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    host: HTMLElement,
    readonly deps: AppDeps,
    opts: MountAppOptions,
  ) {
    injectStyles(host.ownerDocument);
    this.version = opts.version ?? '0.1.0';
    this.webgl = opts.webgl === undefined ? probeWebGL(host.ownerDocument) : { ok: opts.webgl, reason: opts.webgl ? null : 'disabled (dev harness)' };
    if (!this.webgl.ok) console.warn('[ui] WebGL 2 unavailable:', this.webgl.reason);
    this.portraits = new PortraitCache((id, size) => deps.renderHeroPortrait(id, size));
    this.root = h('div', { class: 'sg-root', data: { lang: this.lang } });
    applyRootVars(this.root);
    this.gameLayer = h('div', { class: 'sg-layer sg-game-layer' });
    this.hudLayer = h('div', { class: 'sg-layer sg-hud-layer pass' });
    this.screenLayer = h('div', { class: 'sg-layer sg-screen-layer pass' });
    this.modalLayer = h('div', { class: 'sg-layer sg-modal-layer pass' });
    this.toastLayer = h('div', { class: 'sg-toasts', aria: { live: 'polite' } });
    this.root.append(this.gameLayer, this.hudLayer, this.screenLayer, this.modalLayer, this.toastLayer);
    host.appendChild(this.root);
    this.root.lang = this.lang === 'en' ? 'en' : 'zh-CN';

    let room = opts.roomCode;
    if (room === undefined) {
      try {
        room = new URLSearchParams(location.search).get('room');
      } catch {
        room = null;
      }
    }
    this.roomCode = room ? room.trim().toUpperCase() : null;

    this.installGlobalListeners();
    this.bag.add(
      settings.subscribe((st) => {
        if (st.lang !== this.lang) {
          this.lang = st.lang;
          this.relabel();
        }
      }),
    );
    // no WebGL: an invite link still lands on the title, which explains why nothing can start.
    // A reload in the middle of an online session (F5) goes back to the online screen, which rejoins.
    const rejoin = opts.initialScreen || opts.initialSession ? null : loadRejoin();
    this.go(opts.initialScreen ?? ((this.roomCode || rejoin) && this.webgl.ok ? 'online' : 'title'));
    if (opts.initialSession) {
      const { session, kind } = opts.initialSession;
      this.attachSession(session, kind);
      if (kind === 'single' && session.phase === 'lobby') this.go('single');
    }
    if (opts.initialSettings) this.openSettings(opts.initialSettings);
  }

  // ── UiCtx ─────────────────────────────────────────────────────────────────

  sfx(name: SfxName): void {
    try {
      this.deps.audio?.ui(name);
    } catch (err) {
      console.warn('[ui] audio.ui failed', err);
    }
  }

  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    const el = h('div', { class: `sg-toast sg-dark ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
    this.toastLayer.appendChild(el);
    while (this.toastLayer.childElementCount > 4) this.toastLayer.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, kind === 'error' ? 4200 : 2600);
    if (kind === 'error') this.sfx('error');
  }

  confirm(text: string, opts: { ok?: string; cancel?: string; title?: string } = {}): Promise<boolean> {
    return new Promise((resolve) => {
      const close = (v: boolean): void => {
        back.remove();
        resolve(v);
      };
      const ok = button(opts.ok ?? t('common.confirm'), () => close(true), { sfx: 'confirm' });
      const back = h('div', { class: 'sg-modal-back', role: 'dialog', aria: { modal: 'true' } },
        h('div', { class: 'sg-modal sg-panel sg-corners' },
          opts.title ? h('h2', { class: 'sg-h2' }, opts.title) : null,
          h('p', null, text),
          h('div', { class: 'actions' },
            button(opts.cancel ?? t('common.cancel'), () => close(false), { cls: 'dark', sfx: 'back' }),
            ok,
          ),
        ),
      );
      back.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          close(false);
        }
      });
      this.modalLayer.appendChild(back);
      ok.focus();
    });
  }

  alert(title: string, text: string): Promise<void> {
    return new Promise((resolve) => {
      const close = (): void => {
        back.remove();
        resolve();
      };
      const ok = button(t('common.ok'), close, { sfx: 'confirm' });
      const back = h('div', { class: 'sg-modal-back', role: 'alertdialog', aria: { modal: 'true' } },
        h('div', { class: 'sg-modal sg-panel sg-corners' }, h('h2', { class: 'sg-h2' }, title), h('p', null, text), h('div', { class: 'actions' }, ok)),
      );
      this.modalLayer.appendChild(back);
      ok.focus();
    });
  }

  openSettings(tab: SettingsTab = 'general'): void {
    this.closeSettings();
    const panel = createSettingsPanel(this, tab, () => this.closeSettings());
    this.settingsPanel = panel;
    this.modalLayer.appendChild(panel.el);
    panel.el.querySelector<HTMLElement>('.sg-settings')?.focus({ preventScroll: true });
    this.match?.hud.setSettingsOpen(true);
  }

  private closeSettings(): void {
    if (!this.settingsPanel) return;
    this.settingsPanel.dispose();
    this.settingsPanel.el.remove();
    this.settingsPanel = null;
    this.match?.hud.setSettingsOpen(false);
  }

  loadProgress(cb: (p: LoadProgress | null) => void): () => void {
    this.loadSubs.add(cb);
    cb(this.load);
    return () => this.loadSubs.delete(cb);
  }

  private setLoad(p: LoadProgress | null): void {
    this.load = p;
    for (const cb of this.loadSubs) {
      try {
        cb(p);
      } catch (err) {
        console.error('[ui] load progress subscriber failed', err);
      }
    }
  }

  /** the 3D view finished its staged build (or there is none). A failed view is never "ready". */
  private matchReady(): boolean {
    if (this.loadFailed) return false;
    const hd = this.match?.handle;
    return !hd || !hd.isReady || hd.isReady();
  }

  private onLoadProgress(p: LoadProgress): void {
    this.setLoad(p);
    if (p.stage === 'failed') {
      this.onViewFailed(p.error);
      return;
    }
    if (p.stage === 'ready' && this.session?.phase === 'playing' && this.screenId === 'loading') this.go('match');
  }

  /**
   * The 3D view could not start (no WebGL, context lost, out of memory…): a match
   * without a picture is unplayable, so say why and offer the way back instead of
   * routing into a black screen.
   */
  private onViewFailed(error: string | undefined): void {
    if (this.loadFailed) return;
    this.loadFailed = true;
    this.sfx('error');
    const back = h('div', { class: 'sg-modal-back sg-view-failed', role: 'alertdialog', aria: { modal: 'true' } });
    const close = (): void => {
      back.remove();
      this.leaveSession(true);
    };
    const ok = button(t('over.toTitle'), close, { cls: 'gold', sfx: 'back' });
    back.append(
      h('div', { class: 'sg-modal sg-panel sg-corners' },
        h('h2', { class: 'sg-h2' }, tx('3D 画面无法启动', 'The 3D view could not start')),
        h('p', null, tx(
          '你的浏览器没能创建 WebGL 2 画面，这局无法进行。请在浏览器设置中开启「硬件加速」，更新显卡驱动或浏览器（推荐最新版 Chrome / Edge / Firefox），然后刷新页面再试。',
          'Your browser could not create a WebGL 2 view, so this match cannot be played. Turn on hardware acceleration in the browser settings, update your graphics driver or browser (latest Chrome / Edge / Firefox), then reload and try again.',
        )),
        error ? h('p', { class: 'sg-fail-detail' }, error) : null,
        h('div', { class: 'actions' }, ok),
      ),
    );
    this.modalLayer.appendChild(back);
    ok.focus();
  }

  /** false (after telling the player why) when this device cannot render a match */
  private canPlay(): boolean {
    if (this.webgl.ok) return true;
    void this.alert(tx('无法开始对局', "Can't start a match"), tx('此浏览器不支持 WebGL 2，无法显示 3D 画面。', 'This browser has no WebGL 2, so the 3D view cannot be shown.'));
    return false;
  }

  playerName(): string {
    let name = settings.get().playerName.trim();
    if (!name) {
      // stored language-neutral: displayName() shows 无名N as "Nameless N" in English
      name = `无名${100 + Math.floor(Math.random() * 900)}`;
      settings.update({ playerName: name });
    }
    return name;
  }

  chatLog(): LobbyChatLog | null {
    return this.lobbyChat;
  }

  myHero(): string | null {
    const s = this.session;
    if (!s) return null;
    return s.heroSelect?.picks[mySeat(s)] ?? this.pickedHero ?? s.view?.local()?.heroId ?? null;
  }

  pendingRoom(): string | null {
    const r = this.roomCode;
    this.roomCode = null;
    return r;
  }

  go(id: ScreenId): void {
    if (id === this.screenId && this.screen) return;
    const prev = this.screen;
    this.screen = null;
    if (prev) {
      this.portraits.release(prev.el);
      prev.dispose();
      prev.el.remove();
    }
    this.screenId = id;
    this.syncMenuArt(id);
    const s = this.createScreen(id);
    this.screen = s;
    if (s) this.screenLayer.appendChild(s.el);
    this.hudLayerVisible(id === 'match');
    this.updateMusic();
    this.root.dataset.activeScreen = id;
  }

  /** The blurred key art behind menu screens: created on the first menu screen, freed when a match loads. */
  private syncMenuArt(id: ScreenId): void {
    if (MENU_ART_SCREENS.has(id)) {
      if (this.menuArt) return;
      const art = artBackdrop([TITLE_ART], {
        cls: 'menu',
        onResolve: (url) => {
          if (url && this.menuArt === art) this.root.classList.add('menu-art');
        },
      });
      this.menuArt = art;
      this.screenLayer.prepend(art.el);
    } else if (id === 'loading' || id === 'match') {
      const art = this.menuArt;
      if (!art) return;
      this.menuArt = null;
      art.dispose();
      art.el.remove();
      this.root.classList.remove('menu-art');
    }
  }

  /** Warm the HTTP cache with every painted portrait once a match is being set up (hero select pops in). */
  private schedulePrefetch(): void {
    if (this.prefetchTimer !== null) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.portraits.prefetch(HEROES.map((x) => x.id));
    }, 600);
  }

  startSingle(patch: Partial<MatchSettings>): void {
    if (!this.canPlay()) return;
    let s = this.sessionKind === 'single' ? this.session : null;
    if (!s || s.phase !== 'lobby') {
      this.leaveSession(false);
      try {
        s = this.deps.createLocalSession(this.playerName());
      } catch (err) {
        console.error('[ui] createLocalSession failed', err);
        this.toast(t('error.generic'), 'error');
        return;
      }
      this.attachSession(s, 'single');
    }
    s.updateSettings(patch);
    s.start();
  }

  async hostOnline(mode: 'peer' | 'ws'): Promise<void> {
    if (!this.canPlay()) return;
    const s = await this.deps.hostOnline(this.playerName(), mode);
    if (this.adoptOnline(s)) this.conn = { mode, net: { ...settings.get().net } };
  }

  async joinOnline(code: string, mode: 'peer' | 'ws'): Promise<void> {
    if (!this.canPlay()) return;
    const s = await this.deps.joinOnline(code, this.playerName(), mode);
    if (!this.adoptOnline(s)) return;
    const net = { ...settings.get().net };
    this.conn = { mode, net };
    // F5 in the lobby or mid-match rejoins this room the same way (see screens/online.ts)
    saveRejoin({ code: (s.lobby?.roomCode || code).toUpperCase(), mode, net: netFor(mode, net) });
  }

  connection(): { mode: 'peer' | 'ws'; net: NetServerConfig } | null {
    return this.sessionKind === 'online' ? this.conn : null;
  }

  private adoptOnline(s: GameSession): boolean {
    // the player navigated away while connecting → drop the new session
    if (this.screenId !== 'online') {
      s.leave();
      return false;
    }
    this.leaveSession(false);
    this.attachSession(s, 'online');
    return true;
  }

  /** `keepRejoin`: a page unload (F5) must not forget how to rejoin this tab's room */
  leaveSession(goTitle = true, keepRejoin = false): void {
    const s = this.session;
    if (!keepRejoin) clearRejoin();
    this.conn = null;
    this.sessionBag?.dispose();
    this.sessionBag = null;
    this.session = null;
    this.sessionKind = null;
    this.lastPhase = null;
    this.pickedHero = null;
    this.autoRestart = false;
    this.lobbyChat?.dispose();
    this.lobbyChat = null;
    this.unmountMatch();
    if (s) {
      try {
        // coming back (F5, an involuntary drop): the seat token stays so the rejoin reclaims the seat
        s.leave(keepRejoin ? { keepToken: true } : undefined);
      } catch (err) {
        console.warn('[ui] session.leave failed', err);
      }
    }
    if (goTitle) this.go('title');
  }

  playAgain(): void {
    const s = this.session;
    if (!s) return;
    if (s.phase === 'lobby') {
      s.start();
      return;
    }
    this.autoRestart = true;
    s.returnToLobby();
  }

  // ── session routing ─────────────────────────────────────────────────────────

  private attachSession(s: GameSession, kind: 'single' | 'online'): void {
    this.session = s;
    this.sessionKind = kind;
    this.schedulePrefetch();
    this.lastPhase = s.phase;
    this.pickedHero = s.heroSelect?.picks[mySeat(s)] ?? null;
    const bag = new Bag();
    this.sessionBag = bag;
    if (kind === 'online') this.lobbyChat = new LobbyChatLog(s);
    bag.add(
      s.on('heroSelect', (v) => {
        const hero = v.picks[mySeat(s)];
        if (hero) this.pickedHero = hero;
        // the offered heroes' ability emblems: the detail panel shows them without a blank wait
        prefetchArt(heroAbilityArt(v.options));
      }),
    );
    bag.add(s.on('phase', (p) => this.onPhase(p)));
    bag.add(
      s.on('matchStart', (view) => {
        this.mountMatch(view);
        if (s.phase === 'playing') this.go(this.matchReady() ? 'match' : 'loading');
      }),
    );
    bag.add(s.on('gameOver', () => this.onPhase('gameOver')));
    bag.add(s.on('error', (e) => this.onSessionError(e)));
    // route to whatever phase the session is already in
    if (kind === 'online' || s.phase !== 'lobby') this.onPhase(s.phase, true);
  }

  private onPhase(phase: MatchPhase, force = false): void {
    const prev = this.lastPhase;
    if (!force && prev === phase && phase !== 'lobby') return;
    this.lastPhase = phase;
    const s = this.session;
    if (!s) return;
    switch (phase) {
      case 'lobby':
        this.pickedHero = null;
        this.unmountMatch();
        if (this.sessionKind === 'single') {
          if (this.autoRestart) {
            this.autoRestart = false;
            s.start();
          } else if (prev && prev !== 'lobby') {
            this.go('single');
          }
        } else {
          this.go('lobby');
        }
        break;
      case 'roles':
        this.pickedHero = null;
        // every card emblem of the match while the identities are dealt: pickups show their art at once
        prefetchArt(matchCardArt());
        this.go('roles');
        break;
      case 'heroSelect':
        if (s.heroSelect) prefetchArt(heroAbilityArt(s.heroSelect.options));
        this.go('heroSelect');
        break;
      case 'loading':
        if (s.view && !this.match) this.mountMatch(s.view);
        this.go('loading');
        break;
      case 'playing':
        if (s.view && !this.match) this.mountMatch(s.view);
        // keep the loading screen until the 3D view has rendered its first frames
        this.go(this.matchReady() ? 'match' : 'loading');
        break;
      case 'gameOver':
        if (s.view && !this.match) this.mountMatch(s.view);
        this.match?.hud.setGameOver(true);
        this.go('gameOver');
        break;
    }
  }

  private onSessionError(e: { code: string; zh: string; en: string }): void {
    const msg = tx(e.zh, e.en);
    if (isFatalSessionError(e.code)) {
      // a guest who lost the host (after the net layer's own retries): the rejoin record and the seat
      // token are kept (F5 and the online screen's 重新加入 still work) and the way back is offered (MP2-3)
      const rejoin = this.sessionKind === 'online' && this.session && !this.session.isHost && isReconnectable(e.code) ? loadRejoin() : null;
      this.leaveSession(true, !!rejoin);
      if (rejoin) {
        void this.confirm(msg, { title: t('error.title'), ok: t('online.rejoinCode', { code: rejoin.code }), cancel: t('over.toTitle') }).then((yes) => {
          // the online screen joins the saved room the normal way, in the room's own mode —
          // by itself now, or from its 重新加入 button later
          allowRejoin(yes);
          if (yes) this.go('online');
        });
        return;
      }
      // being kicked or the host closing the room is news, not a malfunction
      void this.alert(isNoticeCode(e.code) ? t('notice.title') : t('error.title'), msg);
    } else {
      this.toast(msg, 'error');
    }
  }

  private mountMatch(view: ViewSource): void {
    const s = this.session;
    if (!s) return;
    if (this.match && this.match.view === view) return;
    this.unmountMatch();
    const container = h('div', { class: 'sg-game' });
    this.gameLayer.appendChild(container);
    let handle: GameHandle;
    try {
      handle = this.deps.mountGame(container, view, s);
    } catch (err) {
      console.error('[ui] mountGame failed', err);
      container.remove();
      this.onViewFailed(err instanceof Error ? err.message : String(err));
      return;
    }
    const hud = new Hud(this, { view, handle, session: s });
    hud.setActive(this.screenId === 'match');
    this.hudLayer.appendChild(hud.el);
    // APP-3: the match clock waits for this view — a promise that settles once the
    // staged build reports 'ready' (or fails, or the match is unmounted first)
    let settle: () => void = () => undefined;
    const viewReady = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const match = { handle, hud, container, view, offLoad: () => undefined as void, settleLoad: settle };
    this.match = match;
    if (handle.onLoadProgress) {
      try {
        match.offLoad = handle.onLoadProgress((p) => {
          if (p.stage === 'ready' || p.stage === 'failed') match.settleLoad();
          this.onLoadProgress(p);
        });
      } catch (err) {
        console.error('[ui] onLoadProgress failed', err);
        settle();
      }
    } else settle();
    if (handle.isReady?.()) settle();
    try {
      (s as GameSession & { setLocalLoading?(ready: Promise<void>): void }).setLocalLoading?.(viewReady);
    } catch (err) {
      console.warn('[ui] setLocalLoading failed', err);
    }
  }

  private unmountMatch(): void {
    this.loadFailed = false;
    const m = this.match;
    if (!m) return;
    this.match = null;
    m.settleLoad();
    m.offLoad();
    this.setLoad(null);
    try {
      m.hud.dispose();
    } catch (err) {
      console.error('[ui] hud dispose failed', err);
    }
    m.hud.el.remove();
    this.portraits.release(m.hud.el);
    try {
      m.handle.dispose();
    } catch (err) {
      console.error('[ui] game dispose failed', err);
    }
    m.container.remove();
    clear(this.hudLayer);
  }

  // ── screens ───────────────────────────────────────────────────────────────

  private createScreen(id: ScreenId): Screen | null {
    const s = this.session;
    switch (id) {
      case 'title':
        return createTitleScreen(this, this.version);
      case 'single':
        return createSingleScreen(this);
      case 'online':
        return createOnlineScreen(this);
      case 'gallery':
        return createGalleryScreen(this);
      case 'help':
        return createHelpScreen(this);
      case 'lobby':
        return s ? createLobbyScreen(this, s) : null;
      case 'roles':
        return s ? createRolesScreen(this, s) : null;
      case 'heroSelect':
        return s ? createHeroSelectScreen(this, s) : null;
      case 'loading':
        return s ? createLoadingScreen(this, s) : null;
      case 'gameOver':
        return s ? createGameOverScreen(this, s, this.match?.view ?? s.view) : null;
      case 'match':
        return null;
    }
  }

  private hudLayerVisible(on: boolean): void {
    this.hudLayer.classList.toggle('sg-hidden', !on);
    if (this.match) this.match.hud.setActive(on && this.screenId === 'match');
  }

  private relabel(): void {
    this.root.dataset.lang = this.lang;
    this.root.lang = this.lang === 'en' ? 'en' : 'zh-CN';
    if (this.screen) {
      if (this.screen.relabel) this.screen.relabel();
      else {
        const id = this.screenId;
        this.screenId = null;
        if (id) this.go(id);
      }
    }
    if (this.settingsPanel?.relabel) this.settingsPanel.relabel();
    this.match?.hud.relabel();
  }

  private updateMusic(): void {
    let track: MusicTrack = 'menu';
    if (this.screenId === 'match') track = 'battle';
    else if (this.screenId === 'gameOver') {
      const won = this.didWin();
      track = won === null ? 'defeat' : won ? 'victory' : 'defeat';
    }
    if (track === this.music) return;
    this.music = track;
    if (!this.unlocked) return;
    try {
      this.deps.audio?.music(track);
    } catch (err) {
      console.warn('[ui] audio.music failed', err);
    }
  }

  private didWin(): boolean | null {
    const s = this.session;
    const res = s?.result;
    if (!s || !res) return null;
    const view = this.match?.view ?? s.view;
    const me = view?.localId() ?? view?.players().find((p) => p.playerId === s.myId)?.entityId;
    return me !== undefined && me !== null && res.winners.includes(me);
  }

  // ── global listeners ────────────────────────────────────────────────────────

  private installGlobalListeners(): void {
    const unlock = (): void => {
      if (this.unlocked) return;
      this.unlocked = true;
      const a = this.deps.audio;
      if (!a) return;
      a.unlock()
        .then(() => {
          const track = this.music;
          if (track !== undefined) a.music(track);
        })
        .catch((err: unknown) => console.warn('[ui] audio unlock failed', err));
    };
    this.bag.listen(this.root, 'pointerdown', unlock, { capture: true });
    this.bag.listen(this.root.ownerDocument, 'keydown', unlock, { capture: true });
    // Esc closes the settings modal wherever focus is
    this.bag.listen(this.root.ownerDocument, 'keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.settingsPanel) {
        ev.preventDefault();
        // the same Esc must not also toggle the in-match pause menu
        ev.stopImmediatePropagation();
        this.closeSettings();
      }
    });

    // delegated UI sounds
    this.bag.listen(this.root, 'click', (ev) => {
      const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.sg-btn, .sg-tab, .sg-seg > button, .sg-switch, .sg-hcard');
      if (!el || (el as HTMLButtonElement).disabled) return;
      const name = el.dataset.sfx as SfxName | 'none' | undefined;
      if (name === 'none') return;
      this.sfx(name ?? 'click');
    });
    this.bag.listen(this.root, 'pointerover', (ev) => {
      if ((ev as PointerEvent).pointerType === 'touch') return;
      const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.sg-btn, .sg-hcard, .sg-tab');
      if (!el) return;
      const rel = (ev as PointerEvent).relatedTarget as Node | null;
      if (rel && el.contains(rel)) return;
      const now = performance.now();
      if (now - this.lastHover < 70) return;
      this.lastHover = now;
      this.sfx('hover');
    });
  }

  dispose(): void {
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    this.menuArt?.dispose();
    this.closeSettings();
    this.leaveSession(false, true);
    if (this.screen) {
      this.screen.dispose();
      this.screen = null;
    }
    this.bag.dispose();
    try {
      this.deps.audio?.music(null);
    } catch {
      /* ignore */
    }
    this.root.remove();
  }
}

/** Mount the whole UI into `root`. The integration layer passes real deps; the dev harness passes mocks. */
export function mountApp(root: HTMLElement, deps: AppDeps, opts: MountAppOptions = {}): { dispose(): void } {
  const app = new App(root, deps, opts);
  return { dispose: () => app.dispose() };
}
