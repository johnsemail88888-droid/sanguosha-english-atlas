// PLATFORM-7: the desktop app serves the game from http://127.0.0.1:<port>/ — localStorage is
// per origin, so a port fallback (8787 busy) used to start the game with default settings.
// The last good port is remembered and tried first; the game's localStorage keys are
// mirrored to the app data folder by the preload and restored on another origin.
// electron/main.cjs and preload.cjs run here against a stubbed 'electron' module.
import fs from 'node:fs';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ELECTRON_DIR = path.resolve(__dirname, '../../../electron');
const state = require(path.join(ELECTRON_DIR, 'state.cjs')) as {
  PORTS: number[];
  MARK_KEY: string;
  portOrder(last: unknown): number[];
  snapshotStorage(store: Storage): Record<string, string>;
  restoreStorage(store: Storage, mirror: unknown): boolean;
  mirrorFile(file: string): { load(): { version: number; items: Record<string, string> } | null; save(items: Record<string, string>, origin?: string): number };
};

/** An in-memory Storage (one per origin). */
function memStorage(init: Record<string, string> = {}): Storage {
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

const tmpDirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-desktop-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('port order', () => {
  it('the last good port first, then the defaults (no duplicates); junk is ignored', () => {
    expect(state.portOrder(undefined)).toEqual(state.PORTS);
    expect(state.portOrder(8788)).toEqual([8788, 8787, 8789, 18787, 0]);
    expect(state.portOrder(51234)).toEqual([51234, ...state.PORTS]); // an ephemeral port from last time
    for (const junk of [0, -1, 70000, '8788', 1.5, null]) expect(state.portOrder(junk)).toEqual(state.PORTS);
  });
});

describe('localStorage mirror', () => {
  it('another origin gets the settings; changes flow back; the same origin is not touched twice', () => {
    const file = path.join(tmp(), 'web-storage.json');
    const mirror = state.mirrorFile(file);
    expect(mirror.load()).toBeNull();
    const a = memStorage({ 'sgwl.settings.v1': '{"playerName":"关羽","quality":"high"}', 'sgwl.guide.v1': '3', other: 'keep' });
    const v1 = mirror.save(state.snapshotStorage(a), 'http://127.0.0.1:8787');
    a.setItem(state.MARK_KEY, String(v1));
    expect(mirror.load()?.items).toEqual({ 'sgwl.settings.v1': '{"playerName":"关羽","quality":"high"}', 'sgwl.guide.v1': '3' });
    // the port changed: a fresh origin
    const b = memStorage({ unrelated: 'x', 'sgwl.settings.v1': '{"playerName":"主公"}' });
    expect(state.restoreStorage(b, mirror.load())).toBe(true);
    expect(b.getItem('sgwl.settings.v1')).toBe('{"playerName":"关羽","quality":"high"}');
    expect(b.getItem('sgwl.guide.v1')).toBe('3');
    expect(b.getItem('unrelated')).toBe('x'); // not the game's: untouched
    expect(state.restoreStorage(b, mirror.load())).toBe(false); // already holds it
    // changed on B, then back on port A: A gets B's newer settings, and a removed key goes
    b.setItem('sgwl.settings.v1', '{"playerName":"张飞"}');
    b.removeItem('sgwl.guide.v1');
    const v2 = mirror.save(state.snapshotStorage(b));
    b.setItem(state.MARK_KEY, String(v2));
    expect(v2).toBe(v1 + 1);
    expect(state.restoreStorage(a, mirror.load())).toBe(true);
    expect(a.getItem('sgwl.settings.v1')).toBe('{"playerName":"张飞"}');
    expect(a.getItem('sgwl.guide.v1')).toBeNull();
    expect(a.getItem('other')).toBe('keep');
    // junk mirrors are ignored
    expect(state.restoreStorage(memStorage(), { version: 'x', items: {} })).toBe(false);
    fs.writeFileSync(file, '{broken');
    expect(mirror.load()).toBeNull();
  });
});

// ── main.cjs + preload.cjs with a stubbed Electron ──────────────────────────
interface Launch {
  url: string;
  ipc: Record<string, (ev: { returnValue?: unknown }, ...a: unknown[]) => void>;
  quit(): Promise<void>;
}

/** Load electron/main.cjs as a fresh app launch with userData in `userData`; resolves once the window loads its URL. */
async function launch(userData: string): Promise<Launch> {
  const ipc: Launch['ipc'] = {};
  const on: Record<string, () => unknown> = {};
  let loaded!: (url: string) => void;
  const urlP = new Promise<string>((r) => (loaded = r));
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  class BrowserWindow {
    static getAllWindows = () => [];
    webContents = { setWindowOpenHandler: () => undefined };
    once() {}
    on() {}
    loadURL(url: string) {
      loaded(url);
      return Promise.resolve();
    }
  }
  const fake = {
    app: {
      isPackaged: false,
      getAppPath: () => path.resolve(ELECTRON_DIR, '..'),
      getPath: (name: string) => (name === 'userData' ? userData : os.tmpdir()),
      requestSingleInstanceLock: () => true,
      on: (ev: string, cb: () => unknown) => void (on[ev] = cb),
      setName() {},
      setAppUserModelId() {},
      whenReady: () => readyP,
      quit() {},
    },
    BrowserWindow,
    Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu() {} },
    clipboard: { writeText() {} },
    dialog: { showMessageBox: () => Promise.resolve({}), showErrorBox() {} },
    ipcMain: { on: (ch: string, cb: Launch['ipc'][string]) => void (ipc[ch] = cb) },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    shell: {},
  };
  const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
  const orig = M._load;
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
  const url = await urlP;
  return {
    url,
    ipc,
    quit: async () => {
      on['before-quit']?.();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

/** Run electron/preload.cjs for a page on `store` (its origin's localStorage); returns its pagehide handler. */
function preload(store: Storage, ipc: Launch['ipc']): () => void {
  const handlers: Record<string, () => void> = {};
  const fake = {
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: {
      sendSync: (ch: string, ...a: unknown[]) => {
        const ev: { returnValue?: unknown } = {};
        ipc[ch](ev, ...a);
        return ev.returnValue;
      },
    },
  };
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in g;
  const timers: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  g.window = { localStorage: store, addEventListener: (ev: string, cb: () => void) => void (handlers[ev] = cb) };
  (globalThis as { setInterval: unknown }).setInterval = (fn: () => void, ms: number) => {
    const t = realSetInterval(fn, ms);
    timers.push(t);
    return t;
  };
  const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
  const orig = M._load;
  M._load = function (req: string, ...rest: unknown[]) {
    return req === 'electron' ? fake : orig.call(this, req, ...rest);
  };
  try {
    const p = path.join(ELECTRON_DIR, 'preload.cjs');
    delete require.cache[p];
    require(p);
  } finally {
    M._load = orig;
    (globalThis as { setInterval: unknown }).setInterval = realSetInterval;
    if (!hadWindow) delete g.window;
  }
  return () => {
    for (const t of timers) clearInterval(t);
    handlers.pagehide?.();
  };
}

describe('desktop app launches (electron/main.cjs + preload.cjs, stubbed Electron)', () => {
  it('reopens on the last good port; when it is busy the settings follow to the new origin', async () => {
    const userData = tmp();
    // 1st launch: some port; the player sets a name
    const first = await launch(userData);
    const port1 = Number(new URL(first.url).port);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8'))).toEqual({ port: port1 });
    const origin1 = memStorage();
    let unload = preload(origin1, first.ipc);
    origin1.setItem('sgwl.settings.v1', '{"playerName":"赵云","quality":"medium"}');
    unload();
    await first.quit();

    // 2nd launch: the same port again (same origin, same localStorage)
    const second = await launch(userData);
    expect(Number(new URL(second.url).port)).toBe(port1);
    await second.quit();

    // 3rd launch: that port is taken by something else — another port, a new origin
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(port1, '0.0.0.0', () => r()));
    try {
      const third = await launch(userData);
      const port3 = Number(new URL(third.url).port);
      expect(port3).not.toBe(port1);
      expect(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8'))).toEqual({ port: port3 });
      const origin3 = memStorage(); // empty: a new origin
      unload = preload(origin3, third.ipc);
      expect(origin3.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云","quality":"medium"}'); // restored before the game reads it
      origin3.setItem('sgwl.settings.v1', '{"playerName":"赵云","quality":"low"}');
      unload();
      await third.quit();
    } finally {
      await new Promise((r) => blocker.close(r));
    }

    // 4th launch: back on the remembered (newest) port… and the first origin, if ever used again, catches up
    const fourth = await launch(userData);
    unload = preload(origin1, fourth.ipc);
    expect(origin1.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云","quality":"low"}');
    unload();
    await fourth.quit();
  }, 30_000);
});
