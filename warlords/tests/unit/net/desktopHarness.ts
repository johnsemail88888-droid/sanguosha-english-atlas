// electron/main.cjs and preload.cjs against a stubbed 'electron' module: an app launch with its
// embedded server, its IPC handlers and its window (what it loads, the webContents events it
// listens to), and the preload run for a page on some origin. Nothing here reaches the network:
// the stubbed net.fetch answers what a test says (by default: offline).
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const ELECTRON_DIR = path.resolve(__dirname, '../../../electron');
const SERVER_DIR = path.resolve(ELECTRON_DIR, '../server');

/** What Electron passes an IPC handler: the sender (webContents) and its frame. */
export interface IpcEvent {
  returnValue?: unknown;
  sender?: unknown;
  senderFrame?: { origin?: string; url?: string; parent?: unknown } | null;
}
type Handler = (ev: IpcEvent, ...a: unknown[]) => unknown;
type Listener = (...a: unknown[]) => unknown;

export interface FetchAnswer {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface Launch {
  /** the app's userData folder (desktop.json, web-storage.json) */
  userData: string;
  /** the first URL the window loaded */
  url: string;
  /** every URL the window loaded, in order */
  loads: string[];
  /** resolves with loads[n] once there is one */
  load(n: number): Promise<string>;
  /** ipcMain.on handlers by channel */
  ipc: Record<string, Handler>;
  /** ipcMain.handle handlers by channel */
  handle: Record<string, Handler>;
  /** app events the main process listens to (e.g. 'gpu-info-update') */
  on: Record<string, () => unknown>;
  /** what app.getGPUFeatureStatus() answers */
  gpu: Record<string, string>;
  /** the window's webContents (IPC from the page comes from it) and its listeners */
  wc: { listeners: Record<string, Listener[]>; emit(ev: string, ...a: unknown[]): unknown[] };
  /** webPreferences of the window */
  prefs: Record<string, unknown>;
  /** the permission request / check handlers set on the session */
  permissions: { request?: Listener; check?: Listener };
  /** the window-open handler */
  openHandler?: (d: { url: string }) => unknown;
  /** URLs shell.openExternal was asked to open */
  opened: string[];
  /** what the stubbed net.fetch was asked for */
  fetched: string[];
  /** console lines the main process printed ([desktop] …) */
  logs: string[];
  /** the application menu's template (Menu.setApplicationMenu) */
  menu: MenuItem[];
  /** every dialog.showMessageBox the main process opened, in order */
  dialogs: Record<string, unknown>[];
  /** what the next dialogs answer (their button index; default: the dialog's cancelId, else 0) */
  answers: number[];
  /** session.defaultSession.on listeners (e.g. 'will-download') */
  sessionOn: Record<string, Listener[]>;
  quit(): Promise<void>;
}

export interface MenuItem {
  label?: string;
  submenu?: MenuItem[];
  click?: (...a: unknown[]) => unknown;
}

/** The menu item labelled `label` (any depth). */
export function menuItem(items: MenuItem[], label: string): MenuItem | null {
  for (const it of items) {
    if (it.label === label) return it;
    const sub = it.submenu ? menuItem(it.submenu, label) : null;
    if (sub) return sub;
  }
  return null;
}

export interface LaunchOptions {
  /** a packaged app in this folder (dist/ with sgwl-build.json …; server/ is linked in); default: the dev tree */
  appDir?: string;
  /** the stubbed net.fetch (default: always offline) */
  fetch?: (url: string, init?: unknown) => Promise<FetchAnswer>;
  env?: Record<string, string>;
}

/** A packaged-app folder: dist/ (an index page + sgwl-build.json with `build` — none for null / undefined) and a link to the real server/. */
export function appFolder(root: string, build: unknown): string {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<!doctype html><title>t</title>');
  if (build !== undefined && build !== null) fs.writeFileSync(path.join(root, 'dist', 'sgwl-build.json'), typeof build === 'string' ? build : JSON.stringify(build));
  fs.symlinkSync(SERVER_DIR, path.join(root, 'server'), 'dir');
  return root;
}

/** Load electron/main.cjs as a fresh app launch with userData in `userData`; resolves once the window loads its first URL. */
export async function launch(userData: string, opts: LaunchOptions = {}): Promise<Launch> {
  const ipc: Launch['ipc'] = {};
  const handle: Launch['handle'] = {};
  const on: Record<string, () => unknown> = {};
  // before the GPU process has reported, Chromium answers this placeholder for everything
  const gpu: Record<string, string> = { webgl: 'disabled_off', gpu_compositing: 'disabled_software' };
  const loads: string[] = [];
  const waiters: { n: number; done: (url: string) => void }[] = [];
  const listeners: Record<string, Listener[]> = {};
  const permissions: Launch['permissions'] = {};
  const opened: string[] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  let menu: MenuItem[] = [];
  const dialogs: Record<string, unknown>[] = [];
  const answers: number[] = [];
  const sessionOn: Record<string, Listener[]> = {};
  let prefs: Record<string, unknown> = {};
  let openHandler: Launch['openHandler'];
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const wc = {
    listeners,
    setWindowOpenHandler: (h: Launch['openHandler']) => void (openHandler = h),
    on: (ev: string, cb: Listener) => void (listeners[ev] ??= []).push(cb),
    getURL: () => loads[loads.length - 1] ?? '',
    emit: (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).map((cb) => cb(...a)),
  };
  class BrowserWindow {
    static getAllWindows = () => [];
    webContents = wc;
    constructor(o: { webPreferences?: Record<string, unknown> }) {
      prefs = o.webPreferences ?? {};
    }
    once() {}
    on() {}
    loadURL(url: string) {
      loads.push(url);
      for (const w of waiters.splice(0)) {
        if (loads.length > w.n) w.done(loads[w.n]);
        else waiters.push(w);
      }
      return Promise.resolve();
    }
  }
  const packaged = !!opts.appDir;
  const fake = {
    app: {
      isPackaged: packaged,
      getAppPath: () => opts.appDir ?? path.resolve(ELECTRON_DIR, '..'),
      getPath: (name: string) => (name === 'userData' ? userData : os.tmpdir()),
      requestSingleInstanceLock: () => true,
      on: (ev: string, cb: () => unknown) => void (on[ev] = cb),
      setName() {},
      setAppUserModelId() {},
      whenReady: () => readyP,
      getVersion: () => '0.1.0',
      getGPUFeatureStatus: () => ({ ...gpu }),
      getGPUInfo: () => Promise.resolve({ gpuDevice: [] }),
      quit() {},
    },
    BrowserWindow,
    Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: (m: MenuItem[]) => void (menu = m) },
    clipboard: { writeText() {} },
    dialog: {
      showMessageBox: (o: Record<string, unknown>) => {
        dialogs.push(o);
        const next = answers.shift();
        return Promise.resolve({ response: next ?? (typeof o.cancelId === 'number' ? o.cancelId : 0) });
      },
      showErrorBox() {},
    },
    ipcMain: {
      on: (ch: string, cb: Handler) => void (ipc[ch] = cb),
      handle: (ch: string, cb: Handler) => void (handle[ch] = cb),
    },
    net: {
      fetch: (url: string, init?: unknown) => {
        fetched.push(url);
        return opts.fetch ? opts.fetch(url, init) : Promise.reject(new Error('offline (test)'));
      },
      isOnline: () => true,
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (h: Listener) => void (permissions.request = h),
        setPermissionCheckHandler: (h: Listener) => void (permissions.check = h),
        on: (ev: string, cb: Listener) => void (sessionOn[ev] ??= []).push(cb),
      },
    },
    shell: { openExternal: (url: string) => void opened.push(url) },
  };
  const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
  const orig = M._load;
  const env0 = { ...process.env };
  Object.assign(process.env, opts.env ?? {});
  const con = { info: console.info, warn: console.warn };
  const keep =
    (f: (...a: unknown[]) => void) =>
    (...a: unknown[]) => {
      const line = a.map(String).join(' ');
      if (line.startsWith('[desktop]')) logs.push(line);
      else f(...a);
    };
  console.info = keep(con.info);
  console.warn = keep(con.warn);
  M._load = function (req: string, ...rest: unknown[]) {
    return req === 'electron' ? fake : orig.call(this, req, ...rest);
  };
  try {
    const main = path.join(ELECTRON_DIR, 'main.cjs');
    delete require.cache[main];
    require(main);
  } finally {
    M._load = orig;
  }
  ready();
  const load = (n: number): Promise<string> =>
    loads.length > n ? Promise.resolve(loads[n]) : new Promise((done) => waiters.push({ n, done }));
  let url: string;
  try {
    url = await load(0);
  } finally {
    for (const k of Object.keys(opts.env ?? {})) {
      if (k in env0) process.env[k] = env0[k];
      else delete process.env[k];
    }
  }
  return {
    userData,
    url,
    loads,
    load,
    ipc,
    handle,
    on,
    gpu,
    wc,
    get prefs() {
      return prefs;
    },
    permissions,
    get openHandler() {
      return openHandler;
    },
    opened,
    fetched,
    logs,
    get menu() {
      return menu;
    },
    dialogs,
    answers,
    sessionOn,
    quit: async () => {
      on['before-quit']?.();
      await new Promise((r) => setTimeout(r, 50));
      console.info = con.info;
      console.warn = con.warn;
    },
  };
}

