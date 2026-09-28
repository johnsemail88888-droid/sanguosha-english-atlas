// Desktop state that must survive a change of the embedded server's port (PLATFORM-7).
//
// The game is served from http://127.0.0.1:<port>/ and the browser keeps localStorage per
// origin: when the usual port is busy and the app falls back to another one, the page would
// start with default settings (name, quality, keybinds) and LAN friends' URLs change. So:
//  - the last port that worked is remembered (userData/desktop.json) and tried first;
//  - the game's own localStorage keys ('sgwl…') are mirrored to userData/web-storage.json by
//    the preload, and restored into whatever origin the window opens on when that origin has
//    not seen the newest mirror yet (a different port, the official server's page — electron/
//    page.cjs — or the same one after another origin wrote newer settings).
//  - an origin writes only the keys it changed since it last synced (a patch): an origin with
//    stale settings (another port's, the official page's, a page going away after the window
//    switched) never overwrites newer ones it did not touch.
// The preload is sandboxed (it can only require 'electron'): it reads and writes its origin's
// 'sgwl…' keys; what to restore and what to write is decided here, in the main process
// (syncPlan, mirrorFile().patch).
// Plain CommonJS without Electron imports: main.cjs uses it, the unit tests too.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Ports tried by default, in order (0 = any free port). */
const PORTS = [8787, 8788, 8789, 18787, 0];
/** localStorage keys the game owns (settings, setup prefs, guide progress, QA switches). */
const KEY_PREFIX = 'sgwl';
/** localStorage key: the mirror version this origin holds (it wrote it, or restored it). */
const MARK_KEY = 'sgwl.desktop.mirror';

/** Ports to try: the last one that worked first (same origin ⇒ same localStorage), then the defaults. */
function portOrder(last, defaults = PORTS) {
  const out = [];
  if (Number.isInteger(last) && last > 0 && last < 65536) out.push(last);
  for (const p of defaults) if (!out.includes(p)) out.push(p);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write via a temp file + rename: a crash mid-write never leaves half a file. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const isGameKey = (k) => typeof k === 'string' && k.startsWith(KEY_PREFIX) && k !== MARK_KEY;

function validMirror(m) {
  return !!m && typeof m === 'object' && Number.isInteger(m.version) && m.version > 0 && !!m.items && typeof m.items === 'object';
}

/** The game's keys in `store` (a Storage): what the mirror keeps. */
function snapshotStorage(store) {
  const items = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!isGameKey(k)) continue;
    const v = store.getItem(k);
    if (typeof v === 'string') items[k] = v;
  }
  return items;
}

/** Only string values of the game's keys. */
function cleanItems(items) {
  const clean = {};
  if (items && typeof items === 'object') for (const [k, v] of Object.entries(items)) if (isGameKey(k) && typeof v === 'string') clean[k] = v;
  return clean;
}

/**
 * What an origin holding `items` (its 'sgwl…' localStorage keys, the mark included) must change
 * to hold `mirror`: { version (held afterwards; 0 = no mirror yet), set: { key: value }, remove: [key] }.
 * Nothing to change when it holds that version already. Keys that are not the game's are never named.
 */
function syncPlan(items, mirror) {
  const have = items && typeof items === 'object' ? items : {};
  if (!validMirror(mirror)) return { version: 0, set: {}, remove: [] };
  if (Number(have[MARK_KEY]) === mirror.version) return { version: mirror.version, set: {}, remove: [] };
  const want = cleanItems(mirror.items);
  const set = {};
  for (const [k, v] of Object.entries(want)) if (have[k] !== v) set[k] = v;
  set[MARK_KEY] = String(mirror.version);
  const remove = Object.keys(have).filter((k) => isGameKey(k) && !Object.prototype.hasOwnProperty.call(want, k));
  return { version: mirror.version, set, remove };
}

/** An origin's 'sgwl…' keys, its mark included: what the preload reads and sends (syncPlan's `items`). */
function storageKeys(store) {
  const items = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue;
    const v = store.getItem(k);
    if (typeof v === 'string') items[k] = v;
  }
  return items;
}

/** Carry out a syncPlan on `store` (the preload does the same). Returns true when it changed anything. */
function applyPlan(store, plan) {
  if (!plan || typeof plan !== 'object') return false;
  let changed = false;
  for (const k of Array.isArray(plan.remove) ? plan.remove : []) {
    store.removeItem(k);
    changed = true;
  }
  for (const [k, v] of Object.entries(plan.set && typeof plan.set === 'object' ? plan.set : {})) {
    store.setItem(k, v);
    changed = true;
  }
  return changed;
}

/**
 * Bring `store` (this origin's localStorage) to the mirror's state unless it already holds
 * that version. Returns true when it changed anything. Keys that are not the game's are
 * never touched.
 */
function restoreStorage(store, mirror) {
  if (!validMirror(mirror)) return false;
  return applyPlan(store, syncPlan(storageKeys(store), mirror));
}

/**
 * The file-side store: `load()` the mirror; `save(items, origin)` a new version of it holding
 * `items`; `patch({ set, del }, origin)` a new version with only these keys changed (what an
 * origin changed since it last synced) — both return the new mirror's version, which the saving
 * origin then marks as held (`patch` returns the whole new mirror).
 */
function mirrorFile(file) {
  const load = () => {
    const m = readJson(file);
    return validMirror(m) ? m : null;
  };
  const write = (items, origin) => {
    const cur = load();
    const m = { version: (cur ? cur.version : 0) + 1, origin: typeof origin === 'string' ? origin : '', savedAt: Date.now(), items };
    writeJson(file, m);
    return m;
  };
  return {
    load,
    save(items, origin) {
      return write(cleanItems(items), origin).version;
    },
    patch(change, origin) {
      const cur = load();
      const items = { ...(cur ? cleanItems(cur.items) : {}) };
      const c = change && typeof change === 'object' ? change : {};
      if (Array.isArray(c.del)) for (const k of c.del) if (isGameKey(k)) delete items[k];
      Object.assign(items, cleanItems(c.set));
      return write(items, origin);
    },
  };
}

module.exports = { PORTS, KEY_PREFIX, MARK_KEY, portOrder, readJson, writeJson, snapshotStorage, storageKeys, syncPlan, applyPlan, restoreStorage, mirrorFile };
