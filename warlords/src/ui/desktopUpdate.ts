// Desktop app updates, page side: the title screen's chip (「新版本已下载 · 重启并更新」 /
// 「有新版本 build N · 下载」), 设置 → 通用 → 关于, the build number next to the version, and
// telling the app when a match is on. The app side is electron/updater.cjs, reached through the
// preload's window.sgwlDesktop.update; in a browser there is nothing to update (a reload is the
// newest build) and all of this stays out of the way.
//
// Never nags: the chip shows on the title screen only (never in a match), at most on one launch
// per 24 h, and ✕ hides it for the rest of the launch. The setup build / AppImage install a
// downloaded update on quit anyway, so ignoring the chip is fine.
import type { ScreenId } from './ctx';
import { h } from './dom';
import { t } from './i18n';
import { button } from './widgets';

export type UpdateKind = 'nsis' | 'appimage' | 'portable' | 'mac' | 'linux' | 'none';
export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';

/** electron/updater.cjs's state (crosses the preload bridge: cleaned by cleanUpdateState) */
export interface UpdateState {
  kind: UpdateKind;
  /** electron-updater downloads and installs by itself (setup build, AppImage) */
  auto: boolean;
  /** this app's version */
  current: string;
  status: UpdateStatus;
  /** the newer version found */
  version?: string;
  /** download progress (auto) */
  percent?: number;
  /** manual: what 下载 opens */
  url?: string;
  /** portable: the setup build (it updates itself) */
  setupUrl?: string;
}

interface UpdateBridge {
  onState?(cb: (st: unknown) => void): unknown;
  download?(which?: 'setup'): void;
  restart?(): void;
  check?(): void;
  playing?(on: boolean): void;
}

type DesktopGlobal = { sgwlDesktop?: { isDesktop?: boolean; version?: unknown; update?: UpdateBridge } };

function desktop(): DesktopGlobal['sgwlDesktop'] | null {
  const d = (globalThis as DesktopGlobal).sgwlDesktop;
  return d && d.isDesktop ? d : null;
}

function bridge(): UpdateBridge | null {
  const u = desktop()?.update;
  return u && typeof u === 'object' ? u : null;
}

/** The desktop app's version (0.1.<build> for a release build); null in a browser or an older app. */
export function desktopVersion(): string | null {
  const v = desktop()?.version;
  return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

/** 0.1.42 → 42 (a release build: warlords-desktop.yml's run number); null for 0.1.0 or junk. */
export function buildNumber(version: string | null | undefined): number | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  const n = m ? Number(m[3]) : 0;
  return n > 0 ? n : null;
}

/** How the title / 关于 show a version: "0.1.42 · build 42"; the version alone without a build. */
export function versionText(version: string): string {
  const n = buildNumber(version);
  return n == null ? version : `${version} · build ${n}`;
}

const KINDS: readonly UpdateKind[] = ['nsis', 'appimage', 'portable', 'mac', 'linux', 'none'];
const STATUSES: readonly UpdateStatus[] = ['idle', 'checking', 'latest', 'available', 'downloading', 'ready', 'error'];
const httpsUrl = (v: unknown): string | undefined => (typeof v === 'string' && /^https:\/\//.test(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Only a well-formed state survives the bridge (links: https only). */
export function cleanUpdateState(v: unknown): UpdateState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = KINDS.find((k) => k === o.kind);
  const status = STATUSES.find((s) => s === o.status);
  if (!kind || !status || typeof o.current !== 'string') return null;
  const st: UpdateState = { kind, status, auto: o.auto === true, current: o.current };
  const version = str(o.version);
  if (version) st.version = version;
  if (typeof o.percent === 'number' && Number.isFinite(o.percent)) st.percent = Math.max(0, Math.min(100, Math.round(o.percent)));
  const url = httpsUrl(o.url);
  if (url) st.url = url;
  const setupUrl = httpsUrl(o.setupUrl);
  if (setupUrl) st.setupUrl = setupUrl;
  return st;
}

