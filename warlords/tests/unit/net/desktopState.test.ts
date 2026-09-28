// PLATFORM-7: the desktop app serves the game from http://127.0.0.1:<port>/ — localStorage is
// per origin, so a port fallback (8787 busy) used to start the game with default settings.
// The last good port is remembered and tried first; the game's localStorage keys are
// mirrored to the app data folder by the preload and restored on another origin (another
// port, or the official server's page: electron/page.cjs).
// electron/main.cjs and preload.cjs run here against a stubbed 'electron' module (desktopHarness.ts).
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callSync, ELECTRON_DIR, launch, memStorage, pageEvent, preload } from './desktopHarness';

const require = createRequire(import.meta.url);
type Plan = { version: number; set: Record<string, string>; remove: string[] };
const state = require(path.join(ELECTRON_DIR, 'state.cjs')) as {
  PORTS: number[];
  MARK_KEY: string;
  portOrder(last: unknown): number[];
  snapshotStorage(store: Storage): Record<string, string>;
  storageKeys(store: Storage): Record<string, string>;
  syncPlan(items: unknown, mirror: unknown): Plan;
  applyPlan(store: Storage, plan: unknown): boolean;
  restoreStorage(store: Storage, mirror: unknown): boolean;
  mirrorFile(file: string): {
    load(): { version: number; items: Record<string, string> } | null;
    save(items: Record<string, string>, origin?: string): number;
    patch(change: { set?: Record<string, string>; del?: string[] }, origin?: string): { version: number; items: Record<string, string> };
  };
};

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

  it('an origin writes only what it changed: stale settings of another origin never overwrite newer ones', () => {
    const mirror = state.mirrorFile(path.join(tmp(), 'web-storage.json'));
    // the bundled page (port 8787) holds v1; the official server's page restored it too
    const v1 = mirror.save({ 'sgwl.settings.v1': 'name=赵云', 'sgwl.keys.v1': 'k1' }, 'http://127.0.0.1:8787');
    expect(v1).toBe(1);
    // the official page changes the key binds (v2)…
    const v2 = mirror.patch({ set: { 'sgwl.keys.v1': 'k2' } }, 'https://official.test');
    expect(v2).toMatchObject({ version: 2, items: { 'sgwl.settings.v1': 'name=赵云', 'sgwl.keys.v1': 'k2' } });
    // … while the bundled page, still on v1, changes the name: only the name is written
    const bundled = { 'sgwl.settings.v1': 'name=张飞', 'sgwl.keys.v1': 'k1', [state.MARK_KEY]: '1' };
    const v3 = mirror.patch({ set: { 'sgwl.settings.v1': 'name=张飞' } }, 'http://127.0.0.1:8787');
    expect(v3.items).toEqual({ 'sgwl.settings.v1': 'name=张飞', 'sgwl.keys.v1': 'k2' });
    // and the bundled page catches up with the newer key binds it did not touch
    const plan = state.syncPlan(bundled, v3);
    expect(plan).toEqual({ version: 3, set: { 'sgwl.keys.v1': 'k2', [state.MARK_KEY]: '3' }, remove: [] });
    // a key removed elsewhere goes; keys that are not the game's are never named
    const v4 = mirror.patch({ del: ['sgwl.keys.v1'] }, 'https://official.test');
    expect(state.syncPlan({ ...bundled, other: 'x' }, v4)).toMatchObject({ remove: ['sgwl.keys.v1'] });
    // holding the version already: nothing to change; no mirror yet: version 0
    expect(state.syncPlan({ [state.MARK_KEY]: '4' }, v4)).toEqual({ version: 4, set: {}, remove: [] });
    expect(state.syncPlan({}, null)).toEqual({ version: 0, set: {}, remove: [] });
    // the mark is the mirror's business, never an item
    expect(mirror.patch({ set: { [state.MARK_KEY]: '99', other: 'x' } }).items).not.toHaveProperty(state.MARK_KEY);
  });
});

describe('desktop app launches (electron/main.cjs + preload.cjs, stubbed Electron)', () => {
  it('reopens on the last good port; when it is busy the settings follow to the new origin', async () => {
    const userData = tmp();
    // 1st launch: some port; the player sets a name
    const first = await launch(userData);
    const port1 = Number(new URL(first.url).port);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8'))).toEqual({ port: port1 });
    const origin1 = memStorage();
    let unload = preload(origin1, first);
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
      unload = preload(origin3, third);
      expect(origin3.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云","quality":"medium"}'); // restored before the game reads it
      origin3.setItem('sgwl.settings.v1', '{"playerName":"赵云","quality":"low"}');
      unload();
      await third.quit();
    } finally {
      await new Promise((r) => blocker.close(r));
    }

    // 4th launch: back on the remembered (newest) port… and the first origin, if ever used again, catches up
    const fourth = await launch(userData);
    unload = preload(origin1, fourth);
    expect(origin1.getItem('sgwl.settings.v1')).toBe('{"playerName":"赵云","quality":"low"}');
    unload();
    await fourth.quit();
  }, 30_000);

  it('the page gets the app version and the update bridge; a dev run never checks for updates', async () => {
    const app = await launch(tmp());
    const bridge: Record<string, unknown> = {};
    const unload = preload(memStorage(), app, { exposed: bridge });
    const update = bridge.update as { onState(cb: (st: unknown) => void): () => void; download(): void; restart(): void; check(): void; playing(on: boolean): void };
    expect(typeof update.onState).toBe('function');
    for (const fn of ['download', 'restart', 'check', 'playing'] as const) expect(typeof update[fn]).toBe('function');
    // the bundled page, and the version fix / LAN switch it can ask for
    expect(bridge.page).toBe('bundled');
    expect(typeof bridge.fixVersion).toBe('function');
    expect(typeof bridge.useBundled).toBe('function');
    // what the page asks for through the bridge (main.cjs answers)
    expect(callSync(app, 'sgwl:update-get')).toEqual({ kind: 'none', auto: false, current: '0.1.0', build: null, status: 'idle' });
    // actions are harmless in a dev run
    app.ipc['sgwl:update-do'](pageEvent(app), 'check');
    app.ipc['sgwl:update-do'](pageEvent(app), 'download');
    app.ipc['sgwl:update-do'](pageEvent(app), 'restart');
    app.ipc['sgwl:update-playing'](pageEvent(app), true);
    expect(callSync(app, 'sgwl:update-get')).toMatchObject({ kind: 'none', status: 'idle' });
    unload();
    await app.quit();
  });

  it('the page gets the WebGL status the GPU process reported, not the start-up placeholder (Mac: Metal taken for software)', async () => {
    const app = await launch(tmp());
    // the GPU process reports after the window exists (macOS): the page asks then
    app.gpu.webgl = 'enabled';
    app.on['gpu-info-update']?.();
    const bridge: Record<string, unknown> = {};
    const unload = preload(memStorage(), app, { exposed: bridge });
    expect(bridge.webgl).toBe('enabled');
    unload();
    await app.quit();
  });
});
