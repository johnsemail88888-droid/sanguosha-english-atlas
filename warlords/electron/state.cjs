// Desktop state that must survive a change of the embedded server's port (PLATFORM-7).
//
// The game is served from http://127.0.0.1:<port>/ and the browser keeps localStorage per
// origin: when the usual port is busy and the app falls back to another one, the page would
// start with default settings (name, quality, keybinds) and LAN friends' URLs change. So:
//  - the last port that worked is remembered (userData/desktop.json) and tried first;
//  - the game's own localStorage keys ('sgwl…') are mirrored to userData/web-storage.json by
//    the preload, and restored into whatever origin the window opens on when that origin has
//    not seen the newest mirror yet (a different port, or the same one after another port
//    wrote newer settings).
// Plain CommonJS without Electron imports: main.cjs and preload.cjs use it, the unit tests too.
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

/**
 * Bring `store` (this origin's localStorage) to the mirror's state unless it already holds
 * that version. Returns true when it changed anything. Keys that are not the game's are
 * never touched.
 */
function restoreStorage(store, mirror) {
  if (!validMirror(mirror)) return false;
  if (Number(store.getItem(MARK_KEY)) === mirror.version) return false;
  const stale = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (isGameKey(k) && !Object.prototype.hasOwnProperty.call(mirror.items, k)) stale.push(k);
  }
  for (const k of stale) store.removeItem(k);
  for (const [k, v] of Object.entries(mirror.items)) if (isGameKey(k) && typeof v === 'string') store.setItem(k, v);
  store.setItem(MARK_KEY, String(mirror.version));
  return true;
}

/**
 * The file-side store: `load()` the mirror, `save(items, origin)` a new version of it
 * (returns that version, which the saving origin then marks as held).
 */
function mirrorFile(file) {
  return {
    load() {
      const m = readJson(file);
      return validMirror(m) ? m : null;
    },
    save(items, origin) {
      const cur = readJson(file);
      const version = (validMirror(cur) ? cur.version : 0) + 1;
      const clean = {};
      if (items && typeof items === 'object') for (const [k, v] of Object.entries(items)) if (isGameKey(k) && typeof v === 'string') clean[k] = v;
      writeJson(file, { version, origin: typeof origin === 'string' ? origin : '', savedAt: Date.now(), items: clean });
      return version;
    },
  };
}

module.exports = { PORTS, KEY_PREFIX, MARK_KEY, portOrder, readJson, writeJson, snapshotStorage, restoreStorage, mirrorFile };
