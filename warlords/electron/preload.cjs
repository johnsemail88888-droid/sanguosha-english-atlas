// Exposes desktop-only info (LAN addresses of the embedded server, the app version and its
// updates, which page the window shows and the version fix) to the game UI, and keeps the
// game's localStorage keys mirrored in the app's data folder (PLATFORM-7): the page's origin
// changes with the embedded server's port — and the window may show the official server's page
// (electron/page.cjs) — and localStorage with it.
//
// Only on the app's own pages: the top frame of the window on one of the origins main.cjs allows
// (the embedded server's, the official server's — --sgwl-origins). Anything else gets no
// window.sgwlDesktop and no settings (main.cjs checks every IPC sender again).
//
// Sandboxed (webPreferences.sandbox): only 'electron' can be required here. The mirror's logic
// (what to restore, what to write) runs in the main process (state.cjs syncPlan / patch); this
// file reads and writes its origin's 'sgwl…' keys. Keep window.sgwlDesktop backward compatible —
// the official page is the server's build, up to a day older or newer than the app.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** How often changed settings are copied to the mirror (ms; and when the page goes away). */
const MIRROR_EVERY_MS = 5000;
/** The game's localStorage keys start with this (state.cjs KEY_PREFIX). */
const KEY_PREFIX = 'sgwl';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const isUrlList = (v) => Array.isArray(v) && v.every((u) => typeof u === 'string');

