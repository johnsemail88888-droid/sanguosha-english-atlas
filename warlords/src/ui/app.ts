// App shell: owns the layer stack (3D game, HUD, screens, modals, toasts),
// routes screens from GameSession phases/events, and exposes the UiCtx that
// every screen uses. Public entry point: mountApp().
import type { GameEvent, HeroSelectView, MatchPhase, MatchSettings, Vec3 } from '../core/types';
import type { GameSession } from '../game/session';
import type { InputSink } from '../game/input-types';
import { defaultQuality, isSoftwareGpu, probeGpu, settings, type NetServerConfig, type Quality } from '../game/settings';
import type { ViewSource } from '../render/view';
import type { ScreenId, Screen, SettingsTab, UiCtx } from './ctx';
import { Bag, h, clear } from './dom';
import { getLang, t, tx } from './i18n';
import { applyRootVars, injectStyles } from './styles';
import { PortraitCache, button, portraitPrefetchPlan, type SfxName } from './widgets';
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
import { createPerfCheckPanel } from './screens/perfCheck';
import { Hud } from './hud/hud';
import { probeWebGL, type WebGLSupport } from './webgl';
import { clearRejoin, isReconnectable, loadRejoin, netFor, refreshRejoin, type RejoinInfo } from './invite';
import { desktopGpuSoftware } from './desktop';
import { AutoQualityController, autoPick, autoTuneNeeded } from './autoQuality';
import { perfVerdict, qualityName } from './perfcheck';

export type UiKey = 'scoreboard' | 'map' | 'chat' | 'menu' | 'quickchat';

export interface AppDeps {
  createLocalSession(name: string): GameSession;
  hostOnline(name: string, mode: 'peer' | 'ws'): Promise<GameSession>;
  joinOnline(code: string, name: string, mode: 'peer' | 'ws'): Promise<GameSession>;
  /** mount the 3D game for a ViewSource; returns a handle the UI uses during the match */
  mountGame(container: HTMLElement, view: ViewSource, session: GameSession): GameHandle;
  renderHeroPortrait(heroId: string, size?: number): Promise<string>;
  mountHeroTurntable?(container: HTMLElement, heroId: string): { dispose(): void };
  /** ~2 s GPU benchmark in its own offscreen context (render/bench.ts): median frame ms at 1280×720 and 640×360 (0: failed) */
  benchmarkGpu?(opts?: { durationMs?: number; signal?: { aborted: boolean } }): Promise<{ ms: number; msSmall: number; renderer: string; error?: string }>;
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
  /**
   * Optional (PLATFORM-4): a graphics-tier switch made mid-match is applied in stages by the
   * renderer — true until it has fully applied. `onQualityApplying` reports both edges and
   * returns the unsubscribe; it may only work once the view is ready (the App subscribes then).
   */
  qualityApplying?(): boolean;
  onQualityApplying?(cb: (applying: boolean) => void): () => void;
  /** Optional: live performance numbers of the 3D view (F3 panel); null before the view is built. */
  perf?(): PerfInfo | null;
}

/** The 3D view's live performance numbers (render/renderer.ts PerfSnapshot). */
export interface PerfInfo {
  fps: number;
  /** real time between two frames (ms, smoothed) */
  frameMs: number;
  /** main-thread time of a frame (ms, smoothed) */
  jsMs: number;
  /** GPU time of a frame (ms, smoothed; -1 / absent: the browser cannot measure it) */
  gpuMs?: number;
  drawCalls: number;
  triangles: number;
  /** render scale now, and its adaptive range on this tier */
  pixelRatio: number;
  pixelRatioMin: number;
  pixelRatioMax: number;
  quality: Quality;
  applying: boolean;
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
  /** override the GPU renderer string of the probe (dev harness: `?gpu=SwiftShader` previews the software-renderer warning) */
  gpu?: string;
  /**
   * Open 性能体检 by itself when a problem is found (a software renderer; the GPU fixed
   * since last time → ✅). Default: on, except in automated browsers (navigator.webdriver:
   * the e2e suites run on SwiftShader and would be greeted by it on every page).
   */
  autoPerfCheck?: boolean;
  /** open 性能体检 right after mounting (dev harness) */
  initialPerfCheck?: boolean;
  /**
   * 自动 quality: benchmark the GPU (first launch / a new GPU) and use its pick.
   * Default: on, except in automated browsers unless the URL has `autotune=1` (the
   * e2e suites run on SwiftShader: every fresh profile would drop to 极速).
   */
  autoTune?: boolean;
}

