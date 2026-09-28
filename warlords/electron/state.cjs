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
//  - the official server's page is remote content: only the player's preferences cross to and
//    from it (REMOTE_KEYS, and of sgwl.settings.v1 the REMOTE_SETTINGS fields, checked). Its
//    connection — relay addresses, access keys (but the official server's own), TURN credentials,
//    the connection choice — and the QA / debug switches stay with each origin: the remote page
//    can neither read the app page's nor plant its own there.
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
/** localStorage key of the game's settings (src/game/settings.ts). */
const SETTINGS_KEY = 'sgwl.settings.v1';
/**
 * The keys that cross to / from the official server's page: preferences and progress hints —
 * never the connection choice (sgwl.ui.netChoice.v2, sgwl.ui.netModeChosen, sgwl.ui.customWsUrl),
 * the QA / debug switches (sgwl.debug, sgwl.worldArt) or the update chip's memo. A key added to
 * the game later stays with its origin until it is named here.
 */
const REMOTE_KEYS = new Set([SETTINGS_KEY, 'sgwl.guide.v1', 'sgwl.sktips.v1', 'sgwl.ui.single.v1', 'sgwl.gpu.software', 'sgwl.perfcheck.shown', 'sgwl.gpuWarn.off']);
/** No value from the official page longer than this is kept (a mirror file is not a dump). */
const MAX_REMOTE_VALUE = 16 * 1024;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const oneOf = (...xs) => (v) => xs.includes(v);
/**
 * The sgwl.settings.v1 fields that cross (src/game/settings.ts UserSettings: all but `net`, a test
 * keeps the two in step), each with the check a value from the official page must pass.
 */
const REMOTE_SETTINGS = {
  playerName: (v) => typeof v === 'string' && v.length <= 64,
  lang: oneOf('zh', 'en'),
  mouseSensitivity: isNum,
  adsSensitivity: isNum,
  invertY: isBool,
  fov: isNum,
  quality: oneOf('potato', 'low', 'medium', 'high', 'ultra'),
  qualityAuto: isBool,
  autoAdjust: isBool,
  autoRenderScale: isNum,
  showFps: isBool,
  gpuBench: (v) => v === null || (!!v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= 4096),
  masterVolume: isNum,
  musicVolume: isNum,
  sfxVolume: isNum,
  voiceLines: isBool,
  musicSource: oneOf('noname', 'original'),
  touchControls: oneOf('auto', 'on', 'off'),
  cameraView: oneOf('auto', 'first', 'third'),
};

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

