// Desktop updates: every push to main publishes a GitHub release (warlords-desktop.yml) with
// version 0.1.<build> and electron-updater's metadata (latest.yml, latest-linux.yml,
// latest-mac.yml). How a copy of the app gets the new build depends on how it was installed:
//
//   nsis     Windows setup build: electron-updater downloads it in the background (never during a
//            match) and installs it when the app quits; the title screen offers 重启并更新 at once.
//   appimage Linux AppImage: the same.
//   portable Windows portable exe: nothing to install into — the title screen offers the new exe
//            (one click downloads it in the browser) and points at the setup build.
//   mac      ad-hoc signed (no Apple Developer ID): Squirrel.Mac only applies updates signed by a
//            Developer ID, so the title screen offers the new dmg for this Mac's chip.
//   linux    Linux, not an AppImage (an unpacked folder): the releases page.
//   none     a dev run (npm run electron): no checks at all.
//
// Feed: the generic provider on releases/latest/download (package.json build.publish, which makes
// electron-builder write resources/app-update.yml). The release tags (warlords-build-N) are not
// semver, but that is not what rules out the github provider: with a stable app version
// electron-updater 6.8 only puts the tag into URLs. It asks the releases.atom feed + the
// releases/latest page + the tag's latest.yml (three github.com requests per check), while the
// generic provider asks one URL that redirects to the newest release's latest.yml. Both follow
// GitHub's "latest release", which is why every warlords build is published with make_latest.
//
// Offline, rate-limited, GitHub down: silent (the state says 'error'; the next check is 4 h later).
// Plain CommonJS; Electron and electron-updater come in through `deps`, so the unit tests run it.
'use strict';

const REPO = 'johnsemail88888-droid/sanguosha-english-atlas';
/** electron-updater's feed — the same URL as package.json build.publish[0].url */
const FEED_URL = `https://github.com/${REPO}/releases/latest/download`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
/** release tag of build N (warlords-desktop.yml: tag warlords-build-<run_number>, version 0.1.<run_number>) */
const TAG_PREFIX = 'warlords-build-';
/** first check once the window is up, then every 4 h */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** How this copy of the app updates (see the table above). */
function updateKind({ platform, env = {}, isPackaged }) {
  if (!isPackaged) return 'none';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : 'linux';
  return 'none';
}

/** electron-updater downloads and installs by itself. */
const isAuto = (kind) => kind === 'nsis' || kind === 'appimage';

/** The metadata file a manual check reads. */
function feedFile(kind) {
  if (kind === 'mac') return 'latest-mac.yml';
  if (kind === 'linux' || kind === 'appimage') return 'latest-linux.yml';
  return 'latest.yml';
}