/** Menu screens with nothing else on the GPU: the benchmark may run there (hero select / gallery spin a 3D hero). */
const BENCH_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['title', 'single', 'online', 'lobby', 'roles', 'help']);

/** The view 自动 picks for: the window's CSS pixels and its devicePixelRatio. */
function viewSize(): { cssPixels: number; dpr: number } {
  const g = globalThis as { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number };
  return { cssPixels: (g.innerWidth || 1280) * (g.innerHeight || 720), dpr: g.devicePixelRatio || 1 };
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
  'replacedElsewhere',
  'relayLost',
]);
const FATAL_ERROR = /kick|host.?left|disconnect|lost|closed|full|version|not.?found|fail|timeout|refused|ended/i;

export function isFatalSessionError(code: string): boolean {
  return FATAL_CODES.has(code) || FATAL_ERROR.test(code);
}

/** Session endings that are news, not malfunctions: titled 提示 / Notice instead of 出错了. */
export function isNoticeCode(code: string): boolean {
  // replacedElsewhere: the same seat was opened in another window (a duplicated tab) — that one plays on
  return code === 'kicked' || code === 'hostLeft' || code === 'replacedElsewhere' || /kick|host.?left/i.test(code);
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
  private match: { handle: GameHandle; hud: Hud; container: HTMLElement; view: ViewSource; offLoad: () => void; settleLoad: () => void; offQuality: (() => void) | null } | null = null;
  /** a mid-match quality switch is being applied (「应用中…」): the HUD and the settings panel listen */
  private applyingQuality = false;
  private readonly applyingSubs = new Set<(on: boolean) => void>();
  /** lobby chat of the current online session: kept across matches (the lobby screen is rebuilt) */
  private lobbyChat: LobbyChatLog | null = null;
  /** connection of the current online session (host or guest) */
  private conn: { mode: 'peer' | 'ws'; net: NetServerConfig } | null = null;
  /**
   * How this tab joined the current online room as a guest: its rejoin record is saved
   * again from this (with a fresh age) on every (re)connect, a drop and a page unload, so
   * it never ages out while the session lives (pt3-online: a drop 40 min after the join
   * skipped 重新加入 and wiped the seat token).
   */
  private joined: Omit<RejoinInfo, 'at'> | null = null;
  private load: LoadProgress | null = null;
  private readonly loadSubs = new Set<(p: LoadProgress | null) => void>();
  private music: MusicTrack | undefined = undefined;
  private unlocked = false;
  private lastHover = 0;
  private roomCode: string | null;
  /** bumped by every join and by 取消 (online screen): a superseded join's session is left */
  private joinSeq = 0;
  private lang = getLang();
  readonly version: string;
  /** WebGL 2 is available (probed once at boot): without it no match can render */
  readonly webgl: WebGLSupport;
  /** the GPU the browser renders WebGL with (same probe; 重新检测 probes again) */
  gpu: { renderer: string; software: boolean };
  /** the harness pretends this GPU (never probes the real one) */
  private readonly gpuOverride: string | undefined;
  /** 性能体检 (modal) */
  private perfPanel: Screen | null = null;
  /** 性能体检 may open by itself (a problem found) */
  private readonly autoPerfCheckOn: boolean;
  /** 自动 quality may benchmark this GPU (MountAppOptions.autoTune) */
  private readonly autoTune: boolean;
  /** the GPU benchmark in progress (aborted when a match starts: it runs again on the next quiet menu) */
  private benchRun: { signal: { aborted: boolean }; done: Promise<void> } | null = null;
  private benchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 自动调节画质 during the current match */
  private adjust: { ctl: AutoQualityController; timer: ReturnType<typeof setInterval>; last: number } | null = null;
  private disposed = false;
  /** the 3D view of the current match failed to start (the failure modal is up) */
  private loadFailed = false;
  /** blurred key art behind the menu screens (dropped during a match to free the decoded image) */
  private menuArt: ArtBackdrop | null = null;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  /** the portraits of the heroes not on offer are fetched once (idle, after the offered ones) */
  private restPrefetch = false;

  constructor(
    host: HTMLElement,
    readonly deps: AppDeps,
    opts: MountAppOptions,
  ) {
    injectStyles(host.ownerDocument);
    this.version = opts.version ?? '0.1.0';
    this.webgl = opts.webgl === undefined ? probeWebGL(host.ownerDocument) : { ok: opts.webgl, reason: opts.webgl ? null : 'disabled (dev harness)' };
    if (!this.webgl.ok) console.warn('[ui] WebGL 2 unavailable:', this.webgl.reason);
    this.gpuOverride = opts.gpu;
    const renderer = opts.gpu ?? (opts.webgl === undefined ? probeGpu(host.ownerDocument).renderer : '');
    // (the desktop app also knows it from Chromium's GPU feature status)
    this.gpu = { renderer, software: isSoftwareGpu(renderer) || (opts.gpu === undefined && desktopGpuSoftware()) };
    if (this.gpu.software) console.info('[ui] WebGL runs on a software renderer:', renderer);
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
    this.autoPerfCheckOn = opts.autoPerfCheck ?? !navigatorIsAutomated();
    this.autoTune = opts.autoTune ?? (!navigatorIsAutomated() || urlFlag('autotune'));
    if (opts.initialPerfCheck) this.openPerfCheck();
    else if (this.autoPerfCheckOn) this.autoPerfCheck();
    // 自动: a software renderer needs no benchmark (极速 at once); hardware is measured on a quiet menu
    if (this.autoTune && this.gpu.software) void this.runBenchmark(false);
    else this.scheduleAutoTune();
  }

  /**
   * 性能体检 opens by itself (once per tab) when WebGL runs on a software renderer,
   * and once more on the first visit after that was fixed — to show the ✅.
   */
  private autoPerfCheck(): void {
    if (!this.webgl.ok || !this.gpu.renderer) return;
    const SOFT_KEY = 'sgwl.gpu.software';
    const SHOWN_KEY = 'sgwl.perfcheck.shown';
    let wasSoftware = false;
    let shown = false;
    try {
      wasSoftware = localStorage.getItem(SOFT_KEY) === '1';
      shown = sessionStorage.getItem(SHOWN_KEY) === '1';
      if (this.gpu.software) localStorage.setItem(SOFT_KEY, '1');
      else localStorage.removeItem(SOFT_KEY);
    } catch {
      /* storage blocked: shown on every load, like the warning */
    }
    const open = this.gpu.software ? !shown : wasSoftware;
    if (!open) return;
    try {
      sessionStorage.setItem(SHOWN_KEY, '1');
    } catch {
      /* ignore */
    }
    this.openPerfCheck();
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
    if (!this.perfPanel) this.match?.hud.setSettingsOpen(false);
  }

  openPerfCheck(): void {
    this.closePerfCheck();
    const panel = createPerfCheckPanel(this, () => this.closePerfCheck());
    this.perfPanel = panel;
    this.modalLayer.appendChild(panel.el);
    panel.el.querySelector<HTMLElement>('.sg-perfcheck')?.focus({ preventScroll: true });
    // a single-player match pauses behind it, like behind the settings
    this.match?.hud.setSettingsOpen(true);
  }

  private closePerfCheck(): void {
    if (!this.perfPanel) return;
    this.perfPanel.dispose();
    this.perfPanel.el.remove();
    this.perfPanel = null;
    if (!this.settingsPanel) this.match?.hud.setSettingsOpen(false);
  }

  /** 重新检测: probe the GPU again (the harness keeps its pretend GPU) and benchmark it (a software renderer: nothing to measure). */
  async recheckGpu(): Promise<void> {
    if (this.gpuOverride === undefined && this.webgl.ok) {
      const g = probeGpu(this.root.ownerDocument, true);
      this.gpu = { renderer: g.renderer, software: isSoftwareGpu(g.renderer) || desktopGpuSoftware() };
    }
    await this.runBenchmark(true);
  }

  autoTuning(): boolean {
    return !!this.benchRun;
  }

  // ── 自动 quality ────────────────────────────────────────────────────────────

  /** Benchmark this GPU on the next quiet menu, when 自动 needs it (first launch, a new GPU). */
  private scheduleAutoTune(delayMs = 1500): void {
    if (!this.autoTune || !this.webgl.ok || this.benchRun || this.benchTimer !== null || this.disposed) return;
    if (!autoTuneNeeded(settings.get(), this.gpu)) return;
    this.benchTimer = setTimeout(() => {
      this.benchTimer = null;
      // a match / a 3D screen came first: the next quiet menu schedules it again (go())
      if (this.match || !this.screenId || !BENCH_SCREENS.has(this.screenId)) return;
      void this.runBenchmark(false);
    }, delayMs);
  }

  /**
   * Measure this GPU (render/bench.ts, ~2 s offscreen; a software renderer needs no
   * measuring) and keep the result; on 自动 its pick becomes the tier. `asked`:
   * 重新检测 — whatever is stored, and even in a match (the player asked).
   */
  private runBenchmark(asked: boolean): Promise<void> {
    if (this.benchRun) return this.benchRun.done;
    const gpu = { ...this.gpu };
    if (!this.webgl.ok || !gpu.renderer || (!asked && !autoTuneNeeded(settings.get(), gpu))) return Promise.resolve();
    if (gpu.software) {
      this.storeBench(gpu, 0, 0, asked);
      return Promise.resolve();
    }
    const bench = this.deps.benchmarkGpu;
    if (!bench) return Promise.resolve();
    const signal = { aborted: false };
    const done = (async (): Promise<void> => {
      let r: { ms: number; msSmall: number; error?: string };
      try {
        r = await bench({ durationMs: 2000, signal });
      } catch (err) {
        r = { ms: 0, msSmall: 0, error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (this.benchRun?.signal === signal) this.benchRun = null;
      }
      // a match started meanwhile: measured again on the next quiet menu
      if (signal.aborted || this.disposed) return;
      if (!(r.ms > 0)) console.warn('[ui] GPU benchmark did not run:', r.error);
      else console.info(`[ui] GPU benchmark: ${r.ms.toFixed(2)} ms @ 1280×720, ${r.msSmall.toFixed(2)} ms @ 640×360 (${gpu.renderer})`);
      this.storeBench(gpu, r.ms > 0 ? r.ms : 0, r.ms > 0 ? r.msSmall : 0, asked);
    })();
    this.benchRun = { signal, done };
    this.refreshPanels();
    return done;
  }

  private storeBench(gpu: { renderer: string; software: boolean }, ms: number, msSmall: number, asked: boolean): void {
    settings.update({ gpuBench: { gpu: gpu.renderer, ms, msSmall, at: Date.now() } });
    this.applyAutoQuality(true);
    this.refreshPanels();
    // a slow machine: 性能体检 says so (once per benchmark — it runs once per GPU)
    if (asked || !this.autoPerfCheckOn || this.perfPanel || this.match) return;
    const pick = autoPick(settings.get(), gpu, viewSize(), defaultQuality());
    if (perfVerdict({ webgl2: this.webgl.ok, renderer: gpu.renderer, pick }).kind === 'slow') this.openPerfCheck();
  }

  /** 自动: the benchmark's pick becomes the tier and the render-scale cap (a toast when the tier changes). */
  private applyAutoQuality(toast: boolean): void {
    const s = settings.get();
    if (!s.qualityAuto) return;
    const pick = autoPick(s, this.gpu, viewSize(), defaultQuality());
    if (!pick) return;
    const changed = pick.quality !== s.quality;
    if (changed || pick.maxPixelRatio !== s.autoRenderScale) settings.update({ quality: pick.quality, autoRenderScale: pick.maxPixelRatio });
    this.adjust?.ctl.setTier(pick.quality, pick.quality);
    if (changed && toast) {
      const name = qualityName(pick.quality);
      this.toast(tx(`已按显卡自动设置画质：${name}（可在设置中更改）`, `Graphics quality set for your GPU: ${name} (change it in Settings)`));
    }
  }

  setQualityAuto(): void {
    settings.update({ qualityAuto: true });
    if (autoTuneNeeded(settings.get(), this.gpu)) {
      // (in a match: after it — the benchmark would take the GPU from the fight)
      if (!this.match) void this.runBenchmark(false);
    } else this.applyAutoQuality(false);
  }

  /** The settings / 性能体检 panels show the benchmark's state: redraw them. */
  private refreshPanels(): void {
    this.settingsPanel?.relabel?.();
  }

  // ── 自动调节画质 (in a match) ────────────────────────────────────────────────

  /** The richest tier a step up may reach on 自动 (the benchmark's pick; null: none known — no steps up). */
  private autoCeiling(): Quality | null {
    const s = settings.get();
    return s.qualityAuto ? (autoPick(s, this.gpu, viewSize(), defaultQuality())?.quality ?? null) : null;
  }

  private startAutoAdjust(): void {
    this.stopAutoAdjust();
    const m = this.match;
    if (!m?.handle.perf) return;
    const ctl = new AutoQualityController(settings.get().quality, this.autoCeiling());
    this.adjust = { ctl, timer: setInterval(() => this.tickAutoAdjust(), 500), last: performance.now() };
  }

  private stopAutoAdjust(): void {
    if (!this.adjust) return;
    clearInterval(this.adjust.timer);
    this.adjust = null;
  }

  private tickAutoAdjust(): void {
    const m = this.match;
    const a = this.adjust;
    if (!m || !a) return;
    const now = performance.now();
    const dt = (now - a.last) / 1000;
    a.last = now;
    const s = settings.get();
    if (!s.autoAdjust) return;
    let p: PerfInfo | null = null;
    try {
      p = m.handle.perf?.() ?? null;
    } catch {
      p = null;
    }
    if (!p) return;
    // the player picked another tier (or turned 自动 on / off) meanwhile
    if (s.quality !== a.ctl.tier) a.ctl.setTier(s.quality, this.autoCeiling());
    const paused = m.hud.pauseRequested;
    const hidden = this.root.ownerDocument.visibilityState === 'hidden';
    const active = this.screenId === 'match' && this.matchReady() && !paused && !hidden && !this.applyingQuality && !p.applying;
    const step = a.ctl.update({ dt, fps: p.fps, frameMs: p.frameMs, jsMs: p.jsMs, gpuMs: p.gpuMs ?? -1, active, resAtFloor: p.pixelRatio <= p.pixelRatioMin + 0.01 });
    if (step) {
      console.info(`[ui] 自动调节画质: ${p.fps} fps → ${step.to}`);
      settings.update({ quality: step.to });
      this.toast(tx('画面较卡，已自动调低画质（可在设置中改回）', 'The game is lagging: graphics quality lowered (you can change it back in Settings)'));
    }
    // a step up waits for a single-player pause (the sim waits for the switch there)
    if (a.ctl.pendingUp && paused && this.sessionKind === 'single') this.applyUp(a.ctl.takeUp());
  }

  /** A step up 自动调节画质 made ready: applied at a pause or after the match. */
  private applyUp(up: Quality | null): void {
    const s = settings.get();
    if (!up || !s.qualityAuto || !s.autoAdjust || up === s.quality) return;
    console.info(`[ui] 自动调节画质: headroom → ${up}`);
    settings.update({ quality: up });
    this.toast(tx(`画面流畅，已自动提高画质：${qualityName(up)}`, `Running smoothly: graphics quality raised to ${qualityName(up)}`));
  }

  loadProgress(cb: (p: LoadProgress | null) => void): () => void {
    this.loadSubs.add(cb);
    cb(this.load);
    return () => this.loadSubs.delete(cb);
  }

  /** `cb` now and on every change: a mid-match quality switch is being applied (「应用中…」). */
  qualityApplying(cb: (on: boolean) => void): () => void {
    this.applyingSubs.add(cb);
    cb(this.applyingQuality);
    return () => this.applyingSubs.delete(cb);
  }

  private setQualityApplying(on: boolean): void {
    if (on === this.applyingQuality) return;
    this.applyingQuality = on;
    for (const cb of [...this.applyingSubs]) {
      try {
        cb(on);
      } catch (err) {
        console.error('[ui] quality subscriber failed', err);
      }
    }
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
    // the GPU benchmark only runs on quiet menus: a 3D screen stops it, a quiet one may start it
    if (!BENCH_SCREENS.has(id)) {
      if (this.benchRun) this.benchRun.signal.aborted = true;
    } else this.scheduleAutoTune();
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

  /**
   * PLATFORM-12: warm the HTTP cache with the portraits hero select shows — offered, then picked —
   * at once (again as picks come in), and every other hero's only once those have arrived and the
   * browser is idle (they are for the gallery / later matches).
   */
  private prefetchPortraits(v: HeroSelectView): void {
    const plan = portraitPrefetchPlan([...v.options, ...Object.values(v.picks)], HEROES.map((x) => x.id));
    // a free pick offers all of them: no point asking for 30 files at high priority
    const shown = this.portraits.prefetch(plan.first, plan.first.length <= 8 ? 'high' : 'auto');
    if (this.restPrefetch) return;
    this.restPrefetch = true;
    void shown.then(() => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      const rest = (): void => {
        this.prefetchTimer = null;
        void this.portraits.prefetch(plan.rest, 'low');
      };
      if (ric) ric(rest, { timeout: 4000 });
      else this.prefetchTimer = setTimeout(rest, 1500);
    });
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
    const mine = ++this.joinSeq;
    const s = await this.deps.joinOnline(code, this.playerName(), mode);
    // 取消 (or a newer attempt) came first: nobody wants this seat any more
    if (mine !== this.joinSeq) {
      s.leave();
      return;
    }
    if (!this.adoptOnline(s)) return;
    const net = { ...settings.get().net };
    this.conn = { mode, net };
    // F5 in the lobby or mid-match rejoins this room the same way (see screens/online.ts)
    this.joined = { code: (s.lobby?.roomCode || code).toUpperCase(), mode, net: netFor(mode, net) };
    this.touchRejoin();
  }

  cancelJoin(): void {
    this.joinSeq++;
  }

  /**
   * An online guest's rejoin record, saved again with a fresh age (null: no guest session
   * joined from this tab — then the stored record, if still young). See `joined`.
   */
  private touchRejoin(): RejoinInfo | null {
    const guest = this.sessionKind === 'online' && !!this.session && !this.session.isHost;
    return refreshRejoin(guest ? this.joined : null);
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
    // F5 / a drop: the record is kept, dated now (it must not age out under a live session)
    if (keepRejoin) this.touchRejoin();
    else clearRejoin();
    this.joined = null;
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
    if (s.heroSelect) this.prefetchPortraits(s.heroSelect);
    this.lastPhase = s.phase;
    this.pickedHero = s.heroSelect?.picks[mySeat(s)] ?? null;
    const bag = new Bag();
    this.sessionBag = bag;
    if (kind === 'online') {
      this.lobbyChat = new LobbyChatLog(s);
      // every (re)connect and phase change dates the guest's rejoin record afresh
      const touch = (): void => {
        if (this.joined) this.touchRejoin();
      };
      bag.add(s.on('lobby', touch));
      bag.add(s.on('phase', touch));
    }
    bag.add(
      s.on('heroSelect', (v) => {
        const hero = v.picks[mySeat(s)];
        if (hero) this.pickedHero = hero;
        // the offered heroes' ability emblems: the detail panel shows them without a blank wait
        prefetchArt(heroAbilityArt(v.options));
        this.prefetchPortraits(v);
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
      // (dated afresh: the record set at the join may be older than REJOIN_MAX_AGE_MS by now)
      const rejoin = this.sessionKind === 'online' && this.session && !this.session.isHost && isReconnectable(e.code) ? this.touchRejoin() : null;
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
    // the match's own build needs the GPU: no benchmark now (again on the next quiet menu)
    if (this.benchRun) this.benchRun.signal.aborted = true;
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
    const match = { handle, hud, container, view, offLoad: () => undefined as void, settleLoad: settle, offQuality: null as (() => void) | null };
    this.match = match;
    // 自动调节画质 watches this match's frame rate (its warm-up counts from the first frames on screen)
    this.startAutoAdjust();
    // the renderer's staged quality switch (PLATFORM-4): only once the view is built (before that a switch applies at once)
    const watchQuality = (): void => {
      if (match.offQuality || !handle.onQualityApplying || this.match !== match) return;
      try {
        match.offQuality = handle.onQualityApplying((on) => {
          if (this.match === match) this.setQualityApplying(on);
        });
        if (handle.qualityApplying?.()) this.setQualityApplying(true);
      } catch (err) {
        console.warn('[ui] onQualityApplying failed', err);
      }
    };
    if (handle.onLoadProgress) {
      try {
        match.offLoad = handle.onLoadProgress((p) => {
          if (p.stage === 'ready' || p.stage === 'failed') match.settleLoad();
          if (p.stage === 'ready') watchQuality();
          this.onLoadProgress(p);
        });
      } catch (err) {
        console.error('[ui] onLoadProgress failed', err);
        settle();
      }
    } else settle();
    if (handle.isReady?.() || !handle.onLoadProgress) {
      settle();
      watchQuality();
    }
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
    // a step up the match earned applies to the next one (its renderer builds at that tier)
    const up = this.adjust?.ctl.takeUp() ?? null;
    this.stopAutoAdjust();
    m.settleLoad();
    m.offLoad();
    m.offQuality?.();
    this.setQualityApplying(false);
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
    this.applyUp(up);
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
    if (this.perfPanel?.relabel) this.perfPanel.relabel();
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
      if (ev.key === 'Escape' && (this.settingsPanel || this.perfPanel)) {
        ev.preventDefault();
        // the same Esc must not also toggle the in-match pause menu
        ev.stopImmediatePropagation();
        // 性能体检 opened from the settings sits on top of them: it closes first
        if (this.perfPanel) this.closePerfCheck();
        else this.closeSettings();
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
    this.disposed = true;
    if (this.benchTimer !== null) clearTimeout(this.benchTimer);
    if (this.benchRun) this.benchRun.signal.aborted = true;
    this.stopAutoAdjust();
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    this.menuArt?.dispose();
    this.closeSettings();
    this.closePerfCheck();
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

/** `?name=1` in the page URL (test switches). */
function urlFlag(name: string): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(name) === '1';
  } catch {
    return false;
  }
}

/** An automated browser (WebDriver / Playwright): no unasked-for dialogs over the page. */
function navigatorIsAutomated(): boolean {
  try {
    return !!(globalThis.navigator as { webdriver?: boolean } | undefined)?.webdriver;
  } catch {
    return false;
  }
}