// ── the app's state, shared by every screen ──────────────────────────────────

let current: UpdateState | null = null;
const subs = new Set<(st: UpdateState | null) => void>();
let hooked = false;

function hook(): void {
  if (hooked) return;
  const b = bridge();
  if (!b || typeof b.onState !== 'function') return;
  hooked = true;
  try {
    b.onState((raw) => {
      const st = cleanUpdateState(raw);
      if (!st) return;
      current = st;
      for (const cb of [...subs]) cb(st);
    });
  } catch (err) {
    console.warn('[update] the app did not answer', err);
  }
}

/** The update state now (null: a browser, or the app has not said yet). */
export function updateState(): UpdateState | null {
  hook();
  return current;
}

/** `cb` now and on every change; returns the unsubscribe. */
export function onUpdateState(cb: (st: UpdateState | null) => void): () => void {
  hook();
  subs.add(cb);
  cb(current);
  return () => void subs.delete(cb);
}

export type UpdateAction = 'download' | 'setup' | 'restart' | 'check';

/** 下载 (the file / the background download), 安装版 (portable → setup build), 重启并更新, 检查更新. */
export function updateAction(action: UpdateAction): void {
  const b = bridge();
  if (!b) return;
  try {
    if (action === 'restart') b.restart?.();
    else if (action === 'check') b.check?.();
    else b.download?.(action === 'setup' ? 'setup' : undefined);
  } catch (err) {
    console.warn('[update] action failed', action, err);
  }
}

// ── a match is on: the app's checks, downloads and restarts wait ─────────────

const MATCH_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['heroSelect', 'loading', 'match']);

/** hero select → the match: an update download must not eat the match's bandwidth, a restart must not end it. */
export const isMatchScreen = (id: ScreenId): boolean => MATCH_SCREENS.has(id);

let playing = false;
let told: boolean | null = null;

/** The App's screen changed (App.go): tell the app when a match starts or ends. */
export function reportScreen(id: ScreenId): void {
  playing = isMatchScreen(id);
  if (told === playing) return;
  const b = bridge();
  if (!b || typeof b.playing !== 'function') return;
  told = playing;
  try {
    b.playing(playing);
  } catch {
    /* an older app: nothing waits */
  }
}

// ── the title chip ───────────────────────────────────────────────────────────

/** A launch that showed the chip keeps it quiet on other launches for this long. */
export const NAG_EVERY_MS = 24 * 60 * 60 * 1000;
const MEMO_KEY = 'sgwl.desktop.updateChip';

/** When the chip was last offered (localStorage, mirrored by the app with the other settings). */
export interface ChipMemo {
  at: number;
  version: string;
}

/** This launch (page load): the chip was shown / closed with ✕. */
export interface ChipSession {
  shown: boolean;
  dismissed: boolean;
  /** a join failed on a version mismatch: the update is needed now — show it whatever the throttle says */
  urgent?: boolean;
}

/** What the chip offers: a downloaded update (重启并更新) or a new build to download (下载); null: nothing. */
export function chipOffer(st: UpdateState | null): 'restart' | 'download' | null {
  if (!st || !st.version) return null;
  if (st.status === 'ready' && st.auto) return 'restart';
  if (st.status === 'available' && !st.auto) return 'download';
  return null;
}

/** Show the chip now? Once shown it stays for the launch (until ✕); a launch within 24 h of the last offer stays quiet. */
export function chipVisible(st: UpdateState | null, memo: ChipMemo | null, session: ChipSession, now: number): boolean {
  if (!chipOffer(st)) return false;
  if (session.urgent) return true;
  if (session.dismissed) return false;
  if (session.shown) return true;
  if (!memo) return true;
  const age = now - memo.at;
  return !(age >= 0 && age < NAG_EVERY_MS);
}