/** A JSON object's text → the object; null for anything else. */
function parseObj(text) {
  try {
    const v = JSON.parse(String(text));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The preference fields of a settings object that pass their checks (REMOTE_SETTINGS). */
function prefsOf(s) {
  const out = {};
  for (const [field, ok] of Object.entries(REMOTE_SETTINGS)) if (Object.prototype.hasOwnProperty.call(s, field) && ok(s[field])) out[field] = s[field];
  return out;
}

/** The key-store origin of a relay URL (src/net/relayKey.ts relayOrigin: 'wss://host[:port]'); null for anything else. */
function relayKeyOrigin(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/**
 * sgwl.settings.v1 for the official page: the mirror's preferences over the page's own settings,
 * whose connection stays as it is — plus the official server's own access key (`keyOrigin`) when
 * the page has none (it is that server's key). null: the mirror holds no settings.
 */
function settingsForRemote(mirrorValue, ownValue, keyOrigin) {
  const from = parseObj(mirrorValue);
  if (!from) return null;
  const own = parseObj(ownValue) || {};
  const out = { ...own, ...prefsOf(from) };
  const ownNet = own.net && typeof own.net === 'object' ? own.net : {};
  const ownKeys = ownNet.keys && typeof ownNet.keys === 'object' ? ownNet.keys : {};
  const key = keyOrigin && from.net && from.net.keys && typeof from.net.keys[keyOrigin] === 'string' ? from.net.keys[keyOrigin] : null;
  if (key && typeof ownKeys[keyOrigin] !== 'string') out.net = { ...ownNet, keys: { ...ownKeys, [keyOrigin]: key } };
  return JSON.stringify(out);
}

/** sgwl.settings.v1 from the official page: its (checked) preferences over the mirror's settings, the connection untouched. null: junk. */
function settingsFromRemote(mirrorValue, remoteValue) {
  const from = parseObj(remoteValue);
  if (!from) return null;
  return JSON.stringify({ ...(parseObj(mirrorValue) || {}), ...prefsOf(from) });
}

/** What of the mirror's `items` the official page (holding `have`) gets. */
function remoteItems(items, have, keyOrigin) {
  const want = {};
  for (const [k, v] of Object.entries(cleanItems(items))) {
    if (!REMOTE_KEYS.has(k)) continue;
    if (k !== SETTINGS_KEY) want[k] = v;
    else {
      const s = settingsForRemote(v, have[k], keyOrigin);
      if (s !== null) want[k] = s;
    }
  }
  return want;
}

/**
 * What an origin holding `items` (its 'sgwl…' localStorage keys, the mark included) must change
 * to hold `mirror`: { version (held afterwards; 0 = no mirror yet), set: { key: value }, remove: [key] }.
 * Nothing to change when it holds that version already. Keys that are not the game's are never named.
 * `remote` ({ keyOrigin }: the official server's page): only the preferences are named (see the top).
 */
function syncPlan(items, mirror, remote = null) {
  const have = items && typeof items === 'object' ? items : {};
  if (!validMirror(mirror)) return { version: 0, set: {}, remove: [] };
  if (Number(have[MARK_KEY]) === mirror.version) return { version: mirror.version, set: {}, remove: [] };
  const want = remote ? remoteItems(mirror.items, have, remote.keyOrigin) : cleanItems(mirror.items);
  const set = {};
  for (const [k, v] of Object.entries(want)) if (have[k] !== v) set[k] = v;
  set[MARK_KEY] = String(mirror.version);
  // (the official page's connection and switches are its own: never removed; its settings neither)
  const synced = (k) => isGameKey(k) && (!remote || (REMOTE_KEYS.has(k) && k !== SETTINGS_KEY));
  const remove = Object.keys(have).filter((k) => synced(k) && !Object.prototype.hasOwnProperty.call(want, k));
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
 * `items`; `patch({ set, del }, origin, remote)` a new version with only these keys changed (what
 * an origin changed since it last synced) — both return the new mirror's version, which the saving
 * origin then marks as held (`patch` returns the whole new mirror). `remote` (the official
 * server's page): only its preferences are taken — REMOTE_KEYS, the REMOTE_SETTINGS fields of its
 * settings, each checked — never a connection, a key, a switch, and it never deletes the settings.
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
    patch(change, origin, remote = null) {
      const cur = load();
      const items = { ...(cur ? cleanItems(cur.items) : {}) };
      const c = change && typeof change === 'object' ? change : {};
      const takes = (k) => isGameKey(k) && (!remote || REMOTE_KEYS.has(k));
      if (Array.isArray(c.del)) for (const k of c.del) if (takes(k) && !(remote && k === SETTINGS_KEY)) delete items[k];
      for (const [k, v] of Object.entries(cleanItems(c.set))) {
        if (!takes(k)) continue;
        if (!remote) items[k] = v;
        else if (v.length > MAX_REMOTE_VALUE) continue;
        else if (k !== SETTINGS_KEY) items[k] = v;
        else {
          const s = settingsFromRemote(items[k], v);
          if (s !== null) items[k] = s;
        }
      }
      return write(items, origin);
    },
  };
}

module.exports = {
  PORTS,
  KEY_PREFIX,
  MARK_KEY,
  SETTINGS_KEY,
  REMOTE_KEYS,
  REMOTE_SETTINGS,
  MAX_REMOTE_VALUE,
  portOrder,
  readJson,
  writeJson,
  snapshotStorage,
  storageKeys,
  relayKeyOrigin,
  syncPlan,
  applyPlan,
  restoreStorage,
  mirrorFile,
};