function jsonArg(name, fallback) {
  try {
    const v = JSON.parse(decodeURIComponent(arg(name)) || 'null');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

const port = Number(arg('sgwl-port') || 8787);
/** the origins main.cjs lets the window show (page.cjs createGuard) */
const origins = (() => {
  const v = jsonArg('sgwl-origins', []);
  return isUrlList(v) ? v : [];
})();
const here = (() => {
  try {
    return String(window.location.origin);
  } catch {
    return '';
  }
})();
const topFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();
const ours = topFrame && here !== 'null' && origins.includes(here);

/** This origin's 'sgwl…' keys (the mirror's mark included): what the main process plans with. */
function readKeys(store) {
  const items = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue;
    const v = store.getItem(k);
    if (typeof v === 'string') items[k] = v;
  }
  return items;
}

/** Carry out the main process's plan ({ set, remove }); true when it changed anything. */
function applyPlan(store, plan) {
  if (!plan || typeof plan !== 'object') return false;
  let changed = false;
  for (const k of Array.isArray(plan.remove) ? plan.remove : []) {
    if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue;
    store.removeItem(k);
    changed = true;
  }
  const set = plan.set && typeof plan.set === 'object' ? plan.set : {};
  for (const k of Object.keys(set)) {
    if (!k.startsWith(KEY_PREFIX) || typeof set[k] !== 'string') continue;
    store.setItem(k, set[k]);
    changed = true;
  }
  return changed;
}

/** What changed from `before` to `after`: { set, del }. */
function diff(before, after) {
  const set = {};
  const del = [];
  for (const k of Object.keys(after)) if (before[k] !== after[k]) set[k] = after[k];
  for (const k of Object.keys(before)) if (!Object.prototype.hasOwnProperty.call(after, k)) del.push(k);
  return { set, del };
}

/** Copy this page's changed settings to the mirror now (a no-op when nothing changed). */
let flush = () => undefined;

/**
 * Before the game's scripts read their settings: restore the mirror into this origin if it
 * does not hold the newest one (another port / the other page wrote it); then keep the mirror
 * up to date with what this page changes — only that: a key it did not change is never written.
 */
function mirrorStorage() {
  let store;
  try {
    store = window.localStorage;
  } catch {
    return; // storage blocked: nothing to keep
  }
  if (!store) return;
  /** the keys as last synced with the mirror: what changes are measured against */
  let last = null;
  try {
    const plan = ipcRenderer.sendSync('sgwl:storage-load', readKeys(store));
    if (plan && typeof plan === 'object') {
      if (applyPlan(store, plan)) console.info('[desktop] settings restored from the app data folder');
      // no mirror yet (version 0): everything here is new to it
      last = Number(plan.version) > 0 ? readKeys(store) : {};
    }
  } catch (err) {
    console.warn('[desktop] restoring the settings failed', err);
  }
  // the mirror could not be read: only what changes from now on is written (never stale settings over newer ones)
  if (!last) last = readKeys(store);
  flush = () => {
    try {
      const now = readKeys(store);
      const change = diff(last, now);
      if (!Object.keys(change.set).length && !change.del.length) return;
      const plan = ipcRenderer.sendSync('sgwl:storage-save', { set: change.set, del: change.del, items: now });
      if (!plan || typeof plan !== 'object') return;
      // (keys another origin changed meanwhile come back with the new mark)
      applyPlan(store, plan);
      last = readKeys(store);
    } catch (err) {
      console.warn('[desktop] saving the settings failed', err);
    }
  };
  setInterval(() => flush(), MIRROR_EVERY_MS);
  window.addEventListener('pagehide', () => flush());
}

/** Asked from the main process, which answers once the GPU process has reported (see main.cjs gpuReady). */
function webglStatus() {
  try {
    const v = ipcRenderer.sendSync('sgwl:webgl');
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * Desktop updates (electron/updater.cjs, src/ui/desktopUpdate.ts). onState(cb) calls cb with the
 * state now and on every change, and returns the unsubscribe; download() opens the new build (the
 * portable exe / the dmg) or starts the background download; restart() installs a downloaded one.
 */
const update = {
  onState(cb) {
    if (typeof cb !== 'function') return () => undefined;
    const push = (_ev, st) => cb(st);
    ipcRenderer.on('sgwl:update-state', push);
    try {
      const st = ipcRenderer.sendSync('sgwl:update-get');
      if (st) cb(st);
    } catch {
      /* no updater: nothing to show */
    }
    return () => ipcRenderer.removeListener('sgwl:update-state', push);
  },
  /** which: 'setup' — the portable's offer of the setup build (it updates itself) */
  download: (which) => ipcRenderer.send('sgwl:update-do', 'download', which === 'setup' ? 'setup' : undefined),
  restart: () => ipcRenderer.send('sgwl:update-do', 'restart'),
  check: () => ipcRenderer.send('sgwl:update-do', 'check'),
  /** a match is on: no update check, download or restart until it ends */
  playing: (on) => ipcRenderer.send('sgwl:update-playing', !!on),
};

if (ours) {
  mirrorStorage();

  let lanUrls = [];
  try {
    lanUrls = JSON.parse(decodeURIComponent(arg('sgwl-lan')) || '[]');
  } catch {
    lanUrls = [];
  }
  if (!isUrlList(lanUrls)) lanUrls = [];

  contextBridge.exposeInMainWorld('sgwlDesktop', {
    isDesktop: true,
    /** LAN URLs when the window opened, best first (see getLanUrls for a fresh list) */
    lanUrls,
    /** http://<ip>:<port>/ of this machine right now, best first (Wi-Fi / Ethernet before virtual adapters) */
    getLanUrls: () => {
      try {
        const fresh = ipcRenderer.sendSync('sgwl:lan-urls');
        return isUrlList(fresh) ? fresh : lanUrls;
      } catch {
        return lanUrls;
      }
    },
    port,
    /** how Chromium runs WebGL (app.getGPUFeatureStatus().webgl: 'enabled…' = on the GPU; '' unknown) */
    webgl: webglStatus(),
    /** the app's version (0.1.<build> for a release build) */
    version: arg('sgwl-version'),
    update,
    /** which page the window shows: 'bundled' (this app's own build) | 'official' (the official server's build) */
    page: here === `http://127.0.0.1:${port}` ? 'bundled' : 'official',
    /**
     * 「版本不同」 on the official server: ask the app to reload the page whose build matches the
     * server's, carrying { room } (joined there by itself) or { create: true } (创建房间 there);
     * `compat`: this page's build. Resolves { switched, page?, reason? } (switched: this page is
     * about to be replaced), or null.
     */
    fixVersion: (req) => {
      const o = req && typeof req === 'object' ? req : {};
      flush(); // the settings as they are now, before the other page reads them
      return ipcRenderer.invoke('sgwl:fix-version', {
        room: typeof o.room === 'string' ? o.room : null,
        create: o.create === true,
        compat: typeof o.compat === 'string' ? o.compat : null,
      });
    },
    /** 切换到本机版本: the bundled page (LAN friends get that build) */
    useBundled: () => {
      flush();
      ipcRenderer.send('sgwl:use-bundled');
    },
  });
}