export function loadChipMemo(store: Pick<Storage, 'getItem'> | null = localStore()): ChipMemo | null {
  try {
    const v = JSON.parse(store?.getItem(MEMO_KEY) ?? 'null') as Partial<ChipMemo> | null;
    return v && typeof v.at === 'number' && Number.isFinite(v.at) ? { at: v.at, version: String(v.version ?? '') } : null;
  } catch {
    return null;
  }
}

export function saveChipMemo(memo: ChipMemo, store: Pick<Storage, 'setItem'> | null = localStore()): void {
  try {
    store?.setItem(MEMO_KEY, JSON.stringify(memo));
  } catch {
    /* storage blocked: it may show again next launch */
  }
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const session: ChipSession = { shown: false, dismissed: false };

/** "build 42" (or the version when it has no build number) */
const buildLabel = (version: string | undefined): string => {
  const n = buildNumber(version);
  return n == null ? (version ?? '') : String(n);
};

/**
 * The title screen's update chip: hidden unless there is something to offer (desktop app only).
 * `refresh()` re-renders it (language change); `dispose()` stops listening.
 */
export function createUpdateChip(): { el: HTMLElement; refresh(): void; dispose(): void } {
  const el = h('div', { class: 'sg-update-chip title sg-hidden', role: 'status', aria: { live: 'polite' } });
  if (!bridge()) return { el, refresh: () => undefined, dispose: () => undefined };
  ensureStyles(el.ownerDocument);
  let st: UpdateState | null = null;
  const render = (): void => {
    const now = Date.now();
    const visible = chipVisible(st, session.shown ? null : loadChipMemo(), session, now);
    el.classList.toggle('sg-hidden', !visible);
    const offer = chipOffer(st);
    if (!visible || !st || !offer) {
      el.replaceChildren();
      return;
    }
    if (!session.shown) {
      session.shown = true;
      saveChipMemo({ at: now, version: st.version ?? '' });
    }
    const n = buildLabel(st.version);
    const parts: (HTMLElement | null)[] = [
      h('span', { class: 'msg' }, offer === 'restart' ? t('update.ready', { n }) : t('update.available', { n })),
      button(offer === 'restart' ? t('update.restart') : t('update.download'), () => updateAction(offer === 'restart' ? 'restart' : 'download'), {
        cls: 'small gold go',
        sfx: 'confirm',
        title: st.kind === 'mac' ? t('update.macHint') : undefined,
      }),
      // the portable exe: the setup build updates itself from then on
      st.kind === 'portable' && st.setupUrl ? button(t('update.setup'), () => updateAction('setup'), { cls: 'small ghost setup', title: t('update.setupHint') }) : null,
      button('✕', () => {
        session.dismissed = true;
        render();
      }, { cls: 'icon small ghost x', title: t('update.later'), sfx: 'back' }),
    ];
    el.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  };
  const off = onUpdateState((s) => {
    st = s;
    render();
  });
  return { el, refresh: render, dispose: off };
}

/**
 * A join failed because the other side runs another game version (versionMismatch): in the
 * desktop app, check for the update now and bring the chip back. Returns the hint the error
 * message adds (null in a browser: reloading the page is the fix there, the message says so).
 */
export function versionMismatchHint(): string | null {
  if (!bridge()) return null;
  session.urgent = true;
  updateAction('check');
  return t('update.mismatch');
}

// ── 设置 → 通用 → 关于 ─────────────────────────────────────────────────────────

/** The status line + action of 关于 (pure: the tests read it). */
export function aboutLine(st: UpdateState | null, inMatch: boolean): { text: string; action: UpdateAction | null; label?: string } {
  if (!st) return { text: t('update.web'), action: null };
  if (st.kind === 'none') return { text: t('update.dev'), action: null };
  const n = buildLabel(st.version);
  switch (st.status) {
    case 'ready':
      return inMatch ? { text: t('update.readyQuit', { n }), action: null } : { text: t('update.ready', { n }), action: 'restart', label: t('update.restart') };
    case 'available':
      return st.auto ? { text: t('update.downloading', { n }), action: null } : { text: t('update.available', { n }), action: 'download', label: t('update.download') };
    case 'downloading':
      return { text: `${t('update.downloading', { n })}${st.percent ? ` ${st.percent}%` : ''}`, action: null };
    case 'checking':
      return { text: t('update.checking'), action: null };
    case 'latest':
      return { text: t('update.latest'), action: 'check', label: t('update.check') };
    case 'error':
      return { text: t('update.failed'), action: 'check', label: t('update.check') };
    default:
      return { text: '', action: 'check', label: t('update.check') };
  }
}

/** 关于: 版本 0.1.42 · build 42 — 已是最新 / 有新版本 · 下载 / 重启并更新. `version`: the page's version (a browser's is its build's). */
export function createAboutBox(version: string): { el: HTMLElement; dispose(): void } {
  const el = h('div', { class: 'set-about' });
  ensureStyles(el.ownerDocument);
  // the offline single file (file://) never updates: its version, nothing more
  const offlineFile = globalThis.location?.protocol === 'file:';
  const render = (st: UpdateState | null): void => {
    const line = !st && offlineFile ? { text: '', action: null } : aboutLine(st, playing);
    el.replaceChildren(
      h('div', { class: 'ver' }, h('b', null, versionText(st?.current || desktopVersion() || version))),
      h('div', { class: `upd ${st?.status ?? 'web'}` },
        line.text ? h('span', null, line.text) : null,
        line.action && line.label
          ? button(line.label, () => updateAction(line.action!), { cls: `small ${line.action === 'check' ? 'dark' : 'gold'}`, title: line.action === 'download' && st?.kind === 'mac' ? t('update.macHint') : undefined })
          : null,
        st?.kind === 'portable' && st.status === 'available' && st.setupUrl ? button(t('update.setup'), () => updateAction('setup'), { cls: 'small dark', title: t('update.setupHint') }) : null,
      ),
    );
  };
  if (!bridge()) {
    render(null);
    return { el, dispose: () => undefined };
  }
  return { el, dispose: onUpdateState(render) };
}

// ── styles (kept here: only the desktop app and 关于 use them) ─────────────────

const STYLE_ID = 'sgwl-update-styles';
const UPDATE_CSS = /* css */ `
.sg-update-chip { display: inline-flex; align-items: center; gap: 0.45em; max-width: min(34em, calc(100vw - 2em)); padding: 0.2em 0.3em 0.2em 0.85em; border: 1px solid rgba(214, 173, 82, 0.75); border-radius: 999px; background: rgba(12, 8, 4, 0.8); color: var(--paper, #f3e6c8); font: 700 0.86em/1.25 var(--font-body, sans-serif); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); text-shadow: none; pointer-events: auto; }
.sg-update-chip .msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-update-chip .sg-btn.small { font-size: 0.95em; min-height: 1.8em; padding: 0.15em 0.75em; }
.sg-update-chip .sg-btn.icon { width: 1.9em; min-width: 1.9em; border: 0; background: transparent; }
/* title: the top-left corner (the GPU chip and the language button hold the top-right) */
.sg-update-chip.title { position: absolute; top: 1em; left: 1em; z-index: 3; }
@media (max-height: 520px) { .sg-update-chip { font-size: 0.72em; } .sg-update-chip.title { top: 0.5em; left: 0.5em; } .sg-update-chip .setup { display: none; } }
.set-about { display: flex; flex-direction: column; gap: 0.3em; }
.set-about .upd { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5em; opacity: 0.85; }
.set-about .upd.available span, .set-about .upd.ready span { font-weight: 700; opacity: 1; }
`;

function ensureStyles(doc: Document | null | undefined): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = UPDATE_CSS;
  doc.head?.appendChild(style);
}

/** Tests: forget the app's state, this launch's chip and the reported match state. */
export function resetDesktopUpdateForTests(): void {
  current = null;
  subs.clear();
  hooked = false;
  playing = false;
  told = null;
  session.shown = false;
  session.dismissed = false;
  session.urgent = false;
}