/** An IPC event from the window's top frame showing `origin` (default: the page it loaded first). */
export function pageEvent(app: Launch, origin = new URL(app.url).origin, extra: Partial<IpcEvent> = {}): IpcEvent {
  return { sender: app.wc, senderFrame: { origin, url: `${origin}/`, parent: null }, ...extra };
}

/** A synchronous IPC call from `ev`'s page: the handler's answer (ev.returnValue). */
export function callSync(app: Launch, channel: string, ev: IpcEvent = pageEvent(app), ...args: unknown[]): unknown {
  app.ipc[channel](ev, ...args);
  return ev.returnValue;
}

export interface PreloadOptions {
  /** the page's origin (default: the page the window loaded first) */
  origin?: string;
  /** window.sgwlDesktop lands here */
  exposed?: Record<string, unknown>;
  /** the preload runs in a sub-frame */
  subFrame?: boolean;
}

/**
 * Run electron/preload.cjs for a page on `store` (its origin's localStorage), with the window's
 * additionalArguments on process.argv (as Electron does); returns its pagehide handler.
 */
export function preload(store: Storage, app: Launch, opts: PreloadOptions = {}): () => void {
  const origin = opts.origin ?? new URL(app.url).origin;
  const ev = (): IpcEvent => pageEvent(app, origin);
  const handlers: Record<string, () => void> = {};
  const fake = {
    contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => void Object.assign(opts.exposed ?? {}, api) },
    ipcRenderer: {
      sendSync: (ch: string, ...a: unknown[]) => callSync(app, ch, ev(), ...a),
      send: (ch: string, ...a: unknown[]) => void app.ipc[ch](ev(), ...a),
      invoke: (ch: string, ...a: unknown[]) => Promise.resolve(app.handle[ch](ev(), ...a)),
      on() {},
      removeListener() {},
    },
  };
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in g;
  const timers: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  const win: Record<string, unknown> = { localStorage: store, addEventListener: (e: string, cb: () => void) => void (handlers[e] = cb), location: { origin } };
  win.top = opts.subFrame ? {} : win;
  g.window = win;
  (globalThis as { setInterval: unknown }).setInterval = (fn: () => void, ms: number) => {
    const t = realSetInterval(fn, ms);
    timers.push(t);
    return t;
  };
  const args = (app.prefs.additionalArguments as string[] | undefined) ?? [];
  const argv0 = process.argv;
  process.argv = [...argv0, ...args];
  const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
  const orig = M._load;
  const p = path.join(ELECTRON_DIR, 'preload.cjs');
  // the renderer is sandboxed (webPreferences.sandbox): its preload can require 'electron' and
  // nothing else — so here too (a require of ./state.cjs or node:path would break the real app)
  M._load = function (req: string, ...rest: unknown[]) {
    if (req === 'electron') return fake;
    if (req === p) return orig.call(this, req, ...rest);
    throw new Error(`sandboxed preload: require('${req}') is not available`);
  };
  try {
    delete require.cache[p];
    require(p);
  } finally {
    M._load = orig;
    process.argv = argv0;
    (globalThis as { setInterval: unknown }).setInterval = realSetInterval;
    if (!hadWindow) delete g.window;
  }
  return () => {
    for (const t of timers) clearInterval(t);
    handlers.pagehide?.();
  };
}

/** An in-memory Storage (one per origin). */
export function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}