/** [major, minor, patch] of a x.y.z version (a leading v and a -pre / +build suffix allowed); null if it is none. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 by major.minor.patch; an unreadable version counts as 0.0.0. */
function compareVersions(a, b) {
  const x = parseVersion(a) || [0, 0, 0];
  const y = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** `latest` is a real version and newer than `current`. */
const isNewer = (latest, current) => !!parseVersion(latest) && compareVersions(latest, current) > 0;

/** The CI build number of a version (0.1.42 → 42); null for a local build (patch 0) or junk. */
function buildOf(version) {
  const v = parseVersion(version);
  return v && v[2] > 0 ? v[2] : null;
}

/** The GitHub release a version was published in (warlords-build-42); null when it was not. */
function releaseTag(version) {
  const n = buildOf(version);
  return n == null ? null : `${TAG_PREFIX}${n}`;
}

/** URL of a file of the release that published `version` (a fixed tag: a newer release cannot 404 it). */
function assetUrl(version, file) {
  const tag = releaseTag(version);
  return tag ? `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(file)}` : RELEASES_URL;
}

/**
 * electron-builder's latest*.yml → { version, files }. A few lines of a known format, read with
 * two regexes (no YAML library in the manual path). null when it has no version.
 */
function parseFeed(text) {
  if (typeof text !== 'string') return null;
  const v = /^version:[ \t]*['"]?([^'"\s#]+)/m.exec(text);
  if (!v || !parseVersion(v[1])) return null;
  const files = [];
  for (const m of text.matchAll(/^[ \t]*(?:-[ \t]+)?url:[ \t]*['"]?([^'"\s#]+)/gm)) if (!files.includes(m[1])) files.push(m[1]);
  const p = /^path:[ \t]*['"]?([^'"\s#]+)/m.exec(text);
  if (p && !files.includes(p[1])) files.push(p[1]);
  return { version: v[1], files };
}

/** package.json build.portable.artifactName with ${version} filled in */
const portableName = (version) => `SanguoWarlords-${version}-Windows-portable.exe`;
/** package.json build.nsis.artifactName */
const setupName = (version) => `SanguoWarlords-${version}-Windows-setup.exe`;
/** package.json build.dmg.artifactName (arch: arm64 | x64) */
const dmgName = (version, arch) => `SanguoWarlords-${version}-macOS-${arch}.dmg`;

/**
 * What 下载 opens for a manual update: `url` the file for this machine (the new portable exe; the
 * dmg for this Mac's chip — arm64 also when an Intel build runs under Rosetta) or the releases page;
 * `setupUrl` (portable only) the setup build, which updates itself from then on.
 */
function downloadTarget({ kind, version, files = [], arch }) {
  if (!releaseTag(version)) return { url: RELEASES_URL };
  if (kind === 'portable') {
    const setup = files.find((f) => /-setup\.exe$/i.test(f)) || setupName(version);
    return { url: assetUrl(version, portableName(version)), setupUrl: assetUrl(version, setup) };
  }
  if (kind === 'mac' && (arch === 'arm64' || arch === 'x64')) {
    const dmg = files.find((f) => f.endsWith(`-macOS-${arch}.dmg`)) || dmgName(version, arch);
    return { url: assetUrl(version, dmg) };
  }
  return { url: RELEASES_URL };
}

/**
 * The updater of one app run.
 * deps: { app ({ isPackaged, getVersion() }), openExternal(url), fetchText(url, timeoutMs) → Promise<string>,
 *   loadAutoUpdater() → electron-updater's autoUpdater, platform, arch, env, log, setTimeout, setInterval, now }
 * Returns { state(), onChange(cb), start(), check(), download(which), restart(), setPlaying(on) }.
 */
function createUpdater(deps) {
  const log = deps.log || console;
  const timers = { setTimeout: deps.setTimeout || setTimeout, setInterval: deps.setInterval || setInterval };
  const now = deps.now || Date.now;
  const kind = updateKind({ platform: deps.platform, env: deps.env || {}, isPackaged: !!deps.app.isPackaged });
  const current = String(deps.app.getVersion());
  let state = { kind, auto: isAuto(kind), current, build: buildOf(current), status: 'idle' };
  const listeners = new Set();
  let started = false;
  let playing = false;
  /** a check (and for electron-updater a download) waits for the match to end */
  let due = false;
  let busy = false;
  let au = null;

  const set = (patch) => {
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const cb of [...listeners]) {
      try {
        cb(state);
      } catch (err) {
        log.warn('[updater] listener failed', err);
      }
    }
  };
  let lastErr = null;
  /** Offline / GitHub down: silent — an update already found stays on offer. */
  const failed = (err) => {
    // electron-updater both emits 'error' and rejects: one log line
    if (err !== lastErr) log.warn(`[updater] ${kind}: update check / download failed:`, err && err.message ? err.message : err);
    lastErr = err;
    if (state.status !== 'available' && state.status !== 'ready') set({ status: 'error' });
  };

  function autoUpdater() {
    if (au) return au;
    au = deps.loadAutoUpdater();
    au.autoDownload = false; // downloadUpdate() below, never during a match
    au.autoInstallOnAppQuit = true;
    au.allowPrerelease = false;
    au.allowDowngrade = false;
    au.logger = {
      info: (m) => log.info(`[updater] ${m}`),
      warn: (m) => log.warn(`[updater] ${m}`),
      error: (m) => log.warn(`[updater] ${m}`),
      debug: () => undefined,
    };
    au.on('update-available', (info) => {
      set({ status: 'available', version: String(info && info.version), percent: 0 });
      startDownload();
    });
    au.on('update-not-available', () => set({ status: 'latest', checkedAt: now() }));
    au.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(99, Math.floor(Number(p && p.percent) || 0)));
      if (state.status !== 'downloading' || state.percent !== percent) set({ status: 'downloading', percent });
    });
    au.on('update-downloaded', (info) => set({ status: 'ready', version: String((info && info.version) || state.version), percent: 100 }));
    // without an 'error' listener the EventEmitter would throw
    au.on('error', failed);
    return au;
  }

  function startDownload() {
    if (playing) {
      due = true;
      return;
    }
    set({ status: 'downloading' });
    autoUpdater()
      .downloadUpdate()
      .catch(failed);
  }

  async function checkManual() {
    const text = await deps.fetchText(`${FEED_URL}/${feedFile(kind)}`, FETCH_TIMEOUT_MS);
    const feed = parseFeed(text);
    if (!feed) throw new Error(`unreadable ${feedFile(kind)}`);
    if (!isNewer(feed.version, current)) {
      set({ status: 'latest', checkedAt: now() });
      return;
    }
    set({ status: 'available', version: feed.version, checkedAt: now(), ...downloadTarget({ kind, version: feed.version, files: feed.files, arch: deps.arch }) });
  }

  /** One check now — or when the match ends. Resolves when it is done (never rejects). */
  async function check() {
    if (kind === 'none' || busy) return;
    if (playing) {
      due = true;
      return;
    }
    // downloaded: it installs on quit; downloading: it is on its way
    if (state.status === 'ready' || state.status === 'downloading') return;
    busy = true;
    due = false;
    try {
      if (isAuto(kind)) {
        if (state.status === 'available') startDownload();
        else {
          set({ status: 'checking' });
          await autoUpdater().checkForUpdates();
        }
      } else {
        if (state.status !== 'available') set({ status: 'checking' });
        await checkManual();
      }
    } catch (err) {
      failed(err);
    } finally {
      busy = false;
    }
  }

  return {
    state: () => state,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Checks ~10 s after the window shows, then every 4 h (once per run; a dev run never). */
    start() {
      if (started || kind === 'none') return;
      started = true;
      const first = timers.setTimeout(() => void check(), FIRST_CHECK_MS);
      const every = timers.setInterval(() => void check(), CHECK_EVERY_MS);
      for (const t of [first, every]) if (t && typeof t.unref === 'function') t.unref();
    },
    check,
    /** 下载: the file in the browser (manual) or the download now (electron-updater). `which` 'setup': the portable's setup build. */
    download(which) {
      if (kind === 'none') return;
      if (isAuto(kind)) {
        // after a failed download: a fresh check (the release it knew may have been replaced)
        if (state.status === 'available') startDownload();
        else void check();
        return;
      }
      const url = which === 'setup' ? state.setupUrl : state.url;
      void Promise.resolve(deps.openExternal(url || RELEASES_URL)).catch((err) => log.warn('[updater] could not open the download', err));
    },
    /** 重启并更新: only a downloaded update, never during a match. */
    restart() {
      if (!isAuto(kind) || state.status !== 'ready' || playing) return;
      try {
        autoUpdater().quitAndInstall(true, true);
      } catch (err) {
        failed(err);
      }
    },
    /** The page is in a match (hero select … the end of the match): checks and downloads wait. */
    setPlaying(on) {
      playing = !!on;
      if (!playing && due) {
        due = false;
        if (isAuto(kind) && state.status === 'available') startDownload();
        else void check();
      }
    },
  };
}

module.exports = {
  REPO,
  FEED_URL,
  RELEASES_URL,
  TAG_PREFIX,
  FIRST_CHECK_MS,
  CHECK_EVERY_MS,
  updateKind,
  isAuto,
  feedFile,
  parseVersion,
  compareVersions,
  isNewer,
  buildOf,
  releaseTag,
  assetUrl,
  parseFeed,
  portableName,
  setupName,
  dmgName,
  downloadTarget,
  createUpdater,
};
