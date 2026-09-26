// Exposes desktop-only info (LAN addresses of the embedded server) to the game UI, and
// keeps the game's localStorage keys mirrored in the app's data folder (PLATFORM-7): the
// page's origin changes with the embedded server's port, and localStorage with it.
const { contextBridge, ipcRenderer } = require('electron');
const { MARK_KEY, restoreStorage, snapshotStorage } = require('./state.cjs');

/** How often changed settings are copied to the mirror (ms; and when the page goes away). */
const MIRROR_EVERY_MS = 5000;

/**
 * Before the game's scripts read their settings: restore the mirror into this origin if it
 * does not hold the newest one (another port wrote it); then keep the mirror up to date.
 */
function mirrorStorage() {
  let store;
  try {
    store = window.localStorage;
  } catch {
    return; // storage blocked: nothing to keep
  }
  if (!store) return;
  let held = false;
  try {
    const m = ipcRenderer.sendSync('sgwl:storage-load');
    if (restoreStorage(store, m)) console.info('[desktop] settings restored from the app data folder');
    held = !!m && Number(store.getItem(MARK_KEY)) === m.version;
  } catch (err) {
    console.warn('[desktop] restoring the settings failed', err);
  }
  let last = held ? JSON.stringify(snapshotStorage(store)) : null;
  const save = () => {
    try {
      const items = snapshotStorage(store);
      const text = JSON.stringify(items);
      if (text === last) return;
      const version = ipcRenderer.sendSync('sgwl:storage-save', items);
      if (Number.isInteger(version) && version > 0) store.setItem(MARK_KEY, String(version));
      last = text;
    } catch (err) {
      console.warn('[desktop] saving the settings failed', err);
    }
  };
  setInterval(save, MIRROR_EVERY_MS);
  window.addEventListener('pagehide', save);
}

mirrorStorage();

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const isUrlList = (v) => Array.isArray(v) && v.every((u) => typeof u === 'string');

let lanUrls = [];
try {
  lanUrls = JSON.parse(decodeURIComponent(arg('sgwl-lan')) || '[]');
} catch {
  lanUrls = [];
}

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
  port: Number(arg('sgwl-port') || 8787),
});
